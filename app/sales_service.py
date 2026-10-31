"""Authorization and transactional business rules for the sales domain."""
from datetime import datetime, timezone
from sqlalchemy import select, or_, func
from app.errors import error
from app.models import Company, Contact
from app.phase2_models import Lead, LeadEvidence, Opportunity, OpportunityContact, FollowUpTask, Activity
from app import service
from app.change_journal import record_sales_change as record
from pydantic import ValidationError
from app.sales_schemas import LeadData, OpportunityData, TaskData, ActivityData


def now(): return datetime.now(timezone.utc)


def get(db, p, model, id, lock=False, include_deleted=False):
    q = select(model).where(model.id == id, model.tenant_id == p.membership.tenant_id)
    if hasattr(model, 'deleted_at') and not include_deleted: q = q.where(model.deleted_at.is_(None))
    if p.membership.role != 'admin':
        if model in (Lead, Opportunity): q = q.where(model.owner_id.in_(service.scope_ids(p)))
        elif model is FollowUpTask: q = q.where(model.assigned_to.in_(service.scope_ids(p)))
        elif model is Activity: q = q.where(model.created_by.in_(service.scope_ids(p)))
    if lock: q = q.with_for_update()
    obj = db.scalar(q)
    if not obj: raise error(404, 'NOT_FOUND', 'Record not found')
    if model is Lead:
        if obj.company_id: service.get_company(db, p, obj.company_id, lock)
        if obj.contact_id: service.get_contact(db, p, obj.contact_id, lock)
    if model is Opportunity: service.get_company(db, p, obj.company_id, lock)
    if model in (FollowUpTask, Activity): validate_links(db, p, {key: getattr(obj, key, None) for key in ('company_id','contact_id','lead_id','opportunity_id','follow_up_task_id')})
    return obj


def validate_links(db, p, fields, lock=False):
    company = service.get_company(db, p, fields['company_id'], lock) if fields.get('company_id') else None
    contact = service.get_contact(db, p, fields['contact_id'], lock) if fields.get('contact_id') else None
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


def create(db, p, request, model, data):
    values = data.model_dump()
    evidence = values.pop('evidence', None)
    validate_links(db, p, values, True)
    if model in (Lead, Opportunity): values['owner_id'] = service.owner(db, p, values.get('owner_id'))
    if model is FollowUpTask: values['assigned_to'] = service.owner(db, p, values.get('assigned_to'))
    if model is Lead:
        if values.get('contact_id') and not values.get('company_id'): raise error(422, 'VALIDATION_ERROR', 'Contact requires its company')
    obj = model(**values, tenant_id=p.membership.tenant_id, created_by=p.user.id)
    db.add(obj); db.flush(); db.refresh(obj)
    if evidence:
        for item in evidence:
            db.add(LeadEvidence(**item, tenant_id=p.membership.tenant_id, lead_id=obj.id, created_by=p.user.id))
        db.flush()
    record(db, p, request, 'create', obj, values.keys())
    return service.output(obj), 201


def add_evidence(db, p, request, lead_id, data):
    get(db, p, Lead, lead_id, True)
    obj = LeadEvidence(**data.model_dump(), tenant_id=p.membership.tenant_id, lead_id=lead_id, created_by=p.user.id)
    db.add(obj); db.flush(); db.refresh(obj)
    record(db, p, request, 'create', obj, ['lead_id', 'evidence_type', 'source_type', 'source_id'])
    return service.output(obj), 201


def version(obj, expected):
    if obj.version != expected: raise error(409, 'VERSION_CONFLICT', 'Record has changed')


def change(db, p, request, obj, expected, values, action):
    version(obj, expected)
    changes = {k: {'old': getattr(obj, k), 'new': v} for k, v in values.items() if getattr(obj, k) != v}
    for k, v in values.items(): setattr(obj, k, v)
    if hasattr(obj, 'version'): obj.version += 1
    if hasattr(obj, 'updated_by'): obj.updated_by = p.user.id
    db.flush(); db.refresh(obj)
    record(db, p, request, action, obj, values.keys(), changes)
    return service.output(obj), 200


