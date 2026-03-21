"""
HandOff.AI MCP Server — Model Context Protocol tool provider.

Exposes HandOff.AI's core capabilities as MCP tools so that any MCP-compatible
AI host (Claude Desktop, other agents, custom LLM pipelines) can:
  - Discover available guided workflows by natural language query
  - Fetch the full step list for a given SOP
  - Start a new guided session for a user
  - Query the current live session state (cursor position, current step)

MCP transport: SSE (Server-Sent Events) — mounted on the FastAPI app at:
  GET  /mcp/sse        — establishes the SSE stream for an MCP client
  POST /mcp/messages/  — client-to-server message channel

Usage from Claude Desktop (add to claude_desktop_config.json):
  {
    "mcpServers": {
      "handoff-ai": {
        "url": "http://localhost:8000/mcp/sse"
      }
    }
  }
"""

import json
import logging
from typing import Any

from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp import types
from fastapi import FastAPI, Request

logger = logging.getLogger(__name__)


def create_mcp_server() -> Server:
    """Build and return the configured MCP server instance."""
    server = Server("handoff-ai")

    # ── Tool: search_workflow ─────────────────────────────────────────────────

    @server.list_tools()
    async def list_tools() -> list[types.Tool]:
        return [
            types.Tool(
                name="search_workflow",
                description=(
                    "Find the most relevant guided workflow (SOP) for a task description. "
                    "Returns up to 5 matching workflows ranked by semantic similarity. "
                    "Use this to discover which workflow to start before calling start_session."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "product_id": {
                            "type": "string",
                            "description": "The product/app identifier (e.g. 'freight-os')",
                        },
                        "query": {
                            "type": "string",
                            "description": "Natural language description of the task (e.g. 'create a new shipment')",
                        },
                    },
                    "required": ["product_id", "query"],
                },
            ),
            types.Tool(
                name="get_workflow",
                description=(
                    "Retrieve the full details of a specific workflow SOP including all step instructions. "
                    "Use this after search_workflow to inspect the steps before starting a session."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "sop_id": {
                            "type": "string",
                            "description": "The SOP identifier returned by search_workflow",
                        },
                    },
                    "required": ["sop_id"],
                },
            ),
            types.Tool(
                name="start_session",
                description=(
                    "Create a new guided session for a user. Returns a session_id and WebSocket URL. "
                    "The user can then connect to the WebSocket to receive real-time step guidance "
                    "and Ghost Cursor coordinates."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "user_id": {
                            "type": "string",
                            "description": "Identifier for the end user being guided",
                        },
                        "product_id": {
                            "type": "string",
                            "description": "The product/app the user is being guided through",
                        },
                        "sop_id": {
                            "type": "string",
                            "description": "The SOP to follow (from search_workflow or get_workflow)",
                        },
                    },
                    "required": ["user_id", "product_id", "sop_id"],
                },
            ),
            types.Tool(
                name="get_session_state",
                description=(
                    "Get the current state of an active guidance session: "
                    "current step index, instruction text, cursor position, "
                    "and whether the step is destructive."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "session_id": {
                            "type": "string",
                            "description": "The session identifier returned by start_session",
                        },
                    },
                    "required": ["session_id"],
                },
            ),
        ]

    # ── Tool dispatcher ───────────────────────────────────────────────────────

    @server.call_tool()
    async def call_tool(
        name: str, arguments: dict[str, Any]
    ) -> list[types.TextContent]:
        logger.info("MCP tool called: %s args=%s", name, list(arguments.keys()))

        try:
            if name == "search_workflow":
                result = await _tool_search_workflow(**arguments)
            elif name == "get_workflow":
                result = await _tool_get_workflow(**arguments)
            elif name == "start_session":
                result = await _tool_start_session(**arguments)
            elif name == "get_session_state":
                result = await _tool_get_session_state(**arguments)
            else:
                result = {"error": f"Unknown tool: {name}"}
        except Exception as exc:
            logger.error("MCP tool '%s' error: %s", name, exc)
            result = {"error": str(exc)}

        return [types.TextContent(type="text", text=json.dumps(result, indent=2, default=str))]

    return server


# ── Tool implementations ──────────────────────────────────────────────────────

