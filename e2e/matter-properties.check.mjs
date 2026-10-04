// Playwright check for authenticated matter–property linking with synthetic
// classification/document fixtures. Every /api/** request is intercepted;
// external requests are blocked — no BFF, FastAPI, database, scanner or
// upstream is contacted. Run: `node e2e/matter-properties.check.mjs`
// with a loopback static build server (BASE env var overrides).
import { chromium } from 'playwright'
import assert from 'node:assert/strict'

const BASE = process.env.BASE || 'http://127.0.0.1:4173'
const origin = new URL(BASE).origin
assert.ok(['localhost', '127.0.0.1'].includes(new URL(BASE).hostname), 'Use a loopback static build')
const classification = {
  canonicalCode: 'transfer.donation', subtype: 'donation', displayLabel: 'Donation',
  transferFrom: null, transferFromLabel: null, requiresTransferFrom: false,
}
const pageErrors = []
const MATTER_ID = '11111111-1111-4111-8111-111111111111'
const TRANSFER_ID = 'TRF-PW-001'

const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

// Server-side store simulated by the mocks. attachBodies records every
// POST .../properties body so tests can assert identical-key retries.
function makeApi(t) {
  const calls = { createMatter: [], attachProperty: [], attachParty: [], documentReads: [] }
  const fingerprints = new Map()
  let links = []
  let attachBehaviour = t.attachBehaviour || 'success' // 'success' | 'fail-once' | 'drop-once'
  let attachAttempts = 0
  let createdMatter = null

  const EXISTING = {
    '22222222-2222-4222-8222-222222222221': { streetAddress: '7 Selected Lane', city: 'Cape Town', province: 'Western Cape', postalCode: '8001' },
    '22222222-2222-4222-8222-222222222222': { streetAddress: '21 Protea Road', city: 'Durban', province: 'KwaZulu-Natal', postalCode: '4001' },
  }

  const propertyProjection = (manual, over = {}) => ({
    id: over.id || '33333333-3333-4333-8333-333333333333',
    streetAddress: '14 Jacaranda Avenue',
    city: 'Pretoria',
    province: 'Gauteng',
    postalCode: '0181',
    propertyType: 'Freehold',
    status: 'active',
    manual,
    ...over,
  })

  const projectionForId = (id) => propertyProjection(false, { id, manual: false, ...(EXISTING[id] || {}) })

  const projectionForBody = body => body.property_id ? projectionForId(body.property_id) : propertyProjection(true, {
    streetAddress: body.property.street_address, city: body.property.city, province: body.property.province,
    postalCode: body.property.postal_code, propertyType: body.property.property_type,
    erfNumber: body.property.erf_number, legalDescription: body.property.legal_description, yearBuilt: body.property.year_built,
  })

  const linkRow = (id, property, over = {}) => ({
    id,
    matterId: '44444444-4444-4444-8444-444444444444',
    propertyId: property.id,
    propertyKind: 'input',
    clientRequestId: over.clientRequestId || null,
    property,
    ...over,
  })

  const route = async (r) => {
    const url = new URL(r.request().url())
    const path = url.pathname
    const method = r.request().method()

    if (path === '/api/auth/refresh' && method === 'POST') {
      return r.fulfill(json({ message: 'OK', data: { principalKey: 'a'.repeat(64), token: 'pw-access-token', expires: Math.floor(Date.now() / 1000) + 3600 } }))
    }
    if (path === '/api/v1/transfers/classifications') {
      return r.fulfill(json({ message: 'OK', data: { classifications: [classification] } }))
    }
    if (path === '/api/v1/transfers' && method === 'GET') {
      // Matches the real v1 list contract exactly: { message, data } with
      // no `success` flag. An earlier mock invented success:true, which
      // masked the probeMatterPersistence envelope defect — earlier pass
      // results depended on that inaccuracy.
      return r.fulfill(json({ message: 'OK', data: { transfers: [], pagination: { page: 1, limit: 1, total: 0, totalPages: 0 } } }))
    }
    if (path === '/api/v1/transfers' && method === 'POST') {
      calls.createMatter.push(JSON.parse(r.request().postData() || '{}'))
      if (!calls.createMatter.at(-1).property_address?.trim()) return r.fulfill(json({ detail: 'property_address is required' }, 422))
      createdMatter = { id: MATTER_ID, transferId: TRANSFER_ID, propertyAddress: calls.createMatter.at(-1).property_address }
      return r.fulfill(json({ message: 'Created', data: { ...createdMatter, created: true } }, 201))
    }
    if (path === `/api/v1/transfers/${MATTER_ID}/properties` && method === 'POST') {
      const body = JSON.parse(r.request().postData() || '{}')
      calls.attachProperty.push(body)
      attachAttempts += 1
      if (attachBehaviour === 'fail-once' && attachAttempts === 1) {
        return r.fulfill(json({ message: 'Internal error', errors: ['simulated failure'] }, 500))
      }
      if (attachBehaviour === 'drop-once' && attachAttempts === 1) {
        // Lost response: server commits but the client never sees it.
        links = [linkRow('link-1', projectionForBody(body), { clientRequestId: body.client_request_id })]
        fingerprints.set(body.client_request_id, JSON.stringify(body))
        return r.abort('connectionreset')
      }
      const replay = links.find(l => l.clientRequestId === body.client_request_id)
      if (replay) {
        if (fingerprints.get(body.client_request_id) !== JSON.stringify(body)) return r.fulfill(json({ error: 'client_request_id was already used with a different payload' }, 409))
        return r.fulfill(json({ message: 'OK', data: { ...replay, created: false } }))
      }
      const duplicate = body.property_id && links.find(link => link.propertyId === body.property_id && link.propertyKind === 'input')
      if (duplicate) return r.fulfill(json({ message: 'OK', data: { ...duplicate, created: false } }))
      const link = linkRow(`link-${links.length + 1}`, projectionForBody(body), { clientRequestId: body.client_request_id })
      fingerprints.set(body.client_request_id, JSON.stringify(body))
      links.push(link)
      return r.fulfill(json({ message: 'Created', data: { ...link, created: true } }, 201))
    }
    if (path === `/api/v1/transfers/${MATTER_ID}/properties` && method === 'GET') {
      return r.fulfill(json({ message: 'OK', data: { properties: links } }))
    }
    if (path === `/api/v1/transfers/${MATTER_ID}/parties` && method === 'POST') {
      const body = JSON.parse(r.request().postData() || '{}')
      calls.attachParty.push(body)
      return r.fulfill(json({ message: 'Created', data: { id: `party-${calls.attachParty.length}`, created: true } }, 201))
    }
    if (path === `/api/v1/transfers/${MATTER_ID}/parties` && method === 'GET') {
      return r.fulfill(json({ message: 'OK', data: { parties: [] } }))
    }
    if (path === `/api/v1/transfers/${MATTER_ID}` && method === 'GET') {
      return r.fulfill(json({ message: 'OK', data: {
        id: MATTER_ID, transferId: TRANSFER_ID, propertyAddress: createdMatter?.propertyAddress || '14 Jacaranda Avenue',
        purchasePrice: 1500000, status: 'in_progress', updatedAt: '2026-01-01T00:00:00Z',
        matter: { id: '44444444-4444-4444-8444-444444444444', matterType: 'transfer', title: 'Synthetic matter',
          referenceNumber: 'SYNTHETIC-001', firmReference: null, classificationCode: classification.canonicalCode,
          status: 'in_progress', updatedAt: '2026-01-01T00:00:00Z' },
      } }))
    }
    if (path === '/api/v1/properties' && method === 'GET') {
      return r.fulfill(json({
        message: 'OK',
        data: {
          properties: [projectionForId('22222222-2222-4222-8222-222222222221'), projectionForId('22222222-2222-4222-8222-222222222222')],
        },
      }))
    }
    if (path.endsWith('/documents') && method === 'GET') calls.documentReads.push(path)
    if (path === `/api/v1/transfers/${MATTER_ID}/documents` && method === 'GET') {
      return r.fulfill(json({ message: 'OK', data: {
        documents: [{ id: 'doc-synthetic', transferId: MATTER_ID, name: 'Synthetic property harness document',
          status: 'uploaded', scanStatus: 'clean', requirementKey: null }],
        requirements: [], unevaluatedFacts: [], unevaluatedRules: [],
      } }))
    }
    if (path === `/api/v1/transfers/${MATTER_ID}/milestones` && method === 'GET') {
      return r.fulfill(json({ message: 'OK', data: { milestones: [] } }))
    }
    if (path === `/api/v1/transfers/${MATTER_ID}/activity` && method === 'GET') {
      return r.fulfill(json({ message: 'OK', data: { activity: [] } }))
    }
    if (path === '/api/catalogue') {
      return r.fulfill(json([{ id: 'cat-1', name: 'FICA Identification', module: 'transfers', status: 'Active' }]))
    }
    if (path === `/api/transfers/${TRANSFER_ID}/documents` && method === 'POST') {
      return r.fulfill(json({ success: true, data: { id: 'doc-1', name: 'FICA Identification', type: 'identification', status: 'pending', catalogueDocumentId: 'cat-1' } }))
    }
    if (path.startsWith('/api/address/')) {
      return r.fulfill(json({ error: 'Legacy endpoint unavailable' }, 503))
    }
    if (path === `/api/transfers/${TRANSFER_ID}` || path === `/api/transfers/${MATTER_ID}`) {
      return r.fulfill(json({ success: true, data: { id: MATTER_ID, transfer_id: TRANSFER_ID, property_address: '14 Jacaranda Avenue', purchase_price: 1500000, status: 'active' } }))
    }
    if (path === `/api/transfers/${TRANSFER_ID}/milestones` || path === `/api/transfers/${MATTER_ID}/milestones`) {
      return r.fulfill(json({ success: true, data: [] }))
    }
    if (path === `/api/transfers/${TRANSFER_ID}/activity` || path === `/api/transfers/${MATTER_ID}/activity`) {
      return r.fulfill(json({ success: true, data: [] }))
    }
    console.log(`  [unmocked] ${method} ${path}`)
    return r.fulfill(json({ success: false, error: 'unmocked' }, 404))
  }

  return { route, calls, get links() { return links }, set links(v) { links = v } }
}

