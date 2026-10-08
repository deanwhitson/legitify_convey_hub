import os
import urllib.parse
from dataclasses import dataclass, field
from typing import List, Optional

from dotenv import load_dotenv

load_dotenv()

# Values that must never be accepted as real production configuration.
PLACEHOLDER_VALUES = frozenset({
    "your_username",
    "your_password",
    "dev-secret-change-me",
    "changeme",
    "password",
})
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})


def _is_placeholder(value: Optional[str]) -> bool:
    return not value or value.strip().lower() in PLACEHOLDER_VALUES


def _production_config_errors(env=os.environ) -> List[str]:
    """Missing/unsafe production configuration. Messages name the variable
    and the rule only — never the offending value."""
    errors: List[str] = []

    dsn = _resolve_database_url()
    if dsn:
        try:
            parsed = urllib.parse.urlparse(dsn)
        except ValueError:
            errors.append("database connection string is not a valid URL")
            parsed = None
        if parsed is not None:
            if parsed.scheme not in ("postgres", "postgresql"):
                errors.append("database connection string has an unsupported scheme")
            if not parsed.hostname:
                errors.append("database connection string has no hostname")
            if not parsed.password:
                errors.append("database connection string carries no password")
            sslmode = urllib.parse.parse_qs(parsed.query).get("sslmode", [None])[0]
            if sslmode in ("disable", "no-verify"):
                errors.append("database connection string sslmode=%s is not allowed in production" % sslmode)
    else:
        for name in ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"):
            if _is_placeholder(env.get(name)):
                errors.append(f"{name} missing or still a placeholder value")

    for name in ("SECRET_KEY", "JWT_SECRET"):
        if _is_placeholder(env.get(name)):
            errors.append(f"{name} missing or still a placeholder value")

    if env.get("DB_SSL_NO_VERIFY", "").lower() == "true":
        errors.append("DB_SSL_NO_VERIFY=true is refused in production")

    upstream = env.get("LEGITIFY_API_BASE_URL")
    if not upstream or not upstream.strip():
        errors.append("LEGITIFY_API_BASE_URL missing")
    else:
        try:
            u = urllib.parse.urlparse(upstream)
        except ValueError:
            errors.append("LEGITIFY_API_BASE_URL is not a valid URL")
        else:
            # Plain-http upstream lanes are an undecided deployment contract
            # — fail closed on https; it carries bearer tokens and PII.
            if u.scheme != "https":
                errors.append("LEGITIFY_API_BASE_URL must be an https URL in production")
            elif u.hostname in _LOOPBACK_HOSTS:
                errors.append("LEGITIFY_API_BASE_URL loopback is not a valid upstream in production")

    if env.get("LEGACY_ACCOUNTABLE_INSTITUTION_ID"):
        errors.append(
            "LEGACY_ACCOUNTABLE_INSTITUTION_ID must not be configured in production "
            "(unauthenticated legacy-tenant bridge)"
        )

    # Sumsub provider modes demand complete credentials in production;
    # 'off'/'fixture' carry none. Live mode is never authorised silently —
    # it requires the same explicit review as any production change.
    if env.get("SUMSUB_MODE", "off") in ("sandbox", "live"):
        for name in ("SUMSUB_APP_TOKEN", "SUMSUB_APP_SECRET",
                     "SUMSUB_WEBHOOK_SECRET", "SUMSUB_LEVEL_NAME"):
            if _is_placeholder(env.get(name)):
                errors.append(f"{name} missing or still a placeholder value")
        base = env.get("SUMSUB_BASE_URL", "https://api.sumsub.com")
        try:
            if urllib.parse.urlparse(base).scheme != "https":
                errors.append("SUMSUB_BASE_URL must be an https URL")
        except ValueError:
            errors.append("SUMSUB_BASE_URL is not a valid URL")

    return errors


# NOTE: The shared Legitify package `legitify_shared` is not available in this
# repository, so we keep a local Settings implementation. When `legitify_shared`
# is installed, this should be replaced with `BaseServiceSettings` or inherit
# from it.
@dataclass(frozen=True)
class Settings:
    app_name: str
    app_version: str
    port: int
    database_url: Optional[str]
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    db_min_connections: int
    db_max_connections: int
    db_schema: str
    db_ssl: bool
    db_ssl_ca_file: Optional[str]
    db_ssl_no_verify: bool
    node_env: str
    secret_key: str = field(repr=False)
    legitify_api_base_url: str
    redis_url: str
    audit_database_url: Optional[str]
    jwt_secret: Optional[str] = None
    document_token_secret: Optional[str] = field(default=None, repr=False)
    document_link_ttl_seconds: int = 300
    # TEMPORARY: server-controlled tenant for the unauthenticated legacy POST /api/transfers.
    # This bridge is deleted once the legacy write path is retired or JWT auth is added.
    legacy_accountable_institution_id: Optional[int] = None
    # Sumsub identity-verification POC — secrets never appear in repr().
    sumsub_mode: str = "off"
    sumsub_base_url: str = "https://api.sumsub.com"
    sumsub_app_token: Optional[str] = field(default=None, repr=False)
    sumsub_app_secret: Optional[str] = field(default=None, repr=False)
    sumsub_webhook_secret: Optional[str] = field(default=None, repr=False)
    sumsub_level_name: Optional[str] = None
    sumsub_sdk_token_ttl_seconds: int = 1200
    sumsub_fixture_receiver_token: Optional[str] = field(default=None, repr=False)


