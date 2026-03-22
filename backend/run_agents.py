"""
run_agents.py — entry point for the HandOff.AI backend.

Each uAgent runs in its own dedicated OS thread with its own asyncio event loop.
This is required because:
  - Agent.run() blocks (it runs the agent's event loop indefinitely).
  - Python 3.10+ threads have no implicit event loop; asyncio.set_event_loop()
    must be called before Agent() is instantiated in that thread.
  - We do NOT use Bureau because it overwrites all agent endpoints, making
    individual agents unreachable from the FastAPI bridge.

Usage:
    python run_agents.py          # agents + API (default)
    python run_agents.py agents   # agents only   (Railway agents dyno)
    python run_agents.py api      # API only      (Railway api dyno)
"""

import asyncio
import sys
import threading
import time

import uvicorn

from config import settings


# ── Per-agent thread runner ───────────────────────────────────────────────────

def _run_agent_thread(module_path: str, start_delay: float = 0.0):
    """
    Run one agent inside this thread.

    1. Sleep briefly so agents start in a staggered order (avoids Almanac
       registration race conditions on first launch).
    2. Create a fresh asyncio event loop for this thread — required before
       Agent() is instantiated.
    3. Import the agent module and call create_agent().run().
    """
    time.sleep(start_delay)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    import importlib
    module = importlib.import_module(module_path)
    agent = module.create_agent()
    agent.run()


# ── Public runners ────────────────────────────────────────────────────────────

def run_agents_in_background():
    """Spawn all agent threads as daemons (API stays in foreground)."""
    agent_modules = [
        ("agents.context_agent",     0.0),
        ("agents.knowledge_agent",   1.0),
        ("agents.vision_agent",      2.0),
        ("agents.completion_agent",  3.0),   # autonomous completion reporter
    ]
    for module_path, delay in agent_modules:
        t = threading.Thread(
            target=_run_agent_thread,
            args=(module_path, delay),
            name=module_path.split(".")[-1],
            daemon=True,
        )
        t.start()


def run_agents_blocking():
    """Run agents in the foreground (blocks until Ctrl-C)."""
    agent_modules = [
        ("agents.context_agent",     0.0),
        ("agents.knowledge_agent",   1.0),
        ("agents.vision_agent",      2.0),
        ("agents.completion_agent",  3.0),
    ]
    threads = []
    for module_path, delay in agent_modules:
        t = threading.Thread(
            target=_run_agent_thread,
            args=(module_path, delay),
            name=module_path.split(".")[-1],
            daemon=False,
        )
        t.start()
        threads.append(t)
    for t in threads:
        t.join()


def run_api():
    uvicorn.run(
        "api.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=(settings.app_env == "development"),
        log_level=settings.log_level.lower(),
    )


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"

    if mode == "api":
        run_api()
    elif mode == "agents":
        run_agents_blocking()
    else:
        run_agents_in_background()
        run_api()
