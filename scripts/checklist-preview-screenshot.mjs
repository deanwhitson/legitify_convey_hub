// Local screenshot + interaction check for the checklist preview.
// Usage: node scripts/checklist-preview-screenshot.mjs
// Requires the preview server at BASE (default http://127.0.0.1:4174).
// Asserts: no external requests, scenario switching, combined level+stage
// filters, and mouse/keyboard group toggles. Local-render evidence only.

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://127.0.0.1:4174'
const PAGE = `${BASE}/checklist-preview.html`
const OUT = process.env.OUT_DIR || 'docs/preview-screenshots'

const external = []
const failures = []

function assert(cond, msg) {
  if (!cond) failures.push(`assert: ${msg}`)
}

const browser = await chromium.launch()
const ctx = await browser.newContext()
const page = await ctx.newPage()
page.on('request', req => {
  const u = new URL(req.url())
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) external.push(req.url())
})
page.on('requestfailed', req => failures.push(`requestfailed: ${req.url()}`))
page.on('pageerror', err => failures.push(`pageerror: ${err.message}`))

await page.setViewportSize({ width: 1280, height: 900 })
await page.goto(PAGE, { waitUntil: 'networkidle' })
await page.waitForSelector('text=Document checklist preview')
await page.screenshot({ path: `${OUT}/desktop-1280.png`, fullPage: false })
await page.screenshot({ path: `${OUT}/desktop-1280-full.png`, fullPage: true })

// --- interaction: scenario selection -------------------------------------
const scenario = page.getByLabel('Preview scenario')
await scenario.selectOption('bulk-sectional')
await page.waitForSelector('text=Matter SYNTH-PT-BULK-ST')
const bulkBadge = await page.locator('text=Private Treaty — Bulk Transfer').count()
assert(bulkBadge > 0, 'scenario switch shows Bulk Transfer classification')
await scenario.selectOption('evaluation-unavailable')
await page.waitForSelector('text=unavailable — nothing shown may be read as satisfied')
const unavUnresolved = await page.locator('dt:has-text("Unresolved / unknown") + dd').innerText()
assert(Number(unavUnresolved) === 81, `unavailable scenario unresolved=81, got ${unavUnresolved}`)
await scenario.selectOption('pt-na-sectional')
await page.waitForSelector('text=Matter SYNTH-PT-NA-ST')

// --- interaction: combined level + stage filters --------------------------
await page.getByLabel('Filter by obligation level').selectOption('required')
await page.getByLabel('Filter by due stage').selectOption('Before lodgement')
await page.waitForTimeout(150)
const rows = page.locator('li[data-doc-id]')
const rowCount = await rows.count()
assert(rowCount > 0, 'combined filters leave visible rows')
for (let i = 0; i < rowCount; i++) {
  const lvl = await rows.nth(i).getAttribute('data-level')
  assert(lvl === 'required', `filtered row ${i} has level=required, got ${lvl}`)
}
assert(await page.locator('text=Clear filters').count() === 1, 'Clear filters appears')
await page.screenshot({ path: `${OUT}/desktop-1280-filtered.png`, fullPage: false })
await page.locator('text=Clear filters').click()
await page.waitForTimeout(150)

// --- interaction: group toggles (mouse + keyboard) ------------------------
const firstToggle = page.locator('button[aria-expanded]').first()
assert(await firstToggle.getAttribute('aria-expanded') === 'true', 'group starts expanded')
await firstToggle.click()
assert(await firstToggle.getAttribute('aria-expanded') === 'false', 'click collapses group')
await firstToggle.click()
await firstToggle.focus()
await page.keyboard.press('Enter')
assert(await firstToggle.getAttribute('aria-expanded') === 'false', 'Enter key toggles group')
await page.keyboard.press('Enter')
assert(await firstToggle.getAttribute('aria-expanded') === 'true', 'Enter key re-expands group')

// --- narrow viewport ------------------------------------------------------
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(300)
assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  'narrow viewport has no horizontal overflow')
for (const select of await page.locator('select').all()) {
  const box = await select.boundingBox()
  assert(box && box.x >= 0 && box.x + box.width <= 390, 'narrow select fits viewport')
}
await page.screenshot({ path: `${OUT}/narrow-390.png`, fullPage: false })
await page.screenshot({ path: `${OUT}/narrow-390-full.png`, fullPage: true })

await browser.close()

if (external.length || failures.length) {
  if (external.length) console.error('EXTERNAL REQUESTS:', external)
  if (failures.length) console.error('FAILURES:', failures)
  process.exit(1)
}
console.log(`Interaction checks passed; screenshots in ${OUT}; no external requests.`)