async function newAuthedPage(browser, api) {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  context.setDefaultTimeout(8000)
  await context.addCookies([{ name: 'deedly_sid', value: 'pw-sid', url: BASE }])
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    return url.pathname.startsWith('/api/') ? api.route(route) : route.continue()
  })
  const page = await context.newPage()
  page.on('pageerror', error => pageErrors.push(error.message))
  return { context, page }
}

// Fills steps 2–3 (parties and provisional financials) before saving.
async function completeWizardFromStep2(page) {
  await page.getByRole('button', { name: 'Add First Buyer' }).click()
  const buyer = page.locator('div').filter({ hasText: /^Buyer/ }).last()
  await page.getByPlaceholder('Full name').first().fill('Buyer One')
  await page.getByPlaceholder('SA ID or Company Reg').first().fill('8001015009087')
  await page.getByPlaceholder('email@example.com').first().fill('buyer@example.com')
  await page.getByPlaceholder('+27 12 345 6789').first().fill('+27111111111')
  await page.getByRole('button', { name: 'Add First Seller' }).click()
  await page.getByPlaceholder('Full name').nth(1).fill('Seller One')
  await page.getByPlaceholder('SA ID or Company Reg').nth(1).fill('7502025555083')
  await page.getByPlaceholder('email@example.com').nth(1).fill('seller@example.com')
  await page.getByPlaceholder('+27 12 345 6789').nth(1).fill('+27222222222')
  await page.getByRole('button', { name: 'Next Step' }).click()

  await page.getByPlaceholder('2,500,000').fill('1500000')
  await page.getByPlaceholder('250,000', { exact: true }).fill('150000')
  await page.getByRole('button', { name: 'Next Step' }).click()
}

