import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { VeriffCapture, safeVeriffCaptureUrl } from './VeriffCapture'

test('Veriff capture URL rejects non-provider URLs, credentials and HTTP', () => {
  for (const url of ['javascript:alert(1)', 'http://veriff.com/v/test', 'https://veriff.com.evil.test/', 'https://user:pass@veriff.com/', 'https://veriff.com:444/']) {
    assert.equal(safeVeriffCaptureUrl(url), null)
  }
  assert.equal(safeVeriffCaptureUrl('https://alchemy.veriff.com/v/synthetic'), 'https://alchemy.veriff.com/v/synthetic')
})

test('Hosted capture has no-referrer protection and does not claim completion is approval', () => {
  const html = renderToStaticMarkup(<VeriffCapture captureUrl="https://alchemy.veriff.com/v/synthetic" simulated />)
  assert.match(html, /noopener noreferrer/)
  assert.match(html, /no-referrer/)
  assert.match(html, /does not perform real document verification/)
  assert.match(html, /does not mean the passport is verified/)
})

test('Invalid capture URL cannot become a browser link', () => {
  const html = renderToStaticMarkup(<VeriffCapture captureUrl="https://evil.test/" simulated={false} />)
  assert.match(html, /role="alert"/)
  assert.doesNotMatch(html, /href=/)
})
