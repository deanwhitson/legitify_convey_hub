# Document checklist preview — integration gap report and local preview

**Status:** local-only review artifact on `codex/document-checklist-preview`.
**Scope:** read-only, offline, attorney-facing preview of the approved
ten-group checklist design (DEEDLY-170) plus the gap between the approved
design and the current `MatterDocumentsResult` contract.
**Authority:** approved workbook `Deedly-obligation-decisions.xlsx`
(SHA-256 `C543935844CFD9AD20CDEC05EE539B3057834FF4D17006E033BBA20C8E5A107E`,
approvals by Dean 2026-10-06) and the consolidated docs on
`docs/deedly-170-obligation-matrix` (`ff53eb7`) /
`docs/deedly-170-workflow-approval-pack` (`a5364d2`).

Nothing in this branch changes production navigation, authentication, API
contracts, deployed output or runtime behavior. The preview makes **no API
calls** and loads **no external assets**; screenshot checks assert zero
non-localhost requests.

## 1. Gap matrix — approved design vs existing contract

Cited fields are real: `src/lib/api/matterDocuments.ts` (`MatterDocument`,
`DocumentRequirement`, `MatterDocumentsResult`) and
`src/components/transfers/MatterDocumentsSection.tsx`.

| Approved checklist-design field | Existing code/API field | Status |
|---|---|---|
| Stable document identity (catalogue id) | `DocumentRequirement.requirementKey`, `MatterDocument.catalogueDocumentId` | **Requires approved mapping.** Keys exist but no approved mapping from keys to the 87-row ledger is established; catalogue IDs must not be inferred from `displayName`. |
| Display name | `DocumentRequirement.displayName` | **Existing** (display only). |
| Obligation level per classification (Required/Conditional/Optional/N/A/Outside P0 × 12 codes) | none — `source: 'baseline' \| 'conditional'` is a provenance flag, **not** an obligation level | **Missing; requires separately approved mapping.** `baseline` must not be read as Required. |
| Tenure dimension (separate from classification; drives DOC-020/040/046 splits) | none | **Missing; requires approved mapping.** Fixture inputs tenure explicitly. |
| Purpose-group membership (10 approved groups; 81 grouped + 6 excluded ledger rows) | none | **Missing.** Preview derives groups from the approved ledger only. |
| Applicability trigger wording | `DocumentRequirement.conditionKey` (opaque key only) | **Missing as wording; requires approved mapping** from condition keys to approved trigger text and to fact keys (DT-05 approvals still open). |
| Due-stage wording | none | **Missing.** Approved timing prose is reproduced verbatim in fixtures; executable stage gates are **not** authorised by the docs. |
| Evidence received/uploaded | `MatterDocument.status: 'pending' \| 'uploaded' \| ...` | **Existing** — receipt only; never acceptance. |
| Evidence accepted (reviewer acceptance) | `status: 'verified'` — but no reviewer identity, route or acceptance metadata | **Partially existing; acceptance semantics require approved mapping.** Upload and `scanStatus: 'clean'` are not acceptance. |
| Evidence rejected | `status: 'rejected'` | **Existing** (display state). |
| Scan cleanliness | `MatterDocument.scanStatus` | **Existing** — orthogonal to obligation and acceptance. |
| Unevaluated facts / rules surfaced | `unevaluatedFacts: string[]`, `unevaluatedRules: UnevaluatedRule[]` | **Existing.** Preview mirrors this as the `incomplete` evaluation state. |
| Unmapped uploads visible, never counted | documents without `requirementKey` linkage | **Partially existing** in the contract; preview keeps them in a dedicated non-counted section. |
| Reviewer determination route (DT-07) | none | **Missing; requires approved mapping.** Fixture asserts determinations explicitly. |
| Signature flags, provenance, review-limit wording | none | **Missing** — ledger content only. |
| Golden Records reuse/link route (DOC-001/033/048) | none | **Missing; requires approved mapping.** Reuse is review-gated; a link is not acceptance. |
| Rule/fact evaluation engine | none | **Not built — intentionally.** Requires approved fact keys, machine mapping, authority/backfill/schema artifacts. |
| PROV-LEVY-CERT permanent identifier + signature/formality | none | **Two separate pending reviews:** identifier → catalogue/engine generation-numbering mapping review; signature flag `Undecided for new document` → separate evidence/formality review. |

