"""Email-first invitation transport. SMTP acceptance is not delivery proof."""
import asyncio
import os
import re
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage
from services.id_verification_service import IdVerificationError

class EmailDeliveryUnavailable(IdVerificationError):
    def __init__(self):
        super().__init__('email_delivery_unavailable')

def valid_email(value):
    return isinstance(value,str) and len(value) <= 254 and bool(re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+',value))

def validate_contact(contact):
    if not isinstance(contact,dict) or set(contact)-{'fullName','email','phone','onBehalfOfPartyId'}:
        raise IdVerificationError('invalid_contact_details')
    name,email,phone = (contact.get(k) for k in ('fullName','email','phone'))
    if not isinstance(name,str) or not 2 <= len(name.strip()) <= 150 or any(ord(c)<32 for c in name):
        raise IdVerificationError('invalid_contact_details')
    if not valid_email(email) or not isinstance(phone,str) or len(phone)>32:
        raise IdVerificationError('invalid_contact_details')
    phone = re.sub(r'[\s()-]','',phone)
    if not re.fullmatch(r'\+[1-9]\d{7,14}',phone):
        raise IdVerificationError('invalid_contact_details')
    return {'fullName':name.strip(),'email':email.strip(),'phone':phone}

@dataclass(frozen=True)
class EmailConfig:
    host: str
    port: int
    sender: str
    username: str = field(repr=False)
    password: str = field(repr=False)

def load_email_config(env=None):
    env = os.environ if env is None else env
    try:
        config = EmailConfig(env.get('VERIFICATION_SMTP_HOST',''),int(env.get('VERIFICATION_SMTP_PORT','465')),
            env.get('VERIFICATION_EMAIL_FROM',''),env.get('VERIFICATION_SMTP_USERNAME',''),env.get('VERIFICATION_SMTP_PASSWORD',''))
    except (ValueError,TypeError):
        raise EmailDeliveryUnavailable()
    if not all((config.host,config.username,config.password)) or config.port!=465 or not valid_email(config.sender) or any(c.isspace() for c in config.host):
        raise EmailDeliveryUnavailable()
    return config

def invitation_message(sender,recipient,name,capture_url,invitation_id):
    from clients.veriff_client import valid_veriff_url
    if not valid_email(sender) or not valid_email(recipient) or not valid_veriff_url(capture_url):
        raise EmailDeliveryUnavailable()
    message = EmailMessage()
    message['Subject'] = 'DEEDLY passport verification invitation'
    message['From'],message['To'] = sender,recipient
    message['Message-ID'] = f'<{invitation_id}@{sender.split("@")[1]}>'
    message.set_content(f'Hello {name},\n\nYour attorney has requested passport verification. '
        'Open the secure Veriff link below and capture your own passport and selfie.\n\n'
        f'{capture_url}\n\nDo not forward this private link. Your passport and selfie are '
        'captured directly by Veriff. Completing capture does not itself mean approval.\n\nDEEDLY')
    return message

class SmtpInvitationMailer:
    def __init__(self,config):
        self.config = config
    async def send(self,recipient,name,capture_url,invitation_id):
        message = invitation_message(self.config.sender,recipient,name,capture_url,invitation_id)
        def deliver():
            with smtplib.SMTP_SSL(self.config.host,self.config.port,context=ssl.create_default_context(),timeout=15) as smtp:
                smtp.login(self.config.username,self.config.password)
                if smtp.send_message(message):
                    raise EmailDeliveryUnavailable()
        try:
            await asyncio.to_thread(deliver)
        except Exception:
            raise EmailDeliveryUnavailable() from None
