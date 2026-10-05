import { apiRequest } from './http'
import type { ApiResponse, PaginatedResponse, TransferFilters } from '../types'
import type { TransferState, Document as TransferDocument, Party, PropertyDetails } from '../../components/transfers/TransferForm'

export interface TransferAggregate extends TransferState {
  id?: string
  transfer_id?: string
  progress?: number
  created_at?: string
  updated_at?: string
  next_due_date?: string
}

export interface Milestone {
  id: string
  name: string
  statusLabel: string
  status: 'not_started' | 'in_progress' | 'completed' | 'overdue' | 'not_required'
  completedDate?: string
  dueDate?: string
  notes?: string
}

export interface AuditEntry {
  id: string
  user: string | null
  action: string
  timestamp: string
}

interface ServerDocument {
  id?: unknown
  transferId?: unknown
  transfer_id?: unknown
  catalogueDocumentId?: unknown
  catalogue_document_id?: unknown
  name?: unknown
  category?: unknown
  type?: unknown
  status?: unknown
  filePath?: unknown
  file_path?: unknown
  fileSize?: unknown
  file_size?: unknown
  fileType?: unknown
  file_type?: unknown
  originalFileName?: unknown
  original_file_name?: unknown
  description?: unknown
  notes?: unknown
  uploadedAt?: unknown
  uploadDate?: unknown
}

export interface TransferClassification {
  canonicalCode: string
  subtype: string
  displayLabel: string
  transferFrom: string | null
  transferFromLabel: string | null
  requiresTransferFrom: boolean
}

export function classificationLabel(option: TransferClassification): string {
  return option.transferFromLabel ? `${option.displayLabel} — ${option.transferFromLabel}` : option.displayLabel
}

function isTransferClassification(input: unknown): input is TransferClassification {
  if (!input || typeof input !== 'object') return false
  const option = input as Record<string, unknown>
  const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  return nonEmpty(option.canonicalCode) && /^transfer\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(option.canonicalCode)
    && option.canonicalCode !== 'transfer.generic'
    && nonEmpty(option.subtype) && nonEmpty(option.displayLabel)
    && (option.transferFrom === null || nonEmpty(option.transferFrom))
    && (option.transferFromLabel === null || nonEmpty(option.transferFromLabel))
    && typeof option.requiresTransferFrom === 'boolean'
    && (!option.requiresTransferFrom || (nonEmpty(option.transferFrom) && nonEmpty(option.transferFromLabel)))
}

interface ServerAggregate {
  matter?: { classificationCode?: string | null; firmReference?: string | null } | null
  id?: string
  transferId?: string
  transfer_id?: string
  propertyAddress?: string
  purchasePrice?: number
  status?: string
  currentStep?: number
  totalSteps?: number
  progress?: number
  property?: Record<string, unknown>
  parties?: Record<string, unknown>[]
  financials?: Record<string, unknown>
  documents?: ServerDocument[]
  createdAt?: string
  updatedAt?: string
  nextDueDate?: string
}

function isLegacyCreatePayload(data: unknown): data is { property_address: string; purchase_price: number } {
  return Boolean(data && typeof data === 'object' && typeof (data as Record<string, unknown>).property_address === 'string' && typeof (data as Record<string, unknown>).purchase_price === 'number')
}

function legacyToAggregate(data: { property_address: string; purchase_price: number }): TransferAggregate {
  return {
    currentStep: 1,
    status: 'draft',
    propertyDetails: { address: data.property_address, city: '', state: '', zipCode: '', propertyType: '', lotNumber: '', legalDescription: '', yearBuilt: '', squareFootage: '' },
    parties: [],
    financials: { purchasePrice: String(data.purchase_price), depositAmount: '', loanAmount: '', interestRate: '', loanTerm: '', transferDuty: '', conveyancingFees: '', deedsOfficeFees: '', vat: '', postPetty: '', clearanceCertificate: '', ratesClearance: '' },
    documents: []
  }
}

