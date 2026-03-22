"""
SOP management routes — Admin CRUD for Standard Operating Procedures
and the Record Mode → SOP generation pipeline.

All endpoints require a Firebase ID token in the Authorization header.
"""

import logging
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Header, status

from models import (
    SopDocument, SopStep, SopSummary,
    CreateSopRequest, AddStepRequest, UpdateSopRequest,
    RecordingSession, RecordedEvent,
)
from services import (
    create_sop, get_sop, list_sops_for_product, add_step_to_sop,
    publish_sop, delete_sop,
    save_recording_session, get_recording_session,
    generate_sop_steps,
)
from config import settings

router = APIRouter(prefix="/sops", tags=["SOPs"])
logger = logging.getLogger(__name__)


# ── Auth helper (lightweight — production would verify Firebase ID token) ─────

async def get_admin_uid(authorization: str = Header(...)) -> str:
    """
    Validates the Firebase ID token from the Authorization: Bearer <token> header.
    For the hackathon MVP, we decode without full verification.
    In production, use firebase_admin.auth.verify_id_token().
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Empty token")

    try:
        import firebase_admin.auth as fb_auth
        decoded = fb_auth.verify_id_token(token)
        return decoded["uid"]
    except Exception:
        # Fallback for local dev — accept any non-empty token as "admin"
        if settings.app_env == "development":
            return token
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


# ── SOP CRUD ──────────────────────────────────────────────────────────────────

@router.post("", response_model=SopDocument, status_code=status.HTTP_201_CREATED)
async def create_sop_endpoint(
    body: CreateSopRequest,
    admin_uid: str = Depends(get_admin_uid),
):
    return await create_sop(
        product_id=body.product_id,
        name=body.name,
        admin_uid=admin_uid,
        description=body.description,
    )


@router.get("", response_model=list[SopSummary])
async def list_sops(product_id: str, published_only: bool = False):
    return await list_sops_for_product(product_id, published_only=published_only)


# ── Semantic SOP search — must be registered BEFORE /{sop_id} ────────────────

class SopSearchResult(SopSummary):
    similarity_score: float = 0.0


@router.get("/search", response_model=list[SopSearchResult])
async def semantic_search_sops(
    product_id: str,
    q: str,
    limit: int = 5,
    min_score: float = 0.45,
):
    """
    Natural-language SOP search.
    Embed the query with text-embedding-004, compare against stored SOP embeddings
    and return up to `limit` results ranked by cosine similarity.

    Example:
        GET /sops/search?product_id=freight-os&q=how+do+I+create+a+new+shipment
    """
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query parameter 'q' must not be empty")

    from services.embedding_service import embed_text, cosine_similarity
    from services import get_sops_with_embeddings as fetch_with_embs

    candidates = await fetch_with_embs(product_id)
    if not candidates:
        return []

    query_emb = await embed_text(q)
    scored: list[tuple[float, dict]] = []

    for cand in candidates:
        stored = cand.get("embedding")
        if not stored:
            from services.embedding_service import embed_sop_text
            stored = await embed_text(embed_sop_text(cand["name"], cand.get("description")))
        score = cosine_similarity(query_emb, stored)
        if score >= min_score:
            scored.append((score, cand))

    scored.sort(key=lambda t: t[0], reverse=True)

    summaries = await list_sops_for_product(product_id)
    summary_map = {s.sop_id: s for s in summaries}

    results: list[SopSearchResult] = []
    for score, cand in scored[:limit]:
        s = summary_map.get(cand["sop_id"])
        if s:
            results.append(SopSearchResult(**s.model_dump(), similarity_score=round(score, 4)))

    return results


@router.get("/{sop_id}", response_model=SopDocument)
async def get_sop_endpoint(sop_id: str):
    sop = await get_sop(sop_id)
    if not sop:
        raise HTTPException(status_code=404, detail=f"SOP '{sop_id}' not found")
    return sop


@router.patch("/{sop_id}", response_model=dict)
async def update_sop_endpoint(
    sop_id: str,
    body: UpdateSopRequest,
    admin_uid: str = Depends(get_admin_uid),
):
    from services.firebase_service import get_firestore
    from google.cloud.firestore_v1 import firestore as fs_module

    sop = await get_sop(sop_id)
    if not sop:
        raise HTTPException(status_code=404, detail=f"SOP '{sop_id}' not found")

    db = get_firestore()
    updates: dict = {"updated_at": datetime.utcnow().isoformat()}
    if body.name is not None:
        updates["name"] = body.name
    if body.description is not None:
        updates["description"] = body.description
    if body.published is not None:
        updates["published"] = body.published

    await db.collection("sops").document(sop_id).update(updates)
    return {"updated": True}


@router.delete("/{sop_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_sop_endpoint(
    sop_id: str,
    admin_uid: str = Depends(get_admin_uid),
):
    await delete_sop(sop_id)


# ── Step management ───────────────────────────────────────────────────────────

@router.post("/{sop_id}/steps", response_model=SopDocument, status_code=status.HTTP_201_CREATED)
async def add_step_endpoint(
    sop_id: str,
    body: AddStepRequest,
    admin_uid: str = Depends(get_admin_uid),
):
    step = SopStep(
        step_index=0,   # will be recalculated by add_step_to_sop
        step_type=body.step_type,
        instruction_text=body.instruction_text,
        selector_hint=body.selector_hint,
        input_value=body.input_value,
        is_destructive=body.is_destructive,
        requires_autofill=body.requires_autofill,
        sensitive_field=body.sensitive_field,
    )
    return await add_step_to_sop(sop_id, step)


@router.post("/{sop_id}/publish", response_model=dict)
async def publish_sop_endpoint(
    sop_id: str,
    admin_uid: str = Depends(get_admin_uid),
):
    await publish_sop(sop_id, published=True)
    return {"published": True}


@router.post("/{sop_id}/unpublish", response_model=dict)
async def unpublish_sop_endpoint(
    sop_id: str,
    admin_uid: str = Depends(get_admin_uid),
):
    await publish_sop(sop_id, published=False)
    return {"published": False}


# ── Record Mode → SOP generation ─────────────────────────────────────────────

@router.post("/record/start", response_model=dict, status_code=status.HTTP_201_CREATED)
async def start_recording(
    product_id: str,
    admin_uid: str = Depends(get_admin_uid),
):
    recording_id = str(uuid4())
    recording = RecordingSession(
        recording_id=recording_id,
        product_id=product_id,
        admin_user_id=admin_uid,
        started_at=datetime.utcnow(),
    )
    await save_recording_session(recording)
    return {"recording_id": recording_id}


@router.post("/record/{recording_id}/events", response_model=dict)
async def append_recording_events(
    recording_id: str,
    events: list[RecordedEvent],
    admin_uid: str = Depends(get_admin_uid),
):
    recording = await get_recording_session(recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording session not found")

    # Redact password fields per PRD open question resolution
    sanitised: list[RecordedEvent] = []
    for ev in events:
        if ev.is_password_field and settings.record_mode_redact_passwords:
            ev = ev.model_copy(update={"input_value": None})
        sanitised.append(ev)

    recording.events.extend(sanitised)
    await save_recording_session(recording)
    return {"appended": len(sanitised)}


@router.post("/record/{recording_id}/finalise", response_model=SopDocument)
async def finalise_recording(
    recording_id: str,
    sop_name: str,
    admin_uid: str = Depends(get_admin_uid),
):
    """
    Stop recording, send events to Gemini for SOP step generation,
    and return the newly created SOP document.
    """
    recording = await get_recording_session(recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording session not found")

    events_dicts = [ev.model_dump(mode="json") for ev in recording.events]
    generated_steps = await generate_sop_steps(events_dicts)

    sop = await create_sop(
        product_id=recording.product_id,
        name=sop_name,
        admin_uid=admin_uid,
    )

    for raw_step in generated_steps:
        from models import StepType
        step = SopStep(
            step_index=raw_step.get("step_index", 0),
            step_type=StepType(raw_step.get("step_type", "click")),
            instruction_text=raw_step.get("instruction_text", ""),
            selector_hint=raw_step.get("selector_hint"),
            input_value=raw_step.get("input_value"),
            is_destructive=raw_step.get("is_destructive", False),
            requires_autofill=raw_step.get("requires_autofill", False),
            sensitive_field=raw_step.get("sensitive_field", False),
        )
        sop = await add_step_to_sop(sop.sop_id, step)

    # Refresh embedding now that the SOP has full step content
    try:
        from services.embedding_service import embed_text, embed_sop_text
        from services.firebase_service import update_sop_embedding
        step_dicts = [s.model_dump(mode="json") for s in sop.steps]
        emb = await embed_text(embed_sop_text(sop.name, sop.description, step_dicts))
        await update_sop_embedding(sop.sop_id, emb)
    except Exception as exc:
        logger.warning("Could not refresh SOP embedding after finalise: %s", exc)

    logger.info("SOP generated from recording", extra={"sop_id": sop.sop_id, "steps": len(sop.steps)})
    return sop
