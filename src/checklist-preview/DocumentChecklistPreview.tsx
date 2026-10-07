import { useMemo, useState } from 'react'
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileQuestion,
  Info,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import {
  CHECKLIST_DATA,
  CLASSIFICATION_LABELS,
} from './data/approvedChecklistData'
import {
  SCENARIOS,
  SCENARIOS_BY_ID,
  DEFAULT_SCENARIO_ID,
} from './data/checklistPreviewFixtures'
import {
  buildChecklistViewModel,
  isTenureSplit,
} from './model/checklistViewModel'
import type {
  ChecklistItem,
  ChecklistViewModel,
} from './model/checklistViewModel'

// ---------------------------------------------------------------------------
// Grouped document checklist preview — LOCAL ONLY.
// Read-only, fixture-driven, no API calls. Approved ledger content is shown
// verbatim; evidence/applicability states are synthetic and illustrative.
// Nothing on this page accepts, waives, uploads or transitions anything.
// ---------------------------------------------------------------------------

export type LevelFilter =
  | 'all'
  | 'required'
  | 'conditional'
  | 'optional'
  | 'not_applicable'
  | 'unknown'

export interface ItemFilter {
  level: LevelFilter
  stage: string
}

/**
 * Due-stage buckets used by the stage filter. The ledger records due stages
 * as prose; the filter buckets that prose approximately and each item still
 * displays its original wording. This is a presentation aid, not a stage
 * definition.
 */
export function stageBucket(timing: string): string {
  const t = timing.toLowerCase()
  if (t.includes('no p0 due stage')) return 'No P0 due stage'
  if (t.includes('cdd') || t.includes('identity/capacity'))
    return 'Identity / CDD'
  if (t.includes('levy clearance request')) return 'Before clearance request'
  if (t.includes('sars') || t.includes('duty')) return 'Before SARS / duty'
  if (t.includes('signing')) return 'At signing'
  if (t.includes('lodgement')) return 'Before lodgement'
  if (t.includes('transfer')) return 'Before transfer'
  return 'Other recorded wording'
}

export function filterItems(
  items: ChecklistItem[],
  filter: ItemFilter
): ChecklistItem[] {
  return items.filter(it => {
    if (filter.level !== 'all') {
      const lvl = it.effectiveLevel
      const bucket =
        lvl === 'unknown' || lvl === 'tenure_split_unresolved'
          ? 'unknown'
          : lvl === 'outside_p0'
            ? 'not_applicable'
            : lvl
      if (bucket !== filter.level) return false
    }
    if (filter.stage !== 'all' && stageBucket(it.dueStageWording) !== filter.stage)
      return false
    return true
  })
}

const LEVEL_LABEL: Record<string, string> = {
  required: 'Required',
  conditional: 'Conditional',
  optional: 'Optional',
  not_applicable: 'Not applicable',
  outside_p0: 'Outside P0',
  tenure_split_unresolved: 'Tenure-dependent',
  unknown: 'Unknown',
}

function levelBadgeVariant(level: ChecklistItem['effectiveLevel']) {
  switch (level) {
    case 'required':
      return 'error' as const
    case 'conditional':
      return 'warning' as const
    case 'optional':
      return 'primary' as const
    case 'not_applicable':
    case 'outside_p0':
      return 'secondary' as const
    default:
      return 'default' as const
  }
}

const APPLICABILITY_LABEL: Record<string, string> = {
  applicable: 'Applies',
  conditional_pending_fact: 'Trigger unrecorded',
  conditional_trigger_unmet: 'Trigger not met',
  not_applicable: 'Not applicable',
  unknown: 'Unknown',
}

const EVIDENCE_LABEL: Record<string, string> = {
  none: 'No evidence received',
  uploaded_awaiting_review: 'Received — awaiting review',
  rejected: 'Rejected',
  accepted: 'Accepted',
}

function evidenceBadgeVariant(state: ChecklistItem['evidence']) {
  switch (state) {
    case 'accepted':
      return 'success' as const
    case 'rejected':
      return 'error' as const
    case 'uploaded_awaiting_review':
      return 'warning' as const
    default:
      return 'secondary' as const
  }
}

