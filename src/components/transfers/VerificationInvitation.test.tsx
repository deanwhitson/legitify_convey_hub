import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { validateVerificationContact, VerificationInvitation } from './VerificationInvitation'
import type { Party } from './TransferForm'

const contact = { fullName: 'Ada Example', email: 'ada@example.invalid', phone: '+27 82 123 4567' }
test('Invitation requires legal name, valid email and international cell number', () => {
  assert.equal(validateVerificationContact(contact), null)
  for (const broken of [{...contact,fullName:''},{...contact,email:'invalid'},{...contact,phone:'0821234567'},{...contact,phone:'+27abc12345'}]) {
    assert.ok(validateVerificationContact(broken))
  }
})
test('Attorney sees prefilled details and demo invitation is explicitly unsent', () => {
  const party = { id:'a',source:'manual',type:'buyer',name:contact.fullName,email:contact.email,phone:contact.phone,idNumber:'',address:'' } as Party
  const html = renderToStaticMarkup(<VerificationInvitation party={party} transferId="matter" demo onConfirmed={() => {}} onCancel={() => {}} />)
  assert.match(html,/Confirm person to verify/)
  assert.match(html,/Full legal name/)
  assert.match(html,/Email address/)
  assert.match(html,/Cell phone number/)
  assert.match(html,/No email or SMS will be sent/)
  assert.match(html,/Review invitation/)
  assert.match(html,/Ada Example/)
})
