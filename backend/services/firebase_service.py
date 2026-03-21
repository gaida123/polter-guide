"""
Firebase service — wraps both Firestore (SOP/session document storage)
and Firebase Realtime Database (sub-100ms Ghost Cursor state sync).

Initialised once as a module-level singleton; safe to import anywhere.
"""

import json
import logging
from datetime import datetime
from typing import Optional
from uuid import uuid4

import firebase_admin
from firebase_admin import credentials, firestore, db as realtime_db
from google.cloud.firestore_v1 import AsyncClient

from config import settings
from models import (
    SopDocument, SopStep, SopSummary,
    SessionState, CursorState, SessionStatus,
    RecordingSession, RecordedEvent,
)

logger = logging.getLogger(__name__)

# ── Singleton initialisation ──────────────────────────────────────────────────

_app: Optional[firebase_admin.App] = None


def _init_firebase() -> firebase_admin.App:
    global _app
    if _app is not None:
        return _app
    cred = credentials.Certificate(settings.firebase_service_account_path)
    _app = firebase_admin.initialize_app(cred, {
        "databaseURL": settings.firebase_realtime_db_url,
    })
    logger.info("Firebase Admin SDK initialised")
    return _app


def get_firestore() -> AsyncClient:
    _init_firebase()
    return firestore.async_client()


def get_realtime_db():
    _init_firebase()
    return realtime_db


# ── SOP CRUD (Firestore) ──────────────────────────────────────────────────────

async def create_sop(
    product_id: str,
    name: str,
    admin_uid: str,
    description: Optional[str] = None,
) -> SopDocument:
    from services.embedding_service import embed_text, embed_sop_text
    db = get_firestore()
    sop_id = str(uuid4())
    sop = SopDocument(
        sop_id=sop_id,
        product_id=product_id,
        name=name,
        description=description,
        created_by=admin_uid,
    )
    doc_data = sop.model_dump(mode="json")
    # Store embedding alongside the document for semantic search.
    # We store it directly in the document (not in the Pydantic model) to
    # avoid serialising 768 floats in every API response.
    try:
        doc_data["_embedding"] = await embed_text(embed_sop_text(name, description))
    except Exception as exc:
        logger.warning("Could not generate SOP embedding: %s", exc)
    await db.collection("sops").document(sop_id).set(doc_data)
    logger.info("SOP created", extra={"sop_id": sop_id})
    return sop


async def get_sop(sop_id: str) -> Optional[SopDocument]:
    db = get_firestore()
    doc = await db.collection("sops").document(sop_id).get()
    if not doc.exists:
        return None
    return SopDocument(**doc.to_dict())


async def list_sops_for_product(product_id: str,
                                 published_only: bool = False) -> list[SopSummary]:
    db = get_firestore()
    query = db.collection("sops").where("product_id", "==", product_id)
    if published_only:
        query = query.where("published", "==", True)
    docs = query.stream()
    summaries: list[SopSummary] = []
    async for doc in docs:
        data = doc.to_dict()
        summaries.append(SopSummary(
            sop_id=data["sop_id"],
            name=data["name"],
            product_id=data["product_id"],
            published=data["published"],
            total_steps=len(data.get("steps", [])),
            total_plays=data.get("total_plays", 0),
            completion_count=data.get("completion_count", 0),
            created_at=data["created_at"],
            updated_at=data["updated_at"],
        ))
    return summaries


async def add_step_to_sop(sop_id: str, step: SopStep) -> SopDocument:
    db = get_firestore()
    ref = db.collection("sops").document(sop_id)
    doc = await ref.get()
    if not doc.exists:
        raise ValueError(f"SOP {sop_id} not found")
    sop = SopDocument(**doc.to_dict())
    step.step_index = len(sop.steps)
    sop.steps.append(step)
    sop.updated_at = datetime.utcnow()
    await ref.update({
        "steps": [s.model_dump(mode="json") for s in sop.steps],
        "updated_at": sop.updated_at.isoformat(),
    })
    return sop


async def publish_sop(sop_id: str, published: bool = True) -> None:
    db = get_firestore()
    await db.collection("sops").document(sop_id).update({
        "published": published,
        "updated_at": datetime.utcnow().isoformat(),
    })


