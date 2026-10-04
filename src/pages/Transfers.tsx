import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { readNavigationState } from '@/lib/navigationState'
import { Card, CardHeader, CardTitle, CardContent, Input } from '@/components/ui'
import { useTransferClassifications } from '@/hooks/useTransferClassifications'
import { MatterClassificationSelect } from '@/components/transfers/MatterClassificationSelect'
import {
  TransferProvider,
  useTransfer,
  getProgressPercentage
} from '@/components/transfers/TransferForm'
import { StepProperty } from '@/components/transfers/StepProperty'
import { StepParties } from '@/components/transfers/StepParties'
import { StepFinancials } from '@/components/transfers/StepFinancials'
import { StepDocuments } from '@/components/transfers/StepDocuments'
import { StepReview } from '@/components/transfers/StepReview'
import { TransferNavigation } from '@/components/transfers/TransferNavigation'
import { UnavailableNotice } from '@/components/ui'
import { useTransfers } from '@/hooks/useTransfers'
import { TransferApi, buildAttachPartyRequest, buildManualPropertyRequest, transferPartyToFormParty } from '@/lib/api/transferApi'
import { isPersistenceDisabled, isPersistenceUnavailable, probeMatterPersistence, serviceUnavailableMessage } from '@/lib/api/serviceStatus'

const Transfers: React.FC = () => {
  const location = useLocation()
  const target = (location.state as { transferId?: string } | null)?.transferId || new URLSearchParams(location.search).get('id') || 'new'
  const scope = useRef({ target, revision: 0, savedTarget: null as string | null })
  if (scope.current.target !== target) {
    scope.current = { target, revision: scope.current.revision + (scope.current.savedTarget === target ? 0 : 1), savedTarget: null }
  }
  return (
    <TransferProvider key={scope.current.revision}>
      <TransferWorkflow onMatterCreated={id => { scope.current.savedTarget = id }} />
    </TransferProvider>
  )
}

