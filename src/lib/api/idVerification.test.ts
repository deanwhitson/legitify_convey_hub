import assert from 'node:assert/strict'
import { describe, it, mock, afterEach } from 'node:test'
import { IdVerificationApi } from './idVerification'

const TRANSFER_ID = '11111111-1111-1111-1111-111111111111'
const PARTY_ID = '22222222-2222-2222-2222-222222222222'
const ENTITY_PARTY_ID = '33333333-3333-3333-3333-333333333333'

afterEach(() => mock.restoreAll())

function captureFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = []
  mock.method(globalThis, 'fetch', async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return calls
}

describe('IdVerificationApi', () => {
  it('gets status from the party-scoped endpoint', async () => {
    const calls = captureFetch({ message: 'OK', data: { status: 'not_started' } })
    const res = await IdVerificationApi.getStatus(TRANSFER_ID, PARTY_ID)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `/api/v1/transfers/${TRANSFER_ID}/parties/${PARTY_ID}/id-verification`)
    assert.equal(calls[0].init?.method ?? 'GET', 'GET')
    assert.equal(res.data.status, 'not_started')
  })

  it('starts a session with only onBehalfOfPartyId in the body', async () => {
    const calls = captureFetch({ message: 'OK', data: { sdkToken: 't' } })
    await IdVerificationApi.startSession(TRANSFER_ID, PARTY_ID, ENTITY_PARTY_ID)
    assert.equal(calls[0].url, `/api/v1/transfers/${TRANSFER_ID}/parties/${PARTY_ID}/id-verification/session`)
    assert.equal(calls[0].init?.method, 'POST')
    assert.equal(JSON.parse(String(calls[0].init?.body)).onBehalfOfPartyId, ENTITY_PARTY_ID)
    // Browser-supplied provider ids/level names/tenant ids are never sent.
    const sent = JSON.parse(String(calls[0].init?.body))
    assert.deepEqual(Object.keys(sent), ['onBehalfOfPartyId'])
  })

  it('starts a session with an empty body when no representative', async () => {
    const calls = captureFetch({ message: 'OK', data: {} })
    await IdVerificationApi.startSession(TRANSFER_ID, PARTY_ID)
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {})
  })

  it('refreshes the sdk token via the refresh endpoint', async () => {
    const calls = captureFetch({ message: 'OK', data: { sdkToken: 'new' } })
    await IdVerificationApi.refreshToken(TRANSFER_ID, PARTY_ID)
    assert.equal(calls[0].url, `/api/v1/transfers/${TRANSFER_ID}/parties/${PARTY_ID}/id-verification/refresh`)
    assert.equal(calls[0].init?.method, 'POST')
  })

  it('retries via the retry endpoint', async () => {
    const calls = captureFetch({ message: 'OK', data: {} })
    await IdVerificationApi.retry(TRANSFER_ID, PARTY_ID, ENTITY_PARTY_ID)
    assert.equal(calls[0].url, `/api/v1/transfers/${TRANSFER_ID}/parties/${PARTY_ID}/id-verification/retry`)
    assert.equal(JSON.parse(String(calls[0].init?.body)).onBehalfOfPartyId, ENTITY_PARTY_ID)
  })
})
