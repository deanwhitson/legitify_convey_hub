import type {
  ApprovedChecklistData,
  ApprovedDocument,
  ClassificationLevel,
  ObligationLevel,
  TenureSplitLevel,
} from '../data/approvedChecklistData'

// ---------------------------------------------------------------------------
// Preview-only view model.
//
// This module is the proposed presentation boundary between an approved
// obligation ledger and a grouped checklist UI. The synthetic inputs below
// stand in for runtime fields that the production `MatterDocumentsResult`
// contract does not yet carry (obligation levels, purpose groups, due
// stages, applicability evaluations, reviewer acceptance). Nothing here
// evaluates rules: fixtures assert inputs explicitly and the mapper only
// projects them for display.
// ---------------------------------------------------------------------------

export type Tenure = 'freehold' | 'sectional_title' | 'unknown'

/** Illustrative evidence lifecycle — receipt is NOT reviewer acceptance. */
export type EvidenceState =
  | 'none'
  | 'uploaded_awaiting_review'
  | 'rejected'
  | 'accepted'

/**
 * Applicability after a synthetic fact check — independent from obligation
 * level. "Required" means required *where applicable*: a Required item whose
 * applicability fact is unrecorded or absent stays `unknown`, never assumed
 * applicable.
 * `conditional_pending_fact` is a conditional item whose trigger fact is not
 * yet recorded; `unknown` means applicability (or the level itself) could not
 * be resolved. Both stay visible and count as unresolved — neither implies
 * the obligation is cleared.
 */
export type ApplicabilityState =
  | 'applicable'
  | 'conditional_pending_fact'
  | 'conditional_trigger_unmet'
  | 'not_applicable'
  | 'unknown'

export type EvaluationState =
  | 'complete'
  | 'incomplete' // some facts unrecorded — unknowns stay visible
  | 'unavailable' // evaluation failed — nothing may imply zero obligations

export interface SyntheticEvidence {
  state: EvidenceState
  /** Illustrative reviewer note — never a legal determination. */
  note?: string
  /** Illustrative reviewer who accepted/rejected — evidence route only. */
  reviewedBy?: string
  /** Where the fixture claims reuse of existing evidence. */
  reuseOf?: string
}

export interface SyntheticFact {
  /** Whether the conditional trigger is met/unmet, or unrecorded. */
  trigger: 'met' | 'not_met' | 'unrecorded'
  note?: string
}

export interface ReviewerDetermination {
  determination: 'not_applicable' | 'required'
  reason: string
  determinedBy: string
}

export interface UnmappedDocument {
  id: string
  name: string
  state: EvidenceState
  note?: string
}

export interface ChecklistInput {
  scenarioId: string
  matterRef: string
  classificationCode: string | null
  tenure: Tenure
  evaluation: EvaluationState
  /** Synthetic fact store keyed by catalogue document id. */
  facts: Record<string, SyntheticFact>
  /** Synthetic evidence keyed by catalogue document id. */
  evidence: Record<string, SyntheticEvidence>
  /** Reviewer determinations (DT-07 route) keyed by catalogue document id. */
  reviewerDeterminations: Record<string, ReviewerDetermination>
  /** Documents the fixture claims have no catalogue mapping. */
  unmappedDocuments: UnmappedDocument[]
}

export interface ChecklistItem {
  catalogueId: string
  name: string
  /** Raw approved matrix cell for the fixture classification. */
  approvedLevel: ClassificationLevel | null
  /** Effective level after applying the tenure dimension, if split. */
  effectiveLevel: ObligationLevel | 'tenure_split_unresolved' | 'unknown'
  applicability: ApplicabilityState
  applicabilityNote?: string
  triggerWording: string
  dueStageWording: string
  evidence: EvidenceState
  evidenceNote?: string
  evidenceReviewedBy?: string
  evidenceReuseOf?: string
  reviewerDetermination?: ReviewerDetermination
  reviewLimitsWording: string
  signatureFlag: string
  decisionStatus: string
  provenance: string
  provisional: boolean
}

export interface ChecklistGroupView {
  name: string
  items: ChecklistItem[]
  displayNote: string
  stageNote: string
  evidenceNote: string
  viewsNote: string
  counts: GroupCounts
}

