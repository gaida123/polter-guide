"""
Optional Agentverse registration for local uAgents.

uAgents expose POST /connect with a JSON body (user_token = Agentverse API key).
This mirrors the Agent Inspector flow so agents are registered for discovery
without opening the inspector UI manually.
"""

from __future__ import annotations

import logging
import threading
import time

import httpx

from config import settings

logger = logging.getLogger(__name__)


def _connect_one(port: int, label: str) -> None:
    url = f"http://127.0.0.1:{port}/connect"
    body: dict = {
        "user_token": settings.agentverse_api_key,
        "agent_type": "uagent",
        "endpoint": f"http://127.0.0.1:{port}/submit",
    }
    if settings.agentverse_team.strip():
        body["team"] = settings.agentverse_team.strip()
    try:
        with httpx.Client(timeout=90.0) as client:
            r = client.post(url, json=body)
            if r.status_code == 200:
                data = r.json()
                ok = data.get("success", True)
                detail = data.get("detail")
                if ok:
                    logger.info("Agentverse connect OK | %s port=%s", label, port)
                else:
                    logger.warning(
                        "Agentverse connect declined | %s port=%s detail=%s",
                        label, port, detail,
                    )
            else:
                logger.warning(
                    "Agentverse connect HTTP %s | %s port=%s body=%s",
                    r.status_code, label, port, r.text[:300],
                )
    except Exception as e:
        logger.warning("Agentverse connect failed | %s port=%s: %s", label, port, e)


def _local_agent_connect_targets():
    """Only agents that run in this process (skip remote-address overrides)."""
    items = [("context_agent", settings.context_agent_port)]
    if settings.use_local_knowledge_agent:
        items.append(("knowledge_agent", settings.knowledge_agent_port))
    if settings.use_local_vision_agent:
        items.append(("vision_agent", settings.vision_agent_port))
    items.append(("completion_agent", settings.completion_agent_port))
    return items


def _run_connect_all() -> None:
    delay = max(0.0, settings.agentverse_connect_delay_seconds)
    if delay:
        time.sleep(delay)
    for label, port in _local_agent_connect_targets():
        _connect_one(port, label)


def schedule_agentverse_connect() -> None:
    """
    Start a daemon thread that POSTs /connect on each agent after a delay.
    No-op if auto-connect is off or API key is empty.
    """
    if not settings.agentverse_api_key.strip():
        return
    if not settings.agentverse_auto_connect:
        logger.info("Agentverse auto-connect skipped (agentverse_auto_connect=false)")
        return
    t = threading.Thread(
        target=_run_connect_all,
        name="agentverse-connect",
        daemon=True,
    )
    t.start()
    ports = [p for _, p in _local_agent_connect_targets()]
    logger.info(
        "Agentverse auto-connect scheduled in %.1fs for ports %s",
        settings.agentverse_connect_delay_seconds,
        ports,
    )