async def _tool_search_workflow(product_id: str, query: str) -> dict:
    from services.firebase_service import get_sops_with_embeddings
    from services.embedding_service import embed_text, cosine_similarity, embed_sop_text

    candidates = await get_sops_with_embeddings(product_id)
    if not candidates:
        return {"matches": [], "message": "No workflows found for this product."}

    query_emb = await embed_text(query)
    scored = []
    for cand in candidates:
        stored = cand.get("embedding")
        if not stored:
            stored = await embed_text(embed_sop_text(cand["name"], cand.get("description")))
        score = cosine_similarity(query_emb, stored)
        if score >= 0.40:
            scored.append({"score": round(score, 4), **cand})

    scored.sort(key=lambda x: x["score"], reverse=True)
    matches = [
        {
            "sop_id": m["sop_id"],
            "name": m["name"],
            "description": m.get("description"),
            "published": m.get("published"),
            "similarity_score": m["score"],
        }
        for m in scored[:5]
    ]
    return {"query": query, "product_id": product_id, "matches": matches}


async def _tool_get_workflow(sop_id: str) -> dict:
    from services.firebase_service import get_sop
    sop = await get_sop(sop_id)
    if sop is None:
        return {"error": f"SOP '{sop_id}' not found."}
    return {
        "sop_id": sop.sop_id,
        "name": sop.name,
        "description": sop.description,
        "published": sop.published,
        "total_steps": len(sop.steps),
        "steps": [
            {
                "step_index": s.step_index,
                "step_type": s.step_type,
                "instruction_text": s.instruction_text,
                "is_destructive": s.is_destructive,
                "requires_autofill": s.requires_autofill,
            }
            for s in sop.steps
        ],
    }


async def _tool_start_session(user_id: str, product_id: str, sop_id: str) -> dict:
    from uuid import uuid4
    from services.firebase_service import write_session_state
    from models.session_models import SessionState, SessionStatus, CursorState

    session_id = str(uuid4())
    state = SessionState(
        session_id=session_id,
        user_id=user_id,
        product_id=product_id,
        sop_id=sop_id,
        status=SessionStatus.ACTIVE,
        current_step_index=0,
        cursor=CursorState(x=0.5, y=0.5, step_index=0),
    )
    write_session_state(state)
    return {
        "session_id": session_id,
        "ws_url": f"ws://localhost:{__import__('config').settings.api_port}/ws/{session_id}",
        "firebase_path": f"sessions/{session_id}",
        "message": "Session created. Connect to ws_url to receive real-time guidance.",
    }


async def _tool_get_session_state(session_id: str) -> dict:
    from services.firebase_service import get_session_state
    data = get_session_state(session_id)
    if data is None:
        return {"error": f"Session '{session_id}' not found."}
    cursor = data.get("cursor", {})
    return {
        "session_id": session_id,
        "status": data.get("status"),
        "current_step_index": data.get("current_step_index", 0),
        "sop_id": data.get("sop_id"),
        "cursor": {
            "x": cursor.get("x", 0.5),
            "y": cursor.get("y", 0.5),
            "instruction_text": cursor.get("instruction_text", ""),
            "is_destructive": cursor.get("is_destructive", False),
        },
    }


# ── FastAPI mounting ──────────────────────────────────────────────────────────

def mount_mcp(app: FastAPI, server: Server) -> None:
    """
    Mount the MCP server onto an existing FastAPI application.

    Two routes are added:
      GET  /mcp/sse        — SSE stream (MCP client connects here)
      POST /mcp/messages/  — message ingestion endpoint

    The SseServerTransport handles the protocol framing; our server instance
    processes the decoded MCP messages.
    """
    sse_transport = SseServerTransport("/mcp/messages/")

    @app.get("/mcp/sse", tags=["MCP"], include_in_schema=True)
    async def mcp_sse_endpoint(request: Request):
        """
        Model Context Protocol SSE endpoint.
        Connect an MCP-compatible AI host here to access HandOff.AI tools.
        """
        async with sse_transport.connect_sse(
            request.scope, request.receive, request._send
        ) as (read_stream, write_stream):
            init_options = server.create_initialization_options()
            await server.run(read_stream, write_stream, init_options)

    @app.post("/mcp/messages/", tags=["MCP"], include_in_schema=False)
    async def mcp_messages_endpoint(request: Request):
        await sse_transport.handle_post_message(
            request.scope, request.receive, request._send
        )

    logger.info("MCP server mounted at /mcp/sse")
