import assert from 'node:assert/strict'
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, it, mock } from 'node:test'

import jwt from 'jsonwebtoken'

// Prevent the Express app from binding to a fixed port during import.
process.env.VERCEL = '1'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-32-bytes-long!!'

const JWT_SECRET = process.env.JWT_SECRET

const { default: app } = await import('../index')
const { pool } = await import('../db')
const database = mock.method(pool, 'query', () => { throw new Error('Unexpected BFF database query') })
mock.method(pool, 'connect', () => { throw new Error('Unexpected BFF database connection') })

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

let server: Server
let baseUrl: string
let upstream: Server
let upstreamBaseUrl: string
let captured: CapturedRequest[]
let upstreamResponse: { status: number; body: unknown } | null

const TRANSFER_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = '66666666-6666-4666-8666-666666666666'

function makeToken(abilities: string[] = ['api', 'transfers:read', 'transfers:write'], role = 3, ai = 5) {
  return jwt.sign(
    {
      type: 'access',
      user_id: 1,
      abilities,
      accountable_institution_id: ai,
      user_roles_id: role,
      tenant_id: randomUUID(),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET,
    { algorithm: 'HS256' }
  )
}

function listen(target: Server): Promise<string> {
  return new Promise((resolve) => {
    target.listen(0, '127.0.0.1', () => {
      const address = target.address()
      if (address && typeof address === 'object') {
        resolve(`http://127.0.0.1:${address.port}`)
      }
    })
  })
}

async function httpPost(path: string, headers: Record<string, string>, json?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

before(async () => {
  captured = []
  upstreamResponse = { status: 201, body: { message: 'Created', data: { id: TRANSFER_ID } } }

  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const response = upstreamResponse ?? { status: 500, body: null }
      res
        .writeHead(response.status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(response.body))
    })
  })
  upstreamBaseUrl = await listen(upstream)
  process.env.DEEDLY_API_BASE_URL = upstreamBaseUrl

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        baseUrl = `http://127.0.0.1:${address.port}`
      }
      resolve()
    })
  })
})

after(async () => {
  delete process.env.DEEDLY_API_BASE_URL
  server.close()
  upstream.close()
  await pool.end()
})

