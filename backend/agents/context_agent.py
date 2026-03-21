"""
Context Agent — Fetch.ai uAgent that wraps the LangGraph guidance workflow.

Role in the architecture:
  - Primary web sessions go through the FastAPI WebSocket → run_guidance_step()
    directly (no HTTP hops, lowest latency).
  - This agent handles *agent-to-agent* StepRequests arriving via the Fetch.ai
    mesh (other uAgents, Agentverse integrations, external AI pipelines).

Both paths call the same LangGraph guidance_graph, so the behaviour is
identical regardless of which entry point is used.

Uses create_agent() factory so Agent() is instantiated inside the thread
that has its own asyncio event loop (required in Python 3.10+).
"""

import asyncio
import logging
from typing import Optional

from uagents import Agent, Context

from config import settings
from models.agent_models import StepRequest, StepResponse, AgentError
from models.session_models import CursorState

logger = logging.getLogger(__name__)


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
    )

    @agent.on_event("startup")
    async def startup(ctx: Context):
        ctx.logger.info(
            f"Context Agent (LangGraph) started | address: {ctx.agent.address} | "
            f"inspect: https://agentverse.ai/inspect/"
            f"?uri=http%3A//127.0.0.1%3A{settings.context_agent_port}"
            f"&address={ctx.agent.address}"
        )

    @agent.on_message(model=StepRequest)
    async def handle_step_request(ctx: Context, sender: str, msg: StepRequest):
        """
        Received a StepRequest from another agent via the Fetch.ai mesh.
        Delegate to the LangGraph workflow and return a StepResponse.
        """
        logger.info(
            "Agent StepRequest | session=%s step=%d intent_hint=%r",
            msg.session_id, msg.current_step_index, msg.voice_command,
        )

        from services.workflow import run_guidance_step

        try:
            state = await run_guidance_step(
                session_id=msg.session_id,
                user_id=msg.user_id,
                product_id=msg.product_id,
                sop_id=msg.sop_id,
                current_step_index=msg.current_step_index,
                screenshot_base64=msg.screenshot_base64,
                voice_command=msg.voice_command,
                user_query=msg.user_query,
            )
        except Exception as exc:
            logger.error("LangGraph workflow error in agent handler: %s", exc)
            await ctx.send(sender, AgentError(
                session_id=msg.session_id,
                agent_name="context",
                error_code="WORKFLOW_ERROR",
                message=str(exc),
            ))
            return

        if state.get("error"):
            await ctx.send(sender, AgentError(
                session_id=msg.session_id,
                agent_name="context",
                error_code="NOT_FOUND",
                message=state["error"],
            ))
            return

        await ctx.send(sender, StepResponse(
            session_id=msg.session_id,
            step_index=state.get("resolved_step_index", 0),
            total_steps=state.get("total_steps", 1),
            instruction_text=state.get("instruction_text", ""),
            target_x=state.get("target_x", 0.5),
            target_y=state.get("target_y", 0.5),
            requires_autofill=state.get("requires_autofill", False),
            autofill_value=state.get("autofill_value"),
            is_destructive=state.get("is_destructive", False),
            is_final_step=state.get("is_final_step", False),
            detected_error_modal=state.get("detected_error_modal", False),
            error_modal_text=state.get("error_modal_text"),
            vision_confidence=state.get("vision_confidence", 0.0),
            intent=state.get("intent"),
            matched_sop_name=state.get("matched_sop_name"),
        ))

    return agent


if __name__ == "__main__":
    asyncio.set_event_loop(asyncio.new_event_loop())
    create_agent().run()
