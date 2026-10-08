import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

from readiness import (
    check_readiness,
    collect_readiness,
    load_manifest,
    expected_migration_count,
    reset_readiness_cache,
)

SECRET = "s3cr3t-pr0d-pw"
MANIFEST = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "src", "lib", "migrations", "manifest.json",
)
MANIFEST_ENTRIES = load_manifest(MANIFEST)


def prod_env(**overrides):
    env = {
        "NODE_ENV": "production",
        "DATABASE_URL": f"postgresql://svc:{SECRET}@db.example.internal:5432/appdb?sslmode=verify-full",
        "SECRET_KEY": "real-prod-secret-" + "x" * 32,
        "JWT_SECRET": "real-jwt-secret-" + "y" * 32,
        "LEGITIFY_API_BASE_URL": "https://api.legitify.example",
    }
    env.update(overrides)
    return env


class FakePool:
    def __init__(self, ledger=None, db_fails=False, ledger_fails=False):
        self.ledger = (
            [{"filename": f, "checksum": s} for f, s in MANIFEST_ENTRIES.items()]
            if ledger is None else ledger
        )
        self.db_fails, self.ledger_fails = db_fails, ledger_fails
        self.calls = []

    async def fetchval(self, sql, timeout=None):
        self.calls.append(sql)
        if self.db_fails:
            raise RuntimeError("connection refused — host detail must not leak")
        return 1

    async def fetch(self, sql, timeout=None):
        self.calls.append(sql)
        if self.db_fails:
            raise RuntimeError("connection refused")
        if self.ledger_fails:
            raise RuntimeError("relation does not exist")
        return self.ledger


