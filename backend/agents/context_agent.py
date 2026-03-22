"""
Context Agent — client-facing orchestrator of the HandOff.AI multi-agent system.

Uses a factory function create_agent() so the Agent object is only instantiated
inside a thread that already has an asyncio event loop set (required in Python 3.10+).
"""

import asyncio
import logging
from typing import Optional

from uagents import Agent, Context

from config import settings
from models.agent_models import (
    StepRequest, StepResponse,
    KnowledgeRequest, KnowledgeResponse,
    VisionRequest, VisionResponse,
    AgentError,
)
from models.session_models import CursorState
from services.asi1_service import refine_step_instruction

logger = logging.getLogger(__name__)

# In-memory correlation store: session_id → pending response slots.
# Module-level so it persists across handler calls within the same process.
_pending: dict[str, dict] = {}


def _ensure_pending(session_id: str) -> dict:
    if session_id not in _pending:
        _pending[session_id] = {
            "knowledge": None,
            "vision": None,
            "knowledge_event": asyncio.Event(),
            "vision_event": asyncio.Event(),
            "original_request": None,
            "sender": None,
        }
    return _pending[session_id]


def create_agent() -> Agent:
    """
    Factory — call this AFTER asyncio.set_event_loop() has been called in
    the current thread.  Returns a fully-wired Agent ready to call .run() on.
    """
    agent = Agent(
        name="context_agent",
        seed=settings.context_agent_seed,
        port=settings.context_agent_port,
        endpoint=[f"http://localhost:{settings.context_agent_port}/submit"],
        # mailbox requires no explicit endpoint — omit here; Almanac API
        # registration (which powers agentverse.ai/inspect/) works via endpoint.
    )

    @agent.on_event("startup")
    async def startup(ctx: Context):
        ctx.logger.info(
            f"Context Agent started | address: {ctx.agent.address} | "
            f"inspect: https://agentverse.ai/inspect/"
            f"?uri=http%3A//127.0.0.1%3A{settings.context_agent_port}"
            f"&address={ctx.agent.address}"
        )
        ctx.logger.info(
            "Context routing | knowledge=%s | vision=%s",
            "local" if settings.use_local_knowledge_agent else "remote",
            "local" if settings.use_local_vision_agent else "remote",
        )

    @agent.on_message(model=StepRequest)
    async def handle_step_request(ctx: Context, sender: str, msg: StepRequest):
        logger.info("StepRequest | session=%s step=%d", msg.session_id, msg.current_step_index)

        slot = _ensure_pending(msg.session_id)
        slot["original_request"] = msg
        slot["sender"] = sender
        slot["knowledge_event"].clear()
        slot["vision_event"].clear()
        slot["knowledge"] = None
        slot["vision"] = None

        knowledge_addr = settings.knowledge_agent_address
        vision_addr = settings.vision_agent_address

        await asyncio.gather(
            ctx.send(knowledge_addr, KnowledgeRequest(
                session_id=msg.session_id,
                user_id=msg.user_id,
                product_id=msg.product_id,
                sop_id=msg.sop_id,
                current_step_index=msg.current_step_index,
                voice_command=msg.voice_command,
                user_query=msg.user_query,
            )),
            ctx.send(vision_addr, VisionRequest(
                session_id=msg.session_id,
                screenshot_base64=msg.screenshot_base64,
                target_description="",
                selector_hint=None,
            )),
        )

        try:
            await asyncio.wait_for(slot["knowledge_event"].wait(), timeout=10.0)
        except asyncio.TimeoutError:
            logger.error("Knowledge Agent timeout | session=%s", msg.session_id)
            await ctx.send(sender, AgentError(
                session_id=msg.session_id, agent_name="knowledge",
                error_code="TIMEOUT", message="Knowledge Agent timed out.",
            ))
            _pending.pop(msg.session_id, None)
            return

        knowledge: KnowledgeResponse = slot["knowledge"]
        vision_addr = settings.vision_agent_address
        await ctx.send(vision_addr, VisionRequest(
            session_id=msg.session_id,
            screenshot_base64=msg.screenshot_base64,
            target_description=knowledge.instruction_text,
            selector_hint=knowledge.selector_hint,
        ))

        try:
            await asyncio.wait_for(
                slot["vision_event"].wait(),
                timeout=settings.gemini_vision_timeout_seconds + 2,
            )
        except asyncio.TimeoutError:
            logger.warning("Vision Agent timeout — using fallback | session=%s", msg.session_id)
            slot["vision"] = _vision_fallback(msg.session_id)

        await _merge_and_broadcast(ctx, msg.session_id)

    @agent.on_message(model=KnowledgeResponse)
    async def handle_knowledge_response(ctx: Context, sender: str, msg: KnowledgeResponse):
        slot = _pending.get(msg.sop_id) or _find_pending_by_sop(msg.sop_id)
        if slot is None:
            return
        slot["knowledge"] = msg
        slot["knowledge_event"].set()

    @agent.on_message(model=VisionResponse)
    async def handle_vision_response(ctx: Context, sender: str, msg: VisionResponse):
        slot = _pending.get(msg.session_id)
        if slot is None:
            return
        slot["vision"] = msg
        slot["vision_event"].set()

    @agent.on_message(model=AgentError)
    async def handle_agent_error(ctx: Context, sender: str, msg: AgentError):
        logger.error("AgentError from %s [%s]: %s", msg.agent_name, msg.error_code, msg.message)
        slot = _pending.get(msg.session_id)
        if slot is None:
            return
        if msg.agent_name == "knowledge":
            await ctx.send(slot["sender"], msg)
            _pending.pop(msg.session_id, None)
        else:
            slot["vision"] = _vision_fallback(msg.session_id)
            slot["vision_event"].set()

    return agent