export interface GroupCounts {
  /** Confirmed-applicable mandatory items still lacking accepted evidence.
   *  Preview definition: effective level required or conditional, with
   *  applicability resolved to `applicable`, and no accepted evidence.
   *  Optional, not-applicable and unresolved items are never counted here. */
  outstanding: number
  /** Outstanding items whose evidence awaits reviewer acceptance. */
  pendingReview: number
  /** Items whose applicability or level cannot be shown as resolved
   *  (unknown applicability, unrecorded conditional triggers, unevaluated
   *  levels, unresolved tenure splits). Unresolved items are never cleared
   *  silently and never mean the checklist is complete. */
  unresolved: number
  /** Effective-optional items (separate from mandatory totals). */
  optional: number
}

export interface ChecklistViewModel {
  scenarioId: string
  matterRef: string
  classificationCode: string | null
  classificationLabel: string | null
  tenure: Tenure
  evaluation: EvaluationState
  unevaluatedReason?: string
  groups: ChecklistGroupView[]
  /** Overall counts deduplicated by catalogue id across groups. */
  overall: GroupCounts & { distinctDocuments: number }
  unmappedDocuments: UnmappedDocument[]
  /** Ledger rows excluded from grouping, explicitly accounted for. */
  ungroupedDocuments: { id: string; name: string; reason: string }[]
  sourceWorkbookSha256: string
}

export function isTenureSplit(
  level: ClassificationLevel | null | undefined
): level is TenureSplitLevel {
  return !!level && level.kind === 'tenure_split'
}

function effectiveLevel(
  level: ClassificationLevel | null,
  tenure: Tenure
): ChecklistItem['effectiveLevel'] {
  if (!level) return 'unknown'
  if (isTenureSplit(level)) {
    if (tenure === 'sectional_title') return level.sectional
    if (tenure === 'freehold') return level.freehold
    return 'tenure_split_unresolved'
  }
  return level.kind
}

function applicabilityFor(
  item: { eff: ChecklistItem['effectiveLevel']; docId: string },
  input: ChecklistInput
): { state: ApplicabilityState; note?: string } {
  const det = input.reviewerDeterminations[item.docId]
  if (det?.determination === 'not_applicable') {
    return { state: 'not_applicable', note: det.reason }
  }
  switch (item.eff) {
    case 'required': {
      // Required where applicable — applicability is never assumed. A
      // Required item only shows `applicable` when the fixture explicitly
      // confirms the fact; a missing or unrecorded fact stays `unknown`.
      const fact = input.facts[item.docId]
      if (!fact || fact.trigger === 'unrecorded') {
        return { state: 'unknown', note: 'Applicability not confirmed' }
      }
      if (fact.trigger === 'not_met') {
        return { state: 'not_applicable', note: fact.note }
      }
      return { state: 'applicable', note: fact.note }
    }
    case 'optional':
      return { state: 'applicable' }
    case 'not_applicable':
    case 'outside_p0':
      return { state: 'not_applicable' }
    case 'tenure_split_unresolved':
      return { state: 'unknown', note: 'Tenure not recorded' }
    case 'unknown':
      return { state: 'unknown', note: 'Obligation level not evaluated' }
    case 'conditional': {
      const fact = input.facts[item.docId]
      if (!fact || fact.trigger === 'unrecorded') {
        return { state: 'conditional_pending_fact', note: 'Trigger condition not recorded' }
      }
      if (fact.trigger === 'met') {
        return { state: 'applicable', note: fact.note }
      }
      return { state: 'conditional_trigger_unmet', note: fact.note }
    }
  }
}

