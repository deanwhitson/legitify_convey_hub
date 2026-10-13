"""Personal email/passport POC. Separate from canonical DEEDLY matter routes.

Email-code owner authentication; encrypted contacts; durable reservations;
one LIVE verification by default; no browser-controlled decisions.
"""
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import time
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import certifi
import psycopg
from psycopg.rows import dict_row
from cryptography.fernet import Fernet, InvalidToken
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

try:
    from provider import VeriffClient, VeriffConfig, valid_veriff_url
except ModuleNotFoundError:
    from clients.veriff_client import VeriffClient, VeriffConfig, valid_veriff_url

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
COOKIE = 'deedly_passport_poc'

def fail(code, status=503):
    raise HTTPException(status_code=status,detail=code)

def setting(key):
    return (os.getenv(key) or '').strip()

def owner_email():
    value = setting('POC_OWNER_EMAIL')
    if not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', value):
        fail('owner_configuration_unavailable')
    return value.casefold()

def owner_hash():
    return hashlib.sha256(owner_email().encode()).hexdigest()

def cipher():
    try:
        return Fernet(setting('POC_ENCRYPTION_KEY').encode())
    except Exception:
        fail('encryption_configuration_unavailable')

def seal(value):
    return cipher().encrypt(json.dumps(value).encode()).decode()

def unseal(value):
    try:
        return json.loads(cipher().decrypt(value.encode()))
    except (InvalidToken,ValueError,AttributeError):
        fail('stored_data_unavailable')

def authenticate(request):
    try:
        data = unseal(request.cookies.get(COOKIE,''))
    except HTTPException:
        fail('sign_in_required',401)
    if data.get('owner')!=owner_email() or data.get('purpose')!='poc_owner_session' or data.get('exp',0)<time.time():
        fail('sign_in_required',401)

def db(work):
    dsn = setting('POC_DATABASE_URL')
    parsed = urlsplit(dsn)
    # This user selected the isolated pilot database. Refuse another target.
    if parsed.scheme not in ('postgres','postgresql') or parsed.path!='/deedly_pilot' or not (parsed.hostname or '').endswith('.neon.tech'):
        fail('database_configuration_unavailable')
    try:
        with psycopg.connect(dsn,sslmode='verify-full',sslrootcert=certifi.where(),connect_timeout=10,
             options='-c statement_timeout=15000',row_factory=dict_row) as conn:
            return work(conn)
    except HTTPException:
        raise
    except Exception:
        fail('storage_unavailable')

async def database(work):
    return await asyncio.to_thread(db,work)

async def payload(request):
    raw = await request.body()
    if len(raw)>8192:
        fail('request_too_large',413)
    try:
        data = json.loads(raw)
    except (ValueError,UnicodeDecodeError):
        fail('invalid_request',422)
    if not isinstance(data,dict):
        fail('invalid_request',422)
    return data

@app.middleware('http')
async def boundary(request,call_next):
    if request.method=='POST':
        try:
            origin = urlsplit(request.headers.get('origin',''))
            if origin.scheme not in ('https','http') or origin.netloc!=request.headers.get('host') or request.headers.get('x-poc-request')!='1':
                return JSONResponse({'error':'request_origin_rejected'},status_code=403)
        except ValueError:
            return JSONResponse({'error':'request_origin_rejected'},status_code=403)
    try:
        response = await call_next(request)
    except Exception:
        response = JSONResponse({'error':'service_unavailable'},status_code=503)
    response.headers['Cache-Control']='no-store'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['X-Content-Type-Options']='nosniff'
    return response

@app.exception_handler(HTTPException)
async def known_error(request,error):
    return JSONResponse({'error':error.detail},status_code=error.status_code)

def mail_config():
    owner = owner_email()
    if setting('POC_SMTP_HOST')!='smtp.gmail.com' or setting('POC_SMTP_USERNAME').casefold()!=owner or not setting('POC_SMTP_PASSWORD'):
        fail('email_configuration_unavailable')
    return owner,setting('POC_SMTP_PASSWORD')

def send_mail(recipient,subject,body,message_id):
    sender,password = mail_config()
    message = EmailMessage()
    message['From'],message['To'],message['Subject'] = sender,recipient,subject
    message['Message-ID']=f'<{message_id}@gmail.com>'
    message.set_content(body)
    attempted = False
    try:
        with smtplib.SMTP_SSL('smtp.gmail.com',465,context=ssl.create_default_context(),timeout=10) as smtp:
            smtp.login(sender,password)
            attempted = True
            rejected = smtp.send_message(message)
            if rejected:
                return 'failed'
        return 'accepted'
    except smtplib.SMTPRecipientsRefused:
        return 'failed'
    except Exception:
        return 'uncertain' if attempted else 'failed'

