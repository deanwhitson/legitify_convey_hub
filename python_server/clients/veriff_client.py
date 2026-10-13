"""Veriff REST transport. No retries on session creation, no payload logging.

Official session/decision API docs accessed 2026-10-13. GET signs session
UUID; response HMAC covers original bytes, not reserialized JSON.
"""
import hashlib
import hmac
import json
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from uuid import UUID

import httpx


class VeriffClientError(Exception):
    def __init__(self):
        super().__init__("Veriff request failed")


def valid_veriff_url(value: str) -> bool:
    try:
        u = urlsplit(value)
        return (u.scheme == "https" and not u.username and not u.password
                and u.port in (None, 443) and bool(u.hostname)
                and any(u.hostname == d or u.hostname.endswith("." + d)
                        for d in ("veriff.com", "veriff.me")))
    except (ValueError, AttributeError, TypeError):
        return False


@dataclass(frozen=True)
class VeriffConfig:
    mode: str
    base_url: str
    api_key: str = field(repr=False)
    shared_secret: str = field(repr=False)
    encryption_key: str = field(repr=False)

    @property
    def environment(self):
        return self.mode

    @property
    def scope(self):
        # Changing integration credentials cannot reuse another account's sessions.
        return hashlib.sha256((self.mode + "|" + self.base_url + "|" + self.api_key).encode()).hexdigest()


def load_veriff_config(settings):
    get = settings.get if hasattr(settings, "get") else lambda k, default="": getattr(settings, k.lower(), default)
    mode = get("VERIFF_MODE", "disabled")
    base = (get("VERIFF_BASE_URL", "") or "").rstrip("/")
    key = get("VERIFF_API_KEY", "") or ""
    secret = get("VERIFF_SHARED_SECRET", "") or ""
    encryption = get("VERIFF_URL_ENCRYPTION_KEY", "") or ""
    if (mode not in ("test", "trial", "live") or not all((key, secret, encryption))
            or not valid_veriff_url(base) or urlsplit(base).path not in ("", "/")
            or urlsplit(base).query or urlsplit(base).fragment):
        raise ValueError("Veriff configuration unavailable")
    from cryptography.fernet import Fernet
    Fernet(encryption.encode())  # validate without ever rendering key material
    return VeriffConfig(mode, base, key, secret, encryption)


class VeriffClient:
    def __init__(self, config: VeriffConfig, *, transport=None):
        self.config = config
        self.http = httpx.AsyncClient(base_url=config.base_url, transport=transport,
                                     timeout=httpx.Timeout(20, connect=5), follow_redirects=False)

    async def aclose(self):
        await self.http.aclose()

    async def _request(self, method, path, *, payload=None, session_id=None):
        headers = {"X-AUTH-CLIENT": self.config.api_key, "Content-Type": "application/json"}
        raw = json.dumps(payload, separators=(",", ":")).encode() if payload is not None else None
        if session_id:
            headers["X-HMAC-SIGNATURE"] = hmac.new(
                self.config.shared_secret.encode(), session_id.encode(), hashlib.sha256).hexdigest()
        try:
            async with self.http.stream(method, path, headers=headers, content=raw) as r:
                if r.status_code != 200 and r.status_code != 201:
                    raise VeriffClientError()
                body = bytearray()
                async for chunk in r.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 512 * 1024:
                        raise VeriffClientError()
                # Required for decision responses. Creation endpoint may omit HMAC.
                sig = r.headers.get("X-HMAC-SIGNATURE")
                if session_id or sig:
                    expected = hmac.new(self.config.shared_secret.encode(), body, hashlib.sha256).hexdigest()
                    if not sig or not re.fullmatch(r"[0-9a-fA-F]{64}", sig) or not hmac.compare_digest(expected, sig.lower()):
                        raise VeriffClientError()
                data = json.loads(body)
                if not isinstance(data, dict) or data.get("status") != "success":
                    raise VeriffClientError()
                return data
        except (httpx.HTTPError, ValueError, UnicodeDecodeError) as exc:
            raise VeriffClientError() from exc

    async def create_session(self, opaque_reference: str, end_user_id: str):
        data = await self._request("POST", "/v1/sessions", payload={"verification": {
            "document": {"type": "PASSPORT"}, "vendorData": opaque_reference, "endUserId": end_user_id,
        }})
        v = data.get("verification")
        try:
            if not isinstance(v, dict) or not valid_veriff_url(v.get("url")):
                raise ValueError()
            UUID(v["id"])
            if v.get("vendorData") not in (None, opaque_reference) or v.get("endUserId") not in (None, end_user_id):
                raise ValueError()
        except (ValueError, KeyError, TypeError, AttributeError):
            raise VeriffClientError()
        return {"id": v["id"], "url": v["url"]}

    async def decision(self, session_id: str):
        try:
            UUID(session_id)
        except (ValueError, TypeError, AttributeError):
            raise VeriffClientError()
        return await self._request("GET", f"/v1/sessions/{session_id}/decision", session_id=session_id)
