import { Router, Request, Response } from 'express'
import { Transform } from 'node:stream'
import { query, withTransaction } from '../../db'
import { requireJwt } from '../../auth/requireJwt'
import { asyncHandler } from '../../utils/asyncHandler'
import { CurrentUser } from '../../auth/currentUser'
import { mapProperty } from './properties'

const router = Router()

const DEEDLY_UNAVAILABLE = { success: false, error: 'Matter service temporarily unavailable' }

// Auth-forwarding proxy for write routes owned by the FastAPI DEEDLY service
// (it holds the Entities client needed for Golden Record visibility checks).
// The caller's JWT is verified by requireJwt, then forwarded unchanged.
async function proxyDeedly(req: Request, res: Response, path: string, method: 'GET' | 'POST' | 'PATCH', idVerification = false) {
  const baseUrl = process.env.DEEDLY_API_BASE_URL
  if (!baseUrl) {
    res.status(503).json(DEEDLY_UNAVAILABLE)
    return
  }

  try {
    const upstream = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/transfers${path}`, {
      method,
      headers: {
        Authorization: req.headers.authorization as string,
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method !== 'GET' ? { body: JSON.stringify(req.body ?? {}) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(35_000),
    })
    const body = await upstream.text()
    if (upstream.status >= 500) {
      if (idVerification && upstream.status === 503) {
        try {
          const code: unknown = JSON.parse(body)?.error
          if (typeof code === 'string' && ['configuration_unavailable', 'provider_unavailable', 'storage_unavailable'].includes(code)) {
            res.status(503).json({ success: false, error: code })
            return
          }
        } catch { /* unknown upstream details stay sanitised */ }
      }
      res.status(503).json(DEEDLY_UNAVAILABLE)
      return
    }
    const contentType = upstream.headers.get('content-type')
    if (contentType) {
      res.setHeader('Content-Type', contentType)
    }
    res.status(upstream.status).send(body)
  } catch {
    res.status(503).json(DEEDLY_UNAVAILABLE)
  }
}

function mapTransferRow(row: any) {
  return {
    id: row.id,
    transferId: row.transfer_id,
    propertyAddress: row.property_address,
    purchasePrice: row.purchase_price != null ? Number(row.purchase_price) : undefined,
    status: row.status,
    currentStep: row.current_step,
    totalSteps: row.total_steps,
    progress: row.progress != null ? Number(row.progress) : undefined,
    createdAt: row.created_at,
    // updated_at_text preserves timestamptz microseconds; the JS-Date form
    // would truncate to milliseconds and break the PATCH version token.
    // List queries don't select the text column and keep the Date form.
    updatedAt: row.updated_at_text ?? row.updated_at,
    parties: [],
  }
}

function mapMatter(row: any) {
  return {
    id: row.id,
    referenceNumber: row.reference_number,
    matterType: row.matter_type,
    title: row.title,
    firmReference: row.firm_reference,
    classificationCode: row.classification_code,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapTransferParty(row: any) {
  return {
    id: row.id,
    transferId: row.transfer_id,
    goldenRecordId: row.golden_record_id,
    entityType: row.entity_type,
    role: row.role,
    accountableInstitutionId: row.accountable_institution_id,
    cachedName: row.cached_name,
    cachedIdNumber: row.cached_id_number,
    cachedEmail: row.cached_email,
    syncedAt: row.synced_at,
    partySource: row.party_source,
    manualName: row.manual_name,
    manualIdNumber: row.manual_id_number,
    manualIdType: row.manual_id_type,
    manualPassportCountry: row.manual_passport_country,
    manualEmail: row.manual_email,
    manualPhone: row.manual_phone,
    manualAddress: row.manual_address,
    isPrimaryContact: Boolean(row.is_primary_contact),
    clientRequestId: row.client_request_id ? String(row.client_request_id) : null,
    acknowledgedDuplicate: Boolean(row.acknowledged_duplicate),
  }
}

// Client party projection is intentionally conservative. The handover defines
// that a client may only see matters where their golden_record_id is a party
// (server/auth/policy.ts), but it does not define what party fields or rows
// a client may view. Until that contract is documented, the client receives
// only their own transfer_parties row and a minimal set of cached display fields.
function mapClientTransferParty(row: any) {
  return {
    id: row.id,
    transferId: row.transfer_id,
    goldenRecordId: row.golden_record_id,
    entityType: row.entity_type,
    role: row.role,
    cachedName: row.cached_name,
    syncedAt: row.synced_at,
  }
}

function mapTransferDocument(row: any) {
  return {
    id: row.id,
    transferId: row.transfer_id,
    catalogueDocumentId: row.catalogue_document_id,
    name: row.name,
    status: row.status,
    notes: row.notes,
    fileSize: row.file_size,
    fileType: row.file_type,
    originalFileName: row.original_file_name,
    requirementKey: row.requirement_key ?? null,
    scanStatus: row.scan_status ?? null,
    uploadedAt: row.uploaded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapDocumentRequirement(row: any) {
  return {
    id: row.id,
    requirementKey: row.requirement_key,
    displayName: row.display_name,
    source: row.source,
    conditionKey: row.condition_key,
    status: row.status,
    satisfiedDocumentId: row.satisfied_document_id ?? null,
    linkedDocumentId: row.linked_document_id ?? null,
  }
}

function mapMilestone(row: any) {
  return {
    id: row.id,
    matterId: row.matter_id,
    definitionId: row.definition_id,
    code: row.code,
    definitionName: row.definition_name,
    name: row.name,
    statusLabel: row.status_label,
    status: row.status,
    sequenceNumber: row.sequence_number,
    dueDate: row.due_date,
    completedDate: row.completed_date,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapTransferFinancials(row: any) {
  if (!row) {
    return null
  }
  return {
    transferId: row.transfer_id,
    purchasePrice: row.purchase_price != null ? Number(row.purchase_price) : undefined,
    depositAmount: row.deposit_amount != null ? Number(row.deposit_amount) : undefined,
    loanAmount: row.loan_amount != null ? Number(row.loan_amount) : undefined,
    interestRate: row.interest_rate != null ? Number(row.interest_rate) : undefined,
    loanTerm: row.loan_term_years != null ? Number(row.loan_term_years) : undefined,
    transferDuty: row.transfer_duty != null ? Number(row.transfer_duty) : undefined,
    conveyancingFees: row.conveyancing_fees != null ? Number(row.conveyancing_fees) : undefined,
    deedsOfficeFees: row.deeds_office_fees != null ? Number(row.deeds_office_fees) : undefined,
    vat: row.vat != null ? Number(row.vat) : undefined,
    postAndPetties: row.post_and_petties != null ? Number(row.post_and_petties) : undefined,
    clearanceCertificateFee: row.clearance_certificate_fee != null ? Number(row.clearance_certificate_fee) : undefined,
    ratesClearanceAmount: row.rates_clearance_amount != null ? Number(row.rates_clearance_amount) : undefined,
    totalCosts: row.total_costs != null ? Number(row.total_costs) : undefined,
    netProceeds: row.net_proceeds != null ? Number(row.net_proceeds) : undefined,
    effectiveRate: row.effective_rate != null ? Number(row.effective_rate) : undefined,
    loanToValueRatio: row.loan_to_value_ratio != null ? Number(row.loan_to_value_ratio) : undefined,
    currencyCode: row.currency_code,
    calculationVersion: row.calculation_version,
    calculationDetails: row.calculation_details,
    calculatedAt: row.calculated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

const SELECT_TRANSFER_COLUMNS = `
  SELECT t.id, t.transfer_id, t.matter_id, t.property_address, t.purchase_price, t.status,
         t.current_step, t.total_steps, t.progress, t.created_at, t.updated_at,
         t.updated_at::text AS updated_at_text, t.accountable_institution_id
`

// All callers are scoped to their verified institution — there is no
// privileged-role exception for reads or writes.
async function authorizeTransfer(user: CurrentUser, id: string): Promise<any | null> {
  if (!isUuid(id)) {
    return null
  }

  if (user.isClient) {
    if (!user.golden_record_id) {
      return null
    }

    const clientQuery = `${SELECT_TRANSFER_COLUMNS}
      FROM transfers t
      WHERE t.id = $1 AND t.accountable_institution_id = $3
        AND EXISTS (
          SELECT 1 FROM transfer_parties tp
          WHERE tp.transfer_id = t.id AND tp.golden_record_id = $2::uuid
            AND tp.accountable_institution_id = $3
        )
    `
    const clientResult = await query(clientQuery, [id, user.golden_record_id, user.accountable_institution_id])
    return clientResult.rows[0] || null
  }

  // Staff ability check is performed by the caller.
  const detailQuery = `${SELECT_TRANSFER_COLUMNS} FROM transfers t WHERE t.id = $1 AND t.accountable_institution_id = $2`
  const detailResult = await query(detailQuery, [id, user.accountable_institution_id])
  return detailResult.rows[0] || null
}

router.get(
  '/classifications',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }
    await proxyDeedly(req, res, '/classifications', 'GET')
  })
)

router.get(
  '/',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!

    // Clients (role 4) must prove Golden Record party membership before seeing any transfer.
    // transfer_parties is currently empty, so the safe default is an empty list.
    if (user.isClient) {
      res.json({
        message: 'OK',
        data: {
          transfers: [],
          pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
        },
      })
      return
    }

    // Staff must hold the documented transfers:read ability (handover §4.5).
    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    // Same-institution isolation applies to every caller — no privileged-role exception.
    const incoming = new URL(req.originalUrl, 'http://localhost').searchParams
    const params = new URLSearchParams()
    for (const key of ['page', 'limit', 'sortBy', 'sortOrder', 'status']) {
      for (const value of incoming.getAll(key)) params.append(key, value)
    }
    const search = params.toString()
    await proxyDeedly(req, res, `/${search ? `?${search}` : ''}`, 'GET')
  })
)

router.get(
  '/:id/parties',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    // Staff must hold the documented transfers:read ability (handover §4.5).
    // Role 4 (Client) is not in the canonical transfers:read assignment; client
    // access is governed by the GR party rule implemented in authorizeTransfer.
    if (!user.isClient && !user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    // Clients are restricted to their own transfer_parties row.
    // The client projection is intentionally conservative: the handover does not
    // define which party fields/rows a client may view, so we return only the
    // matching row and a minimal cache subset until that platform contract exists.
    if (user.isClient) {
      const clientPartiesQuery = `
        SELECT id, transfer_id, golden_record_id, entity_type, role, cached_name, synced_at
        FROM transfer_parties
        WHERE transfer_id = $1
          AND golden_record_id = $2::uuid
          AND accountable_institution_id = $3
          AND accountable_institution_id = (
            SELECT accountable_institution_id FROM transfers WHERE id = $1 AND accountable_institution_id = $3
          )
      `
      const clientPartiesResult = await query(clientPartiesQuery, [id, user.golden_record_id, user.accountable_institution_id])
      res.json({
        message: 'OK',
        data: {
          parties: clientPartiesResult.rows.map(mapClientTransferParty),
        },
      })
      return
    }

    // Tenant-defence in depth: all callers only see parties for their AI.
    const partiesQuery = `
      SELECT id, transfer_id, golden_record_id, entity_type, role,
             accountable_institution_id, cached_name, cached_id_number, cached_email, synced_at,
             party_source, manual_name, manual_id_number, manual_id_type,
             manual_passport_country, manual_email, manual_phone,
             manual_address, is_primary_contact, client_request_id, acknowledged_duplicate
      FROM transfer_parties
      WHERE transfer_id = $1 AND accountable_institution_id = $2
      ORDER BY cached_name NULLS LAST, manual_name NULLS LAST
    `

    const partiesResult = await query(partiesQuery, [id, user.accountable_institution_id])

    res.json({
      message: 'OK',
      data: {
        parties: partiesResult.rows.map(mapTransferParty),
      },
    })
  })
)

router.get(
  '/:id/milestones',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    // Client milestone visibility is not documented. Fail closed.
    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    // No separate milestones:read ability is documented; reuse transfers:read.
    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const association = await query(
      `SELECT m.id AS workflow_matter_id FROM transfers t
       JOIN matters m ON m.id = t.matter_id
       WHERE t.id = $1 AND t.accountable_institution_id = $2
         AND m.accountable_institution_id = $2 AND m.matter_type = 'transfer'`,
      [id, user.accountable_institution_id]
    )
    if (association.rows.length !== 1) {
      res.status(409).json({ success: false, error: 'Workflow association unavailable' })
      return
    }

    // The canonical transfer-to-matter relationship is transfers.matter_id.
    // Invalid associations fail explicitly; legacy links are not repaired.
    // Recheck both owners in the read itself, independent of the earlier
    // transfer authorization, and never fall back to source_record_id.
    const milestonesQuery = `
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
    `
    const milestonesResult = await query(milestonesQuery, [id, user.accountable_institution_id])

    res.json({
      message: 'OK',
      data: {
        milestones: milestonesResult.rows.map(mapMilestone),
      },
    })
  })
)

// Transfer activity feed — milestone_history joined through the same
// verified transfer→matter relationship as the milestones route.
router.get(
  '/:id/activity',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const association = await query(
      `SELECT m.id AS workflow_matter_id FROM transfers t
       JOIN matters m ON m.id = t.matter_id
       WHERE t.id = $1 AND t.accountable_institution_id = $2
         AND m.accountable_institution_id = $2 AND m.matter_type = 'transfer'`,
      [id, user.accountable_institution_id]
    )
    if (association.rows.length !== 1) {
      res.status(409).json({ success: false, error: 'Workflow association unavailable' })
      return
    }

    const activityResult = await query(
      `SELECT mh.id, mh.actor_name, mh.action, mh.change_summary, mh.created_at
       FROM milestone_history mh
       JOIN matter_milestones mm ON mm.id = mh.milestone_id
       JOIN matters m ON m.id = mm.matter_id
       JOIN transfers t ON t.matter_id = m.id
       WHERE t.id = $1
         AND t.accountable_institution_id = $2
         AND m.accountable_institution_id = $2
         AND m.matter_type = 'transfer'
       ORDER BY mh.created_at DESC, mh.id DESC
       LIMIT 100`,
      [id, user.accountable_institution_id]
    )

    res.json({
      message: 'OK',
      data: {
        activity: activityResult.rows.map((row: any) => ({
          id: row.id,
          user: row.actor_name,
          action: row.change_summary || row.action,
          timestamp: row.created_at,
        })),
      },
    })
  })
)

router.get(
  '/:id/documents',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    // Client document visibility is not documented. Fail closed.
    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    // No separate documents:read ability is documented; reuse transfers:read.
    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    // Metadata-only. storage_key/file_path/file_instance_id are internal and
    // must never be projected to clients.
    const documentsQuery = `
      SELECT id, transfer_id, catalogue_document_id, name, status, notes,
             file_size, file_type, original_file_name, requirement_key,
             scan_status, uploaded_at, created_at, updated_at
      FROM transfer_documents
      WHERE transfer_id = $1
      ORDER BY created_at
    `
    const documentsResult = await query(documentsQuery, [id])

    const requirementsResult = await query(
      `
      SELECT r.id, r.requirement_key, r.display_name, r.source,
             r.condition_key, r.status,
             (SELECT d.id FROM transfer_documents d
              WHERE d.transfer_id = r.transfer_id
                AND d.requirement_key = r.requirement_key
                AND d.status = 'uploaded' AND d.scan_status = 'clean'
              ORDER BY d.uploaded_at DESC NULLS LAST LIMIT 1) AS satisfied_document_id,
             (SELECT d.id FROM transfer_documents d
              WHERE d.transfer_id = r.transfer_id
                AND d.requirement_key = r.requirement_key
              ORDER BY d.created_at DESC LIMIT 1) AS linked_document_id
      FROM transfer_document_requirements r
      WHERE r.transfer_id = $1 AND r.accountable_institution_id = $2
      ORDER BY r.applied_at, r.requirement_key
      `,
      [id, transfer.accountable_institution_id]
    )

    // Evaluation flags — mirrors matter_document_service.evaluation_flags so
    // readback surfaces what could not be decided. A matter with no recorded
    // classification is visibly unevaluated, never presented as a complete
    // requirement set. Fact sources are implementation choices pending
    // Dean's approved rule definitions (tri-state: missing ≠ negative).
    const matterContext = await query(
      `SELECT classification_code FROM matters
       WHERE id = $1 AND accountable_institution_id = $2`,
      [transfer.matter_id, transfer.accountable_institution_id]
    )
    const classificationCode = matterContext.rows[0]?.classification_code ?? null
    const bondRows = await query(
      'SELECT 1 AS present FROM bonds WHERE transfer_id = $1 LIMIT 1',
      [id]
    )
    const loanRows = await query(
      'SELECT loan_amount FROM transfer_financials WHERE transfer_id = $1 LIMIT 1',
      [id]
    )
    let hasBond: boolean | null = null
    if (bondRows.rows.length > 0) {
      hasBond = true
    } else if (loanRows.rows.length > 0 && loanRows.rows[0].loan_amount !== null) {
      hasBond = Number(loanRows.rows[0].loan_amount) > 0
    }

    const rulesResult = await query(
      `SELECT rule_key, classification_code, condition_key
       FROM document_requirement_rules WHERE status = 'active'`,
      []
    )
    const SUPPORTED_CONDITIONS = new Set(['has_bond', 'cash_purchase'])
    const ruleEvaluable = (rule: {
      classification_code: string | null
      condition_key: string | null
    }) => {
      const cls = rule.classification_code
      if (cls && cls !== '*' && classificationCode === null) return false
      const cond = rule.condition_key
      if (cond === null) return true
      if (!SUPPORTED_CONDITIONS.has(cond)) return false
      if ((cond === 'has_bond' || cond === 'cash_purchase') && hasBond === null) return false
      return true
    }

    res.json({
      message: 'OK',
      data: {
        documents: documentsResult.rows.map(mapTransferDocument),
        requirements: requirementsResult.rows.map(mapDocumentRequirement),
        unevaluatedFacts: [
          ...(classificationCode === null ? ['classification_code'] : []),
          ...(hasBond === null ? ['has_bond'] : []),
        ],
        unevaluatedRules: rulesResult.rows
          .filter(rule => !ruleEvaluable(rule))
          .map(rule => ({ ruleKey: rule.rule_key, conditionKey: rule.condition_key })),
      },
    })
  })
)

router.post(
  '/:id/documents',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    await proxyDeedly(req, res, `/${req.params.id}/documents`, 'POST')
  })
)

router.post(
  '/:id/documents/requirements/recalculate',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    await proxyDeedly(req, res, `/${req.params.id}/documents/requirements/recalculate`, 'POST')
  })
)

router.post(
  '/:id/documents/:documentId/rescan',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    await proxyDeedly(req, res, `/${req.params.id}/documents/${req.params.documentId}/rescan`, 'POST')
  })
)

router.post(
  '/:id/documents/:documentId/download-link',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    await proxyDeedly(req, res, `/${req.params.id}/documents/${req.params.documentId}/download-link`, 'POST')
  })
)

// Multipart file upload: the raw request body is forwarded unchanged to the
// FastAPI lane (express.json only parses application/json, so the multipart
// stream is still intact here). Content sniffing, the 25 MB cap, storage and
// scanning all happen upstream — but a declared oversize body is refused
// here first so an oversized stream is never proxied.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 + 64 * 1024 // file cap + multipart overhead

router.post(
  '/:id/documents/:documentId/file',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const declared = Number(req.headers['content-length'] || '0')
    if (declared > MAX_UPLOAD_BYTES) {
      res.status(413).json({ success: false, error: 'File exceeds the 25 MB limit' })
      return
    }
    const baseUrl = process.env.DEEDLY_API_BASE_URL
    if (!baseUrl) {
      res.status(503).json(DEEDLY_UNAVAILABLE)
      return
    }
    // Actual-size guard for chunked/undeclared bodies: count streamed bytes
    // through a Transform — a missing Content-Length must not proxy an
    // unbounded body upstream. On overflow the controller aborts the
    // upstream fetch immediately and the handler answers 413.
    let received = 0
    let tooLarge = false
    const abort = new AbortController()
    const limited = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > MAX_UPLOAD_BYTES) {
          if (!tooLarge) {
            tooLarge = true
            abort.abort()
          }
          // Keep draining: the transform drops overflow bytes but continues
          // reading so the socket stays consumed while the 413 flushes —
          // stopping reads here would RST the connection mid-response.
          callback()
          return
        }
        callback(null, chunk)
      },
    })
    limited.on('error', () => {}) // never propagate as an unhandled stream error
    req.on('error', () => limited.destroy())
    req.pipe(limited)
    try {
      const headers: Record<string, string> = {
        Authorization: req.headers.authorization as string,
      }
      if (req.headers['content-type']) {
        headers['Content-Type'] = req.headers['content-type']
      }
      if (req.headers['content-length']) {
        headers['Content-Length'] = req.headers['content-length']
      }
      const upstream = await fetch(
        `${baseUrl.replace(/\/+$/, '')}/api/v1/transfers/${req.params.id}/documents/${req.params.documentId}/file`,
        {
          method: 'POST',
          headers,
          body: limited as unknown as BodyInit,
          // @ts-expect-error Node fetch requires duplex for stream bodies
          duplex: 'half',
          redirect: 'error',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
        }
      )
      const body = await upstream.text()
      if (upstream.status >= 500) {
        res.status(503).json(DEEDLY_UNAVAILABLE)
        return
      }
      const contentType = upstream.headers.get('content-type')
      if (contentType) {
        res.setHeader('Content-Type', contentType)
      }
      res.status(upstream.status).send(body)
    } catch {
      if (res.headersSent) return
      if (tooLarge) {
        // The body exceeded the cap mid-stream — refuse it, never proxy.
        // The socket stays open and keeps draining the remaining body:
        // closing with inbound data still in flight forces RST, and the
        // client would see ECONNRESET instead of the 413.
        res.status(413).json({ success: false, error: 'File exceeds the 25 MB limit' })
        return
      }
      res.status(503).json(DEEDLY_UNAVAILABLE)
    }
  })
)

router.get(
  '/:id/financials',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    // Client financial visibility is not documented. Fail closed.
    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    // No separate financials:read ability is documented; reuse transfers:read.
    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const financialsQuery = `
      SELECT tf.*
      FROM transfer_financials tf
      WHERE tf.transfer_id = $1
    `
    const financialsResult = await query(financialsQuery, [id])
    const financials = financialsResult.rows[0]
      ? mapTransferFinancials(financialsResult.rows[0])
      : null

    res.json({
      message: 'OK',
      data: {
        financials,
      },
    })
  })
)

router.get(
  '/:id',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    // Staff must hold the documented transfers:read ability (handover §4.5).
    // Role 4 (Client) is not in the canonical transfers:read assignment; client
    // access is governed by the GR party rule implemented in authorizeTransfer.
    if (!user.isClient && !user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const data: Record<string, any> = mapTransferRow(transfer)
    // The matter projection is staff-only: the client contract does not
    // document matter-field visibility, so clients keep the existing view.
    if (!user.isClient) {
      let matter = null
      if (transfer.matter_id) {
        const matterResult = await query(
          `SELECT id, reference_number, matter_type, title, status, firm_reference,
                  classification_code, accountable_institution_id, created_at,
                  updated_at::text AS updated_at
           FROM matters
           WHERE id = $1 AND accountable_institution_id = $2
             AND matter_type = 'transfer'`,
          [transfer.matter_id, user.accountable_institution_id]
        )
        matter = matterResult.rows[0] ? mapMatter(matterResult.rows[0]) : null
      }
      data.matter = matter
    }

    res.json({
      message: 'OK',
      data,
    })
  })
)

function mapEstateContext(row: any) {
  return {
    id: row.id,
    transferId: row.transfer_id,
    deceasedGoldenRecordId: row.deceased_golden_record_id,
    mastersEstateReference: row.masters_estate_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPartyRelationship(row: any) {
  return {
    id: row.id,
    transferPartyId: row.transfer_party_id,
    relationshipCode: row.relationship_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRepresentativeAssignment(row: any) {
  let target = null
  if (row.represented_estate_context_id != null) {
    target = { type: 'estate_context', id: row.represented_estate_context_id }
  } else if (row.represented_transfer_party_id != null) {
    target = { type: 'transfer_party', id: row.represented_transfer_party_id }
  }

  return {
    id: row.id,
    transferId: row.transfer_id,
    personGoldenRecordId: row.person_golden_record_id,
    capacity: row.capacity,
    representedTarget: target,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// Scoped to the caller's verified institution for every role.
async function authorizeTransferParty(user: CurrentUser, transferId: string, transferPartyId: string): Promise<boolean> {
  const sql = `
    SELECT 1
    FROM transfer_parties
    WHERE id = $1
      AND transfer_id = $2
      AND accountable_institution_id = $3
  `
  const result = await query(sql, [transferPartyId, transferId, user.accountable_institution_id])
  return result.rows.length > 0
}

router.get(
  '/:id/estate-contexts',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const listQuery = `
      SELECT id, transfer_id, deceased_golden_record_id, masters_estate_reference,
             created_at, updated_at
      FROM matter_estate_contexts
      WHERE transfer_id = $1
        AND accountable_institution_id = $2
      ORDER BY created_at
    `
    const result = await query(listQuery, [id, user.accountable_institution_id])

    res.json({
      message: 'OK',
      data: { estateContexts: result.rows.map(mapEstateContext) },
    })
  })
)

router.get(
  '/:id/estate-contexts/:estate_context_id',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id, estate_context_id } = req.params

    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    if (!isUuid(estate_context_id)) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const detailQuery = `
      SELECT id, transfer_id, deceased_golden_record_id, masters_estate_reference,
             created_at, updated_at
      FROM matter_estate_contexts
      WHERE id = $1
        AND transfer_id = $2
        AND accountable_institution_id = $3
    `
    const result = await query(detailQuery, [estate_context_id, id, user.accountable_institution_id])

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    res.json({
      message: 'OK',
      data: mapEstateContext(result.rows[0]),
    })
  })
)

router.get(
  '/:id/parties/:transfer_party_id/relationships',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id, transfer_party_id } = req.params

    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const partyBelongs = await authorizeTransferParty(user, id, transfer_party_id)
    if (!partyBelongs) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const listQuery = `
      SELECT id, transfer_party_id, relationship_code, created_at, updated_at
      FROM party_relationship_assignments
      WHERE transfer_party_id = $1
      ORDER BY created_at
    `
    const result = await query(listQuery, [transfer_party_id])

    res.json({
      message: 'OK',
      data: { relationships: result.rows.map(mapPartyRelationship) },
    })
  })
)

router.post(
  '/:id/parties/:transfer_party_id/relationships',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id, transfer_party_id } = req.params
    const body = req.body || {}

    // Clients are denied explicitly — not merely via the absence of the
    // transfers:write ability in their role assignment.
    if (user.isClient || !user.hasAbility('transfers:write')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    if (Object.keys(body).length !== 1 || !('relationship_code' in body)) {
      res.status(422).json({ success: false, error: 'Only relationship_code is accepted' })
      return
    }

    const relationship_code = body.relationship_code
    if (typeof relationship_code !== 'string' || !relationship_code.trim()) {
      res.status(422).json({ success: false, error: 'relationship_code is required' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const partyBelongs = await authorizeTransferParty(user, id, transfer_party_id)
    if (!partyBelongs) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const definitionResult = await query(
      'SELECT code FROM party_relationship_definitions WHERE code = $1 AND is_active = TRUE',
      [relationship_code]
    )
    if (definitionResult.rows.length === 0) {
      res.status(400).json({ success: false, error: 'Unknown or inactive relationship code' })
      return
    }

    const doInsert = async (client: any) => {
      const insertResult = await client.query(
        `
          INSERT INTO party_relationship_assignments (
            transfer_party_id,
            relationship_code,
            created_by_user_id,
            updated_by_user_id
          )
          VALUES ($1, $2, $3, $4)
          RETURNING id, transfer_party_id, relationship_code, created_at, updated_at
        `,
        [transfer_party_id, relationship_code, user.user_id, user.user_id]
      )
      return insertResult.rows[0]
    }

    try {
      const created = await withTransaction(doInsert)
      res.status(201).json({
        message: 'Created',
        data: mapPartyRelationship(created),
      })
    } catch (err: any) {
      if (err.code === '23505') {
        res.status(409).json({ success: false, error: 'Relationship already assigned' })
        return
      }
      if (err.code === '23503') {
        res.status(400).json({ success: false, error: 'Unknown or inactive relationship code' })
        return
      }
      throw err
    }
  })
)

router.get(
  '/:id/representative-assignments',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const listQuery = `
      SELECT id, transfer_id, person_golden_record_id, capacity,
             represented_transfer_party_id, represented_estate_context_id,
             created_at, updated_at
      FROM representative_assignments
      WHERE transfer_id = $1
        AND accountable_institution_id = $2
      ORDER BY created_at
    `
    const result = await query(listQuery, [id, user.accountable_institution_id])

    res.json({
      message: 'OK',
      data: { representativeAssignments: result.rows.map(mapRepresentativeAssignment) },
    })
  })
)

router.get(
  '/:id/representative-assignments/:assignment_id',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id, assignment_id } = req.params

    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    if (!isUuid(assignment_id)) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    const detailQuery = `
      SELECT id, transfer_id, person_golden_record_id, capacity,
             represented_transfer_party_id, represented_estate_context_id,
             created_at, updated_at
      FROM representative_assignments
      WHERE id = $1
        AND transfer_id = $2
        AND accountable_institution_id = $3
    `
    const result = await query(detailQuery, [assignment_id, id, user.accountable_institution_id])

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    res.json({
      message: 'OK',
      data: mapRepresentativeAssignment(result.rows[0]),
    })
  })
)

// Write routes are owned by the FastAPI service: party attach may need the
// Golden Record visibility recipe (Entities S2S lane), and matter create shares
// the same transaction semantics. The JWT is verified locally, then forwarded.
// Clients are denied here as well so a forwarded client write can never be
// attempted: FastAPI applies the same explicit denial authoritatively.
function denyClientWrite(req: Request, res: Response): boolean {
  if (req.currentUser!.isClient) {
    res.status(403).json({ success: false, error: 'Forbidden' })
    return true
  }
  return false
}

router.post('/', requireJwt, asyncHandler(async (req, res) => {
  if (denyClientWrite(req, res)) return
  await proxyDeedly(req, res, '/', 'POST')
}))

router.patch(
  '/:id',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    if (denyClientWrite(req, res)) return
    const { id } = req.params
    if (!isUuid(id)) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    await proxyDeedly(req, res, `/${id}`, 'PATCH')
  })
)

router.post(
  '/:id/parties',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    if (denyClientWrite(req, res)) return
    const { id } = req.params
    if (!isUuid(id)) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    await proxyDeedly(req, res, `/${id}/parties`, 'POST')
  })
)

// Allow-listed matter–property readback (link + property projection).
// Staff-only: the client property contract is undocumented, so clients fail
// closed like the other staff surfaces.
function mapMatterPropertyLink(row: any) {
  const property = row.p_id
    ? mapProperty(
        Object.fromEntries(
          Object.entries(row)
            .filter(([key]) => key.startsWith('p_'))
            .map(([key, value]) => [key.slice(2), value])
        )
      )
    : null
  return {
    id: row.link_id,
    matterId: row.matter_id,
    propertyId: row.link_property_id,
    propertyKind: row.property_kind,
    registrationStatus: row.registration_status,
    roleInMatter: row.role_in_matter,
    externalPropertyId: row.external_property_id,
    propertySource: row.property_source,
    accountableInstitutionId: row.link_accountable_institution_id,
    clientRequestId: row.link_client_request_id ? String(row.link_client_request_id) : null,
    createdAt: row.link_created_at,
    updatedAt: row.link_updated_at,
    property,
  }
}

router.get(
  '/:id/properties',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id } = req.params

    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }

    const transfer = await authorizeTransfer(user, id)
    if (!transfer) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }

    // Deterministic resolution through transfers.matter_id only: a transfer
    // without a resolvable same-institution matter link yields an empty list
    // rather than falling back to prototype-era source_record_id rows.
    const linksQuery = `
      SELECT
        mp.id AS link_id, mp.matter_id, mp.property_id AS link_property_id,
        mp.property_kind, mp.registration_status, mp.role_in_matter,
        mp.external_property_id, mp.property_source,
        mp.accountable_institution_id AS link_accountable_institution_id,
        mp.client_request_id AS link_client_request_id,
        mp.created_at AS link_created_at, mp.updated_at AS link_updated_at,
        p.id AS p_id, p.property_id AS p_property_id, p.erf_number AS p_erf_number,
        p.street_address AS p_street_address, p.suburb AS p_suburb,
        p.city AS p_city, p.postal_code AS p_postal_code,
        p.province AS p_province, p.country AS p_country,
        p.property_type AS p_property_type,
        p.legal_description AS p_legal_description,
        p.year_built AS p_year_built, p.square_footage AS p_square_footage,
        p.extent_sqm AS p_extent_sqm, p.status AS p_status,
        p.source_system AS p_source_system,
        p.accountable_institution_id AS p_accountable_institution_id,
        p.client_request_id AS p_client_request_id,
        p.created_at AS p_created_at, p.updated_at AS p_updated_at
      FROM matter_properties mp
      JOIN matters m
        ON m.id = mp.matter_id
       AND m.accountable_institution_id = $2
       AND m.matter_type = 'transfer'
      JOIN transfers t
        ON t.matter_id = mp.matter_id
       AND t.id = $1
       AND t.accountable_institution_id = $2
      LEFT JOIN properties p
        ON p.id = mp.property_id
       AND p.accountable_institution_id = mp.accountable_institution_id
      WHERE mp.accountable_institution_id = $2
      ORDER BY mp.created_at, mp.id
    `
    const linksResult = await query(linksQuery, [id, user.accountable_institution_id])

    res.json({
      message: 'OK',
      data: { properties: linksResult.rows.map(mapMatterPropertyLink) },
    })
  })
)

router.post(
  '/:id/properties',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    if (denyClientWrite(req, res)) return
    const { id } = req.params
    if (!isUuid(id)) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    await proxyDeedly(req, res, `/${id}/properties`, 'POST')
  })
)

// ---- ID verification (Sumsub POC) — auth-forwarded to the FastAPI owner ----
// The BFF verifies the JWT then forwards it unchanged; FastAPI independently
// re-verifies, re-checks transfer/party tenancy, and owns provider calls.
// No provider ids, level names or tenant ids are accepted here — FastAPI
// derives identity from server-side rows only.

router.get(
  '/:id/parties/:transfer_party_id/id-verification',
  requireJwt,
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.currentUser!
    const { id, transfer_party_id } = req.params
    if (user.isClient) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    if (!user.hasAbility('transfers:read')) {
      res.status(403).json({ success: false, error: 'Forbidden' })
      return
    }
    if (!isUuid(id) || !isUuid(transfer_party_id)) {
      res.status(404).json({ success: false, error: 'Not found' })
      return
    }
    await proxyDeedly(req, res, `/${id}/parties/${transfer_party_id}/id-verification`, 'GET', true)
  })
)

for (const action of ['session', 'refresh', 'retry'] as const) {
  router.post(
    `/:id/parties/:transfer_party_id/id-verification/${action}`,
    requireJwt,
    asyncHandler(async (req: Request, res: Response) => {
      const user = req.currentUser!
      const { id, transfer_party_id } = req.params
      if (user.isClient || !user.hasAbility('transfers:write')) {
        res.status(403).json({ success: false, error: 'Forbidden' })
        return
      }
      if (!isUuid(id) || !isUuid(transfer_party_id)) {
        res.status(404).json({ success: false, error: 'Not found' })
        return
      }
      await proxyDeedly(req, res, `/${id}/parties/${transfer_party_id}/id-verification/${action}`, 'POST', true)
    })
  )
}

export default router