class ProductionConfigValidationTests(unittest.TestCase):
    def test_valid_production_configuration_loads(self):
        from config import load_settings
        with patch.dict(os.environ, prod_env(), clear=True):
            settings = load_settings()
            self.assertEqual(settings.node_env, "production")

    def test_missing_jwt_secret_is_rejected(self):
        from config import load_settings
        env = prod_env()
        del env["JWT_SECRET"]
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ValueError) as ctx:
                load_settings()
        self.assertIn("JWT_SECRET", str(ctx.exception))

    def test_missing_database_config_is_rejected(self):
        from config import load_settings
        env = prod_env()
        del env["DATABASE_URL"]
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ValueError) as ctx:
                load_settings()
        self.assertIn("DB_", str(ctx.exception))

    def test_placeholder_and_unsafe_values_are_rejected(self):
        from config import load_settings
        for overrides in (
            {"DATABASE_URL": f"postgresql://svc:{SECRET}@h/db?sslmode=disable"},
            {"DATABASE_URL": "not-a-url"},
            # plain-http upstream is refused in production — the internal-lane
            # contract is undecided, so it fails closed on https
            {"LEGITIFY_API_BASE_URL": "http://legitify.internal:8000"},
            {"LEGITIFY_API_BASE_URL": "https://localhost"},
            {"LEGACY_ACCOUNTABLE_INSTITUTION_ID": "42"},
        ):
            with patch.dict(os.environ, prod_env(**overrides), clear=True):
                with self.assertRaises(ValueError, msg=str(overrides)):
                    load_settings()

    def test_error_messages_never_contain_secret_values(self):
        from config import load_settings
        env = prod_env(DATABASE_URL=f"postgresql://svc:{SECRET}@h/db?sslmode=disable")
        with patch.dict(os.environ, env, clear=True):
            try:
                load_settings()
            except ValueError as e:
                self.assertNotIn(SECRET, str(e))
                self.assertNotIn("db.example.internal", str(e))

    def test_development_defaults_still_load(self):
        from config import load_settings
        env = {"NODE_ENV": "development", "DB_USER": "your_username", "DB_PASSWORD": "your_password"}
        with patch.dict(os.environ, env, clear=True):
            settings = load_settings()
            self.assertEqual(settings.db_user, "your_username")


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        reset_readiness_cache()
        self.env = patch.dict(os.environ, {"MIGRATIONS_MANIFEST": MANIFEST})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        reset_readiness_cache()

    async def test_ready_when_every_manifest_file_and_checksum_matches(self):
        r = await check_readiness(FakePool())
        self.assertTrue(r["ready"])
        self.assertEqual(r["checks"], {"config": "ok", "database": "ok", "schema": "ok"})

    async def test_equal_count_but_wrong_name_is_not_ready(self):
        ledger = [{"filename": f, "checksum": s} for f, s in MANIFEST_ENTRIES.items()]
        ledger[0] = {"filename": "999_not_in_manifest.sql",
                     "checksum": next(iter(MANIFEST_ENTRIES.values()))}
        r = await check_readiness(FakePool(ledger=ledger))
        self.assertEqual(r["checks"]["schema"], "schema-missing-migrations")
        self.assertFalse(r["ready"])

    async def test_equal_count_but_wrong_checksum_is_not_ready(self):
        entries = list(MANIFEST_ENTRIES.items())
        ledger = [{"filename": f, "checksum": s} for f, s in entries]
        ledger[1] = {"filename": entries[1][0], "checksum": "f" * 64}
        r = await check_readiness(FakePool(ledger=ledger))
        self.assertEqual(r["checks"]["schema"], "schema-checksum-mismatch")
        self.assertFalse(r["ready"])

    async def test_extra_ledger_row_beyond_manifest_is_schema_drift(self):
        ledger = [{"filename": f, "checksum": s} for f, s in MANIFEST_ENTRIES.items()]
        ledger.append({"filename": "028_extra.sql", "checksum": "a" * 64})
        r = await check_readiness(FakePool(ledger=ledger))
        self.assertEqual(r["checks"]["schema"], "schema-drift")
        self.assertFalse(r["ready"])

    async def test_unavailable_database_short_circuits_schema_probe(self):
        pool = FakePool(db_fails=True)
        r = await check_readiness(pool)
        self.assertFalse(r["ready"])
        self.assertEqual(r["checks"]["database"], "unavailable")
        self.assertEqual(len(pool.calls), 1)

    async def test_missing_ledger_table_is_not_ready(self):
        r = await check_readiness(FakePool(ledger_fails=True))
        self.assertEqual(r["checks"]["schema"], "ledger-missing")

    async def test_missing_manifest_fails_closed(self):
        with patch.dict(os.environ, {"MIGRATIONS_MANIFEST": "/nonexistent/manifest.json"}):
            reset_readiness_cache()
            r = await check_readiness(FakePool())
        self.assertEqual(r["checks"]["schema"], "manifest-unavailable")
        self.assertFalse(r["ready"])

    async def test_invalid_config_keeps_service_not_ready(self):
        r = await check_readiness(FakePool(), config_valid=False)
        self.assertFalse(r["ready"])
        self.assertEqual(r["checks"]["config"], "invalid-configuration")

    async def test_concurrent_probes_are_independent_and_recover(self):
        pool = FakePool(db_fails=True)
        results = await asyncio.gather(*(check_readiness(pool) for _ in range(8)))
        for r in results:
            self.assertFalse(r["ready"])
        self.assertEqual(len(pool.calls), 8)
        pool.db_fails = False
        pool.calls.clear()
        recovered = await asyncio.gather(*(check_readiness(pool) for _ in range(4)))
        for r in recovered:
            self.assertTrue(r["ready"])

    async def test_sustained_overlapping_probes_stay_bounded_and_recover(self):
        pool = FakePool(db_fails=True)
        for _ in range(3):
            results = await asyncio.gather(*(check_readiness(pool) for _ in range(4)))
            self.assertTrue(all(not r["ready"] for r in results))
        # Each probe issued exactly one query — no accumulation over time.
        self.assertEqual(len(pool.calls), 12)
        pool.db_fails = False
        pool.calls.clear()
        recovered = await asyncio.gather(*(check_readiness(pool) for _ in range(4)))
        self.assertTrue(all(r["ready"] for r in recovered))

    async def test_overlapping_requests_share_one_inflight_probe(self):
        calls = []

        async def getter():
            calls.append(1)
            await asyncio.sleep(0.02)  # widen the overlap window
            return FakePool()

        results = await asyncio.gather(
            *(collect_readiness(getter) for _ in range(8)))
        # One shared probe — get_pool called once, not eight times.
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(r["ready"] for r in results))
        # Nothing cached: the next request starts a fresh probe — prompt
        # recovery after an outage.
        await collect_readiness(getter)
        self.assertEqual(len(calls), 2)

    async def test_output_contains_only_fixed_labels(self):
        r = await check_readiness(FakePool(db_fails=True))
        body = json.dumps(r)
        for bad in (SECRET, "db.example.internal", "connection refused", "host"):
            self.assertNotIn(bad, body)
        self.assertEqual(expected_migration_count(), 28)


