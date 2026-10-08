import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, CardContent } from '@/components/ui'
import {
  IdVerificationApi,
  type IdVerificationSessionData,
  type IdVerificationStatus,
  type IdVerificationStatusData,
} from '@/lib/api/idVerification'
import { ApiRequestError } from '@/lib/api/httpClient'
import SumsubCapture from './SumsubCapture'

export interface IdVerificationPanelProps {
  transferId: string
  /** Persisted transfer_parties id of the natural-person subject. */
  subjectPartyId: string
  subjectName: string
  /** Company/trust party the person verifies on behalf of, when applicable. */
  onBehalfOfPartyId?: string
  onBehalfOfName?: string
  onClose: () => void
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; code: string }
  | { kind: 'status'; data: IdVerificationStatusData }
  | { kind: 'capture'; session: IdVerificationSessionData }
  | { kind: 'error'; message: string }

const STATUS_LABELS: Record<string, string> = {
  not_started: 'Not started',
  started: 'Started',
  pending: 'Pending',
  verified: 'Verified',
  retry_requested: 'Retry requested',
  declined: 'Declined',
  review_required: 'Review required',
}

export const IdVerificationStatusView: React.FC<{
  data: IdVerificationStatusData
  busy?: boolean
  onStart?: () => void
  onRetry?: () => void
  onRefresh?: () => void
}> = ({ data, busy, onStart, onRetry, onRefresh }) => {
  const label = STATUS_LABELS[data.status] ?? 'Unknown'
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{label}</Badge>
        {data.simulated && (
          <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
            Simulated — not a real verification
          </Badge>
        )}
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Environment: {data.environment}
        </span>
      </div>
      {data.attempt?.reviewRejectType && (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Reject type: {data.attempt.reviewRejectType}
          {data.attempt.rejectLabels.length > 0 && ` · ${data.attempt.rejectLabels.join(', ')}`}
        </p>
      )}
      {data.checks.length > 0 && (
        <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
          {data.checks.map(c => (
            <li key={c.check}>
              {c.check.replace(/_/g, ' ')}: {c.state.replace(/_/g, ' ')}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {(data.status === 'not_started' || data.status === 'started' || data.status === 'pending') && (
          <Button size="sm" onClick={onStart} disabled={busy}>
            {data.status === 'not_started' ? 'Start verification' : 'Resume verification'}
          </Button>
        )}
        {(data.status === 'retry_requested' || data.status === 'declined') && (
          <Button size="sm" onClick={onRetry} disabled={busy}>
            Retry verification
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={onRefresh} disabled={busy}>
          Refresh status
        </Button>
      </div>
    </div>
  )
}

export const FixtureCaptureNotice: React.FC = () => (
  <div
    data-testid="fixture-capture"
    className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100"
  >
    <p className="font-medium">Simulated capture session</p>
    <p className="mt-1 text-xs">
      No real passport, selfie or camera data is captured and no provider
      traffic occurs. Outcomes are driven by the demo fixture receiver and
      remain clearly labelled as simulated. The selected subject performs
      capture in person — staff must not submit their own image.
    </p>
  </div>
)

const UNAVAILABLE_LABELS: Record<string, string> = {
  configuration_unavailable:
    'Identity verification is not configured for this environment.',
  provider_unavailable:
    'The verification provider is temporarily unavailable. This is a technical failure, not a decline.',
  storage_unavailable:
    'Verification storage is unavailable. This is a technical failure, not a decline.',
  no_open_attempt: 'There is no active verification attempt for this subject.',
  no_attempt: 'No verification attempt exists for this subject.',
  not_retryable: 'This verification cannot be retried from its current state.',
  subject_not_eligible:
    'Only a natural-person party can be the verification subject.',
}

/**
 * Staff-facing ID verification panel (Sumsub POC).
 *
 * - Every outcome shown here comes from the server-authorised attempt state;
 *   SDK callbacks and local input only trigger a status refetch, never a
 *   status decision.
 * - Fixture/simulated results are always labelled and never presented as a
 *   real verification.
 * - Remount via `key` on subject change — switching client/matter/session
 *   tears the SDK down and discards the previous subject's state.
 */
export const IdVerificationPanel: React.FC<IdVerificationPanelProps> = ({
  transferId,
  subjectPartyId,
  subjectName,
  onBehalfOfPartyId,
  onBehalfOfName,
  onClose,
}) => {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  // Latest server status while the capture flow is mounted — refreshed
  // silently so SDK progress messages never unmount the capture.
  const [captureStatus, setCaptureStatus] = useState<IdVerificationStatus | null>(null)
  // Stale-response guard: bumped on subject change/unmount so an in-flight
  // read can never paint the previous subject's result.
  const generation = useRef(0)

  const stale = (gen: number) => gen !== generation.current

  const loadStatus = useCallback(async () => {
    const gen = generation.current
    setView({ kind: 'loading' })
    try {
      const res = await IdVerificationApi.getStatus(transferId, subjectPartyId)
      if (stale(gen)) return
      setView({ kind: 'status', data: res.data })
    } catch (err) {
      if (stale(gen)) return
      if (err instanceof ApiRequestError) {
        const body = err.message
        const match = /"error"\s*:\s*"([a-z_]+)"/.exec(body)
        if (err.status === 503 || (match && match[1] in UNAVAILABLE_LABELS)) {
          setView({ kind: 'unavailable', code: match?.[1] ?? 'provider_unavailable' })
          return
        }
      }
      setView({ kind: 'error', message: 'Status could not be loaded.' })
    }
  }, [transferId, subjectPartyId])

  useEffect(() => {
    generation.current += 1
    loadStatus()
    return () => {
      generation.current += 1
    }
  }, [loadStatus])

  const runAction = useCallback(
    async (fn: () => Promise<{ data: IdVerificationSessionData }>) => {
      const gen = generation.current
      setBusy(true)
      try {
        const res = await fn()
        if (stale(gen)) return
        setView({ kind: 'capture', session: res.data })
      } catch (err) {
        if (stale(gen)) return
        if (err instanceof ApiRequestError) {
          const match = /"error"\s*:\s*"([a-z_]+)"/.exec(err.message)
          if (match && match[1] in UNAVAILABLE_LABELS) {
            setView({ kind: 'unavailable', code: match[1] })
            return
          }
        }
        setView({ kind: 'error', message: 'The verification session could not be started.' })
      } finally {
        if (!stale(gen)) setBusy(false)
      }
    },
    [],
  )

  const start = useCallback(
    () => runAction(() => IdVerificationApi.startSession(transferId, subjectPartyId, onBehalfOfPartyId)),
    [runAction, transferId, subjectPartyId, onBehalfOfPartyId],
  )
  const retry = useCallback(
    () => runAction(() => IdVerificationApi.retry(transferId, subjectPartyId, onBehalfOfPartyId)),
    [runAction, transferId, subjectPartyId, onBehalfOfPartyId],
  )

  const expirationHandler = useCallback(async (): Promise<string> => {
    const res = await IdVerificationApi.refreshToken(transferId, subjectPartyId)
    return res.data.sdkToken
  }, [transferId, subjectPartyId])

  // Progress-only refresh: fetches the server status without changing the
  // view, so readiness/step messages keep the capture mounted. Only a
  // deliberate settled/cancelled signal (or a real loadStatus call) leaves
  // the capture view. A failed quiet read is swallowed — the capture stays
  // usable and the next signal retries.
  const refreshQuietly = useCallback(async () => {
    const gen = generation.current
    try {
      const res = await IdVerificationApi.getStatus(transferId, subjectPartyId)
      if (!stale(gen)) setCaptureStatus(res.data.status)
    } catch {
      /* stay mounted */
    }
  }, [transferId, subjectPartyId])

  const renderStatus = (data: IdVerificationStatusData) => (
    <IdVerificationStatusView
      data={data}
      busy={busy}
      onStart={start}
      onRetry={retry}
      onRefresh={loadStatus}
    />
  )

  const renderCapture = (session: IdVerificationSessionData) => (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">
          {STATUS_LABELS[captureStatus ?? session.status] ?? (captureStatus ?? session.status)}
        </Badge>
        {session.simulated && (
          <Badge variant="secondary" className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
            Simulated — not a real verification
          </Badge>
        )}
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Environment: {session.environment} · Attempt {session.attemptNo}
        </span>
      </div>
      {session.mode === 'fixture' ? (
        <FixtureCaptureNotice />
      ) : (
        <SumsubCapture
          accessToken={session.sdkToken}
          expirationHandler={expirationHandler}
          onProgress={() => { void refreshQuietly() }}
          onSettled={() => { void loadStatus() }}
          onCancelled={() => { void loadStatus() }}
          onError={code => setView({ kind: 'error', message: `Capture failed: ${code}` })}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={loadStatus} disabled={busy}>
          Refresh status
        </Button>
      </div>
    </div>
  )

  return (
    <Card variant="glass" className="border-teal-200 dark:border-teal-800">
      <CardContent className="p-4 space-y-3" data-testid="id-verification-panel">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Identity verification
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Subject: {subjectName}
              {onBehalfOfPartyId && onBehalfOfName
                ? ` · on behalf of ${onBehalfOfName}`
                : ''}
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={onClose} aria-label="Close verification panel">
            Close
          </Button>
        </div>

        {view.kind === 'loading' && (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading verification status…</p>
        )}
        {view.kind === 'unavailable' && (
          <div
            role="alert"
            className="rounded-md border border-gray-300 bg-gray-50 p-3 text-sm text-gray-700 dark:border-navy-600 dark:bg-navy-800 dark:text-gray-200"
          >
            {UNAVAILABLE_LABELS[view.code] ?? 'Identity verification is unavailable.'}
          </div>
        )}
        {view.kind === 'error' && (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/20 dark:text-red-200"
          >
            {view.message}
            <button className="ml-2 underline" onClick={loadStatus}>Retry</button>
          </div>
        )}
        {view.kind === 'status' && renderStatus(view.data)}
        {view.kind === 'capture' && renderCapture(view.session)}

        <p className="text-[11px] leading-snug text-gray-400 dark:text-gray-500">
          A verification result here does not mark any checklist item, FICA
          document or compliance step as accepted — reviewer acceptance is a
          separate process.
        </p>
      </CardContent>
    </Card>
  )
}

export default IdVerificationPanel
