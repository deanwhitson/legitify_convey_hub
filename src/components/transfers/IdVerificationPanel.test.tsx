import assert from 'node:assert/strict'
import { describe, it, mock, afterEach } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { IdVerificationPanel, IdVerificationStatusView } from './IdVerificationPanel'
import type { IdVerificationStatusData } from '@/lib/api/idVerification'

const PANEL_PROPS = {
  transferId: '11111111-1111-1111-1111-111111111111',
  subjectPartyId: '22222222-2222-2222-2222-222222222222',
  subjectName: 'Synthetic Subject',
  onClose: () => {},
}

function statusData(overrides: Partial<IdVerificationStatusData> = {}): IdVerificationStatusData {
  return {
    status: 'pending',
    attempt: null,
    environment: 'fixture',
    simulated: true,
    checks: [],
    subjectKind: 'party',
    ...overrides,
  }
}

afterEach(() => mock.restoreAll())

describe('IdVerificationPanel', () => {
  it('first paint shows the selected subject and a loading state', () => {
    const html = renderToStaticMarkup(createElement(IdVerificationPanel, PANEL_PROPS))
    assert.ok(html.includes('Synthetic Subject'))
    assert.ok(html.includes('Loading verification status'))
    assert.ok(html.includes('does not mark any checklist item'))
  })

  it('shows the on-behalf-of label for a representative subject', () => {
    const html = renderToStaticMarkup(createElement(IdVerificationPanel, {
      ...PANEL_PROPS,
      onBehalfOfPartyId: '33333333-3333-3333-3333-333333333333',
      onBehalfOfName: 'Acme Pty Ltd',
    }))
    assert.ok(html.includes('on behalf of Acme Pty Ltd'))
  })

  it('status view labels simulated results explicitly', () => {
    const html = renderToStaticMarkup(
      createElement(IdVerificationStatusView, { data: statusData({ status: 'verified' }) })
    )
    assert.ok(html.includes('Verified'))
    assert.ok(html.includes('Simulated — not a real verification'))
    assert.ok(html.includes('fixture'))
  })

  it('a non-simulated verified result carries no simulated label', () => {
    const html = renderToStaticMarkup(
      createElement(IdVerificationStatusView, {
        data: statusData({ status: 'verified', simulated: false, environment: 'sandbox' }),
      })
    )
    assert.ok(html.includes('Verified'))
    assert.ok(!html.includes('Simulated'))
  })

  it('retry and decline states offer a retry action, not a verified state', () => {
    for (const status of ['retry_requested', 'declined'] as const) {
      const html = renderToStaticMarkup(
        createElement(IdVerificationStatusView, { data: statusData({ status }) })
      )
      assert.ok(html.includes('Retry verification'), status)
      assert.ok(!html.includes('Verified'), status)
    }
  })

  it('not_started offers start; pending offers resume', () => {
    const notStarted = renderToStaticMarkup(
      createElement(IdVerificationStatusView, { data: statusData({ status: 'not_started' }) })
    )
    assert.ok(notStarted.includes('Start verification'))
    const pending = renderToStaticMarkup(
      createElement(IdVerificationStatusView, { data: statusData({ status: 'pending' }) })
    )
    assert.ok(pending.includes('Resume verification'))
  })
})
