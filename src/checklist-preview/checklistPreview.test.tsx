import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CHECKLIST_DATA,
  CLASSIFICATION_LABELS,
  DOCUMENTS_BY_ID,
  UNGROUPED_DOCUMENT_IDS,
} from './data/approvedChecklistData'
import {
  buildChecklistViewModel,
  isTenureSplit,
} from './model/checklistViewModel'
import {
  DocumentChecklistPreviewPage,
  filterItems,
  stageBucket,
} from './DocumentChecklistPreview'
import { SCENARIOS_BY_ID } from './data/checklistPreviewFixtures'

const PT_NA = 'transfer.private_treaty.not_applicable'
const PT_STR = 'transfer.private_treaty.sectional_title_register'
const PT_EOS = 'transfer.private_treaty.extension_of_scheme'
const PT_TWNSHP = 'transfer.private_treaty.township_register'
const PT_SUB = 'transfer.private_treaty.subdivision'
const PT_BULK = 'transfer.private_treaty.bulk_transfer'

function modelFor(scenarioId: string) {
  const input = SCENARIOS_BY_ID.get(scenarioId)
  assert.ok(input, `fixture ${scenarioId} exists`)
  return buildChecklistViewModel(CHECKLIST_DATA, input, CLASSIFICATION_LABELS)
}

function itemIn(model: ReturnType<typeof modelFor>, docId: string) {
  for (const g of model.groups) {
    const hit = g.items.find(i => i.catalogueId === docId)
    if (hit) return hit
  }
  assert.fail(`${docId} not found in any group`)
}

describe('approved ledger coverage', () => {
  it('carries all 87 ledger rows, 10 groups and 12 classifications', () => {
    assert.equal(CHECKLIST_DATA.documents.length, 87)
    assert.equal(CHECKLIST_DATA.groups.length, 10)
    assert.equal(CHECKLIST_DATA.classifications.length, 12)
    for (const doc of CHECKLIST_DATA.documents) {
      assert.equal(Object.keys(doc.levels).length, 12, `${doc.id} levels`)
      assert.equal(doc.approvedBy, 'Dean')
      assert.equal(doc.approvalDate, '2026-10-06')
      assert.ok(doc.signatureFlag.length > 0, `${doc.id} signature flag`)
    }
  })

  it('groups cover 81 documents and the 6 excluded rows are accounted for', () => {
    const grouped = new Set(CHECKLIST_DATA.groups.flatMap(g => g.documentIds))
    assert.equal(grouped.size, 81)
    for (const id of grouped) {
      assert.ok(DOCUMENTS_BY_ID.has(id), `${id} resolves to a catalogue record`)
    }
    assert.deepEqual(
      [...UNGROUPED_DOCUMENT_IDS].sort(),
      ['DOC-039', 'DOC-067', 'DOC-068', 'DOC-076', 'DOC-077', 'DOC-086']
    )
    const model = modelFor('pt-na-sectional')
    assert.equal(model.ungroupedDocuments.length, 6)
    for (const u of model.ungroupedDocuments) assert.ok(u.reason.length > 0)
  })

  it('preserves the approved ten group names and order', () => {
    assert.deepEqual(
      CHECKLIST_DATA.groups.map(g => g.name),
      [
        'Identity and FICA',
        'Marriage and consent',
        'Sale and finance',
        'Estate and inheritance',
        'Clearances and compliance',
        'Tax and payments',
        'Property and transfer',
        'Development related',
        'Auction and execution',
        'Bulk transfer and registration',
      ]
    )
  })
})