async def delete_sop(sop_id: str) -> None:
    db = get_firestore()
    await db.collection("sops").document(sop_id).delete()


async def update_sop_embedding(sop_id: str, embedding: list[float]) -> None:
    """Store or refresh the semantic search embedding for a SOP."""
    db = get_firestore()
    await db.collection("sops").document(sop_id).update({
        "_embedding": embedding,
        "updated_at": datetime.utcnow().isoformat(),
    })


async def get_sops_with_embeddings(product_id: str) -> list[dict]:
    """
    Return lightweight dicts for all SOPs in a product, including their
    stored `_embedding` field.  Used by the semantic search endpoint.
    Fields returned: sop_id, name, description, published, _embedding.
    """
    db = get_firestore()
    docs = db.collection("sops").where("product_id", "==", product_id).stream()
    results: list[dict] = []
    async for doc in docs:
        data = doc.to_dict()
        results.append({
            "sop_id": data.get("sop_id", doc.id),
            "name": data.get("name", ""),
            "description": data.get("description"),
            "published": data.get("published", False),
            "embedding": data.get("_embedding"),
        })
    return results


async def increment_sop_play(sop_id: str) -> None:
    db = get_firestore()
    await db.collection("sops").document(sop_id).update({
        "total_plays": firestore.Increment(1),
    })


async def record_sop_completion(sop_id: str, duration_seconds: float) -> None:
    db = get_firestore()
    doc = await db.collection("sops").document(sop_id).get()
    if not doc.exists:
        return
    data = doc.to_dict()
    prev_count = data.get("completion_count", 0)
    prev_avg = data.get("avg_completion_time_seconds") or 0.0
    new_avg = ((prev_avg * prev_count) + duration_seconds) / (prev_count + 1)
    await db.collection("sops").document(sop_id).update({
        "completion_count": firestore.Increment(1),
        "avg_completion_time_seconds": new_avg,
    })


# ── Record Mode (Firestore) ───────────────────────────────────────────────────

async def save_recording_session(recording: RecordingSession) -> None:
    db = get_firestore()
    await db.collection("recordings").document(recording.recording_id).set(
        recording.model_dump(mode="json")
    )


async def get_recording_session(recording_id: str) -> Optional[RecordingSession]:
    db = get_firestore()
    doc = await db.collection("recordings").document(recording_id).get()
    if not doc.exists:
        return None
    return RecordingSession(**doc.to_dict())


# ── Session state (Firebase Realtime DB) ─────────────────────────────────────

def write_session_state(session: SessionState) -> None:
    """Synchronous write — called from uAgents which may not be async."""
    ref = get_realtime_db().reference(f"sessions/{session.session_id}")
    ref.set(session.model_dump(mode="json"))


def update_cursor_state(session_id: str, cursor: CursorState) -> None:
    """Hot path — only updates the cursor node for minimal latency."""
    ref = get_realtime_db().reference(f"sessions/{session_id}/cursor")
    ref.set(cursor.model_dump(mode="json"))


def update_session_status(session_id: str, status: SessionStatus,
                           completed_at: Optional[str] = None) -> None:
    ref = get_realtime_db().reference(f"sessions/{session_id}")
    payload: dict = {"status": status.value}
    if completed_at:
        payload["completed_at"] = completed_at
    ref.update(payload)


def update_session_step_index(session_id: str, step_index: int) -> None:
    """Advance the persisted step pointer after a successful workflow turn."""
    ref = get_realtime_db().reference(f"sessions/{session_id}")
    ref.update({"current_step_index": step_index})


def append_autofill_log(session_id: str, entry: dict) -> None:
    ref = get_realtime_db().reference(f"sessions/{session_id}/autofill_log")
    existing = ref.get() or []
    existing.append(entry)
    ref.set(existing)


def get_session_state(session_id: str) -> Optional[dict]:
    ref = get_realtime_db().reference(f"sessions/{session_id}")
    return ref.get()


def delete_session_state(session_id: str) -> None:
    ref = get_realtime_db().reference(f"sessions/{session_id}")
    ref.delete()
