"""
HandOff.AI Guidance Workflow — LangGraph StateGraph

The multi-step guidance cycle is modelled as a typed directed graph:

    START
      │
      ▼
  classify_intent ──► resolve_knowledge ──► resolve_vision
                                                  │
                             ┌────────────────────┴──────────────────┐
                             ▼ (is_destructive=True)                  ▼ (normal)
                       needs_guardrail_end                         finalize
                             │                                        │
                             └──────────────────────────────────────► END

Benefits over the raw asyncio.Event approach in context_agent.py:
  - Explicit typed GuidanceState flows through every node
  - Conditional routing replaces manual if/else branches  
  - MemorySaver checkpointer persists session state — a resumed session
    picks up at its last confirmed step_index automatically
  - Every node is a pure async function — individually testable
  - Observable: each node logs its inputs/outputs under its own logger key
  - Future-proof: swap in LangGraph Cloud for production checkpointing

Architecture note:
  The Fetch.ai uAgents (Context / Knowledge / Vision) remain in place for the
  Agentverse mesh and agent-to-agent discovery use-case.  This workflow is the
  *primary execution path* for the web-facing WebSocket sessions — it calls the
  same service functions directly rather than adding HTTP hops to the agents.
"""

from __future__ import annotations

import logging
from typing import Optional, Literal, TypedDict

from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver

logger = logging.getLogger(__name__)


# ── Typed workflow state ───────────────────────────────────────────────────────

class GuidanceState(TypedDict):
    """Immutable snapshot that flows through every graph node.

    Input fields are supplied at invocation time; all other fields are
    written by nodes and must have defaults so a fresh invocation is valid.
    """
    # ── inputs ────────────────────────────────────────────────────────────
    session_id: str
    user_id: str
    product_id: str
    sop_id: str
    current_step_index: int
    screenshot_base64: str
    voice_command: Optional[str]
    user_query: Optional[str]

    # ── set by classify_intent ────────────────────────────────────────────
    intent: Optional[str]

    # ── set by resolve_knowledge ──────────────────────────────────────────
    resolved_sop_id: Optional[str]
    resolved_step_index: Optional[int]
    total_steps: Optional[int]
    instruction_text: Optional[str]
    selector_hint: Optional[str]
    requires_autofill: bool
    autofill_value: Optional[str]
    is_destructive: bool
    is_final_step: bool
    matched_sop_name: Optional[str]

    # ── set by resolve_vision ─────────────────────────────────────────────
    target_x: float
    target_y: float
    vision_confidence: float
    detected_error_modal: bool
    error_modal_text: Optional[str]

    # ── control flow ──────────────────────────────────────────────────────
    error: Optional[str]


# ── Step-delta table: intent → index change ───────────────────────────────────

_INTENT_DELTA: dict[str, int] = {
    "navigate_next": 1,
    "confirm": 1,
    "fill": 1,
    "unknown": 1,
    "navigate_skip": 1,
    "navigate_back": -1,
    "navigate_repeat": 0,
    "question": 0,
    "sop_switch": 0,
}


# ── Nodes ──────────────────────────────────────────────────────────────────────

async def classify_intent_node(state: GuidanceState) -> dict:
    """
    LLM classifies the raw voice command into a typed intent token.
    Falls back to 'navigate_next' on any failure so the workflow never stalls.
    """
    cmd = state.get("voice_command")
    if not cmd:
        return {"intent": "navigate_next"}

    from services.gemini_service import classify_voice_intent
    try:
        intent = await classify_voice_intent(cmd, current_step_index=state["current_step_index"])
    except Exception as exc:
        logger.warning("[classify_intent] failed (%s) — defaulting to navigate_next", exc)
        intent = "navigate_next"

    logger.info("[classify_intent] session=%s cmd=%r -> intent=%s", state["session_id"], cmd, intent)
    return {"intent": intent}