function ItemRow({ item }: { item: ChecklistItem }) {
  const levelUnknown =
    item.effectiveLevel === 'unknown' ||
    item.effectiveLevel === 'tenure_split_unresolved'
  return (
    <li
      className="border-t border-gray-100 dark:border-gray-800 px-3 py-3 sm:px-4"
      data-doc-id={item.catalogueId}
      data-level={item.effectiveLevel}
      data-applicability={item.applicability}
      data-evidence={item.evidence}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">
            {item.name}
            <span className="ml-2 font-mono text-xs text-gray-500">
              {item.catalogueId}
            </span>
            {item.provisional && (
              <Badge variant="warning" size="sm" className="ml-2">
                Provisional ID
              </Badge>
            )}
          </p>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
            <span className="font-medium">Trigger/route:</span>{' '}
            {item.triggerWording}
          </p>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
            <span className="font-medium">Due:</span> {item.dueStageWording}
            <span className="ml-1 text-gray-400">
              ({stageBucket(item.dueStageWording)})
            </span>
          </p>
          {item.applicabilityNote && (
            <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
              <span className="font-medium">Applicability note:</span>{' '}
              {item.applicabilityNote}
            </p>
          )}
          {(item.evidenceNote || item.evidenceReuseOf || item.evidenceReviewedBy) && (
            <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
              <span className="font-medium">Evidence:</span>{' '}
              {item.evidenceReuseOf && <>{item.evidenceReuseOf}. </>}
              {item.evidenceNote}
              {item.evidenceReviewedBy && <> — {item.evidenceReviewedBy}</>}
            </p>
          )}
          {item.reviewerDetermination && (
            <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
              <span className="font-medium">Reviewer determination:</span>{' '}
              {item.reviewerDetermination.determination.replace(/_/g, ' ')} —{' '}
              {item.reviewerDetermination.reason} (
              {item.reviewerDetermination.determinedBy})
            </p>
          )}
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-500">
            <span className="font-medium">Review limits:</span>{' '}
            {item.reviewLimitsWording}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 sm:justify-end sm:text-right">
          <Badge
            variant={levelBadgeVariant(item.effectiveLevel)}
            size="sm"
            className={
              levelUnknown
                ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-300'
                : undefined
            }
          >
            {LEVEL_LABEL[item.effectiveLevel]}
            {isTenureSplit(item.approvedLevel) &&
              ` · ${item.approvedLevel.raw}`}
          </Badge>
          <Badge variant="secondary" size="sm">
            {APPLICABILITY_LABEL[item.applicability]}
          </Badge>
          <Badge variant={evidenceBadgeVariant(item.evidence)} size="sm">
            {EVIDENCE_LABEL[item.evidence]}
          </Badge>
          {item.signatureFlag !== 'No' && (
            <Badge variant="default" size="sm">
              Signature: {item.signatureFlag}
            </Badge>
          )}
        </div>
      </div>
    </li>
  )
}