async def _merge_and_broadcast(ctx: Context, session_id: str):
    slot = _pending.pop(session_id, None)
    if slot is None:
        return
    knowledge: KnowledgeResponse = slot["knowledge"]
    vision: VisionResponse = slot["vision"]
    sender: str = slot["sender"]
    original: StepRequest | None = slot.get("original_request")

    instruction = knowledge.instruction_text
    if settings.use_asi1:
        refined = await refine_step_instruction(
            instruction_text=knowledge.instruction_text,
            step_index=knowledge.step_index,
            total_steps=knowledge.total_steps,
            voice_command=original.voice_command if original else None,
            vision_found=vision.found,
            vision_confidence=vision.confidence,
            detected_error_modal=vision.detected_error_modal,
            error_modal_text=vision.error_modal_text,
        )
        if refined:
            instruction = refined
            logger.info("ASI:One refined instruction | session=%s", session_id)

    step_response = StepResponse(
        session_id=session_id,
        step_index=knowledge.step_index,
        total_steps=knowledge.total_steps,
        instruction_text=instruction,
        target_x=vision.target_x,
        target_y=vision.target_y,
        requires_autofill=knowledge.requires_autofill,
        autofill_value=knowledge.autofill_value,
        is_destructive=knowledge.is_destructive,
        is_final_step=knowledge.is_final_step,
        detected_error_modal=vision.detected_error_modal,
        error_modal_text=vision.error_modal_text,
        vision_confidence=vision.confidence,
        intent=knowledge.intent,
        matched_sop_name=knowledge.matched_sop_name,
    )

    _write_cursor(session_id, step_response)
    await ctx.send(sender, step_response)


def _write_cursor(session_id: str, step: StepResponse):
    from services.firebase_service import update_cursor_state
    update_cursor_state(session_id, CursorState(
        x=step.target_x,
        y=step.target_y,
        step_index=step.step_index,
        instruction_text=step.instruction_text,
        is_destructive=step.is_destructive,
    ))


def _vision_fallback(session_id: str) -> VisionResponse:
    return VisionResponse(session_id=session_id, found=False, target_x=0.5, target_y=0.5, confidence=0.0)


def _find_pending_by_sop(sop_id: str) -> Optional[dict]:
    for slot in _pending.values():
        req: StepRequest = slot.get("original_request")
        if req and req.sop_id == sop_id:
            return slot
    return None


if __name__ == "__main__":
    asyncio.set_event_loop(asyncio.new_event_loop())
    create_agent().run()
