"""
Gemini service — wraps all Google Gemini API calls made by HandOff.AI.
Uses the google-genai SDK (replaces deprecated google-generativeai).
"""

import json
import logging
import re
from typing import Optional

from google import genai
from google.genai import types
from google.api_core import exceptions as gapi_exc
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
    before_sleep_log,
)

from config import settings

logger = logging.getLogger(__name__)

_client = genai.Client(api_key=settings.gemini_api_key)
_MODEL  = settings.gemini_model

# Retry decorator — retries on rate-limit (429) and transient server errors
_retry = retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    retry=retry_if_exception_type((
        gapi_exc.ResourceExhausted,
        gapi_exc.ServiceUnavailable,
        gapi_exc.DeadlineExceeded,
    )),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    reraise=True,
)


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


# ── Vision helper ─────────────────────────────────────────────────────────────

import base64 as _base64


def _extract_text(response) -> str:
    """
    Extract only non-thinking text parts from a Gemini response.
    gemini-2.5-flash has a thinking mode that can prepend thought tokens
    before the actual JSON output — we skip those parts.
    """
    parts = []
    for candidate in response.candidates:
        for part in candidate.content.parts:
            if part.text and not getattr(part, "thought", False):
                parts.append(part.text)
    return "".join(parts).strip()


_THINKING_OFF = types.ThinkingConfig(thinking_budget=0)


async def _call_vision(prompt: str, image_base64: str) -> str:
    raw_bytes  = _base64.b64decode(image_base64)
    image_part = types.Part.from_bytes(data=raw_bytes, mime_type="image/png")

    response = await _client.aio.models.generate_content(
        model=_MODEL,
        contents=[prompt, image_part],
        config=types.GenerateContentConfig(
            temperature=0.05,
            max_output_tokens=2048,
            response_mime_type="application/json",
            thinking_config=_THINKING_OFF,
        ),
    )
    return _extract_text(response)


async def _call_text(prompt: str, max_tokens: int = 256) -> str:
    response = await _client.aio.models.generate_content(
        model=_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.0,
            max_output_tokens=max_tokens,
            response_mime_type="application/json",
            thinking_config=_THINKING_OFF,
        ),
    )
    return _extract_text(response)


# ── Coordinate extraction ─────────────────────────────────────────────────────

_COORDINATE_PROMPT = """\
You are a UI element locator for a web application co-pilot.

Target element: "{target_description}"
CSS selector hint (may be stale — treat as a clue only): "{selector_hint}"

Instructions:
1. Find the element described above in the screenshot.
2. Return its centre as fractional coordinates (0.0 = left/top, 1.0 = right/bottom).
3. Return a fractional bounding box {{x, y, w, h}}.
4. Report any error modal, blocking dialog, or unexpected overlay if visible.
5. Set confidence between 0.0 and 1.0.

Respond with a JSON object matching this exact schema (no markdown, no explanation):
{{
  "found": <bool>,
  "target_x": <float 0.0-1.0>,
  "target_y": <float 0.0-1.0>,
  "bounding_box": {{"x": <float>, "y": <float>, "w": <float>, "h": <float>}} or null,
  "detected_error_modal": <bool>,
  "error_modal_text": <string or null>,
  "confidence": <float 0.0-1.0>
}}
"""


async def locate_element(
    screenshot_base64: str,
    target_description: str,
    selector_hint: Optional[str] = None,
) -> dict:
    prompt = _COORDINATE_PROMPT.format(
        target_description=target_description,
        selector_hint=selector_hint or "none provided",
    )
    try:
        raw = await _call_vision(prompt, screenshot_base64)
        return _parse_vision_response(raw)
    except Exception as exc:
        logger.error("Gemini Vision failed: %s", exc)
        return _vision_fallback(str(exc))


