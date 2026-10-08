// Mounted-browser checks for the ID-verification harness.
//
//   npx vite build --config vite.config.idv.ts   (must run first)
//   node scripts/idv-harness-check.mjs
//
// Serves dist-idv/ locally and drives the real IdVerificationEntry +
// IdVerificationPanel through a fully synthetic in-page backend and a mocked
// WebSDK module. Asserts zero non-local requests and zero page errors.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist-idv')
if (!existsSync(path.join(dist, 'idv-harness.html'))) {
  console.error('dist-idv missing — run `npx vite build --config vite.config.idv.ts` first')
  process.exit(1)
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const file = path.join(dist, url.pathname === '/' ? 'idv-harness.html' : url.pathname)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end()
  }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const shots = path.join(root, 'docs', 'id-verification-screenshots')
const errors = []
const external = []
let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS ${name}`)
  else { failures++; console.error(`  FAIL ${name} ${extra}`) }
}

const PARTY_A = '22222222-2222-2222-2222-222222222222'
const PARTY_B = '33333333-3333-3333-3333-333333333333'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } })
const page = await ctx.newPage()
page.on('pageerror', e => errors.push(String(e)))
page.on('request', r => {
  const u = r.url()
  if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u)
})

const emit = (type, payload) => page.evaluate(([t, p]) => window.__sdkEmit?.(t, p), [type, payload])
const idv = (fn, ...args) => page.evaluate(([f, a]) => window.__idv[f](...a), [fn, args])
const shot = name => page.screenshot({ path: path.join(shots, `harness-${name}.png`), fullPage: false })

await page.goto(base, { waitUntil: 'networkidle' })
check('harness banner renders', await page.locator('text=ID-verification demo harness').count() === 1)

// --- Scenario 1: open from party entry, start, SDK stays mounted on progress
const cardA = page.locator('div.rounded-xl', { hasText: 'Synthetic Person Alpha' })
await cardA.getByRole('button', { name: 'Verify identity' }).click()
check('panel opens from party entry', await cardA.locator('text=Identity verification').count() === 1)
check('initial status is Not started', await cardA.locator('text=Not started').count() >= 1)

await cardA.getByRole('button', { name: 'Start verification' }).click()
await page.waitForSelector('[data-testid="mock-sumsub-sdk"]', { timeout: 5000 })
check('sandbox capture mounts mocked WebSDK', true)

await emit('idCheck.onReady')
await emit('idCheck.onStepCompleted', { step: 'idDocSet' })
await emit('idCheck.onApplicantLoaded')
await page.waitForTimeout(300)
check('capture stays mounted through progress messages',
  await page.locator('[data-testid="mock-sumsub-sdk"]').count() === 1)

// General status-change messages carry reviewStatus/reviewResult and are
// NOT completion — they must keep the SDK mounted even with final-looking
// or resubmission payloads.
await emit('idCheck.onApplicantStatusChanged', { reviewStatus: 'awaitingUser' })
await emit('idCheck.applicantStatus', { reviewStatus: 'init' })
await emit('idCheck.onApplicantStatusChanged',
  { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' } })
await page.waitForTimeout(300)
check('capture stays mounted through general status-change messages',
  await page.locator('[data-testid="mock-sumsub-sdk"]').count() === 1)
await shot('01-progress-stays-mounted')

// token expiry → expirationHandler hits the refresh endpoint
await page.evaluate(() => window.__sdkExpire())
await page.waitForTimeout(300)
const refreshCalls = await page.evaluate(() => window.__idv.calls.filter(c => c.url.includes('/refresh')).length)
check('expirationHandler calls the refresh endpoint', refreshCalls >= 1)
check('capture still mounted after token renewal',
  await page.locator('[data-testid="mock-sumsub-sdk"]').count() === 1)

// documented completion event → leaves capture → status view
await emit('idCheck.onApplicantVerificationCompleted')
await page.waitForTimeout(400)
check('completion signal leaves the capture view',
  await page.locator('[data-testid="mock-sumsub-sdk"]').count() === 0)
check('status view restored after completion', await cardA.locator('text=Refresh status').count() === 1)

// event → status update (webhook-driven world simulated by inject + refresh)
await idv('inject', PARTY_A, { reviewAnswer: 'GREEN' })
await cardA.getByRole('button', { name: 'Refresh status' }).click()
await page.waitForTimeout(300)
check('applied event shows Verified', await cardA.locator('text=Verified').count() >= 1)
await shot('02-verified')

// reload persists server-side state (sessionStorage store)
await page.reload({ waitUntil: 'networkidle' })
const cardA2 = page.locator('div.rounded-xl', { hasText: 'Synthetic Person Alpha' })
await cardA2.getByRole('button', { name: 'Verify identity' }).click()
await page.waitForTimeout(300)
check('verified state survives reload', await cardA2.locator('text=Verified').count() >= 1)

// subject switch — party B never shows A's result
const cardB = page.locator('div.rounded-xl', { hasText: 'Synthetic Person Beta' })
await cardB.getByRole('button', { name: 'Verify identity' }).click()
await page.waitForTimeout(300)
check('subject switch shows B\'s own state (Not started)',
  await cardB.locator('text=Not started').count() >= 1 &&
  await cardB.locator('text=Verified').count() === 0)

// representative flow — entity selects a person subject
const cardC = page.locator('div.rounded-xl', { hasText: 'Synthetic Entity Ltd' })
await cardC.getByRole('button', { name: 'Verify representative' }).click()
await cardC.locator('select').selectOption({ value: PARTY_B })
await page.waitForTimeout(300)
check('representative panel names the entity', await cardC.locator('text=on behalf of Synthetic Entity Ltd').count() === 1)

// cancel path — start capture on B then emit a cancel signal
await cardC.getByRole('button', { name: 'Start verification' }).click()
await page.waitForSelector('[data-testid="mock-sumsub-sdk"]')
await emit('idCheck.onCancel')
await page.waitForTimeout(400)
check('cancel signal returns to status view', await page.locator('[data-testid="mock-sumsub-sdk"]').count() === 0)

// fixture mode — simulated capture, labelled, no SDK mount (clean reload first)
await page.reload({ waitUntil: 'networkidle' })
await idv('setMode', 'fixture')
await idv('reset')
const cardA3 = page.locator('div.rounded-xl', { hasText: 'Synthetic Person Alpha' })
await cardA3.getByRole('button', { name: 'Verify identity' }).click()
await cardA3.getByRole('button', { name: 'Start verification' }).click()
await page.waitForTimeout(400)
check('fixture mode shows labelled simulated capture, not the SDK',
  await cardA3.locator('[data-testid="fixture-capture"]').count() === 1 &&
  await page.locator('[data-testid="mock-sumsub-sdk"]').count() === 0)
await shot('03-fixture-simulated')

// narrow layout
await page.setViewportSize({ width: 390, height: 700 })
await page.waitForTimeout(200)
await shot('04-narrow-390')
check('narrow layout renders panel', await cardA3.locator('text=Identity verification').count() === 1)

await browser.close()
server.close()

console.log(`external requests: ${external.length}, page errors: ${errors.length}`)
if (external.length) console.error('EXTERNAL:', external)
if (errors.length) console.error('PAGE ERRORS:', errors)
check('zero external requests', external.length === 0)
check('zero page errors', errors.length === 0)

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('all harness checks passed')
