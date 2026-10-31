"""Sales API. Both interactive clients and agents use the same endpoints."""
from uuid import UUID
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Contact
from app.security import principal
from app import access, service
from app import sales_service as domain
from app import sales_access
from app.phase2_models import Lead, LeadEvidence, Opportunity, OpportunityContact, FollowUpTask, Activity
from app.sales_schemas import LeadCreate, LeadPatch, EvidenceIn, OpportunityData, OpportunityPatch, TaskData, TaskPatch, ActivityData, ActivityPatch, Version, Reason, Note, Stage, Convert, ContactLink

router = APIRouter(prefix='/api/v1', tags=['sales'])


def write(db, p, request, key, operation, model):
    def replay(result):
        if model is LeadEvidence: sales_access.get(db, p, Lead, UUID(result['lead_id']))
        elif model is OpportunityContact: sales_access.get(db, p, Opportunity, UUID(result['opportunity_id']))
        else: sales_access.get(db, p, model, UUID(result['id']), include_deleted=True)
    body, status = service.write(db, p, request, key, operation, replay_authorize=replay)
    return JSONResponse(status_code=status, content=body)


def list_records(db, p, model, limit, offset, status=None, filters=None, search=None, states=None, sort=None):
    from app.errors import error
    if not 1 <= limit <= 100 or offset < 0: raise error(422, 'VALIDATION_ERROR', 'Invalid pagination')
    q = select(model).where(model.tenant_id == p.membership.tenant_id, model.deleted_at.is_(None))
    if p.membership.role != 'admin':
        field = model.assigned_to if model is FollowUpTask else model.created_by if model is Activity else model.owner_id
        q = q.where(field.in_(access.scope_ids(p)))
    if status:
        field = model.stage if model is Opportunity else getattr(model, 'status', None)
        if field is None: raise error(422, 'VALIDATION_ERROR', 'Unsupported filter')
        q = q.where(field == status)
    if states:
        field = model.stage if model is Opportunity else getattr(model, 'status', None)
        if field is None: raise error(422, 'VALIDATION_ERROR', 'Unsupported filter')
        q = q.where(field.in_(states.split(',')))
    if search:
        field = model.name if model is Opportunity else model.title
        term = search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        q = q.where(field.ilike('%' + term + '%', escape='\\'))
    for key, value in (filters or {}).items():
        if value is not None: q = q.where(getattr(model, key) == value)
    if sort not in (None, 'due') or (sort == 'due' and model is not FollowUpTask): raise error(422, 'VALIDATION_ERROR', 'Unsupported sort')
    ordering = (model.due_at, model.id) if sort == 'due' else (model.created_at, model.id)
    rows = []
    # Read bounded batches and stop as soon as the requested page is filled.
    scan_offset = 0
    while len(rows) < offset + limit:
        batch = list(db.scalars(q.order_by(*ordering).limit(100).offset(scan_offset)))
        if not batch: break
        for obj in batch:
            try: sales_access.get(db, p, model, obj.id)
            except Exception as exc:
                if getattr(exc, 'status_code', None) == 404: continue
                raise
            rows.append(obj)
            if len(rows) >= offset + limit: break
        scan_offset += len(batch)
        if len(batch) < 100: break
    return {'items': service.output_with_owner(db, p, rows[offset:offset+limit])}


def task_page(db, p, query, limit, offset):
    from app.errors import error
    if not 1 <= limit <= 100 or offset < 0: raise error(422,'VALIDATION_ERROR','Invalid pagination')
    items = []; scan = 0
    while len(items) < offset + limit:
        batch = list(db.scalars(query.limit(100).offset(scan)))
        if not batch: break
        for task in batch:
            try: sales_access.get(db, p, FollowUpTask, task.id)
            except Exception as exc:
                if getattr(exc, 'status_code', None) == 404: continue
                raise
            items.append(service.output(task))
            if len(items) >= offset + limit: break
        scan += len(batch)
        if len(batch) < 100: break
    return {'items': items[offset:offset+limit]}


@router.get('/leads')
def leads(limit: int = 50, offset: int = 0, status: str | None = None, company_id: UUID | None = None, q: str | None = None, states: str | None = None, p=Depends(principal), db: Session = Depends(get_db)): return list_records(db,p,Lead,limit,offset,status,{'company_id': company_id},q,states)

@router.post('/leads')
def create_lead(data: LeadCreate, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.create(db,p,request,Lead,data),Lead)

@router.get('/leads/{id}')
def get_lead(id: UUID, p=Depends(principal), db: Session = Depends(get_db)): return service.output_with_owner(db,p,[sales_access.get(db,p,Lead,id)])[0]

@router.patch('/leads/{id}')
def patch_lead(id: UUID, data: LeadPatch, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.patch(db,p,request,Lead,id,data),Lead)

