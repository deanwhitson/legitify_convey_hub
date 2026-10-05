import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:4192'
const origin = new URL(BASE).origin
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(BASE).hostname), 'Use a loopback static build')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const milestone = name => ({ id: `milestone-${name}`, name: `${name} milestone`, statusLabel: 'Recorded label', status: 'completed', sequenceNumber: 1, notes: `${name} notes`, dueDate: '2026-01-01', completedDate: '2026-01-02' })
const event = name => ({ id: `event-${name}`, user: null, action: `${name} activity`, timestamp: '2026-01-01T00:00:00Z' })
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const result = (resource, rows) => json({ message: 'OK', data: { [resource]: rows } })
const browser = await chromium.launch()
let passed = 0
let failed = 0

async function scenario(name, run) {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  context.setDefaultTimeout(8000)
  const requests = []
  const errors = []
  const state = { allowCorePatch: false, title: 'Synthetic matter', replies: new Map(), holds: new Map() }
  for (const [id, label] of [[A, 'A'], [B, 'B']]) {
    state.replies.set(`${id}/milestones`, result('milestones', [milestone(label)]))
    state.replies.set(`${id}/activity`, result('activity', [event(label)]))
  }
  const hold = (id, resource) => {
    let started, release
    const requested = new Promise(resolve => { started = resolve })
    const response = new Promise(resolve => { release = resolve })
    state.holds.set(`${id}/${resource}`, { started, response })
    return { requested, release }
  }
  await context.addCookies([{ name: 'deedly_sid', value: 'synthetic-milestone-sid', url: BASE }])
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    requests.push({ method: request.method(), path: url.pathname })
    if (url.pathname === '/api/auth/refresh') return route.fulfill(json({ message: 'OK', data: {
      principalKey: 'a'.repeat(64), token: 'synthetic-milestone-access', expires: Math.floor(Date.now() / 1000) + 3600,
    } }))
    const match = url.pathname.match(/^\/api\/v1\/transfers\/([^/]+)(?:\/(.*))?$/)
    if (!match) return route.fulfill(json({ error: 'Unavailable mocked route; no network fallback' }, 503))
    const [, id, resource = ''] = match
    const pending = state.holds.get(`${id}/${resource}`)
    if (pending) {
      state.holds.delete(`${id}/${resource}`)
      pending.started()
      return route.fulfill(await pending.response)
    }
    if (!resource) {
      if (request.method() === 'PATCH' && state.allowCorePatch) state.title = JSON.parse(request.postData()).title
      else if (request.method() !== 'GET') return route.fulfill(json({ error: 'Unsupported mutation' }, 503))
      return route.fulfill(json({ message: 'OK', data: {
        id, transferId: id === A ? 'SYN-A' : 'SYN-B', propertyAddress: id === A ? 'Synthetic A address' : 'Synthetic B address',
        purchasePrice: 100, status: 'in_progress', updatedAt: '2026-01-01T00:00:00Z',
        matter: { id: id === A ? '44444444-4444-4444-8444-444444444444' : '55555555-5555-4555-8555-555555555555',
          matterType: 'transfer', title: state.title, firmReference: null, status: 'in_progress', updatedAt: '2026-01-01T00:00:00Z' },
      } }))
    }
    if (resource === 'properties') return route.fulfill(result('properties', []))
    if (state.replies.has(`${id}/${resource}`)) return route.fulfill(state.replies.get(`${id}/${resource}`))
    return route.fulfill(json({ error: 'Unavailable mocked route; no network fallback' }, 503))
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const overview = page.getByRole('region', { name: 'Recorded milestone overview' })
  const activity = page.getByRole('region', { name: 'Recorded activity' })
  const rows = () => overview.locator('table[aria-label="Recorded milestones"] tbody tr')
  const goto = id => page.goto(`${BASE}/transfers/${id}/milestones`)
  const switchTo = id => page.evaluate(url => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')) }, `/transfers/${id}/milestones`)
  try {
    await run({ page, state, requests, hold, overview, activity, rows, goto, switchTo })
    assert.deepEqual(errors, [])
    assert.equal(requests.some(r => r.path.startsWith('/api/transfers/')), false, 'No legacy workflow requests')
    const writes = requests.filter(r => r.method !== 'GET' && r.path !== '/api/auth/refresh')
    assert.deepEqual(writes, state.allowCorePatch ? [{ method: 'PATCH', path: `/api/v1/transfers/${A}` }] : [])
    console.log(`PASS ${name}`)
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`)
    failed += 1
  } finally {
    await context.close()
  }
}

console.log('Synthetic browser tests only: all API/auth requests intercepted, external requests blocked; no database or providers.')

await scenario('loading and empty reads never invent milestones or activity', async ({ page, hold, goto, overview, activity, rows }) => {
  const milestones = hold(A, 'milestones')
  const events = hold(A, 'activity')
  await goto(A)
  await Promise.all([milestones.requested, events.requested])
  await overview.getByText('Loading recorded milestones...').waitFor()
  await activity.getByText('Loading recorded activity...').waitFor()
  assert.equal(await rows().count(), 0)
  assert.equal(await overview.getByText('Instruction', { exact: true }).count(), 0)
  milestones.release(result('milestones', []))
  events.release(result('activity', []))
  await overview.getByText(/No recorded milestones were returned/).waitFor()
  await activity.getByText('No recorded activity was returned.').waitFor()
  assert.equal(await rows().count(), 0)
  assert.equal(await overview.getByText('Overall Progress').count(), 0)
  assert.equal(await activity.getByText('John Doe').count(), 0)
})

await scenario('returned records preserve order and expose no milestone editors', async ({ page, state, goto, overview, activity }) => {
  state.replies.set(`${A}/milestones`, result('milestones', [milestone('First'), { ...milestone('Second'), name: 'Instruction' }]))
  await goto(A)
  await overview.getByRole('button', { name: 'First milestone', exact: true }).waitFor()
  assert.deepEqual(await overview.locator('tbody button').allTextContents(), ['First milestone', 'Instruction'])
  await activity.getByText('Actor not recorded').waitFor()
  await overview.getByRole('button', { name: 'First milestone', exact: true }).click()
  await page.getByText('Read-only milestone record', { exact: true }).waitFor()
  const modal = page.locator('.fixed.inset-0.z-50')
  assert.equal(await modal.locator('input, select, textarea').count(), 0)
  await modal.getByText('First notes', { exact: true }).waitFor()
  await modal.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(await page.getByText(/required milestones completed|Overall Progress/).count(), 0)
})

for (const resource of ['milestones', 'activity']) {
  for (const failure of [403, 404, 409, 500, 'malformed']) {
    await scenario(`${resource} ${failure} is independent of the other successful read`, async ({ state, goto, overview, activity }) => {
      state.replies.set(`${A}/${resource}`, failure === 'malformed' ? json({ message: 'OK', data: {} }) : json({ error: 'Synthetic unavailable' }, failure))
      await goto(A)
      if (resource === 'milestones') {
        await overview.getByText('Milestones are temporarily unavailable.', { exact: true }).waitFor()
        await activity.getByText('A activity', { exact: true }).waitFor()
        assert.equal(await overview.getByText(/No recorded milestones/).count(), 0)
      } else {
        await activity.getByText('Activity is temporarily unavailable.', { exact: true }).waitFor()
        await overview.getByRole('button', { name: 'A milestone', exact: true }).waitFor()
        await activity.getByText(/current permissions or service configuration/).waitFor()
        assert.equal(await activity.getByText('No recorded activity was returned.').count(), 0)
      }
    })
  }
}

await scenario('independent retries can recover to empty without fabricating rows', async ({ state, goto, overview, activity }) => {
  for (const resource of ['milestones', 'activity']) state.replies.set(`${A}/${resource}`, json({ error: 'Unavailable' }, 503))
  await goto(A)
  await overview.getByRole('button', { name: 'Retry milestones' }).waitFor()
  await activity.getByRole('button', { name: 'Retry activity' }).waitFor()
  state.replies.set(`${A}/milestones`, result('milestones', []))
  await overview.getByRole('button', { name: 'Retry milestones' }).click()
  await overview.getByText(/No recorded milestones were returned/).waitFor()
  await activity.getByText('Activity is temporarily unavailable.', { exact: true }).waitFor()
  state.replies.set(`${A}/activity`, result('activity', []))
  await activity.getByRole('button', { name: 'Retry activity' }).click()
  await activity.getByText('No recorded activity was returned.').waitFor()
})

await scenario('switching matters clears previous records and the open detail immediately', async ({ page, state, goto, switchTo, hold, overview, activity }) => {
  await goto(A)
  await overview.getByRole('button', { name: 'A milestone', exact: true }).click()
  await activity.getByText('A activity', { exact: true }).waitFor()
  const milestones = hold(B, 'milestones')
  const events = hold(B, 'activity')
  await switchTo(B)
  await Promise.all([milestones.requested, events.requested])
  await overview.getByText('Loading recorded milestones...').waitFor()
  assert.equal(await page.getByText('Read-only milestone record', { exact: true }).count(), 0)
  assert.equal(await page.getByText('A activity', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'A milestone', exact: true }).count(), 0)
  milestones.release(result('milestones', []))
  events.release(result('activity', []))
  await overview.getByText(/No recorded milestones were returned/).waitFor()
  await activity.getByText('No recorded activity was returned.').waitFor()
})

for (const resource of ['milestones', 'activity']) {
  for (const status of [200, 503]) {
    await scenario(`late ${resource} ${status} from A cannot overwrite B`, async ({ page, hold, goto, switchTo, overview, activity }) => {
      const pending = hold(A, resource)
      await goto(A)
      await pending.requested
      await switchTo(B)
      await overview.getByRole('button', { name: 'B milestone', exact: true }).waitFor()
      await activity.getByText('B activity', { exact: true }).waitFor()
      const response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/transfers/${A}/${resource}`)
      pending.release(status === 200 ? result(resource, resource === 'milestones' ? [milestone('Late A')] : [event('Late A')]) : json({ error: 'Late failure' }, status))
      await response
      await page.waitForTimeout(100)
      assert.equal(await overview.getByRole('button', { name: 'B milestone', exact: true }).count(), 1)
      assert.equal(await activity.getByText('B activity', { exact: true }).count(), 1)
      assert.equal(await page.getByText(/Late A|temporarily unavailable/).count(), 0)
    })
  }
}

await scenario('core edits remain available without fabricating workflow audit events', async ({ page, state, goto, activity }) => {
  state.allowCorePatch = true
  state.replies.set(`${A}/activity`, result('activity', []))
  await goto(A)
  await activity.getByText('No recorded activity was returned.').waitFor()
  await page.getByRole('button', { name: 'View & Edit Details' }).click()
  await page.getByLabel('Matter Title', { exact: true }).fill('Updated synthetic title')
  await page.getByRole('button', { name: 'Save Details', exact: true }).click()
  await page.getByRole('button', { name: 'View & Edit Details' }).waitFor()
  await page.getByRole('button', { name: 'View & Edit Details' }).click()
  assert.equal(await page.getByLabel('Matter Title', { exact: true }).inputValue(), 'Updated synthetic title')
  assert.equal(await activity.getByText(/John Doe|Updated matter title, firm reference/).count(), 0)
  await activity.getByText('No recorded activity was returned.').waitFor()
})

await browser.close()
console.log(`Milestone overview browser results: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1
