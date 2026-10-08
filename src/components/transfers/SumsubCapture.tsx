import React, { Suspense } from 'react'

export interface SumsubCaptureProps {
  accessToken: string
  /** Returns a fresh short-lived SDK token — server-authorised renewal. */
  expirationHandler: () => Promise<string>
  onProgress: (type: string) => void
  onError: (code: string) => void
}

// Loaded lazily so the provider SDK bundle is only fetched when a configured
// provider session actually starts — fixture/demo mode and tests never pull it.
const SumsubWebSdk = React.lazy(() => import('@sumsub/websdk-react'))

/**
 * Provider-capture wrapper — mounts the official Sumsub WebSDK
 * (@sumsub/websdk-react 2.9.0) for a configured provider session. SDK
 * callbacks are flow progress only; they never decide an outcome — the
 * server-authorised status is the only source of truth.
 */
const SumsubCapture: React.FC<SumsubCaptureProps> = ({
  accessToken,
  expirationHandler,
  onProgress,
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
      onMessage={(type: string) => onProgress(type)}
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
