import uuid
from datetime import datetime, timezone
from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException
from app.database import get_db
from app.errors import error
from app.models import Company, Contact, Membership, User, AuditLog
from app.schemas import CompanyFields, CompanyPatch, ContactFields, ContactPatch, Login, MemberCreate, MemberPatch, MemberAttach, Restore
from app.security import login, principal
from app import service
from app import members
from app.sales_api import router as sales_router

app = FastAPI(title='B2B CRM API', version='1.0.0')
app.include_router(sales_router)


def audit_failure(request, result):
    p = getattr(request.state, 'principal', None)
    db = getattr(request.state, 'audit_db', None)
    if not p or not db or request.method not in ('POST', 'PATCH', 'DELETE') or not request.url.path.startswith('/api/v1/') or request.url.path.startswith('/api/v1/auth/'):
        return
    parts = request.url.path.split('/')
    target = uuid.UUID(int=0)
    for part in parts:
        try: target = uuid.UUID(part)
        except ValueError: pass
    try:
        db.rollback()
        tenant_id, user_id = request.state.audit_identity
        db.add(AuditLog(tenant_id=tenant_id, actor_id=user_id, action=request.method.lower(), object_type=(parts[3] if len(parts) > 3 else 'unknown')[:50], object_id=target, changed_fields=[], result=result[:20], request_id=request.state.request_id, source=request.headers.get('X-Operation-Source') if request.headers.get('X-Operation-Source') in ('human', 'agent') else 'human', agent_run_id=(request.headers.get('X-Agent-Run-ID') or '')[:100] or None))
        db.commit()
    except Exception:
        db.rollback()


@app.middleware('http')
async def request_context(request: Request, call_next):
    request.state.request_id = str(uuid.uuid4())
    request.state.body = await request.body()
    response = await call_next(request)
    response.headers['X-Request-ID'] = request.state.request_id
    return response