async def resolve_knowledge_node(state: GuidanceState) -> dict:
    """
    Fetch the SOP document and resolve the target step index.

    Resolution order:
      1. Direct Firestore lookup by sop_id.
      2. Semantic search fallback using the user_query / voice_command if the
         sop_id is not found (RAG path).
    """
    if state.get("error"):
        return {}

    from services.firebase_service import get_sop, get_sops_with_embeddings
    from services.embedding_service import find_best_sop

    sop_id = state["sop_id"]
    sop = await get_sop(sop_id)
    matched_sop_name: Optional[str] = None

    if sop is None:
        query = state.get("user_query") or state.get("voice_command") or ""
        if query:
            logger.info("[resolve_knowledge] '%s' not found — semantic search: %r", sop_id, query)
            try:
                candidates = await get_sops_with_embeddings(state["product_id"])
                match = await find_best_sop(query, candidates)
                if match:
                    best_id, score = match
                    sop = await get_sop(best_id)
                    if sop:
                        sop_id = sop.sop_id
                        matched_sop_name = sop.name
                        logger.info("[resolve_knowledge] semantic match: %s score=%.3f", sop_id, score)
            except Exception as exc:
                logger.warning("[resolve_knowledge] semantic search error: %s", exc)

    if sop is None:
        return {"error": f"SOP '{state['sop_id']}' not found and semantic search found no match."}

    # Resolve step index
    intent = state.get("intent") or "navigate_next"
    delta = _INTENT_DELTA.get(intent, 1)
    total = len(sop.steps)
    step_index = max(0, min(state["current_step_index"] + delta, total - 1))
    step = sop.steps[step_index]

    logger.info(
        "[resolve_knowledge] session=%s sop=%s step=%d/%d intent=%s",
        state["session_id"], sop_id, step_index, total, intent,
    )

    return {
        "resolved_sop_id": sop_id,
        "resolved_step_index": step_index,
        "total_steps": total,
        "instruction_text": step.instruction_text,
        "selector_hint": step.selector_hint,
        "requires_autofill": step.requires_autofill and not step.sensitive_field,
        "autofill_value": (
            step.input_value
            if (step.requires_autofill and not step.sensitive_field)
            else None
        ),
        "is_destructive": step.is_destructive,
        "is_final_step": step_index == total - 1,
        "matched_sop_name": matched_sop_name,
    }


async def resolve_vision_node(state: GuidanceState) -> dict:
    """
    Locate the target UI element in the screenshot via Gemini Vision.
    Returns fallback coordinates (0.5, 0.5) on any failure so the cursor
    always appears somewhere reasonable rather than crashing the session.
    """
    if state.get("error"):
        return {}

    from services.gemini_service import locate_element
    try:
        result = await locate_element(
            state["screenshot_base64"],
            state.get("instruction_text", ""),
            state.get("selector_hint"),
        )
    except Exception as exc:
        logger.warning("[resolve_vision] failed (%s) — using fallback coords", exc)
        result = {
            "found": False,
            "target_x": 0.5,
            "target_y": 0.5,
            "confidence": 0.0,
            "detected_error_modal": False,
            "error_modal_text": None,
        }

    logger.info(
        "[resolve_vision] session=%s found=%s x=%.2f y=%.2f conf=%.2f",
        state["session_id"],
        result.get("found"),
        result.get("target_x", 0.5),
        result.get("target_y", 0.5),
        result.get("confidence", 0.0),
    )
    return {
        "target_x": result.get("target_x", 0.5),
        "target_y": result.get("target_y", 0.5),
        "vision_confidence": result.get("confidence", 0.0),
        "detected_error_modal": result.get("detected_error_modal", False),
        "error_modal_text": result.get("error_modal_text"),
    }


