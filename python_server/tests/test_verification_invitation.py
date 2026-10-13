import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from services.verification_email import validate_contact,load_email_config,invitation_message,EmailDeliveryUnavailable
from services.verification_invitation import send_invitation
from services.id_verification_service import IdVerificationError

CONTACT = {'fullName':'Ada Example','email':'ada@example.invalid','phone':'+27821234567'}

class ContactTests(unittest.TestCase):
    def test_validation_and_header_injection(self):
        self.assertEqual(validate_contact(CONTACT),CONTACT)
        for change in ({'email':'ada@example.invalid\r\nBcc: x@test.invalid'},{'phone':'0821234567'},{'fullName':'Ada\nBcc'},{'tenantId':1}):
            with self.assertRaises(IdVerificationError):
                validate_contact({**CONTACT,**change})
    def test_missing_or_insecure_smtp_is_unavailable(self):
        for config in ({},{'VERIFICATION_SMTP_HOST':'smtp.example.invalid','VERIFICATION_SMTP_PORT':'25'}):
            with self.assertRaises(EmailDeliveryUnavailable):
                load_email_config(config)
    def test_message_targets_client_and_protects_link(self):
        message = invitation_message('verification@example.invalid',CONTACT['email'],CONTACT['fullName'],'https://alchemy.veriff.com/v/synthetic','test-id')
        self.assertEqual(message['To'],CONTACT['email'])
        self.assertIn('capture your own passport and selfie',message.get_content())
        self.assertIn('Do not forward',message.get_content())

class InvitationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.repo = AsyncMock()
        self.repo.invitation_subject.return_value = {'party_source':'manual','manual_name':'Ada Example','manual_email':CONTACT['email'],'manual_phone':CONTACT['phone']}
        self.repo.latest.return_value = ({'id':'attempt','attempt_no':1},None)
        self.repo.reserve_invitation.return_value = ({'id':'invitation','delivery_state':'sending'},True)
        self.ctx = SimpleNamespace(provider='veriff',repository=self.repo,config=SimpleNamespace(scope='scope'),start=AsyncMock(return_value={'captureUrl':'https://alchemy.veriff.com/v/synthetic','attemptNo':1}))
        self.mailer = AsyncMock()
    async def send(self,contact=CONTACT):
        return await send_invitation(self.ctx,ai=5,transfer_id='matter',party_id='party',subject_kind='party',contact=contact,mailer=self.mailer)
    async def test_missing_email_service_does_not_create_session(self):
        with patch('services.verification_invitation.load_email_config',side_effect=EmailDeliveryUnavailable()):
            with self.assertRaises(EmailDeliveryUnavailable):
                await send_invitation(self.ctx,ai=5,transfer_id='matter',party_id='party',subject_kind='party',contact=CONTACT)
        self.ctx.start.assert_not_awaited()
    async def test_unsaved_recipient_change_rejected_before_session_and_email(self):
        with self.assertRaises(IdVerificationError) as caught:
            await self.send({**CONTACT,'email':'other@example.invalid'})
        self.assertEqual(caught.exception.code,'contact_details_changed')
        self.ctx.start.assert_not_awaited()
        self.mailer.send.assert_not_awaited()
    async def test_success_is_mail_server_acceptance_not_delivery(self):
        result = await self.send()
        self.assertEqual(result['status'],'accepted_by_email_server')
        self.repo.finish_invitation.assert_awaited_once_with('invitation','accepted')
    async def test_interrupted_send_never_claims_success(self):
        self.mailer.send.side_effect = RuntimeError('sensitive transport failure')
        with self.assertRaises(IdVerificationError) as caught:
            await self.send()
        self.assertEqual(caught.exception.code,'email_delivery_unavailable')
        self.repo.finish_invitation.assert_awaited_once_with('invitation','uncertain')
    async def test_uncertain_resend_blocked(self):
        self.repo.reserve_invitation.return_value = ({'id':'invitation','delivery_state':'uncertain'},False)
        with self.assertRaises(IdVerificationError) as caught:
            await self.send()
        self.assertEqual(caught.exception.code,'invitation_unresolved')
        self.mailer.send.assert_not_awaited()