async function saveAndContinue(page, api) {
  // Documents require a saved matter: persist the draft first.
  await page.getByRole('button', { name: 'Save Details' }).click()
  await page.getByText('Matter, property and all parties saved.').waitFor()
  await page.getByText('Synthetic property harness document', { exact: true }).waitFor()
  assert.ok(api.calls.documentReads.length > 0)
  assert.ok(api.calls.documentReads.every(path => path === `/api/v1/transfers/${MATTER_ID}/documents`), 'Document reads must use the transfer UUID, never its display reference')
  await page.getByRole('button', { name: 'Next Step' }).click()
  assert.equal(await page.getByRole('button', { name: 'Submit Transfer' }).count(), 0)
  await page.getByRole('button', { name: 'Save and Continue' }).click()
}

const results = []
const check = async (name, fn) => {
  try {
    pageErrors.length = 0
    await fn()
    assert.deepEqual(pageErrors, [])
    results.push(`PASS ${name}`)
    console.log(`PASS ${name}`)
  } catch (err) {
    results.push(`FAIL ${name}: ${String(err).split('\n')[0]}`)
    console.log(`FAIL ${name}:`, String(err).slice(0, 500))
  } finally {
    for (const context of browser.contexts()) await context.close()
  }
}

const browser = await chromium.launch()

