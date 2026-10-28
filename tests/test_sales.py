from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from uuid import UUID
import pytest
from test_integration import env
from app.models import AuditLog, User
from app.phase2_models import Lead, LeadEvidence, Opportunity


def test_lead_conversion_and_evidence(env):
    client, sessions, (tenant, other_tenant, admin, sales), auth = env
    h = auth('admin@example.com', tenant)
    company = client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'co'}, json={'name': 'Buyer'}).json()
    base = {'title': 'Buy parts', 'source': 'email', 'company_id': company['id'], 'product_interest': 'parts'}
    assert client.post('/api/v1/leads', headers={**h, 'Idempotency-Key': 'no-evidence'}, json=base).status_code == 422
    bad = {**base, 'evidence': [{'evidence_type':'quote','source_type':'gmail'}]}
    assert client.post('/api/v1/leads', headers={**h, 'Idempotency-Key': 'bad'}, json=bad).status_code == 422
    evidence = {'evidence_type':'quote','source_type':'gmail','source_id':'mail-1','source_snapshot_text':'We need parts.', 'original_quote':'need parts', 'quote_start':3, 'quote_end':13}
    body = {**base, 'evidence': [evidence]}
    created = client.post('/api/v1/leads', headers={**h, 'Idempotency-Key': 'lead'}, json=body)
    assert created.status_code == 201, created.text
    lead = created.json()
    second_quote = client.post('/api/v1/leads/'+lead['id']+'/evidence', headers={**h,'Idempotency-Key':'second-quote'}, json={'evidence_type':'quote','source_type':'gmail','source_id':'mail-1','original_quote':'another passage'})
    assert second_quote.status_code == 201, second_quote.text
    duplicate = client.post('/api/v1/leads', headers={**h, 'Idempotency-Key': 'duplicate'}, json=body)
    assert duplicate.status_code == 409
    with sessions() as db:
        assert len(list(db.scalars(select(Lead)))) == 1
        assert len(list(db.scalars(select(LeadEvidence)))) == 2
    other = auth('other@example.com', other_tenant)
    assert client.get('/api/v1/leads/' + lead['id'], headers=other).status_code == 404
    seller = auth('sales@example.com', tenant)
    assert client.get('/api/v1/leads/' + lead['id'], headers=seller).status_code == 404
    qualified = client.post('/api/v1/leads/' + lead['id'] + '/qualify', headers={**h, 'Idempotency-Key':'qualify'}, json={'expected_version':1})
    assert qualified.status_code == 200, qualified.text
    def convert(i): return client.post('/api/v1/leads/' + lead['id'] + '/convert', headers={**h, 'Idempotency-Key':f'convert-{i}'}, json={'expected_version':2,'company_id':company['id'],'name':'Parts order'})
    with ThreadPoolExecutor(max_workers=2) as pool: result = list(pool.map(convert, range(2)))
    assert sorted(r.status_code for r in result) == [201,409], [r.text for r in result]
    with sessions() as db: assert len(list(db.scalars(select(Opportunity)))) == 1
    return