def _parse_vision_response(raw: str) -> dict:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        cleaned = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`")
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            logger.warning("Unparseable vision response: %s", exc)
            return _vision_fallback(f"parse_error: {exc}")

    bbox = data.get("bounding_box")
    if isinstance(bbox, dict):
        bbox = {k: _clamp(float(bbox.get(k, 0.0))) for k in ("x", "y", "w", "h")}

    return {
        "found":                  bool(data.get("found", False)),
        "target_x":               _clamp(float(data.get("target_x", 0.0))),
        "target_y":               _clamp(float(data.get("target_y", 0.0))),
        "bounding_box":           bbox,
        "detected_error_modal":   bool(data.get("detected_error_modal", False)),
        "error_modal_text":       data.get("error_modal_text") or None,
        "confidence":             _clamp(float(data.get("confidence", 0.0))),
    }


def _vision_fallback(reason: str) -> dict:
    return {
        "found": False, "target_x": 0.5, "target_y": 0.5,
        "bounding_box": None, "detected_error_modal": False,
        "error_modal_text": None, "confidence": 0.0, "_error": reason,
    }


# ── Voice intent classification ───────────────────────────────────────────────

_VALID_INTENTS = frozenset({
    "navigate_next", "navigate_back", "navigate_repeat", "navigate_skip",
    "confirm", "fill", "question", "sop_switch", "unknown",
})

_INTENT_PROMPT = """\
Classify the user's voice command for a guided SaaS onboarding co-pilot.

Current step index: {step_index}
User said: "{command}"

Choose exactly one intent from this list:
  navigate_next   — user wants to proceed to the next step
  navigate_back   — user wants to revisit the previous step
  navigate_repeat — user wants the current instruction repeated
  navigate_skip   — user wants to skip the current step
  confirm         — user is confirming or approving an action
  fill            — user wants a form field filled in automatically
  question        — user is asking a question about the current step
  sop_switch      — user wants to switch to a completely different workflow
  unknown         — none of the above apply

Respond with a JSON object only — no explanation:
{{"intent": "<one of the above>"}}
"""


async def classify_voice_intent(command: str, current_step_index: int = 0) -> str:
    if not command or not command.strip():
        return "navigate_next"
    prompt = _INTENT_PROMPT.format(
        step_index=current_step_index,
        command=command.replace('"', "'"),
    )
    try:
        raw  = await _call_text(prompt, max_tokens=32)
        data = json.loads(raw)
        intent = data.get("intent", "unknown")
        return intent if intent in _VALID_INTENTS else "unknown"
    except Exception as exc:
        logger.warning("Intent classification failed: %s", exc)
        return _keyword_intent_fallback(command)


def _keyword_intent_fallback(command: str) -> str:
    cmd = command.lower()
    if any(k in cmd for k in ("next", "continue", "proceed", "go ahead", "done")):
        return "navigate_next"
    if any(k in cmd for k in ("back", "previous", "go back")):
        return "navigate_back"
    if any(k in cmd for k in ("repeat", "again", "say that", "what was")):
        return "navigate_repeat"
    if any(k in cmd for k in ("skip",)):
        return "navigate_skip"
    if any(k in cmd for k in ("yes", "confirm", "ok", "okay", "sure", "do it")):
        return "confirm"
    if any(k in cmd for k in ("fill", "autofill", "auto fill", "enter it")):
        return "fill"
    return "unknown"


# ── SOP generation from Record Mode events ────────────────────────────────────

_SOP_GENERATION_PROMPT = """\
You are an expert technical writer. Convert the following list of raw DOM interaction events into a clear, friendly, numbered SOP that a new user can follow.

DOM Events (JSON array):
{events_json}

Rules:
- Write each instruction in plain English, second person ("Click the…", "Type your…", "Select…").
- Keep each instruction under 20 words so it sounds natural when read aloud via text-to-speech.
- Mark any step that involves submitting, deleting, or publishing as is_destructive: true.
- Mark form-field steps with requires_autofill: true only if a non-sensitive value was captured.
- Mark password or secret fields with sensitive_field: true.
- Use step_type: one of click, input, select, navigate, confirm.

Return a JSON array only — no markdown, no explanation:
[
  {{
    "step_index": 0,
    "step_type": "click|input|select|navigate|confirm",
    "instruction_text": "...",
    "selector_hint": "...",
    "input_value": null,
    "is_destructive": false,
    "requires_autofill": false,
    "sensitive_field": false
  }}
]
"""


async def generate_sop_steps(events: list[dict]) -> list[dict]:
    prompt = _SOP_GENERATION_PROMPT.format(
        events_json=json.dumps(events, indent=2, default=str)
    )
    try:
        raw    = await _call_text(prompt, max_tokens=2048)
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            for v in parsed.values():
                if isinstance(v, list):
                    parsed = v
                    break
        return parsed if isinstance(parsed, list) else []
    except Exception as exc:
        logger.error("SOP generation failed: %s", exc)
        return []


# ── SOP generation from plain-text description ────────────────────────────────

_PLAIN_TEXT_SOP_PROMPT = """\
You are an expert onboarding designer. Convert the following plain-English description of an onboarding workflow into a structured step list that a new employee can follow with guided screen assistance.

Description: "{description}"

Rules:
- Break the description into clear, atomic steps (one action per step).
- Each step has: a short title (3-5 words), a friendly instruction (max 25 words, second person), and a precise expected_screen description that includes the URL and the specific UI element that must be visible.
- The expected_screen must be detailed enough for an AI vision model to verify: include the URL domain and the key visible element (e.g. "Google accounts sign-in page at accounts.google.com with an email text input field and 'Next' button").
- Aim for 4-10 steps.

Return a JSON array only — no markdown:
[
  {{
    "title": "<3-5 word title>",
    "instruction": "<friendly instruction, max 25 words>",
    "expected": "<precise URL + UI element description for verification>"
  }}
]
"""


async def generate_steps_from_description(description: str) -> list[dict]:
    """Generate SOP steps from a plain-English description."""
    prompt = _PLAIN_TEXT_SOP_PROMPT.format(description=description.replace('"', "'"))
    try:
        raw    = await _call_text(prompt, max_tokens=2048)
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            for v in parsed.values():
                if isinstance(v, list):
                    parsed = v
                    break
        if isinstance(parsed, list):
            return [
                {
                    "title":       s.get("title", f"Step {i+1}"),
                    "instruction": s.get("instruction", ""),
                    "expected":    s.get("expected", ""),
                }
                for i, s in enumerate(parsed)
            ]
        return []
    except Exception as exc:
        logger.error("Plain-text SOP generation failed: %s", exc)
        return []


# ── SOP generation from uploaded document / image ─────────────────────────────

_FILE_SOP_PROMPT = """\
You are an expert onboarding designer. Analyse the attached document (which may be a PDF, Word document, text file, or screenshot of an SOP).

Extract the onboarding steps described in the document and convert them into a structured step list that a new employee can follow with guided screen assistance.

Rules:
- Each step must be a single, atomic action (one click, one navigation, one form field, etc.).
- Each step has three fields:
    title       — 3-5 word summary of the action
    instruction — friendly, second-person instruction (max 25 words), e.g. "Click the blue Sign In button in the top-right corner."
    expected    — precise description of what the screen must show AFTER the step is done, including the URL/app name and the key visible element (e.g. "Google accounts page at accounts.google.com showing an email input field and a Next button").
- If the document contains vague or high-level phases (e.g. "Set up email"), break them into concrete sub-steps.
- Aim for 4-12 steps total.
- Ignore any headers, footers, logos, or page numbers — focus only on instructional content.

Return a JSON array only — no markdown, no explanation:
[
  {{
    "title": "<3-5 word title>",
    "instruction": "<friendly instruction, max 25 words>",
    "expected": "<precise URL/app + UI element description for verification>"
  }}
]
"""


async def generate_steps_from_file(file_bytes: bytes, mime_type: str) -> list[dict]:
    """
    Generate SOP steps from an uploaded document or image.
    Supports: application/pdf, text/plain, image/png, image/jpeg, image/webp.
    For DOCX/other text formats, pass the extracted text as text/plain bytes.
    """
    image_part = types.Part.from_bytes(data=file_bytes, mime_type=mime_type)

    try:
        response = await _client.aio.models.generate_content(
            model=_MODEL,
            contents=[_FILE_SOP_PROMPT, image_part],
            config=types.GenerateContentConfig(
                temperature=0.1,
                max_output_tokens=4096,
                response_mime_type="application/json",
                thinking_config=_THINKING_OFF,
            ),
        )
        raw = _extract_text(response)

        # Robust JSON extraction
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r'\[.*\]', raw, re.DOTALL)
            if m:
                parsed = json.loads(m.group())
            else:
                raise

        if isinstance(parsed, dict):
            for v in parsed.values():
                if isinstance(v, list):
                    parsed = v
                    break

        if isinstance(parsed, list):
            return [
                {
                    "title":       s.get("title", f"Step {i+1}"),
                    "instruction": s.get("instruction", ""),
                    "expected":    s.get("expected", ""),
                }
                for i, s in enumerate(parsed)
            ]
        return []
    except Exception as exc:
        logger.error("File-based SOP generation failed: %s", exc)
        return []


# ── Screen analysis for step verification + idle hints ────────────────────────

_ANALYZE_SCREEN_PROMPT = """\
You are a strict onboarding verification assistant. A user just clicked "Done" claiming they completed a step. Verify by carefully examining the screenshot.

Step {step_index} they claimed to complete:
  Task: "{instruction_text}"
  Required screen: "{expected_screen}"

VERIFICATION RULES — read carefully:
1. Look at the browser's address bar (URL bar) at the top of the Chrome/browser window. The URL must match the required screen. For example:
   - "accounts.google.com" ≠ "workspace.google.com" ≠ "gmail.com" — these are DIFFERENT pages.
   - "gmail.com" marketing page (shows "Create an account" / "Sign in" buttons) ≠ the actual sign-in form at accounts.google.com.
2. Look at the main page content below the browser bar. The page must show the SPECIFIC elements described in the required screen (e.g. an email input field, a password field, etc.).
3. There may be a small dark overlay widget at the top of the screen — IGNORE it entirely. Judge only the browser content behind it.
4. on_correct_screen = TRUE only if BOTH the URL AND the visible page content clearly match the required screen.
5. Be strict. If there is any doubt, set on_correct_screen to FALSE.

Also provide:
- A short hint (max 20 words) telling the user what to do next to reach the required screen.
- The fractional coordinates (0.0–1.0) of the next element the user needs to click.

Return JSON only — no markdown:
{{
  "on_correct_screen": <bool>,
  "hint": "<one concise sentence, max 20 words>",
  "element_description": "<brief description of the element and its location>",
  "confidence": <float 0.0-1.0>,
  "target_x": <float 0.0-1.0 or null>,
  "target_y": <float 0.0-1.0 or null>
}}
"""


async def analyze_screen_for_step(
    screenshot_base64: str,
    step_index: int,
    instruction_text: str,
    expected_screen: str | None = None,
) -> dict:
    prompt = _ANALYZE_SCREEN_PROMPT.format(
        step_index=step_index,
        instruction_text=instruction_text,
        expected_screen=expected_screen or instruction_text,
    )
    try:
        raw  = await _call_vision(prompt, screenshot_base64)
        # Robust parse: try direct, then extract first {...} block
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r'\{.*\}', raw, re.DOTALL)
            if not m:
                raise
            data = json.loads(m.group())
        tx = data.get("target_x")
        ty = data.get("target_y")
        return {
            "on_correct_screen":   bool(data.get("on_correct_screen", False)),
            "hint":                data.get("hint", ""),
            "element_description": data.get("element_description"),
            "confidence":          _clamp(float(data.get("confidence", 0.0))),
            "target_x":            _clamp(float(tx)) if tx is not None else None,
            "target_y":            _clamp(float(ty)) if ty is not None else None,
        }
    except Exception as exc:
        logger.error("Screen analysis failed: %s", exc)
        return {
            "on_correct_screen": False,
            "hint": "",
            "element_description": None,
            "confidence": 0.0,
            "target_x": None,
            "target_y": None,
            "_error": str(exc),
        }
