"""Configuration resolution for the Sumsub ID-verification POC.

Modes (``SUMSUB_MODE`` env):
  * ``disabled`` (default) — routes return a safe configuration-unavailable
    result; no provider objects exist.
  * ``fixture`` — synthetic demo: in-memory repository and a fixture provider
    client. Clearly labelled simulated outcomes; zero provider traffic.
  * ``sandbox`` — real Sumsub sandbox integration: signed API calls, durable
    repository and webhook secret all required. Missing/partial config is a
    safe configuration-unavailable result, never a silent fixture fallback.
  * any other value (incl. ``live``/``production``) — live verification is not
    authorised; treated as configuration-unavailable.

Environment is recorded on every attempt/event row so sandbox records can
never be mistaken for live results.
"""

import os
from dataclasses import dataclass, field
from typing import Optional

MODE_DISABLED = "disabled"
# Alias: Settings exposes ``sumsub_mode`` with "off" as its default.
MODE_OFF = "off"
MODE_FIXTURE = "fixture"
MODE_SANDBOX = "sandbox"

PROVIDER_NAME = "sumsub"
DEFAULT_BASE_URL = "https://api.sumsub.com"
SDK_TOKEN_TTL_SECONDS = 600


@dataclass(frozen=True)
class IdVerificationConfig:
    """Resolved provider configuration. Secrets never leave the server."""

    mode: str  # disabled | fixture | sandbox (others never construct)
    environment: str  # 'fixture' | 'sandbox' — persisted on every record
    app_token: Optional[str] = field(default=None, repr=False)
    app_secret: Optional[str] = field(default=None, repr=False)
    webhook_secret: Optional[str] = field(default=None, repr=False)
    base_url: str = DEFAULT_BASE_URL
    level_name: Optional[str] = None
    sdk_token_ttl_seconds: int = SDK_TOKEN_TTL_SECONDS
    # Local demo boundary credential for the fixture receiver: fixture mode
    # alone never opens the simulation endpoint — it additionally requires
    # this operator-set token (loopback + X-Dev-Fixture-Token header match).
    fixture_receiver_token: Optional[str] = field(default=None, repr=False)
    # Names of missing settings for a safe "configuration_unavailable" detail.
    missing: tuple = ()


def _missing_required(env_get, names):
    return tuple(n for n in names if not (env_get(n) or "").strip())


def _env_getter(env):
    if env is None:
        env = os.environ
    if hasattr(env, "get"):
        return env.get
    # Settings dataclass: expose its sumsub_* attributes as env lookups.
    def _get(name, default=None):
        attr = name.lower()
        return getattr(env, attr, default)
    return _get


def load_id_verification_config(env=None) -> IdVerificationConfig:
    """Resolve config from an env mapping or a Settings object. Returns a
    disabled/unavailable config rather than raising so routes can answer 503
    configuration-unavailable cleanly."""
    env_get = _env_getter(env)
    mode = (env_get("SUMSUB_MODE") or "").strip().lower() or MODE_DISABLED

    if mode == MODE_FIXTURE:
        return IdVerificationConfig(
            mode=MODE_FIXTURE,
            environment="fixture",
            fixture_receiver_token=(
                (env_get("SUMSUB_FIXTURE_RECEIVER_TOKEN") or "").strip() or None
            ),
        )

    if mode != MODE_SANDBOX:
        # disabled, live/production or unrecognised — all unavailable.
        return IdVerificationConfig(
            mode=MODE_DISABLED,
            environment="disabled",
            missing=("SUMSUB_MODE",) if mode != MODE_DISABLED else (),
        )

    required = (
        "SUMSUB_APP_TOKEN",
        "SUMSUB_APP_SECRET",
        "SUMSUB_WEBHOOK_SECRET",
        "SUMSUB_LEVEL_NAME",
        "SUMSUB_BASE_URL",
    )
    missing = _missing_required(env_get, required)
    base_url = (env_get("SUMSUB_BASE_URL") or "").strip().rstrip("/")
    if base_url and not base_url.startswith("https://"):
        # Provider requires HTTPS — a non-https origin is a config defect.
        missing = missing + ("SUMSUB_BASE_URL",) if "SUMSUB_BASE_URL" not in missing else missing
    return IdVerificationConfig(
        mode=MODE_SANDBOX,
        environment="sandbox",
        app_token=(env_get("SUMSUB_APP_TOKEN") or "").strip() or None,
        app_secret=(env_get("SUMSUB_APP_SECRET") or "").strip() or None,
        webhook_secret=(env_get("SUMSUB_WEBHOOK_SECRET") or "").strip() or None,
        base_url=base_url or DEFAULT_BASE_URL,
        level_name=(env_get("SUMSUB_LEVEL_NAME") or "").strip() or None,
        sdk_token_ttl_seconds=int(env_get("SUMSUB_SDK_TOKEN_TTL_SECONDS") or SDK_TOKEN_TTL_SECONDS),
        missing=missing,
    )


def config_available(config: IdVerificationConfig) -> bool:
    if config.mode == MODE_FIXTURE:
        return True
    return config.mode == MODE_SANDBOX and not config.missing