const TransferWorkflow: React.FC<{ onMatterCreated: (id: string) => void }> = ({ onMatterCreated }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch } = useTransfer()
  const { currentStep } = state
  const transferId = (location.state as { transferId?: string } | null)?.transferId || new URLSearchParams(location.search).get('id') || undefined
  const matterDetails = (readNavigationState(location.state) as { matterDetails?: { fileReference?: string; classificationCode?: string } } | null)?.matterDetails
  const incomingReference = matterDetails?.fileReference
  const incomingClassification = matterDetails?.classificationCode
  const classificationData = useTransferClassifications()
  const existingMatter = Boolean(state.id || state.transfer_id || transferId)
  const classificationReady = !classificationData.loading && !classificationData.error
    && classificationData.classifications.some(option => option.canonicalCode === state.classificationCode)

  useEffect(() => {
    if (transferId || (incomingReference === undefined && incomingClassification === undefined)) return
    dispatch({
      type: 'UPDATE_MATTER_DETAILS',
      payload: {
        firmReference: typeof incomingReference === 'string' ? incomingReference : null,
        classificationCode: typeof incomingClassification === 'string' ? incomingClassification : null,
      },
    })
  }, [transferId, incomingReference, incomingClassification, dispatch])

  const { fetchTransfer, error, isLoading } = useTransfers()
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [partySaveState, setPartySaveState] = useState<Record<string, 'saved' | 'failed'>>({})
  const [persistenceError, setPersistenceError] = useState<Error | null>(null)
  const [persistenceChecked, setPersistenceChecked] = useState(false)
  const [propertyLoading, setPropertyLoading] = useState(Boolean(transferId))
  const [propertyLoadError, setPropertyLoadError] = useState<string | null>(null)
  const [propertyLoadAttempt, setPropertyLoadAttempt] = useState(0)
  const active = useRef(true)
  const saveInFlight = useRef(false)
  const locallyCreatedMatter = useRef<string | null>(null)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  // Stable idempotency key for matter creation; generated once per form session
  // so a retried save resolves to the same matter instead of duplicating it.
  const matterRequestKey = useRef<string | null>(null)
  // Stable idempotency key for the property link/capture; reused on retries so
  // a replay resolves to the original property and link rather than duplicating.
  const propertyRequestKey = useRef<string | null>(null)

  // Probe the matter-persistence lane once so Save/Submit are disabled up front
  // while the legacy transfers API is unavailable, instead of failing on click.
  // A null result only means the lane is not known to be down — it does not
  // prove write permission; actual saves still surface their own failures.
  useEffect(() => {
    let cancelled = false
    probeMatterPersistence()
      .then((failure) => { if (!cancelled && failure) setPersistenceError(failure) })
      .finally(() => { if (!cancelled) setPersistenceChecked(true) })
    return () => { cancelled = true }
  }, [])

  // Load an existing transfer aggregate when the component is entered with a transfer id.
  // Source-aware party read-back runs through the authenticated v1 lane so a
  // partially saved matter reopens with party sources and identity intact.
  useEffect(() => {
    if (!transferId || transferId === locallyCreatedMatter.current) return

    let cancelled = false
    setPropertyLoading(true)
    setPropertyLoadError(null)
    const load = async () => {
      const [aggregate, partiesResponse, propertiesResponse] = await Promise.all([
        fetchTransfer(transferId),
        TransferApi.getMatterParties(transferId).catch(() => null),
        TransferApi.getMatterProperties(transferId).catch(err => {
          if (!cancelled) setPropertyLoadError(serviceUnavailableMessage('Linked properties', err))
          return null
        })
      ])
      if (cancelled) return

      const serverParties = partiesResponse?.data || null
      // Reopen a persisted property link read-only: the saved link + its
      // property projection come from the server, never from local guesses.
      const firstLink = propertiesResponse?.data?.find(link => link.propertyKind === 'input')
      const linkedHydration = {
        savedPropertyLinks: propertiesResponse?.data,
        persistedPropertyLinkId: firstLink?.id,
        propertyRequestId: firstLink?.clientRequestId || undefined,
        linkedProperty: firstLink?.property ? {
          id: firstLink.property.id,
          streetAddress: firstLink.property.streetAddress || '',
          city: firstLink.property.city || '',
          province: firstLink.property.province || '',
          postalCode: firstLink.property.postalCode || '',
          propertyType: firstLink.property.propertyType || '',
          status: firstLink.property.status || '',
          manual: firstLink.property.manual
        } : undefined
      }
      if (aggregate) {
        dispatch({
          type: 'HYDRATE_TRANSFER',
          payload: serverParties
            ? { ...aggregate, parties: serverParties.map(transferPartyToFormParty), ...linkedHydration }
            : { ...aggregate, ...linkedHydration }
        })
        if (serverParties) {
          setPartySaveState(Object.fromEntries(serverParties.map(p => [p.id, 'saved' as const])))
        }
      } else if (serverParties) {
        // The legacy aggregate is quarantined/failed but the matter exists:
        // reopen a minimal draft so failed party attachments can be retried
        // against the preserved matter id.
        dispatch({
          type: 'HYDRATE_TRANSFER',
          payload: {
            id: transferId,
            currentStep: 1,
            status: 'draft',
            propertyDetails: { address: '', city: '', state: '', zipCode: '', propertyType: '', lotNumber: '', legalDescription: '', yearBuilt: '', squareFootage: '' },
            parties: serverParties.map(transferPartyToFormParty),
            financials: { purchasePrice: '', depositAmount: '', loanAmount: '', interestRate: '', loanTerm: '', transferDuty: '', conveyancingFees: '', deedsOfficeFees: '', vat: '', postPetty: '', clearanceCertificate: '', ratesClearance: '' },
            documents: [],
            ...linkedHydration
          }
        })
        setPartySaveState(Object.fromEntries(serverParties.map(p => [p.id, 'saved' as const])))
      }
      setPropertyLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [transferId, fetchTransfer, dispatch, propertyLoadAttempt])

  const handlePrevious = () => {
    dispatch({ type: 'SET_CURRENT_STEP', payload: Math.max(1, currentStep - 1) })
  }

  const handleNext = () => {
    dispatch({ type: 'SET_CURRENT_STEP', payload: Math.min(5, currentStep + 1) })
  }

  // Saves the matter (once, idempotently), attaches the property link, then
  // attaches each unsaved party. Returns the matter id plus the failures;
  // callers must not report complete success or navigate while failures are
  // non-empty. The matter id is preserved in state so a retry never creates
  // a second matter, and the property request key is stable so a retried
  // link/capture replays instead of duplicating.
  const persistAggregate = async (): Promise<{ matterId: string; failedPartyIds: string[]; propertyFailed: boolean } | null> => {
    setSaveError(null)
    setSaveNotice(null)
    if (isPersistenceDisabled(persistenceChecked, persistenceError) || propertyLoading || propertyLoadError || saveInFlight.current) return null
    if (!existingMatter && !classificationReady) {
      setSaveError('Choose an available transfer classification before creating the matter.')
      return null
    }
    saveInFlight.current = true
    setIsSaving(true)
    try {
      // 1. Ensure the matter exists (idempotent via a stable client key).
      let matterId = state.id || state.transfer_id || transferId
      if (!matterId) {
        matterRequestKey.current ||= crypto.randomUUID()
        const created = await TransferApi.createMatter({
          client_request_id: matterRequestKey.current,
          property_address: state.selectedPropertyId ? state.linkedProperty?.streetAddress || '' : state.propertyDetails.address,
          purchase_price: Number.parseFloat(state.financials.purchasePrice) || 0,
          firm_reference: state.firmReference?.trim() || null,
          classification_code: state.classificationCode
        })
        if (!active.current) return null
        if (!created.data?.id) {
          setSaveError('The matter could not be created. Your entries remain on this page.')
          return null
        }
        matterId = created.data.id
        dispatch({
          type: 'SET_TRANSFER_ID',
          payload: { id: created.data.id, transfer_id: created.data.transferId || undefined }
        })
        locallyCreatedMatter.current = created.data.id
        onMatterCreated(created.data.id)
        const params = new URLSearchParams(location.search)
        params.set('id', created.data.id)
        navigate({ pathname: location.pathname, search: `?${params}` }, { replace: true, state: location.state })
      } else {
        // The matter id stays fixed: retries attach to it, never recreate it.
        matterRequestKey.current ||= crypto.randomUUID()
      }

      // 2. Attach the property: an existing selected property is linked, or the
      // captured details create an institution-private manual property. Both
      // share one stable client_request_id so retries replay to the same link.
      let propertyFailed: string | null = null
      if (!state.persistedPropertyLinkId) {
        const requestId = state.propertyRequestId || propertyRequestKey.current || crypto.randomUUID()
        propertyRequestKey.current = requestId
        dispatch({ type: 'UPDATE_PROPERTY_LINK', payload: { propertyRequestId: requestId } })
        let request
        if (state.selectedPropertyId) {
          request = { client_request_id: requestId, property_id: state.selectedPropertyId }
        } else {
          const built = buildManualPropertyRequest(state.propertyDetails, requestId)
          if ('error' in built) {
            propertyFailed = built.error
          } else {
            request = built
          }
        }
        if (request) {
          try {
            const attached = await TransferApi.attachMatterProperty(matterId, request)
            if (!active.current) return null
            if (attached.data?.id) {
              dispatch({
                type: 'UPDATE_PROPERTY_LINK',
                payload: {
                  persistedPropertyLinkId: attached.data.id,
                  savedPropertyLinks: [...(state.savedPropertyLinks || []).filter(link => link.id !== attached.data!.id), attached.data],
                  linkedProperty: attached.data.property
                    ? {
                        id: attached.data.property.id,
                        streetAddress: attached.data.property.streetAddress || '',
                        city: attached.data.property.city || '',
                        province: attached.data.property.province || '',
                        postalCode: attached.data.property.postalCode || '',
                        propertyType: attached.data.property.propertyType || '',
                        status: attached.data.property.status || '',
                        manual: attached.data.property.manual
                      }
                    : state.linkedProperty
                }
              })
            } else {
              propertyFailed = 'The property link could not be saved.'
            }
          } catch (err) {
            propertyFailed = err instanceof Error ? err.message : 'The property link could not be saved.'
          }
        }
      }

      // 3. Attach each party that has not yet been persisted.
      if (!active.current) return null
      const failedPartyIds: string[] = []
      const failureReasons: string[] = propertyFailed ? [`Property: ${propertyFailed}`] : []
      const nextSaveState: Record<string, 'saved' | 'failed'> = { ...partySaveState }
      for (const party of state.parties) {
        if (!active.current) return null
        if (party.persistedPartyId) {
          nextSaveState[party.id] = 'saved'
          continue
        }
        const request = buildAttachPartyRequest(party)
        if ('error' in request) {
          failedPartyIds.push(party.id)
          failureReasons.push(`${party.name || 'Unnamed party'}: ${request.error}`)
          nextSaveState[party.id] = 'failed'
          continue
        }
        try {
          const attached = await TransferApi.attachParty(matterId, request)
          if (!active.current) return null
          if (attached.data?.id) {
            nextSaveState[party.id] = 'saved'
            dispatch({
              type: 'UPDATE_PARTY',
              payload: {
                id: party.id,
                updates: {
                  persistedPartyId: attached.data.id,
                  clientRequestId: request.client_request_id
                }
              }
            })
          } else {
            failedPartyIds.push(party.id)
            failureReasons.push(`${party.name || 'Unnamed party'}: save failed`)
            nextSaveState[party.id] = 'failed'
          }
        } catch (err) {
          failedPartyIds.push(party.id)
          failureReasons.push(`${party.name || 'Unnamed party'}: ${err instanceof Error ? err.message : 'save failed'}`)
          nextSaveState[party.id] = 'failed'
        }
      }
      setPartySaveState(nextSaveState)

      if (failedPartyIds.length > 0 || propertyFailed) {
        const savedCount = state.parties.length - failedPartyIds.length
        setSaveError(
          `Matter saved; ${savedCount} of ${state.parties.length} parties saved. ` +
          `${failureReasons.join(' ')} Retry to save the remainder — the same matter and request keys are kept.`
        )
        return { matterId, failedPartyIds, propertyFailed: Boolean(propertyFailed) }
      }

      setSaveNotice('Matter, property and all parties saved.')
      return { matterId, failedPartyIds, propertyFailed: false }
    } catch (err) {
      const failure = err instanceof Error ? err : new Error('The transfer could not be saved')
      setSaveError(`${serviceUnavailableMessage('Matter saving', failure)} Your entries remain on this page.`)
      if (isPersistenceUnavailable(failure)) {
        setPersistenceError(failure)
      }
      return null
    } finally {
      saveInFlight.current = false
      if (active.current) setIsSaving(false)
    }
  }

  const handleSaveDraft = async () => {
    if (saveInFlight.current) return
    const result = await persistAggregate()
    if (!active.current) return
    if (!result) {
      setSaveError(current => current ?? 'The draft could not be saved. Your entries remain on this page.')
    }
  }

  const handleSubmit = async () => {
    if (saveInFlight.current) return
    const result = await persistAggregate()
    if (!active.current) return
    // Never claim success or navigate while any party or the property failed.
    if (!result || result.failedPartyIds.length > 0 || result.propertyFailed) {
      setSaveError(current => current ?? 'The details could not be saved. Your entries remain on this page.')
      return
    }
    navigate(`/transfers/${result.matterId}/milestones`)
  }

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return <StepProperty />
      case 2:
        return <StepParties />
      case 3:
        return <StepFinancials />
      case 4:
        return <StepDocuments />
      case 5:
        return <StepReview />
      default:
        return <StepProperty />
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-navy-900">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            Property Transfer
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Capture transfer details step by step. Saving does not submit or complete the transfer.
          </p>
        </div>

        <Card className="mb-6">
          <CardHeader><CardTitle>Matter classification</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label htmlFor="workflow-firm-reference" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Firm reference</label>
              <Input
                id="workflow-firm-reference"
                value={state.firmReference ?? ''}
                readOnly={existingMatter}
                disabled={isSaving}
                onChange={event => dispatch({ type: 'UPDATE_MATTER_DETAILS', payload: { firmReference: event.target.value } })}
              />
            </div>
            <MatterClassificationSelect
              value={state.classificationCode}
              options={classificationData.classifications}
              loading={classificationData.loading}
              error={classificationData.error}
              onChange={classificationCode => dispatch({ type: 'UPDATE_MATTER_DETAILS', payload: { classificationCode } })}
              onRetry={classificationData.retry}
              readOnly={existingMatter}
              disabled={isSaving}
            />
          </CardContent>
        </Card>

        {persistenceError && (
          <div className="mb-6">
            <UnavailableNotice
              message={serviceUnavailableMessage('Matter saving', persistenceError)}
              detail="Entered details are kept on this page but cannot be saved to the server until authenticated matter persistence is restored."
            />
          </div>
        )}

        {(saveError || error) && (
          <div className="mb-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <p className="text-sm text-red-700 dark:text-red-300">
              {saveError || error}
            </p>
          </div>
        )}

        {saveNotice && !saveError && (
          <div className="mb-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
            <p className="text-sm text-green-700 dark:text-green-300">
              {saveNotice}
            </p>
          </div>
        )}

        {isLoading && (
          <div className="mb-6 text-sm text-gray-600 dark:text-gray-400">
            Loading transfer...
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            {propertyLoading && <p role="status">Loading linked properties...</p>}
            {propertyLoadError && (
              <div role="alert" className="mb-4">
                <p>{propertyLoadError} Saving is disabled until saved property links can be read.</p>
                <button type="button" onClick={() => setPropertyLoadAttempt(attempt => attempt + 1)}>Retry loading linked properties</button>
              </div>
            )}
            <fieldset disabled={isSaving} className="min-w-0 border-0 p-0">
              {!propertyLoading && !propertyLoadError && renderStep()}
            </fieldset>
            <TransferNavigation
              currentStep={currentStep}
              totalSteps={5}
              onPrevious={handlePrevious}
              onNext={handleNext}
              onSave={handleSaveDraft}
              onSubmit={handleSubmit}
              isSaving={isSaving}
              persistenceDisabled={propertyLoading || Boolean(propertyLoadError) || isPersistenceDisabled(persistenceChecked, persistenceError) || (!existingMatter && !classificationReady)}
            />
          </div>

          <div className="lg:col-span-1">
            <Card className="sticky top-8">
              <CardHeader>
                <CardTitle>Transfer Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Form checks — not legal readiness
                    </div>
                    <div className="text-2xl font-bold text-teal-600 dark:text-teal-400">
                      {getProgressPercentage(state)}%
                    </div>
                  </div>

                  <div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Current Step
                    </div>
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {currentStep === 1 && 'Property Details'}
                      {currentStep === 2 && 'Parties Information'}
                      {currentStep === 3 && 'Financial Information'}
                      {currentStep === 4 && 'Documents'}
                      {currentStep === 5 && 'Review & Save'}
                    </div>
                  </div>

                  <div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      Status
                    </div>
                    <div className="font-medium text-gray-900 dark:text-gray-100 capitalize">
                      {state.status.replace('_', ' ')}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

export { Transfers }
