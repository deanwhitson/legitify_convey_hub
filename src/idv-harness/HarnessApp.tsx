import React from 'react'
import { IdVerificationEntry } from '@/components/transfers/IdVerificationEntry'
import type { Party } from '@/components/transfers/TransferForm'

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
export const HarnessApp: React.FC = () => (
  <div className="min-h-screen bg-gray-100 p-6">
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>ID-verification demo harness.</strong> Fully synthetic — a
        labelled in-page backend stands in for the server; no auth, database
        or provider traffic occurs. Subjects are fictional.
      </div>
      {parties.map(p => (
        <div key={p.id} className="rounded-xl bg-white p-4 shadow">
          <h3 className="text-sm font-semibold text-gray-900">{p.name}</h3>
          <p className="text-xs text-gray-500 mb-2">
            {p.entityType} · party {p.persistedPartyId?.slice(0, 8)}…
          </p>
          <IdVerificationEntry party={p} transferId={TRANSFER_ID} allParties={parties} />
        </div>
      ))}
    </div>
  </div>
)

export default HarnessApp
