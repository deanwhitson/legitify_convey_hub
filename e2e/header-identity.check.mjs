// DEEDLY-257 — mounted header identity checks. Requires a loopback Vite DEV
// server (BASE env; default port 4293) because in-page assertions drive the
// app's real session module by its loaded URL, like session-isolation.check.
// All API/auth traffic is intercepted; external requests are aborted.

import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:4293'
const origin = new URL(BASE).origin
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(BASE).hostname), 'Use a loopback Vite development server')
const key = name => (name === 'A' ? 'a' : 'b').repeat(64)
const json = body => ({ contentType: 'application/json', body: JSON.stringify(body) })
const browser = await chromium.launch()
let passed = 0
let failed = 0

async function sessionModuleUrl(page) {
  const url = await page.evaluate(() => performance.getEntriesByType('resource')
    .map(entry => entry.name).find(name => new URL(name).pathname === '/src/lib/api/session.ts'))
  assert.ok(url, 'The app must have loaded its real session module')
  return url
}

async function uiLogin(page, state, login) {
  state.nextLogin = login
  await page.getByPlaceholder('13-digit ID number').fill('9002024800081')
  await page.locator('input[type="password"]').fill('synthetic-only')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByPlaceholder('6-digit code').fill('123456')
  await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click()
}

async function scenario(name, run, { cookie = true } = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  context.setDefaultTimeout(10000)
  context.setDefaultNavigationTimeout(30000)
  if (cookie) await context.addCookies([{ name: 'deedly_sid', value: 'sid-A', url: BASE }])
  const state = { nextLogin: null, requests: 0 }
  const errors = []
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/auth/refresh') {
      const sid = request.headers()['x-deedly-session']
      const name = sid === 'sid-B' ? 'B' : 'A'
      return route.fulfill(json({ message: 'OK', data: { token: `token-${name}`, expires: 9999999999, principalKey: key(name) } }))
    }
    if (url.pathname === '/api/auth/logout') return route.fulfill(json({ success: true }))
    if (url.pathname === '/api/auth/initiate-login') return route.fulfill(json({ data: { requires_otp: true, user_id: 2 } }))
    if (url.pathname === '/api/auth/otp') return route.fulfill(json({ data: { confirmation_pin: 'SYNTHETIC' } }))
    if (url.pathname === '/api/auth/login') {
      const login = state.nextLogin ?? { sid: 'sid-A', principal: 'A', user: { id: 2 } }
      await context.addCookies([{ name: 'deedly_sid', value: login.sid, url: BASE }])
      return route.fulfill(json({ message: 'OK', data: {
        sid: login.sid, principalKey: key(login.principal), token: `token-${login.principal}`,
        expires: 9999999999, user: login.user,
      } }))
    }
    if (url.pathname === '/api/v1/transfers') {
      state.requests += 1
      return route.fulfill(json({ message: 'OK', data: {
        transfers: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 1 },
        statusTotals: { total: 0, inProgress: 0, completed: 0 },
      } }))
    }
    return route.fulfill({ ...json({ error: 'Synthetic unavailable service' }), status: 503 })
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const header = page.locator('header')
  const install = async session => {
    const moduleUrl = await sessionModuleUrl(page)
    await page.evaluate(async ({ moduleUrl, session: next }) => {
      const sessionModule = await import(moduleUrl)
      sessionModule.setSession({ accessToken: 'token-inline', expires: 9999999999, user: next.user, sid: next.sid, principalKey: next.principalKey })
    }, { moduleUrl, session })
  }
  try {
    await page.goto(BASE + '/transfers', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await run({ page, context, state, header, install })
    assert.deepEqual(errors, [])
    assert.equal(await header.getByText('John Doe').count(), 0, 'placeholder name must never render')
    assert.equal(await header.getByText('Senior Partner').count(), 0, 'placeholder role must never render')
    passed++
    console.log('PASS ' + name)
  } catch (error) {
    failed++
    console.error('FAIL ' + name + ': ' + error.message)
  } finally {
    await context.close()
  }
}

const JANE = { name: 'Jane Naidoo', role_name: 'Conveyancer', accountable_institution_name: 'Example Attorneys' }
const PIETER = { first_name: 'Pieter', surname: 'Botha' }

