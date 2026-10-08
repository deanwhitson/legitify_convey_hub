import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { readNavigationState } from '@/lib/navigationState'
import { Users, Plus, Trash2, User, Star, Phone, Mail, AlertTriangle, ShieldCheck } from 'lucide-react'
import { Card, CardContent } from '@/components/ui'
import { Input } from '@/components/ui'
import { Button } from '@/components/ui'
import { useTransfer, Party } from './TransferForm'
import { IdVerificationPanel } from './IdVerificationPanel'
import { findPotentialDuplicates } from '@/lib/utils/partyDuplicates'
import type { GoldenRecord, GoldenRecordEntityType } from '@/lib/api/goldenRecordsApi'

const validateIDNumber = (idNumber: string): boolean => {
  // Basic SA ID validation (13 digits)
  return /^\d{13}$/.test(idNumber)
}

const validateEmail = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

interface PartyCardProps {
  party: Party
  isPrimary?: boolean
  sameTypeCount: number
  duplicates: { identifierMatches: Party[]; nameMatches: Party[] }
  /** Persisted transfer id — verification is only available on a saved matter. */
  transferId?: string
  /** All parties, for selecting a natural-person representative. */
  allParties: Party[]
  onUpdate: (id: string, field: keyof Party, value: string | boolean) => void
  onRemove: (id: string) => void
  onSetPrimary: (type: 'buyer' | 'seller', partyId: string) => void
}