describe('representative approved distinctions', () => {
  it('DOC-040: flat Required on two variants, tenure split elsewhere', () => {
    const doc = DOCUMENTS_BY_ID.get('DOC-040')!
    assert.equal(doc.levels[PT_STR].kind, 'required')
    assert.equal(doc.levels[PT_EOS].kind, 'required')
    const others = CHECKLIST_DATA.classifications.filter(
      c => c !== PT_STR && c !== PT_EOS
    )
    assert.equal(others.length, 10)
    for (const c of others) {
      const lvl = doc.levels[c]
      assert.ok(isTenureSplit(lvl), `${c} is tenure split`)
      assert.equal(lvl.sectional, 'required')
      assert.equal(lvl.freehold, 'conditional')
    }
  })

  it('DOC-070: Conditional on the two register-linked variants, N/A elsewhere', () => {
    const doc = DOCUMENTS_BY_ID.get('DOC-070')!
    assert.equal(doc.levels[PT_STR].kind, 'conditional')
    assert.equal(doc.levels[PT_EOS].kind, 'conditional')
    for (const c of CHECKLIST_DATA.classifications) {
      if (c === PT_STR || c === PT_EOS) continue
      assert.equal(doc.levels[c].kind, 'not_applicable', c)
    }
  })

  it('PROV-LEVY-CERT keeps provisional id, exact signature flag and mapping', () => {
    const doc = DOCUMENTS_BY_ID.get('PROV-LEVY-CERT')!
    assert.equal(doc.signatureFlag, 'Undecided for new document')
    assert.equal(doc.levels[PT_STR].kind, 'required')
    assert.equal(doc.levels[PT_TWNSHP].kind, 'not_applicable')
    assert.equal(doc.levels[PT_EOS].kind, 'not_applicable')
    assert.equal(doc.levels[PT_SUB].kind, 'not_applicable')
    assert.equal(doc.levels[PT_BULK].kind, 'optional')
    const conditional = CHECKLIST_DATA.classifications.filter(
      c => doc.levels[c].kind === 'conditional'
    )
    assert.equal(conditional.length, 7)
    assert.ok(conditional.includes(PT_NA))
  })

  it('preserves reuse and acceptance-route wording for DOC-001/033/048/046', () => {
    assert.match(DOCUMENTS_BY_ID.get('DOC-001')!.applicabilityRoute, /Golden Records.*reuse\/link/i)
    assert.match(DOCUMENTS_BY_ID.get('DOC-033')!.applicabilityRoute, /Golden Records/i)
    assert.match(DOCUMENTS_BY_ID.get('DOC-048')!.applicabilityRoute, /transaction/i)
    assert.match(DOCUMENTS_BY_ID.get('DOC-046')!.applicabilityRoute, /[Mm]anaging-agent/)
    assert.match(DOCUMENTS_BY_ID.get('DOC-046')!.applicabilityRoute, /body-corporate|body corporate/i)
  })
})

