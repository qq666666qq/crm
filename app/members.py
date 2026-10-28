from sqlalchemy import select
from app.errors import error
from app.models import Tenant, User, Membership
from app.security import passwords
from app.service import audit


def require_admin(db, p, lock=False):
    # Serialize member changes for this tenant, including the last-admin check.
    if lock: db.scalar(select(Tenant).where(Tenant.id == p.membership.tenant_id).with_for_update())
    db.expire(p.membership)
    if p.membership.status != 'active' or p.membership.role != 'admin': raise error(403, 'FORBIDDEN', 'Administrator required')


def serialize(member, user):
    return {'id': str(member.id), 'user_id': str(user.id), 'email': user.email, 'name': user.name, 'role': member.role, 'status': member.status, 'user_status': user.status}


def create(db, p, request, data):
    require_admin(db, p, True)
    email = str(data.email).lower()
    if db.scalar(select(User.id).where(User.email == email)): raise error(409, 'DUPLICATE_DETECTED', 'An account with this email already exists')
    user = User(email=email, name=data.name, password_hash=passwords.hash(data.password))
    db.add(user); db.flush()
    member = Membership(tenant_id=p.membership.tenant_id, user_id=user.id, role=data.role)
    db.add(member); db.flush()
    audit(db, p, request, 'create', member, ['user_id', 'role', 'status'])
    return serialize(member, user), 201


def attach(db, p, request, data):
    require_admin(db, p, True)
    user = db.get(User, data.user_id)
    if not user or user.status != 'active': raise error(404, 'NOT_FOUND', 'Active user not found')
    if db.scalar(select(Membership.id).where(Membership.tenant_id == p.membership.tenant_id, Membership.user_id == user.id)):
        raise error(409, 'DUPLICATE_DETECTED', 'Membership already exists')
    member = Membership(tenant_id=p.membership.tenant_id, user_id=user.id, role=data.role)
    db.add(member); db.flush()
    audit(db, p, request, 'create', member, ['user_id', 'role', 'status'])
    return serialize(member, user), 201


def modify(db, p, request, member_id, data):
    require_admin(db, p, True)
    member = db.scalar(select(Membership).where(Membership.id == member_id, Membership.tenant_id == p.membership.tenant_id).with_for_update())
    if not member: raise error(404, 'NOT_FOUND', 'Member not found')
    fields = data.model_dump(exclude_unset=True)
    if not fields or any(value is None for value in fields.values()): raise error(422, 'VALIDATION_ERROR', 'Provide a role or status')
    next_role = fields.get('role', member.role)
    next_status = fields.get('status', member.status)
    if member.role == 'admin' and member.status == 'active' and (next_role != 'admin' or next_status != 'active'):
        admins = list(db.scalars(select(Membership.id).where(Membership.tenant_id == member.tenant_id, Membership.role == 'admin', Membership.status == 'active')))
        if len(admins) <= 1: raise error(409, 'VALIDATION_ERROR', 'The last active administrator cannot be disabled or demoted')
    for k, v in fields.items(): setattr(member, k, v)
    db.flush()
    audit(db, p, request, 'update', member, fields.keys())
    return serialize(member, db.get(User, member.user_id)), 200
