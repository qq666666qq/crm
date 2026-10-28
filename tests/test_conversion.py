from concurrent.futures import ThreadPoolExecutor
from sqlalchemy import select
import pytest
from test_integration import env
from app.models import Company, Contact, AuditLog
from app.phase2_models import Lead, Opportunity, OpportunityContact


def make_lead(client, headers, key, **fields):
    body = {'title': 'Inquiry', 'source': 'manual', 'product_interest': 'Parts', 'evidence': [{'evidence_type': 'manual', 'source_type': 'manual', 'manual_note': 'Buyer requested parts'}], **fields}
    created = client.post('/api/v1/leads', headers={**headers, 'Idempotency-Key': key}, json=body)
    assert created.status_code == 201, created.text
    lead = created.json()
    qualified = client.post(f"/api/v1/leads/{lead['id']}/qualify", headers={**headers, 'Idempotency-Key': key + '-qualify'}, json={'expected_version': 1})
    assert qualified.status_code == 200, qualified.text
    return lead


def test_convert_creates_company_contact_and_replays(env):
    client, sessions, (tenant, _, admin, _), auth = env
    h = auth('admin@example.com', tenant)
    lead = make_lead(client, h, 'lead')
    body = {'expected_version': 2, 'name': 'Parts order', 'company_new': {'name': 'New Buyer', 'country': 'France', 'website': 'https://buyer.example'}, 'contact_new': {'name': 'Jane', 'email': 'JANE@example.com'}}
    headers = {**h, 'Idempotency-Key': 'convert'}
    first = client.post(f"/api/v1/leads/{lead['id']}/convert", headers=headers, json=body)
    assert first.status_code == 201, first.text
    replay = client.post(f"/api/v1/leads/{lead['id']}/convert", headers=headers, json=body)
    assert replay.status_code == 201 and replay.json() == first.json()
    with sessions() as db:
        company = db.scalar(select(Company).where(Company.name == 'New Buyer'))
        contact = db.scalar(select(Contact).where(Contact.company_id == company.id))
        saved = db.get(Lead, lead['id'])
        opportunity = db.get(Opportunity, first.json()['id'])
        link = db.scalar(select(OpportunityContact).where(OpportunityContact.opportunity_id == opportunity.id))
        assert contact.email == 'jane@example.com'
        assert saved.status == 'converted' and saved.company_id == company.id and saved.contact_id == contact.id
        assert link.contact_id == contact.id and link.is_primary
        assert {row.object_type for row in db.scalars(select(AuditLog).where(AuditLog.result == 'success'))} >= {'companies', 'contacts', 'leads', 'opportunities', 'opportunity_contacts'}


def test_convert_existing_company_and_contact_checks_access(env):
    client, sessions, (tenant, other_tenant, admin, sales), auth = env
    h = auth('admin@example.com', tenant)
    company = client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'company'}, json={'name': 'Existing'}).json()
    contact = client.post(f"/api/v1/companies/{company['id']}/contacts", headers={**h, 'Idempotency-Key': 'contact'}, json={'name': 'Lee', 'email': 'lee@example.com'}).json()
    lead = make_lead(client, h, 'lead')
    result = client.post(f"/api/v1/leads/{lead['id']}/convert", headers={**h, 'Idempotency-Key': 'convert'}, json={'expected_version': 2, 'name': 'Order', 'company_id': company['id'], 'contact_id': contact['id']})
    assert result.status_code == 201, result.text
    with sessions() as db:
        saved = db.get(Lead, lead['id'])
        assert str(saved.contact_id) == contact['id']
        assert db.scalar(select(OpportunityContact).where(OpportunityContact.contact_id == saved.contact_id)) is not None
    outsider = auth('other@example.com', other_tenant)
    foreign = make_lead(client, outsider, 'other-lead')
    denied = client.post(f"/api/v1/leads/{foreign['id']}/convert", headers={**outsider, 'Idempotency-Key': 'cross'}, json={'expected_version': 2, 'name': 'Wrong', 'company_id': company['id'], 'contact_id': contact['id']})
    assert denied.status_code == 404
    seller = auth('sales@example.com', tenant)
    denied = client.post(f"/api/v1/leads/{lead['id']}/convert", headers={**seller, 'Idempotency-Key': 'forged', 'X-Operation-Source': 'agent'}, json={'expected_version': 2, 'name': 'Wrong', 'company_id': company['id']})
    assert denied.status_code == 404


