"""Registration and password recovery using existing user and membership tables."""
import logging
import secrets
import smtplib
import ssl
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from threading import Lock
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from app.config import settings
from app.errors import error
from app.models import AuditLog, LoginSession, Membership, Tenant, User
from app.security import passwords, token_hash

log = logging.getLogger(__name__)
_attempts = defaultdict(deque)
_attempt_lock = Lock()

def throttle(request, action):
    now = datetime.now(timezone.utc).timestamp()
    identity = request.client.host if request.client else 'unknown'
    with _attempt_lock:
        if len(_attempts) > 10000:
            for key in list(_attempts):
                if not _attempts[key] or _attempts[key][-1] < now - 900: del _attempts[key]
        queue = _attempts[(action, identity)]
        while queue and queue[0] < now - 900: queue.popleft()
        if len(queue) >= 20: raise error(429, 'RATE_LIMITED', 'Too many attempts; try again later')
        queue.append(now)

def send_code(email, code, purpose):
    if not settings.smtp_host or not settings.smtp_sender:
        raise RuntimeError('Email delivery is not configured')
    msg = EmailMessage()
    msg['From'], msg['To'] = settings.smtp_sender, email
    msg['Subject'] = 'CRM verification code' if purpose == 'verify' else 'CRM password reset code'
    msg.set_content(f'Your CRM verification code is: {code}\nEnter this code in the CRM application. It expires in 30 minutes.\n')
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        smtp.ehlo(); smtp.starttls(context=ssl.create_default_context()); smtp.ehlo()
        if settings.smtp_username: smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.send_message(msg)

def ensure_delivery():
    if not settings.smtp_host or not settings.smtp_sender: raise error(503, 'SERVICE_UNAVAILABLE', 'Email delivery is not configured')

def audit(db, tenant_id, actor_id, action, object_type, object_id, request):
    db.add(AuditLog(tenant_id=tenant_id, actor_id=actor_id, action=action, object_type=object_type, object_id=object_id, changed_fields=[], request_id=request.state.request_id, source='human'))

def register(db, request, data):
    throttle(request, 'register'); ensure_delivery()
    email = str(data.email).lower()
    existing = db.scalar(select(User).where(User.email == email).with_for_update())
    if existing:
        if existing.status == 'pending':
            code = secrets.token_urlsafe(32)
            existing.verification_hash = token_hash(code)
            existing.verification_expires_at = datetime.now(timezone.utc)+timedelta(minutes=30)
            try:
                send_code(email, code, 'verify'); db.commit()
            except Exception:
                db.rollback(); log.warning('Registration email delivery failed')
        return {'status':'pending', 'message':'If registration is available, a verification code will be sent.'}
    tenant = db.get(Tenant, data.tenant_id)
    if not tenant or tenant.status != 'active':
        return {'status':'pending', 'message':'If registration is available, a verification code will be sent.'}
    code = secrets.token_urlsafe(32)
    user = User(email=email, name=data.name, password_hash=passwords.hash(secrets.token_urlsafe(32)), status='pending', verification_hash=token_hash(code), verification_expires_at=datetime.now(timezone.utc)+timedelta(minutes=30))
    try:
        db.add(user); db.flush()
        member = Membership(tenant_id=tenant.id, user_id=user.id, role='sales', status='pending')
        db.add(member); db.flush()
        audit(db, tenant.id, user.id, 'register_requested', 'tenant_memberships', member.id, request)
        from app.outbox import emit
        emit(db, member, 'create')
        send_code(email, code, 'verify')
        db.commit()
    except IntegrityError:
        db.rollback()
    except Exception:
        db.rollback(); log.warning('Registration email delivery failed')
    return {'status':'pending', 'message':'If registration is available, a verification code will be sent.'}

