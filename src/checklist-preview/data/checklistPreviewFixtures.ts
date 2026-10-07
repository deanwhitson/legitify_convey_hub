import { CHECKLIST_DATA } from './approvedChecklistData'
import {
  isTenureSplit,
  type ChecklistInput,
  type SyntheticFact,
  type Tenure,
} from '../model/checklistViewModel'

// ---------------------------------------------------------------------------
// Synthetic matter fixtures for the local checklist preview.
//
// Every value below is illustrative fixture input — classification, tenure,
// trigger facts, evidence states and reviewer determinations are asserted
// directly, never inferred by a rule evaluator. Evidence states demonstrate
// the received-vs-accepted distinction only; nothing here performs a real
// upload, review, waiver or transition.
// ---------------------------------------------------------------------------

const reviewer = 'Illustrative reviewer'

/**
 * Applicability is never assumed: every document whose effective level is
 * Required for the scenario's classification + tenure gets an explicit
 * `met` fact entry here. Scenario entries spread on top can then record
 * specific unrecorded/not-met facts. Required items with no fact entry at
 * all resolve to unknown applicability in the view model.
 */
function requiredFactsFor(
  classificationCode: string,
  tenure: Tenure
): Record<string, SyntheticFact> {
  const facts: Record<string, SyntheticFact> = {}
  for (const doc of CHECKLIST_DATA.documents) {
    const lvl = doc.levels[classificationCode]
    const eff = isTenureSplit(lvl)
      ? tenure === 'sectional_title'
        ? lvl.sectional
        : tenure === 'freehold'
          ? lvl.freehold
          : null
      : (lvl?.kind ?? null)
    if (eff === 'required') facts[doc.id] = { trigger: 'met' }
  }
  return facts
}

const baseEvidence = {
  'DOC-001': {
    state: 'uploaded_awaiting_review' as const,
    reuseOf: 'Existing Legitify Golden Record (illustrative link)',
    note: 'Identity evidence linked from an existing Golden Record. Currency, completeness and sufficiency review still pending — a link or questionnaire alone is not compliance.',
  },
  'DOC-033': {
    state: 'uploaded_awaiting_review' as const,
    reuseOf: 'Existing Legitify Golden Record (illustrative link)',
    note: 'FICA information proposed for reuse/link; reviewer must confirm currency and sufficiency before acceptance.',
  },
  'DOC-030': {
    state: 'rejected' as const,
    note: 'Signature missing — returned for re-execution.',
    reviewedBy: reviewer,
  },
  'DOC-036': {
    state: 'accepted' as const,
    note: 'TDC01 declaration reviewed and accepted.',
    reviewedBy: reviewer,
  },
  'DOC-048': {
    state: 'uploaded_awaiting_review' as const,
    reuseOf: 'Receipt on prior matter file (illustrative link)',
    note: 'Receipt proposed for reuse — permitted only after transaction-specific verification; verification pending.',
  },
}

const ptNaSectional: ChecklistInput = {
  scenarioId: 'pt-na-sectional',
  matterRef: 'SYNTH-PT-NA-ST',
  classificationCode: 'transfer.private_treaty.not_applicable',
  tenure: 'sectional_title',
  evaluation: 'complete',
  facts: {
    ...requiredFactsFor('transfer.private_treaty.not_applicable', 'sectional_title'),
    'PROV-LEVY-CERT': {
      trigger: 'met',
      note: 'Sectional unit; body-corporate levy clearance applies.',
    },
    'DOC-047': { trigger: 'unrecorded' },
  },
  evidence: {
    ...baseEvidence,
    'DOC-046': {
      state: 'uploaded_awaiting_review',
      note: 'Managing-agent confirmation received; body-corporate confirmation would also be acceptable where no agent exists. Awaiting reviewer acceptance.',
    },
  },
  reviewerDeterminations: {
    'DOC-014': {
      determination: 'not_applicable',
      reason: 'Natural-person seller — no entity or trust ownership/control verification required on this matter.',
      determinedBy: reviewer,
    },
  },
  unmappedDocuments: [
    {
      id: 'UPL-8831',
      name: 'Seller affidavit (freeform upload, no catalogue mapping)',
      state: 'uploaded_awaiting_review',
      note: 'Unmapped uploads remain visible but are never counted as satisfying an obligation.',
    },
  ],
}