Approved wording (levels, triggers, timing, review limits, signature flags)
is reproduced verbatim in `src/checklist-preview/data/approvedChecklist.json`,
generated from the workbook. Executable semantics — how a fact key flips a
conditional item, who may mark acceptance, when a stage gate blocks — remain
unresolved by design and are represented only as explicit synthetic inputs.

## 2. Proposed view model and mapper boundary

`src/checklist-preview/model/checklistViewModel.ts` defines the
presentation boundary:

- **Input** (`ChecklistInput`): matter ref, classification code, tenure,
  evaluation state (`complete | incomplete | unavailable`), synthetic fact
  store, synthetic evidence map, reviewer determinations, unmapped uploads.
- **Item** (`ChecklistItem`): one record per stable catalogue id, carrying —
  as separate concepts — approved level for the classification, effective
  level after the tenure split, applicability state, trigger wording,
  due-stage wording, evidence state, reviewer determination, review limits,
  signature flag and provenance.
- **Obligation level and applicability are independent dimensions,** including
  for Required items: "Required" means required *where applicable*, so a
  Required item whose applicability fact is unrecorded or absent shows
  `unknown` applicability rather than being assumed applicable. Fixtures mark
  every confirmed-applicable item explicitly (`requiredFactsFor` emits a `met`
  fact for each effective-Required document); the mapper never infers
  applicability from level.
- **Groups**: items are projected into the ten approved groups by reference;
  a document listed in multiple groups is the same underlying record, and
  overall counts deduplicate by catalogue id.
- **Unknowns**: `unknown`, `tenure_split_unresolved` and
  `conditional_pending_fact` are first-class visible states; `unavailable`
  marks every item unresolved rather than empty.
- **Outstanding (preview definition):** only confirmed-applicable mandatory
  items — effective Required or Conditional with applicability resolved to
  `applicable` — that lack accepted evidence. Optional, not-applicable and
  unresolved items never count; unresolved items are totalled separately and
  the UI states the checklist is not complete while any remain.

The mapper performs **no rule evaluation** — fixtures assert facts and the
mapper projects them. There is no seed file, no evaluator, no persistence.

## 3. Changed files

- `checklist-preview.html` — separate preview entry page.
- `vite.config.preview.ts` — isolated preview config (own `dist-preview`
  output, no `/api` proxy, port 5174).
- `src/checklist-preview/data/approvedChecklist.json` — approved ledger,
  matrix and group data generated verbatim from the workbook (87 rows,
  12 codes, 10 groups).
- `src/checklist-preview/data/approvedChecklistData.ts` — typed wrapper +
  catalogue lookups and classification labels.
- `src/checklist-preview/data/checklistPreviewFixtures.ts` — eight synthetic
  matter scenarios (see below).
- `src/checklist-preview/model/checklistViewModel.ts` — view-model types and
  mapper.
- `src/checklist-preview/DocumentChecklistPreview.tsx` — read-only preview UI
  reusing `Badge`, `Card` and `cn`; native `select`/`button` controls keep
  toggles and filters keyboard-accessible; layout stacks under `sm`.
- `src/checklist-preview/main.tsx` — preview bootstrap (imports app CSS).
- `src/checklist-preview/checklistPreview.test.tsx` — 23 offline tests.
- `scripts/checklist-preview-screenshot.mjs` — screenshot + external-request
  guard.
- `tsconfig.node.json`, `.gitignore` — additive: cover the preview config in
  typecheck; ignore `dist-preview/`.
- `docs/preview-screenshots/` — captured screenshots.

### Scenarios