def otp_hash(challenge,code):
    return hmac.new(setting('POC_ENCRYPTION_KEY').encode(),(challenge+'|'+code).encode(),hashlib.sha256).hexdigest()

@app.get('/')
async def home():
    return HTMLResponse(Path(__file__).with_name('index.html').read_text(encoding='utf-8'))

@app.get('/api/health')
async def health():
    required=('POC_OWNER_EMAIL','POC_ENCRYPTION_KEY','POC_LIVE_API_KEY','POC_LIVE_SHARED_SECRET',
              'POC_LIVE_BASE_URL','POC_SMTP_HOST','POC_SMTP_USERNAME','POC_SMTP_PASSWORD','POC_DATABASE_URL')
    return {'service':'deedly-personal-passport-poc','mode':'live-trial','ready':all(setting(k) for k in required)}

@app.post('/api/auth/code')
async def request_code(request:Request):
    mail_config(); cipher()
    challenge,code = str(uuid4()),f'{secrets.randbelow(1000000):06d}'
    def reserve(conn):
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',[owner_hash()])
        count = conn.execute("SELECT count(*) AS n FROM transfers.veriff_email_poc_codes WHERE owner_hash=%s AND created_at>now()-interval '1 hour'",[owner_hash()]).fetchone()['n']
        if count>=3:
            fail('sign_in_rate_limited',429)
        conn.execute("INSERT INTO transfers.veriff_email_poc_codes(id,owner_hash,code_hash,expires_at) VALUES (%s,%s,%s,now()+interval '10 minutes')",[challenge,owner_hash(),otp_hash(challenge,code)])
    await database(reserve)
    state = await asyncio.to_thread(send_mail,owner_email(),'DEEDLY POC sign-in code',
        f'Your DEEDLY personal passport POC sign-in code is {code}. It expires in 10 minutes. Do not share it.',challenge)
    if state!='accepted':
        fail('sign_in_email_unavailable')
    return {'challenge':challenge,'message':'Sign-in code accepted by Gmail for sending.'}

@app.post('/api/auth/verify')
async def verify_code(request:Request):
    data = await payload(request)
    try:
        challenge=str(UUID(data.get('challenge','')))
    except (ValueError,TypeError,AttributeError):
        fail('invalid_code',401)
    code = data.get('code','')
    if not isinstance(code,str) or not re.fullmatch(r'\d{6}',code):
        fail('invalid_code',401)
    def check(conn):
        row = conn.execute('SELECT *,expires_at>now() AS current FROM transfers.veriff_email_poc_codes WHERE id=%s AND owner_hash=%s FOR UPDATE',[challenge,owner_hash()]).fetchone()
        if not row or not row['current'] or row['used'] or row['attempts']>=5:
            return False
        ok = hmac.compare_digest(row['code_hash'],otp_hash(challenge,code))
        conn.execute('UPDATE transfers.veriff_email_poc_codes SET attempts=attempts+1,used=%s WHERE id=%s',[ok,challenge])
        return ok
    if not await database(check):
        fail('invalid_or_expired_code',401)
    response = JSONResponse({'authenticated':True})
    response.set_cookie(COOKIE,seal({'owner':owner_email(),'purpose':'poc_owner_session','exp':int(time.time())+14400}),
        max_age=14400,httponly=True,secure=True,samesite='strict',path='/')
    return response

@app.post('/api/auth/logout')
async def logout(request:Request):
    response=JSONResponse({'signed_out':True});response.delete_cookie(COOKIE,path='/',secure=True,httponly=True,samesite='strict');return response