describe('view model', () => {
  it('resolves the separate tenure dimension without changing approved levels', () => {
    const sectional = itemIn(modelFor('pt-na-sectional'), 'DOC-040')
    assert.equal(sectional.effectiveLevel, 'required')
    const freehold = itemIn(modelFor('pt-na-freehold'), 'DOC-040')
    assert.equal(freehold.effectiveLevel, 'conditional')
    assert.ok(isTenureSplit(freehold.approvedLevel))
  })

  it('keeps obligation, applicability and evidence as separate concepts', () => {
    const model = modelFor('pt-na-sectional')
    const d46 = itemIn(model, 'DOC-046')
    assert.equal(d46.effectiveLevel, 'required')
    assert.equal(d46.applicability, 'applicable')
    assert.equal(d46.evidence, 'uploaded_awaiting_review')
    const d30 = itemIn(model, 'DOC-030')
    assert.equal(d30.evidence, 'rejected')
    assert.equal(d30.applicability, 'applicable')
    const d36 = itemIn(model, 'DOC-036')
    assert.equal(d36.evidence, 'accepted')
  })

  it('records conditional triggers distinctly: met, unmet, unrecorded', () => {
    const model = modelFor('pt-na-sectional')
    const cert = itemIn(model, 'PROV-LEVY-CERT')
    assert.equal(cert.effectiveLevel, 'conditional')
    assert.equal(cert.applicability, 'applicable')
    const pending = itemIn(model, 'DOC-047')
    assert.equal(pending.applicability, 'conditional_pending_fact')
    const freehold = modelFor('pt-na-freehold')
    const unmet = itemIn(freehold, 'DOC-046')
    assert.equal(unmet.applicability, 'conditional_trigger_unmet')
  })

  it('honours reviewer not-applicable determinations without losing the level', () => {
    const item = itemIn(modelFor('pt-na-sectional'), 'DOC-014')
    assert.equal(item.applicability, 'not_applicable')
    assert.match(item.reviewerDetermination!.reason, /Natural-person/)
  })

  it('deduplicates overall counts by catalogue id across groups', () => {
    const model = modelFor('pt-na-sectional')
    // Every grouped document contributes once even if a group listed it twice.
    const raw = model.groups.reduce((n, g) => n + g.items.length, 0)
    assert.equal(model.overall.distinctDocuments, 81)
    assert.ok(raw >= model.overall.distinctDocuments)
    // Synthetic duplicate membership: same doc in two groups counts once.
    const clone = JSON.parse(JSON.stringify(CHECKLIST_DATA))
    clone.groups[1].documentIds.push('DOC-001')
    const m2 = buildChecklistViewModel(
      clone,
      SCENARIOS_BY_ID.get('pt-na-sectional')!,
      CLASSIFICATION_LABELS
    )
    const g0 = m2.groups[0].items.find(i => i.catalogueId === 'DOC-001')!
    const g1 = m2.groups[1].items.find(i => i.catalogueId === 'DOC-001')!
    assert.equal(g0.evidence, g1.evidence)
    assert.equal(g0.effectiveLevel, g1.effectiveLevel)
    assert.equal(m2.overall.outstanding, model.overall.outstanding)
  })

  it('keeps unknown and unavailable states visible, never cleared', () => {
    const unavailable = modelFor('evaluation-unavailable')
    assert.ok(unavailable.unevaluatedReason)
    for (const g of unavailable.groups)
      for (const it of g.items) {
        assert.equal(it.effectiveLevel, 'unknown')
        assert.equal(it.applicability, 'unknown')
      }
    // Nothing is confirmed applicable: zero outstanding, everything unresolved.
    assert.equal(unavailable.overall.outstanding, 0)
    assert.equal(unavailable.overall.unresolved, 81)

    const unclassified = modelFor('unclassified')
    assert.equal(unclassified.classificationLabel, null)
    assert.equal(unclassified.overall.outstanding, 0)
    assert.equal(unclassified.overall.unresolved, 81)

    const incomplete = modelFor('evaluation-incomplete')
    assert.ok(incomplete.unevaluatedReason)
  })

  it('Required stays an obligation level while applicability is unknown', () => {
    const item = itemIn(modelFor('evaluation-incomplete'), 'DOC-030')
    assert.equal(item.effectiveLevel, 'required')
    assert.equal(item.applicability, 'unknown')
    // Not confirmed applicable → not outstanding, but never cleared.
    assert.equal(item.evidence, 'none')
    const model = modelFor('evaluation-incomplete')
    const unresolvedIds = model.groups
      .flatMap(g => g.items)
      .filter(
        i =>
          i.applicability === 'unknown' ||
          i.applicability === 'conditional_pending_fact'
      )
      .map(i => i.catalogueId)
    assert.ok(unresolvedIds.includes('DOC-030'))
  })

  it('a Required item with no fact at all is unresolved, not outstanding', () => {
    // Same semantics whether the fact is explicitly 'unrecorded' or absent.
    const input = {
      ...SCENARIOS_BY_ID.get('pt-na-sectional')!,
      facts: { ...SCENARIOS_BY_ID.get('pt-na-sectional')!.facts },
    }
    delete input.facts['DOC-030']
    const model = buildChecklistViewModel(CHECKLIST_DATA, input, CLASSIFICATION_LABELS)
    const item = itemIn(model, 'DOC-030')
    assert.equal(item.effectiveLevel, 'required')
    assert.equal(item.applicability, 'unknown')
    // Not in mandatory outstanding even though it is Required and has
    // rejected (not accepted) evidence.
    const outstandingIds = new Set<string>()
    for (const g of model.groups)
      for (const it of g.items)
        if (
          (it.effectiveLevel === 'required' || it.effectiveLevel === 'conditional') &&
          it.applicability === 'applicable' &&
          it.evidence !== 'accepted'
        )
          outstandingIds.add(it.catalogueId)
    assert.ok(!outstandingIds.has('DOC-030'))
    assert.equal(model.overall.outstanding, outstandingIds.size)
    assert.ok(model.overall.unresolved > 0)
  })

  it('explicit met/unmet Required facts resolve to applicable / N/A', () => {
    const model = modelFor('pt-na-sectional')
    const met = itemIn(model, 'DOC-030') // fact met, evidence rejected
    assert.equal(met.effectiveLevel, 'required')
    assert.equal(met.applicability, 'applicable')
    const input = {
      ...SCENARIOS_BY_ID.get('pt-na-sectional')!,
      facts: {
        ...SCENARIOS_BY_ID.get('pt-na-sectional')!.facts,
        'DOC-030': { trigger: 'not_met' as const, note: 'Fixture: no transfer action needed' },
      },
    }
    const m2 = buildChecklistViewModel(CHECKLIST_DATA, input, CLASSIFICATION_LABELS)
    const unmet = itemIn(m2, 'DOC-030')
    assert.equal(unmet.effectiveLevel, 'required')
    assert.equal(unmet.applicability, 'not_applicable')
  })

  it('unrecorded Conditional triggers are unresolved, not outstanding', () => {
    const model = modelFor('pt-na-sectional')
    const pending = itemIn(model, 'DOC-047')
    assert.equal(pending.effectiveLevel, 'conditional')
    assert.equal(pending.applicability, 'conditional_pending_fact')
    // Outstanding covers only confirmed-applicable mandatory items.
    const outstandingIds = new Set<string>()
    for (const g of model.groups)
      for (const it of g.items)
        if (
          (it.effectiveLevel === 'required' || it.effectiveLevel === 'conditional') &&
          it.applicability === 'applicable' &&
          it.evidence !== 'accepted'
        )
          outstandingIds.add(it.catalogueId)
    assert.equal(outstandingIds.size, model.overall.outstanding)
    assert.ok(!outstandingIds.has('DOC-047'))
    assert.ok(!outstandingIds.has('DOC-030') || itemIn(model, 'DOC-030').applicability === 'applicable')
    // Unresolved items keep the checklist visibly incomplete.
    assert.ok(model.overall.unresolved > 0)
  })

  it('surfaces unmapped documents without counting them', () => {
    const model = modelFor('pt-na-sectional')
    assert.equal(model.unmappedDocuments.length, 1)
    assert.equal(model.unmappedDocuments[0].id, 'UPL-8831')
    const other = modelFor('pt-na-freehold')
    assert.equal(other.unmappedDocuments.length, 0)
    // The unmapped upload cannot offset the outstanding total.
    assert.ok(model.overall.outstanding > 0)
  })
})