try {
  await scenario('a session restored from the cookie pair has no user: neutral fallback renders', async ({ page, state, header }) => {
    // Refresh returns token + principalKey only; nothing user-shaped exists.
    await header.getByText('Signed-in user', { exact: true }).waitFor()
    assert.equal(await page.getByText('[object Object]').count(), 0)
  })

  await scenario('verified login name and role subtitle render; nothing is fabricated', async ({ page, state, header }) => {
    await uiLogin(page, state, { sid: 'sid-A', principal: 'A', user: JANE })
    await header.getByText('Jane Naidoo', { exact: true }).waitFor()
    await header.getByText('Conveyancer · Example Attorneys', { exact: true }).waitFor()
  }, { cookie: false })

  await scenario('mounted header replaces identity on same-tab account switch', async ({ page, context, state, header, install }) => {
    await uiLogin(page, state, { sid: 'sid-A', principal: 'A', user: JANE })
    await header.getByText('Jane Naidoo', { exact: true }).waitFor()
    await context.addCookies([{ name: 'deedly_sid', value: 'sid-B', url: BASE }])
    await install({ sid: 'sid-B', principalKey: key('B'), user: PIETER })
    await header.getByText('Pieter Botha', { exact: true }).waitFor()
    assert.equal(await header.getByText('Jane Naidoo').count(), 0)
    assert.equal(await header.getByText(/Conveyancer|Example Attorneys/).count(), 0)
  }, { cookie: false })

  await scenario('same-session identity update refreshes the mounted header in place', async ({ page, state, header, install }) => {
    await uiLogin(page, state, { sid: 'sid-A', principal: 'A', user: JANE })
    await header.getByText('Jane Naidoo', { exact: true }).waitFor()
    const generation = await page.evaluate(async moduleUrl =>
      (await import(moduleUrl)).getSessionGeneration(), await sessionModuleUrl(page))
    await install({ sid: 'sid-A', principalKey: key('A'), user: { name: 'Martha Khumalo' } })
    await header.getByText('Martha Khumalo', { exact: true }).waitFor()
    assert.equal(await header.getByText('Jane Naidoo').count(), 0)
    const after = await page.evaluate(async moduleUrl =>
      (await import(moduleUrl)).getSessionGeneration(), await sessionModuleUrl(page))
    assert.equal(after, generation, 'same sid+principal must not remount the session subtree')
  }, { cookie: false })

  await scenario('sign out and re-login renders the new account identity', async ({ page, state, header }) => {
    await uiLogin(page, state, { sid: 'sid-A', principal: 'A', user: JANE })
    await header.getByText('Jane Naidoo', { exact: true }).waitFor()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Personal Profile', exact: true }).click()
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click()
    await page.getByRole('heading', { name: 'DEEDLY', exact: true }).waitFor()
    assert.equal(await page.getByText('Jane Naidoo').count(), 0)
    await uiLogin(page, state, { sid: 'sid-B', principal: 'B', user: PIETER })
    await header.getByText('Pieter Botha', { exact: true }).waitFor()
    assert.equal(await page.getByText('Jane Naidoo').count(), 0)
  }, { cookie: false })

  await scenario('a mid-session clear drops the mounted header identity immediately', async ({ page, state, header }) => {
    await uiLogin(page, state, { sid: 'sid-A', principal: 'A', user: JANE })
    await header.getByText('Jane Naidoo', { exact: true }).waitFor()
    await page.evaluate(async moduleUrl => (await import(moduleUrl)).clearSession(), await sessionModuleUrl(page))
    await page.getByRole('heading', { name: 'DEEDLY', exact: true }).waitFor()
    assert.equal(await page.getByText('Jane Naidoo').count(), 0)
    assert.equal(await header.count(), 0, 'header unmounts with the session')
  }, { cookie: false })

  await scenario('malformed login identity renders the neutral fallback, never coerced text', async ({ page, state, header }) => {
    await uiLogin(page, state, { sid: 'sid-A', principal: 'A', user: { name: { display: 'Jane' }, first_name: ['Jane'], role_name: 42, email: null } })
    await header.getByText('Signed-in user', { exact: true }).waitFor()
    assert.equal(await page.getByText('[object Object]').count(), 0)
    assert.equal(await header.getByText('Jane').count(), 0)
    assert.equal(await header.getByText('42').count(), 0)
  }, { cookie: false })

  await scenario('post-reload restored session shows the neutral fallback', async ({ page, state, header }) => {
    await uiLogin(page, state, { sid: 'sid-A', principal: 'A', user: JANE })
    await header.getByText('Jane Naidoo', { exact: true }).waitFor()
    await page.reload({ waitUntil: 'domcontentloaded' })
    // Refresh restores token + principalKey only; no user payload exists.
    await header.getByText('Signed-in user', { exact: true }).waitFor()
    assert.equal(await header.getByText('Jane Naidoo').count(), 0)
  }, { cookie: false })
} finally {
  await browser.close()
}
console.log(`Header identity: ${passed} passed, ${failed} failed. Mocked auth/API only; no live services.`)
process.exitCode = failed ? 1 : 0
