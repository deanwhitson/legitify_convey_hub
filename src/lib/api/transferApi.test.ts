import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'

import { TransferApi } from './transferApi'
import { ApiRequestError } from './http'

// Concurrency tokens deliberately carry non-zero microseconds: the client
// must echo them byte-for-byte.
const T_TS = '2026-01-02T10:00:00.123456+00:00'
const M_TS = '2026-01-02T10:00:01.654321+00:00'
const TRANSFER_ID = '22222222-2222-4222-8222-222222222222'

const DETAIL = {
  id: TRANSFER_ID,
  transferId: 'TRF-TEST-1',
  propertyAddress: '12 Seed Street',
  purchasePrice: 1000000,
  status: 'in_progress',
  updatedAt: T_TS,
  matter: {
    id: '44444444-4444-4444-8444-444444444444',
    referenceNumber: 'TRF-TEST-1',
    title: 'Original title',
    firmReference: 'FRM-1',
    classificationCode: 'sale_private_treaty',
    status: 'in_progress',
    updatedAt: M_TS,
  },
}

function respond(body: unknown, status = 200) {
  return mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }))
}

afterEach(() => mock.restoreAll())

const CLASSIFICATION = {
  canonicalCode: 'transfer.private_treaty.not_applicable',
  subtype: 'private_treaty',
  displayLabel: 'Private Treaty',
  transferFrom: 'not_applicable',
  transferFromLabel: 'Not Applicable',
  requiresTransferFrom: true,
}

describe('read-only milestone and activity API', () => {
  it('keeps empty results distinct from malformed or failed reads', async () => {
    for (const [field, read] of [
      ['milestones', () => TransferApi.getMilestones(TRANSFER_ID)],
      ['activity', () => TransferApi.getActivity(TRANSFER_ID)],
    ] as const) {
      const empty = respond({ message: 'OK', data: { [field]: [] } })
      assert.deepEqual((await read()).data, [])
      empty.mock.restore()
      for (const data of [undefined, {}, { [field]: null }, { [field]: {} }]) {
        const response = respond({ message: 'OK', data })
        await assert.rejects(read, /Invalid .* response/)
        response.mock.restore()
      }
      const failure = respond({ error: 'Unavailable' }, 503)
      await assert.rejects(read, ApiRequestError)
      failure.mock.restore()
    }
  })

  it('refuses unsupported milestone writes without issuing a legacy request', async () => {
    const fetchMock = respond({ success: true, data: [] })
    await assert.rejects(TransferApi.updateMilestones(TRANSFER_ID, []), /read-only/i)
    assert.equal(fetchMock.mock.callCount(), 0)
  })
})

describe('canonical transfer classifications', () => {
  it('loads authenticated reference data without a hard-coded fallback', async () => {
    const fetchMock = respond({ message: 'OK', data: { classifications: [CLASSIFICATION] } })
    assert.deepEqual(await TransferApi.getClassifications(), [CLASSIFICATION])
    assert.equal(fetchMock.mock.calls[0].arguments[0], '/api/v1/transfers/classifications')
  })

  it('keeps an empty catalogue empty and fails on service errors', async () => {
    respond({ message: 'OK', data: { classifications: [] } })
    assert.deepEqual(await TransferApi.getClassifications(), [])
    mock.restoreAll()
    respond({ error: 'Unavailable' }, 503)
    await assert.rejects(TransferApi.getClassifications(), ApiRequestError)
  })

  it('rejects malformed, duplicate, generic and development options', async () => {
    for (const data of [
      {},
      { classifications: 'invalid' },
      { classifications: [null] },
      { classifications: [{ ...CLASSIFICATION, displayLabel: undefined }] },
      { classifications: [{ ...CLASSIFICATION, transferFromLabel: null }] },
      { classifications: [{ ...CLASSIFICATION, canonicalCode: 'transfer.generic' }] },
      { classifications: [{ ...CLASSIFICATION, canonicalCode: 'development.subdivision' }] },
      { classifications: [CLASSIFICATION, CLASSIFICATION] },
    ]) {
      mock.restoreAll()
      respond({ message: 'OK', data })
      await assert.rejects(TransferApi.getClassifications(), /classification response/i)
    }
  })

  it('preserves canonical code and firm reference when reopening a matter', async () => {
    respond({ message: 'OK', data: { ...DETAIL, matter: { ...DETAIL.matter, classificationCode: CLASSIFICATION.canonicalCode } } })
    const response = await TransferApi.getTransfer(TRANSFER_ID)
    assert.equal(response.data?.classificationCode, CLASSIFICATION.canonicalCode)
    assert.equal(response.data?.firmReference, 'FRM-1')
  })

  it('keeps unclassified and unavailable historical codes unchanged', async () => {
    for (const code of [null, 'transfer.historical_classification']) {
      mock.restoreAll()
      respond({ message: 'OK', data: { ...DETAIL, matter: { ...DETAIL.matter, classificationCode: code } } })
      const response = await TransferApi.getTransfer(TRANSFER_ID)
      assert.equal(response.data?.classificationCode, code)
    }
  })

  it('sends the canonical code, not a display label, and preserves the request key', async () => {
    const fetchMock = respond({ message: 'Created', data: { id: TRANSFER_ID } }, 201)
    await TransferApi.createMatter({
      property_address: '12 Seed Street', purchase_price: 100,
      firm_reference: 'FRM-1', classification_code: CLASSIFICATION.canonicalCode,
      client_request_id: '66666666-6666-4666-8666-666666666666',
    })
    const [, init] = fetchMock.mock.calls[0].arguments as unknown as [string, RequestInit]
    const sent = JSON.parse(init.body as string)
    assert.equal(sent.classification_code, CLASSIFICATION.canonicalCode)
    assert.equal(sent.firm_reference, 'FRM-1')
    assert.equal(sent.client_request_id, '66666666-6666-4666-8666-666666666666')
  })
})

