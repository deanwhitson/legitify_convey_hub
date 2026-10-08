import React, { Suspense } from 'react'

export interface SumsubCaptureProps {
  accessToken: string
  /** Returns a fresh short-lived SDK token — server-authorised renewal. */
  expirationHandler: () => Promise<string>
  /** Ordinary flow progress (readiness/step/document events) — the caller
   *  must NOT unmount the capture for these. */
  onProgress: (type: string) => void
  /** The SDK signalled the applicant flow reached a submitted/reviewed/
   *  terminal stage — the caller may leave the capture view. */
  onSettled: (type: string) => void
  /** The applicant cancelled the flow — the caller may leave the capture. */
  onCancelled: (type: string) => void
  onError: (code: string) => void
}

// Loaded lazily so the provider SDK bundle is only fetched when a configured
// provider session actually starts — fixture/demo mode and tests never pull it.
const SumsubWebSdk = React.lazy(() => import('@sumsub/websdk-react'))

// Message classification (docs.sumsub.com WebSDK onMessage types, accessed
// 2026-10-08). Only explicitly documented completion/submission events
// leave the capture; `idCheck.applicantStatus` and
// `idCheck.onApplicantStatusChanged` are GENERAL status-change messages
// (payload reviewStatus/reviewResult can be interim, onHold or
// awaitingUser — not completion), so they are progress and keep the SDK
// mounted. Anything unlisted is ordinary progress — the safe default.
const SETTLED_MESSAGES = new Set([
  'idCheck.onApplicantVerificationCompleted',
  'idCheck.onApplicantSubmitted',
  'idCheck.onApplicantPending',
  'idCheck.onApplicantReviewed',
  'idCheck.onApplicantWorkflowCompleted',
  'idCheck.onApplicantWorkflowFailed',
])
const CANCELLED_MESSAGES = new Set([
  'idCheck.onCancel',
  'idCheck.onApplicantCancelled',
])

/**
 * Provider-capture wrapper — mounts the official Sumsub WebSDK
 * (@sumsub/websdk-react 2.9.0) for a configured provider session. SDK
 * callbacks are flow signals only; they never decide an outcome — the
 * server-authorised status is the only source of truth.
 */
const SumsubCapture: React.FC<SumsubCaptureProps> = ({
  accessToken,
  expirationHandler,
  onProgress,
  onSettled,
  onCancelled,
  onError,
}) => (
  <Suspense
    fallback={
      <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-navy-700 dark:bg-navy-800 dark:text-gray-300">
        Loading verification capture…
      </div>
    }
  >
    <SumsubWebSdk
      accessToken={accessToken}
      expirationHandler={expirationHandler}
      onMessage={(type: string) => {
        if (SETTLED_MESSAGES.has(type)) onSettled(type)
        else if (CANCELLED_MESSAGES.has(type)) onCancelled(type)
        else onProgress(type)
      }}
      onError={(error: unknown) => {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : 'sdk_error'
        onError(code)
      }}
    />
  </Suspense>
)

export default SumsubCapture