function buildItem(
  doc: ApprovedDocument,
  input: ChecklistInput
): ChecklistItem {
  const approved = input.classificationCode
    ? doc.levels[input.classificationCode] ?? null
    : null
  const eff = input.evaluation === 'unavailable'
    ? 'unknown'
    : effectiveLevel(approved, input.tenure)
  const { state, note } = input.evaluation === 'unavailable'
    ? { state: 'unknown' as ApplicabilityState, note: 'Evaluation unavailable' }
    : applicabilityFor({ eff, docId: doc.id }, input)
  const evidence = input.evidence[doc.id]
  return {
    catalogueId: doc.id,
    name: doc.name,
    approvedLevel: approved,
    effectiveLevel: eff,
    applicability: state,
    applicabilityNote: note,
    triggerWording: doc.applicabilityRoute,
    dueStageWording: doc.timing,
    evidence: evidence?.state ?? 'none',
    evidenceNote: evidence?.note,
    evidenceReviewedBy: evidence?.reviewedBy,
    evidenceReuseOf: evidence?.reuseOf,
    reviewerDetermination: input.reviewerDeterminations[doc.id],
    reviewLimitsWording: doc.reviewLimits,
    signatureFlag: doc.signatureFlag,
    decisionStatus: doc.decisionStatus,
    provenance: doc.provenance,
    provisional: doc.id.startsWith('PROV-'),
  }
}

function countItems(items: ChecklistItem[]): GroupCounts {
  const c: GroupCounts = { outstanding: 0, pendingReview: 0, unresolved: 0, optional: 0 }
  for (const it of items) {
    if (it.effectiveLevel === 'optional') c.optional++
    const unresolved =
      it.applicability === 'unknown' ||
      it.applicability === 'conditional_pending_fact'
    if (unresolved) {
      c.unresolved++
      continue // unresolved items are never counted as outstanding or cleared
    }
    const mandatoryLevel =
      it.effectiveLevel === 'required' || it.effectiveLevel === 'conditional'
    if (
      mandatoryLevel &&
      it.applicability === 'applicable' &&
      it.evidence !== 'accepted'
    ) {
      c.outstanding++
      if (it.evidence === 'uploaded_awaiting_review') c.pendingReview++
    }
  }
  return c
}

export function buildChecklistViewModel(
  data: ApprovedChecklistData,
  input: ChecklistInput,
  classificationLabels: Record<string, string> = {}
): ChecklistViewModel {
  const groupedIds = new Set(data.groups.flatMap(g => g.documentIds))
  const allItems = new Map<string, ChecklistItem>()
  for (const doc of data.documents) {
    allItems.set(doc.id, buildItem(doc, input))
  }

  const groups: ChecklistGroupView[] = data.groups.map(g => {
    const items = g.documentIds
      .map(id => allItems.get(id))
      .filter((it): it is ChecklistItem => !!it)
    return {
      name: g.name,
      items,
      displayNote: g.displayNote,
      stageNote: g.stageNote,
      evidenceNote: g.evidenceNote,
      viewsNote: g.viewsNote,
      counts: countItems(items),
    }
  })

  // Overall counts deduplicated by stable catalogue id — a document listed in
  // multiple groups contributes to each group's counts but is counted once in
  // the matter total.
  const distinctItems = [...allItems.values()].filter(it =>
    groupedIds.has(it.catalogueId)
  )
  const overall = countItems(distinctItems)

  const ungroupedDocuments = data.documents
    .filter(d => !groupedIds.has(d.id))
    .map(d => ({
      id: d.id,
      name: d.name,
      reason:
        d.decisionStatus === 'Outside P0'
          ? 'Outside the approved 12-code P0 scope'
          : 'Not applicable on all twelve approved classifications',
    }))

  return {
    scenarioId: input.scenarioId,
    matterRef: input.matterRef,
    classificationCode: input.classificationCode,
    classificationLabel: input.classificationCode
      ? classificationLabels[input.classificationCode] ?? input.classificationCode
      : null,
    tenure: input.tenure,
    evaluation: input.evaluation,
    unevaluatedReason:
      input.evaluation === 'incomplete'
        ? 'Some trigger facts are not recorded — affected items show Unknown, not cleared.'
        : input.evaluation === 'unavailable'
          ? 'Checklist evaluation is unavailable — nothing shown may be read as satisfied.'
          : undefined,
    groups,
    overall: { ...overall, distinctDocuments: distinctItems.length },
    unmappedDocuments: input.unmappedDocuments,
    ungroupedDocuments,
    sourceWorkbookSha256: data.sourceWorkbookSha256,
  }
}