async def finalize_node(state: GuidanceState) -> dict:
    """
    Write the resolved cursor position to Firebase Realtime DB and update the
    session's current_step_index so the next invocation advances correctly.
    """
    if state.get("error"):
        return {}

    from services.firebase_service import update_cursor_state, update_session_step_index
    from models.session_models import CursorState

    try:
        update_cursor_state(
            state["session_id"],
            CursorState(
                x=state.get("target_x", 0.5),
                y=state.get("target_y", 0.5),
                step_index=state.get("resolved_step_index", 0),
                instruction_text=state.get("instruction_text", ""),
                is_destructive=state.get("is_destructive", False),
            ),
        )
        update_session_step_index(
            state["session_id"],
            state.get("resolved_step_index", 0),
        )
    except Exception as exc:
        logger.warning("[finalize] Firebase write failed: %s", exc)

    logger.info(
        "[finalize] session=%s step=%d cursor=(%.2f, %.2f) destructive=%s",
        state["session_id"],
        state.get("resolved_step_index", 0),
        state.get("target_x", 0.5),
        state.get("target_y", 0.5),
        state.get("is_destructive", False),
    )
    return {}


# ── Conditional routing ────────────────────────────────────────────────────────

def route_after_vision(state: GuidanceState) -> Literal["finalize", "__end__"]:
    """
    Destructive steps bypass finalize and end the graph immediately.
    The WebSocket layer reads `is_destructive` from the returned state and
    issues a GUARDRAIL_WARNING to the frontend before advancing.
    This keeps the guardrail concern in the transport layer, not the workflow.
    """
    if state.get("error"):
        return "__end__"
    if state.get("is_destructive"):
        logger.info("[route] destructive step — flagging for guardrail, skipping finalize")
        return "__end__"
    return "finalize"


# ── Graph compilation ──────────────────────────────────────────────────────────

_checkpointer = MemorySaver()


def _build_graph() -> StateGraph:
    g = StateGraph(GuidanceState)

    g.add_node("classify_intent", classify_intent_node)
    g.add_node("resolve_knowledge", resolve_knowledge_node)
    g.add_node("resolve_vision", resolve_vision_node)
    g.add_node("finalize", finalize_node)

    g.add_edge(START, "classify_intent")
    g.add_edge("classify_intent", "resolve_knowledge")
    g.add_edge("resolve_knowledge", "resolve_vision")
    g.add_conditional_edges(
        "resolve_vision",
        route_after_vision,
        {"finalize": "finalize", "__end__": END},
    )
    g.add_edge("finalize", END)

    return g.compile(checkpointer=_checkpointer)


# Singleton — imported by api/main.py and agents/context_agent.py
guidance_graph = _build_graph()


# ── Public API ────────────────────────────────────────────────────────────────

async def run_guidance_step(
    session_id: str,
    user_id: str,
    product_id: str,
    sop_id: str,
    current_step_index: int,
    screenshot_base64: str,
    voice_command: Optional[str] = None,
    user_query: Optional[str] = None,
) -> GuidanceState:
    """
    Invoke the compiled guidance graph for one user interaction turn.

    The MemorySaver checkpointer persists intermediate state keyed on
    session_id (thread_id).  This means:
      - A resumed session automatically uses the last confirmed step_index.
      - Each node's output is stored — useful for debugging and observability.

    Returns the final GuidanceState after all nodes have executed.
    """
    config = {"configurable": {"thread_id": session_id}}

    input_state: GuidanceState = {
        "session_id": session_id,
        "user_id": user_id,
        "product_id": product_id,
        "sop_id": sop_id,
        "current_step_index": current_step_index,
        "screenshot_base64": screenshot_base64,
        "voice_command": voice_command,
        "user_query": user_query,
        # Default values for node-populated fields
        "intent": None,
        "resolved_sop_id": None,
        "resolved_step_index": None,
        "total_steps": None,
        "instruction_text": None,
        "selector_hint": None,
        "requires_autofill": False,
        "autofill_value": None,
        "is_destructive": False,
        "is_final_step": False,
        "matched_sop_name": None,
        "target_x": 0.5,
        "target_y": 0.5,
        "vision_confidence": 0.0,
        "detected_error_modal": False,
        "error_modal_text": None,
        "error": None,
    }

    result: GuidanceState = await guidance_graph.ainvoke(input_state, config=config)
    return result
