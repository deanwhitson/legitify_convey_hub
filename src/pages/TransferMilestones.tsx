import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Clock, Circle, AlertCircle, Calendar, Building, User, ChevronDown, ChevronUp, History } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent, Modal, UnavailableNotice } from '@/components/ui'
import { Button } from '@/components/ui'
import { Badge } from '@/components/ui'
import { useTransfers, TransferAggregate } from '@/hooks/useTransfers'
import { TransferDocumentsPanel } from '@/components/transfers/TransferDocumentsPanel'
import { TransferAccountsTab } from '@/components/transfers/accounts/TransferAccountsTab'
import { TransferApi, type MatterCoreDetail } from '@/lib/api/transferApi'
import { MatterPropertiesPanel } from '@/components/transfers/MatterPropertiesPanel'
import { ApiRequestError } from '@/lib/api/http'
import { cn } from '@/utils/cn'

export type MilestoneStatus = 'not_started' | 'in_progress' | 'completed' | 'overdue' | 'not_required'

interface PartyDetails {
  fullName: string
  idNumber: string
  email: string
  phone: string
  address: string
}

interface TransferDetails {
  id: string
  property: {
    address: string
    city: string
    province: string
    postalCode: string
    propertyType: string
    erfNumber: string
    legalDescription: string
  }
  buyer: PartyDetails
  seller: PartyDetails
  purchasePrice: number
  createdDate: string
}

const emptyDetails = (id: string): TransferDetails => ({
  id,
  property: { address: '', city: '', province: '', postalCode: '', propertyType: '', erfNumber: '', legalDescription: '' },
  buyer: { fullName: '', idNumber: '', email: '', phone: '', address: '' },
  seller: { fullName: '', idNumber: '', email: '', phone: '', address: '' },
  purchasePrice: 0,
  createdDate: '—'
})

function mapAggregateToDetails(aggregate: TransferAggregate | null): TransferDetails {
  if (!aggregate) return emptyDetails('—')
  const buyer = aggregate.parties?.find(p => p.type === 'buyer')
  const seller = aggregate.parties?.find(p => p.type === 'seller')
  return {
    id: aggregate.transfer_id || aggregate.id || '—',
    property: {
      address: aggregate.propertyDetails?.address || '',
      city: aggregate.propertyDetails?.city || '',
      province: aggregate.propertyDetails?.state || '',
      postalCode: aggregate.propertyDetails?.zipCode || '',
      propertyType: aggregate.propertyDetails?.propertyType || '',
      erfNumber: aggregate.propertyDetails?.lotNumber || '',
      legalDescription: aggregate.propertyDetails?.legalDescription || ''
    },
    buyer: {
      fullName: buyer?.name || '',
      idNumber: buyer?.idNumber || '',
      email: buyer?.email || '',
      phone: buyer?.phone || '',
      address: buyer?.address || ''
    },
    seller: {
      fullName: seller?.name || '',
      idNumber: seller?.idNumber || '',
      email: seller?.email || '',
      phone: seller?.phone || '',
      address: seller?.address || ''
    },
    purchasePrice: parseFloat(aggregate.financials?.purchasePrice || '0') || 0,
    createdDate: aggregate.created_at
      ? new Date(aggregate.created_at).toISOString().split('T')[0]
      : '—'
  }
}

const TransferMilestones: React.FC = () => {
  const { transferId } = useParams<{ transferId: string }>()
  return <TransferMilestonesContent key={transferId || 'missing'} />
}