await check('manual capture + wizard completion', async () => {
  const api = makeApi({})
  const { context, page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/workflow`)
  await page.getByLabel('Transfer classification', { exact: true }).selectOption(classification.canonicalCode)
  await page.getByRole('heading', { name: 'Property Details' }).waitFor()
  await page.getByPlaceholder('Start typing the address...').fill('14 Jacaranda Avenue')
  await page.getByPlaceholder('Santon').fill('Pretoria')
  await page.getByPlaceholder('Gouteng').fill('Gauteng')
  await page.getByPlaceholder('2196').fill('0181')
  await page.locator('select').filter({ has: page.locator('option[value="Freehold"]') }).selectOption('Freehold')
  await page.getByRole('button', { name: 'Next Step' }).click()
  await completeWizardFromStep2(page)
  await saveAndContinue(page, api)
  await page.waitForURL(`**/transfers/${MATTER_ID}/milestones`)
  await page.getByRole('list', { name: 'Linked properties' }).getByText('14 Jacaranda Avenue').waitFor()
  await page.getByText('Manually captured — unverified').waitFor()
  assert.equal(api.calls.createMatter.length, 1)
  assert.equal(api.calls.attachProperty.length, 1)
  assert.ok(api.calls.attachProperty[0].property, 'manual capture payload')
  assert.equal(api.calls.attachProperty[0].property.street_address, '14 Jacaranda Avenue')
  assert.equal(api.calls.attachProperty[0].property.source_system, undefined)
  await context.close()
})

await check('select existing property, change it, multiple links on milestones', async () => {
  const api = makeApi({})
  const { context, page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/workflow`)
  await page.getByLabel('Transfer classification', { exact: true }).selectOption(classification.canonicalCode)
  await page.getByPlaceholder("Search your institution's properties by address, city, erf or reference...").fill('lane')
  await page.getByText('7 Selected Lane').waitFor()
  await page.getByText('7 Selected Lane').click()
  await page.getByText('Selected property').waitFor()
  await page.getByRole('button', { name: 'Change' }).click()
  await page.getByPlaceholder("Search your institution's properties by address, city, erf or reference...").fill('protea')
  await page.getByText('21 Protea Road').click()
  await page.getByText('21 Protea Road').waitFor()
  // With the linked flag honoured, Next is enabled without manual fields.
  await page.getByRole('button', { name: 'Next Step' }).click()
  await completeWizardFromStep2(page)
  await saveAndContinue(page, api)
  await page.waitForURL(`**/transfers/${MATTER_ID}/milestones`)
  assert.equal(api.calls.attachProperty.length, 1)
  assert.equal(api.calls.attachProperty[0].property_id, '22222222-2222-4222-8222-222222222222')
  assert.equal(api.calls.createMatter[0].property_address, '21 Protea Road')
  assert.ok(!('property' in api.calls.attachProperty[0]))
  // Attach a second existing property from the milestones panel.
  await page.getByRole('button', { name: 'Attach existing property' }).click()
  await page.getByPlaceholder('Address, city, erf or reference...').fill('lane')
  await page.getByText('7 Selected Lane').waitFor()
  const attachResponse = page.waitForResponse(
    (resp) => resp.url().endsWith(`/api/v1/transfers/${MATTER_ID}/properties`) && resp.request().method() === 'POST',
  )
  await page.getByText('7 Selected Lane').click()
  await attachResponse
  assert.equal(api.calls.attachProperty.length, 2)
  // The panel re-reads the server: both links must render from readback.
  const linksList = page.locator('ul li').filter({ hasText: 'Protea Road' })
  await linksList.waitFor()
  await page.locator('ul li').filter({ hasText: '7 Selected Lane' }).waitFor()
  assert.equal(await page.locator('ul li').filter({ hasText: /Lane|Protea/ }).count(), 2)
  await context.close()
})

await check('failed attach preserves entries and the created matter', async () => {
  const api = makeApi({ attachBehaviour: 'fail-once' })
  const { context, page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/workflow`)
  await page.getByLabel('Transfer classification', { exact: true }).selectOption(classification.canonicalCode)
  await page.getByPlaceholder('Start typing the address...').fill('14 Jacaranda Avenue')
  await page.getByPlaceholder('Santon').fill('Pretoria')
  await page.getByPlaceholder('Gouteng').fill('Gauteng')
  await page.getByPlaceholder('2196').fill('0181')
  await page.locator('select').filter({ has: page.locator('option[value="Freehold"]') }).selectOption('Freehold')
  await page.getByRole('button', { name: 'Next Step' }).click()
  await completeWizardFromStep2(page)
  await page.getByRole('button', { name: 'Save Details' }).click()
  await page.getByText('Property:').waitFor()
  // Entered values and the created matter survive the failed attach.
  await page.getByRole('button', { name: 'Previous' }).click()
  await page.getByRole('button', { name: 'Previous' }).click()
  await page.getByRole('button', { name: 'Previous' }).click()
  assert.equal(await page.getByPlaceholder('Santon').inputValue(), 'Pretoria')
  assert.equal(await page.getByPlaceholder('2196').inputValue(), '0181')
  // Retry: same matter (no second create), same property request key.
  await page.getByRole('button', { name: 'Next Step' }).click()
  await page.getByRole('button', { name: 'Next Step' }).click()
  await page.getByRole('button', { name: 'Next Step' }).click()
  await saveAndContinue(page, api)
  await page.waitForURL(`**/transfers/${MATTER_ID}/milestones`)
  assert.equal(api.calls.createMatter.length, 1, 'matter must not be recreated')
  assert.equal(api.calls.attachProperty.length, 2)
  assert.equal(api.calls.attachProperty[0].client_request_id, api.calls.attachProperty[1].client_request_id)
  await context.close()
})

await check('lost-response retry keeps the key and does not duplicate', async () => {
  const api = makeApi({ attachBehaviour: 'drop-once' })
  const { context, page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/workflow`)
  await page.getByLabel('Transfer classification', { exact: true }).selectOption(classification.canonicalCode)
  await page.getByPlaceholder('Start typing the address...').fill('14 Jacaranda Avenue')
  await page.getByPlaceholder('Santon').fill('Pretoria')
  await page.getByPlaceholder('Gouteng').fill('Gauteng')
  await page.getByPlaceholder('2196').fill('0181')
  await page.locator('select').filter({ has: page.locator('option[value="Freehold"]') }).selectOption('Freehold')
  await page.getByRole('button', { name: 'Next Step' }).click()
  await completeWizardFromStep2(page)
  await page.getByRole('button', { name: 'Save Details' }).click()
  await page.getByText('Property:').waitFor()
  // The server committed the dropped response; the retry must replay it.
  await page.getByRole('button', { name: 'Save Details' }).click()
  await page.getByText('Matter, property and all parties saved.').waitFor()
  assert.equal(api.calls.createMatter.length, 1)
  assert.equal(api.calls.attachProperty.length, 2)
  assert.deepEqual(api.calls.attachProperty[0], api.calls.attachProperty[1], 'identical body on retry')
  assert.equal(api.links.length, 1, 'no duplicate link after replay')
  await context.close()
})