def test_conversion_identity_conflicts_do_not_create_records(env):
    client, sessions, (tenant, _, admin, _), auth = env
    h = auth('admin@example.com', tenant)
    company = client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'company'}, json={'name': 'Ambiguous', 'country': 'France'}).json()
    contact = client.post(f"/api/v1/companies/{company['id']}/contacts", headers={**h, 'Idempotency-Key': 'contact'}, json={'name': 'Lee', 'email': 'lee@example.com'}).json()
    lead = make_lead(client, h, 'lead')
    url = f"/api/v1/leads/{lead['id']}/convert"
    ambiguous = client.post(url, headers={**h, 'Idempotency-Key': 'ambiguous'}, json={'expected_version': 2, 'name': 'Order', 'company_new': {'name': 'AMBIGUOUS', 'country': 'france'}, 'contact_new': {'name':'New','email':'new@example.com'}})
    assert ambiguous.status_code == 409 and ambiguous.json()['error']['code'] == 'DUPLICATE_DETECTED'
    duplicate_contact = client.post(url, headers={**h, 'Idempotency-Key': 'duplicate-contact'}, json={'expected_version': 2, 'name': 'Order', 'company_id': company['id'], 'contact_new': {'name':'Other','email':'lee@example.com'}})
    assert duplicate_contact.status_code == 409
    with sessions() as db:
        assert db.get(Lead, lead['id']).status == 'qualified'
        assert len(list(db.scalars(select(Company)))) == 1
        assert len(list(db.scalars(select(Contact)))) == 1
        assert len(list(db.scalars(select(Opportunity)))) == 0


def test_conversion_rolls_back_created_objects_and_audits(env, monkeypatch):
    from app import sales_service
    client, sessions, (tenant, _, admin, _), auth = env
    h = auth('admin@example.com', tenant)
    lead = make_lead(client, h, 'lead')
    original = sales_service.record
    def fail(db, principal, request, action, obj, fields, changes=None):
        if isinstance(obj, Opportunity): raise RuntimeError('simulated failure after company and contact creation')
        return original(db, principal, request, action, obj, fields, changes)
    monkeypatch.setattr(sales_service, 'record', fail)
    with pytest.raises(RuntimeError):
        client.post(f"/api/v1/leads/{lead['id']}/convert", headers={**h, 'Idempotency-Key': 'convert'}, json={'expected_version':2, 'name':'Order', 'company_new':{'name':'Rollback'}, 'contact_new':{'name':'Jane','email':'jane@example.com'}})
    with sessions() as db:
        assert list(db.scalars(select(Company))) == []
        assert list(db.scalars(select(Contact))) == []
        assert list(db.scalars(select(Opportunity))) == []
        assert db.get(Lead, lead['id']).status == 'qualified'
        assert list(db.scalars(select(AuditLog).where(AuditLog.object_type.in_(['companies','contacts','opportunities']), AuditLog.result == 'success'))) == []


def test_concurrent_conversion_same_new_company_requires_confirmation(env):
    client, sessions, (tenant, _, admin, _), auth = env
    h = auth('admin@example.com', tenant)
    leads = [make_lead(client, h, 'lead-' + str(i)) for i in range(2)]
    def convert(i):
        return client.post(f"/api/v1/leads/{leads[i]['id']}/convert", headers={**h, 'Idempotency-Key': f'convert-{i}'}, json={'expected_version':2, 'name':f'Order {i}', 'company_new':{'name':'Concurrent Buyer','country':'France'}})
    with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(convert, range(2)))
    assert sorted(r.status_code for r in results) == [201, 409], [r.text for r in results]
    with sessions() as db:
        assert len(list(db.scalars(select(Company)))) == 1
        assert len(list(db.scalars(select(Opportunity)))) == 1


def test_sales_creation_and_owner_restrictions(env):
    client, sessions, (tenant, _, admin, sales), auth = env
    seller = auth('sales@example.com', tenant)
    lead = make_lead(client, seller, 'sales-lead')
    url = f"/api/v1/leads/{lead['id']}/convert"
    forbidden = client.post(url, headers={**seller, 'Idempotency-Key': 'wrong-owner'}, json={'expected_version':2,'name':'Order','company_new':{'name':'Buyer','owner_id':admin}})
    assert forbidden.status_code == 403
    allowed = client.post(url, headers={**seller, 'Idempotency-Key': 'own-company'}, json={'expected_version':2,'name':'Order','company_new':{'name':'Buyer'},'contact_new':{'name':'Jane','email':'jane@example.com'}})
    assert allowed.status_code == 201, allowed.text
    with sessions() as db:
        assert str(db.scalar(select(Company)).owner_id) == sales


def test_conversion_rejects_conflicting_existing_lead_task(env):
    from datetime import datetime, timezone
    client, sessions, (tenant, _, admin, _), auth = env
    h = auth('admin@example.com', tenant)
    a = client.post('/api/v1/companies', headers={**h,'Idempotency-Key':'company-a'}, json={'name':'A'}).json()
    b = client.post('/api/v1/companies', headers={**h,'Idempotency-Key':'company-b'}, json={'name':'B'}).json()
    lead = make_lead(client, h, 'lead')
    task = client.post('/api/v1/follow-up-tasks', headers={**h,'Idempotency-Key':'task'}, json={'title':'Call','company_id':a['id'],'lead_id':lead['id'],'due_at':datetime.now(timezone.utc).isoformat()})
    assert task.status_code == 201, task.text
    conflict = client.post(f"/api/v1/leads/{lead['id']}/convert", headers={**h,'Idempotency-Key':'convert'}, json={'expected_version':2,'company_id':b['id'],'name':'Order','contact_new':{'name':'Jane','email':'jane@example.com'}})
    assert conflict.status_code == 409
    with sessions() as db:
        assert list(db.scalars(select(Contact))) == []
        assert list(db.scalars(select(Opportunity))) == []
        assert db.get(Lead, lead['id']).status == 'qualified'
