import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from fastapi import Depends, Header, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pwdlib import PasswordHash
from sqlalchemy import select, update, func
from sqlalchemy.orm import Session
from app.config import settings
from app.database import get_db
from app.models import LoginSession, Membership, Tenant, User
from app.errors import error

passwords = PasswordHash.recommended()
_dummy_hash = passwords.hash(secrets.token_urlsafe(32))
bearer = HTTPBearer(auto_error=False)


def token_hash(token): return hashlib.sha256(token.encode()).hexdigest()


def login(db, email, password):
    user = db.scalar(select(User).where(User.email == email.lower()).with_for_update())
    now = datetime.now(timezone.utc)
    try:
        valid = passwords.verify(password, user.password_hash if user else _dummy_hash)
    except Exception:
        valid = False
    if not user or user.status != 'active' or (user.locked_until and user.locked_until > now):
        raise error(401, 'UNAUTHORIZED', 'Invalid credentials')
    if not valid:
        user.failed_logins = (user.failed_logins or 0) + 1
        if user.failed_logins >= 5:
            user.failed_logins = 0; user.locked_until = now + timedelta(minutes=15)
        db.commit()
        raise error(401, 'UNAUTHORIZED', 'Invalid credentials')
    user.failed_logins = 0; user.locked_until = None
    token = secrets.token_urlsafe(32)
    db.add(LoginSession(token_hash=token_hash(token), user_id=user.id, expires_at=datetime.now(timezone.utc) + timedelta(hours=settings.session_hours)))
    db.commit()
    return token


@dataclass
class Principal:
    user: User
    membership: Membership
    session: LoginSession


def authenticated(credentials: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)):
    if not credentials: raise error(401, 'UNAUTHORIZED', 'Authentication required')
    session = db.get(LoginSession, token_hash(credentials.credentials))
    if not session or session.revoked_at or session.expires_at <= datetime.now(timezone.utc): raise error(401, 'UNAUTHORIZED', 'Session invalid or expired')
    user = db.get(User, session.user_id)
    if not user or user.status != 'active': raise error(401, 'UNAUTHORIZED', 'User disabled')
    # Renew only a still-valid, non-revoked session. The conditional UPDATE
    # prevents a concurrent logout from resurrecting a revoked session.
    now = datetime.now(timezone.utc)
    renewed = db.execute(update(LoginSession).where(
        LoginSession.token_hash == session.token_hash,
        LoginSession.revoked_at.is_(None), LoginSession.expires_at > now,
        LoginSession.user_id.in_(select(User.id).where(User.status == 'active')),
    ).values(expires_at=func.greatest(LoginSession.expires_at, now + timedelta(hours=settings.session_hours))).returning(LoginSession.token_hash)).scalar_one_or_none()
    if renewed is None:
        db.rollback()
        raise error(401, 'UNAUTHORIZED', 'Session invalid or expired')
    db.commit()
    return user, session


def principal(request: Request, tenant: str | None = Header(default=None, alias='X-Tenant-ID'), identity=Depends(authenticated), db: Session = Depends(get_db)):
    user, session = identity
    try:
        import uuid
        tenant_id = uuid.UUID(tenant or '')
    except ValueError:
        raise error(403, 'FORBIDDEN', 'A valid tenant selection is required')
    membership = db.scalar(select(Membership).join(Tenant, Tenant.id == Membership.tenant_id).where(Membership.tenant_id == tenant_id, Membership.user_id == user.id, Membership.status == 'active', Tenant.status == 'active'))
    if not membership or membership.role not in ('admin', 'manager', 'sales'): raise error(403, 'FORBIDDEN', 'Tenant access denied')
    result = Principal(user, membership, session)
    request.state.principal = result
    request.state.audit_identity = (membership.tenant_id, user.id)
    request.state.audit_db = db
    return result