function GroupSection({
  group,
  collapsed,
  onToggle,
  filter,
}: {
  group: ChecklistViewModel['groups'][number]
  collapsed: boolean
  onToggle: () => void
  filter: ItemFilter
}) {
  const visible = filterItems(group.items, filter)
  const regionId = `group-${group.name.replace(/[^a-z0-9]+/gi, '-')}`
  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-3 sm:px-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-lg"
        aria-expanded={!collapsed}
        aria-controls={regionId}
        onClick={onToggle}
      >
        <span className="flex items-center gap-2 min-w-0">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="font-medium text-gray-900 dark:text-gray-100 truncate">
            {group.name}
          </span>
          <span className="text-xs text-gray-500 shrink-0">
            {visible.length} of {group.items.length} shown
          </span>
        </span>
        <span className="flex flex-wrap gap-1.5 justify-end">
          <Badge variant="error" size="sm">
            {group.counts.outstanding} outstanding
          </Badge>
          <Badge variant="warning" size="sm">
            {group.counts.pendingReview} awaiting review
          </Badge>
          <Badge
            size="sm"
            className="bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-300"
          >
            {group.counts.unresolved} unresolved
          </Badge>
          <Badge variant="secondary" size="sm">
            {group.counts.optional} optional
          </Badge>
        </span>
      </button>
      {!collapsed && (
        <div id={regionId}>
          <p className="px-3 sm:px-4 pb-2 text-xs text-gray-500">
            {group.displayNote}
          </p>
          {visible.length === 0 ? (
            <p className="px-3 sm:px-4 pb-4 text-sm text-gray-500 italic">
              No items in this group match the current filters.
            </p>
          ) : (
            <ul className="divide-y-0">
              {visible.map(it => (
                <ItemRow key={it.catalogueId} item={it} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

export function ChecklistSummary({ model }: { model: ChecklistViewModel }) {
  return (
    <Card variant="premium" className="p-4 sm:p-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Matter {model.matterRef}
          </span>
          <Badge variant="primary" size="sm">
            {model.classificationLabel ?? 'Classification not recorded'}
          </Badge>
          <Badge variant="secondary" size="sm">
            Tenure:{' '}
            {model.tenure === 'sectional_title'
              ? 'Sectional Title'
              : model.tenure === 'freehold'
                ? 'Freehold'
                : 'Unknown'}
          </Badge>
        </div>
        {model.unevaluatedReason && (
          <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {model.unevaluatedReason}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div>
            <dt className="text-xs text-gray-500">Mandatory outstanding</dt>
            <dd className="text-2xl font-semibold text-red-600 dark:text-red-400">
              {model.overall.outstanding}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Awaiting review</dt>
            <dd className="text-2xl font-semibold text-yellow-600 dark:text-yellow-400">
              {model.overall.pendingReview}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Unresolved / unknown</dt>
            <dd className="text-2xl font-semibold text-purple-600 dark:text-purple-400">
              {model.overall.unresolved}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Optional (not counted)</dt>
            <dd className="text-2xl font-semibold text-blue-600 dark:text-blue-400">
              {model.overall.optional}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Distinct documents</dt>
            <dd className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {model.overall.distinctDocuments}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-gray-500">
          Preview definition: “outstanding” counts each catalogue document once,
          even if it appears in several groups, and covers only effective
          Required and Conditional items confirmed applicable that lack
          accepted evidence. Optional items are never counted. Items whose
          applicability is unresolved — unknown level, unresolved tenure split,
          unrecorded conditional trigger — are shown separately as unresolved
          and are never counted as satisfied.
        </p>
        {model.overall.unresolved > 0 && (
          <p className="rounded-md border border-purple-300 bg-purple-50 dark:bg-purple-900/20 dark:border-purple-700 px-3 py-2 text-xs text-purple-900 dark:text-purple-200">
            {model.overall.unresolved} item(s) have unresolved applicability —
            the checklist is not complete while these remain.
          </p>
        )}
      </div>
    </Card>
  )
}

export function DocumentChecklistPreviewPage() {
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO_ID)
  const [filter, setFilter] = useState<ItemFilter>({ level: 'all', stage: 'all' })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const input = SCENARIOS_BY_ID.get(scenarioId) ?? SCENARIOS[0]
  const model = useMemo(
    () => buildChecklistViewModel(CHECKLIST_DATA, input, CLASSIFICATION_LABELS),
    [input]
  )

  const stageOptions = useMemo(() => {
    const set = new Set<string>()
    for (const g of model.groups)
      for (const it of g.items) set.add(stageBucket(it.dueStageWording))
    return [...set].sort()
  }, [model])

  const setLevel = (level: LevelFilter) => setFilter(f => ({ ...f, level }))
  const setStage = (stage: string) => setFilter(f => ({ ...f, stage }))

  return (
    <main className="mx-auto max-w-5xl px-3 py-6 sm:px-6 space-y-4">
      <div className="rounded-lg border-2 border-blue-400 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-700 px-4 py-3">
        <p className="text-sm font-semibold text-blue-900 dark:text-blue-100">
          Document checklist preview — synthetic data, read-only
        </p>
        <p className="mt-1 text-xs text-blue-800 dark:text-blue-200">
          Local preview of the approved ten-group checklist design
          (DEEDLY-170). Obligation levels, groups, triggers, due stages, review
          limits and signature flags reproduce the approved 87-document ledger
          verbatim. Classification, tenure, trigger facts, evidence states and
          reviewer determinations are synthetic fixtures. A received document
          is not an accepted document; no approval, upload, waiver or workflow
          action is possible here.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex w-full min-w-0 items-center gap-2 text-sm text-gray-700 dark:text-gray-300 sm:w-auto">
          Scenario
          <select
            aria-label="Preview scenario"
            className="min-w-0 flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm"
            value={scenarioId}
            onChange={e => setScenarioId(e.target.value)}
          >
            {SCENARIOS.map(s => (
              <option key={s.scenarioId} value={s.scenarioId}>
                {s.matterRef} —{' '}
                {s.classificationCode
                  ? CLASSIFICATION_LABELS[s.classificationCode] ??
                    s.classificationCode
                  : 'unclassified'}{' '}
                · {s.tenure.replace(/_/g, ' ')}
                {s.evaluation !== 'complete' ? ` · ${s.evaluation}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-full min-w-0 items-center gap-2 text-sm text-gray-700 dark:text-gray-300 sm:w-auto">
          Level
          <select
            aria-label="Filter by obligation level"
            className="min-w-0 flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm"
            value={filter.level}
            onChange={e => setLevel(e.target.value as LevelFilter)}
          >
            <option value="all">All levels</option>
            <option value="required">Required</option>
            <option value="conditional">Conditional</option>
            <option value="optional">Optional</option>
            <option value="not_applicable">Not applicable</option>
            <option value="unknown">Unknown obligation level</option>
          </select>
        </label>
        <label className="flex w-full min-w-0 items-center gap-2 text-sm text-gray-700 dark:text-gray-300 sm:w-auto">
          Due stage
          <select
            aria-label="Filter by due stage"
            className="min-w-0 flex-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm"
            value={filter.stage}
            onChange={e => setStage(e.target.value)}
          >
            <option value="all">All stages</option>
            {stageOptions.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {(filter.level !== 'all' || filter.stage !== 'all') && (
          <button
            type="button"
            className="rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            onClick={() => setFilter({ level: 'all', stage: 'all' })}
          >
            Clear filters
          </button>
        )}
      </div>

      <ChecklistSummary model={model} />

      <div className="space-y-3">
        {model.groups.map(g => (
          <GroupSection
            key={g.name}
            group={g}
            collapsed={!!collapsed[g.name]}
            onToggle={() =>
              setCollapsed(c => ({ ...c, [g.name]: !c[g.name] }))
            }
            filter={filter}
          />
        ))}
      </div>

      {model.unmappedDocuments.length > 0 && (
        <section className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <FileQuestion className="h-4 w-4" aria-hidden="true" />
            Unmapped documents ({model.unmappedDocuments.length})
          </h2>
          <ul className="mt-2 space-y-1">
            {model.unmappedDocuments.map(d => (
              <li key={d.id} className="text-xs text-gray-600 dark:text-gray-400">
                <span className="font-mono">{d.id}</span> — {d.name}:{' '}
                {EVIDENCE_LABEL[d.state]}. {d.note}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Info className="h-4 w-4" aria-hidden="true" />
          Ledger rows excluded from the ten groups (
          {model.ungroupedDocuments.length})
        </h2>
        <ul className="mt-2 space-y-1">
          {model.ungroupedDocuments.map(d => (
            <li key={d.id} className="text-xs text-gray-600 dark:text-gray-400">
              <span className="font-mono">{d.id}</span> — {d.name}: {d.reason}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-gray-500">
          Source: approved obligation-decisions workbook, SHA-256{' '}
          <span className="font-mono break-all">
            {model.sourceWorkbookSha256}
          </span>
          . Levels and wording are approved content; applicability, evidence
          and reviewer states are illustrative only. Pending separately:
          PROV-LEVY-CERT permanent identifier (catalogue/engine mapping
          review) and its signature/formality requirement (evidence/formality
          review).
        </p>
      </section>
    </main>
  )
}
