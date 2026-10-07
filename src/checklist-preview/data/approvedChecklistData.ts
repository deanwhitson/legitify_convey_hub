import rawData from './approvedChecklist.json'

// Approved checklist catalogue — generated verbatim from
// `Deedly-obligation-decisions.xlsx` (SHA-256
// C543935844CFD9AD20CDEC05EE539B3057834FF4D17006E033BBA20C8E5A107E),
// sheets `Document approvals`, `Current matrix` and `Checklist design`,
// all approved by Dean on 2026-10-06. This file is preview data for the
// local checklist preview only: it is not a runtime contract, a seed, or
// an implementation artifact, and it carries no legal verification.

export type ObligationLevel =
  | 'required'
  | 'conditional'
  | 'optional'
  | 'not_applicable'
  | 'outside_p0'

export interface TenureSplitLevel {
  kind: 'tenure_split'
  sectional: ObligationLevel
  freehold: ObligationLevel
  raw: string
}

export interface FlatLevel {
  kind: ObligationLevel
}

export type ClassificationLevel = FlatLevel | TenureSplitLevel

export interface ApprovedDocument {
  id: string
  name: string
  purposeGroup: string
  applicabilityRoute: string
  timing: string
  reviewLimits: string
  decisionStatus: string
  approvedBy: string
  approvalDate: string
  provenance: string
  signatureFlag: string
  levels: Record<string, ClassificationLevel>
}

export interface PurposeGroup {
  name: string
  documentIds: string[]
  displayNote: string
  stageNote: string
  evidenceNote: string
  viewsNote: string
}

export interface ApprovedChecklistData {
  sourceWorkbookSha256: string
  approvalsDate: string
  approver: string
  classifications: string[]
  groups: PurposeGroup[]
  documents: ApprovedDocument[]
}

export const CHECKLIST_DATA = rawData as ApprovedChecklistData

export const DOCUMENTS_BY_ID: ReadonlyMap<string, ApprovedDocument> = new Map(
  CHECKLIST_DATA.documents.map(d => [d.id, d])
)

export const CLASSIFICATION_LABELS: Record<string, string> = {
  'transfer.private_treaty.not_applicable': 'Private Treaty — Not Applicable',
  'transfer.private_treaty.sectional_title_register': 'Private Treaty — Sectional Title Register',
  'transfer.private_treaty.township_register': 'Private Treaty — Township Register',
  'transfer.private_treaty.extension_of_scheme': 'Private Treaty — Extension of Scheme',
  'transfer.private_treaty.subdivision': 'Private Treaty — Subdivision',
  'transfer.private_treaty.bulk_transfer': 'Private Treaty — Bulk Transfer',
  'transfer.auction': 'Auction',
  'transfer.sale_in_execution': 'Sale in Execution',
  'transfer.property_in_possession': 'Property in Possession',
  'transfer.deceased_estate_inheritance': 'Deceased Estate — Inheritance',
  'transfer.endorsement_section_45': 'Endorsement — Section 45',
  'transfer.donation': 'Donation',
}

// Documents deliberately not in any purpose group, per the approved
// checklist design: out-of-scope or N/A across all twelve codes.
export const UNGROUPED_DOCUMENT_IDS = CHECKLIST_DATA.documents
  .map(d => d.id)
  .filter(id => !CHECKLIST_DATA.groups.some(g => g.documentIds.includes(id)))
