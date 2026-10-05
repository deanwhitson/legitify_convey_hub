import hashlib
import json
import re
import uuid
from typing import AbstractSet, Any, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from auth.current_user import CurrentUser
from auth.dependencies import require_jwt
from auth.policy import TenantBoundaryError, resolve_write_tenant_id
from clients.dependencies import get_entities_client
from db import query, with_transaction
from services.golden_record_visibility import GoldenRecordVisibilityError
from services.document_scanner import build_scanner
from services.document_storage import build_storage
from services.matter_document_service import (
    DocumentIdempotencyConflictError,
    DocumentNotAvailableError,
    DocumentNotFoundError,
    DocumentServiceError,
    DocumentValidationError,
    MAX_FILE_BYTES,
    create_document,
    evaluation_flags,
    get_document,
    issue_download_token,
    list_requirements,
    record_operation,
    recalculate_requirements,
    rescan_document_file,
    upload_document_file,
)
from services.matter_service import (
    MatterConflictError,
    MatterIdempotencyConflictError,
    MatterServiceError,
    MatterValidationError,
    create_transfer_matter,
    update_core_matter_fields,
)
from services.matter_property_service import (
    MANUAL_CAPTURE_SOURCE_SYSTEM,
    MatterPropertyServiceError,
    PropertyConflictError,
    PropertyIdempotencyConflictError,
    PropertyNotEligibleError,
    PropertyValidationError,
    capture_and_link_property_to_matter,
    link_existing_property_to_matter,
    list_matter_properties,
    validate_capture_payload,
)
from services.matter_specialist_service import (
    MatterSpecialistServiceError,
    create_estate_context,
    create_representative_assignment,
)
from services.transfer_party_service import (
    IdempotencyConflictError,
    PartyConflictError,
    PartyValidationError,
    TransferPartyServiceError,
    attach_manual_party_to_transfer,
    link_party_to_transfer,
)

router = APIRouter()

DEFAULT_SORT_COLUMNS = ["created_at", "updated_at", "property_address", "status", "purchase_price"]


SELECT_TRANSFER_COLUMNS = """
    SELECT t.id, t.transfer_id, t.matter_id, t.property_address, t.purchase_price, t.status,
           t.current_step, t.total_steps, t.progress, t.created_at, t.updated_at,
           t.accountable_institution_id
"""


def _map_transfer(row: dict) -> dict:
    return {
        "id": row["id"],
        "transferId": row["transfer_id"],
        "propertyAddress": row["property_address"],
        "purchasePrice": float(row["purchase_price"]) if row["purchase_price"] is not None else None,
        "status": row["status"],
        "currentStep": row["current_step"],
        "totalSteps": row["total_steps"],
        "progress": int(row["progress"]) if row["progress"] is not None else None,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "parties": [],
    }


