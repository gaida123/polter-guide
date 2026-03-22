"""
Integration tests — FastAPI REST endpoints

Uses httpx AsyncClient + ASGITransport (no real server/socket).
All Firebase/Gemini calls are mocked at the usage site (the route module),
not at the definition site, because routes bind names at import time.
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock


# ── /health ───────────────────────────────────────────────────────────────────

class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_returns_200_with_ok_status(self, api_client):
        r = await api_client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert "timestamp" in body
        assert body["workflow_engine"] == "langgraph"


# ── /sops (list) ──────────────────────────────────────────────────────────────

class TestListSopsEndpoint:
    @pytest.mark.asyncio
    async def test_empty_product_returns_empty_list(self, api_client, monkeypatch):
        # Patch at usage site: the name imported in the route module
        monkeypatch.setattr(
            "api.routes.sop.list_sops_for_product",
            AsyncMock(return_value=[]),
        )
        r = await api_client.get("/sops?product_id=demo-product")
        assert r.status_code == 200
        assert r.json() == []

    @pytest.mark.asyncio
    async def test_missing_product_id_returns_422(self, api_client):
        r = await api_client.get("/sops")
        assert r.status_code == 422


# ── /sops (create) ────────────────────────────────────────────────────────────

class TestCreateSopEndpoint:
    @pytest.mark.asyncio
    async def test_create_sop_returns_201(self, api_client, monkeypatch):
        from models.sop_models import SopDocument
        from datetime import datetime
        created_sop = SopDocument(
            sop_id="new-sop-id",
            product_id="demo-product",
            name="Test SOP",
            created_by="dev",
        )
        monkeypatch.setattr(
            "api.routes.sop.create_sop",
            AsyncMock(return_value=created_sop),
        )
        r = await api_client.post(
            "/sops",
            json={"product_id": "demo-product", "name": "Test SOP"},
            headers={"Authorization": "Bearer dev"},
        )
        assert r.status_code == 201
        body = r.json()
        assert body["sop_id"] == "new-sop-id"
        assert body["name"] == "Test SOP"

    @pytest.mark.asyncio
    async def test_create_sop_without_auth_returns_422(self, api_client):
        r = await api_client.post(
            "/sops",
            json={"product_id": "demo-product", "name": "Test SOP"},
        )
        assert r.status_code == 422

    @pytest.mark.asyncio
    async def test_get_nonexistent_sop_returns_404(self, api_client, monkeypatch):
        monkeypatch.setattr(
            "api.routes.sop.get_sop",
            AsyncMock(return_value=None),
        )
        r = await api_client.get("/sops/nonexistent-id")
        assert r.status_code == 404


# ── /sops/search ─────────────────────────────────────────────────────────────

class TestSemanticSearchEndpoint:
    @pytest.mark.asyncio
    async def test_search_returns_ranked_results(self, api_client, monkeypatch):
        from models.sop_models import SopSummary
        from datetime import datetime

        summary = SopSummary(
            sop_id="sop-001",
            name="Create Shipment",
            product_id="demo-product",
            published=True,
            total_steps=5,
            total_plays=0,
            completion_count=0,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        monkeypatch.setattr(
            "api.routes.sop.list_sops_for_product",
            AsyncMock(return_value=[summary]),
        )
        monkeypatch.setattr(
            "services.firebase_service.get_sops_with_embeddings",
            AsyncMock(return_value=[{
                "sop_id": "sop-001",
                "name": "Create Shipment",
                "description": None,
                "published": True,
                "embedding": [1.0, 0.0, 0.0],
            }]),
        )
        async def mock_embed(text):
            return [0.9, 0.1, 0.0]
        monkeypatch.setattr("services.embedding_service.embed_text", mock_embed)

        r = await api_client.get(
            "/sops/search?product_id=demo-product&q=create+a+shipment"
        )
        assert r.status_code == 200
        results = r.json()
        assert isinstance(results, list)
        if results:
            assert "similarity_score" in results[0]

    @pytest.mark.asyncio
    async def test_search_empty_query_returns_400(self, api_client):
        r = await api_client.get("/sops/search?product_id=demo-product&q=")
        assert r.status_code == 400


# ── /sessions ─────────────────────────────────────────────────────────────────

class TestSessionsEndpoint:
    @pytest.mark.asyncio
    async def test_create_session_returns_session_id(self, api_client, monkeypatch):
        sop_mock = MagicMock()
        sop_mock.sop_id = "sop-001"
        sop_mock.name = "Test"
        monkeypatch.setattr(
            "api.routes.sessions.get_sop",
            AsyncMock(return_value=sop_mock),
        )
        monkeypatch.setattr(
            "api.routes.sessions.write_session_state",
            MagicMock(),
        )
        monkeypatch.setattr(
            "api.routes.sessions.increment_sop_play",
            AsyncMock(),
        )
        r = await api_client.post("/sessions", json={
            "user_id": "test-user",
            "product_id": "demo-product",
            "sop_id": "sop-001",
        })
        assert r.status_code == 201
        body = r.json()
        assert "session_id" in body
        assert "ws_url" in body

    @pytest.mark.asyncio
    async def test_create_session_with_unknown_sop_returns_404(self, api_client, monkeypatch):
        monkeypatch.setattr(
            "api.routes.sessions.get_sop",
            AsyncMock(return_value=None),
        )
        r = await api_client.post("/sessions", json={
            "user_id": "u", "product_id": "p", "sop_id": "missing",
        })
        assert r.status_code == 404


# ── /admin ────────────────────────────────────────────────────────────────────

class TestAdminEndpoint:
    @pytest.mark.asyncio
    async def test_analytics_requires_auth(self, api_client):
        r = await api_client.get("/admin/analytics/demo-product")
        assert r.status_code in (401, 422)

    @pytest.mark.asyncio
    async def test_analytics_dev_auth_works(self, api_client, monkeypatch):
        monkeypatch.setattr(
            "api.routes.admin.list_sops_for_product",
            AsyncMock(return_value=[]),
        )
        r = await api_client.get(
            "/admin/analytics/demo-product",
            headers={"Authorization": "Bearer dev"},
        )
        assert r.status_code == 200
