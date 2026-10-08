// Screenshot evidence for the ID-verification POC — synthetic fixture data
// only. Renders the real panel components to static markup, wraps them in the
// built Tailwind CSS and captures each state with Playwright. No servers, no
// provider traffic, no real subjects.
//
// Usage (repo root): npx tsx scripts/id-verification-screenshots.tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IdVerificationPanel,
  IdVerificationStatusView,
  FixtureCaptureNotice,
} from '../src/components/transfers/IdVerificationPanel'
import type { IdVerificationStatusData } from '../src/lib/api/idVerification'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'docs', 'id-verification-screenshots')
fs.mkdirSync(outDir, { recursive: true })

const cssFile = fs
  .readdirSync(path.join(root, 'dist', 'assets'))
  .find(f => f.startsWith('index-') && f.endsWith('.css'))
if (!cssFile) throw new Error('run `npm run build` first — dist CSS not found')

const base: IdVerificationStatusData = {
  status: 'pending',
  attempt: {
    attemptNo: 1,
    reviewRejectType: null,
    rejectLabels: [],
    createdAt: '2026-10-08T10:00:00Z',
    updatedAt: '2026-10-08T10:05:00Z',
  },
  environment: 'fixture',
  simulated: true,
  checks: [],
  subjectKind: 'party',
}

const attempt = (over: object) => ({ ...base.attempt!, ...over })

const scenes: { name: string; markup: string }[] = [
  {
    name: '01-panel-first-paint',
    markup: renderToStaticMarkup(createElement(IdVerificationPanel, {
      transferId: '11111111-1111-1111-1111-111111111111',
      subjectPartyId: '22222222-2222-2222-2222-222222222222',
      subjectName: 'Synthetic Subject (fixture)',
      onClose: () => {},
    })),
  },
  {
    name: '02-not-started',
    markup: renderToStaticMarkup(createElement(IdVerificationStatusView, {
      data: { ...base, status: 'not_started', attempt: null },
    })),
  },
  {
    name: '03-simulated-capture-session',
    markup: renderToStaticMarkup(createElement('div', { className: 'space-y-3' },
      createElement('div', { className: 'flex items-center gap-2' },
        createElement('span', { className: 'text-xs text-gray-500' }, 'Started · fixture · Attempt 1')),
      createElement(FixtureCaptureNotice),
    )),
  },
  {
    name: '04-pending-simulated',
    markup: renderToStaticMarkup(createElement(IdVerificationStatusView, {
      data: { ...base, status: 'pending', checks: [{ check: 'document', state: 'not_reported' }, { check: 'liveness', state: 'not_reported' }] },
    })),
  },
  {
    name: '05-verified-simulated',
    markup: renderToStaticMarkup(createElement(IdVerificationStatusView, {
      data: { ...base, status: 'verified', checks: [{ check: 'document', state: 'performed' }, { check: 'liveness', state: 'performed' }, { check: 'face_match', state: 'performed' }] },
    })),
  },
  {
    name: '06-retry-requested',
    markup: renderToStaticMarkup(createElement(IdVerificationStatusView, {
      data: { ...base, status: 'retry_requested', attempt: attempt({ reviewRejectType: 'RETRY', rejectLabels: ['GRAPHIC_EDITOR', 'SCREENSHOTS'] }) },
    })),
  },
  {
    name: '07-declined',
    markup: renderToStaticMarkup(createElement(IdVerificationStatusView, {
      data: { ...base, status: 'declined', attempt: attempt({ reviewRejectType: 'FINAL', rejectLabels: ['FORGERY', 'DOCUMENT_TEMPLATE'] }) },
    })),
  },
  {
    name: '08-review-required',
    markup: renderToStaticMarkup(createElement(IdVerificationStatusView, {
      data: { ...base, status: 'review_required', attempt: attempt({ reviewRejectType: null, rejectLabels: ['UNSUPPORTED_DOCUMENT'] }) },
    })),
  },
  {
    name: '09-on-behalf-of-entity',
    markup: renderToStaticMarkup(createElement(IdVerificationPanel, {
      transferId: '11111111-1111-1111-1111-111111111111',
      subjectPartyId: '22222222-2222-2222-2222-222222222222',
      subjectName: 'Synthetic Representative (fixture)',
      onBehalfOfPartyId: '33333333-3333-3333-3333-333333333333',
      onBehalfOfName: 'Acme Synthetic Pty Ltd',
      onClose: () => {},
    })),
  },
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 560 } })
const external: string[] = []
page.on('request', r => {
  const u = r.url()
  if (!u.startsWith('file://') && !u.startsWith('data:')) external.push(u)
})

for (const scene of scenes) {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${path.join(root, 'dist', 'assets', cssFile).replace(/\\/g, '/')}">
</head><body class="bg-gray-100 p-8">
<div class="mx-auto max-w-md rounded-xl bg-white p-4 shadow">${scene.markup}</div>
</body></html>`
  const file = path.join(outDir, `${scene.name}.html`)
  fs.writeFileSync(file, html)
  await page.goto(`file://${file.replace(/\\/g, '/')}`)
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(outDir, `${scene.name}.png`) })
  fs.unlinkSync(file)
}

await browser.close()
if (external.length) {
  console.error('EXTERNAL REQUESTS:', external)
  process.exit(1)
}
console.log(`wrote ${scenes.length} screenshots to ${outDir} (0 external requests)`)
