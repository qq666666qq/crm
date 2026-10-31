"""Permission-aware access and relationship checks for sales records."""
from sqlalchemy import select
from app.errors import error
from app.phase2_models import Lead, Opportunity, FollowUpTask, Activity
from app import access


def get(db, p, model, id, lock=False, include_deleted=False):
    q = select(model).where(model.id == id, model.tenant_id == p.membership.tenant_id)
    if hasattr(model, 'deleted_at') and not include_deleted: q = q.where(model.deleted_at.is_(None))
    if p.membership.role != 'admin':
        if model in (Lead, Opportunity): q = q.where(model.owner_id.in_(access.scope_ids(p)))
        elif model is FollowUpTask: q = q.where(model.assigned_to.in_(access.scope_ids(p)))
        elif model is Activity: q = q.where(model.created_by.in_(access.scope_ids(p)))
    if lock: q = q.with_for_update()
    obj = db.scalar(q)
    if not obj: raise error(404, 'NOT_FOUND', 'Record not found')
    if model is Lead:
        if obj.company_id: access.get_company(db, p, obj.company_id, lock)
        if obj.contact_id: access.get_contact(db, p, obj.contact_id, lock)
    if model is Opportunity: access.get_company(db, p, obj.company_id, lock)
    if model in (FollowUpTask, Activity): validate_links(db, p, {key: getattr(obj, key, None) for key in ('company_id','contact_id','lead_id','opportunity_id','follow_up_task_id')})
    return obj


def validate_links(db, p, fields, lock=False):
    company = access.get_company(db, p, fields['company_id'], lock) if fields.get('company_id') else None
    contact = access.get_contact(db, p, fields['contact_id'], lock) if fields.get('contact_id') else None
    lead = get(db, p, Lead, fields['lead_id'], lock) if fields.get('lead_id') else None
    opportunity = get(db, p, Opportunity, fields['opportunity_id'], lock) if fields.get('opportunity_id') else None
    task = get(db, p, FollowUpTask, fields['follow_up_task_id'], lock) if fields.get('follow_up_task_id') else None
    task_lead = get(db, p, Lead, task.lead_id, lock) if task and task.lead_id else None
    task_opportunity = get(db, p, Opportunity, task.opportunity_id, lock) if task and task.opportunity_id else None
    company_ids = {x for x in (getattr(company, 'id', None), getattr(contact, 'company_id', None), getattr(lead, 'company_id', None), getattr(opportunity, 'company_id', None), getattr(task, 'company_id', None), getattr(task_lead, 'company_id', None), getattr(task_opportunity, 'company_id', None)) if x}
    if len(company_ids) > 1: raise error(409, 'VALIDATION_ERROR', 'Related objects belong to different companies')
    if task and ((lead and task.lead_id and lead.id != task.lead_id) or (opportunity and task.opportunity_id and opportunity.id != task.opportunity_id)):
        raise error(409, 'VALIDATION_ERROR', 'Related objects do not match the task')
    if task_lead and opportunity and opportunity.originating_lead_id and task_lead.id != opportunity.originating_lead_id:
        raise error(409, 'VALIDATION_ERROR', 'Opportunity does not match the task lead')
    if lead and task_opportunity and task_opportunity.originating_lead_id and lead.id != task_opportunity.originating_lead_id:
        raise error(409, 'VALIDATION_ERROR', 'Lead does not match the task opportunity')
    if lead and opportunity and opportunity.originating_lead_id and lead.id != opportunity.originating_lead_id:
        raise error(409, 'VALIDATION_ERROR', 'Lead does not match the opportunity')
    return company, contact, lead, opportunity, task