describe('v1 matter create + party attach BFF proxies', async () => {
  beforeEach(() => {
    captured = []
    upstreamResponse = { status: 201, body: { message: 'Created', data: { id: TRANSFER_ID } } }
  })

  it('guards staff lists and keeps client lists empty without totals or upstream calls', async () => {
    for (const [authorization, status] of [
      [undefined, 401], ['Bearer invalid', 401],
      [`Bearer ${makeToken(['transfers:write'])}`, 403],
      [`Bearer ${makeToken(['transfers:read'], 6)}`, 401],
      [`Bearer ${makeToken(['transfers:read'], 4)}`, 200],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/v1/transfers?status=invalid`, {
        headers: authorization ? { Authorization: authorization } : {},
      })
      assert.equal(response.status, status)
      if (status === 200) assert.deepEqual((await response.json()).data, {
        transfers: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
      })
    }
    assert.equal(captured.length, 0)
    assert.equal(database.mock.callCount(), 0)
  })

  it('proxies canonical filtering and pagination with the unchanged JWT, never tenant overrides', async () => {
    for (const role of [1, 2, 3]) {
      const token = makeToken(['transfers:read'], role)
      const envelope = { message: 'OK', data: {
        transfers: [{ id: TRANSFER_ID, status: 'complete' }],
        pagination: { page: 2, limit: 1, total: 3, totalPages: 3 },
        statusTotals: { total: 9, inProgress: 6, completed: 3 },
      } }
      upstreamResponse = { status: 200, body: envelope }
      const response = await fetch(`${baseUrl}/api/v1/transfers?status=complete&page=2&limit=1&sortBy=status&sortOrder=asc&accountable_institution_id=7`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Accountable-Institution-Id': '7' },
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), envelope)
      const sent = captured.at(-1)!
      assert.equal(sent.url, '/api/v1/transfers/?page=2&limit=1&sortBy=status&sortOrder=asc&status=complete')
      assert.equal(sent.headers.authorization, `Bearer ${token}`)
      assert.equal(sent.headers['x-accountable-institution-id'], undefined)
      assert.equal(sent.method, 'GET')
      assert.equal(sent.body, '')
    }
    assert.equal(database.mock.callCount(), 0)
  })

  it('relays validation failures without dropping invalid or repeated status values', async () => {
    upstreamResponse = { status: 422, body: { detail: 'status must be in_progress or complete' } }
    for (const query of ['status=', 'status=draft', 'status=complete&status=in_progress']) {
      const response = await fetch(`${baseUrl}/api/v1/transfers/?${query}`, {
        headers: { Authorization: `Bearer ${makeToken()}` },
      })
      assert.equal(response.status, 422)
      assert.deepEqual(await response.json(), upstreamResponse.body)
      assert.equal(captured.at(-1)?.url, `/api/v1/transfers/?${query}`)
    }
  })

  it('preserves literal question marks and following parameters for FastAPI validation', async () => {
    upstreamResponse = { status: 422, body: { detail: 'Invalid status' } }
    for (const query of [
      'status=complete?legacy&limit=2',
      'status=complete%3Flegacy&limit=2',
      'status=complete?legacy&limit=2&status=in_progress',
    ]) {
      const response = await fetch(`${baseUrl}/api/v1/transfers?${query}`, {
        headers: { Authorization: `Bearer ${makeToken()}` },
      })
      assert.equal(response.status, 422)
      const forwarded = new URL(captured.at(-1)!.url, upstreamBaseUrl).searchParams
      assert.deepEqual(forwarded.getAll('status'), new URLSearchParams(query).getAll('status'))
      assert.equal(forwarded.get('limit'), '2')
    }
  })

  it('fails list reads closed on missing configuration, transport failure and upstream errors', async () => {
    const headers = { Authorization: `Bearer ${makeToken()}` }
    upstreamResponse = { status: 500, body: { error: 'private upstream detail' } }
    for (const base of [upstreamBaseUrl, undefined, 'http://127.0.0.1:1']) {
      if (base) process.env.DEEDLY_API_BASE_URL = base
      else delete process.env.DEEDLY_API_BASE_URL
      try {
        const response = await fetch(`${baseUrl}/api/v1/transfers`, { headers })
        assert.equal(response.status, 503)
        assert.deepEqual(await response.json(), { success: false, error: 'Matter service temporarily unavailable' })
      } finally {
        process.env.DEEDLY_API_BASE_URL = upstreamBaseUrl
      }
    }
    assert.equal(database.mock.callCount(), 0)
  })

  it('guards classification discovery before contacting FastAPI', async () => {
    for (const [authorization, status] of [
      [undefined, 401],
      [`Bearer ${makeToken(['transfers:read'], 4)}`, 404],
      [`Bearer ${makeToken(['transfers:write'])}`, 403],
      [`Bearer ${makeToken(['transfers:read'], 6)}`, 401],
    ] as const) {
      const response = await fetch(`${baseUrl}/api/v1/transfers/classifications`, {
        headers: authorization ? { Authorization: authorization } : {},
      })
      assert.equal(response.status, status)
    }
    assert.equal(captured.length, 0)
  })

  it('proxies classification reference data as GET with the caller JWT and no body', async () => {
    const token = makeToken(['transfers:read'])
    const envelope = { message: 'OK', data: { classifications: [{ canonicalCode: 'transfer.donation', displayLabel: 'Donation' }] } }
    upstreamResponse = { status: 200, body: envelope }
    const response = await fetch(`${baseUrl}/api/v1/transfers/classifications`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), envelope)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].method, 'GET')
    assert.equal(captured[0].url, '/api/v1/transfers/classifications')
    assert.equal(captured[0].headers.authorization, `Bearer ${token}`)
    assert.equal(captured[0].body, '')
  })

  it('fails closed when classification reference data is unavailable', async () => {
    const headers = { Authorization: `Bearer ${makeToken(['transfers:read'])}` }
    upstreamResponse = { status: 500, body: { error: 'private upstream detail' } }
    let response = await fetch(`${baseUrl}/api/v1/transfers/classifications`, { headers })
    assert.equal(response.status, 503)
    assert.doesNotMatch(await response.text(), /private upstream detail/)
    delete process.env.DEEDLY_API_BASE_URL
    try {
      response = await fetch(`${baseUrl}/api/v1/transfers/classifications`, { headers })
      assert.equal(response.status, 503)
    } finally {
      process.env.DEEDLY_API_BASE_URL = upstreamBaseUrl
    }
  })

  it('returns 401 for matter creation without a JWT and never calls upstream', async () => {
    const res = await httpPost('/api/v1/transfers/', {}, { property_address: 'A', purchase_price: 1 })
    assert.equal(res.status, 401)
    assert.equal(captured.length, 0)
  })

  it('returns 401 for party attach without a JWT and never calls upstream', async () => {
    const res = await httpPost(`/api/v1/transfers/${TRANSFER_ID}/parties`, {}, { party_source: 'manual' })
    assert.equal(res.status, 401)
    assert.equal(captured.length, 0)
  })

  it('returns 401 for a malformed JWT', async () => {
    const res = await httpPost('/api/v1/transfers/', { Authorization: 'Bearer not-a-jwt' }, {})
    assert.equal(res.status, 401)
    assert.equal(captured.length, 0)
  })

  it('forwards the caller JWT and matter payload unchanged', async () => {
    const token = makeToken()
    const body = { property_address: '12 Test Street', purchase_price: 1500000, client_request_id: REQUEST_ID }
    const res = await httpPost('/api/v1/transfers/', { Authorization: `Bearer ${token}` }, body)
    assert.equal(res.status, 201)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].method, 'POST')
    assert.equal(captured[0].url, '/api/v1/transfers/')
    assert.equal(captured[0].headers.authorization, `Bearer ${token}`)
    assert.deepEqual(JSON.parse(captured[0].body), body)
  })

  it('forwards the party attach body and path to FastAPI', async () => {
    const token = makeToken()
    const body = {
      client_request_id: REQUEST_ID,
      party_source: 'manual',
      entity_type: 'person',
      role: 'transferor',
      manual: { name: 'Jane Example', id_number: '9001010001081', id_type: 'sa_id' },
    }
    const res = await httpPost(`/api/v1/transfers/${TRANSFER_ID}/parties`, { Authorization: `Bearer ${token}` }, body)
    assert.equal(res.status, 201)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, `/api/v1/transfers/${TRANSFER_ID}/parties`)
    assert.deepEqual(JSON.parse(captured[0].body), body)
  })

  it('returns 404 for a non-UUID transfer id without calling upstream', async () => {
    const res = await httpPost(
      '/api/v1/transfers/not-a-uuid/parties',
      { Authorization: `Bearer ${makeToken()}` },
      { party_source: 'manual' }
    )
    assert.equal(res.status, 404)
    assert.equal(captured.length, 0)
  })

  it('relays FastAPI idempotency conflicts (409) without rewriting them', async () => {
    upstreamResponse = { status: 409, body: { success: false, error: 'client_request_id was already used with a different payload' } }
    const res = await httpPost(
      '/api/v1/transfers/',
      { Authorization: `Bearer ${makeToken()}` },
      { property_address: 'A', purchase_price: 1, client_request_id: REQUEST_ID }
    )
    assert.equal(res.status, 409)
    assert.equal(res.body.error, 'client_request_id was already used with a different payload')
  })

  it('relays FastAPI authorization failures (403) unchanged', async () => {
    upstreamResponse = { status: 403, body: { detail: 'Forbidden' } }
    const res = await httpPost(
      `/api/v1/transfers/${TRANSFER_ID}/parties`,
      { Authorization: `Bearer ${makeToken()}` },
      { party_source: 'manual', entity_type: 'person', role: 'transferor', manual: { name: 'Jane' } }
    )
    assert.equal(res.status, 403)
  })

  it('forwards Veriff session, refresh and retry through the protected IDV proxy with the caller JWT', async () => {
    const subject = randomUUID()
    const token = makeToken()
    upstreamResponse = { status: 200, body: { message: 'OK', data: { provider: 'veriff', captureUrl: 'https://alchemy.veriff.com/v/synthetic' } } }
    for (const action of ['session', 'refresh', 'retry']) {
      const route = `/api/v1/transfers/${TRANSFER_ID}/parties/${subject}/id-verification/${action}`
      const res = await httpPost(route, { Authorization: `Bearer ${token}` }, {})
      assert.equal(res.status, 200)
      assert.equal(res.body.data.provider, 'veriff')
      assert.equal(captured.at(-1)?.url, route)
      assert.equal(captured.at(-1)?.headers.authorization, `Bearer ${token}`)
      assert.equal(captured.at(-1)?.body, '{}')
    }
  })

  it('guards Veriff IDV mutations before any upstream call', async () => {
    const route = `/api/v1/transfers/${TRANSFER_ID}/parties/${randomUUID()}/id-verification/session`
    for (const [headers, expected] of [
      [{}, 401],
      [{ Authorization: `Bearer ${makeToken(['transfers:read'])}` }, 403],
      [{ Authorization: `Bearer ${makeToken(['transfers:write'], 4)}` }, 403],
    ] as const) {
      const res = await httpPost(route, headers, {})
      assert.equal(res.status, expected)
    }
    assert.equal(captured.length, 0)
  })

  it('retrieves Veriff status via GET and preserves no-store and technical failures', async () => {
    const route = `/api/v1/transfers/${TRANSFER_ID}/parties/${randomUUID()}/id-verification`
    const token = makeToken()
    upstreamResponse = { status: 200, body: { message: 'OK', data: { status: 'declined', environment: 'test', simulated: true } } }
    const res = await fetch(baseUrl + route, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal((await res.json()).data.status, 'declined')
    assert.equal(captured[0].method, 'GET')
    assert.equal(captured[0].headers.authorization, `Bearer ${token}`)
    upstreamResponse = { status: 503, body: { success: false, error: 'provider_unavailable' } }
    const failed = await fetch(baseUrl + route, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(failed.status, 503)
    assert.equal((await failed.json()).error, 'provider_unavailable')
    for (const code of ['configuration_unavailable', 'storage_unavailable']) {
      upstreamResponse = { status: 503, body: { success: false, error: code, sensitiveDetail: 'must not reach browser' } }
      const r = await fetch(baseUrl + route, { headers: { Authorization: `Bearer ${token}` } })
      assert.deepEqual(await r.json(), { success: false, error: code })
    }
    upstreamResponse = { status: 503, body: { error: 'sensitive unrecognised provider detail' } }
    const sanitised = await fetch(baseUrl + route, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal((await sanitised.json()).error, 'Matter service temporarily unavailable')
  })

  it('denies client-role matter creation even with transfers:write, without calling upstream', async () => {
    const token = makeToken(['api', 'transfers:read', 'transfers:write'], 4, 5)
    const res = await httpPost(
      '/api/v1/transfers/',
      { Authorization: `Bearer ${token}` },
      { property_address: 'A', purchase_price: 1, client_request_id: REQUEST_ID }
    )
    assert.equal(res.status, 403)
    assert.equal(captured.length, 0)
  })

  it('denies client-role party attach even with transfers:write, without calling upstream', async () => {
    const token = makeToken(['api', 'transfers:read', 'transfers:write'], 4, 5)
    const res = await httpPost(
      `/api/v1/transfers/${TRANSFER_ID}/parties`,
      { Authorization: `Bearer ${token}` },
      { party_source: 'manual', entity_type: 'person', role: 'transferor', manual: { name: 'Jane' } }
    )
    assert.equal(res.status, 403)
    assert.equal(captured.length, 0)
  })
})