describe('staff list API boundary', () => {
  const pagination = { page: 2, limit: 1, total: 7, totalPages: 7 }
  const statusTotals = { total: 20, inProgress: 13, completed: 7 }

  it('sends the canonical filter and preserves server pagination and institution totals', async () => {
    const fetchMock = respond({ message: 'OK', data: {
      transfers: [{ ...DETAIL, status: 'complete' }], pagination, statusTotals,
    } })
    const response = await TransferApi.getTransfers({ status: 'complete', page: 2, limit: 1 })
    assert.equal(fetchMock.mock.calls[0].arguments[0], '/api/v1/transfers?page=2&limit=1&status=complete')
    assert.equal(response.data?.length, 1)
    assert.equal(response.data?.[0].status, 'completed')
    assert.deepEqual(response.pagination, pagination)
    assert.deepEqual(response.statusTotals, statusTotals)
  })

  it('does not apply a second page-local status filter', async () => {
    respond({ message: 'OK', data: { transfers: [DETAIL], pagination, statusTotals } })
    const response = await TransferApi.getTransfers({ status: 'complete' })
    assert.equal(response.data?.length, 1)
  })

  it('preserves empty pages without resetting totals, and never fabricates missing totals', async () => {
    respond({ message: 'OK', data: { transfers: [], pagination, statusTotals } })
    assert.deepEqual((await TransferApi.getTransfers()).statusTotals, statusTotals)
    mock.restoreAll()
    respond({ message: 'OK', data: { transfers: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } } })
    assert.equal((await TransferApi.getTransfers()).statusTotals, null)
  })

  it('fails on missing list metadata, malformed counts and service errors rather than inventing page counts', async () => {
    for (const data of [{}, { transfers: [] }, { transfers: [], pagination, statusTotals: { total: -1 } }]) {
      mock.restoreAll()
      respond({ message: 'OK', data })
      await assert.rejects(TransferApi.getTransfers(), /Invalid transfer list response/)
    }
    mock.restoreAll()
    respond({ error: 'Unavailable' }, 503)
    await assert.rejects(TransferApi.getTransfers(), ApiRequestError)
  })
})

describe('matter core API boundary', () => {
  it('getMatterCore reads the v1 detail route', async () => {
    const fetchMock = respond({ message: 'OK', data: DETAIL })
    const response = await TransferApi.getMatterCore(TRANSFER_ID)
    const [url, init] = fetchMock.mock.calls[0].arguments as unknown as [string, RequestInit]
    assert.equal(url, `/api/v1/transfers/${TRANSFER_ID}`)
    assert.equal(init.method ?? 'GET', 'GET')
    assert.equal(response.data?.matter?.firmReference, 'FRM-1')
  })

  it('updateMatterCore echoes both version tokens verbatim, microseconds intact', async () => {
    const fetchMock = respond({ message: 'OK', data: DETAIL })
    await TransferApi.updateMatterCore(TRANSFER_ID, {
      expected_updated_at: T_TS,
      expected_matter_updated_at: M_TS,
      property_address: '99 New Road',
      firm_reference: null,
    })
    const [url, init] = fetchMock.mock.calls[0].arguments as unknown as [string, RequestInit]
    assert.equal(url, `/api/v1/transfers/${TRANSFER_ID}`)
    assert.equal(init.method, 'PATCH')
    const sent = JSON.parse(init.body as string)
    assert.equal(sent.expected_updated_at, T_TS)
    assert.equal(sent.expected_matter_updated_at, M_TS)
    assert.equal(sent.firm_reference, null)
    assert.equal('purchase_price' in sent, false)
  })

  it('surfaces a 409 stale-version conflict as a typed error the UI can key on', async () => {
    respond({ success: false, error: 'Matter was modified by another user; reload and retry' }, 409)
    await assert.rejects(
      TransferApi.updateMatterCore(TRANSFER_ID, {
        expected_updated_at: T_TS,
        expected_matter_updated_at: M_TS,
        property_address: 'X',
      }),
      (error: unknown) => error instanceof ApiRequestError && error.status === 409
    )
  })

  it('never reports success on a failed save (503/500 surface as errors)', async () => {
    respond({ success: false, error: 'Matter service temporarily unavailable' }, 503)
    await assert.rejects(
      TransferApi.updateMatterCore(TRANSFER_ID, {
        expected_updated_at: T_TS,
        expected_matter_updated_at: M_TS,
        property_address: 'X',
      }),
      (error: unknown) => error instanceof ApiRequestError && error.status === 503
    )
  })
})
