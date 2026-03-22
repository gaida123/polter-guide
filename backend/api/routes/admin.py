"""
Admin dashboard routes — analytics, product configuration, and guardrail management.
"""

import logging
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Header, status
from pydantic import BaseModel

from services.firebase_service import get_firestore, get_sop, list_sops_for_product
from models import SopDocument, SopStep, StepType
from config import settings

router = APIRouter(prefix="/admin", tags=["Admin"])
logger = logging.getLogger(__name__)


# ── Auth (same helper as sop.py — extracted to a shared dep in production) ────

async def require_admin(authorization: str = Header(...)) -> str:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        import firebase_admin.auth as fb_auth
        decoded = fb_auth.verify_id_token(token)
        return decoded["uid"]
    except Exception:
        if settings.app_env == "development":
            return token
        raise HTTPException(status_code=401, detail="Invalid token")


# ── Analytics ─────────────────────────────────────────────────────────────────

@router.get("/analytics/{product_id}", response_model=dict)
async def get_product_analytics(
    product_id: str,
    admin_uid: str = Depends(require_admin),
):
    """Aggregate usage stats across all SOPs for a product."""
    summaries = await list_sops_for_product(product_id)
    total_plays = sum(s.total_plays for s in summaries)
    total_completions = sum(s.completion_count for s in summaries)
    completion_rate = (total_completions / total_plays) if total_plays > 0 else 0.0

    return {
        "product_id": product_id,
        "total_sops": len(summaries),
        "published_sops": sum(1 for s in summaries if s.published),
        "total_plays": total_plays,
        "total_completions": total_completions,
        "overall_completion_rate": round(completion_rate, 4),
        "sops": [s.model_dump() for s in summaries],
    }


@router.get("/analytics/sop/{sop_id}", response_model=dict)
async def get_sop_analytics(
    sop_id: str,
    admin_uid: str = Depends(require_admin),
):
    sop = await get_sop(sop_id)
    if not sop:
        raise HTTPException(status_code=404, detail=f"SOP '{sop_id}' not found")

    completion_rate = (
        sop.completion_count / sop.total_plays if sop.total_plays > 0 else 0.0
    )

    return {
        "sop_id": sop_id,
        "name": sop.name,
        "total_plays": sop.total_plays,
        "completion_count": sop.completion_count,
        "completion_rate": round(completion_rate, 4),
        "avg_completion_time_seconds": sop.avg_completion_time_seconds,
        "total_steps": len(sop.steps),
    }


# ── Guardrail configuration ───────────────────────────────────────────────────

class GuardrailConfig(BaseModel):
    product_id: str
    selectors: list[str]   # CSS selectors that trigger the destructive-action overlay
    labels: list[str]      # Human-readable label hints (used by Vision Agent fallback)


@router.post("/guardrails", response_model=dict, status_code=status.HTTP_201_CREATED)
async def set_guardrails(
    body: GuardrailConfig,
    admin_uid: str = Depends(require_admin),
):
    """Save per-product guardrail selector list to Firestore."""
    db = get_firestore()
    await db.collection("guardrails").document(body.product_id).set({
        "product_id": body.product_id,
        "selectors": body.selectors,
        "labels": body.labels,
        "updated_by": admin_uid,
    })
    return {"saved": True, "product_id": body.product_id}


@router.get("/guardrails/{product_id}", response_model=GuardrailConfig)
async def get_guardrails(product_id: str):
    db = get_firestore()
    doc = await db.collection("guardrails").document(product_id).get()
    if not doc.exists:
        return GuardrailConfig(product_id=product_id, selectors=[], labels=[])
    data = doc.to_dict()
    return GuardrailConfig(
        product_id=product_id,
        selectors=data.get("selectors", []),
        labels=data.get("labels", []),
    )


# ── Product management ────────────────────────────────────────────────────────

class ProductConfig(BaseModel):
    product_id: str
    name: str
    domain: Optional[str] = None
    theme_color: Optional[str] = "#6366f1"


@router.post("/products", response_model=ProductConfig, status_code=status.HTTP_201_CREATED)
async def create_product(
    body: ProductConfig,
    admin_uid: str = Depends(require_admin),
):
    db = get_firestore()
    await db.collection("products").document(body.product_id).set(
        {**body.model_dump(), "created_by": admin_uid}
    )
    return body