def lead_transition(db, p, request, id, expected, action, reason=None):
    obj = get(db, p, Lead, id, True)
    version(obj, expected)
    allowed = {'start': (('new',), 'working'), 'qualify': (('new','working'), 'qualified'), 'disqualify': (('new','working','qualified'), 'disqualified'), 'reopen': (('disqualified',), 'working')}
    states, target = allowed[action]
    if obj.status not in states: raise error(409, 'VALIDATION_ERROR', 'Invalid lead transition')
    return change(db, p, request, obj, expected, {'status': target, 'disqualification_reason': reason if action == 'disqualify' else None}, action)


def convert(db, p, request, id, data):
    lead = get(db, p, Lead, id, True)
    version(lead, data.expected_version)
    if lead.status != 'qualified': raise error(409, 'VALIDATION_ERROR', 'Only qualified leads can be converted')
    if not (lead.product_interest or lead.requirement_notes): raise error(409, 'VALIDATION_ERROR', 'Purchase requirement is required')
    if data.company_new:
        if lead.company_id or lead.contact_id: raise error(409, 'VALIDATION_ERROR', 'The lead already has an identified company or contact')
        new_company = data.company_new.model_dump()
        service.lock_company_name(db, lead.tenant_id, new_company['name'])
        # Names are only a warning signal. Do not expose another salesperson's data.
        candidate = select(Company.id).where(Company.tenant_id == lead.tenant_id, Company.deleted_at.is_(None), func.lower(Company.name) == new_company['name'].lower())
        if new_company.get('country'):
            candidate = candidate.where(or_(Company.country.is_(None), func.lower(Company.country) == new_company['country'].lower()))
        if db.scalar(candidate.limit(1)): raise error(409, 'DUPLICATE_DETECTED', 'Company identity requires confirmation; select an existing company or resolve the possible duplicate')
        if new_company.get('owner_id') is None: new_company['owner_id'] = lead.owner_id
        created, _ = service.create(db, p, request, Company, new_company)
        from uuid import UUID
        company = service.get_company(db, p, UUID(created['id']), True)
    else:
        company_id = data.company_id or lead.company_id
        if not company_id: raise error(409, 'VALIDATION_ERROR', 'Choose an existing company or provide a new company')
        company = service.get_company(db, p, company_id, True)
    if lead.company_id and lead.company_id != company.id: raise error(409, 'VALIDATION_ERROR', 'Company identity does not match the lead')
    if lead.contact_id and data.contact_new: raise error(409, 'VALIDATION_ERROR', 'The lead already has an identified contact')
    if lead.contact_id and data.contact_id and lead.contact_id != data.contact_id: raise error(409, 'VALIDATION_ERROR', 'Contact identity does not match the lead')
    contact_id = data.contact_id or lead.contact_id
    if data.contact_new:
        created_contact, _ = service.create(db, p, request, Contact, data.contact_new.model_dump(), company.id)
        from uuid import UUID
        contact_id = UUID(created_contact['id'])
    if contact_id and service.get_contact(db, p, contact_id, True).company_id != company.id: raise error(409, 'VALIDATION_ERROR', 'Contact belongs to another company')
    # Existing activities and tasks must remain consistent with the resolved company.
    for model in (FollowUpTask, Activity):
        for linked in db.scalars(select(model).where(model.tenant_id == lead.tenant_id, model.lead_id == lead.id, model.deleted_at.is_(None)).with_for_update()):
            if linked.company_id and linked.company_id != company.id:
                raise error(409, 'VALIDATION_ERROR', 'An existing lead record belongs to another company')
            fields = {key: getattr(linked, key, None) for key in ('company_id', 'contact_id', 'lead_id', 'opportunity_id', 'follow_up_task_id')}
            fields['company_id'] = company.id
            validate_links(db, p, fields, True)
    # Exact name is a conservative duplicate signal, not an identity merge.
    duplicate = db.scalar(select(Opportunity.id).where(Opportunity.tenant_id == lead.tenant_id, Opportunity.company_id == company.id, Opportunity.name == data.name, Opportunity.deleted_at.is_(None)))
    if duplicate: raise error(409, 'DUPLICATE_DETECTED', 'An opportunity with this name already exists for this company')
    obj = Opportunity(tenant_id=lead.tenant_id, company_id=company.id, originating_lead_id=lead.id, name=data.name, product_summary=lead.product_interest, requirement_notes=lead.requirement_notes, owner_id=lead.owner_id, created_by=p.user.id, stage='discovery')
    db.add(obj); db.flush(); db.refresh(obj)
    record(db, p, request, 'create', obj, ['originating_lead_id','company_id','name'])
    if contact_id:
        link = OpportunityContact(tenant_id=lead.tenant_id, opportunity_id=obj.id, contact_id=contact_id, is_primary=True)
        db.add(link); db.flush()
        record(db, p, request, 'link', link, ['opportunity_id', 'contact_id', 'is_primary'])
    change(db, p, request, lead, data.expected_version, {'company_id': company.id, 'contact_id': contact_id, 'status': 'converted'}, 'convert')
    return service.output(obj), 201


