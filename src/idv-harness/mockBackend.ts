// Synthetic in-page backend for the ID-verification demo harness.
//
// This is the "safe runnable integrated demo harness" boundary: it exists
// ONLY inside the harness bundle (src/idv-harness), never in the app build.
// It patches window.fetch for the id-verification endpoints and keeps a
// labelled synthetic attempt store in sessionStorage — no server, no JWT,
// no database and no provider traffic. It deliberately does NOT weaken or
// simulate the real authz path; it stands in for the whole server while
// the real panel component exercises its API surface.

export interface MockAttempt {
  attemptNo: number
  status: string
  subjectKind: 'party' | 'representative'
  onBehalfOfPartyId: string | null
  reviewAnswer: string | null
  reviewRejectType: string | null
  rejectLabels: string[]
  lastEventType: string | null
  lastEventAt: string | null
  updatedAt: string
}

interface HarnessStore {
  attempts: Record<string, MockAttempt>
}

const STORE_KEY = 'idv-harness-store-v1'
const OPEN_STATUSES = new Set(['started', 'pending', 'review_required'])
const RETRYABLE_STATUSES = new Set(['retry_requested', 'declined', 'not_started'])

function loadStore(): HarnessStore {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) || '') as HarnessStore
  } catch {
    return { attempts: {} }
  }
}

function saveStore(store: HarnessStore) {
  sessionStorage.setItem(STORE_KEY, JSON.stringify(store))
}

let mode: 'sandbox' | 'fixture' | 'veriff-test' =
  new URLSearchParams(window.location.search).get('provider') === 'veriff' ? 'veriff-test' : 'sandbox'
export const calls: { method: string; url: string }[] = []
export function resetDemoSubject(partyId: string) {
  const store = loadStore()
  delete store.attempts[partyId]
  saveStore(store)
}

