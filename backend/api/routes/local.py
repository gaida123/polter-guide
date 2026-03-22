"""
Local (SQLite-backed) routes for the company onboarding flow.
No Firebase auth required — designed for the demo/MVP.

Routes:
  POST   /local/sops/generate          — AI generates steps from plain text
  POST   /local/sops                   — Save a new SOP
  GET    /local/sops                   — List all SOPs
  GET    /local/sops/{id}              — Get SOP with steps
  DELETE /local/sops/{id}              — Delete SOP

  POST   /local/sessions               — Start employee session
  GET    /local/sessions/{id}          — Get session + SOP steps
  POST   /local/sessions/{id}/steps/{index}/complete  — Mark step done
  POST   /local/sessions/{id}/finish   — Mark session complete
  GET    /local/sessions               — List all sessions (admin report)
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

import local_db
from services.gemini_service import generate_steps_from_description

router  = APIRouter(prefix="/local", tags=["Local"])
logger  = logging.getLogger(__name__)

# Initialise DB on import
local_db.init_db()


# ── Request bodies ────────────────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    description: str


class SopStep(BaseModel):
    title:       str
    instruction: str
    expected:    str = ""


class CreateSopRequest(BaseModel):
    title:       str
    role:        str = "General"
    description: str = ""
    steps:       list[SopStep]


class CreateSessionRequest(BaseModel):
    sop_id:         str
    employee_name:  str
    employee_email: str = ""


# ── SOP endpoints ─────────────────────────────────────────────────────────────

@router.post("/sops/generate", response_model=list[SopStep])
async def generate_sop(body: GenerateRequest):
    """Use Gemini to convert a plain-text description into structured SOP steps."""
    if not body.description.strip():
        raise HTTPException(status_code=400, detail="description must not be empty")
    steps = await generate_steps_from_description(body.description)
    if not steps:
        raise HTTPException(status_code=500, detail="AI failed to generate steps")
    return [SopStep(**s) for s in steps]


@router.post("/sops", status_code=status.HTTP_201_CREATED)
async def create_sop(body: CreateSopRequest):
    steps = [s.model_dump() for s in body.steps]
    sop   = await asyncio.to_thread(
        local_db.create_sop, body.title, body.role, body.description, steps
    )
    return sop


@router.get("/sops")
async def list_sops():
    return await asyncio.to_thread(local_db.list_sops)


@router.get("/sops/{sop_id}")
async def get_sop(sop_id: str):
    sop = await asyncio.to_thread(local_db.get_sop, sop_id)
    if not sop:
        raise HTTPException(status_code=404, detail="SOP not found")
    return sop


@router.delete("/sops/{sop_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sop(sop_id: str):
    await asyncio.to_thread(local_db.delete_sop, sop_id)


# ── Session endpoints ─────────────────────────────────────────────────────────

@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(body: CreateSessionRequest):
    sop = await asyncio.to_thread(local_db.get_sop, body.sop_id)
    if not sop:
        raise HTTPException(status_code=404, detail="SOP not found")
    session = await asyncio.to_thread(
        local_db.create_session, body.sop_id, body.employee_name, body.employee_email
    )
    return {**session, "sop": sop}


@router.get("/sessions")
async def list_sessions(sop_id: Optional[str] = None):
    sessions = await asyncio.to_thread(local_db.list_sessions, sop_id)
    # Attach SOP title to each session
    sop_cache: dict[str, dict] = {}
    for s in sessions:
        sid = s["sop_id"]
        if sid not in sop_cache:
            sop = await asyncio.to_thread(local_db.get_sop, sid)
            sop_cache[sid] = sop or {}
        s["sop_title"] = sop_cache[sid].get("title", "Unknown SOP")
    return sessions


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    session = await asyncio.to_thread(local_db.get_session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    sop = await asyncio.to_thread(local_db.get_sop, session["sop_id"])
    if not sop:
        raise HTTPException(status_code=404, detail="SOP not found")
    return {**session, "sop": sop}


@router.post("/sessions/{session_id}/steps/{step_index}/complete")
async def complete_step(session_id: str, step_index: int):
    result = await asyncio.to_thread(local_db.complete_step, session_id, step_index)
    if result is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return result


@router.post("/sessions/{session_id}/finish")
async def finish_session(session_id: str):
    session = await asyncio.to_thread(local_db.get_session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    await asyncio.to_thread(local_db.finish_session, session_id)
    return {"finished": True}


@router.get("/sessions/{session_id}/report")
async def session_report(session_id: str):
    session = await asyncio.to_thread(local_db.get_session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    sop = await asyncio.to_thread(local_db.get_sop, session["sop_id"])

    total_steps = len(sop["steps"]) if sop else 0
    completed   = len(session["step_results"])
    duration_s: Optional[float] = None
    if session.get("completed_at"):
        from datetime import datetime
        try:
            started   = datetime.fromisoformat(session["started_at"])
            finished  = datetime.fromisoformat(session["completed_at"])
            duration_s = (finished - started).total_seconds()
        except Exception:
            pass

    return {
        "session_id":     session_id,
        "employee_name":  session["employee_name"],
        "employee_email": session["employee_email"],
        "sop_title":      sop["title"] if sop else "Unknown",
        "total_steps":    total_steps,
        "steps_completed": completed,
        "completion_pct": round(completed / total_steps * 100) if total_steps else 0,
        "started_at":     session["started_at"],
        "completed_at":   session.get("completed_at"),
        "duration_seconds": duration_s,
        "step_results":   session["step_results"],
    }
