import React, { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui'
import { IdVerificationPanel } from './IdVerificationPanel'
import type { Party } from './TransferForm'

export interface IdVerificationEntryProps {
  /** The party card this entry point renders inside. */
  party: Party
  /** Persisted transfer (matter) id — verification needs a saved matter. */
  transferId?: string
  /** All parties, for selecting a natural-person representative. */
  allParties: Party[]
}

/**
 * The identity-verification entry point rendered inside a PartyCard.
 *
 * Person parties verify themselves; company/trust parties verify through a
 * specifically selected natural-person representative on the same matter —
 * an entity is never the passport subject. Extracted so both StepParties
 * and the offline demo harness mount the identical component.
 */
export const IdVerificationEntry: React.FC<IdVerificationEntryProps> = ({
  party,
  transferId,
  allParties,
}) => {
  const isPersonParty = !party.entityType || party.entityType === 'person'
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [representativePartyId, setRepresentativePartyId] = useState('')
  const personSubjects = allParties.filter(
    p => (!p.entityType || p.entityType === 'person') && p.persistedPartyId && p.id !== party.id
  )
  const representativeSubject = isPersonParty
    ? undefined
    : personSubjects.find(p => p.persistedPartyId === representativePartyId)

  return (
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
  )
}

export default IdVerificationEntry