const TransferMilestonesContent: React.FC = () => {
  const { transferId } = useParams<{ transferId: string }>()
  const navigate = useNavigate()
  const resolvedTransferId = transferId || ''

  const {
    currentTransfer,
    currentMilestones: milestones,
    activity: auditEntries,
    isMilestonesLoading,
    milestonesError,
    isActivityLoading,
    activityError,
    isLoading,
    error,
    fetchTransfer,
    fetchMilestones,
    fetchActivity
  } = useTransfers()

  const [expandedMilestone, setExpandedMilestone] = useState<string | null>(null)
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false)
  const [transfer, setTransfer] = useState<TransferDetails>(() => emptyDetails(resolvedTransferId))
  const [coreDetail, setCoreDetail] = useState<MatterCoreDetail | null>(null)
  const [coreDraft, setCoreDraft] = useState({ title: '', firmReference: '', propertyAddress: '' })
  const [coreError, setCoreError] = useState<string | null>(null)
  const [coreConflict, setCoreConflict] = useState(false)
  const [isSavingCore, setIsSavingCore] = useState(false)
  const [activeTab, setActiveTab] = useState<'milestones' | 'documents' | 'accounts'>('milestones')

  // Load transfer, milestones and activity from the backend.
  useEffect(() => {
    if (!resolvedTransferId) return
    void fetchTransfer(resolvedTransferId)
    void fetchMilestones(resolvedTransferId)
    void fetchActivity(resolvedTransferId)
  }, [resolvedTransferId, fetchTransfer, fetchMilestones, fetchActivity])

  // Load the editable core fields and concurrency tokens through the
  // authenticated v1 lane. The updatedAt strings are echoed back verbatim —
  // never parsed or reformatted.
  const loadCoreDetails = async () => {
    if (!resolvedTransferId) return
    setCoreError(null)
    try {
      const response = await TransferApi.getMatterCore(resolvedTransferId)
      const detail = response.data ?? null
      setCoreDetail(detail)
      setCoreConflict(false)
      setCoreDraft({
        title: detail?.matter?.title ?? '',
        firmReference: detail?.matter?.firmReference ?? '',
        propertyAddress: detail?.propertyAddress ?? ''
      })
    } catch (loadError) {
      setCoreDetail(null)
      setCoreError(loadError instanceof Error ? loadError.message : 'Failed to load matter details')
    }
  }

  useEffect(() => {
    loadCoreDetails()
  }, [resolvedTransferId])

  // Keep local state in sync with hook state returned from the API.
  useEffect(() => {
    setTransfer(mapAggregateToDetails(currentTransfer))
  }, [currentTransfer])

  const completedCount = milestones.filter(m => m.status === 'completed').length
  const inProgressCount = milestones.filter(m => m.status === 'in_progress').length
  const notRequiredCount = milestones.filter(m => m.status === 'not_required').length
  const remainingCount = milestones.filter(m => m.status === 'not_started' || m.status === 'overdue').length

  const saveCoreDetails = async () => {
    if (!resolvedTransferId || !coreDetail?.matter) return
    setIsSavingCore(true)
    setCoreError(null)
    setCoreConflict(false)
    try {
      const response = await TransferApi.updateMatterCore(resolvedTransferId, {
        expected_updated_at: coreDetail.updatedAt,
        expected_matter_updated_at: coreDetail.matter.updatedAt,
        property_address: coreDraft.propertyAddress,
        firm_reference: coreDraft.firmReference.trim() ? coreDraft.firmReference : null,
        title: coreDraft.title.trim() ? coreDraft.title : null
      })
      const detail = response.data ?? null
      setCoreDetail(detail)
      setCoreDraft({
        title: detail?.matter?.title ?? '',
        firmReference: detail?.matter?.firmReference ?? '',
        propertyAddress: detail?.propertyAddress ?? ''
      })
      setIsDetailsExpanded(false)
    } catch (saveError) {
      if (saveError instanceof ApiRequestError && saveError.status === 409) {
        // Another user saved first. Keep the draft edits untouched — the user
        // chooses to reload the latest version or abandon their edit.
        setCoreConflict(true)
      } else {
        setCoreError(saveError instanceof Error ? saveError.message : 'Failed to save matter details')
      }
    } finally {
      setIsSavingCore(false)
    }
  }

  const getStatusIcon = (status: MilestoneStatus) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
      case 'in_progress':
        return <Clock className="h-5 w-5 text-blue-600 dark:text-blue-400" />
      case 'overdue':
        return <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
      case 'not_required':
        return <Circle className="h-5 w-5 text-violet-600 dark:text-violet-400" />
      default:
        return <Circle className="h-5 w-5 text-gray-400 dark:text-gray-500" />
    }
  }

  const getStatusBadgeVariant = (status: MilestoneStatus): 'success' | 'primary' | 'error' | 'default' => {
    switch (status) {
      case 'completed': return 'success'
      case 'in_progress': return 'primary'
      case 'overdue': return 'error'
      case 'not_required': return 'default'
      default: return 'default'
    }
  }

  const getStatusText = (status: MilestoneStatus) => {
    switch (status) {
      case 'completed': return 'Completed'
      case 'in_progress': return 'In Progress'
      case 'overdue': return 'Overdue'
      case 'not_required': return 'Not Required'
      default: return 'Not Started'
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-ZA', {
      style: 'currency',
      currency: 'ZAR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount)
  }

  const formatAuditTimestamp = (timestamp: string) => new Intl.DateTimeFormat('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp))

  const selectedMilestone = milestones.find(milestone => milestone.id === expandedMilestone)

  if (!resolvedTransferId) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-navy-900 flex items-center justify-center">
        <p className="text-gray-600 dark:text-gray-400">No transfer selected.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-navy-900">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => navigate('/transfers')}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Transfers
          </Button>

          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                Transfer Overview
              </h1>
              <p className="text-gray-600 dark:text-gray-400">
                Track progress for {transfer.id}
              </p>
            </div>

          </div>
        </div>

        {isLoading && (
          <div className="mb-6 rounded-lg p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
            <p className="text-sm text-blue-700 dark:text-blue-300">Loading transfer milestones...</p>
          </div>
        )}
        {error && (
          <div className="mb-6">
            <UnavailableNotice
              message="This transfer is temporarily unavailable."
              detail={error}
            />
          </div>
        )}

        {/* Transfer Summary */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-5">
              <div className="flex items-center space-x-2">
                <Building className="w-4 h-4 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Property</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{coreDetail?.propertyAddress || (currentTransfer ? `${transfer.property.address}, ${transfer.property.city}` : '—')}</p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <User className="w-4 h-4 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Buyer</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{currentTransfer ? transfer.buyer.fullName : '—'}</p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <User className="w-4 h-4 text-gray-400" />
                <div>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Seller</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{currentTransfer ? transfer.seller.fullName : '—'}</p>
                </div>
              </div>
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">Purchase Price</p>
                <p className="text-sm font-bold text-gray-900 dark:text-gray-100">{coreDetail?.purchasePrice != null ? formatCurrency(coreDetail.purchasePrice) : (currentTransfer ? formatCurrency(transfer.purchasePrice) : '—')}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setIsDetailsExpanded(current => !current)} disabled={isSavingCore || !coreDetail}>
                {isDetailsExpanded ? <ChevronUp className="mr-2 h-4 w-4" /> : <ChevronDown className="mr-2 h-4 w-4" />}
                {isDetailsExpanded ? 'Hide Details' : 'View & Edit Details'}
              </Button>
            </div>

            {isDetailsExpanded && coreDetail && (
              <div className="mt-5 space-y-6 border-t border-gray-200 pt-5 dark:border-navy-700">
                {coreConflict && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                    This matter was modified by another user since you opened it. Your edits were not
                    saved and are still in the fields below. Reload to see the latest version before
                    saving again.
                    <Button variant="outline" size="sm" className="ml-3" onClick={loadCoreDetails}>
                      Reload latest
                    </Button>
                  </div>
                )}
                {coreError && !coreConflict && (
                  <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
                    {coreError}
                  </div>
                )}
                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                  <div className="space-y-3">
                    <h2 className="font-semibold text-gray-900 dark:text-gray-100">Matter Details</h2>
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Matter Title<input value={coreDraft.title} onChange={event => setCoreDraft(previous => ({ ...previous, title: event.target.value }))} maxLength={255} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-navy-600 dark:bg-navy-700 dark:text-gray-100" /></label>
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Firm Reference<input value={coreDraft.firmReference} onChange={event => setCoreDraft(previous => ({ ...previous, firmReference: event.target.value }))} maxLength={100} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-navy-600 dark:bg-navy-700 dark:text-gray-100" /></label>
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Property Address<input value={coreDraft.propertyAddress} onChange={event => setCoreDraft(previous => ({ ...previous, propertyAddress: event.target.value }))} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-navy-600 dark:bg-navy-700 dark:text-gray-100" /></label>
                  </div>
                  <div className="space-y-3">
                    <h2 className="font-semibold text-gray-900 dark:text-gray-100">Read-only Details</h2>
                    <div><p className="text-xs font-medium text-gray-500 dark:text-gray-400">Reference Number</p><p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{coreDetail.matter?.referenceNumber || '—'}</p></div>
                    <div><p className="text-xs font-medium text-gray-500 dark:text-gray-400">Classification</p><p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{coreDetail.matter?.classificationCode || '—'}</p></div>
                    <div><p className="text-xs font-medium text-gray-500 dark:text-gray-400">Status</p><p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{coreDetail.status || '—'}</p></div>
                    <div><p className="text-xs font-medium text-gray-500 dark:text-gray-400">Purchase Price</p><p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{coreDetail.purchasePrice != null ? formatCurrency(coreDetail.purchasePrice) : '—'}</p></div>
                    <div><p className="text-xs font-medium text-gray-500 dark:text-gray-400">Buyer</p><p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{transfer.buyer.fullName || '—'}</p></div>
                    <div><p className="text-xs font-medium text-gray-500 dark:text-gray-400">Seller</p><p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{transfer.seller.fullName || '—'}</p></div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Party, property-record and financial details are managed in separate workflows and cannot be edited here.</p>
                  </div>
                </div>
                <div className="flex justify-end"><Button onClick={saveCoreDetails} disabled={isSavingCore || !coreDetail.matter}>{isSavingCore ? 'Saving...' : 'Save Details'}</Button></div>
              </div>
            )}
          </CardContent>
        </Card>

        {resolvedTransferId && <MatterPropertiesPanel transferId={resolvedTransferId} />}

        {/* Tabs */}
        <div className="mb-6 border-b border-gray-200 dark:border-navy-700">
          <div className="flex space-x-8">
            <button
              type="button"
              onClick={() => setActiveTab('milestones')}
              className={cn(
                'pb-3 text-sm font-medium border-b-2 transition-colors duration-200',
                activeTab === 'milestones'
                  ? 'border-teal-600 text-teal-600 dark:border-teal-400 dark:text-teal-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('documents')}
              className={cn(
                'pb-3 text-sm font-medium border-b-2 transition-colors duration-200',
                activeTab === 'documents'
                  ? 'border-teal-600 text-teal-600 dark:border-teal-400 dark:text-teal-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              Documents
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('accounts')}
              className={cn(
                'pb-3 text-sm font-medium border-b-2 transition-colors duration-200',
                activeTab === 'accounts'
                  ? 'border-teal-600 text-teal-600 dark:border-teal-400 dark:text-teal-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              )}
            >
              Accounts & Proforma
            </button>
          </div>
        </div>

        {activeTab === 'milestones' ? (
          <>
          <section aria-label="Recorded milestone overview">
          {isMilestonesLoading ? (
            <p role="status" className="mb-6">Loading recorded milestones...</p>
          ) : milestonesError ? (
            <div className="mb-6">
              <UnavailableNotice message="Milestones are temporarily unavailable." detail="No milestone results are shown. This is not an empty or completed workflow." />
              <Button variant="outline" onClick={() => { void fetchMilestones(resolvedTransferId) }}>Retry milestones</Button>
            </div>
          ) : milestones.length === 0 ? (
            <p className="mb-6">No recorded milestones were returned. Workflow readiness has not been evaluated.</p>
          ) : (
          <>
            {/* Progress Overview */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5 mb-6">
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-teal-600 dark:text-teal-400">{milestones.length}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Recorded Milestones</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{completedCount}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Completed</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{inProgressCount}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">In Progress</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-gray-600 dark:text-gray-400">{remainingCount}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Not Started / Overdue</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-2xl font-bold text-violet-600 dark:text-violet-400">{notRequiredCount}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">Not Required</p>
            </CardContent>
          </Card>
        </div>

        {/* Read-only progress context */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">Read-only recorded states, not legal readiness or transfer completion. Milestone editing and workflow transitions are unavailable.</p>
          </CardContent>
        </Card>

        {/* Milestones List */}
        <Card className="mb-6 overflow-hidden">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Calendar className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <span>Overview</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table aria-label="Recorded milestones" className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-navy-800 text-gray-500 dark:text-gray-400 uppercase text-xs tracking-wide">
                <tr>
                  <th className="px-4 py-3 w-12">#</th>
                  <th className="px-4 py-3 w-[15%]">Milestone</th>
                  <th className="px-4 py-3">Recorded Label</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3 w-[12%]">Status</th>
                  <th className="px-4 py-3 w-[15%]">Due Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-navy-700">
                {milestones.map((milestone, index) => (
                  <tr key={milestone.id} className="hover:bg-gray-50 dark:hover:bg-navy-800/50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">{index + 1}</td>
                    <td className="px-4 py-3 w-[15%]">
                      <button type="button" onClick={() => setExpandedMilestone(milestone.id)} className="font-medium text-teal-700 dark:text-teal-300 underline">{milestone.name}</button>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{milestone.statusLabel}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                      {milestone.notes || '-'}
                    </td>
                    <td className="px-4 py-3 w-[12%]">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(milestone.status)}
                        <Badge
                          variant={getStatusBadgeVariant(milestone.status)}
                          size="sm"
                          className={milestone.status === 'not_required' ? 'bg-violet-100 text-violet-800 dark:bg-violet-900/20 dark:text-violet-300' : undefined}
                        >
                          {getStatusText(milestone.status)}
                        </Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-400 w-[15%]">
                      {milestone.dueDate
                        ? new Date(milestone.dueDate).toLocaleString('en-ZA', { dateStyle: 'medium' })
                        : 'Not set'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Modal isOpen={!!selectedMilestone} onClose={() => setExpandedMilestone(null)} title={selectedMilestone?.name || ''} description="Read-only milestone record" size="md">
          {selectedMilestone && (
            <div className="space-y-4">
              <p>Recorded status: {getStatusText(selectedMilestone.status)}</p>
              <p>Recorded label: {selectedMilestone.statusLabel || '—'}</p>
              <p>Due date: {selectedMilestone.dueDate || 'Not recorded'}</p>
              <p className="whitespace-pre-wrap">{selectedMilestone.notes || 'No description recorded.'}</p>
              {selectedMilestone.completedDate && <p>Recorded completion date: {selectedMilestone.completedDate}</p>}
              <div className="flex justify-end"><Button onClick={() => setExpandedMilestone(null)}>Close</Button></div>
            </div>
          )}
        </Modal>
          </>
          )}
          </section>

        <Card role="region" aria-label="Recorded activity">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <History className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <span>Recorded Activity</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isActivityLoading ? (
              <p role="status">Loading recorded activity...</p>
            ) : activityError ? (
              <>
                <UnavailableNotice message="Activity is temporarily unavailable." detail="Activity may be unavailable under the current permissions or service configuration. Milestone availability is independent; no local audit events are substituted." />
                <Button variant="outline" onClick={() => { void fetchActivity(resolvedTransferId) }}>Retry activity</Button>
              </>
            ) : auditEntries.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No recorded activity was returned.</p>
            ) : (
              <div className="space-y-4">
                {auditEntries.map((entry) => (
                  <div key={entry.id} className="flex items-start justify-between gap-4 border-b border-gray-100 pb-4 last:border-0 last:pb-0 dark:border-navy-700">
                    <div className="flex items-start space-x-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300">
                        <User className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{entry.user || 'Actor not recorded'}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">{entry.action}</p>
                      </div>
                    </div>
                    <time className="shrink-0 text-xs text-gray-500 dark:text-gray-400" dateTime={entry.timestamp}>
                      {formatAuditTimestamp(entry.timestamp)}
                    </time>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
          </>
        ) : activeTab === 'documents' ? (
          <TransferDocumentsPanel transferId={resolvedTransferId} />
        ) : (
          <TransferAccountsTab
            transferId={resolvedTransferId}
            propertyAddress={transfer.property.address}
            erfNumber={transfer.property.erfNumber}
            purchasePrice={transfer.purchasePrice}
            buyerName={transfer.buyer.fullName}
            sellerName={transfer.seller.fullName}
          />
        )}
      </div>
    </div>
  )
}

export { TransferMilestones }