def _map_matter(row: dict) -> dict:
    return {
        "id": row["id"],
        "referenceNumber": row["reference_number"],
        "matterType": row["matter_type"],
        "title": row["title"],
        "firmReference": row["firm_reference"],
        "classificationCode": row["classification_code"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _map_transfer_party(row: dict) -> dict:
    row = dict(row)
    return {
        "id": row["id"],
        "transferId": row["transfer_id"],
        "goldenRecordId": row["golden_record_id"],
        "entityType": row["entity_type"],
        "role": row["role"],
        "accountableInstitutionId": row["accountable_institution_id"],
        "cachedName": row["cached_name"],
        "cachedIdNumber": row["cached_id_number"],
        "cachedEmail": row["cached_email"],
        "syncedAt": row["synced_at"],
        "partySource": row.get("party_source"),
        "manualName": row.get("manual_name"),
        "manualIdNumber": row.get("manual_id_number"),
        "manualIdType": row.get("manual_id_type"),
        "manualPassportCountry": row.get("manual_passport_country"),
        "manualEmail": row.get("manual_email"),
        "manualPhone": row.get("manual_phone"),
        "manualAddress": row.get("manual_address"),
        "isPrimaryContact": bool(row.get("is_primary_contact")),
        "clientRequestId": str(row["client_request_id"]) if row.get("client_request_id") else None,
        "acknowledgedDuplicate": bool(row.get("acknowledged_duplicate")),
    }


# Client party projection is intentionally conservative. The handover defines that
# a client may only see matters where their golden_record_id is a party, but it
# does not document which fields or other parties a client may view. Until that
# contract is explicit, the client receives only their own row and a minimal
# cache subset.
def _map_client_transfer_party(row: dict) -> dict:
    return {
        "id": row["id"],
        "transferId": row["transfer_id"],
        "goldenRecordId": row["golden_record_id"],
        "entityType": row["entity_type"],
        "role": row["role"],
        "cachedName": row["cached_name"],
        "syncedAt": row["synced_at"],
    }


def _map_milestone(row: dict) -> dict:
    return {
        "id": row["id"],
        "matterId": row["matter_id"],
        "definitionId": row["definition_id"],
        "code": row["code"],
        "definitionName": row["definition_name"],
        "name": row["name"],
        "statusLabel": row["status_label"],
        "status": row["status"],
        "sequenceNumber": row["sequence_number"],
        "dueDate": row["due_date"],
        "completedDate": row["completed_date"],
        "notes": row["notes"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _to_number(value):
    return float(value) if value is not None else None


def _map_transfer_document(row: dict) -> dict:
    return {
        "id": row["id"],
        "transferId": row["transfer_id"],
        "catalogueDocumentId": row["catalogue_document_id"],
        "name": row["name"],
        "status": row["status"],
        "notes": row["notes"],
        "fileSize": row["file_size"],
        "fileType": row["file_type"],
        "originalFileName": row["original_file_name"],
        "requirementKey": row.get("requirement_key"),
        "scanStatus": row.get("scan_status"),
        "uploadedAt": row["uploaded_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _map_transfer_financials(row: dict) -> dict:
    return {
        "transferId": row["transfer_id"],
        "purchasePrice": _to_number(row["purchase_price"]),
        "depositAmount": _to_number(row["deposit_amount"]),
        "loanAmount": _to_number(row["loan_amount"]),
        "interestRate": _to_number(row["interest_rate"]),
        "loanTerm": _to_number(row["loan_term_years"]),
        "transferDuty": _to_number(row["transfer_duty"]),
        "conveyancingFees": _to_number(row["conveyancing_fees"]),
        "deedsOfficeFees": _to_number(row["deeds_office_fees"]),
        "vat": _to_number(row["vat"]),
        "postAndPetties": _to_number(row["post_and_petties"]),
        "clearanceCertificateFee": _to_number(row["clearance_certificate_fee"]),
        "ratesClearanceAmount": _to_number(row["rates_clearance_amount"]),
        "totalCosts": _to_number(row["total_costs"]),
        "netProceeds": _to_number(row["net_proceeds"]),
        "effectiveRate": _to_number(row["effective_rate"]),
        "loanToValueRatio": _to_number(row["loan_to_value_ratio"]),
        "currencyCode": row["currency_code"],
        "calculationVersion": row["calculation_version"],
        "calculationDetails": row["calculation_details"],
        "calculatedAt": row["calculated_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _is_valid_uuid(value: str) -> bool:
    return bool(re.match(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", value, re.IGNORECASE))


async def _authorize_transfer(user: CurrentUser, id: str):
    """Return the authorised transfer row, or None if not accessible.

    All callers are scoped to their verified institution — there is no
    privileged-role exception for reads or writes.
    """

    if not _is_valid_uuid(id):
        return None

    if user.is_client:
        if not user.golden_record_id:
            return None

        client_sql = f"""
            {SELECT_TRANSFER_COLUMNS}
            FROM transfers t
            WHERE t.id = $1 AND t.accountable_institution_id = $3
              AND EXISTS (
                SELECT 1 FROM transfer_parties tp
                WHERE tp.transfer_id = t.id AND tp.golden_record_id = $2::uuid
                  AND tp.accountable_institution_id = $3
              )
        """
        client_result = await query(client_sql, [id, user.golden_record_id, user.accountable_institution_id])
        return client_result.rows[0] if client_result.rows else None

    detail_sql = f"""
        {SELECT_TRANSFER_COLUMNS}
        FROM transfers t
        WHERE t.id = $1 AND t.accountable_institution_id = $2
    """
    detail_result = await query(detail_sql, [id, user.accountable_institution_id])
    return detail_result.rows[0] if detail_result.rows else None


def _parse_pagination_params(request: Request):
    try:
        page = max(1, int(request.query_params.get("page", "1")))
    except (TypeError, ValueError):
        page = 1
    try:
        limit = min(100, max(1, int(request.query_params.get("limit", "10"))))
    except (TypeError, ValueError):
        limit = 10
    sort_by = request.query_params.get("sortBy", "created_at")
    if sort_by not in DEFAULT_SORT_COLUMNS:
        sort_by = "created_at"
    sort_order = "asc" if request.query_params.get("sortOrder", "").lower() == "asc" else "desc"
    return {"page": page, "limit": limit, "sort_by": sort_by, "sort_order": sort_order}


@router.get("/classifications")
async def get_transfer_classifications(user: CurrentUser = Depends(require_jwt)):
    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")
    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    result = await query(
        """
        SELECT canonical_code, subtype, display_label, transfer_from,
               transfer_from_label, requires_transfer_from
        FROM matter_classification_options
        WHERE category = 'transfer' AND is_selectable = TRUE AND is_active = TRUE
        ORDER BY display_label, transfer_from_label NULLS FIRST, canonical_code
        """,
        [],
    )
    return {"message": "OK", "data": {"classifications": [
        {
            "canonicalCode": row["canonical_code"],
            "subtype": row["subtype"],
            "displayLabel": row["display_label"],
            "transferFrom": row["transfer_from"],
            "transferFromLabel": row["transfer_from_label"],
            "requiresTransferFrom": row["requires_transfer_from"],
        }
        for row in result.rows
    ]}}


@router.get("/")
async def list_transfers(
    request: Request,
    user: CurrentUser = Depends(require_jwt),
):
    """List transfers scoped to the authenticated user's tenant."""

    # Clients (role 4) must prove Golden Record party membership before seeing any transfer.
    # transfer_parties is currently empty, so the safe default is an empty list.
    if user.is_client:
        return {
            "message": "OK",
            "data": {
                "transfers": [],
                "pagination": {"page": 1, "limit": 10, "total": 0, "totalPages": 0},
            },
        }

    # Staff must hold the documented transfers:read ability (handover §4.5).
    if not user.has_ability("transfers:read"):
        return JSONResponse(status_code=403, content={"success": False, "error": "Forbidden"})

    statuses = request.query_params.getlist("status")
    if len(statuses) > 1 or (statuses and statuses[0] not in ("in_progress", "complete")):
        raise HTTPException(status_code=422, detail="status must be in_progress or complete")

    filters = _parse_pagination_params(request)
    offset = (filters["page"] - 1) * filters["limit"]
    predicate = "WHERE t.accountable_institution_id = $1"
    count_params: list[Any] = [user.accountable_institution_id]
    if statuses:
        predicate += " AND t.status = $2"
        count_params.append(statuses[0])
    count_sql = f"SELECT COUNT(*) AS total FROM transfers t {predicate}"
    data_sql = f"""
        SELECT t.id, t.transfer_id, t.property_address, t.purchase_price, t.status,
               t.current_step, t.total_steps, t.progress, t.created_at, t.updated_at
        FROM transfers t
        {predicate}
        ORDER BY t.{filters['sort_by']} {filters['sort_order'].upper()}, t.id ASC
        LIMIT ${len(count_params) + 1} OFFSET ${len(count_params) + 2}
    """
    data_params = [*count_params, filters["limit"], offset]

    count_result = await query(count_sql, count_params)
    total = int(count_result.rows[0]["total"])

    data_result = await query(data_sql, data_params)
    transfers = [_map_transfer(row) for row in data_result.rows]
    totals_result = await query(
        """
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE t.status = 'in_progress') AS in_progress,
               COUNT(*) FILTER (WHERE t.status = 'complete') AS complete
        FROM transfers t
        WHERE t.accountable_institution_id = $1
        """,
        [user.accountable_institution_id],
    )
    totals = totals_result.rows[0]

    return {
        "message": "OK",
        "data": {
            "transfers": transfers,
            "statusTotals": {
                "total": int(totals["total"]),
                "inProgress": int(totals["in_progress"]),
                "completed": int(totals["complete"]),
            },
            "pagination": {
                "page": filters["page"],
                "limit": filters["limit"],
                "total": total,
                "totalPages": (total + filters["limit"] - 1) // filters["limit"] or 1,
            },
        },
    }


@router.get("/{id}/parties")
async def get_transfer_parties(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """List parties for a transfer, scoped to the authorised tenant."""

    # Staff must hold the documented transfers:read ability (handover §4.5).
    # Role 4 (Client) is not in the canonical transfers:read assignment; client
    # access is governed by the GR party rule implemented in _authorize_transfer.
    if not user.is_client and not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    # Clients are restricted to their own transfer_parties row.
    # The client projection is intentionally conservative: the handover does not
    # define which party fields or other parties a client may view, so we return
    # only the matching row and a minimal cache subset until that platform
    # contract exists.
    if user.is_client:
        client_parties_sql = """
            SELECT id, transfer_id, golden_record_id, entity_type, role, cached_name, synced_at
            FROM transfer_parties
            WHERE transfer_id = $1
              AND golden_record_id = $2::uuid
              AND accountable_institution_id = $3
              AND accountable_institution_id = (
                SELECT accountable_institution_id FROM transfers WHERE id = $1 AND accountable_institution_id = $3
              )
            ORDER BY cached_name
        """
        client_parties_result = await query(client_parties_sql, [id, user.golden_record_id, user.accountable_institution_id])
        parties = [_map_client_transfer_party(row) for row in client_parties_result.rows]
        return {"message": "OK", "data": {"parties": parties}}

    # Tenant-defence in depth: all callers only see parties for their AI.
    parties_sql = """
        SELECT id, transfer_id, golden_record_id, entity_type, role,
               accountable_institution_id, cached_name, cached_id_number, cached_email, synced_at,
               party_source, manual_name, manual_id_number, manual_email, manual_phone,
               manual_address, is_primary_contact, client_request_id, acknowledged_duplicate
        FROM transfer_parties
        WHERE transfer_id = $1 AND accountable_institution_id = $2
        ORDER BY cached_name NULLS LAST, manual_name NULLS LAST
    """
    parties_result = await query(parties_sql, [id, user.accountable_institution_id])
    parties = [_map_transfer_party(row) for row in parties_result.rows]

    return {"message": "OK", "data": {"parties": parties}}


@router.get("/{id}/milestones")
async def get_transfer_milestones(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """List milestones for a transfer, scoped to the authorised tenant."""

    # Client milestone visibility is not documented. Fail closed.
    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")

    # No separate milestones:read ability is documented; reuse transfers:read.
    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    association = await query(
        """SELECT m.id AS workflow_matter_id FROM transfers t
           JOIN matters m ON m.id = t.matter_id
           WHERE t.id = $1 AND t.accountable_institution_id = $2
             AND m.accountable_institution_id = $2 AND m.matter_type = 'transfer'""",
        [id, user.accountable_institution_id],
    )
    if len(association.rows) != 1:
        raise HTTPException(status_code=409, detail="Workflow association unavailable")

    # The canonical transfer-to-matter relationship is transfers.matter_id.
    # Invalid associations fail explicitly; legacy links are not repaired.
    # Recheck both owners in the read itself, independent of the earlier
    # transfer authorization, and never fall back to source_record_id.
    milestones_sql = """
        SELECT mm.id, mm.matter_id, mm.definition_id, md.code,
               md.name AS definition_name, mm.name, mm.status_label, mm.status,
               mm.sequence_number, mm.due_date, mm.completed_date, mm.notes,
               mm.created_at, mm.updated_at
        FROM matter_milestones mm
        JOIN matters m ON m.id = mm.matter_id
        JOIN transfers t ON t.matter_id = m.id
        LEFT JOIN milestone_definitions md ON md.id = mm.definition_id
        WHERE t.id = $1
          AND t.accountable_institution_id = $2
          AND m.accountable_institution_id = $2
          AND m.matter_type = 'transfer'
        ORDER BY mm.sequence_number, mm.id
        """
    milestones_result = await query(milestones_sql, [id, user.accountable_institution_id])
    milestones = [_map_milestone(row) for row in milestones_result.rows]

    return {"message": "OK", "data": {"milestones": milestones}}


@router.get("/{id}/documents")
async def get_transfer_documents(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """List document metadata for a transfer, scoped to the authorised tenant."""

    # Client document visibility is not documented. Fail closed.
    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")

    # No separate documents:read ability is documented; reuse transfers:read.
    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    # Metadata-only query. storage_key/file_path/file_instance_id are internal
    # and must never be projected to clients.
    documents_result = await query(
        """
        SELECT id, transfer_id, catalogue_document_id, name, status, notes,
               file_size, file_type, original_file_name, requirement_key,
               scan_status, uploaded_at, created_at, updated_at
        FROM transfer_documents
        WHERE transfer_id = $1
        ORDER BY created_at
        """,
        [id],
    )
    documents = [_map_transfer_document(row) for row in documents_result.rows]
    requirements = await list_requirements(transfer)
    flags = await evaluation_flags(transfer)

    return {
        "message": "OK",
        "data": {
            "documents": documents,
            "requirements": requirements["requirements"],
            **flags,
        },
    }


def _document_error_response(exc: DocumentServiceError) -> JSONResponse:
    if isinstance(exc, DocumentIdempotencyConflictError):
        return JSONResponse(status_code=409, content={"message": "Conflict", "errors": [str(exc)]})
    if isinstance(exc, DocumentNotFoundError):
        return JSONResponse(status_code=404, content={"message": "Not found"})
    if isinstance(exc, DocumentValidationError):
        return JSONResponse(status_code=422, content={"message": "Validation failed", "errors": [str(exc)]})
    if isinstance(exc, DocumentNotAvailableError):
        return JSONResponse(status_code=409, content={"message": "Not available", "errors": [str(exc)]})
    return JSONResponse(status_code=500, content={"message": "Document operation failed"})


@router.post("/{id}/documents", status_code=201)
async def create_transfer_document(
    id: str,
    body: dict,
    user: CurrentUser = Depends(require_jwt),
):
    """Create a pending document row (no file). Idempotent via client_request_id."""

    _require_transfers_write(user)
    _require_body_keys(
        body,
        required={"name"},
        optional={"catalogue_document_id", "requirement_key", "notes", "client_request_id"},
    )
    if body.get("catalogue_document_id") is not None:
        _require_uuid_field(body, "catalogue_document_id")
    client_request = _optional_uuid_field(body, "client_request_id")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    try:
        row, created = await create_document(
            transfer,
            user,
            {
                "name": body["name"],
                "catalogue_document_id": body.get("catalogue_document_id"),
                "requirement_key": body.get("requirement_key"),
                "notes": body.get("notes"),
                "client_request_id": uuid.UUID(client_request) if client_request else None,
            },
        )
    except DocumentServiceError as exc:
        return _document_error_response(exc)

    return JSONResponse(
        status_code=201 if created else 200,
        content={"message": "Created" if created else "OK", "data": _map_transfer_document(row)},
    )


# Multipart envelope overhead allowed on top of the file cap — boundary,
# headers and field framing. Requests declaring a larger body are refused
# before any bytes are consumed.
_MULTIPART_OVERHEAD_BYTES = 64 * 1024


@router.post("/{id}/documents/{document_id}/file")
async def upload_transfer_document_file(
    id: str,
    document_id: str,
    request: Request,
    file: UploadFile,
    user: CurrentUser = Depends(require_jwt),
):
    """Attach file bytes to an existing document row (multipart 'file' field).

    The 25 MB cap is enforced during the read; content is sniffed against the
    PDF/DOCX/JPG/PNG allow-list. Stored bytes are scanned before they can ever
    become downloadable — scanner failure leaves the file unavailable.
    """

    _require_transfers_write(user)
    if not _is_valid_uuid(document_id):
        raise HTTPException(status_code=404, detail="Not found")

    try:
        declared = int(request.headers.get("content-length") or "0")
    except ValueError:
        declared = 0
    if declared > MAX_FILE_BYTES + _MULTIPART_OVERHEAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 25 MB limit")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    try:
        document = await get_document(transfer, document_id)
    except DocumentServiceError as exc:
        return _document_error_response(exc)

    data = await file.read(MAX_FILE_BYTES + 1)
    storage = build_storage()
    scanner = build_scanner()
    try:
        row, outcome = await upload_document_file(
            transfer,
            document,
            data,
            file.filename,
            storage=storage,
            scanner=scanner,
            user=user,
        )
    except DocumentServiceError as exc:
        return _document_error_response(exc)

    return {
        "message": "OK",
        "data": {"document": _map_transfer_document(row), "outcome": outcome},
    }


@router.post("/{id}/documents/{document_id}/rescan")
async def rescan_transfer_document_file(
    id: str,
    document_id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """Re-scan the stored object for a document whose scan did not complete.

    The retry path without a re-upload: the stored bytes are fetched under
    the document's content-addressed key and scanned again. 'clean' and
    'infected' verdicts are final — the endpoint replays them unchanged.
    """

    _require_transfers_write(user)
    if not _is_valid_uuid(document_id):
        raise HTTPException(status_code=404, detail="Not found")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    try:
        document = await get_document(transfer, document_id)
        row, outcome = await rescan_document_file(
            transfer,
            document,
            storage=build_storage(),
            scanner=build_scanner(),
            user=user,
        )
    except DocumentServiceError as exc:
        return _document_error_response(exc)

    return {
        "message": "OK",
        "data": {"document": _map_transfer_document(row), "outcome": outcome},
    }


@router.post("/{id}/documents/{document_id}/download-link")
async def issue_document_download_link(
    id: str,
    document_id: str,
    request: Request,
    user: CurrentUser = Depends(require_jwt),
):
    """Issue a short-lived opaque download token for a clean uploaded document.

    The link is a bearer credential: anyone holding it may retrieve the file
    until it expires (default 5 min, DOCUMENT_LINK_TTL_SECONDS). Stateless —
    individual revocation before expiry is not supported; the document's
    clean/uploaded state is re-checked at retrieval. Issuing a link is not
    evidence the file was retrieved.
    """

    # Client document access remains excluded; staff require transfers:read.
    if user.is_client or not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")
    if not _is_valid_uuid(document_id):
        raise HTTPException(status_code=404, detail="Not found")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    try:
        document = await get_document(transfer, document_id)
        secret = (
            request.app.state.settings.document_token_secret
            or request.app.state.settings.secret_key
        )
        ttl = getattr(
            request.app.state.settings, "document_link_ttl_seconds", 300
        )
        token, expires = issue_download_token(document, secret, ttl)
    except DocumentServiceError as exc:
        return _document_error_response(exc)

    await record_operation(
        "download_link_issued",
        "success",
        accountable_institution_id=document["accountable_institution_id"],
        actor_user_id=user.user_id,
        transfer_id=str(transfer["id"]),
        document_id=str(document["id"]),
        detail={"expires": expires},
    )
    return {
        "message": "OK",
        "data": {
            "downloadUrl": f"/api/v1/documents/download/{token}",
            "expires": expires,
        },
    }


@router.post("/{id}/documents/requirements/recalculate")
async def recalculate_document_requirements(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """Evaluate active requirement rules against the matter. Idempotent.

    Requirements are obligations, not files: recalculation upserts requirement
    rows and withdraws ones that no longer apply — it never deletes a
    requirement and never touches uploaded evidence.
    """

    _require_transfers_write(user)

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    data = await recalculate_requirements(transfer, user)
    return {"message": "OK", "data": data}


@router.get("/{id}/financials")
async def get_transfer_financials(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """Retrieve financials for a transfer, scoped to the authorised tenant."""

    # Client financial visibility is not documented. Fail closed.
    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")

    # No separate financials:read ability is documented; reuse transfers:read.
    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    # Anchor the query to the authorised transfer. Do not add
    # accountable_institution_id to transfer_financials in this step.
    financials_result = await query(
        "SELECT * FROM transfer_financials WHERE transfer_id = $1",
        [id],
    )
    financials = (
        _map_transfer_financials(financials_result.rows[0])
        if financials_result.rows
        else None
    )

    return {"message": "OK", "data": {"financials": financials}}


@router.get("/{id}")
async def get_transfer(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """Retrieve a single transfer by ID, scoped to the authorised tenant."""

    # Staff must hold the documented transfers:read ability (handover §4.5).
    # Role 4 (Client) is not in the canonical transfers:read assignment; client
    # access is governed by the GR party rule implemented in _authorize_transfer.
    if not user.is_client and not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    data = _map_transfer(transfer)
    # The matter projection is staff-only: the client contract does not
    # document matter-field visibility, so clients keep the existing view.
    if not user.is_client:
        matter = await _load_linked_matter(transfer, user.accountable_institution_id)
        data["matter"] = _map_matter(matter) if matter else None
    return {"message": "OK", "data": data}


async def _load_linked_matter(transfer: dict, accountable_institution_id: int):
    """Resolve the linked matter deterministically via transfers.matter_id."""
    matter_id = transfer.get("matter_id")
    if matter_id is None:
        return None
    result = await query(
        """
        SELECT id, reference_number, matter_type, title, status, firm_reference,
               classification_code, accountable_institution_id, created_at, updated_at
        FROM matters
        WHERE id = $1 AND accountable_institution_id = $2
          AND matter_type = 'transfer'
        """,
        [matter_id, accountable_institution_id],
    )
    return result.rows[0] if result.rows else None


@router.patch("/{id}")
async def update_transfer_core_fields(
    id: str,
    body: dict,
    user: CurrentUser = Depends(require_jwt),
):
    """Update the editable core fields of a transfer matter.

    Allow-list field semantics:
      - omitted            -> unchanged
      - property_address   -> required non-empty string when present
      - firm_reference     -> string <= 100 chars, or null/blank to clear
      - title              -> string <= 255 chars, or null/blank to clear
    Status, classification, progress counters, reference_number, internal
    ids and institution ownership are immutable and rejected by the
    allow-list.

    Both expected_*_updated_at preconditions are required and verified under
    row locks against transfers.updated_at and matters.updated_at, so a
    stale copy conflicts on either row (409) rather than silently
    overwriting another user's change.
    """
    _require_transfers_write(user)

    if not _is_valid_uuid(id):
        raise HTTPException(status_code=404, detail="Not found")

    _require_body_keys(
        body,
        required={"expected_updated_at", "expected_matter_updated_at"},
        optional={"property_address", "firm_reference", "title"},
    )

    expected_updated_at = body["expected_updated_at"]
    expected_matter_updated_at = body["expected_matter_updated_at"]
    for name, value in (
        ("expected_updated_at", expected_updated_at),
        ("expected_matter_updated_at", expected_matter_updated_at),
    ):
        if not isinstance(value, str) or not value.strip():
            raise HTTPException(status_code=422, detail=f"{name} must be a timestamp string")

    fields = {
        key: body[key]
        for key in ("property_address", "firm_reference", "title")
        if key in body
    }

    try:
        transfer, matter = await update_core_matter_fields(
            transfer_id=id,
            accountable_institution_id=user.accountable_institution_id,
            expected_updated_at=expected_updated_at.strip(),
            expected_matter_updated_at=expected_matter_updated_at.strip(),
            fields=fields,
        )
    except MatterValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except MatterConflictError:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": "Matter was modified by another user; reload and retry"},
        )
    except MatterServiceError:
        raise HTTPException(status_code=404, detail="Not found") from None

    data = _map_transfer(transfer)
    data["matter"] = _map_matter(matter)
    return {"message": "OK", "data": data}


def _map_estate_context(row: dict) -> dict:
    return {
        "id": row["id"],
        "transferId": row["transfer_id"],
        "deceasedGoldenRecordId": row["deceased_golden_record_id"],
        "mastersEstateReference": row["masters_estate_reference"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _map_party_relationship(row: dict) -> dict:
    return {
        "id": row["id"],
        "transferPartyId": row["transfer_party_id"],
        "relationshipCode": row["relationship_code"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _map_representative_assignment(row: dict) -> dict:
    target = None
    if row["represented_estate_context_id"] is not None:
        target = {"type": "estate_context", "id": row["represented_estate_context_id"]}
    elif row["represented_transfer_party_id"] is not None:
        target = {"type": "transfer_party", "id": row["represented_transfer_party_id"]}

    return {
        "id": row["id"],
        "transferId": row["transfer_id"],
        "personGoldenRecordId": row["person_golden_record_id"],
        "capacity": row["capacity"],
        "representedTarget": target,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _require_transfers_write(user: CurrentUser) -> None:
    """transfers:write gate for staff write routes.

    Clients (role 4) are denied explicitly: the upstream ability catalogue
    excludes :write on staff surfaces, but a route must not depend on that
    assignment alone.
    """
    if user.is_client or not user.has_ability("transfers:write"):
        raise HTTPException(status_code=403, detail="Forbidden")


def _require_body_keys(body: Any, *, required: AbstractSet[str], optional: AbstractSet[str] = frozenset()) -> None:
    """Reject anything not explicitly allowed.

    An allow-list is the only safe shape here: it rejects protected fields such
    as accountable_institution_id, assignment_state, estate_reference and the
    actor id columns without having to enumerate them.
    """
    if not isinstance(body, dict):
        raise HTTPException(status_code=422, detail="A JSON object body is required")

    keys = set(body.keys())
    missing = required - keys
    if missing:
        raise HTTPException(
            status_code=422, detail=f"Missing required field(s): {', '.join(sorted(missing))}"
        )

    unexpected = keys - required - set(optional)
    if unexpected:
        raise HTTPException(
            status_code=422, detail=f"Unexpected field(s): {', '.join(sorted(unexpected))}"
        )


def _require_uuid_field(body: dict, field: str) -> str:
    value = body.get(field)
    if not isinstance(value, str) or not _is_valid_uuid(value):
        raise HTTPException(status_code=422, detail=f"{field} must be a UUID")
    return value


def _optional_uuid_field(body: dict, field: str) -> Optional[str]:
    value = body.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not _is_valid_uuid(value):
        raise HTTPException(status_code=422, detail=f"{field} must be a UUID")
    return value


def _visibility_error_response(exc: GoldenRecordVisibilityError) -> JSONResponse:
    """Map a visibility outcome to the API, preserving the 400/503 distinction.

    Rejections (unknown Golden Record, not a client of this institution, wrong
    entity type, unusable record) are 400 with one tenant-safe message, so the
    caller cannot tell them apart. Upstream faults are 503 and are never
    reported as a tenant decision.
    """
    return JSONResponse(
        status_code=exc.http_status,
        content={"success": False, "error": exc.public_message},
    )


def _specialist_error_response(exc: MatterSpecialistServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": exc.public_message},
    )


async def _authorize_transfer_party(
    user: CurrentUser,
    transfer_id: str,
    transfer_party_id: str,
) -> bool:
    """Verify that transfer_party_id belongs to transfer_id and the user's verified tenant."""
    sql = """
        SELECT 1
        FROM transfer_parties
        WHERE id = $1
          AND transfer_id = $2
          AND accountable_institution_id = $3
    """
    result = await query(sql, [transfer_party_id, transfer_id, user.accountable_institution_id])
    return bool(result.rows)


@router.get("/{id}/estate-contexts")
async def get_transfer_estate_contexts(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """List estate contexts for a transfer, scoped to the authorised tenant."""

    # Client access is not documented; fail closed.
    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")

    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    list_sql = """
        SELECT id, transfer_id, deceased_golden_record_id, masters_estate_reference,
               created_at, updated_at
        FROM matter_estate_contexts
        WHERE transfer_id = $1 AND accountable_institution_id = $2
        ORDER BY created_at
    """
    result = await query(list_sql, [id, user.accountable_institution_id])
    contexts = [_map_estate_context(row) for row in result.rows]

    return {"message": "OK", "data": {"estateContexts": contexts}}


@router.get("/{id}/estate-contexts/{estate_context_id}")
async def get_transfer_estate_context(
    id: str,
    estate_context_id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """Retrieve a single estate context, scoped to the authorised tenant."""

    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")

    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    detail_sql = """
        SELECT id, transfer_id, deceased_golden_record_id, masters_estate_reference,
               created_at, updated_at
        FROM matter_estate_contexts
        WHERE id = $1
          AND transfer_id = $2
          AND accountable_institution_id = $3
    """
    result = await query(detail_sql, [estate_context_id, id, user.accountable_institution_id])
    if not result.rows:
        raise HTTPException(status_code=404, detail="Not found")

    return {"message": "OK", "data": _map_estate_context(result.rows[0])}


@router.get("/{id}/parties/{transfer_party_id}/relationships")
async def get_transfer_party_relationships(
    id: str,
    transfer_party_id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """List relationship assignments for a transfer party."""

    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")

    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    if not await _authorize_transfer_party(user, id, transfer_party_id):
        raise HTTPException(status_code=404, detail="Not found")

    list_sql = """
        SELECT id, transfer_party_id, relationship_code, created_at, updated_at
        FROM party_relationship_assignments
        WHERE transfer_party_id = $1
        ORDER BY created_at
    """
    result = await query(list_sql, [transfer_party_id])
    relationships = [_map_party_relationship(row) for row in result.rows]

    return {"message": "OK", "data": {"relationships": relationships}}


@router.post("/{id}/parties/{transfer_party_id}/relationships", status_code=201)
async def create_transfer_party_relationship(
    id: str,
    transfer_party_id: str,
    body: dict,
    user: CurrentUser = Depends(require_jwt),
):
    """Assign a relationship code to a transfer party."""

    _require_transfers_write(user)

    if set(body.keys()) != {"relationship_code"}:
        raise HTTPException(status_code=422, detail="Only relationship_code is accepted")

    relationship_code = body.get("relationship_code")
    if not isinstance(relationship_code, str) or not relationship_code.strip():
        raise HTTPException(status_code=422, detail="relationship_code is required")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    if not await _authorize_transfer_party(user, id, transfer_party_id):
        raise HTTPException(status_code=404, detail="Not found")

    # Verify the relationship definition exists and is active.
    definition_result = await query(
        "SELECT code FROM party_relationship_definitions WHERE code = $1 AND is_active = TRUE",
        [relationship_code],
    )
    if not definition_result.rows:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": "Unknown or inactive relationship code"},
        )

    async def _do_insert(connection):
        return await query(
            """
                INSERT INTO party_relationship_assignments (
                    transfer_party_id,
                    relationship_code,
                    created_by_user_id,
                    updated_by_user_id
                )
                VALUES ($1, $2, $3, $4)
                RETURNING id, transfer_party_id, relationship_code, created_at, updated_at
            """,
            [
                transfer_party_id,
                relationship_code,
                user.user_id,
                user.user_id,
            ],
            connection=connection,
        )

    try:
        insert_result = await with_transaction(_do_insert)
    except asyncpg.exceptions.UniqueViolationError:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": "Relationship already assigned"},
        )
    except asyncpg.exceptions.ForeignKeyViolationError:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": "Unknown or inactive relationship code"},
        )

    return {
        "message": "Created",
        "data": _map_party_relationship(insert_result.rows[0]),
    }


@router.get("/{id}/representative-assignments")
async def get_transfer_representative_assignments(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """List representative assignments for a transfer."""

    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")

    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    list_sql = """
        SELECT id, transfer_id, person_golden_record_id, capacity,
               represented_transfer_party_id, represented_estate_context_id,
               created_at, updated_at
        FROM representative_assignments
        WHERE transfer_id = $1 AND accountable_institution_id = $2
        ORDER BY created_at
    """
    result = await query(list_sql, [id, user.accountable_institution_id])
    assignments = [_map_representative_assignment(row) for row in result.rows]

    return {"message": "OK", "data": {"representativeAssignments": assignments}}


@router.get("/{id}/representative-assignments/{assignment_id}")
async def get_transfer_representative_assignment(
    id: str,
    assignment_id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """Retrieve a single representative assignment, scoped to the authorised tenant."""

    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")

    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    detail_sql = """
        SELECT id, transfer_id, person_golden_record_id, capacity,
               represented_transfer_party_id, represented_estate_context_id,
               created_at, updated_at
        FROM representative_assignments
        WHERE id = $1
          AND transfer_id = $2
          AND accountable_institution_id = $3
    """
    result = await query(detail_sql, [assignment_id, id, user.accountable_institution_id])
    if not result.rows:
        raise HTTPException(status_code=404, detail="Not found")

    return {"message": "OK", "data": _map_representative_assignment(result.rows[0])}


@router.post("/{id}/estate-contexts", status_code=201)
async def post_transfer_estate_context(
    id: str,
    body: dict,
    user: CurrentUser = Depends(require_jwt),
    entities_client=Depends(get_entities_client),
):
    """Create an estate context for a transfer, deriving tenant from the transfer."""

    _require_transfers_write(user)

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    _require_body_keys(
        body,
        required={"deceased_golden_record_id"},
        optional={"masters_estate_reference"},
    )

    try:
        row = await create_estate_context(
            transfer_id=uuid.UUID(id),
            deceased_golden_record_id=_require_uuid_field(
                body, "deceased_golden_record_id"
            ),
            masters_estate_reference=body.get("masters_estate_reference"),
            entities_client=entities_client,
            actor_user_id=user.user_id,
        )
    except GoldenRecordVisibilityError as exc:
        return _visibility_error_response(exc)
    except MatterSpecialistServiceError as exc:
        return _specialist_error_response(exc)

    return {"message": "Created", "data": _map_estate_context(row)}


@router.post("/{id}/representative-assignments", status_code=201)
async def post_transfer_representative_assignment(
    id: str,
    body: dict,
    user: CurrentUser = Depends(require_jwt),
    entities_client=Depends(get_entities_client),
):
    """Assign a person, in a capacity, to represent an estate context or a trust party."""

    _require_transfers_write(user)

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    _require_body_keys(
        body,
        required={"person_golden_record_id", "capacity"},
        optional={"represented_estate_context_id", "represented_transfer_party_id"},
    )

    try:
        row = await create_representative_assignment(
            transfer_id=uuid.UUID(id),
            person_golden_record_id=_require_uuid_field(body, "person_golden_record_id"),
            capacity=body["capacity"],
            represented_estate_context_id=_optional_uuid_field(
                body, "represented_estate_context_id"
            ),
            represented_transfer_party_id=_optional_uuid_field(
                body, "represented_transfer_party_id"
            ),
            entities_client=entities_client,
            actor_user_id=user.user_id,
        )
    except GoldenRecordVisibilityError as exc:
        return _visibility_error_response(exc)
    except MatterSpecialistServiceError as exc:
        return _specialist_error_response(exc)
    except asyncpg.exceptions.UniqueViolationError:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": "Representative assignment already exists"},
        )

    return {"message": "Created", "data": _map_representative_assignment(row)}


def _request_fingerprint(payload: dict) -> str:
    """Stable fingerprint of the validated request payload for idempotency."""
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


_ORDINARY_PARTY_ROLES = ("transferor", "transferee")
_MANUAL_PARTY_FIELDS = (
    "name",
    "id_number",
    "id_type",
    "passport_country",
    "email",
    "phone",
    "address",
)


@router.post("/", status_code=201)
async def create_transfer(
    body: dict,
    user: CurrentUser = Depends(require_jwt),
):
    """Create a DEEDLY transfer matter under the caller's institution.

    The accountable institution is derived from the verified caller; a supplied
    value is honoured only for the documented cross-tenant roles (policy §5.5).
    client_request_id makes creation idempotent per institution.
    """
    _require_transfers_write(user)

    _require_body_keys(
        body,
        required={"property_address", "purchase_price"},
        optional={
            "firm_reference",
            "classification_code",
            "client_request_id",
            "accountable_institution_id",
        },
    )

    requested_ai = body.get("accountable_institution_id")
    if requested_ai is not None and (
        not isinstance(requested_ai, int) or isinstance(requested_ai, bool)
    ):
        raise HTTPException(status_code=422, detail="accountable_institution_id must be an integer")
    try:
        accountable_institution_id = resolve_write_tenant_id(user, requested_ai)
    except TenantBoundaryError:
        raise HTTPException(status_code=403, detail="Forbidden") from None

    purchase_price = body.get("purchase_price")
    if isinstance(purchase_price, bool) or not isinstance(purchase_price, (int, float)):
        raise HTTPException(status_code=422, detail="purchase_price must be a number")

    firm_reference = body.get("firm_reference")
    if firm_reference is not None and not isinstance(firm_reference, str):
        raise HTTPException(status_code=422, detail="firm_reference must be a string")

    classification_code = body.get("classification_code")
    if classification_code is not None:
        if not isinstance(classification_code, str) or not classification_code.strip():
            raise HTTPException(status_code=422, detail="classification_code must be a string")
        classification_result = await query(
            """
            SELECT 1 FROM matter_classification_options
            WHERE canonical_code = $1 AND category = 'transfer'
              AND is_selectable = TRUE AND is_active = TRUE
            """,
            [classification_code],
        )
        if not classification_result.rows:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Unknown or inactive transfer classification"},
            )

    client_request_id = _optional_uuid_field(body, "client_request_id")
    fingerprint = _request_fingerprint(
        {
            "property_address": body["property_address"],
            "purchase_price": purchase_price,
            "firm_reference": firm_reference,
            "classification_code": classification_code,
            "accountable_institution_id": accountable_institution_id,
        }
    )

    try:
        row, created = await create_transfer_matter(
            property_address=body["property_address"],
            purchase_price=purchase_price,
            accountable_institution_id=accountable_institution_id,
            actor_user_id=user.user_id,
            firm_reference=firm_reference,
            classification_code=classification_code,
            client_request_id=uuid.UUID(client_request_id) if client_request_id else None,
            request_fingerprint=fingerprint,
        )
    except MatterValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except MatterIdempotencyConflictError:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": "client_request_id was already used with a different payload"},
        )
    except MatterServiceError:
        raise HTTPException(status_code=404, detail="Not found") from None

    data = _map_transfer(row)
    data["created"] = created
    if not created:
        # Raw JSONResponse bypasses jsonable_encoder — encode UUID/datetime.
        return JSONResponse(
            status_code=200,
            content=jsonable_encoder({"message": "OK", "data": data}),
        )
    return {"message": "Created", "data": data}


def _require_code_field(code: Any, label: str) -> str:
    """Validate shape only; the existence check is a query the caller awaits."""
    if not isinstance(code, str) or not code.strip():
        raise HTTPException(status_code=422, detail=f"{label} is required")
    return code.strip()


@router.post("/{id}/parties", status_code=201)
async def attach_transfer_party(
    id: str,
    body: dict,
    user: CurrentUser = Depends(require_jwt),
    entities_client=Depends(get_entities_client),
):
    """Attach a party to a transfer: Golden Record-linked or manual.

    party_source is explicit and immutable. Golden Record parties go through
    the existing institution-linkage visibility recipe; manual parties persist
    institution-owned capture fields and never call upstream.
    """
    _require_transfers_write(user)

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    _require_body_keys(
        body,
        required={"party_source", "entity_type", "role"},
        optional={
            "golden_record_id",
            "manual",
            "is_primary_contact",
            "client_request_id",
            "acknowledged_duplicate",
        },
    )

    party_source = body["party_source"]
    if party_source not in ("golden_record", "manual"):
        raise HTTPException(status_code=422, detail="party_source must be 'golden_record' or 'manual'")

    entity_type = _require_code_field(body["entity_type"], "entity_type")
    role = _require_code_field(body["role"], "role")

    entity_result = await query(
        "SELECT code FROM entity_type_definitions WHERE code = $1 AND is_active = TRUE",
        [entity_type],
    )
    if not entity_result.rows:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": "Unknown or inactive entity type"},
        )

    role_result = await query(
        "SELECT code FROM party_role_definitions WHERE code = $1 AND is_active = TRUE",
        [role],
    )
    if not role_result.rows or role not in _ORDINARY_PARTY_ROLES:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": "Unknown or inactive party role"},
        )

    is_primary_contact = body.get("is_primary_contact")
    if is_primary_contact is not None and not isinstance(is_primary_contact, bool):
        raise HTTPException(status_code=422, detail="is_primary_contact must be a boolean")

    acknowledged_duplicate = body.get("acknowledged_duplicate")
    if acknowledged_duplicate is not None and not isinstance(acknowledged_duplicate, bool):
        raise HTTPException(status_code=422, detail="acknowledged_duplicate must be a boolean")

    client_request_id = _optional_uuid_field(body, "client_request_id")

    fingerprint = _request_fingerprint(
        {
            "transfer_id": id,
            "party_source": party_source,
            "entity_type": entity_type,
            "role": role,
            "golden_record_id": body.get("golden_record_id"),
            "manual": body.get("manual"),
            "is_primary_contact": is_primary_contact,
            "acknowledged_duplicate": acknowledged_duplicate,
        }
    )

    try:
        if party_source == "golden_record":
            if "manual" in body:
                raise HTTPException(
                    status_code=422,
                    detail="manual fields are not accepted for a golden_record party",
                )
            row = await link_party_to_transfer(
                uuid.UUID(id),
                _require_uuid_field(body, "golden_record_id"),
                entity_type,
                role,
                entities_client=entities_client,
                is_primary_contact=bool(is_primary_contact),
                client_request_id=uuid.UUID(client_request_id) if client_request_id else None,
                request_fingerprint=fingerprint,
                acknowledged_duplicate=bool(acknowledged_duplicate),
            )
        else:
            if "golden_record_id" in body:
                raise HTTPException(
                    status_code=422,
                    detail="golden_record_id is not accepted for a manual party",
                )
            manual = body.get("manual")
            if not isinstance(manual, dict):
                raise HTTPException(status_code=422, detail="manual details are required for a manual party")
            unexpected = set(manual.keys()) - set(_MANUAL_PARTY_FIELDS)
            if unexpected:
                raise HTTPException(
                    status_code=422,
                    detail=f"Unexpected manual field(s): {', '.join(sorted(unexpected))}",
                )
            for field in _MANUAL_PARTY_FIELDS:
                if field in manual and manual[field] is not None and not isinstance(manual[field], str):
                    raise HTTPException(status_code=422, detail=f"manual.{field} must be a string")
            manual_name = manual.get("name")
            if not isinstance(manual_name, str) or not manual_name.strip():
                raise HTTPException(status_code=422, detail="manual.name is required")
            row = await attach_manual_party_to_transfer(
                uuid.UUID(id),
                entity_type=entity_type,
                role=role,
                manual_name=manual_name,
                manual_id_number=manual.get("id_number"),
                manual_id_type=manual.get("id_type"),
                manual_passport_country=manual.get("passport_country"),
                manual_email=manual.get("email"),
                manual_phone=manual.get("phone"),
                manual_address=manual.get("address"),
                is_primary_contact=bool(is_primary_contact),
                acknowledged_duplicate=bool(acknowledged_duplicate),
                client_request_id=uuid.UUID(client_request_id) if client_request_id else None,
                request_fingerprint=fingerprint,
            )
    except GoldenRecordVisibilityError as exc:
        return _visibility_error_response(exc)
    except PartyValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except IdempotencyConflictError:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": "client_request_id was already used with a different payload"},
        )
    except PartyConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": str(exc)},
        )
    except TransferPartyServiceError:
        raise HTTPException(status_code=404, detail="Not found") from None

    if row is None:
        raise HTTPException(status_code=404, detail="Not found")

    return {"message": "Created", "data": _map_transfer_party(row)}


# ---- Matter–property linking and readback (P0 Property Integration) ----


def _map_property(row: Optional[dict]) -> Optional[dict]:
    """Allow-listed property projection. `manual` marks institution-private
    manual capture (unverified); verification is never inferred from
    external_property_id or any other field."""
    if row is None:
        return None
    row = dict(row)
    return {
        "id": row.get("id"),
        "propertyId": row.get("property_id"),
        "erfNumber": row.get("erf_number"),
        "streetAddress": row.get("street_address"),
        "suburb": row.get("suburb"),
        "city": row.get("city"),
        "postalCode": row.get("postal_code"),
        "province": row.get("province"),
        "country": row.get("country"),
        "propertyType": row.get("property_type"),
        "legalDescription": row.get("legal_description"),
        "yearBuilt": row.get("year_built"),
        "squareFootage": (
            float(row["square_footage"]) if row.get("square_footage") is not None else None
        ),
        "extentSqm": (
            float(row["extent_sqm"]) if row.get("extent_sqm") is not None else None
        ),
        "status": row.get("status"),
        "sourceSystem": row.get("source_system"),
        "manual": row.get("source_system") == MANUAL_CAPTURE_SOURCE_SYSTEM,
        "accountableInstitutionId": row.get("accountable_institution_id"),
        "clientRequestId": str(row["client_request_id"]) if row.get("client_request_id") else None,
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _map_matter_property_link(row: dict, property_row: Optional[dict]) -> dict:
    """Allow-listed relationship projection with the linked property nested."""
    row = dict(row)
    return {
        "id": row["id"],
        "matterId": row["matter_id"],
        "propertyId": row["property_id"],
        "propertyKind": row["property_kind"],
        "registrationStatus": row.get("registration_status"),
        "roleInMatter": row.get("role_in_matter"),
        "externalPropertyId": row.get("external_property_id"),
        "propertySource": row.get("property_source"),
        "accountableInstitutionId": row.get("accountable_institution_id"),
        "clientRequestId": str(row["client_request_id"]) if row.get("client_request_id") else None,
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "property": _map_property(property_row),
    }


def _map_matter_property_readback(row: dict) -> dict:
    """Map the flat joined readback row (link_* / p_* aliases) to the link
    projection with the nested allow-listed property."""
    property_row = None
    if row.get("p_id") is not None:
        property_row = {
            key[2:]: row[key] for key in row.keys() if key.startswith("p_")
        }
    return _map_matter_property_link(
        {
            "id": row["link_id"],
            "matter_id": row["matter_id"],
            "property_id": row["link_property_id"],
            "property_kind": row["property_kind"],
            "registration_status": row.get("registration_status"),
            "role_in_matter": row.get("role_in_matter"),
            "external_property_id": row.get("external_property_id"),
            "property_source": row.get("property_source"),
            "accountable_institution_id": row.get("link_accountable_institution_id"),
            "client_request_id": row.get("link_client_request_id"),
            "created_at": row.get("link_created_at"),
            "updated_at": row.get("link_updated_at"),
        },
        property_row,
    )


@router.get("/{id}/properties")
async def get_transfer_properties(
    id: str,
    user: CurrentUser = Depends(require_jwt),
):
    """Matter–property readback: link + allow-listed property projection.

    Staff-only and institution-scoped; clients fail closed. Existing links
    remain readable regardless of the property's current status, and a matter
    with multiple links returns all of them. A transfer without a resolvable
    matter link yields an empty list — prototype-era rows are never repaired.
    """
    if user.is_client:
        raise HTTPException(status_code=404, detail="Not found")
    if not user.has_ability("transfers:read"):
        raise HTTPException(status_code=403, detail="Forbidden")

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    rows = await list_matter_properties(
        uuid.UUID(id), user.accountable_institution_id
    )
    return {
        "message": "OK",
        "data": {"properties": [_map_matter_property_readback(row) for row in rows]},
    }


@router.post("/{id}/properties", status_code=201)
async def attach_transfer_property(
    id: str,
    body: dict,
    user: CurrentUser = Depends(require_jwt),
):
    """Link an existing same-institution property OR capture a manual
    institution-private property and link it — atomically, in one request.

    Exactly one of `property_id` or `property` must be supplied. New links
    require an active property; stored links replay unchanged even if the
    property later became inactive. client_request_id replays return the
    original rows (200) and conflicting reuse fails 409.
    """
    _require_transfers_write(user)

    transfer = await _authorize_transfer(user, id)
    if not transfer:
        raise HTTPException(status_code=404, detail="Not found")

    _require_body_keys(
        body,
        required=set(),
        optional={"property_id", "property", "client_request_id"},
    )

    has_property_id = body.get("property_id") is not None
    has_capture = body.get("property") is not None
    if has_property_id == has_capture:
        raise HTTPException(
            status_code=422,
            detail="Exactly one of property_id or property must be supplied",
        )

    client_request_id = _optional_uuid_field(body, "client_request_id")
    # _authorize_transfer already proved the transfer belongs to the caller's
    # verified institution; the service re-locks and re-checks it in the txn.
    accountable_institution_id = user.accountable_institution_id

    validated_capture = None
    property_id = None
    if has_property_id:
        property_id = _require_uuid_field(body, "property_id")
        operation = "link"
    else:
        try:
            validated_capture = validate_capture_payload(body["property"])
        except PropertyValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        operation = "capture"

    fingerprint = _request_fingerprint(
        {
            "operation": operation,
            "transfer_id": id,
            "matter_id": str(transfer["matter_id"]) if transfer.get("matter_id") else None,
            "property_id": property_id,
            "property": validated_capture,
        }
    )

    try:
        if operation == "link":
            link_row, property_row, created = await link_existing_property_to_matter(
                uuid.UUID(id),
                uuid.UUID(property_id),
                accountable_institution_id,
                client_request_id=uuid.UUID(client_request_id) if client_request_id else None,
                request_fingerprint=fingerprint,
            )
        else:
            link_row, property_row, created = await capture_and_link_property_to_matter(
                uuid.UUID(id),
                validated_capture,
                accountable_institution_id,
                client_request_id=uuid.UUID(client_request_id) if client_request_id else None,
                request_fingerprint=fingerprint,
            )
    except PropertyValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    except PropertyIdempotencyConflictError:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": "client_request_id was already used with a different payload"},
        )
    except PropertyNotEligibleError:
        return JSONResponse(
            status_code=400,
            content={"success": False, "error": "Unknown or ineligible property"},
        )
    except PropertyConflictError as exc:
        return JSONResponse(
            status_code=409,
            content={"success": False, "error": str(exc)},
        )
    except MatterPropertyServiceError:
        raise HTTPException(status_code=404, detail="Not found") from None

    data = _map_matter_property_link(link_row, property_row)
    data["created"] = created
    if not created:
        # Raw JSONResponse bypasses jsonable_encoder — UUID/datetime values
        # in the mapped row must be encoded explicitly.
        return JSONResponse(
            status_code=200,
            content=jsonable_encoder({"message": "OK", "data": data}),
        )
    return {"message": "Created", "data": data}