def provider_config(allow_creation=False):
    key,secret,base = (setting(k) for k in ('POC_LIVE_API_KEY','POC_LIVE_SHARED_SECRET','POC_LIVE_BASE_URL'))
    if not key or not secret or not valid_veriff_url(base) or urlsplit(base).path not in ('','/') or urlsplit(base).query or urlsplit(base).fragment:
        fail('live_veriff_configuration_unavailable')
    if hashlib.sha256(key.encode()).hexdigest()==setting('POC_TEST_KEY_HASH'):
        fail('test_integration_cannot_be_used_as_live')
    if allow_creation:
        if setting('POC_TRIAL_CONFIRMED')!='yes':fail('confirm_available_trial_quota')
        try:expiry=float(setting('POC_LIVE_ENABLED_UNTIL'))
        except ValueError:fail('confirm_available_trial_quota')
        if time.time()>expiry:fail('poc_trial_window_expired',409)
    return VeriffConfig('trial',base,key,secret,setting('POC_ENCRYPTION_KEY'))

def contact_input(data):
    if set(data)-{'fullName','email','phone','requestId','confirmRecipient'} or data.get('confirmRecipient') is not True:
        fail('confirm_recipient_required',422)
    name,email,phone = (data.get(k) for k in ('fullName','email','phone'))
    if not isinstance(name,str) or not 2<=len(name.strip())<=150 or not any(c.isalpha() for c in name) or any(ord(c)<32 for c in name):
        fail('invalid_name',422)
    if not isinstance(email,str) or len(email)>254 or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+',email):
        fail('invalid_email',422)
    if not isinstance(phone,str) or len(phone)>32:
        fail('invalid_phone',422)
    phone=re.sub(r'[\s()-]','',phone)
    if not re.fullmatch(r'\+[1-9]\d{7,14}',phone):
        fail('invalid_phone',422)
    try:
        request_id=str(UUID(data.get('requestId','')))
    except (ValueError,TypeError,AttributeError):
        fail('invalid_request_id',422)
    return {'fullName':name.strip(),'email':email,'phone':phone},request_id

def case_view(row):
    contact=unseal(row['contact_encrypted'])
    return {'id':str(row['id']),'fullName':contact['fullName'],'email':contact['email'],'phone':contact['phone'],
        'status':row['status'],'emailState':row['email_state'],'creationState':row['creation_state'],
        'createdAt':row['created_at'].isoformat(),'updatedAt':row['updated_at'].isoformat(),
        'summary':row['summary'] or {}}

def find_case(conn,case_id):
    row=conn.execute('SELECT * FROM transfers.veriff_email_poc_cases WHERE id=%s AND owner_hash=%s',[case_id,owner_hash()]).fetchone()
    if not row:
        fail('not_found',404)
    return row

@app.get('/api/cases')
async def list_cases(request:Request):
    authenticate(request)
    rows=await database(lambda c:c.execute('SELECT * FROM transfers.veriff_email_poc_cases WHERE owner_hash=%s ORDER BY created_at DESC LIMIT 50',[owner_hash()]).fetchall())
    return {'cases':[case_view(row) for row in rows]}

@app.post('/api/cases')
async def create_case(request:Request):
    authenticate(request);mail_config()
    config=provider_config(allow_creation=True)
    contact,request_id=contact_input(await payload(request))
    digest=hashlib.sha256(json.dumps(contact,sort_keys=True).encode()).hexdigest()
    case_id,ref=str(uuid4()),'dly-poc-'+uuid4().hex
    def reserve(conn):
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',[owner_hash()+'|'+config.scope])
        prior=conn.execute('SELECT * FROM transfers.veriff_email_poc_cases WHERE owner_hash=%s AND request_id=%s',[owner_hash(),request_id]).fetchone()
        if prior:
            if prior['request_hash']!=digest:fail('request_conflict',409)
            return prior,False
        count=conn.execute('SELECT count(*) AS n FROM transfers.veriff_email_poc_cases WHERE owner_hash=%s AND integration_scope=%s',[owner_hash(),config.scope]).fetchone()['n']
        limit=int(setting('POC_LIVE_SESSION_LIMIT') or '1')
        if count>=limit:fail('poc_verification_limit_reached',409)
        row=conn.execute("""INSERT INTO transfers.veriff_email_poc_cases
            (id,owner_hash,integration_scope,request_id,request_hash,external_ref,contact_encrypted)
            VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *""",[case_id,owner_hash(),config.scope,request_id,digest,ref,seal(contact)]).fetchone()
        return row,True
    row,owned=await database(reserve)
    if not owned:
        return case_view(row)
    client=VeriffClient(config)
    session=None
    try:
        session=await client.create_session(ref,case_id)
        await database(lambda c:c.execute("""UPDATE transfers.veriff_email_poc_cases SET session_id=%s,
            capture_encrypted=%s,creation_state='ready',updated_at=now() WHERE id=%s""",[session['id'],seal({'url':session['url']}),case_id]))
        # An owned-session read conclusively checks the shared secret before
        # inviting the client to submit passport/biometric data.
        await client.decision(session['id'])
    except Exception:
        if session is None:
            await database(lambda c:c.execute("UPDATE transfers.veriff_email_poc_cases SET creation_state='uncertain',updated_at=now() WHERE id=%s",[case_id]))
            fail('session_creation_unresolved')
        await database(lambda c:c.execute("UPDATE transfers.veriff_email_poc_cases SET email_state='failed',status='review_required',updated_at=now() WHERE id=%s",[case_id]))
        fail('provider_authentication_unconfirmed')
    finally:
        await client.aclose()
    await database(lambda c:c.execute("UPDATE transfers.veriff_email_poc_cases SET email_state='sending',updated_at=now() WHERE id=%s",[case_id]))
    state=await asyncio.to_thread(send_mail,contact['email'],'DEEDLY passport verification invitation',
        f"Hello {contact['fullName']},\n\nYour attorney has invited you to complete passport verification. Open this private link and capture your own passport and selfie:\n\n{session['url']}\n\nDo not forward the link or email passport images to the attorney. Veriff will guide you through capture. Finishing capture does not itself mean approval.\n\nDEEDLY passport POC",case_id)
    row=await database(lambda c:c.execute('UPDATE transfers.veriff_email_poc_cases SET email_state=%s,updated_at=now() WHERE id=%s RETURNING *',[state,case_id]).fetchone())
    return case_view(row)