@router.delete('/leads/{id}')
def delete_lead(id: UUID, expected_version: int, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.remove(db,p,request,Lead,id,expected_version),Lead)

@router.post('/leads/{id}/qualify')
def qualify(id: UUID, data: Version, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.lead_transition(db,p,request,id,data.expected_version,'qualify'),Lead)

@router.post('/leads/{id}/start')
def start_lead(id: UUID, data: Version, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.lead_transition(db,p,request,id,data.expected_version,'start'),Lead)

@router.post('/leads/{id}/disqualify')
def disqualify(id: UUID, data: Reason, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.lead_transition(db,p,request,id,data.expected_version,'disqualify',data.reason),Lead)

@router.post('/leads/{id}/reopen')
def reopen(id: UUID, data: Version, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.lead_transition(db,p,request,id,data.expected_version,'reopen'),Lead)

@router.post('/leads/{id}/convert')
def convert(id: UUID, data: Convert, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.convert(db,p,request,id,data),Opportunity)

@router.get('/leads/{id}/evidence')
def evidence(id: UUID, limit: int = 50, offset: int = 0, p=Depends(principal), db: Session = Depends(get_db)):
    sales_access.get(db,p,Lead,id)
    from app.errors import error
    if not 1 <= limit <= 100 or offset < 0: raise error(422,'VALIDATION_ERROR','Invalid pagination')
    return {'items':[service.output(x) for x in db.scalars(select(LeadEvidence).where(LeadEvidence.tenant_id==p.membership.tenant_id,LeadEvidence.lead_id==id).order_by(LeadEvidence.created_at,LeadEvidence.id).limit(limit).offset(offset))]}

@router.post('/leads/{id}/evidence')
def create_evidence(id: UUID, data: EvidenceIn, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.add_evidence(db,p,request,id,data),LeadEvidence)

@router.get('/opportunities')
def opportunities(limit: int = 50, offset: int = 0, stage: str | None = None, company_id: UUID | None = None, q: str | None = None, states: str | None = None, p=Depends(principal), db: Session = Depends(get_db)): return list_records(db,p,Opportunity,limit,offset,stage,{'company_id': company_id},q,states)

@router.post('/opportunities')
def create_opportunity(data: OpportunityData, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.create(db,p,request,Opportunity,data),Opportunity)

@router.get('/opportunities/{id}')
def get_opportunity(id: UUID, p=Depends(principal), db: Session = Depends(get_db)): return service.output_with_owner(db,p,[sales_access.get(db,p,Opportunity,id)])[0]

@router.patch('/opportunities/{id}')
def patch_opportunity(id: UUID, data: OpportunityPatch, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.patch(db,p,request,Opportunity,id,data),Opportunity)

@router.delete('/opportunities/{id}')
def delete_opportunity(id: UUID, expected_version: int, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.remove(db,p,request,Opportunity,id,expected_version),Opportunity)

@router.post('/opportunities/{id}/stage')
def opportunity_stage(id: UUID, data: Stage, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.stage(db,p,request,id,data.expected_version,data.stage),Opportunity)

@router.post('/opportunities/{id}/close-won')
def close_won(id: UUID, data: Note, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.stage(db,p,request,id,data.expected_version,'won',data.note),Opportunity)

@router.post('/opportunities/{id}/close-lost')
def close_lost(id: UUID, data: Reason, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.stage(db,p,request,id,data.expected_version,'lost',data.reason),Opportunity)

@router.get('/opportunities/{id}/contacts')
def opportunity_contacts(id: UUID, limit: int = 50, offset: int = 0, p=Depends(principal), db: Session = Depends(get_db)):
    sales_access.get(db,p,Opportunity,id)
    from app.errors import error
    if not 1 <= limit <= 100 or offset < 0: raise error(422,'VALIDATION_ERROR','Invalid pagination')
    links = list(db.scalars(select(OpportunityContact).where(OpportunityContact.tenant_id==p.membership.tenant_id,OpportunityContact.opportunity_id==id).order_by(OpportunityContact.created_at,OpportunityContact.id).limit(limit).offset(offset)))
    names = dict(db.execute(select(Contact.id, Contact.name).where(Contact.tenant_id == p.membership.tenant_id, Contact.id.in_([link.contact_id for link in links]))).all()) if links else {}
    return {'items': [{**service.output(link), 'contact_name': names.get(link.contact_id)} for link in links]}

@router.post('/opportunities/{id}/contacts')
def link_contact(id: UUID, data: ContactLink, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.add_contact(db,p,request,id,data),OpportunityContact)

@router.delete('/opportunities/{id}/contacts/{contact_id}')
def unlink_contact(id: UUID, contact_id: UUID, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.unlink_contact(db,p,request,id,contact_id),OpportunityContact)


