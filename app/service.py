import hashlib
import json
from datetime import datetime, timezone
from urllib.parse import urlsplit
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.errors import error
from app.models import Company, Contact, Idempotency, Membership, User
from app.schemas import ContactFields
from app.change_journal import record_customer_change as audit


def domain(website):
    if not website: return None
    host = urlsplit(website).hostname.rstrip('.').encode('idna').decode().lower()
    return host[4:] if host.startswith('www.') else host


def lock_company_name(db, tenant_id, name):
    from sqlalchemy import text
    identity = f'company-name:{tenant_id}:{name.strip().lower()}'
    lock_id = int.from_bytes(hashlib.sha256(identity.encode()).digest()[:8], 'big', signed=True)
    db.execute(text('SELECT pg_advisory_xact_lock(:id)'), {'id': lock_id})


def scope_ids(p):
    if p.membership.role == 'sales': return select(Membership.user_id).where(Membership.tenant_id == p.membership.tenant_id, Membership.user_id == p.user.id)
    tree = select(Membership.user_id).where(Membership.tenant_id == p.membership.tenant_id, Membership.user_id == p.user.id, Membership.status == 'active').cte(recursive=True)
    tree = tree.union(select(Membership.user_id).join(tree, Membership.manager_id == tree.c.user_id).where(Membership.tenant_id == p.membership.tenant_id, Membership.role != 'admin'))
    return select(tree.c.user_id)


def company_query(p):
    q = select(Company).where(Company.tenant_id == p.membership.tenant_id, Company.deleted_at.is_(None))
    if p.membership.role != 'admin': q = q.where(Company.owner_id.in_(scope_ids(p)))
    return q


def get_company(db, p, id, lock=False):
    q = company_query(p).where(Company.id == id)
    if lock: q = q.with_for_update()
    obj = db.scalar(q)
    if not obj: raise error(404, 'NOT_FOUND', 'Company not found')
    return obj


def get_contact(db, p, id, lock=False):
    q = select(Contact).join(Company, (Contact.company_id == Company.id) & (Contact.tenant_id == Company.tenant_id)).where(Contact.id == id, Contact.tenant_id == p.membership.tenant_id, Contact.deleted_at.is_(None), Company.deleted_at.is_(None))
    if p.membership.role != 'admin': q = q.where(Company.owner_id.in_(scope_ids(p)))
    if lock: q = q.with_for_update(of=(Company, Contact))
    obj = db.scalar(q)
    if not obj: raise error(404, 'NOT_FOUND', 'Contact not found')
    return obj


def output(obj):
    from decimal import Decimal
    return jsonable_encoder({column.name: getattr(obj, column.name) for column in obj.__table__.columns if column.name != 'website_domain'}, custom_encoder={Decimal: str})


def output_with_owner(db, p, objects):
    """Only expose names of owners of already-authorized records in this tenant."""
    objects = list(objects)
    ids = {getattr(obj, 'owner_id', None) or getattr(obj, 'assigned_to', None) for obj in objects}
    ids.discard(None)
    names = dict(db.execute(select(User.id, User.name).join(Membership, Membership.user_id == User.id).where(Membership.tenant_id == p.membership.tenant_id, User.id.in_(ids))).all()) if ids else {}
    result = []
    for obj in objects:
        item = output(obj)
        owner_id = getattr(obj, 'owner_id', None) or getattr(obj, 'assigned_to', None)
        if owner_id: item['owner_name'] = names.get(owner_id)
        result.append(item)
    return result


def owner(db, p, owner_id):
    owner_id = owner_id or p.user.id
    if p.membership.role != 'admin' and not db.scalar(select(Membership.user_id).where(Membership.user_id == owner_id, Membership.user_id.in_(scope_ids(p)))): raise error(403, 'FORBIDDEN', 'Owner is outside your management scope')
    if not db.scalar(select(Membership.id).where(Membership.tenant_id == p.membership.tenant_id, Membership.user_id == owner_id, Membership.status == 'active')): raise error(422, 'VALIDATION_ERROR', 'Owner must be an active tenant member')
    return owner_id


def write(db: Session, p, request, key, operation, replay_check=None, replay_authorize=None):
    if not key or len(key) > 128: raise error(422, 'VALIDATION_ERROR', 'Idempotency-Key is required (1-128 characters)')
    payload = request.state.body
    digest = hashlib.sha256(request.method.encode() + b' ' + request.url.path.encode() + b'?' + request.url.query.encode() + b' ' + payload).hexdigest()
    # Transaction-scoped advisory lock serializes concurrent requests with the same key.
    lock_id = int.from_bytes(hashlib.sha256((str(p.membership.tenant_id) + str(p.user.id) + key).encode()).digest()[:8], 'big', signed=True)
    from sqlalchemy import text
    db.execute(text('SELECT pg_advisory_xact_lock(:id)'), {'id': lock_id})
    prior = db.scalar(select(Idempotency).where(Idempotency.tenant_id == p.membership.tenant_id, Idempotency.actor_id == p.user.id, Idempotency.key == key))
    if prior:
        if prior.request_hash != digest: raise error(409, 'IDEMPOTENCY_CONFLICT', 'Key already used for a different request')
        # Recheck current access even when the original response is cached.
        if replay_authorize:
            replay_authorize(prior.response)
        elif replay_check:
            replay_check()
        else:
            target_id = prior.response.get('id')
            company_id = prior.response.get('company_id') or target_id
            q = select(Company).where(Company.id == company_id, Company.tenant_id == p.membership.tenant_id)
            if p.membership.role != 'admin': q = q.where(Company.owner_id.in_(scope_ids(p)))
            if not db.scalar(q): raise error(404, 'NOT_FOUND', 'Record not found')
        return prior.response, prior.status_code
    try:
        result, status = operation()
        db.add(Idempotency(tenant_id=p.membership.tenant_id, actor_id=p.user.id, key=key, request_hash=digest, status_code=status, response=result))
        db.commit()
        return result, status
    except IntegrityError:
        db.rollback()
        raise error(409, 'DUPLICATE_DETECTED', 'Duplicate or invalid related record')


