"""
ASI:One — OpenAI-compatible chat completions for Context Agent orchestration.

Refines the merged SOP instruction after Knowledge + Vision; failures are silent
so the pipeline still returns the original Gemini/Firestore text.
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from config import settings

logger = logging.getLogger(__name__)

_SYSTEM = """You are the HandOff.AI Context orchestrator. You receive the raw \
instruction for ONE onboarding step plus light metadata from vision. \
Rewrite ONLY that instruction so it is clearer, concise, and easy to follow \
(2–5 short sentences). Rules:
- Do not invent new UI elements, URLs, or steps that are not implied by the original.
- Do not change the underlying task; preserve every required action.
- If an error dialog was detected, weave one brief sentence acknowledging it \
only if it fits the original step (do not hallucinate dialog text).
- Output plain text only — no markdown, bullets, or quotes around the whole message."""


async def refine_step_instruction(
    *,
    instruction_text: str,
    step_index: int,
    total_steps: int,
    voice_command: Optional[str],
    vision_found: bool,
    vision_confidence: float,
    detected_error_modal: bool,
    error_modal_text: Optional[str],
) -> Optional[str]:
    """
    Call ASI:One chat/completions to polish `instruction_text`.
    Returns None if ASI:One is disabled or the call fails.
    """
    if not settings.use_asi1 or not instruction_text.strip():
        return None

    user_block = (
        f"Step {step_index + 1} of {total_steps}.\n"
        f"Original instruction:\n{instruction_text.strip()}\n\n"
        f"Voice command (may be empty): {voice_command or '(none)'}\n"
        f"Vision: target_found={vision_found}, confidence={vision_confidence:.2f}\n"
        f"Error modal detected: {detected_error_modal}\n"
        f"Error modal text (may be empty): {error_modal_text or '(none)'}\n"
    )

    url = f"{settings.asi1_base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": settings.asi1_model,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": user_block},
        ],
        "temperature": 0.25,
        "max_tokens": 450,
    }
    headers = {
        "Authorization": f"Bearer {settings.asi1_api_key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=settings.asi1_timeout_seconds) as client:
            res = await client.post(url, json=payload, headers=headers)
            res.raise_for_status()
            data = res.json()
    except httpx.HTTPStatusError as e:
        logger.warning("ASI:One HTTP error: %s %s", e.response.status_code, e.response.text[:200])
        return None
    except Exception as e:
        logger.warning("ASI:One request failed: %s", e)
        return None

    try:
        choices = data.get("choices") or []
        if not choices:
            return None
        content = choices[0].get("message", {}).get("content")
        if not content or not str(content).strip():
            return None
        refined = str(content).strip()
        if len(refined) > 4000:
            refined = refined[:4000]
        return refined
    except (KeyError, IndexError, TypeError) as e:
        logger.warning("ASI:One parse error: %s", e)
        return None
