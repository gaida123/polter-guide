"""
HandOff.AI — FastAPI application entry point.

Exposes:
  - REST routes:  /sops, /sessions, /admin
  - WebSocket:    /ws/{session_id}  ← Ghost Cursor real-time bridge

The WebSocket handler acts as the bridge between the frontend and the
Fetch.ai Context Agent.  On each inbound message it:
  1. Parses the WsInbound envelope.
  2. Sends a StepRequest to the Context Agent via HTTP (uAgents submit endpoint).
  3. Awaits the StepResponse via an asyncio.Future keyed on session_id.
  4. Pushes the WsOutbound envelope back to the frontend.

Firebase Realtime DB is also updated inside the Context Agent, giving the
frontend a second, zero-latency cursor-sync channel that bypasses WebSocket.
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

import httpx
import structlog
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from api.routes import sop as sop_router
from api.routes import sessions as sessions_router
from api.routes import admin as admin_router
from api.routes import vision as vision_router
from api.routes import local as local_router
from config import settings
from models import (
    WsInbound, WsOutbound, WsMessageType,
    StepRequest, StepResponse, AgentError,
    SessionStatus,
)
from services.firebase_service import update_session_status, get_session_state

# ── Structured logging ────────────────────────────────────────────────────────

structlog.configure(
    wrapper_class=structlog.make_filtering_bound_logger(
        getattr(logging, settings.log_level.upper(), logging.INFO)
    )
)
logger = structlog.get_logger()

# ── In-flight response futures keyed by session_id ───────────────────────────
# The Context Agent POSTs its response back to /internal/agent-response,
# where the matching future is resolved and the WebSocket handler picks it up.
_pending_futures: dict[str, asyncio.Future] = {}


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("HandOff.AI API starting", port=settings.api_port)
    yield
    logger.info("HandOff.AI API shutting down")


# ── App factory ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="HandOff.AI API",
    description="Agentic AI Co-Pilot for B2B SaaS onboarding",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sop_router.router)
app.include_router(sessions_router.router)
app.include_router(admin_router.router)
app.include_router(vision_router.router)
app.include_router(local_router.router)


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/docs")


# ── Health check ─────────────────────────────────────────────────────────────

@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


# ── Internal endpoint — Context Agent posts responses here ───────────────────

@app.post("/internal/agent-response", include_in_schema=False)
async def receive_agent_response(payload: dict):
    """
    The Context Agent calls this endpoint with a StepResponse or AgentError
    after finishing its orchestration cycle.
    """
    session_id: Optional[str] = payload.get("session_id")
    if not session_id:
        return {"error": "missing session_id"}

    future = _pending_futures.get(session_id)
    if future and not future.done():
        future.set_result(payload)

    return {"received": True}


# ── WebSocket — Ghost Cursor real-time bridge ─────────────────────────────────

@app.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    await websocket.accept()
    logger.info("WebSocket connected", session_id=session_id)

    update_session_status(session_id, SessionStatus.ACTIVE)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
                msg = WsInbound(**data)
            except Exception as exc:
                await _send_error(websocket, session_id, f"Invalid message: {exc}")
                continue

            await _dispatch_ws_message(websocket, session_id, msg)

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected", session_id=session_id)
        update_session_status(session_id, SessionStatus.PAUSED)


async def _dispatch_ws_message(
    websocket: WebSocket, session_id: str, msg: WsInbound
):
    msg_type = msg.type
    payload = msg.payload

    if msg_type == WsMessageType.START_SESSION:
        await _send(websocket, WsOutbound(
            type=WsMessageType.STEP_UPDATE,
            session_id=session_id,
            payload={"message": "Session started. Ready to guide you."},
        ))

    elif msg_type in (WsMessageType.VOICE_COMMAND, WsMessageType.SCREENSHOT):
        await _handle_step_advance(websocket, session_id, payload)

    elif msg_type == WsMessageType.AUTOFILL_CONFIRM:
        await _handle_autofill_confirm(websocket, session_id, payload)

    elif msg_type == WsMessageType.PAUSE_SESSION:
        update_session_status(session_id, SessionStatus.PAUSED)
        await _send(websocket, WsOutbound(
            type=WsMessageType.STEP_UPDATE,
            session_id=session_id,
            payload={"message": "Session paused."},
        ))

    elif msg_type == WsMessageType.END_SESSION:
        update_session_status(
            session_id, SessionStatus.COMPLETED,
            completed_at=datetime.utcnow().isoformat()
        )
        await _send(websocket, WsOutbound(
            type=WsMessageType.SESSION_COMPLETE,
            session_id=session_id,
            payload={"message": "You've completed this workflow. Great work!"},
        ))


async def _handle_step_advance(websocket: WebSocket, session_id: str, payload: dict):
    """
    Build a StepRequest and forward it to the Context Agent.
    Wait for the StepResponse (or AgentError) with a 15-second timeout.
    """
    session_data = get_session_state(session_id)
    if not session_data:
        await _send_error(websocket, session_id, "Session not found")
        return

    step_request = StepRequest(
        session_id=session_id,
        user_id=session_data["user_id"],
        product_id=session_data["product_id"],
        sop_id=session_data["sop_id"],
        current_step_index=session_data.get("current_step_index", 0),
        screenshot_base64=payload.get("screenshot_base64", ""),
        voice_command=payload.get("voice_command"),
    )

    # Register a future for this session
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    _pending_futures[session_id] = future

    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                settings.context_agent_endpoint,
                json=step_request.model_dump(mode="json"),
                timeout=5.0,
            )
    except Exception as exc:
        logger.warning("Could not reach Context Agent: %s", exc)
        await _send_error(websocket, session_id, "Agent temporarily unavailable")
        _pending_futures.pop(session_id, None)
        return

    try:
        result: dict = await asyncio.wait_for(future, timeout=15.0)
    except asyncio.TimeoutError:
        await _send_error(websocket, session_id, "Agent response timed out")
        _pending_futures.pop(session_id, None)
        return
    finally:
        _pending_futures.pop(session_id, None)

    # Determine if this is a StepResponse or AgentError
    if "error_code" in result:
        await _send(websocket, WsOutbound(
            type=WsMessageType.ERROR,
            session_id=session_id,
            payload=result,
        ))
        return

    # Destructive action guardrail
    if result.get("is_destructive"):
        await _send(websocket, WsOutbound(
            type=WsMessageType.GUARDRAIL_WARNING,
            session_id=session_id,
            payload={
                "instruction_text": result.get("instruction_text", ""),
                "warning": "This action is permanent. Are you sure you want to proceed?",
                "step_data": result,
            },
        ))
        return

    # Autofill gate
    if result.get("requires_autofill") and settings.autofill_require_confirmation:
        await _send(websocket, WsOutbound(
            type=WsMessageType.AUTOFILL_REQUEST,
            session_id=session_id,
            payload={
                "instruction_text": result.get("instruction_text", ""),
                "autofill_value": result.get("autofill_value"),
                "step_data": result,
            },
        ))
        return

    await _send(websocket, WsOutbound(
        type=WsMessageType.STEP_UPDATE,
        session_id=session_id,
        payload=result,
    ))

    if result.get("is_final_step"):
        await _send(websocket, WsOutbound(
            type=WsMessageType.SESSION_COMPLETE,
            session_id=session_id,
            payload={"message": "You've completed all steps. Excellent work!"},
        ))


async def _handle_autofill_confirm(websocket: WebSocket, session_id: str, payload: dict):
    """User confirmed autofill — log it and resume the step flow."""
    from services.firebase_service import append_autofill_log
    append_autofill_log(session_id, {
        "step_index": payload.get("step_index"),
        "field_selector": payload.get("field_selector"),
        "confirmed_at": datetime.utcnow().isoformat(),
    })
    await _send(websocket, WsOutbound(
        type=WsMessageType.STEP_UPDATE,
        session_id=session_id,
        payload={**payload, "autofill_confirmed": True},
    ))


async def _send(websocket: WebSocket, msg: WsOutbound):
    await websocket.send_text(msg.model_dump_json())


async def _send_error(websocket: WebSocket, session_id: str, detail: str):
    await _send(websocket, WsOutbound(
        type=WsMessageType.ERROR,
        session_id=session_id,
        payload={"detail": detail},
    ))
