import { apiRequest } from './httpClient'

export type IdVerificationStatus =
  | 'not_started'
  | 'started'
  | 'pending'
  | 'verified'
  | 'retry_requested'
  | 'declined'
  | 'review_required'

export interface IdVerificationCheck {
  check: string
  state: string
  detail?: string
}

export interface IdVerificationStatusData {
  status: IdVerificationStatus
  attempt: {
    attemptNo: number
    provider: string | null
    levelName: string | null
    reviewAnswer: string | null
    reviewRejectType: string | null
    rejectLabels: string[]
    lastEventType: string | null
    lastEventAt: string | null
    updatedAt: string | null
  } | null
  environment: string
  simulated: boolean
  checks: IdVerificationCheck[]
  subjectKind: 'party' | 'representative'
  onBehalfOfPartyId?: string
  onBehalfOfEntityType?: string
}

export interface IdVerificationSessionData {
  mode: 'fixture' | 'sandbox' | string
  environment: string
  simulated: boolean
  resumed: boolean
  attemptNo: number
  status: IdVerificationStatus
  sdkToken: string
  sdkTokenTtlSeconds: number
  levelName: string | null
  subjectKind: 'party' | 'representative'
  onBehalfOfPartyId?: string
  onBehalfOfEntityType?: string
}

interface Envelope<T> {
  message: string
  data: T
}

function basePath(transferId: string, transferPartyId: string): string {
  return `/api/v1/transfers/${transferId}/parties/${transferPartyId}/id-verification`
}

export const IdVerificationApi = {
  getStatus(transferId: string, transferPartyId: string): Promise<Envelope<IdVerificationStatusData>> {
    return apiRequest<Envelope<IdVerificationStatusData>>(basePath(transferId, transferPartyId))
  },

  startSession(
    transferId: string,
    transferPartyId: string,
    onBehalfOfPartyId?: string,
  ): Promise<Envelope<IdVerificationSessionData>> {
    return apiRequest<Envelope<IdVerificationSessionData>>(`${basePath(transferId, transferPartyId)}/session`, {
      method: 'POST',
      body: onBehalfOfPartyId ? { onBehalfOfPartyId } : {},
    })
  },

  refreshToken(transferId: string, transferPartyId: string): Promise<Envelope<IdVerificationSessionData>> {
    return apiRequest<Envelope<IdVerificationSessionData>>(`${basePath(transferId, transferPartyId)}/refresh`, {
      method: 'POST',
      body: {},
    })
  },

  retry(
    transferId: string,
    transferPartyId: string,
    onBehalfOfPartyId?: string,
  ): Promise<Envelope<IdVerificationSessionData>> {
    return apiRequest<Envelope<IdVerificationSessionData>>(`${basePath(transferId, transferPartyId)}/retry`, {
      method: 'POST',
      body: onBehalfOfPartyId ? { onBehalfOfPartyId } : {},
    })
  },
}