def stage(db, p, request, id, expected, target, note=None):
    obj = get(db, p, Opportunity, id, True)
    version(obj, expected)
    if obj.stage in ('won','lost'): raise error(409, 'VALIDATION_ERROR', 'Closed opportunity cannot be changed')
    if target == 'lost' and not note: raise error(422, 'VALIDATION_ERROR', 'Lost reason required')
    fields = {'stage': target}
    if target in ('won','lost'):
        fields.update(closed_at=now(), close_note=note if target == 'won' else None, lost_reason=note if target == 'lost' else None)
    return change(db, p, request, obj, expected, fields, 'stage')


def task_transition(db, p, request, id, expected, status, note=None):
    task = get(db, p, FollowUpTask, id, True)
    version(task, expected)
    if task.status != 'pending': raise error(409, 'VALIDATION_ERROR', 'Task is already closed')
    return change(db, p, request, task, expected, {'status': status, 'completed_at': now() if status == 'completed' else None, 'completion_note': note if status == 'completed' else None}, status)


def patch(db, p, request, model, id, data):
    obj = get(db, p, model, id, True)
    if hasattr(obj, 'version'): version(obj, data.expected_version)
    if model is Opportunity and obj.stage in ('won','lost'): raise error(409, 'VALIDATION_ERROR', 'Closed opportunity cannot be edited')
    if model is Lead and obj.status == 'converted': raise error(409, 'VALIDATION_ERROR', 'Converted lead cannot be edited')
    if model is FollowUpTask and obj.status != 'pending': raise error(409, 'VALIDATION_ERROR', 'Closed task cannot be edited')
    changes = data.model_dump(exclude_unset=True)
    expected = changes.pop('expected_version', None)
    schema = {Lead: LeadData, Opportunity: OpportunityData, FollowUpTask: TaskData, Activity: ActivityData}[model]
    merged = {key: changes.get(key, getattr(obj, key)) for key in schema.model_fields}
    try: clean = schema(**merged).model_dump()
    except ValidationError: raise error(422, 'VALIDATION_ERROR', 'Invalid record values')
    validate_links(db, p, clean, True)
    if model is Lead and any(clean[k] != getattr(obj, k) for k in ('company_id', 'contact_id')):
        for target, column in ((Opportunity, Opportunity.originating_lead_id), (FollowUpTask, FollowUpTask.lead_id), (Activity, Activity.lead_id)):
            if db.scalar(select(target.id).where(target.tenant_id == obj.tenant_id, column == obj.id, target.deleted_at.is_(None)).limit(1)):
                raise error(409, 'VALIDATION_ERROR', 'Cannot change a lead relation while active records reference it')
    if model is Opportunity and clean['company_id'] != obj.company_id:
        if obj.originating_lead_id or db.scalar(select(OpportunityContact.id).where(OpportunityContact.opportunity_id == obj.id).limit(1)) or db.scalar(select(FollowUpTask.id).where(FollowUpTask.opportunity_id == obj.id, FollowUpTask.deleted_at.is_(None)).limit(1)) or db.scalar(select(Activity.id).where(Activity.opportunity_id == obj.id, Activity.deleted_at.is_(None)).limit(1)):
            raise error(409, 'VALIDATION_ERROR', 'Cannot change company while active records reference the opportunity')
    if model is FollowUpTask and any(clean[k] != getattr(obj, k) for k in ('company_id', 'lead_id', 'opportunity_id')):
        if db.scalar(select(Activity.id).where(Activity.follow_up_task_id == obj.id, Activity.deleted_at.is_(None)).limit(1)):
            raise error(409, 'VALIDATION_ERROR', 'Cannot change task relations while active activities reference it')
    if model is Lead and clean.get('contact_id') and not clean.get('company_id'): raise error(422, 'VALIDATION_ERROR', 'Contact requires its company')
    for field in ('owner_id', 'assigned_to'):
        if field in changes:
            if changes[field] is None: raise error(422, 'VALIDATION_ERROR', 'Owner cannot be null')
            changes[field] = service.owner(db, p, changes[field])
    changes = {k: clean[k] if k not in ('owner_id', 'assigned_to') else changes[k] for k in changes}
    return change(db, p, request, obj, expected, changes, 'update')


