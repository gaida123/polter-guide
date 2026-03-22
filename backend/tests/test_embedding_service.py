"""
Unit tests — embedding service

Tests cosine similarity math and the find_best_sop ranking logic
without any real API calls.
"""

import pytest
import math


class TestCosineSimilarity:
    def setup_method(self):
        from services.embedding_service import cosine_similarity
        self.sim = cosine_similarity

    def test_identical_vectors_return_one(self):
        v = [1.0, 0.5, 0.3]
        assert self.sim(v, v) == pytest.approx(1.0, abs=1e-5)

    def test_orthogonal_vectors_return_zero(self):
        a = [1.0, 0.0]
        b = [0.0, 1.0]
        assert self.sim(a, b) == pytest.approx(0.0, abs=1e-5)

    def test_opposite_vectors_return_negative_one(self):
        a = [1.0, 0.0]
        b = [-1.0, 0.0]
        assert self.sim(a, b) == pytest.approx(-1.0, abs=1e-5)

    def test_zero_vector_returns_zero(self):
        """Division by zero must be handled gracefully."""
        assert self.sim([0.0, 0.0], [1.0, 2.0]) == pytest.approx(0.0)

    def test_symmetry(self):
        a = [0.2, 0.8, 0.5]
        b = [0.9, 0.1, 0.3]
        assert self.sim(a, b) == pytest.approx(self.sim(b, a), abs=1e-6)


class TestEmbedSopText:
    def setup_method(self):
        from services.embedding_service import embed_sop_text
        self.build = embed_sop_text

    def test_name_only(self):
        result = self.build("Create Shipment")
        assert result == "Create Shipment"

    def test_name_and_description(self):
        result = self.build("Create Shipment", "How to create a freight shipment")
        assert "Create Shipment" in result
        assert "freight shipment" in result

    def test_first_three_steps_included(self):
        steps = [
            {"instruction_text": "Step A"},
            {"instruction_text": "Step B"},
            {"instruction_text": "Step C"},
            {"instruction_text": "Step D"},  # should be excluded
        ]
        result = self.build("My SOP", steps=steps)
        assert "Step A" in result
        assert "Step B" in result
        assert "Step C" in result
        assert "Step D" not in result


class TestFindBestSop:
    @pytest.mark.asyncio
    async def test_returns_best_match(self, monkeypatch):
        """The candidate with the highest cosine similarity is returned."""
        # Create synthetic embeddings: query is close to candidate B
        query_emb = [1.0, 0.0, 0.0]
        emb_a     = [0.0, 1.0, 0.0]  # orthogonal — low score
        emb_b     = [0.9, 0.1, 0.0]  # close to query — high score

        monkeypatch.setattr(
            "services.embedding_service.embed_text",
            lambda text: (
                [0.9, 0.1, 0.0] if "shipment" in text.lower()
                else [1.0, 0.0, 0.0]
            ),
        )
        # Override embed_text to be sync for the mock
        import services.embedding_service as emb_svc
        monkeypatch.setattr(emb_svc, "embed_text",
            lambda t: [1.0, 0.0, 0.0])

        async def mock_embed(text):
            return query_emb
        monkeypatch.setattr(emb_svc, "embed_text", mock_embed)

        candidates = [
            {"sop_id": "sop-a", "name": "Invoice Process", "embedding": emb_a},
            {"sop_id": "sop-b", "name": "Create Shipment", "embedding": emb_b},
        ]
        from services.embedding_service import find_best_sop, cosine_similarity
        result = await find_best_sop("create a shipment", candidates, min_similarity=0.0)
        assert result is not None
        sop_id, score = result
        assert sop_id == "sop-b"
        assert score == pytest.approx(cosine_similarity(query_emb, emb_b), abs=1e-5)

    @pytest.mark.asyncio
    async def test_returns_none_when_no_match_above_threshold(self, monkeypatch):
        import services.embedding_service as emb_svc
        async def mock_embed(text):
            return [1.0, 0.0]
        monkeypatch.setattr(emb_svc, "embed_text", mock_embed)

        candidates = [
            {"sop_id": "sop-x", "name": "Unrelated", "embedding": [0.0, 1.0]},
        ]
        result = await emb_svc.find_best_sop("create shipment", candidates, min_similarity=0.99)
        assert result is None

    @pytest.mark.asyncio
    async def test_empty_candidates_returns_none(self, monkeypatch):
        import services.embedding_service as emb_svc
        async def mock_embed(text):
            return [1.0, 0.0]
        monkeypatch.setattr(emb_svc, "embed_text", mock_embed)
        result = await emb_svc.find_best_sop("anything", [])
        assert result is None
