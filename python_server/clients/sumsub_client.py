"""Sumsub API client — protocol + signed HTTP client + fixture client.

Signing per docs.sumsub.com/reference/authentication (accessed 2026-10-08):
``X-App-Token``, ``X-App-Access-Ts`` (unix seconds) and ``X-App-Access-Sig``
= lowercase hex HMAC-SHA256 of ``ts + METHOD + path?query + body`` keyed by
the app secret. HTTPS only (config enforces the scheme).

Boundaries:
  * ``SumsubApiClient`` is used only when ``SUMSUB_MODE=sandbox``; it never
    carries the webhook secret (separate credential) and never logs token
    values or request bodies.
  * ``FixtureSumsubClient`` produces labelled synthetic objects with zero
    provider traffic, for ``SUMSUB_MODE=fixture`` demos and offline tests.
  * No retry loop that could duplicate chargeable provider work: reads may
    retry once on transport failure; writes are single-attempt.
"""

import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional, Protocol

import httpx
from dataclasses import field

from services.id_verification_config import IdVerificationConfig

CONNECT_TIMEOUT_SECONDS = 5.0
READ_TIMEOUT_SECONDS = 10.0
WRITE_TIMEOUT_SECONDS = 15.0


class SumsubClientError(Exception):
    """Provider call failed in a sanitised way — never carries secrets."""

    def __init__(self, code: str, status: Optional[int] = None):
        super().__init__(code)
        self.code = code
        self.status = status


class SumsubNotFoundError(SumsubClientError):
    def __init__(self):
        super().__init__("not_found", 404)


@dataclass(frozen=True)
class ApplicantRef:
    applicant_id: str
    external_user_id: str


@dataclass(frozen=True)
class SdkAccessToken:
    token: str = field(repr=False)  # opaque; never logged
    user_id: str = ""


@dataclass(frozen=True)
class ReviewStatus:
    review_status: str
    review_answer: Optional[str]
    review_reject_type: Optional[str]
    reject_labels: tuple
    level_name: Optional[str]
    # Review-cycle identifiers — used to confirm an ambiguous event belongs
    # to the attempt cycle it claims, never as status authority.
    inspection_id: Optional[str] = None
    attempt_id: Optional[str] = None


class SumsubClient(Protocol):
    async def create_applicant(self, external_user_id: str, level_name: str) -> ApplicantRef: ...
    async def get_applicant_by_external_id(self, external_user_id: str) -> Optional[ApplicantRef]: ...
    async def create_sdk_access_token(self, user_id: str, level_name: str, ttl_seconds: int) -> SdkAccessToken: ...
    async def get_applicant_review_status(self, applicant_id: str) -> ReviewStatus: ...
    async def aclose(self) -> None: ...


def _sign(secret: str, ts: str, method: str, path_with_query: str, body: bytes) -> str:
    payload = ts.encode() + method.encode() + path_with_query.encode() + body
    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


