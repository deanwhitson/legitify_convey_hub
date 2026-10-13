import React, { useState } from 'react'
import { IdVerificationEntry } from '@/components/transfers/IdVerificationEntry'
import type { Party } from '@/components/transfers/TransferForm'
import { simulateVeriffUiOutcome, resetDemoSubject } from './mockBackend'

const TRANSFER_ID = '11111111-1111-1111-1111-111111111111'
const PARTY_A = '22222222-2222-2222-2222-222222222222'
const PARTY_B = '33333333-3333-3333-3333-333333333333'
const COMPANY_C = '44444444-4444-4444-4444-444444444444'

const mk = (over: Partial<Party>): Party => ({
  id: 'ui-x',
  source: 'manual',
  type: 'buyer',
  name: '',
  idNumber: '',
  email: '',
  phone: '',
  address: '',
  ...over,
})

const parties: Party[] = [
  mk({ id: 'ui-a', persistedPartyId: PARTY_A, name: 'Synthetic Person Alpha', entityType: 'person', type: 'seller' }),
  mk({ id: 'ui-b', persistedPartyId: PARTY_B, name: 'Synthetic Person Beta', entityType: 'person' }),
  mk({ id: 'ui-c', persistedPartyId: COMPANY_C, name: 'Synthetic Entity Ltd', entityType: 'company', company: 'Synthetic Entity Ltd' }),
]

/**
 * Harness shell — mounts the real IdVerificationEntry (the same component
 * StepParties renders) over a fully synthetic in-page backend. Used by
 * scripts/idv-harness-check.mjs for mounted-browser checks and by the team
 * for the offline click-through demo.
 */
export const HarnessApp: React.FC = () => {
  const [demoParties, setDemoParties] = useState(parties)
  return (
  <div className="min-h-screen bg-gray-100 p-6">
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>ID-verification demo harness.</strong> Fully synthetic — a
        labelled in-page backend stands in for the server; no auth, database
        or provider traffic occurs. Subjects are fictional.
      </div>
      {demoParties.map(p => (
        <div key={p.id} className="rounded-xl bg-white p-4 shadow">
          <h3 className="text-sm font-semibold text-gray-900">{p.name}</h3>
          <p className="text-xs text-gray-500 mb-2">
            {p.entityType} · party {p.persistedPartyId?.slice(0, 8)}…
          </p>
          <IdVerificationEntry party={p} transferId={TRANSFER_ID} allParties={demoParties}
            invitationDemo onConfirmContact={(id, contact) => {
              const subject = demoParties.find(person => person.id === id)
              if (subject?.persistedPartyId && (subject.name !== contact.fullName || subject.email !== contact.email || subject.phone !== contact.phone)) resetDemoSubject(subject.persistedPartyId)
              setDemoParties(current => current.map(person => person.id === id ? { ...person, name: contact.fullName, email: contact.email, phone: contact.phone } : person))
            }} />
          {new URLSearchParams(window.location.search).get('provider') === 'veriff' && p.entityType === 'person' && (
            <div className="mt-4 border-t pt-2 text-xs">
              <p>Demo controls: create a session first, simulate an outcome, then Refresh status.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['pending', 'verified', 'declined', 'review_required'] as const).map(status => (
                  <button key={status} className="rounded border px-2 py-1"
                    onClick={() => simulateVeriffUiOutcome(p.persistedPartyId!, status)}>
                    Simulate {status.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  </div>
)
}

export default HarnessApp
