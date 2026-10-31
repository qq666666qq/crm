"""Tenant-scoped customer and member access checks shared by CRM domains."""
from sqlalchemy import select
from app.errors import error
from app.models import Company, Contact, Membership


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


def owner(db, p, owner_id):
    owner_id = owner_id or p.user.id
    if p.membership.role != 'admin' and not db.scalar(select(Membership.user_id).where(Membership.user_id == owner_id, Membership.user_id.in_(scope_ids(p)))): raise error(403, 'FORBIDDEN', 'Owner is outside your management scope')
    if not db.scalar(select(Membership.id).where(Membership.tenant_id == p.membership.tenant_id, Membership.user_id == owner_id, Membership.status == 'active')): raise error(422, 'VALIDATION_ERROR', 'Owner must be an active tenant member')
    return owner_id
