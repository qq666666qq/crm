from sqlalchemy import select
from app.errors import error
from app.models import Tenant, User, Membership
from app.security import passwords
from app.service import scope_ids
from app.change_journal import record_customer_change as audit


def require_admin(db, p, lock=False):
    # Serialize member changes for this tenant, including the last-admin check.
    if lock: db.scalar(select(Tenant).where(Tenant.id == p.membership.tenant_id).with_for_update())
    db.expire(p.membership)
    if p.membership.status != 'active' or p.membership.role != 'admin': raise error(403, 'FORBIDDEN', 'Administrator required')


def require_manager(db, p, lock=False):
    if lock: db.scalar(select(Tenant).where(Tenant.id == p.membership.tenant_id).with_for_update())
    db.expire(p.membership)
    if p.membership.status != 'active' or p.membership.role not in ('admin','manager'): raise error(403, 'FORBIDDEN', 'Management permission required')


def can_manage(db, p, member):
    if p.membership.role == 'admin': return True
    return member.user_id != p.user.id and member.role != 'admin' and (member.status != 'pending' or member.manager_id == p.user.id) and bool(db.scalar(select(Membership.user_id).where(Membership.tenant_id == p.membership.tenant_id, Membership.user_id == member.user_id, Membership.user_id.in_(scope_ids(p)))))


def validate_manager(db, p, member, manager_id):
    if manager_id is None:
        if p.membership.role != 'admin': raise error(403, 'FORBIDDEN', 'Manager cannot remove reporting line')
        return
    supervisor = db.scalar(select(Membership).where(Membership.tenant_id == p.membership.tenant_id, Membership.user_id == manager_id, Membership.status == 'active', Membership.role.in_(['manager','admin'])))
    if not supervisor: raise error(422, 'VALIDATION_ERROR', 'Manager must be an active manager or administrator')
    if p.membership.role != 'admin' and not db.scalar(select(Membership.user_id).where(Membership.tenant_id == p.membership.tenant_id, Membership.user_id == manager_id, Membership.user_id.in_(scope_ids(p)))): raise error(403, 'FORBIDDEN', 'Manager is outside your scope')
    if member and (member.user_id == manager_id or manager_id in descendants(db, member)):
        raise error(409, 'VALIDATION_ERROR', 'Reporting lines cannot contain a cycle')


def descendants(db, member):
    tree = select(Membership.user_id).where(Membership.tenant_id == member.tenant_id, Membership.user_id == member.user_id).cte(recursive=True)
    tree = tree.union(select(Membership.user_id).join(tree, Membership.manager_id == tree.c.user_id).where(Membership.tenant_id == member.tenant_id))
    return set(db.scalars(select(tree.c.user_id)))


def serialize(member, user):
    return {'id': str(member.id), 'user_id': str(user.id), 'email': user.email, 'name': user.name, 'role': member.role, 'manager_id': str(member.manager_id) if member.manager_id else None, 'status': member.status, 'user_status': user.status}


def create(db, p, request, data):
    require_manager(db, p, True)
    if p.membership.role == 'manager' and data.role == 'admin': raise error(403, 'FORBIDDEN', 'Managers cannot create administrators')
    manager_id = data.manager_id if p.membership.role == 'admin' else (data.manager_id or p.user.id)
    validate_manager(db, p, None, manager_id)
    if data.role == 'admin' and manager_id is not None: raise error(422, 'VALIDATION_ERROR', 'Administrators cannot report to another member')
    email = str(data.email).lower()
    if db.scalar(select(User.id).where(User.email == email)): raise error(409, 'DUPLICATE_DETECTED', 'An account with this email already exists')
    user = User(email=email, name=data.name, password_hash=passwords.hash(data.password))
    db.add(user); db.flush()
    member = Membership(tenant_id=p.membership.tenant_id, user_id=user.id, role=data.role, manager_id=manager_id)
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
    require_manager(db, p, True)
    member = db.scalar(select(Membership).where(Membership.id == member_id, Membership.tenant_id == p.membership.tenant_id).with_for_update())
    if not member: raise error(404, 'NOT_FOUND', 'Member not found')
    if not can_manage(db, p, member): raise error(403, 'FORBIDDEN', 'Member is outside your management scope')
    fields = data.model_dump(exclude_unset=True)
    if not fields or any(value is None for key,value in fields.items() if key != 'manager_id'): raise error(422, 'VALIDATION_ERROR', 'Provide a role or status')
    if p.membership.role != 'admin' and (fields.get('role') == 'admin' or (member.status == 'pending' and (member.manager_id != p.user.id or fields.get('manager_id', p.user.id) != p.user.id))): raise error(403, 'FORBIDDEN', 'Only the direct manager can approve this application')
    if 'manager_id' in fields: validate_manager(db, p, member, fields['manager_id'])
    if member.role == 'manager' and fields.get('role') == 'sales' and db.scalar(select(Membership.id).where(Membership.tenant_id == member.tenant_id, Membership.manager_id == member.user_id).limit(1)):
        raise error(409, 'VALIDATION_ERROR', 'Reassign this manager’s reports first')
    if member.status == 'pending' and fields.get('status') == 'active':
        user = db.get(User, member.user_id)
        if not user or user.status != 'active': raise error(409, 'VALIDATION_ERROR', 'Email must be verified before approval')
    next_role = fields.get('role', member.role)
    next_status = fields.get('status', member.status)
    if next_role == 'admin' and fields.get('manager_id', member.manager_id) is not None: raise error(422, 'VALIDATION_ERROR', 'Administrators cannot report to another member')
    if member.role == 'admin' and member.status == 'active' and (next_role != 'admin' or next_status != 'active'):
        admins = list(db.scalars(select(Membership.id).where(Membership.tenant_id == member.tenant_id, Membership.role == 'admin', Membership.status == 'active')))
        if len(admins) <= 1: raise error(409, 'VALIDATION_ERROR', 'The last active administrator cannot be disabled or demoted')
    for k, v in fields.items(): setattr(member, k, v)
    db.flush()
    audit(db, p, request, 'update', member, fields.keys())
    return serialize(member, db.get(User, member.user_id)), 200
