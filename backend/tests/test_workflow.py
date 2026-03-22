"""
Unit tests — LangGraph workflow nodes

Each node is tested in isolation with mocked service dependencies.
The graph topology (edge routing) is tested via run_guidance_step().
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ── Helpers ───────────────────────────────────────────────────────────────────

def _base_state(**overrides) -> dict:
    """Return a minimal valid GuidanceState with safe defaults."""
    state = {
        "session_id": "test-session",
        "user_id": "test-user",
        "product_id": "test-product",
        "sop_id": "sop-001",
        "current_step_index": 0,
        "screenshot_base64": "base64encodedpng==",
        "voice_command": None,
        "user_query": None,
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
    state.update(overrides)
    return state


def _make_sop(steps=None):
    """Return a minimal SopDocument-like MagicMock."""
    from unittest.mock import MagicMock
    step = MagicMock()
    step.instruction_text = "Click the Submit button"
    step.selector_hint = "#submit-btn"
    step.requires_autofill = False
    step.sensitive_field = False
    step.input_value = None
    step.is_destructive = False

    sop = MagicMock()
    sop.sop_id = "sop-001"
    sop.name = "Test SOP"
    sop.steps = steps or [step]
    return sop


# ── classify_intent_node ──────────────────────────────────────────────────────

class TestClassifyIntentNode:
    @pytest.mark.asyncio
    async def test_no_voice_command_returns_navigate_next(self):
        from services.workflow import classify_intent_node
        result = await classify_intent_node(_base_state())
        assert result["intent"] == "navigate_next"

    @pytest.mark.asyncio
    async def test_voice_command_classified(self, monkeypatch):
        # Nodes use lazy imports — patch at the source module
        monkeypatch.setattr(
            "services.gemini_service.classify_voice_intent",
            AsyncMock(return_value="navigate_back"),
        )
        from services.workflow import classify_intent_node
        result = await classify_intent_node(_base_state(voice_command="go back"))
        assert result["intent"] == "navigate_back"

    @pytest.mark.asyncio
    async def test_classification_failure_defaults_to_navigate_next(self, monkeypatch):
        monkeypatch.setattr(
            "services.gemini_service.classify_voice_intent",
            AsyncMock(side_effect=Exception("gemini down")),
        )
        from services.workflow import classify_intent_node
        result = await classify_intent_node(_base_state(voice_command="next"))
        assert result["intent"] == "navigate_next"


# ── resolve_knowledge_node ────────────────────────────────────────────────────

class TestResolveKnowledgeNode:
    @pytest.mark.asyncio
    async def test_finds_sop_and_resolves_first_step(self, monkeypatch):
        sop = _make_sop()
        monkeypatch.setattr("services.firebase_service.get_sop", AsyncMock(return_value=sop))
        from services.workflow import resolve_knowledge_node
        result = await resolve_knowledge_node(_base_state(intent="navigate_next"))
        assert result["resolved_sop_id"] == "sop-001"
        assert result["resolved_step_index"] == 0  # only 1 step, clamped to 0
        assert result["instruction_text"] == "Click the Submit button"

    @pytest.mark.asyncio
    async def test_navigate_back_from_step_1_goes_to_step_0(self, monkeypatch):
        step_a = MagicMock(instruction_text="Step A", selector_hint=None,
                           requires_autofill=False, sensitive_field=False,
                           input_value=None, is_destructive=False)
        step_b = MagicMock(instruction_text="Step B", selector_hint=None,
                           requires_autofill=False, sensitive_field=False,
                           input_value=None, is_destructive=False)
        sop = _make_sop(steps=[step_a, step_b])
        monkeypatch.setattr("services.firebase_service.get_sop", AsyncMock(return_value=sop))
        from services.workflow import resolve_knowledge_node
        result = await resolve_knowledge_node(
            _base_state(intent="navigate_back", current_step_index=1)
        )
        assert result["resolved_step_index"] == 0

    @pytest.mark.asyncio
    async def test_sop_not_found_sets_error(self, monkeypatch):
        monkeypatch.setattr("services.firebase_service.get_sop", AsyncMock(return_value=None))
        monkeypatch.setattr(
            "services.firebase_service.get_sops_with_embeddings",
            AsyncMock(return_value=[]),
        )
        from services.workflow import resolve_knowledge_node
        result = await resolve_knowledge_node(_base_state())
        assert result.get("error") is not None
        assert "not found" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_is_final_step_set_on_last_step(self, monkeypatch):
        step = MagicMock(instruction_text="Last", selector_hint=None,
                         requires_autofill=False, sensitive_field=False,
                         input_value=None, is_destructive=False)
        sop = _make_sop(steps=[step])
        monkeypatch.setattr("services.firebase_service.get_sop", AsyncMock(return_value=sop))
        from services.workflow import resolve_knowledge_node
        result = await resolve_knowledge_node(_base_state(intent="navigate_next"))
        assert result["is_final_step"] is True

    @pytest.mark.asyncio
    async def test_skips_when_error_already_set(self, monkeypatch):
        get_sop_mock = AsyncMock(return_value=None)
        monkeypatch.setattr("services.firebase_service.get_sop", get_sop_mock)
        from services.workflow import resolve_knowledge_node
        result = await resolve_knowledge_node(_base_state(error="prior error"))
        assert result == {}


# ── resolve_vision_node ───────────────────────────────────────────────────────

class TestResolveVisionNode:
    @pytest.mark.asyncio
    async def test_coordinates_propagated(self, monkeypatch):
        monkeypatch.setattr(
            "services.gemini_service.locate_element",
            AsyncMock(return_value={
                "found": True,
                "target_x": 0.75,
                "target_y": 0.20,
                "confidence": 0.95,
                "detected_error_modal": False,
                "error_modal_text": None,
            }),
        )
        from services.workflow import resolve_vision_node
        result = await resolve_vision_node(_base_state())
        assert result["target_x"] == pytest.approx(0.75)
        assert result["target_y"] == pytest.approx(0.20)
        assert result["vision_confidence"] == pytest.approx(0.95)

    @pytest.mark.asyncio
    async def test_vision_failure_uses_fallback_coords(self, monkeypatch):
        monkeypatch.setattr(
            "services.gemini_service.locate_element",
            AsyncMock(side_effect=Exception("Gemini timeout")),
        )
        from services.workflow import resolve_vision_node
        result = await resolve_vision_node(_base_state())
        assert result["target_x"] == pytest.approx(0.5)
        assert result["target_y"] == pytest.approx(0.5)
        assert result["vision_confidence"] == pytest.approx(0.0)

    @pytest.mark.asyncio
    async def test_skips_when_error_already_set(self, monkeypatch):
        locate_mock = AsyncMock()
        monkeypatch.setattr("services.gemini_service.locate_element", locate_mock)
        from services.workflow import resolve_vision_node
        result = await resolve_vision_node(_base_state(error="prior error"))
        assert result == {}
        locate_mock.assert_not_called()


# ── route_after_vision ────────────────────────────────────────────────────────

class TestRouteAfterVision:
    def test_normal_step_goes_to_finalize(self):
        from services.workflow import route_after_vision
        assert route_after_vision(_base_state(is_destructive=False)) == "finalize"

    def test_destructive_step_goes_to_end(self):
        from services.workflow import route_after_vision
        assert route_after_vision(_base_state(is_destructive=True)) == "__end__"

    def test_error_state_goes_to_end(self):
        from services.workflow import route_after_vision
        assert route_after_vision(_base_state(error="something broke")) == "__end__"


# ── Full graph integration ────────────────────────────────────────────────────

class TestRunGuidanceStep:
    @pytest.mark.asyncio
    async def test_full_happy_path(self, monkeypatch):
        """End-to-end: all nodes succeed, finalize writes cursor."""
        step = MagicMock(instruction_text="Click Submit", selector_hint="#btn",
                         requires_autofill=False, sensitive_field=False,
                         input_value=None, is_destructive=False)
        sop = _make_sop(steps=[step])

        monkeypatch.setattr("services.gemini_service.classify_voice_intent",
                            AsyncMock(return_value="navigate_next"))
        monkeypatch.setattr("services.firebase_service.get_sop", AsyncMock(return_value=sop))
        monkeypatch.setattr("services.gemini_service.locate_element",
                            AsyncMock(return_value={
                                "found": True, "target_x": 0.6, "target_y": 0.4,
                                "confidence": 0.9, "detected_error_modal": False,
                                "error_modal_text": None,
                            }))
        monkeypatch.setattr("services.firebase_service.update_cursor_state", MagicMock())
        monkeypatch.setattr("services.firebase_service.update_session_step_index", MagicMock())

        from services.workflow import run_guidance_step
        state = await run_guidance_step(
            session_id="sess-1", user_id="u1", product_id="p1",
            sop_id="sop-001", current_step_index=0,
            screenshot_base64="base64==", voice_command="next",
        )
        assert state["error"] is None
        assert state["instruction_text"] == "Click Submit"
        assert state["target_x"] == pytest.approx(0.6)
        assert state["intent"] == "navigate_next"

    @pytest.mark.asyncio
    async def test_missing_sop_returns_error(self, monkeypatch):
        monkeypatch.setattr("services.gemini_service.classify_voice_intent",
                            AsyncMock(return_value="navigate_next"))
        monkeypatch.setattr("services.firebase_service.get_sop", AsyncMock(return_value=None))
        monkeypatch.setattr("services.firebase_service.get_sops_with_embeddings",
                            AsyncMock(return_value=[]))

        from services.workflow import run_guidance_step
        state = await run_guidance_step(
            session_id="sess-2", user_id="u1", product_id="p1",
            sop_id="nonexistent", current_step_index=0,
            screenshot_base64="base64==",
        )
        assert state["error"] is not None
