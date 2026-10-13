import React from 'react'

export function safeVeriffCaptureUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '')
    const allowed = ['veriff.com', 'veriff.me'].some(
      host => url.hostname === host || url.hostname.endsWith('.' + host),
    )
    return url.protocol === 'https:' && !url.username && !url.password &&
      (!url.port || url.port === '443') && allowed ? url.href : null
  } catch { return null }
}

/** Capture progress never writes a decision; staff refresh the signed server result. */
export const VeriffCapture: React.FC<{ captureUrl?: string; simulated: boolean; demo?: boolean }> = ({ captureUrl, simulated, demo = false }) => {
  const url = safeVeriffCaptureUrl(captureUrl)
  if (!url) return <p role="alert">The Veriff session could not be opened. Refresh status and try again.</p>
  return (
    <div className="space-y-3 rounded-md border border-teal-200 p-3" data-testid="veriff-capture">
      <p className="text-sm">The selected person must capture their own passport and selfie in Veriff.</p>
      {simulated && <p className="text-xs text-amber-800">Test integration: Veriff does not perform real document verification.</p>}
      {demo ? <p className="rounded-md bg-gray-100 p-2 text-xs text-gray-600">Capture preview only. Use the labelled demo controls below to simulate a result.</p> : <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
        className="inline-block rounded-md bg-teal-700 px-4 py-2 text-sm text-white">Open Veriff passport check</a>}
      <p className="text-xs text-gray-500">After capture, return here and select Refresh status. Opening or finishing capture does not mean the passport is verified.</p>
    </div>
  )
}

export default VeriffCapture
