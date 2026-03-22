"""
Unit tests — Gemini service

Tests the JSON parsing, coordinate clamping, and intent classification
WITHOUT making any real API calls.  The Gemini model is fully mocked.
"""

import json
import pytest
from unittest.mock import AsyncMock, patch


# ── _parse_vision_response ────────────────────────────────────────────────────

class TestParseVisionResponse:
    def setup_method(self):
        from services.gemini_service import _parse_vision_response
        self.parse = _parse_vision_response

    def test_valid_response_parsed_correctly(self):
        raw = json.dumps({
            "found": True,
            "target_x": 0.45,
            "target_y": 0.32,
            "bounding_box": {"x": 0.40, "y": 0.28, "w": 0.10, "h": 0.08},
            "detected_error_modal": False,
            "error_modal_text": None,
            "confidence": 0.92,
        })
        result = self.parse(raw)
        assert result["found"] is True
        assert result["target_x"] == pytest.approx(0.45)
        assert result["target_y"] == pytest.approx(0.32)
        assert result["confidence"] == pytest.approx(0.92)
        assert result["bounding_box"]["w"] == pytest.approx(0.10)

    def test_coordinates_clamped_to_unit_range(self):
        """Model hallucinating x=1.5 must not move cursor off-screen."""
        raw = json.dumps({
            "found": True,
            "target_x": 1.5,   # over 1.0
            "target_y": -0.2,  # under 0.0
            "bounding_box": None,
            "detected_error_modal": False,
            "error_modal_text": None,
            "confidence": 0.8,
        })
        result = self.parse(raw)
        assert result["target_x"] == pytest.approx(1.0)
        assert result["target_y"] == pytest.approx(0.0)

    def test_markdown_fenced_json_stripped(self):
        """Handles accidental ```json ... ``` wrapping from older Gemini."""
        raw = "```json\n{\"found\": false, \"target_x\": 0.0, \"target_y\": 0.0, \"bounding_box\": null, \"detected_error_modal\": false, \"error_modal_text\": null, \"confidence\": 0.0}\n```"
        result = self.parse(raw)
        assert result["found"] is False
        assert result["target_x"] == pytest.approx(0.0)

    def test_completely_invalid_json_returns_fallback(self):
        result = self.parse("not json at all !!!")
        assert result["found"] is False
        assert "_error" in result

    def test_detected_error_modal_propagated(self):
        raw = json.dumps({
            "found": True, "target_x": 0.5, "target_y": 0.5,
            "bounding_box": None,
            "detected_error_modal": True,
            "error_modal_text": "Session expired. Please log in again.",
            "confidence": 0.75,
        })
        result = self.parse(raw)
        assert result["detected_error_modal"] is True
        assert "expired" in result["error_modal_text"]

    def test_missing_fields_use_safe_defaults(self):
        raw = json.dumps({"found": True})  # minimal response
        result = self.parse(raw)
        assert result["target_x"] == pytest.approx(0.0)
        assert result["confidence"] == pytest.approx(0.0)
        assert result["detected_error_modal"] is False


# ── keyword_intent_fallback ────────────────────────────────────────────────────

class TestKeywordIntentFallback:
    def setup_method(self):
        from services.gemini_service import _keyword_intent_fallback
        self.classify = _keyword_intent_fallback

    @pytest.mark.parametrize("phrase,expected", [
        ("next step", "navigate_next"),
        ("continue please", "navigate_next"),
        ("go ahead", "navigate_next"),
        ("go back", "navigate_back"),
        ("previous step", "navigate_back"),
        ("say that again", "navigate_repeat"),
        ("repeat please", "navigate_repeat"),
        ("skip this", "navigate_skip"),
        ("yes confirm", "confirm"),
        ("okay sure", "confirm"),
        ("fill it in", "fill"),
        ("auto fill please", "fill"),
        ("what do I do here", "unknown"),
        ("purple monkey dishwasher", "unknown"),
    ])
    def test_keyword_phrases(self, phrase, expected):
        assert self.classify(phrase) == expected


# ── classify_voice_intent (LLM path) ─────────────────────────────────────────

class TestClassifyVoiceIntent:
    @pytest.mark.asyncio
    async def test_llm_path_returns_valid_intent(self, monkeypatch):
        """LLM returns a valid JSON intent → forwarded as-is."""
        mock_raw = AsyncMock(return_value='{"intent": "navigate_back"}')
        monkeypatch.setattr(
            "services.gemini_service._call_intent_with_retry", mock_raw
        )
        from services.gemini_service import classify_voice_intent
        result = await classify_voice_intent("go back", current_step_index=2)
        assert result == "navigate_back"

    @pytest.mark.asyncio
    async def test_llm_path_unknown_intent_normalised(self, monkeypatch):
        """LLM returns an unrecognised token → normalised to 'unknown'."""
        mock_raw = AsyncMock(return_value='{"intent": "teleport"}')
        monkeypatch.setattr(
            "services.gemini_service._call_intent_with_retry", mock_raw
        )
        from services.gemini_service import classify_voice_intent
        result = await classify_voice_intent("teleport me")
        assert result == "unknown"

    @pytest.mark.asyncio
    async def test_llm_failure_falls_back_to_keywords(self, monkeypatch):
        """If the LLM call throws, keyword fallback is used."""
        monkeypatch.setattr(
            "services.gemini_service._call_intent_with_retry",
            AsyncMock(side_effect=Exception("network error")),
        )
        from services.gemini_service import classify_voice_intent
        result = await classify_voice_intent("next please")
        assert result == "navigate_next"

    @pytest.mark.asyncio
    async def test_empty_command_defaults_to_navigate_next(self):
        from services.gemini_service import classify_voice_intent
        result = await classify_voice_intent("")
        assert result == "navigate_next"