def test_opportunity_tasks_activity_and_stage_audit(env):
    client, sessions, (tenant, other_tenant, admin, sales), auth = env
    h = auth('admin@example.com', tenant)
    def post(path, key, body): return client.post('/api/v1/'+path, headers={**h,'Idempotency-Key':key}, json=body)
    company = post('companies','company',{'name':'Acme'}).json()
    opportunity = post('opportunities','opp',{'company_id':company['id'],'name':'Purchase'} )
    assert opportunity.status_code == 201, opportunity.text
    oid = opportunity.json()['id']
    assert post('opportunities','opp2',{'company_id':company['id'],'name':'Another'}).status_code == 201
    first = post('companies/'+company['id']+'/contacts','c1',{'name':'One','email':'one@example.com'}).json()
    second = post('companies/'+company['id']+'/contacts','c2',{'name':'Two','email':'two@example.com'}).json()
    for i,c in enumerate((first,second)):
        r=post('opportunities/'+oid+'/contacts','link'+str(i),{'contact_id':c['id'],'is_primary':True})
        assert r.status_code == 201, r.text
    assert post('opportunities/'+oid+'/contacts','duplicate-link',{'contact_id':first['id']}).status_code == 409
    stage=post('opportunities/'+oid+'/stage','stage',{'expected_version':1,'stage':'quoting'})
    assert stage.status_code == 200, stage.text
    assert post('opportunities/'+oid+'/close-lost','badlost',{'expected_version':2,'reason':''}).status_code == 422
    closed=post('opportunities/'+oid+'/close-won','won',{'expected_version':2})
    assert closed.status_code == 200 and closed.json()['closed_at']
    with sessions() as db:
        audit = list(db.scalars(select(AuditLog).where(AuditLog.action=='stage')))
        assert audit[0].changes['stage'] == {'old':'discovery','new':'quoting'}
    past = (datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
    task=post('follow-up-tasks','task',{'opportunity_id':oid,'title':'Call','due_at':past})
    assert task.status_code == 201, task.text
    tid=task.json()['id']
    assert any(x['id']==tid for x in client.get('/api/v1/follow-up-tasks/overdue',headers=h).json()['items'])
    activity=post('activities','activity',{'opportunity_id':oid,'follow_up_task_id':tid,'activity_type':'phone','summary':'Called','occurred_at':past})
    assert activity.status_code == 201, activity.text
    done=post('follow-up-tasks/'+tid+'/complete','done',{'expected_version':1})
    assert done.status_code == 200 and done.json()['completed_at']
    assert post('follow-up-tasks/'+tid+'/complete','again',{'expected_version':2}).status_code == 409


def test_cross_company_access_agent_and_versions(env):
    client, sessions, (tenant, other_tenant, admin, sales), auth = env
    h = auth('admin@example.com', tenant)
    def post(path, key, body): return client.post('/api/v1/'+path, headers={**h,'Idempotency-Key':key}, json=body)
    a = post('companies','a',{'name':'A'}).json()
    b = post('companies','b',{'name':'B'}).json()
    contact = post('companies/'+b['id']+'/contacts','contact',{'name':'Person','email':'p@example.org'}).json()
    opp = post('opportunities','op',{'company_id':a['id'],'name':'Opportunity'}).json()
    assert post('opportunities/'+opp['id']+'/contacts','wrong-company',{'contact_id':contact['id']}).status_code == 409
    seller = auth('sales@example.com', tenant)
    result = client.patch('/api/v1/opportunities/'+opp['id'], headers={**seller, 'Idempotency-Key':'agent', 'X-Operation-Source':'agent'}, json={'expected_version':1,'name':'Stolen'})
    assert result.status_code == 404
    assert client.get('/api/v1/opportunities/'+opp['id'], headers=auth('other@example.com',other_tenant)).status_code == 404
    r=client.patch('/api/v1/opportunities/'+opp['id'], headers={**h, 'Idempotency-Key':'update'}, json={'expected_version':1,'name':'Updated'})
    assert r.status_code == 200, r.text
    r=client.patch('/api/v1/opportunities/'+opp['id'], headers={**h, 'Idempotency-Key':'stale'}, json={'expected_version':1,'name':'Stale'})
    assert r.status_code == 409 and r.json()['error']['code'] == 'VERSION_CONFLICT'
    mixed=post('activities','mixed',{'company_id':a['id'],'contact_id':contact['id'],'activity_type':'note','summary':'wrong relation','occurred_at':datetime.now(timezone.utc).isoformat()})
    assert mixed.status_code == 409
    deleted=client.delete('/api/v1/companies/'+a['id']+'?expected_version=1', headers={**h,'Idempotency-Key':'delete'})
    assert deleted.status_code == 409


def test_evidence_database_constraints_and_original_quote(env):
    client, sessions, (tenant, other_tenant, admin, sales), auth = env
    h = auth('admin@example.com', tenant)
    payload = {'title':'Inquiry','source':'mail','evidence':[{'evidence_type':'quote','source_type':'email','source_id':'msg','source_snapshot_text':'A 报价 B','original_quote':' 报价 ','quote_start':1,'quote_end':5}]}
    created=client.post('/api/v1/leads',headers={**h,'Idempotency-Key':'lead-quote'},json=payload)
    assert created.status_code == 201, created.text
    ident = created.json()['id']
    recorded=client.get('/api/v1/leads/'+ident+'/evidence',headers=h).json()['items'][0]
    assert recorded['original_quote'] == ' 报价 '
    with pytest.raises(IntegrityError):
        with sessions.begin() as db:
            db.add(LeadEvidence(tenant_id=UUID(other_tenant), lead_id=UUID(ident), evidence_type='quote', source_type='email', original_quote='x', created_by=UUID(admin)))
            db.flush()
    with pytest.raises(IntegrityError):
        with sessions.begin() as db:
            db.add(LeadEvidence(tenant_id=UUID(tenant), lead_id=UUID(ident), evidence_type='quote', source_type='email', original_quote='x', quote_start=0, source_snapshot_text='x', created_by=UUID(admin)))
            db.flush()
    with pytest.raises(IntegrityError):
        with sessions.begin() as db:
            outsider = db.scalar(select(User).where(User.email == 'other@example.com'))
            db.add(LeadEvidence(tenant_id=UUID(tenant), lead_id=UUID(ident), evidence_type='quote', source_type='email', original_quote='x', created_by=outsider.id))
            db.flush()


def test_reminders_and_duplicate_completion(env):
    client, sessions, (tenant, other_tenant, admin, sales), auth = env
    h = auth('admin@example.com', tenant)
    company=client.post('/api/v1/companies',headers={**h,'Idempotency-Key':'company'},json={'name':'A'}).json()
    now=datetime.now(timezone.utc)
    payload={'company_id':company['id'],'title':'Future','due_at':(now+timedelta(days=1)).isoformat(),'remind_at':(now-timedelta(minutes=1)).isoformat()}
    task=client.post('/api/v1/follow-up-tasks',headers={**h,'Idempotency-Key':'task'},json=payload).json()
    reminders=client.get('/api/v1/follow-up-tasks/reminders',headers=h).json()['items']
    assert any(row['id']==task['id'] for row in reminders)
    assert not any(row['id']==task['id'] for row in client.get('/api/v1/follow-up-tasks/overdue',headers=h).json()['items'])
    req={'expected_version':1}
    headers={**h,'Idempotency-Key':'complete'}
    result=client.post('/api/v1/follow-up-tasks/'+task['id']+'/complete',headers=headers,json=req)
    repeat=client.post('/api/v1/follow-up-tasks/'+task['id']+'/complete',headers=headers,json=req)
    assert result.status_code == repeat.status_code == 200 and result.json()==repeat.json()


def test_activity_cannot_mix_task_lead_and_other_company(env):
    client, sessions, (tenant, other_tenant, admin, sales), auth = env
    h = auth('admin@example.com', tenant)
    def post(path, key, payload): return client.post('/api/v1/'+path,headers={**h,'Idempotency-Key':key},json=payload)
    a=post('companies','a',{'name':'A'}).json()
    b=post('companies','b',{'name':'B'}).json()
    lead=post('leads','lead',{'company_id':a['id'],'title':'Inquiry','source':'manual','evidence':[{'evidence_type':'manual','source_type':'manual','manual_note':'Met buyer'}]}).json()
    when=datetime.now(timezone.utc).isoformat()
    task=post('follow-up-tasks','task',{'lead_id':lead['id'],'title':'Call','due_at':when}).json()
    response=post('activities','activity',{'company_id':b['id'],'follow_up_task_id':task['id'],'activity_type':'note','summary':'Mismatch','occurred_at':when})
    assert response.status_code == 409
