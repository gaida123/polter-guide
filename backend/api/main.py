"""
HandOff.AI — FastAPI application entry point.

Exposes:
  - REST routes:  /sops, /sessions, /admin
  - WebSocket:    /ws/{session_id}  ← Ghost Cursor real-time bridge
  - MCP server:   /mcp/sse + /mcp/messages  ← Model Context Protocol endpoint

WebSocket flow (refactored to use LangGraph):
  The previous architecture forwarded each message to the Fetch.ai Context
  Agent via httpx, then waited for a /internal/agent-response callback.
  This added two HTTP round-trips and required a global pending-futures dict.

  The new flow calls the LangGraph guidance_graph *directly* inside the
  WebSocket handler:
    1. Parse WsInbound message
    2. Call run_guidance_step() — runs classify_intent → resolve_knowledge
       → resolve_vision → finalize nodes with MemorySaver checkpointing
    3. Build WsOutbound from the returned GuidanceState
    4. Push to frontend

  The Fetch.ai uAgents (context / knowledge / vision) remain running in
  background threads for the Agentverse mesh and agent-to-agent flows;
  they also use run_guidance_step() internally for consistency.
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

import structlog
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from api.routes import sop as sop_router
from api.routes import sessions as sessions_router
from api.routes import admin as admin_router
from config import settings
from models import (
    WsInbound, WsOutbound, WsMessageType,
    SessionStatus,
)
from services.firebase_service import (
    update_session_status, get_session_state, append_autofill_log,
)
from services.workflow import run_guidance_step, GuidanceState

# ── Structured logging ────────────────────────────────────────────────────────

structlog.configure(
    wrapper_class=structlog.make_filtering_bound_logger(
        getattr(logging, settings.log_level.upper(), logging.INFO)
    )
)
logger = structlog.get_logger()


# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("HandOff.AI API starting", port=settings.api_port)
    yield
    logger.info("HandOff.AI API shutting down")


# ── App factory ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="HandOff.AI API",
    description="Agentic AI Co-Pilot for B2B SaaS onboarding — powered by LangGraph + Fetch.ai",
    version="0.2.0",
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


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse(url="/docs")


@app.get("/health", tags=["Health"])
async def health():
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "workflow_engine": "langgraph",
    }


# ── MCP Server (Model Context Protocol) ──────────────────────────────────────
# HandOff.AI exposes its core capabilities as MCP tools so external AI
# systems (e.g. Claude Desktop, other agents) can drive guided workflows.

from mcp_server import create_mcp_server, mount_mcp

_mcp = create_mcp_server()
mount_mcp(app, _mcp)


# ── WebSocket — LangGraph-powered Ghost Cursor bridge ────────────────────────

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
    Run one turn of the LangGraph guidance workflow and forward the result
    to the frontend WebSocket client.

    The LangGraph MemorySaver checkpointer (keyed on session_id) persists the
    step index between turns, so the session can be resumed after a disconnect.
    """
    session_data = get_session_state(session_id)
    if not session_data:
        await _send_error(websocket, session_id, "Session not found")
        return

    try:
        result: GuidanceState = await run_guidance_step(
            session_id=session_id,
            user_id=session_data.get("user_id", ""),
            product_id=session_data.get("product_id", ""),
            sop_id=session_data.get("sop_id", ""),
            current_step_index=session_data.get("current_step_index", 0),
            screenshot_base64=payload.get("screenshot_base64", ""),
            voice_command=payload.get("voice_command"),
            user_query=payload.get("user_query"),
        )
    except Exception as exc:
        logger.error("LangGraph workflow error", session_id=session_id, error=str(exc))
        await _send_error(websocket, session_id, f"Workflow error: {exc}")
        return

    if result.get("error"):
        await _send_error(websocket, session_id, result["error"])
        return

    step_data = {
        "session_id": session_id,
        "step_index": result.get("resolved_step_index", 0),
        "total_steps": result.get("total_steps", 1),
        "instruction_text": result.get("instruction_text", ""),
        "target_x": result.get("target_x", 0.5),
        "target_y": result.get("target_y", 0.5),
        "requires_autofill": result.get("requires_autofill", False),
        "autofill_value": result.get("autofill_value"),
        "is_destructive": result.get("is_destructive", False),
        "is_final_step": result.get("is_final_step", False),
        "detected_error_modal": result.get("detected_error_modal", False),
        "error_modal_text": result.get("error_modal_text"),
        "vision_confidence": result.get("vision_confidence", 0.0),
        "intent": result.get("intent"),
        "matched_sop_name": result.get("matched_sop_name"),
    }

    # Guardrail: destructive steps surface a warning before proceeding
    if result.get("is_destructive"):
        await _send(websocket, WsOutbound(
            type=WsMessageType.GUARDRAIL_WARNING,
            session_id=session_id,
            payload={
                "instruction_text": step_data["instruction_text"],
                "warning": "This action is permanent. Are you sure you want to proceed?",
                "step_data": step_data,
            },
        ))
        return

    # Autofill gate
    if result.get("requires_autofill") and settings.autofill_require_confirmation:
        await _send(websocket, WsOutbound(
            type=WsMessageType.AUTOFILL_REQUEST,
            session_id=session_id,
            payload={
                "instruction_text": step_data["instruction_text"],
                "autofill_value": step_data["autofill_value"],
                "step_data": step_data,
            },
        ))
        return

    await _send(websocket, WsOutbound(
        type=WsMessageType.STEP_UPDATE,
        session_id=session_id,
        payload=step_data,
    ))

    if result.get("is_final_step"):
        await _send(websocket, WsOutbound(
            type=WsMessageType.SESSION_COMPLETE,
            session_id=session_id,
            payload={"message": "You've completed all steps. Excellent work!"},
        ))


async def _handle_autofill_confirm(websocket: WebSocket, session_id: str, payload: dict):
    """User confirmed autofill — log it and resume the step data."""
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