| Scenario | Demonstrates |
|---|---|
| `pt-na-sectional` | PT-N/A + sectional tenure → DOC-040 Required via split; DOC-001/033 Golden Records reuse awaiting sufficiency review; DOC-046 managing-agent route; DOC-048 transaction-verified reuse pending; DOC-070 N/A; rejected + accepted + awaiting-review states; unmapped upload. |
| `pt-na-freehold` | Same classification, freehold → DOC-040 Conditional; DOC-046 trigger-not-met; PROV-LEVY-CERT trigger not met. |
| `pt-sectional-register` | DOC-040 flat Required; DOC-070 Conditional met; PROV-LEVY-CERT Required — additional certificate, not a DOC-046 rename. |
| `bulk-sectional` | PROV-LEVY-CERT Optional — counted separately from mandatory totals. |
| `sie-freehold` | Sale in Execution; court/sheriff pack items with review-gated form-sufficiency caveats. |
| `evaluation-incomplete` | Unrecorded trigger facts remain visible as pending, never cleared — including a Required item (DOC-030) with unconfirmed applicability. |
| `evaluation-unavailable` | Whole checklist unresolved — nothing implies zero obligations. |
| `unclassified` | No classification recorded — all levels unknown. |

## 4. Launch instructions

```powershell
# from the repository root (any checkout of this branch)
npm ci                              # once
npx vite --config vite.config.preview.ts
# open http://127.0.0.1:5174/checklist-preview.html

# or serve the built preview bundle
npx vite build --config vite.config.preview.ts
npx vite preview --config vite.config.preview.ts --port 4174
# open http://127.0.0.1:4174/checklist-preview.html
```

## 5. Verification

| Check | Command | Result |
|---|---|---|
| Unit/component tests (offline, Node 24.19.0) | `node --import ./scripts/offline-test-guard.mjs --import tsx --test src/checklist-preview/checklistPreview.test.tsx` | 23/23 pass |
| TypeScript | `npx tsc --noEmit` | clean |
| Preview build | `node node_modules/vite/bin/vite.js build --config vite.config.preview.ts` | OK (`dist-preview/`) |
| Production build isolation | `npm run build` | OK — `dist/` contains only `index.html`; preview not emitted |
| Browser interaction + no external traffic | `node scripts/checklist-preview-screenshot.mjs` | scenario switch, combined filters, mouse + keyboard group toggles pass; zero non-localhost requests, zero page failures |
| Whitespace | `git diff --check` | clean |

Runtime: checks ran under Node **v24.19.0**
(`C:\Users\Dean\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`),
matching the repo `engines.node` requirement. `npm run lint` is not runnable —
no ESLint config exists in the repo (fails on clean `main` too).

**Skipped, honestly:** no integration tests against either API server (the
preview makes no calls); no browser-auth/S2S checks; no DB, migration,
grant or seed verification; no deployed-hosting verification (hosting is
deferred). Playwright evidence is local-render evidence only.

## 6. Remaining integration dependencies

1. **Approved machine mapping** from `requirementKey`/`conditionKey` to the
   87-row ledger (catalogue ids, levels, groups, triggers, timing) —
   separate approval required; do not infer from display names.
2. **Fact keys** (DT-05) and per-row rule approval (DT-10) before any
   conditional item can auto-resolve; the preview's synthetic facts stand in
   for this only visually.
3. **Stage gates** (DT-14): stage/transition/evidence/authority rules must be
   agreed before due stages become executable; the stage filter's buckets
   are a presentation aid over approved prose, not stage definitions.
4. **Evidence acceptance route** (DT-08): reviewer identity, alternatives
   accepted per document, and the accept/waive authority — upload/scan are
   not acceptance.
5. **PROV-LEVY-CERT:** permanent identifier pending the catalogue/engine
   generation-numbering mapping review; signature/formality pending a
   separate evidence/formality review (flag: `Undecided for new document`).
6. **Golden Records reuse/link** (DOC-001/033) and **transaction-verified
   receipt reuse** (DOC-048) need their approved attachment/linkage
   contracts; no attachment-service capability is claimed.
7. **Schema/backfill/grant/audit artifacts** for any persistence of
   checklist state — none exist; fixtures live outside runtime data.
8. **Out-of-scope handling** of the six ungrouped ledger rows
   (DOC-039/067/068/076/077/086) in the production contract.

### Review clarification

The obligation filter labels unknown obligation levels explicitly. It does not
filter applicability: a Required item with an unknown fact remains in Required,
while the separate unresolved total prevents a false completion claim.

The mobile selectors now shrink within the viewport. Browser checks assert
that all selects fit and the 390px layout has no horizontal overflow.
Independent review matched every approval field, all 1,044 classification
cells, and all ten groups to the hash-pinned source workbook.
