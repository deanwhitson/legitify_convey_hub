"""Invitations bind to a saved person and durable verification attempt."""
import hashlib
import re
from uuid import uuid4
from services.id_verification_service import IdVerificationError
from services.veriff_verification import normalise
from services.verification_email import validate_contact, load_email_config, SmtpInvitationMailer
from repositories.veriff_verification import VeriffStorageError

async def send_invitation(ctx,*,ai,transfer_id,party_id,subject_kind,contact,on_behalf_of_party_id=None,mailer=None):
    contact = validate_contact(contact)
    if getattr(ctx,'provider',None)!='veriff':
        raise IdVerificationError('configuration_unavailable')
    mailer = mailer or SmtpInvitationMailer(load_email_config())
    party = await ctx.repository.invitation_subject(ai,transfer_id,party_id)
    manual = party.get('party_source')=='manual'
    name = party.get('manual_name') if manual else party.get('cached_name')
    email = party.get('manual_email') if manual else party.get('cached_email')
    phone = party.get('manual_phone') if manual else None
    if (normalise(name)!=normalise(contact['fullName']) or not email
        or str(email).strip().casefold()!=contact['email'].casefold()
        or re.sub(r'[\s()-]','',str(phone or ''))!=contact['phone']):
        raise IdVerificationError('contact_details_changed')
    await ctx.repository.invitation_storage_ready()
    session = await ctx.start(ai=ai,transfer_id=transfer_id,transfer_party_id=party_id,
        subject_kind=subject_kind,on_behalf_of_party_id=on_behalf_of_party_id)
    row,_ = await ctx.repository.latest(ctx.config.scope,ai,party_id)
    if row is None or row['attempt_no']!=session['attemptNo']:
        raise VeriffStorageError()
    recipient_hash = hashlib.sha256(contact['email'].casefold().encode()).hexdigest()
    invitation,owned = await ctx.repository.reserve_invitation(row,recipient_hash,str(uuid4()))
    if not owned:
        if invitation['delivery_state']=='accepted' and invitation['recipient_hash']==recipient_hash:
            return {'status':'accepted_by_email_server','resumed':True}
        raise IdVerificationError('invitation_unresolved')
    try:
        await mailer.send(email,name,session['captureUrl'],str(invitation['id']))
    except Exception:
        await ctx.repository.finish_invitation(str(invitation['id']),'uncertain')
        raise IdVerificationError('email_delivery_unavailable') from None
    await ctx.repository.finish_invitation(str(invitation['id']),'accepted')
    return {'status':'accepted_by_email_server','resumed':False}