def _settings_stub():
    import types
    return types.SimpleNamespace(
        database_url=None, db_host="localhost", db_port=5432,
        db_name="x", db_user="u", db_password="p",
        db_min_connections=1, db_max_connections=1,
        db_schema="public", db_ssl=False, db_ssl_ca_file=None,
        db_ssl_no_verify=False, node_env="development",
    )


class PoolCreationTests(unittest.IsolatedAsyncioTestCase):
    """Concurrent get_pool calls must share one create_pool — no leaked
    duplicate pools during outage flapping."""

    def setUp(self):
        import db
        self.db = db
        self.saved_pool, self.saved_settings = db._pool, db._settings
        db._pool, db._settings = None, None

    def tearDown(self):
        self.db._pool, self.db._settings = self.saved_pool, self.saved_settings

    async def test_concurrent_get_pool_creates_one_pool(self):
        created = []

        async def fake_create_pool(**kwargs):
            await asyncio.sleep(0.01)  # widen the race window
            p = object()
            created.append(p)
            return p

        with patch.object(self.db.asyncpg, "create_pool", side_effect=fake_create_pool):
            pools = await asyncio.gather(*(
                self.db.get_pool(_settings_stub()) for _ in range(5)
            ))
        self.assertEqual(len(created), 1)
        self.assertTrue(all(p is created[0] for p in pools))

    async def test_create_pool_failure_retries_without_leaking_state(self):
        attempts = []

        async def flaky(**kwargs):
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("database unreachable")
            return object()

        with patch.object(self.db.asyncpg, "create_pool", side_effect=flaky):
            with self.assertRaises(RuntimeError):
                await self.db.get_pool(_settings_stub())
            self.assertIsNone(self.db._pool)  # no half-created pool retained
            pool = await self.db.get_pool()   # retry: settings cached
            self.assertEqual(len(attempts), 2)
            self.assertIs(self.db._pool, pool)

    async def test_cancelled_lock_waiter_does_not_block_later_acquisition(self):
        release = asyncio.Event()
        created = []

        async def slow(**kwargs):
            created.append(1)
            await release.wait()
            return object()

        with patch.object(self.db.asyncpg, "create_pool", side_effect=slow):
            first = asyncio.create_task(self.db.get_pool(_settings_stub()))
            await asyncio.sleep(0)          # first enters create_pool
            waiter = asyncio.create_task(self.db.get_pool())
            await asyncio.sleep(0)          # waiter parks on the lock
            waiter.cancel()
            release.set()
            pool = await first
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            # Lock released despite the cancelled waiter; recovery works.
            self.assertIs(await self.db.get_pool(), pool)
            self.assertEqual(len(created), 1)

    async def test_collect_readiness_bounds_a_stuck_pool_wait(self):
        never = asyncio.Event()  # never set — create_pool hangs forever

        async def stuck(**kwargs):
            await never.wait()

        with patch.object(self.db.asyncpg, "create_pool", side_effect=stuck):
            r = await collect_readiness(
                lambda: self.db.get_pool(_settings_stub()), budget=0.05)
            self.assertFalse(r["ready"])
            self.assertEqual(r["checks"]["database"], "unavailable")
        # The timed-out wait was cancelled — the creation lock is free and
        # a healthy create succeeds immediately afterwards.
        async def quick(**kwargs):
            return object()
        with patch.object(self.db.asyncpg, "create_pool", side_effect=quick):
            pool = await self.db.get_pool(_settings_stub())
            self.assertIsNotNone(pool)

    async def test_foreign_loop_pool_is_never_served(self):
        import types
        stale = types.SimpleNamespace(_loop=object())  # foreign loop marker
        self.db._pool = stale
        created = []

        async def make(**kwargs):
            pool = types.SimpleNamespace(_loop=asyncio.get_running_loop())
            created.append(pool)
            return pool

        with patch.object(self.db.asyncpg, "create_pool", side_effect=make):
            pool = await self.db.get_pool(_settings_stub())
            self.assertIsNot(pool, stale)
            self.assertIs(pool._loop, asyncio.get_running_loop())
            self.assertIs(await self.db.get_pool(), pool)  # same-loop reuse
            self.assertEqual(len(created), 1)


if __name__ == "__main__":
    unittest.main()