@router.get('/follow-up-tasks/due')
def due(until: datetime | None = None, from_at: datetime | None = None, limit: int = 50, offset: int = 0, p=Depends(principal), db: Session = Depends(get_db)):
    from app.errors import error
    if until and (until.tzinfo is None or until.utcoffset() is None): raise error(422,'VALIDATION_ERROR','until requires a timezone')
    if from_at and (from_at.tzinfo is None or from_at.utcoffset() is None): raise error(422,'VALIDATION_ERROR','from_at requires a timezone')
    if not 1 <= limit <= 100 or offset < 0: raise error(422,'VALIDATION_ERROR','Invalid pagination')
    cutoff = until or datetime.now(timezone.utc)
    query = select(FollowUpTask).where(FollowUpTask.tenant_id == p.membership.tenant_id, FollowUpTask.assigned_to == p.user.id, FollowUpTask.deleted_at.is_(None), FollowUpTask.status == 'pending', FollowUpTask.due_at <= cutoff).order_by(FollowUpTask.due_at, FollowUpTask.id)
    if from_at: query = query.where(FollowUpTask.due_at >= from_at)
    return task_page(db, p, query, limit, offset)

@router.get('/follow-up-tasks/overdue')
def overdue(limit: int = 50, offset: int = 0, p=Depends(principal), db: Session = Depends(get_db)): return due(None,None,limit,offset,p,db)

@router.get('/follow-up-tasks/reminders')
def reminders(limit: int = 50, offset: int = 0, p=Depends(principal), db: Session = Depends(get_db)):
    from app.errors import error
    if not 1 <= limit <= 100 or offset < 0: raise error(422,'VALIDATION_ERROR','Invalid pagination')
    query = select(FollowUpTask).where(FollowUpTask.tenant_id == p.membership.tenant_id, FollowUpTask.assigned_to == p.user.id, FollowUpTask.deleted_at.is_(None), FollowUpTask.status == 'pending', FollowUpTask.remind_at <= datetime.now(timezone.utc)).order_by(FollowUpTask.remind_at, FollowUpTask.id)
    return task_page(db, p, query, limit, offset)

@router.get('/follow-up-tasks')
def tasks(limit: int = 50, offset: int = 0, status: str | None = None, company_id: UUID | None = None, lead_id: UUID | None = None, opportunity_id: UUID | None = None, q: str | None = None, sort: str | None = None, p=Depends(principal), db: Session = Depends(get_db)): return list_records(db,p,FollowUpTask,limit,offset,status,{'company_id':company_id, 'lead_id':lead_id, 'opportunity_id':opportunity_id},q,None,sort)

@router.post('/follow-up-tasks')
def create_task(data: TaskData, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.create(db,p,request,FollowUpTask,data),FollowUpTask)

@router.get('/follow-up-tasks/{id}')
def get_task(id: UUID, p=Depends(principal), db: Session = Depends(get_db)): return service.output_with_owner(db,p,[sales_access.get(db,p,FollowUpTask,id)])[0]

@router.patch('/follow-up-tasks/{id}')
def patch_task(id: UUID, data: TaskPatch, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.patch(db,p,request,FollowUpTask,id,data),FollowUpTask)

@router.delete('/follow-up-tasks/{id}')
def delete_task(id: UUID, expected_version: int, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.remove(db,p,request,FollowUpTask,id,expected_version),FollowUpTask)

@router.post('/follow-up-tasks/{id}/complete')
def complete_task(id: UUID, data: Note, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.task_transition(db,p,request,id,data.expected_version,'completed',data.note),FollowUpTask)

@router.post('/follow-up-tasks/{id}/cancel')
def cancel_task(id: UUID, data: Version, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.task_transition(db,p,request,id,data.expected_version,'cancelled'),FollowUpTask)

@router.get('/activities')
def activities(limit: int = 50, offset: int = 0, company_id: UUID | None = None, lead_id: UUID | None = None, opportunity_id: UUID | None = None, follow_up_task_id: UUID | None = None, p=Depends(principal), db: Session = Depends(get_db)): return list_records(db,p,Activity,limit,offset,filters={'company_id':company_id, 'lead_id':lead_id, 'opportunity_id':opportunity_id, 'follow_up_task_id':follow_up_task_id})

@router.post('/activities')
def create_activity(data: ActivityData, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.create(db,p,request,Activity,data),Activity)

@router.get('/activities/{id}')
def get_activity(id: UUID, p=Depends(principal), db: Session = Depends(get_db)): return service.output(sales_access.get(db,p,Activity,id))

@router.patch('/activities/{id}')
def patch_activity(id: UUID, data: ActivityPatch, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.patch(db,p,request,Activity,id,data),Activity)

@router.delete('/activities/{id}')
def delete_activity(id: UUID, request: Request, expected_version: int, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)): return write(db,p,request,key,lambda: domain.remove(db,p,request,Activity,id,expected_version),Activity)