export function simulateVeriffUiOutcome(partyId: string, status: 'pending' | 'verified' | 'declined' | 'review_required') {
  const store = loadStore()
  const attempt = store.attempts[partyId]
  if (!attempt) return
  attempt.status = status
  attempt.lastEventType = 'synthetic_veriff_ui_outcome'
  attempt.updatedAt = new Date().toISOString()
  saveStore(store)
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ message: 'OK', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fail(code: string, status: number): Response {
  return new Response(JSON.stringify({ success: false, error: code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function attemptOf(store: HarnessStore, partyId: string): MockAttempt | undefined {
  return store.attempts[partyId]
}

function statusData(store: HarnessStore, partyId: string) {
  const a = attemptOf(store, partyId)
  return {
    status: a?.status ?? 'not_started',
    attempt: a
      ? {
          attemptNo: a.attemptNo,
          provider: mode === 'veriff-test' ? 'veriff' : 'sumsub',
          levelName: 'idv-poc-level',
          reviewAnswer: a.reviewAnswer,
          reviewRejectType: a.reviewRejectType,
          rejectLabels: a.rejectLabels,
          lastEventType: a.lastEventType,
          lastEventAt: a.lastEventAt,
          updatedAt: a.updatedAt,
        }
      : null,
    environment: mode,
    simulated: mode === 'fixture' || mode === 'veriff-test',
    checks: a ? [{ check: 'provider_review', state: 'not_reported' }] : [],
    subjectKind: a?.subjectKind ?? 'party',
    onBehalfOfPartyId: a?.onBehalfOfPartyId ?? null,
  }
}

function sessionData(a: MockAttempt, resumed: boolean) {
  return {
    provider: mode === 'veriff-test' ? 'veriff' : 'sumsub',
    captureUrl: mode === 'veriff-test' ? 'https://alchemy.veriff.com/v/synthetic-harness-do-not-submit' : undefined,
    mode,
    environment: mode,
    simulated: mode === 'fixture' || mode === 'veriff-test',
    resumed,
    attemptNo: a.attemptNo,
    status: a.status,
    sdkToken: `MOCK-SDK-TOKEN-${Math.random().toString(36).slice(2, 10)}`,
    sdkTokenTtlSeconds: 600,
    levelName: 'idv-poc-level',
    subjectKind: a.subjectKind,
    onBehalfOfPartyId: a.onBehalfOfPartyId,
  }
}

function startOrResume(store: HarnessStore, partyId: string, onBehalf?: string | null): Response {
  const existing = attemptOf(store, partyId)
  if (existing && OPEN_STATUSES.has(existing.status)) {
    return envelope(sessionData(existing, true))
  }
  if (existing && !RETRYABLE_STATUSES.has(existing.status)) {
    return fail('not_retryable', 409)
  }
  const attempt: MockAttempt = {
    attemptNo: (existing?.attemptNo ?? 0) + 1,
    status: 'started',
    subjectKind: onBehalf ? 'representative' : 'party',
    onBehalfOfPartyId: onBehalf ?? null,
    reviewAnswer: null,
    reviewRejectType: null,
    rejectLabels: [],
    lastEventType: 'applicantCreated',
    lastEventAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  store.attempts[partyId] = attempt
  saveStore(store)
  return envelope(sessionData(attempt, false))
}

const BASE_RE = /\/api\/v1\/transfers\/([^/]+)\/parties\/([^/]+)\/id-verification(\/\w+)?$/

export function installMockIdvBackend(): void {
  const realFetch = window.fetch.bind(window)

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const match = BASE_RE.exec(url)
    if (!match) return realFetch(input, init)

    const method = (init?.method ?? 'GET').toUpperCase()
    const [, , partyId, suffix] = match
    calls.push({ method, url })
    const store = loadStore()
    const body = init?.body ? JSON.parse(String(init.body)) : {}

    if (!suffix && method === 'GET') return envelope(statusData(store, partyId))
    if (suffix === '/session' && method === 'POST') {
      return startOrResume(store, partyId, body.onBehalfOfPartyId)
    }
    if (suffix === '/refresh' && method === 'POST') {
      const a = attemptOf(store, partyId)
      if (!a || !OPEN_STATUSES.has(a.status)) return fail('no_open_attempt', 409)
      return envelope(sessionData(a, true))
    }
    if (suffix === '/retry' && method === 'POST') {
      const a = attemptOf(store, partyId)
      if (!a) return fail('no_attempt', 404)
      if (!RETRYABLE_STATUSES.has(a.status)) return fail('not_retryable', 409)
      return startOrResume(store, partyId, body.onBehalfOfPartyId)
    }
    return fail('not_found', 404)
  }

  // Driver hooks for the Playwright checks — labelled synthetic controls.
  const w = window as unknown as Record<string, unknown>
  w.__idv = {
    setMode(next: 'sandbox' | 'fixture' | 'veriff-test') {
      mode = next
    },
    getMode() {
      return mode
    },
    /** Simulate a server-side applied provider outcome — mirrors the real
     *  webhook mapping (GREEN→verified, RED+RETRY→retry_requested,
     *  RED+FINAL→declined, RED other→review_required, pending→pending). */
    inject(partyId: string, event: { type?: string; reviewAnswer?: string; reviewRejectType?: string; createdAtMs?: string }) {
      const store = loadStore()
      const a = attemptOf(store, partyId)
      if (!a) return { result: 'unmatched' }
      const type = event.type ?? 'applicantReviewed'
      let next = a.status
      if (type === 'applicantPending') next = 'pending'
      else if (type === 'applicantReviewed') {
        const ans = event.reviewAnswer
        if (ans === 'GREEN') next = 'verified'
        else if (ans === 'RED' && event.reviewRejectType === 'RETRY') next = 'retry_requested'
        else if (ans === 'RED' && event.reviewRejectType === 'FINAL') next = 'declined'
        else next = 'review_required'
        a.reviewAnswer = ans ?? null
        a.reviewRejectType = event.reviewRejectType ?? null
      }
      a.status = next
      a.lastEventType = type
      a.lastEventAt = event.createdAtMs ?? new Date().toISOString()
      a.updatedAt = new Date().toISOString()
      saveStore(store)
      return { result: 'applied', status: next }
    },
    reset() {
      sessionStorage.removeItem(STORE_KEY)
    },
    getStore() {
      return loadStore()
    },
    calls,
  }
}
