import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from fastapi import Depends, Header, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pwdlib import PasswordHash
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.config import settings
from app.database import get_db
from app.models import LoginSession, Membership, Tenant, User
from app.errors import error

passwords = PasswordHash.recommended()
bearer = HTTPBearer(auto_error=False)


def token_hash(token): return hashlib.sha256(token.encode()).hexdigest()


def login(db, email, password):
    user = db.scalar(select(User).where(User.email == email.lower()))
    try:
        valid = user is not None and passwords.verify(password, user.password_hash)
    except Exception:
        valid = False
    if not valid or user.status != 'active': raise error(401, 'UNAUTHORIZED', 'Invalid credentials')
    token = secrets.token_urlsafe(32)
    db.add(LoginSession(token_hash=token_hash(token), user_id=user.id, expires_at=datetime.now(timezone.utc) + timedelta(hours=settings.session_hours)))
    db.commit()
    return token


@dataclass
class Principal:
    user: User
    membership: Membership
    session: LoginSession


def principal(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer), tenant: str | None = Header(default=None, alias='X-Tenant-ID'), db: Session = Depends(get_db)):
    if not credentials: raise error(401, 'UNAUTHORIZED', 'Authentication required')
    session = db.get(LoginSession, token_hash(credentials.credentials))
    if not session or session.revoked_at or session.expires_at <= datetime.now(timezone.utc): raise error(401, 'UNAUTHORIZED', 'Session invalid or expired')
    user = db.get(User, session.user_id)
    if not user or user.status != 'active': raise error(401, 'UNAUTHORIZED', 'User disabled')
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