def _resolve_database_url() -> Optional[str]:
    return (
        os.getenv("ConveyHub_Transfers_POSTGRES_URL_NON_POOLING")
        or os.getenv("POSTGRES_URL_NON_POOLING")
        or os.getenv("ConveyHub_Transfers_POSTGRES_URL")
        or os.getenv("POSTGRES_URL")
        or os.getenv("DATABASE_URL")
    )


def load_settings() -> Settings:
    node_env = os.getenv("NODE_ENV", "development")
    raw_secret_key = os.getenv("SECRET_KEY")

    if raw_secret_key is None:
        if node_env == "production":
            raise ValueError("SECRET_KEY must be set in production")
        secret_key = "dev-secret-change-me"
    else:
        secret_key = raw_secret_key
        if node_env == "production" and (not secret_key or secret_key == "dev-secret-change-me"):
            raise ValueError("The default development SECRET_KEY cannot be used in production")

    raw_jwt_secret = os.getenv("JWT_SECRET")

    if node_env == "production":
        errors = _production_config_errors()
        if errors:
            raise ValueError(
                "Invalid production configuration: " + "; ".join(errors)
            )

    # TEMPORARY: parse the legacy tenant bridge without any production default.
    legacy_ai: Optional[int] = None
    raw_legacy_ai = os.getenv("LEGACY_ACCOUNTABLE_INSTITUTION_ID")
    if raw_legacy_ai is not None and raw_legacy_ai.strip() != "":
        try:
            parsed_legacy_ai = int(raw_legacy_ai)
            if parsed_legacy_ai > 0:
                legacy_ai = parsed_legacy_ai
        except ValueError:
            legacy_ai = None

    return Settings(
        app_name=os.getenv("APP_NAME", "Legitify ConveyHub API"),
        app_version=os.getenv("APP_VERSION", "1.0.0"),
        port=int(os.getenv("PORT", "3000")),
        database_url=_resolve_database_url(),
        db_host=os.getenv("DB_HOST", "localhost"),
        db_port=int(os.getenv("DB_PORT", "5432")),
        db_name=os.getenv("DB_NAME", "legitify_convey_hub"),
        db_user=os.getenv("DB_USER", "your_username"),
        db_password=os.getenv("DB_PASSWORD", "your_password"),
        db_min_connections=int(os.getenv("DB_MIN_CONNECTIONS", "2")),
        db_max_connections=int(os.getenv("DB_MAX_CONNECTIONS", "10")),
        db_schema=os.getenv("DB_SCHEMA", "transfers"),
        db_ssl=os.getenv("DB_SSL", "").lower() == "true",
        db_ssl_ca_file=os.getenv("DB_SSL_CA_FILE") or os.getenv("PGSSLROOTCERT") or None,
        db_ssl_no_verify=os.getenv("DB_SSL_NO_VERIFY", "").lower() == "true",
        node_env=node_env,
        secret_key=secret_key,
        jwt_secret=raw_jwt_secret,
        document_token_secret=os.getenv("DOCUMENT_TOKEN_SECRET"),
        document_link_ttl_seconds=int(os.getenv("DOCUMENT_LINK_TTL_SECONDS", "300")),
        legitify_api_base_url=os.getenv("LEGITIFY_API_BASE_URL", "http://localhost:8000"),
        redis_url=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
        audit_database_url=os.getenv("AUDIT_DATABASE_URL"),
        legacy_accountable_institution_id=legacy_ai,
        sumsub_mode=os.getenv("SUMSUB_MODE", "off"),
        sumsub_base_url=os.getenv("SUMSUB_BASE_URL", "https://api.sumsub.com"),
        sumsub_app_token=os.getenv("SUMSUB_APP_TOKEN"),
        sumsub_app_secret=os.getenv("SUMSUB_APP_SECRET"),
        sumsub_webhook_secret=os.getenv("SUMSUB_WEBHOOK_SECRET"),
        sumsub_level_name=os.getenv("SUMSUB_LEVEL_NAME"),
        sumsub_sdk_token_ttl_seconds=int(os.getenv("SUMSUB_SDK_TOKEN_TTL_SECONDS", "1200")),
        sumsub_fixture_receiver_token=os.getenv("SUMSUB_FIXTURE_RECEIVER_TOKEN"),
    )