const ptNaFreehold: ChecklistInput = {
  scenarioId: 'pt-na-freehold',
  matterRef: 'SYNTH-PT-NA-FH',
  classificationCode: 'transfer.private_treaty.not_applicable',
  tenure: 'freehold',
  evaluation: 'complete',
  facts: {
    ...requiredFactsFor('transfer.private_treaty.not_applicable', 'freehold'),
    'DOC-040': { trigger: 'unrecorded' },
    'DOC-046': {
      trigger: 'not_met',
      note: 'No body-corporate levy administration applies to this freehold erf.',
    },
    'PROV-LEVY-CERT': {
      trigger: 'not_met',
      note: 'Freehold property — sectional levy clearance trigger not met.',
    },
  },
  evidence: { ...baseEvidence },
  reviewerDeterminations: {},
  unmappedDocuments: [],
}

const ptSectionalRegister: ChecklistInput = {
  scenarioId: 'pt-sectional-register',
  matterRef: 'SYNTH-PT-STR-ST',
  classificationCode: 'transfer.private_treaty.sectional_title_register',
  tenure: 'sectional_title',
  evaluation: 'complete',
  facts: {
    ...requiredFactsFor('transfer.private_treaty.sectional_title_register', 'sectional_title'),
    'DOC-070': {
      trigger: 'met',
      note: 'Scheme rules / member or mortgagee approval needed for this scheme registration.',
    },
    'PROV-LEVY-CERT': {
      trigger: 'met',
      note: 'Sectional unit; body-corporate levy clearance applies.',
    },
  },
  evidence: {
    ...baseEvidence,
    'PROV-LEVY-CERT': {
      state: 'uploaded_awaiting_review',
      note: 'Additional certificate — not a DOC-046 rename. Signature/formality still undecided for the new document.',
    },
  },
  reviewerDeterminations: {},
  unmappedDocuments: [],
}

const bulkSectional: ChecklistInput = {
  scenarioId: 'bulk-sectional',
  matterRef: 'SYNTH-PT-BULK-ST',
  classificationCode: 'transfer.private_treaty.bulk_transfer',
  tenure: 'sectional_title',
  evaluation: 'complete',
  facts: {
    ...requiredFactsFor('transfer.private_treaty.bulk_transfer', 'sectional_title'),
  },
  evidence: { ...baseEvidence },
  reviewerDeterminations: {},
  unmappedDocuments: [],
}

const saleInExecutionFreehold: ChecklistInput = {
  scenarioId: 'sie-freehold',
  matterRef: 'SYNTH-SIE-FH',
  classificationCode: 'transfer.sale_in_execution',
  tenure: 'freehold',
  evaluation: 'complete',
  facts: {
    ...requiredFactsFor('transfer.sale_in_execution', 'freehold'),
    'PROV-LEVY-CERT': {
      trigger: 'not_met',
      note: 'Freehold property — sectional levy clearance trigger not met.',
    },
  },
  evidence: {
    'DOC-029': { state: 'uploaded_awaiting_review', note: 'Court order received; sufficiency of the current court-rule form is a review dependency, not yet verified.' },
    'DOC-084': { state: 'uploaded_awaiting_review', note: 'Sheriff pack received — awaiting review.' },
  },
  reviewerDeterminations: {},
  unmappedDocuments: [],
}

const evaluationIncomplete: ChecklistInput = {
  scenarioId: 'evaluation-incomplete',
  matterRef: 'SYNTH-INC-ST',
  classificationCode: 'transfer.private_treaty.not_applicable',
  tenure: 'sectional_title',
  evaluation: 'incomplete',
  facts: {
    // Required stays an obligation level; its applicability is unconfirmed
    // while the fixture records no fact.
    'DOC-030': { trigger: 'unrecorded' },
  },
  evidence: {},
  reviewerDeterminations: {},
  unmappedDocuments: [],
}

const evaluationUnavailable: ChecklistInput = {
  scenarioId: 'evaluation-unavailable',
  matterRef: 'SYNTH-UNAVAIL',
  classificationCode: 'transfer.private_treaty.not_applicable',
  tenure: 'sectional_title',
  evaluation: 'unavailable',
  facts: {},
  evidence: {},
  reviewerDeterminations: {},
  unmappedDocuments: [],
}

const unclassified: ChecklistInput = {
  scenarioId: 'unclassified',
  matterRef: 'SYNTH-NO-CLASS',
  classificationCode: null,
  tenure: 'unknown',
  evaluation: 'incomplete',
  facts: {},
  evidence: {},
  reviewerDeterminations: {},
  unmappedDocuments: [],
}

export const SCENARIOS: ChecklistInput[] = [
  ptNaSectional,
  ptNaFreehold,
  ptSectionalRegister,
  bulkSectional,
  saleInExecutionFreehold,
  evaluationIncomplete,
  evaluationUnavailable,
  unclassified,
]

export const SCENARIOS_BY_ID = new Map(SCENARIOS.map(s => [s.scenarioId, s]))

export const DEFAULT_SCENARIO_ID = ptNaSectional.scenarioId