@router.get("/products/{product_id}", response_model=ProductConfig)
async def get_product(product_id: str):
    db = get_firestore()
    doc = await db.collection("products").document(product_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail=f"Product '{product_id}' not found")
    return ProductConfig(**doc.to_dict())


# ── Demo seeding ──────────────────────────────────────────────────────────────

DEMO_PRODUCT_ID = "demo-product"
DEMO_SOP_ID     = "demo-sop-001"

_FREIGHTOS_STEPS: list[dict] = [
    {
        "step_index": 0,
        "step_type": StepType.CLICK,
        "instruction_text": "Welcome to FreightOS. Let's create your first shipment. Click on Shipments in the left navigation panel.",
        "selector_hint": "#nav-shipments",
        "is_destructive": False,
        "requires_autofill": False,
    },
    {
        "step_index": 1,
        "step_type": StepType.SELECT,
        "instruction_text": "Great! Now open the Shipment Type dropdown and choose your freight method — Air, Sea, or Road.",
        "selector_hint": "#shipment-type",
        "is_destructive": False,
        "requires_autofill": True,
        "input_value": "Air Freight",
    },
    {
        "step_index": 2,
        "step_type": StepType.INPUT,
        "instruction_text": "Enter the Origin Port. This is where your cargo will be loaded — for example, Shanghai.",
        "selector_hint": "#origin-port",
        "is_destructive": False,
        "requires_autofill": True,
        "input_value": "Shanghai",
    },
    {
        "step_index": 3,
        "step_type": StepType.INPUT,
        "instruction_text": "Now enter the Destination. Type the port or city where the shipment needs to be delivered.",
        "selector_hint": "#destination",
        "is_destructive": False,
        "requires_autofill": True,
        "input_value": "Los Angeles",
    },
    {
        "step_index": 4,
        "step_type": StepType.INPUT,
        "instruction_text": "Enter the Cargo Weight in kilograms. This is used to calculate freight costs.",
        "selector_hint": "#cargo-weight",
        "is_destructive": False,
        "requires_autofill": True,
        "input_value": "1200",
    },
    {
        "step_index": 5,
        "step_type": StepType.INPUT,
        "instruction_text": "Enter the Customer name — who is this shipment for?",
        "selector_hint": "#customer",
        "is_destructive": False,
        "requires_autofill": True,
        "input_value": "Acme Corp",
    },
    {
        "step_index": 6,
        "step_type": StepType.CLICK,
        "instruction_text": "Perfect. Now click Submit and Dispatch to finalise the shipment. This will send the order to the freight network.",
        "selector_hint": "#submit-dispatch",
        "is_destructive": True,
        "requires_autofill": False,
    },
]


@router.post("/seed-demo", response_model=dict)
async def seed_demo_sop():
    """
    Idempotent endpoint that creates (or refreshes) the FreightOS demo SOP
    used on the /demo page. Safe to call multiple times — re-creates with the
    same fixed sop_id so existing demo links don't break.
    """
    db = get_firestore()

    from services.embedding_service import embed_text, embed_sop_text

    sop_name = "Process Your First Shipment"
    sop_desc = "A guided walkthrough of the FreightOS new-shipment form, from navigation to dispatch."

    sop = SopDocument(
        sop_id=DEMO_SOP_ID,
        product_id=DEMO_PRODUCT_ID,
        name=sop_name,
        description=sop_desc,
        created_by="admin-seed",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
        published=True,
        steps=[SopStep(**s) for s in _FREIGHTOS_STEPS],
    )

    doc_data = sop.model_dump(mode="json")
    try:
        doc_data["_embedding"] = await embed_text(embed_sop_text(sop_name, sop_desc))
    except Exception as exc:
        logger.warning("Seed: could not generate embedding: %s", exc)

    await db.collection("sops").document(DEMO_SOP_ID).set(doc_data)

    # Also ensure the product document exists
    await db.collection("products").document(DEMO_PRODUCT_ID).set({
        "product_id": DEMO_PRODUCT_ID,
        "name": "FreightOS Demo",
        "domain": "localhost:5173",
        "theme_color": "#6366f1",
        "created_by": "admin-seed",
    }, merge=True)

    logger.info("Demo SOP seeded: %s / %s", DEMO_PRODUCT_ID, DEMO_SOP_ID)
    return {
        "seeded": True,
        "sop_id": DEMO_SOP_ID,
        "product_id": DEMO_PRODUCT_ID,
        "steps": len(_FREIGHTOS_STEPS),
    }
