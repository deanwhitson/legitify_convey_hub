import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { inspect } from 'node:util'
import { after, before, beforeEach, describe, it, mock } from 'node:test'
import jwt from 'jsonwebtoken'
import { CurrentUser } from '../auth/currentUser'
import { JWTVerificationError, verifyJwt } from '../auth/jwt'
import { authorizeMutation, authorizeRecordAccess, resolveEffectiveTenantId, resolveWriteTenantId } from '../auth/policy'

process.env.VERCEL = '1'
process.env.JWT_SECRET = 'ai-security-tests-only-32-byte-secret'
process.env.NODE_ENV = 'development'
process.env.ConveyHub_Transfers_POSTGRES_URL_NON_POOLING = 'postgres://test:test@127.0.0.1:1/test_only'
process.env.DEEDLY_API_BASE_URL = 'http://127.0.0.1:1'
process.env.LEGACY_ACCOUNTABLE_INSTITUTION_ID = '5'
process.env.LOQATE_API_KEY = 'address-test-key-not-a-real-key'

const SECRET = process.env.JWT_SECRET
const GR = '11111111-1111-4111-8111-111111111111'
const OWN = '22222222-2222-4222-8222-222222222222'
const FOREIGN = '33333333-3333-4333-8333-333333333333'
const PARTY = '44444444-4444-4444-8444-444444444444'
const OTHER_PARTY = '55555555-5555-4555-8555-555555555555'
const MARKER = 'private-security-fixture-not-for-response-or-logs'
const { default: app } = await import('../index')
const { pool, query, checkDatabaseHealth } = await import('../db')
let server: Server
let baseUrl: string
let calls: Array<{ text: string; params: unknown[] }> = []
let failQuery = false
const CANONICAL_MATTER = '66666666-6666-4666-8666-666666666666'
let workflowMatter: string | null | undefined
let denyHistory = false
let outbound: string[] = []
const httpFetch = globalThis.fetch
mock.method(globalThis, 'fetch', async (...[input, init]: Parameters<typeof httpFetch>) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (baseUrl && url.startsWith(`${baseUrl}/`)) return httpFetch(input, init)
  outbound.push(url)
  if (url === 'http://127.0.0.1:1/api/v1/transfers/' && init?.method === 'GET') {
    const forwarded = new Headers(init.headers)
    assert.equal(forwarded.get('X-Accountable-Institution-Id'), null)
    const user = verifyJwt(forwarded.get('Authorization')!.replace('Bearer ', ''), SECRET)
    assert.equal(user.accountable_institution_id, 5)
    return new Response(JSON.stringify({ message: 'OK', data: {
      transfers: [{ id: OWN }], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
      statusTotals: { total: 1, inProgress: 1, completed: 0 },
    } }), { headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error('Unexpected upstream request')
})
const errorLog = mock.method(console, 'error', () => {})
const warningLog = mock.method(console, 'warn', () => {})
mock.method(console, 'log', () => {})

function makeToken(overrides: Record<string, unknown> = {}, omit: string[] = []) {
  const claims: Record<string, unknown> = {
    type: 'access', user_id: 123, golden_record_id: GR,
    abilities: ['transfers:read', 'transfers:write'],
    accountable_institution_id: 5, user_roles_id: 3,
    exp: Math.floor(Date.now() / 1000) + 3600, ...overrides,
  }
  for (const field of omit) delete claims[field]
  return jwt.sign(claims, SECRET, { algorithm: 'HS256' })
}

function authorization(overrides: Record<string, unknown> = {}) {
  return { Authorization: `Bearer ${makeToken(overrides)}` }
}

function row(id: string, ai: number) {
  return {
    id, transfer_id: `TX-${ai}`, accountable_institution_id: ai,
    property_address: `Institution ${ai} address`, purchase_price: 100,
    status: 'in_progress', current_step: 1, total_steps: 5, progress: 0,
    ...(workflowMatter !== undefined ? { matter_id: workflowMatter } : {}),
    created_at: '2026-01-01', updated_at: '2026-01-01',
  }
}

async function fixtureQuery(text: string, params: unknown[] = []) {
  calls.push({ text, params })
  if (failQuery) throw new Error(MARKER)
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 }
  if (text.includes('AS workflow_matter_id')) {
    const valid = workflowMatter === undefined || workflowMatter === CANONICAL_MATTER
    const rows = valid ? [{ workflow_matter_id: CANONICAL_MATTER }] : []
    return { rows, rowCount: rows.length }
  }
  if (text.includes('FROM transfers t')) {
    let rows = [row(OWN, 5), row(FOREIGN, 7)]
    if (text.includes('t.id = $1')) rows = rows.filter(item => item.id === params[0])
    const scope = /t\.accountable_institution_id\s*=\s*\$(\d+)/.exec(text)
    if (scope) rows = rows.filter(item => item.accountable_institution_id === params[Number(scope[1]) - 1])
    if (text.includes('EXISTS')) rows = rows.filter(() => params[1] === GR)
    if (text.includes('COUNT(*)')) return { rows: [{ count: String(rows.length) }], rowCount: 1 }
    return { rows, rowCount: rows.length }
  }
  if (text.includes('FROM matter_milestones mm') || text.includes('FROM milestone_history mh')) {
    if (denyHistory && text.includes('FROM milestone_history')) throw Object.assign(new Error(MARKER), { code: '42501' })
    const matters = [
      { id: CANONICAL_MATTER, source: FOREIGN, ai: 5, type: 'transfer' },
      { id: '77777777-7777-4777-8777-777777777777', source: OWN, ai: 5, type: 'transfer' },
      { id: '88888888-8888-4888-8888-888888888888', source: OWN, ai: 5, type: 'transfer' },
      { id: '99999999-9999-4999-8999-999999999999', source: OWN, ai: 7, type: 'transfer' },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source: OWN, ai: 5, type: 'bond' },
    ]
    let matched = matters.filter(m => text.includes('t.matter_id = m.id') ? m.id === workflowMatter : m.source === params[0])
    if (text.includes('m.accountable_institution_id')) matched = matched.filter(m => m.ai === params[1])
    if (text.includes("m.matter_type = 'transfer'")) matched = matched.filter(m => m.type === 'transfer')
    const rows = matched.map(m => ({ id: m.id, matter_id: m.id, name: 'Recorded milestone', status: 'not_started',
      sequence_number: 1, actor_name: null, action: 'Recorded event', created_at: '2026-01-01T00:00:00Z' }))
    return { rows, rowCount: rows.length }
  }
  if (text.includes('FROM transfer_parties') && text.includes('SELECT 1')) {
    const ownerAi = params[1] === OWN ? 5 : 7
    const ownedParty = params[1] === OWN ? params[0] === PARTY : params[0] === OTHER_PARTY
    const scoped = params.length < 3 || params[2] === ownerAi
    const visible = ownedParty && scoped
    return { rows: visible ? [{ exists: 1 }] : [], rowCount: visible ? 1 : 0 }
  }
  if (text.includes('FROM party_relationship_definitions')) {
    return { rows: [{ code: params[0] }], rowCount: 1 }
  }
  if (text.includes('INSERT INTO party_relationship_assignments')) {
    return {
      rows: [{
        id: GR, transfer_party_id: params[0], relationship_code: params[1],
        created_at: '2026-01-01', updated_at: '2026-01-01',
      }],
      rowCount: 1,
    }
  }
  if (text.includes('FROM transfer_parties') && !text.includes('SELECT 1')) {
    const ai = params[0] === OWN ? 5 : 7
    return { rows: [{
      id: PARTY, transfer_id: params[0], golden_record_id: GR, entity_type: 'person',
      role: 'transferee', accountable_institution_id: ai, cached_name: `Client of ${ai}`,
      cached_id_number: MARKER, cached_email: MARKER, synced_at: '2026-01-01',
    }], rowCount: 1 }
  }
  throw new Error('Unexpected persistence call')
}

