"""PostgreSQL access layer.

Connection comes from DATABASE_URL, so the same code runs against a local
server, Azure Database for PostgreSQL, or anything else that speaks Postgres:

    DATABASE_URL=postgresql://user:password@host:5432/frostedcorner

`init_schema()` is idempotent and `seed()` only fills empty tables, so both are
safe to run on every boot. The JSON files in this directory remain the seed
source for the catalog; everything mutable lives in the database from then on.
"""

import json
import os
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

_pool = None


class DatabaseUnavailable(RuntimeError):
    """Raised when the database is not configured or not reachable."""


def database_url():
    return os.environ.get("DATABASE_URL")


def _pool_or_raise():
    """One lazily-created connection pool for the process."""
    global _pool
    if _pool is not None:
        return _pool

    url = database_url()
    if not url:
        raise DatabaseUnavailable("DATABASE_URL is not set")
    try:
        from psycopg_pool import ConnectionPool
    except ImportError:
        try:
            import psycopg
        except ImportError as exc:
            raise DatabaseUnavailable("psycopg is not installed") from exc

        # No pool package: fall back to a connection per call.
        class _Direct:
            def connection(self_inner):
                return psycopg.connect(url)
        _pool = _Direct()
        return _pool

    _pool = ConnectionPool(url, min_size=1, max_size=4, open=True)
    return _pool


@contextmanager
def connect():
    """Yields a connection, committing on success and rolling back on error."""
    pool = _pool_or_raise()
    try:
        with pool.connection() as conn:
            yield conn
    except DatabaseUnavailable:
        raise
    except Exception as exc:
        raise DatabaseUnavailable(str(exc)) from exc


def query(sql, params=(), one=False):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            if cur.description is None:
                return None
            cols = [c.name for c in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    return (rows[0] if rows else None) if one else rows


def execute(sql, params=()):
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount


# ── Schema ───────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    password_salt   TEXT NOT NULL,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'customer',
    home_corner     TEXT,
    plan            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- Free-form so agents can read preferences without a migration per key.
CREATE TABLE IF NOT EXISTS preferences (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS orders (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    placed_at  DATE NOT NULL,
    channel    TEXT NOT NULL DEFAULT 'app',
    status     TEXT NOT NULL DEFAULT 'fulfilled'
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
    order_id  BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id   TEXT NOT NULL,
    quantity  INT NOT NULL DEFAULT 1,
    PRIMARY KEY (order_id, item_id)
);

CREATE TABLE IF NOT EXISTS locations (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    region        TEXT NOT NULL,
    orders_week   INT NOT NULL DEFAULT 0,
    revenue_week  NUMERIC(10,2) NOT NULL DEFAULT 0,
    change_pct    NUMERIC(5,2) NOT NULL DEFAULT 0
);

-- Stock is per location, so "Scottsdale is low" is a query rather than a claim.
CREATE TABLE IF NOT EXISTS inventory (
    location_id    TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    sku            TEXT NOT NULL,
    name           TEXT NOT NULL,
    unit           TEXT NOT NULL,
    on_hand        NUMERIC(10,2) NOT NULL,
    reorder_point  NUMERIC(10,2) NOT NULL,
    on_order       NUMERIC(10,2) NOT NULL DEFAULT 0,
    lead_time_days INT NOT NULL DEFAULT 3,
    PRIMARY KEY (location_id, sku)
);

CREATE TABLE IF NOT EXISTS supply_orders (
    id           TEXT PRIMARY KEY,
    location_id  TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    placed       DATE NOT NULL,
    eta          DATE NOT NULL,
    status       TEXT NOT NULL,
    total        NUMERIC(10,2) NOT NULL,
    lines        INT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_daily (
    day          DATE NOT NULL,
    location_id  TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    orders       INT NOT NULL,
    revenue      NUMERIC(10,2) NOT NULL,
    PRIMARY KEY (day, location_id)
);

CREATE TABLE IF NOT EXISTS item_sales (
    day      DATE NOT NULL,
    item_id  TEXT NOT NULL,
    units    INT NOT NULL,
    PRIMARY KEY (day, item_id)
);
"""


def init_schema():
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(SCHEMA)


def _json(name):
    return json.loads((DATA_DIR / name).read_text(encoding="utf-8"))


def catalog():
    """The product catalog still lives in storefront.json — it is not mutable."""
    return _json("storefront.json")


def menu_items():
    data = catalog()
    return [*data.get("weeklyMenu", []), *data.get("plantBased", [])]
