"""
Shared pytest fixtures — HandOff.AI backend tests.

Patching strategy:
  - Workflow nodes use lazy imports inside functions:
      from services.firebase_service import get_sop
    → patch "services.firebase_service.get_sop"

  - Route handlers bind names at module load time:
      from services import create_sop, list_sops_for_product
    → patch "api.routes.sop.create_sop" (usage site)

  - Firebase Admin init is patched globally so no credentials are needed.
"""

import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock, patch


# ── Prevent Firebase credential errors on import ──────────────────────────────

@pytest.fixture(autouse=True)
def block_firebase_init(monkeypatch):
    """
    Prevent firebase_admin.initialize_app from running during tests.
    The actual client (get_firestore / get_realtime_db) is mocked per-test
    by the api_client fixture or inline in each test.
    """
    monkeypatch.setattr(
        "firebase_admin.initialize_app",
        MagicMock(return_value=MagicMock()),
    )
    monkeypatch.setattr(
        "firebase_admin.credentials.Certificate",
        MagicMock(return_value=MagicMock()),
    )
    # Keep _app non-None so _init_firebase() short-circuits
    import services.firebase_service as fb
    monkeypatch.setattr(fb, "_app", MagicMock())


@pytest.fixture(autouse=True)
def block_gemini_configure(monkeypatch):
    """Prevent real Gemini API configuration on module load."""
    monkeypatch.setattr("google.generativeai.configure", MagicMock())


# ── Async Firestore helper ────────────────────────────────────────────────────

def make_async_stream(items=()):
    """Return an async generator that yields the given items."""
    async def _gen():
        for item in items:
            yield item
    return _gen()


def make_firestore_doc(data: dict, exists: bool = True):
    """Return a mock Firestore document snapshot."""
    doc = MagicMock()
    doc.exists = exists
    doc.to_dict.return_value = data
    doc.id = data.get("sop_id", "doc-id")
    return doc


# ── FastAPI test client ────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def api_client(monkeypatch):
    """
    Async httpx client wired directly to the FastAPI ASGI app.
    MCP mounting is skipped (SSE transport conflicts with test client).
    Firestore and Realtime DB are both stubbed out.
    """
    # Stub Firestore client
    fs_stub = MagicMock()
    async def _get_doc(*a, **kw):
        doc = MagicMock()
        doc.exists = False
        doc.to_dict.return_value = {}
        return doc
    fs_stub.collection.return_value.document.return_value.get = _get_doc
    fs_stub.collection.return_value.document.return_value.set = AsyncMock()
    fs_stub.collection.return_value.document.return_value.update = AsyncMock()
    fs_stub.collection.return_value.document.return_value.delete = AsyncMock()
    fs_stub.collection.return_value.where.return_value.stream = MagicMock(
        return_value=make_async_stream([])
    )

    # Stub Realtime DB
    rt_stub = MagicMock()
    rt_stub.reference.return_value.set = MagicMock()
    rt_stub.reference.return_value.update = MagicMock()
    rt_stub.reference.return_value.get = MagicMock(return_value=None)

    import services.firebase_service as fb
    monkeypatch.setattr(fb, "get_firestore", MagicMock(return_value=fs_stub))
    monkeypatch.setattr(fb, "get_realtime_db", MagicMock(return_value=rt_stub))

    from httpx import AsyncClient, ASGITransport
    with patch("mcp_server.mount_mcp", MagicMock()):
        from api.main import app
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://testserver",
        ) as client:
            yield client