def verify(db, request, data):
    throttle(request, 'verify')
    user = db.scalar(select(User).where(User.verification_hash == token_hash(data.code)).with_for_update())
    if not user or user.status != 'pending' or not user.verification_expires_at or user.verification_expires_at <= datetime.now(timezone.utc): raise error(400, 'INVALID_TOKEN', 'Invalid or expired code')
    user.password_hash = passwords.hash(data.password)
    user.status = 'active'; user.verification_hash = None; user.verification_expires_at = None
    for member in db.scalars(select(Membership).where(Membership.user_id == user.id, Membership.status == 'pending')):
        audit(db, member.tenant_id, user.id, 'email_verified', 'users', user.id, request)
    db.commit()
    return {'status':'verified'}

def request_reset(db, request, data):
    throttle(request, 'reset_request'); ensure_delivery()
    user = db.scalar(select(User).where(User.email == str(data.email).lower()).with_for_update())
    if user and user.status == 'active':
        code = secrets.token_urlsafe(32)
        user.reset_hash = token_hash(code); user.reset_expires_at = datetime.now(timezone.utc)+timedelta(minutes=30)
        try:
            send_code(user.email, code, 'reset'); db.commit()
        except Exception:
            db.rollback(); log.warning('Password recovery email delivery failed')
    return {'status':'pending', 'message':'If the account exists, a recovery code will be sent.'}

def reset(db, request, data):
    throttle(request, 'reset_confirm')
    user = db.scalar(select(User).where(User.reset_hash == token_hash(data.code)).with_for_update())
    if not user or user.status != 'active' or not user.reset_expires_at or user.reset_expires_at <= datetime.now(timezone.utc): raise error(400, 'INVALID_TOKEN', 'Invalid or expired code')
    user.password_hash = passwords.hash(data.password); user.reset_hash = None; user.reset_expires_at = None; user.failed_logins = 0; user.locked_until = None
    db.execute(update(LoginSession).where(LoginSession.user_id == user.id, LoginSession.revoked_at.is_(None)).values(revoked_at=datetime.now(timezone.utc)))
    for member in db.scalars(select(Membership).where(Membership.user_id == user.id, Membership.status == 'active')):
        audit(db, member.tenant_id, user.id, 'password_reset', 'users', user.id, request)
    db.commit(); return {'status':'password_changed'}

def change_password(db, request, identity, data):
    throttle(request, 'change_password')
    user, _ = identity
    user = db.scalar(select(User).where(User.id == user.id).with_for_update())
    if not passwords.verify(data.current_password, user.password_hash): raise error(400, 'VALIDATION_ERROR', 'Current password is incorrect')
    user.password_hash = passwords.hash(data.new_password); user.reset_hash = None; user.reset_expires_at = None; user.failed_logins = 0; user.locked_until = None
    db.execute(update(LoginSession).where(LoginSession.user_id == user.id, LoginSession.revoked_at.is_(None)).values(revoked_at=datetime.now(timezone.utc)))
    for member in db.scalars(select(Membership).where(Membership.user_id == user.id, Membership.status == 'active')):
        audit(db, member.tenant_id, user.id, 'password_changed', 'users', user.id, request)
    db.commit(); return {'status':'password_changed'}

def join(db, request, identity, data):
    user, _ = identity
    tenant = db.get(Tenant, data.tenant_id)
    if not tenant or tenant.status != 'active': raise error(404, 'NOT_FOUND', 'Enterprise not found')
    if db.scalar(select(Membership.id).where(Membership.tenant_id == tenant.id, Membership.user_id == user.id)): raise error(409, 'DUPLICATE_DETECTED', 'Membership or request already exists')
    try:
        member = Membership(tenant_id=tenant.id, user_id=user.id, role='sales', status='pending')
        db.add(member); db.flush(); audit(db, tenant.id, user.id, 'join_requested', 'tenant_memberships', member.id, request)
        from app.outbox import emit
        emit(db, member, 'create'); db.commit()
    except IntegrityError:
        db.rollback(); raise error(409, 'DUPLICATE_DETECTED', 'Membership or request already exists')
    return {'status':'pending'}
