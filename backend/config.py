"""
Central configuration — all settings sourced from environment variables.
Provides a single `settings` singleton imported across the entire backend.

Agent addresses are derived deterministically from each agent's seed using
the Fetch.ai uAgents Identity class — the same way uAgents itself does it.
This lets the Context Agent know the Knowledge and Vision agents' addresses
before the Bureau starts, without any runtime name-lookup.
"""

from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


def _derive_agent_address(seed: str) -> str:
    """Compute the bech32 agent1q... address from a seed string."""
    try:
        from uagents import Identity
        return Identity.from_seed(seed, 0).address
    except Exception:
        return ""  # graceful fallback during import before deps are installed


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── App ────────────────────────────────────────────────────────────────────
    app_env: str = "development"
    app_secret_key: str = "change-me-in-production"
    log_level: str = "INFO"

    # ── FastAPI ────────────────────────────────────────────────────────────────
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    allowed_origins: str = "http://localhost:5173,http://localhost:3000"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",")]

    # ── Fetch.ai uAgents ──────────────────────────────────────────────────────
    context_agent_seed: str = "context-agent-seed-replace-me"
    knowledge_agent_seed: str = "knowledge-agent-seed-replace-me"
    vision_agent_seed: str = "vision-agent-seed-replace-me"
    completion_agent_seed: str = "handoff-completion-agent-seed-v1"

    context_agent_port: int = 8001
    knowledge_agent_port: int = 8002
    vision_agent_port: int = 8003
    completion_agent_port: int = 8004

    @property
    def context_agent_endpoint(self) -> str:
        return f"http://localhost:{self.context_agent_port}/submit"

    @property
    def knowledge_agent_endpoint(self) -> str:
        return f"http://localhost:{self.knowledge_agent_port}/submit"

    @property
    def vision_agent_endpoint(self) -> str:
        return f"http://localhost:{self.vision_agent_port}/submit"

    # Deterministic Fetch.ai addresses — derived once from seeds at startup.
    # ctx.send() requires these exact agent1q... strings.
    @property
    def knowledge_agent_address(self) -> str:
        return _derive_agent_address(self.knowledge_agent_seed)

    @property
    def vision_agent_address(self) -> str:
        return _derive_agent_address(self.vision_agent_seed)

    # Agentverse registration — agents auto-register when this key is present.
    # Get one at https://agentverse.ai → Settings → API Keys
    agentverse_api_key: str = ""

    # ASI:One — OpenAI-compatible LLM endpoint at https://api.asi1.ai/v1
    # Used by the Context Agent to polish merged step instructions when set.
    asi1_api_key: str = ""
    asi1_base_url: str = "https://api.asi1.ai/v1"
    asi1_model: str = "asi1-fast"
    asi1_timeout_seconds: int = 12

    @property
    def use_asi1(self) -> bool:
        return bool(self.asi1_api_key)

    # ── Google Gemini ─────────────────────────────────────────────────────────
    gemini_api_key: str = ""
    gemini_model: str = "gemini-1.5-flash"
    gemini_vision_timeout_seconds: int = 10

    # Embeddings — used for semantic SOP search (RAG)
    embedding_model: str = "models/text-embedding-004"
    embedding_cache_ttl: int = 3600  # seconds before in-memory cache entry expires

    # ── Firebase ──────────────────────────────────────────────────────────────
    firebase_service_account_path: str = "./firebase-service-account.json"
    firebase_realtime_db_url: str = ""

    # ── Session & safety ──────────────────────────────────────────────────────
    session_ttl_seconds: int = 3600
    autofill_require_confirmation: bool = True
    record_mode_redact_passwords: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