function toServerAggregate(state: TransferAggregate) {
  const property = state.propertyDetails
  const financials = state.financials
  return {
    id: state.id,
    transferId: state.transfer_id,
    currentStep: state.currentStep,
    totalSteps: 5,
    progress: Math.round((state.currentStep / 5) * 100),
    status: state.status,
    property: {
      address: property.address,
      city: property.city,
      province: property.state,
      postalCode: property.zipCode,
      propertyType: property.propertyType,
      erfNumber: property.lotNumber,
      lotNumber: property.lotNumber,
      legalDescription: property.legalDescription,
      description: property.legalDescription,
      yearBuilt: property.yearBuilt,
      squareFootage: property.squareFootage
    },
    parties: state.parties,
    financials: {
      ...financials,
      postAndPetties: financials.postPetty,
      clearanceCertificateFee: financials.clearanceCertificate,
      ratesClearanceAmount: financials.ratesClearance
    },
    documents: state.documents.map(({ file: _file, ...document }) => ({
      ...document,
      category: document.type,
      uploadedAt: document.uploadDate,
      catalogueDocumentId: document.catalogueDocumentId,
      notes: document.notes ?? document.description,
      originalFileName: document.originalFileName,
      fileSize: document.fileSize,
      fileType: document.fileType,
      filePath: document.filePath
    }))
  }
}

const value = (input: unknown) => input === null || input === undefined ? '' : String(input)

function mapServerDocument(document: ServerDocument): TransferDocument {
  return {
    id: value(document.id),
    name: value(document.name),
    type: value(document.category ?? document.type),
    catalogueDocumentId: value(document.catalogueDocumentId ?? document.catalogue_document_id),
    status: (document.status === 'verified' ? 'verified' : document.status === 'pending' ? 'pending' : document.status === 'rejected' ? 'rejected' : document.status === 'not_required' ? 'not_required' : 'uploaded') as TransferDocument['status'],
    uploadDate: value(document.uploadedAt ?? document.uploadDate),
    description: value(document.description ?? document.notes),
    notes: value(document.notes ?? document.description),
    filePath: value(document.filePath ?? document.file_path),
    fileSize: typeof document.fileSize === 'number' ? document.fileSize : typeof document.file_size === 'number' ? document.file_size : undefined,
    fileType: value(document.fileType ?? document.file_type),
    originalFileName: value(document.originalFileName ?? document.original_file_name)
  }
}

function fromServerAggregate(server: ServerAggregate): TransferAggregate {
  const property = server.property || {}
  const financials = server.financials || {}
  const status = server.status === 'completed' || server.status === 'complete' ? 'completed' : server.status === 'in_progress' ? 'in_progress' : 'draft'
  return {
    id: server.id,
    transfer_id: server.transferId || server.transfer_id,
    classificationCode: server.matter?.classificationCode ?? null,
    firmReference: server.matter?.firmReference ?? null,
    progress: typeof server.progress === 'number' ? server.progress : undefined,
    created_at: server.createdAt,
    updated_at: server.updatedAt,
    next_due_date: server.nextDueDate,
    currentStep: server.currentStep || 1,
    status,
    propertyDetails: {
      address: value(property.streetAddress ?? property.address ?? server.propertyAddress),
      city: value(property.city),
      state: value(property.province),
      zipCode: value(property.postalCode),
      propertyType: value(property.propertyType),
      lotNumber: value(property.lotNumber ?? property.erfNumber),
      legalDescription: value(property.legalDescription ?? property.description),
      yearBuilt: value(property.yearBuilt),
      squareFootage: value(property.squareFootage ?? property.extentSqm)
    },
    parties: (server.parties || []).map(party => ({
      id: value(party.id),
      source: party.party_source === 'manual' || party.source === 'manual' ? 'manual' as const : 'golden_record' as const,
      persistedPartyId: value(party.id) || undefined,
      goldenRecordId: value(party.golden_record_id ?? party.goldenRecordId) || undefined,
      entityType: value(party.entity_type ?? party.entityType) as Party['entityType'],
      type: party.role === 'transferor' || party.type === 'seller' ? 'seller' as const : 'buyer' as const,
      name: value(party.name) || `${value(party.first_name)} ${value(party.surname)}`.trim(),
      idNumber: value(party.idNumber ?? party.id_number ?? party.sa_id_number ?? party.passport_number),
      email: value(party.email),
      phone: value(party.phone),
      address: value(party.address),
      company: value(party.company ?? party.companyName),
      role: value(party.role ?? party.roleTitle),
      isPrimary: Boolean(party.isPrimary)
    })),
    financials: {
      purchasePrice: value(financials.purchasePrice ?? server.purchasePrice),
      depositAmount: value(financials.depositAmount),
      loanAmount: value(financials.loanAmount),
      interestRate: value(financials.interestRate),
      loanTerm: value(financials.loanTerm),
      transferDuty: value(financials.transferDuty),
      conveyancingFees: value(financials.conveyancingFees),
      deedsOfficeFees: value(financials.deedsOfficeFees),
      vat: value(financials.vat),
      postPetty: value(financials.postAndPetties ?? financials.postPetty),
      clearanceCertificate: value(financials.clearanceCertificateFee ?? financials.clearanceCertificate),
      ratesClearance: value(financials.ratesClearanceAmount ?? financials.ratesClearance)
    },
    documents: (server.documents || []).map(mapServerDocument)
  }
}

