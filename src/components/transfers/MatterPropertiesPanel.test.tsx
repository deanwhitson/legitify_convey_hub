import assert from 'node:assert/strict'
import { describe, it, mock, afterEach } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { MatterPropertiesPanel, MatterPropertyLinks } from './MatterPropertiesPanel'
import type { MatterPropertyLinkApi } from '@/lib/api/transferApi'

function respond(data: unknown, status = 200) {
  return mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' }
  }))
}

afterEach(() => mock.restoreAll())

describe('MatterPropertiesPanel', () => {
  it('renders every returned link without inferring a primary or verified property', () => {
    const links = [
      { id: 'l1', propertyKind: 'input', propertyId: 'p1', property: { id: 'p1', streetAddress: 'First saved property', manual: true, status: 'sold', erfNumber: '123', yearBuilt: 2020, legalDescription: 'Saved description' } },
      { id: 'l2', propertyKind: 'input', propertyId: 'p2', property: { id: 'p2', streetAddress: 'Second saved property', manual: false, status: 'active' } },
      { id: 'l3', propertyKind: 'output', propertyId: null, externalPropertyId: 'Synthetic output', property: null },
    ] as MatterPropertyLinkApi[]
    const html = renderToStaticMarkup(createElement(MatterPropertyLinks, { links }))
    assert.equal((html.match(/<li /g) || []).length, 3)
    for (const value of ['First saved property', 'Second saved property', 'Synthetic output', 'sold', 'Saved description', 'Erf 123', 'Built 2020', 'Manually captured — unverified']) assert.ok(html.includes(value), value)
    assert.doesNotMatch(html, /<button|<input|Primary property/)
  })

  it('renders the linked-properties surface with an attach control', () => {
    respond({ message: 'OK', data: { properties: [] } })
    const html = renderToStaticMarkup(createElement(MatterPropertiesPanel, { transferId: 't-1' }))
    assert.match(html, /Linked Properties/)
    assert.match(html, /Attach existing property/)
    assert.match(html, /Capture a property/)
    // SSR render runs no effects; the loading state is the honest first paint.
    assert.match(html, /Loading linked properties/)
  })
})