class SumsubApiClient:
    """Signed Sumsub REST client. ``transport`` is a test seam only."""

    def __init__(self, config: IdVerificationConfig, *, transport: Optional[Any] = None) -> None:
        self._base_url = config.base_url.rstrip("/")
        self._app_token = config.app_token or ""
        self._app_secret = config.app_secret or ""
        kwargs: dict[str, Any] = {"base_url": self._base_url}
        if transport is not None:
            kwargs["transport"] = transport
        self._client = httpx.AsyncClient(**kwargs)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(
        self,
        method: str,
        path_with_query: str,
        *,
        body: Optional[bytes] = None,
        timeout_seconds: float = READ_TIMEOUT_SECONDS,
    ) -> Any:
        ts = str(int(time.time()))
        sig = _sign(self._app_secret, ts, method.upper(), path_with_query, body or b"")
        headers = {
            "X-App-Token": self._app_token,
            "X-App-Access-Ts": ts,
            "X-App-Access-Sig": sig,
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            resp = await self._client.request(
                method,
                path_with_query,
                content=body,
                headers=headers,
                timeout=httpx.Timeout(timeout_seconds, connect=CONNECT_TIMEOUT_SECONDS),
            )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise SumsubClientError("transport_unavailable") from exc
        if resp.status_code == 404:
            raise SumsubNotFoundError()
        if resp.status_code >= 400:
            # Sanitised: record only the status class, never body content.
            raise SumsubClientError("upstream_error", resp.status_code)
        try:
            return resp.json()
        except ValueError as exc:
            raise SumsubClientError("malformed_response") from exc

    async def create_applicant(self, external_user_id: str, level_name: str) -> ApplicantRef:
        payload = json.dumps({"externalUserId": external_user_id}).encode()
        from urllib.parse import quote
        data = await self._request(
            "POST",
            f"/resources/applicants?levelName={quote(level_name, safe='')}",
            body=payload,
            timeout_seconds=WRITE_TIMEOUT_SECONDS,
        )
        applicant_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(applicant_id, str) or not applicant_id:
            raise SumsubClientError("malformed_response")
        return ApplicantRef(applicant_id=applicant_id, external_user_id=external_user_id)

    async def get_applicant_by_external_id(self, external_user_id: str) -> Optional[ApplicantRef]:
        # docs.sumsub.com/reference/get-applicant-data-via-externaluserid
        # (accessed 2026-10-08): the path ends in /one. A response without an
        # applicant id is a malformed response, not a genuine not-found.
        from urllib.parse import quote
        try:
            data = await self._request(
                "GET",
                f"/resources/applicants/-;externalUserId={quote(external_user_id, safe='')}/one",
            )
        except SumsubNotFoundError:
            return None
        applicant_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(applicant_id, str) or not applicant_id:
            raise SumsubClientError("malformed_response")
        return ApplicantRef(applicant_id=applicant_id, external_user_id=external_user_id)

    async def create_sdk_access_token(self, user_id: str, level_name: str, ttl_seconds: int) -> SdkAccessToken:
        payload = json.dumps(
            {"ttlInSecs": int(ttl_seconds), "userId": user_id, "levelName": level_name}
        ).encode()
        data = await self._request(
            "POST", "/resources/accessTokens/sdk", body=payload,
            timeout_seconds=WRITE_TIMEOUT_SECONDS,
        )
        token = data.get("token") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token:
            raise SumsubClientError("malformed_response")
        return SdkAccessToken(token=token, user_id=user_id)

    async def get_applicant_review_status(self, applicant_id: str) -> ReviewStatus:
        data = await self._request("GET", f"/resources/applicants/{applicant_id}/status")
        if not isinstance(data, dict):
            raise SumsubClientError("malformed_response")
        result = data.get("reviewResult") if isinstance(data.get("reviewResult"), dict) else {}
        return ReviewStatus(
            review_status=str(data.get("reviewStatus") or ""),
            review_answer=result.get("reviewAnswer"),
            review_reject_type=result.get("reviewRejectType"),
            reject_labels=tuple(result.get("rejectLabels") or ()),
            level_name=data.get("levelName"),
            inspection_id=(
                result.get("inspectionId")
                if isinstance(result.get("inspectionId"), str)
                else (data.get("inspectionId") if isinstance(data.get("inspectionId"), str) else None)
            ),
            attempt_id=data.get("attemptId") if isinstance(data.get("attemptId"), str) else None,
        )


def fixture_applicant_id(external_user_id: str) -> str:
    """Deterministic labelled fixture applicant id — mirrors the provider's
    applicant reuse: every attempt cycle for the same external ref binds the
    same applicant id."""
    digest = hashlib.sha256(external_user_id.encode()).hexdigest()[:10]
    return f"FIXTURE-APPLICANT-{digest}"


class FixtureSumsubClient:
    """Synthetic provider for SUMSUB_MODE=fixture — no provider traffic.

    Produces labelled fake applicant ids and tokens. Status outcomes are
    driven by the fixture webhook simulation, not by this client. Applicant
    ids are deterministic per external ref — a new attempt cycle for the same
    subject binds the same applicant, like the real provider.
    """

    def __init__(self) -> None:
        self._counter = 0

    async def aclose(self) -> None:
        return None

    async def create_applicant(self, external_user_id: str, level_name: str) -> ApplicantRef:
        return ApplicantRef(
            applicant_id=fixture_applicant_id(external_user_id),
            external_user_id=external_user_id,
        )

    async def get_applicant_by_external_id(self, external_user_id: str) -> Optional[ApplicantRef]:
        # Deterministic fixture: applicants are discovered through the attempt
        # store, never the provider, so this always reports "no applicant".
        return None

    async def create_sdk_access_token(self, user_id: str, level_name: str, ttl_seconds: int) -> SdkAccessToken:
        self._counter += 1
        return SdkAccessToken(
            token=f"FIXTURE-TOKEN-{uuid.uuid4()}",
            user_id=user_id,
        )

    async def get_applicant_review_status(self, applicant_id: str) -> ReviewStatus:
        # The fixture has no remote state to reconcile; callers must treat
        # this as "unknown" rather than any verified outcome.
        return ReviewStatus(
            review_status="fixture_unknown",
            review_answer=None,
            review_reject_type=None,
            reject_labels=(),
            level_name=None,
        )
