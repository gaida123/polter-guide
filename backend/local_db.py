"""
Local SQLite database for HandOff.AI — no Firebase required.
Stores SOPs and employee onboarding sessions for the company flow.
"""

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from uuid import uuid4

DB_PATH = Path(__file__).parent / "data" / "handoff.db"


def _conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    conn = _conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sops (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            role        TEXT NOT NULL DEFAULT 'General',
            description TEXT,
            steps       TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id               TEXT PRIMARY KEY,
            sop_id           TEXT NOT NULL,
            employee_name    TEXT NOT NULL,
            employee_email   TEXT,
            started_at       TEXT NOT NULL,
            completed_at     TEXT,
            current_step     INTEGER NOT NULL DEFAULT 0,
            step_results     TEXT NOT NULL DEFAULT '[]',
            report_generated INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS agent_feed (
            id           TEXT PRIMARY KEY,
            session_id   TEXT NOT NULL,
            employee_name TEXT NOT NULL,
            sop_title    TEXT NOT NULL,
            summary      TEXT NOT NULL,
            steps_done   INTEGER NOT NULL,
            total_steps  INTEGER NOT NULL,
            duration_s   REAL,
            created_at   TEXT NOT NULL
        );
    """)
    conn.commit()
    _migrate_schema(conn)
    conn.close()


def _migrate_schema(conn: sqlite3.Connection) -> None:
    """Add columns/tables introduced after first deploy (idempotent)."""
    session_cols = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
    if "report_generated" not in session_cols:
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN report_generated INTEGER NOT NULL DEFAULT 0"
        )
        conn.commit()
    feed_tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_feed'"
        ).fetchall()
    }
    if not feed_tables:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS agent_feed (
                id            TEXT PRIMARY KEY,
                session_id    TEXT NOT NULL,
                employee_name TEXT NOT NULL,
                sop_title     TEXT NOT NULL,
                summary       TEXT NOT NULL,
                steps_done    INTEGER NOT NULL,
                total_steps   INTEGER NOT NULL,
                duration_s    REAL,
                created_at    TEXT NOT NULL
            );
        """)
        conn.commit()


# ── SOPs ──────────────────────────────────────────────────────────────────────

def create_sop(title: str, role: str, description: str, steps: list[dict]) -> dict:
    conn = _conn()
    sop_id = str(uuid4())
    now    = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT INTO sops (id, title, role, description, steps, created_at) VALUES (?,?,?,?,?,?)",
        (sop_id, title, role, description, json.dumps(steps), now),
    )
    conn.commit()
    conn.close()
    return {"id": sop_id, "title": title, "role": role, "description": description,
            "steps": steps, "created_at": now}


def list_sops() -> list[dict]:
    conn = _conn()
    rows = conn.execute(
        "SELECT s.*, (SELECT COUNT(*) FROM sessions WHERE sop_id=s.id) AS plays,"
        " (SELECT COUNT(*) FROM sessions WHERE sop_id=s.id AND completed_at IS NOT NULL) AS completions"
        " FROM sops s ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["steps"] = json.loads(d["steps"])
        result.append(d)
    return result


def get_sop(sop_id: str) -> dict | None:
    conn = _conn()
    row = conn.execute("SELECT * FROM sops WHERE id=?", (sop_id,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    d["steps"] = json.loads(d["steps"])
    return d


def delete_sop(sop_id: str) -> None:
    conn = _conn()
    conn.execute("DELETE FROM sops WHERE id=?", (sop_id,))
    conn.commit()
    conn.close()


# ── Sessions ──────────────────────────────────────────────────────────────────

def create_session(sop_id: str, employee_name: str, employee_email: str = "") -> dict:
    conn = _conn()
    sid = str(uuid4())
    now = datetime.utcnow().isoformat()
    conn.execute(
        "INSERT INTO sessions (id, sop_id, employee_name, employee_email, started_at) VALUES (?,?,?,?,?)",
        (sid, sop_id, employee_name, employee_email, now),
    )
    conn.commit()
    conn.close()
    return {"id": sid, "sop_id": sop_id, "employee_name": employee_name,
            "employee_email": employee_email, "started_at": now,
            "completed_at": None, "current_step": 0, "step_results": []}


def get_session(session_id: str) -> dict | None:
    conn = _conn()
    row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    d["step_results"] = json.loads(d["step_results"])
    return d


def complete_step(session_id: str, step_index: int) -> dict | None:
    conn = _conn()
    row = conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        conn.close()
        return None
    results: list = json.loads(row["step_results"])
    now = datetime.utcnow().isoformat()
    results.append({"step_index": step_index, "completed_at": now})
    next_step = step_index + 1
    conn.execute(
        "UPDATE sessions SET current_step=?, step_results=? WHERE id=?",
        (next_step, json.dumps(results), session_id),
    )
    conn.commit()
    conn.close()
    return {"step_index": step_index, "completed_at": now}


def finish_session(session_id: str) -> None:
    conn = _conn()
    conn.execute(
        "UPDATE sessions SET completed_at=? WHERE id=?",
        (datetime.utcnow().isoformat(), session_id),
    )
    conn.commit()
    conn.close()


def get_unprocessed_completions() -> list[dict]:
    """Return completed sessions that the CompletionAgent hasn't processed yet."""
    conn = _conn()
    rows = conn.execute(
        "SELECT * FROM sessions WHERE completed_at IS NOT NULL AND report_generated=0"
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["step_results"] = json.loads(d["step_results"])
        result.append(d)
    return result


def mark_session_processed(session_id: str) -> None:
    conn = _conn()
    conn.execute("UPDATE sessions SET report_generated=1 WHERE id=?", (session_id,))
    conn.commit()
    conn.close()


def save_feed_entry(entry: dict) -> None:
    conn = _conn()
    conn.execute(
        "INSERT INTO agent_feed (id,session_id,employee_name,sop_title,summary,"
        "steps_done,total_steps,duration_s,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            entry["id"], entry["session_id"], entry["employee_name"],
            entry["sop_title"], entry["summary"], entry["steps_done"],
            entry["total_steps"], entry.get("duration_s"), entry["created_at"],
        ),
    )
    conn.commit()
    conn.close()


def get_feed(limit: int = 30) -> list[dict]:
    conn = _conn()
    rows = conn.execute(
        "SELECT * FROM agent_feed ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def list_sessions(sop_id: str | None = None) -> list[dict]:
    conn = _conn()
    if sop_id:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE sop_id=? ORDER BY started_at DESC", (sop_id,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM sessions ORDER BY started_at DESC").fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["step_results"] = json.loads(d["step_results"])
        result.append(d)
    return result