describe('filters', () => {
  const model = modelFor('pt-na-sectional')
  const all = model.groups.flatMap(g => g.items)

  it('filters by effective obligation level', () => {
    const required = filterItems(all, { level: 'required', stage: 'all' })
    assert.ok(required.length > 0)
    for (const it of required) assert.equal(it.effectiveLevel, 'required')
    const unknown = filterItems(all, { level: 'unknown', stage: 'all' })
    assert.equal(unknown.length, 0) // obligation levels are known; applicability remains a separate dimension
    const unav = modelFor('evaluation-unavailable')
    const unavItems = unav.groups.flatMap(g => g.items)
    assert.equal(
      filterItems(unavItems, { level: 'unknown', stage: 'all' }).length,
      unavItems.length
    )
  })

  it('filters by due-stage bucket while preserving original wording', () => {
    const lodgement = filterItems(all, {
      level: 'all',
      stage: 'Before lodgement',
    })
    assert.ok(lodgement.length > 0)
    for (const it of lodgement)
      assert.equal(stageBucket(it.dueStageWording), 'Before lodgement')
    const cdd = filterItems(all, { level: 'all', stage: 'Identity / CDD' })
    assert.ok(cdd.some(i => i.catalogueId === 'DOC-001'))
  })

  it('combines level and stage filters', () => {
    const combined = filterItems(all, {
      level: 'required',
      stage: 'Before lodgement',
    })
    for (const it of combined) {
      assert.equal(it.effectiveLevel, 'required')
      assert.equal(stageBucket(it.dueStageWording), 'Before lodgement')
    }
  })
})

describe('preview page render', () => {
  it('labels itself as a synthetic read-only preview and renders all groups', () => {
    const html = renderToStaticMarkup(<DocumentChecklistPreviewPage />)
    assert.match(html, /synthetic data, read-only/i)
    assert.match(html, /Unknown obligation level/)
    for (const g of CHECKLIST_DATA.groups) {
      assert.ok(html.includes(g.name), g.name)
    }
    // Keyboard-accessible group toggles: real buttons with aria-expanded.
    assert.match(html, /aria-expanded="true"/)
    // Native selects for scenario and both filters.
    assert.match(html, />All levels</)
    assert.match(html, />All stages</)
    // Never an action control.
    assert.doesNotMatch(html, /type="submit"/)
  })

  it('renders the outstanding definition and excluded-row accounting', () => {
    const html = renderToStaticMarkup(<DocumentChecklistPreviewPage />)
    assert.match(html, /Mandatory outstanding/)
    assert.match(html, /Optional \(not counted\)/)
    assert.match(html, /Ledger rows excluded/)
    assert.match(html, /Unmapped documents/)
    assert.match(html, /Undecided for new document/)
    assert.match(html, /not complete while these remain/)
  })
})