@app.exception_handler(HTTPException)
async def http_error(request, exc):
    detail = exc.detail if isinstance(exc.detail, dict) else {'code': 'NOT_FOUND' if exc.status_code == 404 else 'INTERNAL_ERROR', 'message': str(exc.detail)}
    audit_failure(request, detail.get('code', 'failure'))
    return JSONResponse(status_code=exc.status_code, content={'error': detail, 'request_id': request.state.request_id}, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    audit_failure(request, 'VALIDATION_ERROR')
    return JSONResponse(status_code=422, content={'error': {'code': 'VALIDATION_ERROR', 'message': 'Invalid request', 'details': [{'location': list(e['loc']), 'message': e['msg']} for e in exc.errors()]}, 'request_id': request.state.request_id})


@app.exception_handler(Exception)
async def internal_error(request, exc):
    audit_failure(request, 'INTERNAL_ERROR')
    return JSONResponse(status_code=500, content={'error': {'code': 'INTERNAL_ERROR', 'message': 'Internal server error'}, 'request_id': request.state.request_id})


@app.get('/health')
def health(db: Session = Depends(get_db)):
    db.execute(text('SELECT 1'))
    return {'status': 'ok'}


@app.post('/api/v1/auth/login')
def auth_login(data: Login, db: Session = Depends(get_db)):
    return {'access_token': login(db, str(data.email), data.password), 'token_type': 'bearer'}


@app.get('/api/v1/auth/me')
def me(p=Depends(principal)):
    return {'user_id': str(p.user.id), 'email': p.user.email, 'name': p.user.name, 'tenant_id': str(p.membership.tenant_id), 'role': p.membership.role}


@app.post('/api/v1/auth/logout')
def logout(p=Depends(principal), db: Session = Depends(get_db)):
    p.session.revoked_at = datetime.now(timezone.utc)
    db.commit()
    return {'status': 'logged_out'}


def response(result):
    body, status = result
    return JSONResponse(status_code=status, content=body)


@app.get('/api/v1/members')
def list_members(p=Depends(principal), db: Session = Depends(get_db)):
    members.require_admin(db, p)
    rows = db.execute(select(Membership, User).join(User, User.id == Membership.user_id).where(Membership.tenant_id == p.membership.tenant_id).order_by(User.email))
    return {'items': [members.serialize(member, user) for member, user in rows]}


@app.post('/api/v1/members')
def create_member(data: MemberCreate, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    members.require_admin(db, p)
    return response(service.write(db, p, request, key, lambda: members.create(db, p, request, data), lambda: members.require_admin(db, p, True)))


@app.post('/api/v1/members/attach')
def attach_member(data: MemberAttach, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    members.require_admin(db, p)
    return response(service.write(db, p, request, key, lambda: members.attach(db, p, request, data), lambda: members.require_admin(db, p, True)))


@app.patch('/api/v1/members/{id}')
def update_member(id: uuid.UUID, data: MemberPatch, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    members.require_admin(db, p)
    return response(service.write(db, p, request, key, lambda: members.modify(db, p, request, id, data), lambda: members.require_admin(db, p, True)))


@app.post('/api/v1/companies/{id}/restore')
def restore_company(id: uuid.UUID, data: Restore, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    return response(service.write(db, p, request, key, lambda: service.restore(db, p, request, Company, id, data.expected_version)))


@app.post('/api/v1/contacts/{id}/restore')
def restore_contact(id: uuid.UUID, data: Restore, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    return response(service.write(db, p, request, key, lambda: service.restore(db, p, request, Contact, id, data.expected_version)))


@app.get('/api/v1/companies')
def companies(q: str = '', limit: int = 50, offset: int = 0, p=Depends(principal), db: Session = Depends(get_db)):
    if not 1 <= limit <= 100 or offset < 0: raise error(422, 'VALIDATION_ERROR', 'Invalid pagination')
    query = service.company_query(p)
    if q: query = query.where(Company.name.ilike('%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%', escape='\\'))
    return {'items': [service.output(x) for x in db.scalars(query.order_by(Company.created_at, Company.id).limit(limit).offset(offset))]}


@app.get('/api/v1/companies/duplicates')
def company_duplicate_candidates(name: str, country: str | None = None, p=Depends(principal), db: Session = Depends(get_db)):
    from sqlalchemy import func
    if not name.strip() or len(name) > 255 or (country is not None and len(country) > 100): raise error(422, 'VALIDATION_ERROR', 'Invalid name or country')
    query = service.company_query(p).where(func.lower(Company.name) == name.strip().lower())
    if country: query = query.where(func.lower(Company.country) == country.strip().lower())
    return {'classification': 'possible_duplicate', 'items': [service.output(x) for x in db.scalars(query.order_by(Company.id).limit(100))]}


@app.post('/api/v1/companies')
def create_company(data: CompanyFields, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    return response(service.write(db, p, request, key, lambda: service.create(db, p, request, Company, data.model_dump())))


@app.get('/api/v1/companies/{id}')
def company(id: uuid.UUID, p=Depends(principal), db: Session = Depends(get_db)):
    return service.output(service.get_company(db, p, id))


@app.patch('/api/v1/companies/{id}')
def update_company(id: uuid.UUID, data: CompanyPatch, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    return response(service.write(db, p, request, key, lambda: service.modify(db, p, request, service.get_company(db, p, id, True), data.model_dump(exclude_unset=True))))


@app.delete('/api/v1/companies/{id}')
def delete_company(id: uuid.UUID, request: Request, expected_version: int, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    return response(service.write(db, p, request, key, lambda: service.modify(db, p, request, service.get_company(db, p, id, True), {'expected_version': expected_version}, True)))


@app.get('/api/v1/companies/{id}/contacts')
def contacts(id: uuid.UUID, p=Depends(principal), db: Session = Depends(get_db)):
    service.get_company(db, p, id)
    return {'items': [service.output(c) for c in db.scalars(select(Contact).where(Contact.tenant_id == p.membership.tenant_id, Contact.company_id == id, Contact.deleted_at.is_(None)).order_by(Contact.created_at, Contact.id))]}


@app.post('/api/v1/companies/{id}/contacts')
def create_contact(id: uuid.UUID, data: ContactFields, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    service.get_company(db, p, id)
    return response(service.write(db, p, request, key, lambda: service.create(db, p, request, Contact, data.model_dump(), id)))


@app.get('/api/v1/contacts/{id}')
def contact(id: uuid.UUID, p=Depends(principal), db: Session = Depends(get_db)):
    return service.output(service.get_contact(db, p, id))


@app.patch('/api/v1/contacts/{id}')
def update_contact(id: uuid.UUID, data: ContactPatch, request: Request, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    return response(service.write(db, p, request, key, lambda: service.modify(db, p, request, service.get_contact(db, p, id, True), data.model_dump(exclude_unset=True))))


@app.delete('/api/v1/contacts/{id}')
def delete_contact(id: uuid.UUID, request: Request, expected_version: int, key: str | None = Header(None, alias='Idempotency-Key'), p=Depends(principal), db: Session = Depends(get_db)):
    return response(service.write(db, p, request, key, lambda: service.modify(db, p, request, service.get_contact(db, p, id, True), {'expected_version': expected_version}, True)))