/** v1 list/detail endpoints return the upstream `{message, data}` envelope
 * rather than `{success, data}` — map explicitly instead of trusting
 * `response.success`. */
interface V1ListData {
  transfers?: ServerAggregate[]
  pagination?: PaginatedResponse<TransferAggregate>['pagination']
  statusTotals?: TransferStatusTotals
}

export interface TransferStatusTotals {
  total: number
  inProgress: number
  completed: number
}

export interface TransferListResponse extends PaginatedResponse<TransferAggregate> {
  statusTotals: TransferStatusTotals | null
}

export class TransferApi {
  static async getClassifications(): Promise<TransferClassification[]> {
    const response = await apiRequest<{ data?: { classifications?: unknown } }>(
      '/api/v1/transfers/classifications', { cache: 'no-store' },
    )
    const options = response?.data?.classifications
    if (!Array.isArray(options) || !options.every(isTransferClassification)
      || new Set(options.map(option => option.canonicalCode)).size !== options.length) {
      throw new Error('Invalid classification response')
    }
    return options
  }

  static async getTransfers(filters: TransferFilters = {}): Promise<TransferListResponse> {
    // The v1 list owns status filtering, pagination and institution totals;
    // the browser must not recompute them from a single page.
    const params = new URLSearchParams()
    if (filters.page) params.set('page', String(filters.page))
    if (filters.limit) params.set('limit', String(filters.limit))
    if (filters.sortBy) params.set('sortBy', filters.sortBy)
    if (filters.sortOrder) params.set('sortOrder', filters.sortOrder)
    if (filters.status !== undefined) params.set('status', filters.status)
    const qs = params.toString()
    const envelope = await apiRequest<{ message?: string; data?: V1ListData }>(`/api/v1/transfers${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
    const data = envelope.data
    const pagination = data?.pagination
    const totals = data?.statusTotals ?? null
    const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    if (!Array.isArray(data?.transfers) || !pagination
      || ![pagination.page, pagination.limit, pagination.total, pagination.totalPages].every(isCount)
      || pagination.page < 1 || pagination.limit < 1
      || (totals !== null && ![totals.total, totals.inProgress, totals.completed].every(isCount))) {
      throw new Error('Invalid transfer list response')
    }
    return {
      success: true,
      data: data.transfers.map(fromServerAggregate),
      pagination,
      statusTotals: totals,
    }
  }

  static async getTransfer(id: string): Promise<ApiResponse<TransferAggregate>> {
    const envelope = await apiRequest<{ message?: string; data?: ServerAggregate }>(`/api/v1/transfers/${id}`)
    return { success: true, message: envelope.message, data: envelope.data ? fromServerAggregate(envelope.data) : undefined }
  }

  static async createTransfer(data: Partial<TransferAggregate> | { property_address: string; purchase_price: number }): Promise<ApiResponse<TransferAggregate>> {
    const aggregate = isLegacyCreatePayload(data) ? legacyToAggregate(data) : data as TransferAggregate
    const response = await apiRequest<ApiResponse<ServerAggregate>>('/api/transfers', { method: 'POST', body: toServerAggregate(aggregate) })
    return { ...response, data: response.data ? fromServerAggregate(response.data) : undefined }
  }

  static async updateTransfer(id: string, data: Partial<TransferAggregate>): Promise<ApiResponse<TransferAggregate>> {
    const response = await apiRequest<ApiResponse<ServerAggregate>>(`/api/transfers/${id}`, { method: 'PUT', body: toServerAggregate(data as TransferAggregate) })
    return { ...response, data: response.data ? fromServerAggregate(response.data) : undefined }
  }

  static async uploadTransferDocument(transferId: string, documentId: string, file: File): Promise<ApiResponse<TransferDocument>> {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('Failed to read file'))
      reader.readAsDataURL(file)
    })

    const response = await apiRequest<ApiResponse<ServerDocument>>(`/api/transfers/${transferId}/documents/${documentId}/upload`, {
      method: 'POST',
      body: {
        fileName: file.name,
        fileType: file.type || 'application/octet-stream',
        fileData: base64
      }
    })

    if (!response.data) {
      return { success: false, error: response.error || 'Upload failed' }
    }

    return { success: true, data: mapServerDocument(response.data) }
  }

  static async addTransferDocument(transferId: string, catalogueDocumentId: string, name?: string): Promise<ApiResponse<TransferDocument>> {
    const response = await apiRequest<ApiResponse<ServerDocument>>(`/api/transfers/${transferId}/documents`, {
      method: 'POST',
      body: { catalogueDocumentId, name }
    })

    if (!response.data) {
      return { success: false, error: response.error || 'Failed to add document' }
    }

    return { success: true, data: mapServerDocument(response.data) }
  }

  static async updateTransferDocument(transferId: string, documentId: string, updates: { status?: TransferDocument['status']; notes?: string }): Promise<ApiResponse<TransferDocument>> {
    const response = await apiRequest<ApiResponse<ServerDocument>>(`/api/transfers/${transferId}/documents/${documentId}`, {
      method: 'PATCH',
      body: updates
    })

    if (!response.data) {
      return { success: false, error: response.error || 'Failed to update document' }
    }

    return { success: true, data: mapServerDocument(response.data) }
  }

  static async deleteTransfer(id: string): Promise<ApiResponse<boolean>> {
    return apiRequest(`/api/transfers/${id}`, { method: 'DELETE' })
  }

  static async getMilestones(id: string): Promise<ApiResponse<Milestone[]>> {
    const envelope = await apiRequest<{ message?: string; data?: { milestones?: Milestone[] } }>(`/api/v1/transfers/${id}/milestones`)
    const rows = envelope.data?.milestones
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !row.id
      || typeof row.name !== 'string' || !['not_started', 'in_progress', 'completed', 'overdue', 'not_required'].includes(row.status))) {
      throw new Error('Invalid milestones response')
    }
    return { success: true, message: envelope.message, data: rows }
  }

  static async updateMilestones(_id: string, _milestones: Milestone[]): Promise<ApiResponse<Milestone[]>> {
    throw new Error('Milestones are read-only; editing is unavailable.')
  }

  static async getActivity(id: string): Promise<ApiResponse<AuditEntry[]>> {
    const envelope = await apiRequest<{ message?: string; data?: { activity?: AuditEntry[] } }>(`/api/v1/transfers/${id}/activity`)
    const rows = envelope.data?.activity
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !row.id
      || (row.user != null && typeof row.user !== 'string') || typeof row.action !== 'string'
      || typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp)))) {
      throw new Error('Invalid activity response')
    }
    return { success: true, message: envelope.message, data: rows }
  }

  // ---- Authenticated v1 matter + party lane (BFF → FastAPI) ----

  /** Idempotent matter creation. `clientRequestId` must be stable across retries
   * so a repeated request resolves to the same matter rather than duplicating it. */
  static async createMatter(request: CreateMatterRequest): Promise<ApiResponse<MatterCreated>> {
    return apiRequest('/api/v1/transfers', { method: 'POST', body: request })
  }

  /** Attach one party (manual natural person or existing Golden Record). */
  static async attachParty(transferId: string, request: AttachPartyRequest): Promise<ApiResponse<TransferPartyApi>> {
    return apiRequest(`/api/v1/transfers/${transferId}/parties`, { method: 'POST', body: request })
  }

  /** Source-aware party read-back for reopening partially saved matters. */
  static async getMatterParties(transferId: string): Promise<ApiResponse<TransferPartyApi[]>> {
    const response = await apiRequest<ApiResponse<{ parties: TransferPartyApi[] }>>(`/api/v1/transfers/${transferId}/parties`)
    return { ...response, data: response.data?.parties }
  }

  /** Core matter read-back including the matter projection and both
   * updated_at concurrency tokens. Echo the token strings verbatim into
   * updateMatterCore — never reformat them. */
  static async getMatterCore(transferId: string): Promise<ApiResponse<MatterCoreDetail>> {
    return apiRequest(`/api/v1/transfers/${transferId}`)
  }

  /** Optimistic-concurrency update of the editable core fields.
   * Throws ApiRequestError with status 409 when either stored row was
   * modified since the read the edit was based on. */
  static async updateMatterCore(transferId: string, request: UpdateMatterCoreRequest): Promise<ApiResponse<MatterCoreDetail>> {
    return apiRequest(`/api/v1/transfers/${transferId}`, { method: 'PATCH', body: request })
  }

  // ---- Matter–property linking and readback (staff surfaces) ----

  /** Same-institution property discovery for selecting a link target. */
  static async searchProperties(query: string, limit = 25): Promise<ApiResponse<PropertyRecordApi[]>> {
    const params = new URLSearchParams()
    if (query.trim()) params.set('query', query.trim())
    params.set('limit', String(limit))
    const response = await apiRequest<ApiResponse<{ properties: PropertyRecordApi[] }>>(`/api/v1/properties?${params}`)
    if (!Array.isArray(response.data?.properties)) throw new Error('Invalid property search response')
    return { ...response, data: response.data.properties }
  }

  /** Attach a property to a matter: link an existing property_id or capture a
   * manual institution-private property, atomically. Retries must reuse the
   * same client_request_id so a replay resolves to the original rows. */
  static async attachMatterProperty(transferId: string, request: AttachMatterPropertyRequest): Promise<ApiResponse<MatterPropertyLinkApi>> {
    return apiRequest(`/api/v1/transfers/${transferId}/properties`, { method: 'POST', body: request })
  }

  /** Saved link + property readback for reopening a matter. Existing links
   * remain readable regardless of the property's current status. */
  static async getMatterProperties(transferId: string): Promise<ApiResponse<MatterPropertyLinkApi[]>> {
    const response = await apiRequest<ApiResponse<{ properties: MatterPropertyLinkApi[] }>>(`/api/v1/transfers/${transferId}/properties`)
    if (!Array.isArray(response.data?.properties)) throw new Error('Invalid property readback response')
    return { ...response, data: response.data.properties }
  }
}

export interface CreateMatterRequest {
  client_request_id: string
  property_address: string
  purchase_price: number
  firm_reference?: string | null
  classification_code?: string | null
}

/** POST /api/v1/transfers response (camelCase projection, mirrors _map_transfer). */
export interface MatterCreated {
  id: string
  transferId: string | null
  propertyAddress: string | null
  purchasePrice: number | null
  status: string | null
  /** false when the request replayed an existing matter (HTTP 200). */
  created: boolean
}

/** GET/PATCH /api/v1/transfers/{id} matter projection (staff view). */
export interface MatterCoreMatter {
  id: string
  referenceNumber: string | null
  matterType: string | null
  title: string | null
  firmReference: string | null
  classificationCode: string | null
  status: string | null
  updatedAt: string
}

/** GET/PATCH /api/v1/transfers/{id} data payload. */
export interface MatterCoreDetail {
  id: string
  transferId: string | null
  propertyAddress: string | null
  purchasePrice: number | null
  status: string | null
  currentStep: number | null
  totalSteps: number | null
  progress: number | null
  updatedAt: string
  matter?: MatterCoreMatter | null
}

/** PATCH /api/v1/transfers/{id} request. Omitted keys are unchanged;
 * null clears firm_reference/title. The expected_* keys must echo the
 * server's updatedAt/matter.updatedAt strings verbatim. */
export interface UpdateMatterCoreRequest {
  expected_updated_at: string
  expected_matter_updated_at: string
  property_address?: string
  firm_reference?: string | null
  title?: string | null
}

export interface ManualPersonPayload {
  name: string
  /** Identifier value; optional. Type is carried by id_type so duplicate
   * warnings compare like types only. */
  id_number?: string | null
  id_type?: 'sa_id' | 'passport' | 'other' | null
  passport_country?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
}

export type AttachPartyRequest =
  | {
      client_request_id: string
      party_source: 'manual'
      entity_type: 'person'
      role: 'transferor' | 'transferee'
      acknowledged_duplicate?: boolean
      is_primary_contact?: boolean
      manual: ManualPersonPayload
    }
  | {
      client_request_id: string
      party_source: 'golden_record'
      entity_type: 'person' | 'company' | 'trust'
      role: 'transferor' | 'transferee'
      golden_record_id: string
      is_primary_contact?: boolean
    }

/** GET /api/v1/transfers/{id}/parties projection (camelCase, staff view). */
export interface TransferPartyApi {
  id: string
  transferId: string
  partySource: 'manual' | 'golden_record' | null
  goldenRecordId: string | null
  entityType: string | null
  role: string
  accountableInstitutionId: number | null
  cachedName?: string | null
  cachedIdNumber?: string | null
  cachedEmail?: string | null
  syncedAt?: string | null
  manualName?: string | null
  manualIdNumber?: string | null
  manualIdType?: 'sa_id' | 'passport' | 'other' | null
  manualPassportCountry?: string | null
  manualEmail?: string | null
  manualPhone?: string | null
  manualAddress?: string | null
  isPrimaryContact?: boolean
  clientRequestId?: string | null
  acknowledgedDuplicate?: boolean
}

/**
 * Build the v1 attach request for a form party, or a failure reason when the
 * party cannot be expressed in this slice (manual capture is person-only; a
 * Golden Record party must carry goldenRecordId).
 */
export function buildAttachPartyRequest(party: Party): AttachPartyRequest | { error: string } {
  const role = party.type === 'seller' ? 'transferor' : 'transferee'
  const clientRequestId = party.clientRequestId || crypto.randomUUID()

  if (party.source === 'golden_record') {
    if (!party.goldenRecordId) {
      return { error: 'Golden Record party has no record id' }
    }
    return {
      client_request_id: clientRequestId,
      party_source: 'golden_record',
      entity_type: (party.entityType || 'person') as 'person' | 'company' | 'trust',
      role,
      golden_record_id: party.goldenRecordId,
      is_primary_contact: Boolean(party.isPrimary)
    }
  }

  if (party.entityType && party.entityType !== 'person') {
    return { error: 'Manual capture currently supports natural persons only' }
  }

  return {
    client_request_id: clientRequestId,
    party_source: 'manual',
    entity_type: 'person',
    role,
    acknowledged_duplicate: Boolean(party.acknowledgedDuplicate),
    is_primary_contact: Boolean(party.isPrimary),
    manual: {
      name: party.name,
      id_number: party.idNumber || null,
      id_type: party.idType ?? null,
      passport_country: party.idType === 'passport' ? party.passportCountry || null : null,
      email: party.email || null,
      phone: party.phone || null,
      address: party.address || null
    }
  }
}

// ---- Matter–property API types ----

/** GET /api/v1/properties projection (camelCase, staff view). */
export interface PropertyRecordApi {
  id: string
  propertyId: string | null
  erfNumber: string | null
  streetAddress: string | null
  suburb: string | null
  city: string | null
  postalCode: string | null
  province: string | null
  country: string | null
  propertyType: string | null
  legalDescription: string | null
  yearBuilt: number | null
  squareFootage: number | null
  extentSqm: number | null
  status: string | null
  sourceSystem: string | null
  /** True only for institution-private manual capture — never verified. */
  manual: boolean
  accountableInstitutionId: number | null
  clientRequestId: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** GET/POST /api/v1/transfers/{id}/properties link projection. */
export interface MatterPropertyLinkApi {
  id: string
  matterId: string
  propertyId: string | null
  propertyKind: 'input' | 'output' | string
  registrationStatus: string | null
  roleInMatter: string | null
  externalPropertyId: string | null
  propertySource: string | null
  accountableInstitutionId: number | null
  clientRequestId: string | null
  createdAt: string | null
  updatedAt: string | null
  property: PropertyRecordApi | null
  /** Present on POST responses: false when the request replayed a stored link. */
  created?: boolean
}

/** Manual capture payload — institution-private and unverified. Area capture
 * (square_footage / extent_sqm) is deferred and not part of this contract. */
export interface ManualPropertyPayload {
  street_address: string
  suburb?: string | null
  city: string
  postal_code?: string | null
  province: string
  country?: string | null
  property_type: string
  erf_number?: string | null
  legal_description?: string | null
  year_built?: number | null
}

export type AttachMatterPropertyRequest =
  | { client_request_id: string; property_id: string }
  | { client_request_id: string; property: ManualPropertyPayload }

/** The nine property types permitted by the properties CHECK constraint. */
export const PROPERTY_TYPES = [
  'Freehold',
  'Sectional Title',
  'Share Block',
  'Life Rights',
  'Agricultural Holding',
  'Farm',
  'Commercial',
  'Mixed Use',
  'Vacant Land'
] as const

const SA_POSTAL_CODE = /^\d{4}$/

/**
 * Build the v1 capture+link request for the form's property details, or a
 * failure reason when they cannot be expressed. Manual capture is
 * institution-private and unverified; a supplied postal code must be a valid
 * four-digit SA value — malformed input fails here instead of being nulled.
 */
export function buildManualPropertyRequest(
  details: PropertyDetails,
  clientRequestId: string
): AttachMatterPropertyRequest | { error: string } {
  if (!details.address.trim() || !details.city.trim() || !details.state.trim()) {
    return { error: 'Street address, city and province are required' }
  }
  if (!details.propertyType) {
    return { error: 'Property type is required' }
  }
  if (!(PROPERTY_TYPES as readonly string[]).includes(details.propertyType)) {
    return { error: 'Property type is not a supported value' }
  }
  const postalCode = details.zipCode.trim()
  if (postalCode && !SA_POSTAL_CODE.test(postalCode)) {
    return { error: 'Postal code must be a four-digit South African value' }
  }
  const yearBuilt = details.yearBuilt.trim()
  const parsedYear = yearBuilt ? Number.parseInt(yearBuilt, 10) : null
  if (yearBuilt && (!Number.isInteger(parsedYear) || String(parsedYear) !== yearBuilt)) {
    return { error: 'Year built must be a whole number' }
  }
  return {
    client_request_id: clientRequestId,
    property: {
      street_address: details.address.trim(),
      city: details.city.trim(),
      province: details.state.trim(),
      postal_code: postalCode || null,
      property_type: details.propertyType,
      // "Erf number" writes only erf_number; legal description writes only
      // legal_description. No cross-mapping or dual-write fallbacks.
      erf_number: details.lotNumber.trim() || null,
      legal_description: details.legalDescription.trim() || null,
      year_built: parsedYear
    }
  }
}

/** Map a v1 party row back to the form model, preserving source and identity. */
export function transferPartyToFormParty(party: TransferPartyApi): Party {
  const isManual = party.partySource === 'manual'
  return {
    id: party.id,
    source: isManual ? 'manual' : 'golden_record',
    persistedPartyId: party.id,
    clientRequestId: party.clientRequestId || undefined,
    goldenRecordId: party.goldenRecordId || undefined,
    entityType: (party.entityType || undefined) as Party['entityType'],
    type: party.role === 'transferor' ? 'seller' : 'buyer',
    name: isManual ? party.manualName || '' : party.cachedName || '',
    idNumber: isManual ? party.manualIdNumber || '' : party.cachedIdNumber || '',
    email: isManual ? party.manualEmail || '' : party.cachedEmail || '',
    phone: party.manualPhone || '',
    address: party.manualAddress || '',
    isPrimary: party.isPrimaryContact ?? false,
    acknowledgedDuplicate: party.acknowledgedDuplicate ?? false
  }
}
