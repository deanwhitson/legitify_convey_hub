"""Offline tests for the personal POC. No SMTP/provider/database traffic."""
import hashlib
import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock,patch
from uuid import uuid4
from datetime import datetime,timezone
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root))
sys.path.insert(0,str(root.parent/'output/neon-test-deps'))
poc=importlib.import_module('poc_live.app')
ENV={'POC_OWNER_EMAIL':'owner@example.invalid','POC_ENCRYPTION_KEY':Fernet.generate_key().decode(),
     'POC_LIVE_API_KEY':'synthetic-live','POC_LIVE_SHARED_SECRET':'synthetic-secret',
     'POC_LIVE_BASE_URL':'https://api-saas.veriff.com','POC_TRIAL_CONFIRMED':'yes',
     'POC_LIVE_ENABLED_UNTIL':'9999999999','POC_TEST_KEY_HASH':hashlib.sha256(b'synthetic-test').hexdigest()}

class PersonalPocTests(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,ENV);self.env.start()
        self.db_guard=patch('psycopg.connect',side_effect=AssertionError('Real DB blocked'));self.db_guard.start()
        self.smtp_guard=patch('smtplib.SMTP_SSL',side_effect=AssertionError('Real SMTP blocked'));self.smtp_guard.start()
        self.http=TestClient(poc.app,base_url='https://poc.example.test')
        self.headers={'Origin':'https://poc.example.test','X-Poc-Request':'1'}
    def tearDown(self):
        self.http.close();self.smtp_guard.stop();self.db_guard.stop();self.env.stop()
    def row(self):
        return {'id':str(uuid4()),'session_id':str(uuid4()),'external_ref':'synthetic-ref',
                'contact_encrypted':poc.seal({'fullName':'Ada Example','email':'ada@example.invalid','phone':'+27821234567'})}
    def decision(self,row,code=9001,status='approved'):
        return {'verification':{'id':row['session_id'],'endUserId':row['id'],'vendorData':row['external_ref'],
            'code':code,'status':status,'person':{'firstName':'Ada','lastName':'Example'},
            'document':{'type':'PASSPORT','validUntil':'2035-01-01'}}}
    def test_private_cases_require_owner_signin_before_db(self):
        self.assertEqual(self.http.get('/api/cases').status_code,401)
        self.assertEqual(self.http.post('/api/cases',headers=self.headers,json={}).status_code,401)
    def test_mutations_reject_wrong_or_missing_origin(self):
        for headers in ({},{'Origin':'https://evil.example','X-Poc-Request':'1'}):
            self.assertEqual(self.http.post('/api/auth/code',headers=headers,json={}).status_code,403)
    def test_cookie_bound_to_owner_purpose_and_expiry(self):
        from types import SimpleNamespace
        for token in (poc.seal({'owner':'other@example.invalid','purpose':'poc_owner_session','exp':9999999999}),
                      poc.seal({'owner':ENV['POC_OWNER_EMAIL'],'purpose':'other','exp':9999999999}),
                      poc.seal({'owner':ENV['POC_OWNER_EMAIL'],'purpose':'poc_owner_session','exp':1})):
            with self.assertRaises(Exception):poc.authenticate(SimpleNamespace(cookies={poc.COOKIE:token}))
    def test_owner_cookie_is_accepted_and_contacts_encrypted(self):
        from types import SimpleNamespace
        token=poc.seal({'owner':ENV['POC_OWNER_EMAIL'],'purpose':'poc_owner_session','exp':9999999999})
        poc.authenticate(SimpleNamespace(cookies={poc.COOKIE:token}))
        row=self.row();self.assertNotIn('Ada Example',row['contact_encrypted'])
        self.assertEqual(poc.unseal(row['contact_encrypted'])['fullName'],'Ada Example')
    def test_contact_and_confirmation_validation(self):
        body={'fullName':'Ada Example','email':'ada@example.invalid','phone':'+27 82 123 4567','requestId':str(uuid4()),'confirmRecipient':True}
        self.assertEqual(poc.contact_input(body)[0]['phone'],'+27821234567')
        for extra in ({'confirmRecipient':False},{'phone':'0821234567'},{'email':'x\r\nBcc:bad'},{'fullName':'!!'},{'providerStatus':'verified'}):
            with self.assertRaises(Exception):poc.contact_input({**body,**extra})
    def test_test_key_and_expired_trial_window_block_creation(self):
        with patch.dict(os.environ,{'POC_LIVE_API_KEY':'synthetic-test'}):
            with self.assertRaises(Exception):poc.provider_config(allow_creation=True)
        with patch.dict(os.environ,{'POC_LIVE_ENABLED_UNTIL':'1'}):
            with self.assertRaises(Exception):poc.provider_config(allow_creation=True)
            self.assertEqual(poc.provider_config().mode,'trial')
    def test_result_requires_bound_approved_current_passport_and_name(self):
        row=self.row();data=self.decision(row)
        self.assertEqual(poc.decision_summary(data,row)['status'],'verified')
        for field,value in [('type','ID_CARD'),('validUntil','2020-01-01'),('validUntil',None)]:
            altered=self.decision(row);altered['verification']['document'][field]=value
            self.assertEqual(poc.decision_summary(altered,row)['status'],'review_required')
        altered=self.decision(row);altered['verification']['person']['firstName']='Other'
        self.assertEqual(poc.decision_summary(altered,row)['status'],'review_required')
        altered=self.decision(row);altered['verification']['vendorData']='other'
        with self.assertRaises(Exception):poc.decision_summary(altered,row)
    def test_pending_declined_and_unknown_are_distinct(self):
        row=self.row()
        self.assertEqual(poc.decision_summary({'verification':None},row)['status'],'pending')
        self.assertEqual(poc.decision_summary(self.decision(row,9102,'declined'),row)['status'],'declined')
        self.assertEqual(poc.decision_summary(self.decision(row,9999,'approved'),row)['status'],'review_required')
    def test_html_exposes_no_caller_secret_or_simulated_result_controls(self):
        r=self.http.get('/');self.assertEqual(r.status_code,200)
        self.assertNotIn(ENV['POC_ENCRYPTION_KEY'],r.text)
        self.assertNotIn('synthetic-secret',r.text)
        self.assertNotIn('Simulate verified',r.text)
    def test_logout_clears_secure_httponly_cookie(self):
        r=self.http.post('/api/auth/logout',headers=self.headers,json={})
        self.assertEqual(r.status_code,200)
        cookie=r.headers['set-cookie'];self.assertIn('HttpOnly',cookie);self.assertIn('Secure',cookie);self.assertIn('SameSite=strict',cookie)

    def sign_in_cookie(self):
        self.http.cookies.set(poc.COOKIE,poc.seal({'owner':ENV['POC_OWNER_EMAIL'],'purpose':'poc_owner_session','exp':9999999999}))

    def full_row(self):
        row=self.row();row.update(status='pending',creation_state='ready',email_state='accepted',
            summary={},created_at=datetime.now(timezone.utc),updated_at=datetime.now(timezone.utc))
        return row

    def test_confirmed_invitation_checks_signature_before_sending_to_client(self):
        self.sign_in_cookie();row=self.full_row();provider=AsyncMock()
        provider.create_session.return_value={'id':row['session_id'],'url':'https://alchemy.veriff.com/v/synthetic'}
        provider.decision.return_value={'verification':None}
        body={'fullName':'Ada Example','email':'ada@example.invalid','phone':'+27821234567','requestId':str(uuid4()),'confirmRecipient':True}
        with patch.dict(os.environ,{'POC_SMTP_HOST':'smtp.gmail.com','POC_SMTP_USERNAME':ENV['POC_OWNER_EMAIL'],'POC_SMTP_PASSWORD':'synthetic-password'}),\
             patch.object(poc,'database',new=AsyncMock(side_effect=[(row,True),None,None,row])),\
             patch.object(poc,'VeriffClient',return_value=provider),patch.object(poc,'send_mail',return_value='accepted') as mail:
            result=self.http.post('/api/cases',headers=self.headers,json=body)
        self.assertEqual(result.status_code,200,result.text)
        provider.decision.assert_awaited_once_with(row['session_id'])
        self.assertEqual(mail.call_args.args[0],'ada@example.invalid')
        self.assertEqual(result.json()['emailState'],'accepted')

    def test_idempotent_replay_never_creates_or_emails_again(self):
        self.sign_in_cookie();row=self.full_row();provider=AsyncMock()
        body={'fullName':'Ada Example','email':'ada@example.invalid','phone':'+27821234567','requestId':str(uuid4()),'confirmRecipient':True}
        with patch.dict(os.environ,{'POC_SMTP_HOST':'smtp.gmail.com','POC_SMTP_USERNAME':ENV['POC_OWNER_EMAIL'],'POC_SMTP_PASSWORD':'synthetic-password'}),\
             patch.object(poc,'database',new=AsyncMock(return_value=(row,False))),\
             patch.object(poc,'VeriffClient',return_value=provider),patch.object(poc,'send_mail') as mail:
            result=self.http.post('/api/cases',headers=self.headers,json=body)
        self.assertEqual(result.status_code,200,result.text)
        provider.create_session.assert_not_awaited();mail.assert_not_called()

    def test_signed_read_failure_does_not_invite_client(self):
        self.sign_in_cookie();row=self.full_row();provider=AsyncMock()
        provider.create_session.return_value={'id':row['session_id'],'url':'https://alchemy.veriff.com/v/synthetic'}
        provider.decision.side_effect=RuntimeError('invalid signature')
        body={'fullName':'Ada Example','email':'ada@example.invalid','phone':'+27821234567','requestId':str(uuid4()),'confirmRecipient':True}
        with patch.dict(os.environ,{'POC_SMTP_HOST':'smtp.gmail.com','POC_SMTP_USERNAME':ENV['POC_OWNER_EMAIL'],'POC_SMTP_PASSWORD':'synthetic-password'}),\
             patch.object(poc,'database',new=AsyncMock(side_effect=[(row,True),None,None])),\
             patch.object(poc,'VeriffClient',return_value=provider),patch.object(poc,'send_mail') as mail:
            result=self.http.post('/api/cases',headers=self.headers,json=body)
        self.assertEqual(result.status_code,503,result.text)
        self.assertEqual(result.json()['error'],'provider_authentication_unconfirmed');mail.assert_not_called()