mock.method(pool, 'query', fixtureQuery as typeof pool.query)
mock.method(pool, 'connect', (async () => ({
  query: (text: string, params?: unknown[]) => fixtureQuery(text, params),
  release: () => {},
})) as typeof pool.connect)

async function request(path: string, headers: Record<string, string> = {}, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, headers: response.headers, body: await response.json() }
}

before(async () => {
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

beforeEach(() => {
  calls = []
  outbound = []
  failQuery = false
  workflowMatter = undefined
  denyHistory = false
  errorLog.mock.resetCalls()
  warningLog.mock.resetCalls()
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  mock.restoreAll()
  await pool.end()
})

describe('canonical read-only workflow associations', () => {
  for (const resource of ['milestones', 'activity']) {
    it(`${resource} uses only the canonical matter despite mismatched and duplicate legacy sources`, async () => {
      workflowMatter = CANONICAL_MATTER
      const result = await request(`/api/v1/transfers/${OWN}/${resource}`, authorization())
      assert.equal(result.status, 200)
      assert.deepEqual(result.body.data[resource].map((item: { id: string }) => item.id), [CANONICAL_MATTER])
      const read = calls.at(-1)!
      assert.match(read.text, /t\.matter_id = m\.id/)
      assert.match(read.text, /t\.id = \$1/)
      assert.match(read.text, /t\.accountable_institution_id = \$2/)
      assert.match(read.text, /m\.accountable_institution_id = \$2/)
      assert.match(read.text, /m\.matter_type = 'transfer'/)
      assert.doesNotMatch(read.text, /source_record_id/)
      assert.ok(calls.every(call => /^\s*SELECT\b/.test(call.text)))
    })

    it(`${resource} never repairs or falls back for absent, foreign or wrong-type canonical links`, async () => {
      for (const link of [null, FOREIGN, '99999999-9999-4999-8999-999999999999', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']) {
        workflowMatter = link
        const result = await request(`/api/v1/transfers/${OWN}/${resource}`, authorization())
        assert.equal(result.status, 409)
        assert.ok(!result.body.data)
      }
      assert.ok(calls.every(call => /^\s*SELECT\b/.test(call.text)))
    })

    it(`${resource} preserves auth, staff ability and every-role tenant boundaries`, async () => {
      assert.equal((await request(`/api/v1/transfers/${OWN}/${resource}`)).status, 401)
      assert.equal((await request(`/api/v1/transfers/${OWN}/${resource}`, authorization({ user_roles_id: 4 }))).status, 404)
      assert.equal((await request(`/api/v1/transfers/${OWN}/${resource}`, authorization({ abilities: [] }))).status, 403)
      assert.equal(calls.length, 0)
      for (const role of [1, 2, 3]) {
        const denied = await request(`/api/v1/transfers/${FOREIGN}/${resource}`, authorization({ user_roles_id: role }))
        assert.equal(denied.status, 404)
      }
      assert.ok(calls.every(call => !/FROM (matter_milestones|milestone_history)/.test(call.text)))
    })
  }

  it('surfaces missing history permission rather than inventing empty activity or changing grants', async () => {
    workflowMatter = CANONICAL_MATTER
    denyHistory = true
    const result = await request(`/api/v1/transfers/${OWN}/activity`, authorization())
    assert.equal(result.status, 500)
    assert.ok(!result.body.data)
    assert.ok(!JSON.stringify(result.body).includes(MARKER))
    const milestones = await request(`/api/v1/transfers/${OWN}/milestones`, authorization())
    assert.equal(milestones.status, 200)
    assert.ok(calls.every(call => /^\s*SELECT\b/.test(call.text)))
  })
})

describe('Verified institution claims and policy', () => {
  for (const field of ['user_id', 'accountable_institution_id', 'user_roles_id']) {
    it(`rejects malformed ${field} without integer coercion or default access`, () => {
      for (const value of [null, true, false, 0, -1, 6.9, '6.9', '', ' 5', [], {}, 2 ** 53]) {
        assert.throws(() => verifyJwt(makeToken({ [field]: value }), SECRET), JWTVerificationError, `${field}: ${JSON.stringify(value)}`)
      }
    })
  }

  it('retains canonical integer-string claims', () => {
    const user = verifyJwt(makeToken({ user_id: '123', accountable_institution_id: '5', user_roles_id: '2' }), SECRET)
    assert.equal(user.user_id, 123)
    assert.equal(user.accountable_institution_id, 5)
    assert.equal(user.user_roles_id, 2)
  })

  it('denies retired and unknown role IDs even with read and write abilities', () => {
    for (const role of [5, 6, 7, 99]) {
      assert.throws(
        () => verifyJwt(makeToken({ user_roles_id: role }), SECRET),
        JWTVerificationError, `user_roles_id: ${role}`,
      )
    }
    for (const role of [1, 2, 3, 4]) {
      const user = verifyJwt(makeToken({ user_roles_id: role }), SECRET)
      assert.equal(user.user_roles_id, role)
    }
  })

  it('does not let client identity override the institution boundary', () => {
    const user = new CurrentUser({ user_id: 1, accountable_institution_id: 5, user_roles_id: 4, golden_record_id: GR })
    assert.equal(authorizeRecordAccess(user, 7), 'not_found')
    assert.equal(authorizeRecordAccess(user, 5), 'client_party_check_required')
  })

  it('rejects missing, non-positive and malformed institution scopes even for privileged roles', () => {
    for (const role of [1, 2, 3, 4]) {
      for (const value of [undefined, null, false, 0, -1, 2.5, '2']) {
        const user = new CurrentUser({ user_id: 1, accountable_institution_id: value as number, user_roles_id: role })
        assert.equal(authorizeRecordAccess(user, 5), 'not_found')
        assert.throws(() => resolveEffectiveTenantId(user))
        user.accountable_institution_id = 5
        assert.equal(authorizeRecordAccess(user, value as number), 'not_found')
        if (value !== undefined) assert.throws(() => resolveEffectiveTenantId(user, value as number))
      }
    }
  })

  it('keeps no cross-institution write exception for privileged roles', () => {
    for (const role of [1, 2, 3]) {
      const user = new CurrentUser({ user_id: 1, accountable_institution_id: 5, user_roles_id: role })
      assert.equal(authorizeRecordAccess(user, 7), 'not_found')
      assert.equal(authorizeRecordAccess(user, 5), 'allowed')
      assert.equal(authorizeMutation(user, 7), 'not_found')
      assert.equal(authorizeMutation(user, 5), 'allowed')
      assert.equal(resolveWriteTenantId(user), 5)
      assert.equal(resolveWriteTenantId(user, 5), 5)
      assert.throws(() => resolveWriteTenantId(user, 7))
    }
  })
})

const legacyPaths: Array<[string, string]> = [
  ['GET', '/api/transfers'], ['GET', '/api/transfers/stats'], ['POST', '/api/transfers'],
  ['GET', `/api/transfers/${OWN}`], ['PUT', `/api/transfers/${OWN}`], ['DELETE', `/api/transfers/${OWN}`],
  ['GET', `/api/transfers/${OWN}/parties`], ['GET', `/api/transfers/${OWN}/documents`],
  ['POST', `/api/transfers/${OWN}/documents`], ['PATCH', `/api/transfers/${OWN}/documents/${PARTY}`],
  ['POST', `/api/transfers/${OWN}/documents/${PARTY}/upload`],
  ['GET', `/api/transfers/${OWN}/milestones`], ['PUT', `/api/transfers/${OWN}/milestones`],
  ['PATCH', `/api/transfers/${OWN}/milestones/${PARTY}`], ['GET', `/api/transfers/${OWN}/milestones/${PARTY}/audit`],
  ['GET', `/api/transfers/${OWN}/activity`], ['GET', '/api/documents'],
  ['GET', '/api/generated-documents'], ['POST', '/api/generated-documents'], ['GET', `/api/generated-documents/${OWN}`],
  ['GET', '/api/users/me'], ['PUT', '/api/users/me'], ['GET', '/api/catalogue'], ['POST', '/api/catalogue'],
  ['GET', '/api/data-fields'], ['GET', '/api/clauses'], ['POST', '/api/clauses'],
  ['GET', '/api/address/search'], ['GET', '/api/address/retrieve'], ['GET', '/api/address/geocode'],
  ...['/api/accounts', '/api/v1/accounts'].flatMap(prefix => [
    ['GET', `${prefix}/settings`], ['PUT', `${prefix}/settings`], ['GET', `${prefix}/tariffs`], ['POST', `${prefix}/tariffs`],
    ['GET', `${prefix}/transfers/${OWN}/proforma`], ['PUT', `${prefix}/transfers/${OWN}/proforma`],
    ['POST', `${prefix}/calculate`], ['POST', `${prefix}/reset`],
  ] as Array<[string, string]>),
]

describe('Legacy quarantine', () => {
  for (const [method, path] of legacyPaths) {
    it(`contains ${method} ${path} before data, cache or default-institution access`, async () => {
      const cases: Array<[Record<string, string>, number]> = [
        [{}, 401], [{ 'X-Service-Key': 'test-service-key', 'X-Accountable-Institution-Id': '5' }, 401],
        [authorization(), 503], [authorization({ accountable_institution_id: 1 }), 503],
        [authorization({ accountable_institution_id: 7 }), 503],
        [authorization({ user_roles_id: 1 }), 503],
        [authorization({ user_roles_id: 5 }), 401], [authorization({ user_roles_id: 6 }), 401],
      ]
      for (const [authentication, expected] of cases) {
        const result = await request(`${path}?accountable_institution_id=7&text=Test&q=Test&id=${GR}`, authentication, method,
          ['POST', 'PUT', 'PATCH'].includes(method) ? { accountable_institution_id: 7, golden_record_id: GR } : undefined)
        assert.equal(result.status, expected)
        assert.equal(result.headers.get('cache-control'), 'no-store')
        assert.deepEqual(calls, [])
        assert.deepEqual(outbound, [])
      }
    })
  }
})

describe('Contracted v1 institution boundaries', () => {
  it('scopes lists to the verified AI despite header or query overrides', async () => {
    const result = await request('/api/v1/transfers?accountable_institution_id=7', {
      ...authorization(), 'X-Accountable-Institution-Id': '7',
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.data.transfers.map((item: { id: string }) => item.id), [OWN])
  })

  it('hides foreign matters, including for institution 1 staff', async () => {
    for (const [id, ai] of [[FOREIGN, 5], [OWN, 1]] as const) {
      const result = await request(`/api/v1/transfers/${id}`, authorization({ accountable_institution_id: ai }))
      assert.equal(result.status, 404)
      assert.deepEqual(result.body, { success: false, error: 'Not found' })
    }
  })

  it('keeps client party projections within their own institution', async () => {
    for (const suffix of ['', '/parties']) {
      const own = await request(`/api/v1/transfers/${OWN}${suffix}`, authorization({ user_roles_id: 4, abilities: [] }))
      assert.equal(own.status, 200)
      assert.ok(!JSON.stringify(own.body).includes(MARKER))
      if (suffix === '/parties') assert.equal(calls.at(-1)?.params[2], 5)
      const foreign = await request(`/api/v1/transfers/${FOREIGN}${suffix}`, authorization({ user_roles_id: 4, abilities: [] }))
      assert.equal(foreign.status, 404)
    }
  })

  it('keeps no cross-institution read or list exception for privileged roles', async () => {
    for (const role of [1, 2, 3]) {
      const detail = await request(`/api/v1/transfers/${FOREIGN}`, authorization({ user_roles_id: role }))
      assert.equal(detail.status, 404)
      const listing = await request('/api/v1/transfers/', authorization({ user_roles_id: role }))
      assert.equal(listing.status, 200)
      assert.deepEqual(listing.body.data.transfers.map((item: { id: string }) => item.id), [OWN])
      for (const nested of ['parties', 'milestones', 'documents', 'financials', 'estate-contexts']) {
        const result = await request(
          `/api/v1/transfers/${FOREIGN}/${nested}`, authorization({ user_roles_id: role }),
        )
        assert.equal(result.status, 404, nested)
      }
    }
  })

  it('denies client-role writes even when the token carries transfers:write', async () => {
    const result = await request(
      `/api/v1/transfers/${OWN}/parties/${PARTY}/relationships`,
      authorization({ user_roles_id: 4 }), 'POST', { relationship_code: 'test_relationship' },
    )
    assert.equal(result.status, 403)
    assert.deepEqual(calls, [])
  })

  it('denies retired and unknown role IDs before any handler, persistence or upstream', async () => {
    for (const role of [5, 6, 7, 99]) {
      for (const [path, method, body] of [
        ['/api/v1/transfers/', 'GET', undefined],
        [`/api/v1/transfers/${OWN}`, 'GET', undefined],
        [`/api/v1/transfers/${OWN}/parties/${PARTY}/relationships`, 'POST', { relationship_code: 'test_relationship' }],
      ] as const) {
        const result = await request(path, authorization({ user_roles_id: role }), method, body)
        assert.equal(result.status, 401, `role ${role} ${method} ${path}`)
        assert.equal(result.headers.get('cache-control'), 'no-store')
      }
    }
    assert.deepEqual(calls, [])
    assert.deepEqual(outbound, [])
  })

  it('denies cross-institution writes for staff roles before any mutation', async () => {
    for (const role of [1, 2, 3]) {
      const result = await request(
        `/api/v1/transfers/${FOREIGN}/parties/${OTHER_PARTY}/relationships`,
        authorization({ user_roles_id: role }), 'POST', { relationship_code: 'test_relationship' },
      )
      assert.equal(result.status, 404)
      assert.ok(calls.every(call => !call.text.includes('INSERT')))
      calls = []
    }
    assert.deepEqual(outbound, [])
  })

  it('keeps same-institution writes working for staff roles', async () => {
    for (const role of [1, 2, 3]) {
      const result = await request(
        `/api/v1/transfers/${OWN}/parties/${PARTY}/relationships`,
        authorization({ user_roles_id: role }), 'POST', { relationship_code: 'test_relationship' },
      )
      assert.equal(result.status, 201)
    }
  })

  it('rejects missing and tampered JWT institution context without touching persistence', async () => {
    const tokens = [makeToken({}, ['accountable_institution_id']), `${makeToken()}.tampered`]
    for (const ai of [null, false, 0, -1, 5.5]) tokens.push(makeToken({ accountable_institution_id: ai, user_roles_id: 1 }))
    for (const encoded of tokens) {
      const result = await request('/api/v1/transfers?accountable_institution_id=5', {
        Authorization: `Bearer ${encoded}`, 'X-Accountable-Institution-Id': '5',
      })
      assert.equal(result.status, 401)
      assert.deepEqual(calls, [])
    }
  })

  it('prevents caching of successful and denied matter reads', async () => {
    for (const [id, authentication] of [[OWN, authorization()], [FOREIGN, authorization()], [OWN, {}]] as const) {
      const result = await request(`/api/v1/transfers/${id}`, authentication)
      assert.equal(result.headers.get('cache-control'), 'no-store')
    }
  })

  it('redacts unexpected errors and database logs in development too', async () => {
    failQuery = true
    const result = await request(`/api/v1/transfers/${OWN}`, authorization())
    assert.equal(result.status, 500)
    assert.ok(!JSON.stringify(result.body).includes(MARKER))
    assert.ok(!inspect(errorLog.mock.calls, { depth: 10 }).includes(MARKER))
    assert.equal(result.headers.get('cache-control'), 'no-store')
    await assert.rejects(() => query(`SELECT '${MARKER}' WHERE $1 = $1`, [MARKER]))
    assert.ok(!inspect(errorLog.mock.calls, { depth: 10 }).includes(MARKER))
    const health = await checkDatabaseHealth()
    assert.equal(health.healthy, false)
    assert.ok(!JSON.stringify(health).includes(MARKER))
  })
})
