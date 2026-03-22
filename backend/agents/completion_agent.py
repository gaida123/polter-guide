"""
CompletionAgent — autonomous Fetch.ai uAgent for HandOff.AI.

Every 10 seconds this agent:
  1. Scans the local SQLite DB for newly completed onboarding sessions
     that haven't been processed yet.
  2. Calls Gemini to generate a human-readable completion summary.
  3. Writes a feed entry visible in the admin dashboard.
  4. Marks the session as processed so it isn't handled twice.

This demonstrates core Fetch.ai value: an autonomous agent that acts
independently, without being triggered by an API call.
"""

import asyncio
import logging
from datetime import datetime
from uuid import uuid4

from uagents import Agent, Context

from config import settings

logger = logging.getLogger(__name__)


def create_agent() -> Agent:
    agent = Agent(
        name="handoff_completion_agent",
        seed=settings.completion_agent_seed,
        port=settings.completion_agent_port,
        endpoint=[f"http://localhost:{settings.completion_agent_port}/submit"],
    )

    @agent.on_event("startup")
    async def on_startup(ctx: Context):
        ctx.logger.info(
            f"CompletionAgent online | address: {ctx.agent.address} | "
            f"inspect: https://agentverse.ai/inspect/"
            f"?uri=http%3A//127.0.0.1%3A{settings.completion_agent_port}"
            f"&address={ctx.agent.address}"
        )

    @agent.on_interval(period=10.0)
    async def scan_completions(ctx: Context):
        """Autonomously find completed sessions and generate reports."""
        import local_db
        from services.gemini_service import generate_completion_report

        try:
            sessions = await asyncio.to_thread(local_db.get_unprocessed_completions)
        except Exception as exc:
            ctx.logger.warning(f"DB scan failed: {exc}")
            return

        for session in sessions:
            try:
                sop = await asyncio.to_thread(local_db.get_sop, session["sop_id"])
                sop_title  = sop["title"] if sop else "Unknown SOP"
                total_steps = len(sop["steps"]) if sop else 0
                steps_done  = len(session["step_results"])

                # Calculate duration
                duration_s = None
                if session.get("completed_at") and session.get("started_at"):
                    try:
                        started   = datetime.fromisoformat(session["started_at"])
                        finished  = datetime.fromisoformat(session["completed_at"])
                        duration_s = (finished - started).total_seconds()
                    except Exception:
                        pass

                summary = await generate_completion_report(
                    employee_name   = session["employee_name"],
                    sop_title       = sop_title,
                    steps_done      = steps_done,
                    total_steps     = total_steps,
                    duration_seconds= duration_s,
                )

                entry = {
                    "id":            str(uuid4()),
                    "session_id":    session["id"],
                    "employee_name": session["employee_name"],
                    "sop_title":     sop_title,
                    "summary":       summary,
                    "steps_done":    steps_done,
                    "total_steps":   total_steps,
                    "duration_s":    duration_s,
                    "created_at":    datetime.utcnow().isoformat(),
                }

                await asyncio.to_thread(local_db.save_feed_entry, entry)
                await asyncio.to_thread(local_db.mark_session_processed, session["id"])

                ctx.logger.info(
                    f"Report generated | employee={session['employee_name']} "
                    f"sop={sop_title} steps={steps_done}/{total_steps}"
                )

            except Exception as exc:
                ctx.logger.error(f"Failed to process session {session['id']}: {exc}")

    return agent