await check('saved-property readback after reload', async () => {
  const api = makeApi({})
  api.links = [{
    id: 'link-1', matterId: MATTER_ID, propertyId: '33333333-3333-4333-8333-333333333333',
    propertyKind: 'input', clientRequestId: 'req-1',
    property: {
      id: '33333333-3333-4333-8333-333333333333', streetAddress: '14 Jacaranda Avenue', city: 'Pretoria',
      province: 'Gauteng', postalCode: '0181', propertyType: 'Freehold',
      status: 'sold', manual: true,
    },
  }]
  const { context, page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/workflow?id=${MATTER_ID}`)
  await page.getByText('Linked property').waitFor()
  await page.getByText('14 Jacaranda Avenue').waitFor()
  await page.getByText('Manually captured — unverified').waitFor()
  await page.getByText('Saved links cannot be removed here').waitFor()
  // Read-only: no capture form, no discovery, no Change control.
  assert.equal(await page.getByPlaceholder('Santon').count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Change' }).count(), 0)
  // Inactive status stays readable.
  await context.close()
})

const savedLink = (id, address, overrides = {}) => ({
  id, matterId: '44444444-4444-4444-8444-444444444444', propertyId: `property-${id}`,
  propertyKind: 'input', clientRequestId: null,
  property: { id: `property-${id}`, streetAddress: address, city: 'Pretoria', province: 'Gauteng',
    postalCode: '0181', propertyType: 'Freehold', status: 'active', manual: true },
  ...overrides,
})

async function fillSavedCapture(page) {
  await page.getByRole('button', { name: 'Capture a property', exact: true }).click()
  const form = page.getByRole('form', { name: 'Capture property' })
  await form.getByLabel('Street address *', { exact: true }).fill('14 Jacaranda Avenue')
  await form.getByLabel('City *', { exact: true }).fill('Pretoria')
  await form.getByLabel('Province *', { exact: true }).fill('Gauteng')
  await form.getByLabel('Postal code *', { exact: true }).fill('0181')
  await form.getByLabel('Property type *', { exact: true }).selectOption('Freehold')
  return form
}

await check('saved-matter capture validates, preserves failed entries, retries and reloads', async () => {
  const api = makeApi({ attachBehaviour: 'fail-once' })
  api.links = [savedLink('prior', 'Prior linked home')]
  const { page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/${MATTER_ID}/milestones`)
  const form = await fillSavedCapture(page)
  await form.getByLabel('Postal code *', { exact: true }).fill('219')
  await form.getByRole('button', { name: 'Save property' }).click()
  await page.getByRole('alert').filter({ hasText: 'four-digit' }).waitFor()
  assert.equal(api.calls.attachProperty.length, 0)
  await form.getByLabel('Postal code *', { exact: true }).fill('0181')
  await form.getByLabel('Year built', { exact: true }).fill('twenty')
  await form.getByRole('button', { name: 'Save property' }).click()
  await page.getByRole('alert').filter({ hasText: 'whole number' }).waitFor()
  assert.equal(api.calls.attachProperty.length, 0)
  await form.getByLabel('Year built', { exact: true }).fill('2020')
  await form.getByLabel('Erf number', { exact: true }).fill('1234')
  await form.getByLabel('Legal description', { exact: true }).fill('Synthetic erf description\nSecond line')
  await form.getByRole('button', { name: 'Save property' }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(await form.getByLabel('Street address *', { exact: true }).inputValue(), '14 Jacaranda Avenue')
  assert.equal(api.calls.attachProperty.length, 1)
  await form.getByRole('button', { name: 'Save property' }).click()
  await page.getByRole('list', { name: 'Linked properties' }).getByText('14 Jacaranda Avenue', { exact: true }).waitFor()
  assert.deepEqual(api.calls.attachProperty[0], api.calls.attachProperty[1])
  assert.equal(api.calls.createMatter.length, 0)
  assert.equal(api.links.length, 2)
  await page.reload()
  const list = page.getByRole('list', { name: 'Linked properties' })
  await list.getByText('Prior linked home').waitFor()
  assert.equal(await list.getByRole('listitem').count(), 2)
  await list.getByText('Synthetic erf description').waitFor()
  assert.equal(await list.getByText('Synthetic erf description').textContent(), 'Synthetic erf description\nSecond line')
  assert.equal(api.calls.attachProperty[1].property.legal_description, 'Synthetic erf description\nSecond line')
  await list.getByText(/Erf 1234.*Built 2020/).waitFor()
  assert.equal(api.calls.attachProperty.length, 2)
})

await check('saved capture lost-response replay and conflicting edited payload', async () => {
  const api = makeApi({ attachBehaviour: 'drop-once' })
  const { page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/${MATTER_ID}/milestones`)
  const form = await fillSavedCapture(page)
  await form.getByRole('button', { name: 'Save property' }).click()
  await page.getByRole('alert').waitFor()
  assert.equal(api.links.length, 1)
  await form.getByLabel('City *', { exact: true }).fill('Changed city')
  await form.getByRole('button', { name: 'Save property' }).click()
  await page.getByRole('alert').filter({ hasText: '409' }).waitFor()
  assert.equal(api.calls.attachProperty[0].client_request_id, api.calls.attachProperty[1].client_request_id)
  await form.getByLabel('City *', { exact: true }).fill('Pretoria')
  await form.getByRole('button', { name: 'Save property' }).click()
  await page.getByRole('list', { name: 'Linked properties' }).waitFor()
  assert.deepEqual(api.calls.attachProperty[0], api.calls.attachProperty[2])
  assert.equal(api.links.length, 1)
})

await check('saved-panel existing-property retries reuse identity and prevent duplicate links', async () => {
  const api = makeApi({ attachBehaviour: 'drop-once' })
  const { page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/${MATTER_ID}/milestones`)
  await page.getByRole('button', { name: 'Attach existing property' }).click()
  await page.getByPlaceholder('Address, city, erf or reference...').fill('lane')
  await page.getByRole('button').filter({ hasText: '7 Selected Lane' }).click()
  await page.getByRole('alert').waitFor()
  await page.getByRole('button').filter({ hasText: '7 Selected Lane' }).click()
  await page.getByRole('list', { name: 'Linked properties' }).getByText('7 Selected Lane').waitFor()
  assert.deepEqual(api.calls.attachProperty[0], api.calls.attachProperty[1])
  assert.equal(api.links.length, 1)
  await page.getByRole('button', { name: 'Attach existing property' }).click()
  await page.getByPlaceholder('Address, city, erf or reference...').fill('lane')
  const duplicate = page.getByRole('button').filter({ hasText: '7 Selected Lane' })
  await duplicate.waitFor()
  assert.equal(await duplicate.isDisabled(), true)
  assert.match(await duplicate.innerText(), /Already linked/)
  assert.equal(api.calls.attachProperty.length, 2)
})

await check('committed save with failed readback offers GET recovery without a second POST', async () => {
  const api = makeApi({})
  const route = api.route
  let failedRead = false
  api.route = async r => {
    if (r.request().method() === 'GET' && new URL(r.request().url()).pathname === `/api/v1/transfers/${MATTER_ID}/properties`
      && api.calls.attachProperty.length && !failedRead) {
      failedRead = true
      return r.fulfill(json({ detail: 'Readback unavailable' }, 503))
    }
    return route(r)
  }
  const { page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/${MATTER_ID}/milestones`)
  const form = await fillSavedCapture(page)
  await form.getByRole('button', { name: 'Save property' }).click()
  await page.getByRole('status').filter({ hasText: 'Property saved, but readback failed' }).waitFor()
  assert.equal(await page.getByRole('list', { name: 'Linked properties' }).count(), 0)
  await page.getByRole('button', { name: 'Retry loading linked properties' }).click()
  await page.getByRole('list', { name: 'Linked properties' }).waitFor()
  assert.equal(api.calls.attachProperty.length, 1)
  assert.equal(api.links.length, 1)
})

await check('wizard readback keeps all input/output links and fails closed on read errors', async () => {
  const api = makeApi({})
  api.links = [savedLink('one', 'First linked home'), savedLink('two', 'Second linked home'),
    savedLink('output', '', { propertyKind: 'output', property: null, propertyId: null, externalPropertyId: 'Synthetic output reference' })]
  api.links[0].property.status = 'sold'
  let failRead = true
  const route = api.route
  api.route = r => failRead && new URL(r.request().url()).pathname === `/api/v1/transfers/${MATTER_ID}/properties`
    ? r.fulfill(json({ detail: 'Readback unavailable' }, 503)) : route(r)
  const { page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/workflow?id=${MATTER_ID}`)
  await page.getByRole('alert').filter({ hasText: 'Saving is disabled' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Save Details' }).isDisabled(), true)
  assert.equal(await page.getByPlaceholder('Start typing the address...').count(), 0)
  failRead = false
  await page.getByRole('button', { name: 'Retry loading linked properties' }).click()
  const list = page.getByRole('list', { name: 'Linked properties' })
  await list.getByText('Second linked home').waitFor()
  await list.getByText('Synthetic output reference').waitFor()
  await list.getByText('sold', { exact: true }).waitFor()
  assert.equal(await list.getByRole('listitem').count(), 3)
  await page.reload()
  await list.getByText('Second linked home').waitFor()
  assert.equal(await list.getByRole('listitem').count(), 3)
  assert.equal(api.calls.attachProperty.length, 0)
})

for (const surface of ['wizard', 'saved panel']) {
  await check(`${surface} ignores stale searches and clears pending results`, async () => {
    const api = makeApi({})
    const route = api.route
    let oldRoute
    let requested
    let firstRequest = new Promise(resolve => { requested = resolve })
    api.route = r => {
      const url = new URL(r.request().url())
      if (url.pathname === '/api/v1/properties') {
        if (url.searchParams.get('query') === 'old') { oldRoute = r; requested(); return }
        return r.fulfill(json({ data: { properties: [{ ...savedLink('new', 'Newest search result').property, manual: false }] } }))
      }
      return route(r)
    }
    const { page } = await newAuthedPage(browser, api)
    await page.goto(surface === 'wizard' ? `${BASE}/transfers/workflow` : `${BASE}/transfers/${MATTER_ID}/milestones`)
    if (surface === 'saved panel') await page.getByRole('button', { name: 'Attach existing property' }).click()
    const input = page.getByPlaceholder(surface === 'wizard' ? "Search your institution's properties by address, city, erf or reference..." : 'Address, city, erf or reference...')
    await input.fill('old')
    await firstRequest
    await input.fill('new')
    await page.getByText('Newest search result', { exact: true }).waitFor()
    await oldRoute.fulfill(json({ data: { properties: [savedLink('old', 'Stale search result').property] } }))
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('Stale search result', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Newest search result', { exact: true }).count(), 1)
    firstRequest = new Promise(resolve => { requested = resolve })
    await input.fill('old')
    await firstRequest
    await input.fill('')
    await oldRoute.fulfill(json({ detail: 'late search error' }, 503))
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('Searching...', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Newest search result', { exact: true }).count(), 0)
    assert.equal(await page.getByText(/late search error/).count(), 0)
  })
}

for (const surface of ['wizard', 'saved panel']) {
  await check(`${surface} discards old-matter readback after in-app navigation`, async () => {
    const otherId = '55555555-5555-4555-8555-555555555555'
    const api = makeApi({})
    const route = api.route
    let oldRoute
    let requested
    const firstRequest = new Promise(resolve => { requested = resolve })
    api.route = r => {
      const path = new URL(r.request().url()).pathname
      if (path === `/api/v1/transfers/${MATTER_ID}/properties`) { oldRoute = r; requested(); return }
      if (path === `/api/v1/transfers/${otherId}/properties`) return r.fulfill(json({ data: { properties: [savedLink('new-matter', 'New matter property')] } }))
      if (path.startsWith(`/api/v1/transfers/${otherId}`)) return r.fulfill(json({ data: path.endsWith('/parties') ? { parties: [] } : { id: otherId, transferId: 'TRF-SYNTHETIC-OTHER' } }))
      return route(r)
    }
    const { page } = await newAuthedPage(browser, api)
    const target = id => surface === 'wizard' ? `/transfers/workflow?id=${id}` : `/transfers/${id}/milestones`
    await page.goto(`${BASE}${target(MATTER_ID)}`)
    await firstRequest
    await page.evaluate(url => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')) }, target(otherId))
    await page.getByRole('list', { name: 'Linked properties' }).getByText('New matter property').waitFor()
    await oldRoute.fulfill(json({ data: { properties: [savedLink('old-matter', 'Old matter property')] } }))
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('Old matter property', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('list', { name: 'Linked properties' }).getByText('New matter property').count(), 1)
  })
}

for (const status of [403, 404]) {
  await check(`property read denial ${status} exposes no saved-matter mutation controls`, async () => {
    const api = makeApi({})
    const route = api.route
    api.route = r => new URL(r.request().url()).pathname === `/api/v1/transfers/${MATTER_ID}/properties`
      ? r.fulfill(json({ detail: 'Not permitted' }, status)) : route(r)
    const { page } = await newAuthedPage(browser, api)
    await page.goto(`${BASE}/transfers/${MATTER_ID}/milestones`)
    await page.getByRole('button', { name: 'Retry loading linked properties' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Capture a property' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Attach existing property' }).count(), 0)
    assert.equal(api.calls.attachProperty.length, 0)
  })
}

for (const status of [403, 422]) {
  await check(`saved manual capture surfaces server ${status} without inventing a link`, async () => {
    const api = makeApi({})
    const route = api.route
    let posts = 0
    api.route = r => {
      if (r.request().method() === 'POST' && new URL(r.request().url()).pathname === `/api/v1/transfers/${MATTER_ID}/properties`) {
        posts += 1
        return r.fulfill(json({ detail: 'Synthetic rejected write' }, status))
      }
      return route(r)
    }
    const { page } = await newAuthedPage(browser, api)
    await page.goto(`${BASE}/transfers/${MATTER_ID}/milestones`)
    const form = await fillSavedCapture(page)
    await form.getByRole('button', { name: 'Save property' }).click()
    await page.getByRole('alert').filter({ hasText: String(status) }).waitFor()
    assert.equal(await form.getByLabel('Street address *', { exact: true }).inputValue(), '14 Jacaranda Avenue')
    assert.equal(api.links.length, 0)
    assert.equal(posts, 1)
    assert.equal(await page.getByRole('list', { name: 'Linked properties' }).count(), 0)
  })
}

await check('pending capture is single-flight and cannot update a different matter after navigation', async () => {
  const otherId = '55555555-5555-4555-8555-555555555555'
  const api = makeApi({})
  const route = api.route
  let pendingRoute
  let requested
  let posts = 0
  let oldReads = 0
  const requestStarted = new Promise(resolve => { requested = resolve })
  api.route = r => {
    const path = new URL(r.request().url()).pathname
    if (path === `/api/v1/transfers/${MATTER_ID}/properties`) {
      if (r.request().method() === 'POST') { posts += 1; pendingRoute = r; requested(); return }
      oldReads += 1
    }
    if (path === `/api/v1/transfers/${otherId}/properties`) return r.fulfill(json({ data: { properties: [savedLink('other', 'Other matter property')] } }))
    if (path.startsWith(`/api/v1/transfers/${otherId}`)) return r.fulfill(json({ data: path.endsWith('/parties') ? { parties: [] } : { id: otherId } }))
    return route(r)
  }
  const { page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/${MATTER_ID}/milestones`)
  const form = await fillSavedCapture(page)
  await form.getByRole('button', { name: 'Save property' }).click()
  await requestStarted
  assert.equal(await form.getByRole('button', { name: 'Save property' }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true)
  await form.getByRole('button', { name: 'Save property' }).evaluate(button => button.click())
  assert.equal(posts, 1)
  await page.evaluate(url => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')) }, `/transfers/${otherId}/milestones`)
  await page.getByRole('list', { name: 'Linked properties' }).getByText('Other matter property').waitFor()
  await pendingRoute.fulfill(json({ data: savedLink('late', '14 Jacaranda Avenue'), message: 'Created' }, 201))
  await page.waitForTimeout(100)
  assert.equal(oldReads, 1)
  assert.equal(await page.getByText('14 Jacaranda Avenue', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('status').filter({ hasText: 'Property saved' }).count(), 0)
})

await check('inactive discovery results cannot become new links', async () => {
  const api = makeApi({})
  const route = api.route
  const property = { ...savedLink('inactive', 'Inactive candidate').property, status: 'sold' }
  api.route = r => new URL(r.request().url()).pathname === '/api/v1/properties'
    ? r.fulfill(json({ data: { properties: [property] } })) : route(r)
  const { page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/${MATTER_ID}/milestones`)
  await page.getByRole('button', { name: 'Attach existing property' }).click()
  await page.getByPlaceholder('Address, city, erf or reference...').fill('inactive')
  const result = page.getByRole('button').filter({ hasText: 'Inactive candidate' })
  await result.waitFor()
  assert.equal(await result.isDisabled(), true)
  assert.equal(api.calls.attachProperty.length, 0)
})

for (const surface of ['wizard', 'saved panel']) {
  await check(`${surface} shows empty search results only after the current response`, async () => {
    const api = makeApi({})
    const route = api.route
    let pendingRoute
    let requested
    const requestStarted = new Promise(resolve => { requested = resolve })
    api.route = r => {
      if (new URL(r.request().url()).pathname === '/api/v1/properties') { pendingRoute = r; requested(); return }
      return route(r)
    }
    const { page } = await newAuthedPage(browser, api)
    await page.goto(surface === 'wizard' ? `${BASE}/transfers/workflow` : `${BASE}/transfers/${MATTER_ID}/milestones`)
    if (surface === 'saved panel') await page.getByRole('button', { name: 'Attach existing property' }).click()
    const input = page.getByPlaceholder(surface === 'wizard' ? "Search your institution's properties by address, city, erf or reference..." : 'Address, city, erf or reference...')
    await input.fill('nothing')
    await requestStarted
    assert.equal(await page.getByText('No matching properties.', { exact: true }).count(), 0)
    await pendingRoute.fulfill(json({ data: { properties: [] } }))
    await page.getByText('No matching properties.', { exact: true }).waitFor()
    await input.fill('')
    assert.equal(await page.getByText('No matching properties.', { exact: true }).count(), 0)
  })
}

await check('Save Details binds the saved matter URL and reloads without creating again', async () => {
  const api = makeApi({})
  const { page } = await newAuthedPage(browser, api)
  await page.goto(`${BASE}/transfers/workflow`)
  await page.getByLabel('Transfer classification', { exact: true }).selectOption(classification.canonicalCode)
  await page.getByPlaceholder('Start typing the address...').fill('14 Jacaranda Avenue')
  await page.getByPlaceholder('Santon').fill('Pretoria')
  await page.getByPlaceholder('Gouteng').fill('Gauteng')
  await page.getByPlaceholder('2196').fill('0181')
  await page.locator('select').filter({ has: page.locator('option[value="Freehold"]') }).selectOption('Freehold')
  await page.getByRole('button', { name: 'Save Details' }).click()
  await page.getByText('Matter, property and all parties saved.', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('id'), MATTER_ID)
  await page.reload()
  await page.getByRole('list', { name: 'Linked properties' }).getByText('14 Jacaranda Avenue').waitFor()
  assert.equal(api.calls.createMatter.length, 1)
  assert.equal(api.calls.attachProperty.length, 1)
})

await browser.close()
console.log('\n--- RESULTS ---')
results.forEach(r => console.log(r))
process.exit(results.every(r => r.startsWith('PASS')) ? 0 : 1)