def normalise(value):
    import unicodedata
    return ''.join(c for c in unicodedata.normalize('NFKD',str(value or '')).casefold() if c.isalnum())

def decision_summary(data,row):
    value=data.get('verification')
    if value is None:return {'status':'pending'}
    if not isinstance(value,dict) or value.get('id')!=row['session_id'] or value.get('endUserId')!=str(row['id']) or value.get('vendorData')!=row['external_ref']:
        fail('provider_result_binding_failed')
    code=value.get('code');status=value.get('status')
    mapping={9001:('approved','review_required'),9102:('declined','declined'),9103:('resubmission_requested','retry_requested'),9104:('expired','expired'),9121:('abandoned','abandoned')}
    outcome=mapping.get(code if type(code) is int else None)
    result=outcome[1] if outcome and outcome[0]==status else 'review_required'
    doc=value.get('document') if isinstance(value.get('document'),dict) else {}
    person=value.get('person') if isinstance(value.get('person'),dict) else {}
    name=unseal(row['contact_encrypted'])['fullName']
    matched=normalise(name)==normalise(' '.join(str(person.get(k) or '') for k in ('firstName','lastName')))
    try:valid=date.fromisoformat(doc.get('validUntil',''))>=datetime.now(timezone(timedelta(hours=2))).date()
    except (ValueError,TypeError):valid=False
    if code==9001 and status=='approved' and matched and valid and doc.get('type')=='PASSPORT':result='verified'
    return {'status':result,'providerCode':code if type(code) is int else None,'passport':doc.get('type')=='PASSPORT','currentPassport':valid,'nameMatched':matched}

@app.get('/api/cases/{case_id}')
async def refresh_case(case_id:str,request:Request):
    authenticate(request)
    try:case_id=str(UUID(case_id))
    except ValueError:fail('not_found',404)
    row=await database(lambda c:find_case(c,case_id))
    if row['creation_state']!='ready':return case_view(row)
    config=provider_config()
    if row['integration_scope']!=config.scope:fail('integration_configuration_changed',409)
    client=VeriffClient(config)
    try:
        data=await client.decision(row['session_id'])
    except Exception:
        fail('provider_temporarily_unavailable')
    finally:
        await client.aclose()
    summary=decision_summary(data,row)
    if summary['status']=='pending' and row['status'] not in ('pending','started'):return case_view(row)
    updated=await database(lambda c:c.execute('''UPDATE transfers.veriff_email_poc_cases
        SET status=%s,summary=%s::jsonb,version=version+1,updated_at=now()
        WHERE id=%s AND owner_hash=%s AND version=%s RETURNING *''',
        [summary['status'],json.dumps(summary),case_id,owner_hash(),row['version']]).fetchone())
    if not updated:updated=await database(lambda c:find_case(c,case_id))
    return case_view(updated)
