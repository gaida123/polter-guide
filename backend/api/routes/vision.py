"""
Vision analysis endpoint — takes a screenshot and current SOP step context,
calls Gemini Vision, and returns a contextual hint for the overlay's idle-user panel.

This route is intentionally unauthenticated for the demo MVP;
add API-key or session-token auth before production deployment.
"""

import logging
from fastapi import APIRouter
from pydantic import BaseModel, Field

from services.gemini_service import analyze_screen_for_step

router = APIRouter(prefix="/vision", tags=["Vision"])
logger = logging.getLogger(__name__)


class AnalyzeScreenRequest(BaseModel):
    screenshot_base64: str          = Field(..., description="Base64-encoded PNG screenshot")
    step_index: int                  = Field(..., description="0-based current SOP step index")
    instruction_text: str            = Field(..., description="The instruction text for the current step")
    expected_screen: str | None      = Field(None, description="Description of the screen/app the user must be on")


class AnalyzeScreenResponse(BaseModel):
    on_correct_screen:   bool
    hint:                str
    element_description: str | None
    confidence:          float
    target_x:            float | None = None
    target_y:            float | None = None


@router.post("/analyze-screen", response_model=AnalyzeScreenResponse)
async def analyze_screen(body: AnalyzeScreenRequest):
    """
    Given a screenshot and current step context, return a Gemini-generated hint
    that tells the idle user exactly what to do next.
    """
    result = await analyze_screen_for_step(
        screenshot_base64=body.screenshot_base64,
        step_index=body.step_index,
        instruction_text=body.instruction_text,
        expected_screen=body.expected_screen,
    )
    logger.info(
        "Screen analysis: step=%d confident=%.2f on_correct=%s",
        body.step_index, result["confidence"], result["on_correct_screen"],
    )
    return AnalyzeScreenResponse(
        on_correct_screen=result["on_correct_screen"],
        hint=result.get("hint", ""),
        element_description=result.get("element_description"),
        confidence=result["confidence"],
        target_x=result.get("target_x"),
        target_y=result.get("target_y"),
    )
