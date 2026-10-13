import { useState } from 'react'
import { Button } from '@/components/ui'
import type { Party } from './TransferForm'
import { IdVerificationApi } from '@/lib/api/idVerification'

export interface VerificationContact { fullName: string; email: string; phone: string }

export function validateVerificationContact(contact: VerificationContact): string | null {
  if (contact.fullName.trim().length < 2 || contact.fullName.trim().length > 150) return 'Enter the full legal name as shown on the passport.'
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contact.email.trim()) || contact.email.length > 254) return 'Enter a valid email address.'
  if (!/^\+[1-9]\d{7,14}$/.test(contact.phone.replace(/[\s()-]/g, ''))) return 'Enter a cell number with country code, for example +27 82 123 4567.'
  return null
}

export function VerificationInvitation({ party, transferId, onBehalfOfPartyId, onBehalfOfName, demo = false, onConfirmed, onCancel }:
  { party: Party; transferId: string; onBehalfOfPartyId?: string; onBehalfOfName?: string; demo?: boolean;
    onConfirmed: (contact: VerificationContact) => void; onCancel: () => void }) {
  const [contact, setContact] = useState<VerificationContact>({ fullName: party.name, email: party.email, phone: party.phone })
  const [step, setStep] = useState<'details' | 'confirm' | 'sent'>('details')
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sentContact, setSentContact] = useState<VerificationContact | null>(null)
  const edit = (field: keyof VerificationContact, value: string) => {
    setContact(current => ({ ...current, [field]: value })); setError(null); setConfirmed(false)
  }
  const review = () => {
    const invalid = validateVerificationContact(contact)
    if (invalid) { setError(invalid); return }
    setContact({ fullName: contact.fullName.trim(), email: contact.email.trim(), phone: contact.phone.replace(/[\s()-]/g, '') })
    setStep('confirm'); setError(null)
  }
  const send = async () => {
    if (!confirmed || busy) return
    setBusy(true); setError(null)
    try {
      if (!demo) {
        const result = await IdVerificationApi.sendInvitation(transferId, party.persistedPartyId!, contact, onBehalfOfPartyId)
        if (result?.data?.status !== 'accepted_by_email_server') throw new Error('Send acceptance not confirmed')
      }
      setSentContact({ ...contact }); setStep('sent')
    } catch {
      setError('The email invitation could not be sent. Check the saved person details and email-service configuration. No successful send is recorded here.')
    } finally { setBusy(false) }
  }
  return <section className="space-y-4 rounded-lg border border-teal-200 p-4" data-testid="verification-invitation">
    <div><h4 className="font-semibold text-gray-900">Confirm person to verify</h4>
      <p className="text-xs text-gray-500">Matter: {transferId.slice(0, 8)}…{onBehalfOfName ? ` · Representative of ${onBehalfOfName}` : ''}</p>
    </div>
    {demo && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">Demo only — use fictional contact details. No email or SMS will be sent.</p>}
    {step === 'details' && <form className="space-y-3" onSubmit={event => { event.preventDefault(); review() }}>
      <label className="block text-sm">Full legal name <span aria-hidden="true">*</span>
        <input className="mt-1 block w-full rounded border p-2" required maxLength={150} autoComplete="name" value={contact.fullName} onChange={e => edit('fullName', e.target.value)} /></label>
      <p className="text-xs text-gray-500">Use the name exactly as it appears on the passport.</p>
      <label className="block text-sm">Email address <span aria-hidden="true">*</span>
        <input className="mt-1 block w-full rounded border p-2" type="email" required maxLength={254} autoComplete="email" value={contact.email} onChange={e => edit('email', e.target.value)} /></label>
      <label className="block text-sm">Cell phone number <span aria-hidden="true">*</span>
        <input className="mt-1 block w-full rounded border p-2" type="tel" required autoComplete="tel" placeholder="+27 82 123 4567" value={contact.phone} onChange={e => edit('phone', e.target.value)} /></label>
      <p className="text-xs text-gray-500">The invitation will be sent by email. The cell number is captured for contact purposes.</p>
      {!demo && <p className="text-xs text-gray-500">These details must match the saved person on this matter. Save any corrections on the matter before sending.</p>}
      <div className="flex gap-2"><Button type="submit" size="sm">Review invitation</Button><Button type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</Button></div>
    </form>}
    {step === 'confirm' && <div className="space-y-3">
      <dl className="rounded bg-gray-50 p-3 text-sm"><dt className="text-xs text-gray-500">Person</dt><dd className="break-words font-medium">{contact.fullName}</dd>
        <dt className="mt-2 text-xs text-gray-500">Send invitation to</dt><dd className="break-words">{contact.email}</dd>
        <dt className="mt-2 text-xs text-gray-500">Cell number</dt><dd>{contact.phone}</dd></dl>
      <p className="text-sm">The client will open a secure Veriff link and capture their own passport and selfie. The attorney must not complete capture for the client.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I confirm this is the intended person and their contact details are correct.</label>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!confirmed || busy} onClick={() => { void send() }}>{busy ? 'Sending…' : demo ? 'Send verification invitation (demo)' : 'Send verification invitation'}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setStep('details'); setConfirmed(false) }}>Edit details</Button></div>
    </div>}
    {step === 'sent' && sentContact && <div className="space-y-3" role="status">
      <p className="font-medium">{demo ? 'Invitation simulated — no email sent' : 'Invitation accepted by the email server'}</p>
      <p className="break-words text-sm">{sentContact.fullName} · {sentContact.email}</p>
      <p className="text-xs text-gray-500">{demo ? 'Continue to inspect the verification screens and simulate the client’s result.' : 'Sending an invitation does not verify identity or confirm delivery. Refresh the verification result after the client finishes capture.'}</p>
      <Button size="sm" onClick={() => onConfirmed(sentContact)}>View verification status</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>
}