def create(db, p, request, model, values, company_id=None):
    values = dict(values)
    if model is Company:
        lock_company_name(db, p.membership.tenant_id, values['name'])
        values['owner_id'] = owner(db, p, values.get('owner_id'))
        values['website_domain'] = domain(values.get('website'))
    else:
        get_company(db, p, company_id, lock=True)
        values['company_id'] = company_id
    obj = model(**values, tenant_id=p.membership.tenant_id, updated_by=p.user.id)
    db.add(obj)
    db.flush()
    db.refresh(obj)
    audit(db, p, request, 'create', obj, values.keys())
    return output(obj), 201


def modify(db, p, request, obj, values, delete=False):
    expected = values.pop('expected_version')
    if obj.version != expected: raise error(409, 'VERSION_CONFLICT', 'Record has changed')
    if delete and isinstance(obj, Company):
        if db.scalar(select(Contact.id).where(Contact.tenant_id == obj.tenant_id, Contact.company_id == obj.id, Contact.deleted_at.is_(None)).limit(1)):
            raise error(409, 'VALIDATION_ERROR', 'Remove active contacts before deleting company')
    if delete and isinstance(obj, (Company, Contact)):
        from app.phase2_models import Lead, Opportunity, OpportunityContact, FollowUpTask, Activity
        checks = [(Lead, Lead.company_id), (Opportunity, Opportunity.company_id), (FollowUpTask, FollowUpTask.company_id), (Activity, Activity.company_id)] if isinstance(obj, Company) else [(Lead, Lead.contact_id), (OpportunityContact, OpportunityContact.contact_id), (Activity, Activity.contact_id)]
        for target, column in checks:
            query = select(target.id).where(target.tenant_id == obj.tenant_id, column == obj.id)
            if hasattr(target, 'deleted_at'): query = query.where(target.deleted_at.is_(None))
            if db.scalar(query.limit(1)): raise error(409, 'VALIDATION_ERROR', 'Active related records prevent deletion')
    if isinstance(obj, Company):
        if values.get('name') is not None or 'country' in values: lock_company_name(db, p.membership.tenant_id, values.get('name') or obj.name)
        if 'owner_id' in values: values['owner_id'] = owner(db, p, values['owner_id'])
        if values.get('name', 'valid') is None: raise error(422, 'VALIDATION_ERROR', 'name cannot be null')
        if 'website' in values: values['website_domain'] = domain(values['website'])
    else:
        merged = {k: values.get(k, getattr(obj, k)) for k in ContactFields.model_fields}
        try: ContactFields(**merged)
        except Exception: raise error(422, 'VALIDATION_ERROR', 'Contact must have a name and a valid contact channel')
    if delete: values['deleted_at'] = datetime.now(timezone.utc)
    changes = {key: {'old': getattr(obj, key), 'new': value} for key, value in values.items() if getattr(obj, key) != value}
    for key, value in values.items(): setattr(obj, key, value)
    obj.version += 1
    obj.updated_by = p.user.id
    db.flush()
    db.refresh(obj)
    audit(db, p, request, 'delete' if delete else 'update', obj, values.keys(), changes)
    return output(obj), 200


def restore(db, p, request, model, id, expected):
    if model is Company:
        q = select(Company).where(Company.id == id, Company.tenant_id == p.membership.tenant_id, Company.deleted_at.is_not(None))
        if p.membership.role != 'admin': q = q.where(Company.owner_id.in_(scope_ids(p)))
        obj = db.scalar(q.with_for_update())
    else:
        q = select(Contact).join(Company, (Contact.company_id == Company.id) & (Contact.tenant_id == Company.tenant_id)).where(Contact.id == id, Contact.tenant_id == p.membership.tenant_id, Contact.deleted_at.is_not(None), Company.deleted_at.is_(None))
        if p.membership.role != 'admin': q = q.where(Company.owner_id.in_(scope_ids(p)))
        obj = db.scalar(q.with_for_update(of=(Company, Contact)))
    if not obj: raise error(404, 'NOT_FOUND', 'Deleted record not found or parent inactive')
    if obj.version != expected: raise error(409, 'VERSION_CONFLICT', 'Record has changed')
    obj.deleted_at = None
    obj.version += 1
    obj.updated_by = p.user.id
    db.flush(); db.refresh(obj)
    audit(db, p, request, 'restore', obj, ['deleted_at'])
    return output(obj), 200