const PartyCard: React.FC<PartyCardProps> = ({
  party,
  isPrimary,
  sameTypeCount,
  duplicates,
  transferId,
  allParties,
  onUpdate,
  onRemove,
  onSetPrimary
}) => {
  const duplicateNames = [...duplicates.identifierMatches, ...duplicates.nameMatches]
    .map(p => p.name || 'another party')
  const needsAcknowledgement = duplicateNames.length > 0 && !party.acknowledgedDuplicate
  const isPersonParty = !party.entityType || party.entityType === 'person'
  // Staff-opened verification panel state. A company/trust party verifies via
  // a chosen natural-person representative — never the entity itself.
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [representativePartyId, setRepresentativePartyId] = useState('')
  const personSubjects = allParties.filter(
    p => (!p.entityType || p.entityType === 'person') && p.persistedPartyId && p.id !== party.id
  )
  const representativeSubject = isPersonParty
    ? undefined
    : personSubjects.find(p => p.persistedPartyId === representativePartyId)

  return (
  <Card variant="premium" className="animate-in fade-in slide-in-from-bottom-3 duration-300 hover:shadow-premium transition-all duration-300">
    <CardContent className="p-4 space-y-4">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            party.type === 'buyer'
              ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
              : 'bg-green-100 dark:bg-green-900/20 text-green-600 dark:text-green-400'
          }`}>
            <User className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-medium text-gray-900 dark:text-gray-100 capitalize">
                {party.type}
              </span>
              {party.source === 'golden_record' ? (
                <span className="inline-flex items-center space-x-1 text-xs text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-900/20 px-2 py-0.5 rounded-full">
                  <ShieldCheck className="h-3 w-3" />
                  <span>Golden Record</span>
                </span>
              ) : (
                <span className="text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-navy-800 px-2 py-0.5 rounded-full">
                  Manual entry
                </span>
              )}
              {isPrimary && (
                <div className="flex items-center space-x-1">
                  <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />
                  <span className="text-xs text-yellow-600 dark:text-yellow-400 font-medium">
                    Primary
                  </span>
                </div>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {party.entityType === 'trust' ? 'Trust' : party.company || 'Individual'}
              {party.entityType === 'trust' && ` · Registration: ${party.registrationNo ?? 'Not available'} · Master’s Office: ${party.mastersOffice ?? 'Not available'}`}
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          {sameTypeCount > 1 && !isPrimary && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSetPrimary(party.type, party.id)}
              className="text-yellow-600 hover:text-yellow-700 hover:bg-yellow-50 dark:hover:bg-yellow-900/20"
              title="Set as primary"
            >
              <Star className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onRemove(party.id)}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
            title="Remove party"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {party.source === 'manual' && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Captured manually for this matter — not a Golden Record and not verified.
        </p>
      )}

      {duplicateNames.length > 0 && (
        <div className="flex items-start space-x-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5" />
          <div className="text-xs text-amber-800 dark:text-amber-200 space-y-1">
            <p>
              Possible duplicate: this party shares
              {duplicates.identifierMatches.length > 0 ? ' an identifier' : ' a name'} with{' '}
              {duplicateNames.join(', ')}. Parties are never merged automatically.
            </p>
            <label className="flex items-center space-x-2">
              <input
                type="checkbox"
                checked={Boolean(party.acknowledgedDuplicate)}
                onChange={(e) => onUpdate(party.id, 'acknowledgedDuplicate', e.target.checked)}
              />
              <span>
                {needsAcknowledgement
                  ? 'Confirm this is a different person (kept as a separate party)'
                  : 'Kept as a separate party'}
              </span>
            </label>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Full Name *
          </label>
          <Input
            variant="premium"
            placeholder="Full name"
            value={party.name}
            onChange={(e) => onUpdate(party.id, 'name', e.target.value)}
            className="text-sm transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            ID/Reg Number *
          </label>
          <Input
            variant="premium"
            placeholder="SA ID or Company Reg"
            value={party.idNumber}
            onChange={(e) => onUpdate(party.id, 'idNumber', e.target.value)}
            className={`text-sm transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 ${
              (!party.entityType || party.entityType === 'person') && (!party.idType || party.idType === 'sa_id') && party.idNumber && !validateIDNumber(party.idNumber) ? 'border-red-500' : ''
            }`}
          />
          {party.source === 'manual' && (
            <select
              value={party.idType ?? 'sa_id'}
              onChange={(e) => onUpdate(party.id, 'idType', e.target.value)}
              className="mt-1 w-full text-xs rounded-md border border-gray-300 dark:border-navy-600 bg-white dark:bg-navy-800 text-gray-700 dark:text-gray-200 px-2 py-1"
            >
              <option value="sa_id">SA ID</option>
              <option value="passport">Passport</option>
              <option value="other">Other identifier</option>
            </select>
          )}
          {(!party.entityType || party.entityType === 'person') && (!party.idType || party.idType === 'sa_id') && party.idNumber && !validateIDNumber(party.idNumber) && (
            <p className="text-xs text-red-500 mt-1">Invalid ID/Reg number format</p>
          )}
        </div>

        {party.source === 'manual' && party.idType === 'passport' && (
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Passport Country
            </label>
            <Input
              variant="premium"
              placeholder="e.g. ZA"
              value={party.passportCountry ?? ''}
              onChange={(e) => onUpdate(party.id, 'passportCountry', e.target.value)}
              className="text-sm transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Email *
          </label>
          <Input
            variant="premium"
            placeholder="email@example.com"
            value={party.email}
            onChange={(e) => onUpdate(party.id, 'email', e.target.value)}
            className={`text-sm transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500 ${
              party.email && !validateEmail(party.email) ? 'border-red-500' : ''
            }`}
          />
          {party.email && !validateEmail(party.email) && (
            <p className="text-xs text-red-500 mt-1">Invalid email format</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Phone *
          </label>
          <Input
            variant="premium"
            placeholder="+27 12 345 6789"
            value={party.phone}
            onChange={(e) => onUpdate(party.id, 'phone', e.target.value)}
            className="text-sm transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Company
          </label>
          <Input
            variant="premium"
            placeholder="Company name (optional)"
            value={party.company}
            onChange={(e) => onUpdate(party.id, 'company', e.target.value)}
            className="text-sm transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            Role
          </label>
          <Input
            variant="premium"
            placeholder="Role or title"
            value={party.role}
            onChange={(e) => onUpdate(party.id, 'role', e.target.value)}
            className="text-sm transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          Address
        </label>
        <Input
          variant="premium"
          placeholder="Street address"
          value={party.address}
          onChange={(e) => onUpdate(party.id, 'address', e.target.value)}
          className="text-sm transition-all duration-200 focus:ring-2 focus:ring-teal-500 focus:border-teal-500"
        />
      </div>

      {/* Contact Summary */}
      {(party.email || party.phone) && (
        <div className="flex items-center space-x-4 text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-200 dark:border-navy-700">
          {party.email && (
            <div className="flex items-center space-x-1">
              <Mail className="h-3 w-3" />
              <span>{party.email}</span>
            </div>
          )}
          {party.phone && (
            <div className="flex items-center space-x-1">
              <Phone className="h-3 w-3" />
              <span>{party.phone}</span>
            </div>
          )}
        </div>
      )}

      {/* Identity verification (Sumsub POC) — saved parties only. */}
      <div className="pt-2 border-t border-gray-200 dark:border-navy-700">
        {!party.persistedPartyId || !transferId ? (
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Save the matter to enable identity verification for this party.
          </p>
        ) : !verifyOpen ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setVerifyOpen(true)}
            title={
              isPersonParty
                ? 'Verify this person’s identity'
                : 'Verify a natural-person representative for this entity'
            }
          >
            <ShieldCheck className="h-4 w-4 mr-1" />
            {isPersonParty ? 'Verify identity' : 'Verify representative'}
          </Button>
        ) : isPersonParty ? (
          <IdVerificationPanel
            key={party.persistedPartyId}
            transferId={transferId}
            subjectPartyId={party.persistedPartyId}
            subjectName={party.name || 'Unnamed party'}
            onClose={() => setVerifyOpen(false)}
          />
        ) : personSubjects.length === 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            A company or trust is never verified as a passport holder. Save a
            natural-person party first to select an authorised representative.
          </p>
        ) : (
          <div className="space-y-2">
            <label
              htmlFor={`representative-${party.id}`}
              className="block text-xs font-medium text-gray-700 dark:text-gray-300"
            >
              Select the natural-person representative to verify
            </label>
            <select
              id={`representative-${party.id}`}
              className="w-full text-sm rounded-md border border-gray-300 dark:border-navy-600 bg-white dark:bg-navy-800 text-gray-700 dark:text-gray-200 px-2 py-1"
              value={representativePartyId}
              onChange={e => setRepresentativePartyId(e.target.value)}
            >
              <option value="">Choose a person…</option>
              {personSubjects.map(p => (
                <option key={p.persistedPartyId} value={p.persistedPartyId}>
                  {p.name || 'Unnamed party'}
                </option>
              ))}
            </select>
            {representativeSubject ? (
              <IdVerificationPanel
                key={`${party.persistedPartyId}:${representativeSubject.persistedPartyId}`}
                transferId={transferId}
                subjectPartyId={representativeSubject.persistedPartyId!}
                subjectName={representativeSubject.name || 'Unnamed party'}
                onBehalfOfPartyId={party.persistedPartyId}
                onBehalfOfName={party.name || party.company || 'this entity'}
                onClose={() => setVerifyOpen(false)}
              />
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setVerifyOpen(false)}>
                Cancel
              </Button>
            )}
          </div>
        )}
      </div>
    </CardContent>
  </Card>
  )
}

export function goldenRecordToParty(record: GoldenRecord, id: string): Party {
  return {
    id,
    source: 'golden_record',
    clientRequestId: crypto.randomUUID(),
    type: 'buyer',
    goldenRecordId: record.goldenRecordId,
    entityType: record.entityType,
    registrationNo: record.registrationNo,
    mastersOffice: record.mastersOffice,
    isTrust: record.isTrust,
    name: record.name,
    idNumber: record.entityType === 'person' ? record.idNumber : record.registrationNo ?? '',
    email: record.email || '',
    phone: record.phone || '',
    address: record.address || '',
    company: record.entityType === 'person' ? '' : record.name,
    isPrimary: true
  }
}

const StepParties: React.FC = () => {
  const { state, dispatch } = useTransfer()
  const { parties } = state
  // The UUID matter id — the human transfer_id code is not a valid path param.
  const transferId = state.id
  const location = useLocation()
  const goldenRecord = readNavigationState(location.state)?.goldenRecord as GoldenRecord | undefined
  const goldenRecordSearch = readNavigationState(location.state)?.goldenRecordSearch as { entityType: GoldenRecordEntityType; query: string } | undefined

  // Auto-populate buyer from golden record if available
  useEffect(() => {
    if (parties.filter(p => p.type === 'buyer').length > 0) return

    if (goldenRecord) {
      const newParty = goldenRecordToParty(goldenRecord, Date.now().toString())
      dispatch({ type: 'ADD_PARTY', payload: newParty })
    } else if (goldenRecordSearch) {
      const newParty: Party = {
        id: Date.now().toString(),
        source: 'manual',
        clientRequestId: crypto.randomUUID(),
        type: 'buyer',
        entityType: goldenRecordSearch.entityType,
        name: '',
        idNumber: '',
        email: '',
        phone: '',
        address: '',
        company: '',
        isPrimary: true
      }
      dispatch({ type: 'ADD_PARTY', payload: newParty })
    }
  }, [goldenRecord, goldenRecordSearch, dispatch, parties])

  const addParty = (type: 'buyer' | 'seller') => {
    const newParty: Party = {
      id: Date.now().toString(),
      source: 'manual',
      clientRequestId: crypto.randomUUID(),
      type,
      name: '',
      idNumber: '',
      email: '',
      phone: '',
      address: '',
      company: '',
      role: '',
      isPrimary: type === 'buyer' && parties.filter(p => p.type === 'buyer').length === 0
    }
    dispatch({ type: 'ADD_PARTY', payload: newParty })
  }

  const updateParty = (id: string, field: keyof Party, value: string | boolean) => {
    dispatch({
      type: 'UPDATE_PARTY',
      payload: { id, updates: { [field]: value } }
    })
  }

  const removeParty = (id: string) => {
    dispatch({ type: 'REMOVE_PARTY', payload: id })
  }

  const setPrimaryParty = (type: 'buyer' | 'seller', partyId: string) => {
    // First, remove primary status from all parties of this type
    parties
      .filter(p => p.type === type)
      .forEach(party => {
        dispatch({
          type: 'UPDATE_PARTY',
          payload: { id: party.id, updates: { isPrimary: false } }
        })
      })

    // Then set the new primary
    dispatch({
      type: 'UPDATE_PARTY',
      payload: { id: partyId, updates: { isPrimary: true } }
    })
  }

  const getPartiesByType = (type: 'buyer' | 'seller') => {
    return parties.filter(party => party.type === type)
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-right-5 duration-500">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Parties Information
        </h2>
        <p className="text-gray-600 dark:text-gray-400">
          Add buyers and sellers involved in this transfer
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Buyers Section */}
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center">
                <Users className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Buyers
              </h3>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                ({getPartiesByType('buyer').length})
              </span>
            </div>
            <Button
              variant="premium-secondary"
              size="sm"
              onClick={() => addParty('buyer')}
              className="transition-all duration-200 hover:scale-105"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Buyer
            </Button>
          </div>

          <div className="space-y-3">
            {getPartiesByType('buyer').length === 0 ? (
              <Card variant="glass">
                <CardContent className="p-6 text-center">
                  <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center mx-auto mb-3">
                    <User className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                    No buyers added yet
                  </p>
                  <Button
                    variant="premium-primary"
                    size="sm"
                    onClick={() => addParty('buyer')}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add First Buyer
                  </Button>
                </CardContent>
              </Card>
            ) : (
              getPartiesByType('buyer').map((party) => (
                <PartyCard
                  key={party.id}
                  party={party}
                  isPrimary={party.isPrimary}
                  sameTypeCount={getPartiesByType('buyer').length}
                  duplicates={findPotentialDuplicates(party, parties)}
                  transferId={transferId}
                  allParties={parties}
                  onUpdate={updateParty}
                  onRemove={removeParty}
                  onSetPrimary={setPrimaryParty}
                />
              ))
            )}
          </div>
        </div>

        {/* Sellers Section */}
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/20 flex items-center justify-center">
                <Users className="h-4 w-4 text-green-600 dark:text-green-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Sellers
              </h3>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                ({getPartiesByType('seller').length})
              </span>
            </div>
            <Button
              variant="premium-secondary"
              size="sm"
              onClick={() => addParty('seller')}
              className="transition-all duration-200 hover:scale-105"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Seller
            </Button>
          </div>

          <div className="space-y-3">
            {getPartiesByType('seller').length === 0 ? (
              <Card variant="glass">
                <CardContent className="p-6 text-center">
                  <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/20 flex items-center justify-center mx-auto mb-3">
                    <User className="h-6 w-6 text-green-600 dark:text-blue-400" />
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                    No sellers added yet
                  </p>
                  <Button
                    variant="premium-primary"
                    size="sm"
                    onClick={() => addParty('seller')}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add First Seller
                  </Button>
                </CardContent>
              </Card>
            ) : (
              getPartiesByType('seller').map((party) => (
                <PartyCard
                  key={party.id}
                  party={party}
                  isPrimary={party.isPrimary}
                  sameTypeCount={getPartiesByType('seller').length}
                  duplicates={findPotentialDuplicates(party, parties)}
                  transferId={transferId}
                  allParties={parties}
                  onUpdate={updateParty}
                  onRemove={removeParty}
                  onSetPrimary={setPrimaryParty}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Validation Summary */}
      <Card variant="glass">
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Users className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Total Parties: {parties.length}
              </span>
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              {parties.some(p => p.type === 'buyer') && parties.some(p => p.type === 'seller')
                ? '✓ Both buyers and sellers added'
                : '⚠ Need at least one buyer and one seller'}
            </div>
          </div>

          {/* Party Requirements */}
          <div className="mt-3 space-y-2">
            <div className="text-xs text-gray-600 dark:text-gray-400">
              Requirements:
            </div>
            <div className="flex flex-wrap gap-4 text-xs">
              <div className={`flex items-center space-x-1 ${
                parties.some(p => p.type === 'buyer') ? 'text-green-600' : 'text-red-600'
              }`}>
                <span>{parties.some(p => p.type === 'buyer') ? '✓' : '✗'}</span>
                <span>At least one buyer</span>
              </div>
              <div className={`flex items-center space-x-1 ${
                parties.some(p => p.type === 'seller') ? 'text-green-600' : 'text-red-600'
              }`}>
                <span>{parties.some(p => p.type === 'seller') ? '✓' : '✗'}</span>
                <span>At least one seller</span>
              </div>
              <div className={`flex items-center space-x-1 ${
                parties.some(p => p.type === 'buyer' && p.isPrimary) ? 'text-green-600' : 'text-red-600'
              }`}>
                <span>{parties.some(p => p.type === 'buyer' && p.isPrimary) ? '✓' : '✗'}</span>
                <span>Primary buyer set</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export { StepParties }