def remove(db, p, request, model, id, expected=None):
    obj = get(db, p, model, id, True)
    if hasattr(obj, 'version'): version(obj, expected)
    refs = []
    if model is Lead: refs = [(Opportunity, Opportunity.originating_lead_id), (FollowUpTask, FollowUpTask.lead_id), (Activity, Activity.lead_id)]
    elif model is Opportunity: refs = [(FollowUpTask, FollowUpTask.opportunity_id), (Activity, Activity.opportunity_id), (OpportunityContact, OpportunityContact.opportunity_id)]
    elif model is FollowUpTask: refs = [(Activity, Activity.follow_up_task_id)]
    for target, field in refs:
        q = select(target.id).where(target.tenant_id == p.membership.tenant_id, field == id)
        if hasattr(target, 'deleted_at'): q = q.where(target.deleted_at.is_(None))
        if db.scalar(q.limit(1)): raise error(409, 'VALIDATION_ERROR', 'Active related records prevent deletion')
    return change(db, p, request, obj, expected, {'deleted_at': now()}, 'delete')


def add_contact(db, p, request, id, data):
    opportunity = get(db, p, Opportunity, id, True)
    contact = service.get_contact(db, p, data.contact_id, True)
    if opportunity.company_id != contact.company_id: raise error(409, 'VALIDATION_ERROR', 'Contact belongs to another company')
    link = OpportunityContact(tenant_id=p.membership.tenant_id, opportunity_id=id, **data.model_dump())
    db.add(link); db.flush(); db.refresh(link)
    record(db, p, request, 'link', link, ['opportunity_id','contact_id','is_primary','role_note'])
    return service.output(link), 201


def unlink_contact(db, p, request, id, contact_id):
    get(db, p, Opportunity, id, True)
    link = db.scalar(select(OpportunityContact).where(OpportunityContact.tenant_id == p.membership.tenant_id, OpportunityContact.opportunity_id == id, OpportunityContact.contact_id == contact_id).with_for_update())
    if not link: raise error(404, 'NOT_FOUND', 'Link not found')
    result = service.output(link)
    record(db, p, request, 'unlink', link, ['contact_id'])
    db.delete(link); db.flush()
    return result, 200
