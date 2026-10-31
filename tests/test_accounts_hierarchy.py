from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import UUID
from sqlalchemy import select
from test_integration import env
from app import accounts
from app.models import Membership, User, LoginSession, Company
from app.security import passwords, token_hash


def test_session_renews_only_while_valid_and_never_after_logout(env):
    client, sessions, (tenant, _, _, _), auth = env
    headers = auth('admin@example.com', tenant)
    digest = token_hash(headers['Authorization'].split()[1])
    with sessions.begin() as db:
        db.get(LoginSession, digest).expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
    assert client.get('/api/v1/auth/me', headers=headers).status_code == 200
    with sessions() as db:
        assert db.get(LoginSession, digest).expires_at > datetime.now(timezone.utc) + timedelta(hours=11)
    assert client.post('/api/v1/auth/logout', headers=headers).status_code == 200
    assert client.get('/api/v1/auth/me', headers=headers).status_code == 401
    other = auth('admin@example.com', tenant)
    other_digest = token_hash(other['Authorization'].split()[1])
    with sessions.begin() as db:
        db.get(LoginSession, other_digest).expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    assert client.get('/api/v1/auth/me', headers=other).status_code == 401


def test_registration_approval_reset_and_password_change(env, monkeypatch):
    client, sessions, (tenant, _, admin, sales), auth = env
    codes=[]
    monkeypatch.setattr(accounts.settings, 'smtp_host', 'test')
    monkeypatch.setattr(accounts.settings, 'smtp_sender', 'test@example.com')
    monkeypatch.setattr(accounts, 'send_code', lambda email,code,purpose: codes.append((email,code,purpose)))
    accounts._attempts.clear()
    admin_headers=auth('admin@example.com',tenant)
    reg=client.post('/api/v1/auth/register',json={'email':'new@example.com','name':'New','tenant_id':tenant})
    assert reg.status_code == 200 and codes[-1][2]=='verify'
    code=codes[-1][1]
    with sessions() as db:
        pending_user=db.scalar(select(User).where(User.email=='new@example.com'))
        assert pending_user.verification_hash != code and code not in pending_user.password_hash
    assert client.post('/api/v1/auth/login',json={'email':'new@example.com','password':'newpassword123'}).status_code == 401
    members=client.get('/api/v1/members',headers=admin_headers).json()['items']
    new=next(x for x in members if x['email']=='new@example.com')
    fail=client.patch('/api/v1/members/'+new['id'],headers={**admin_headers,'Idempotency-Key':'early'},json={'status':'active'})
    assert fail.status_code == 409
    assert client.post('/api/v1/auth/register/verify',json={'code':code,'password':'newpassword123'}).status_code == 200
    assert client.post('/api/v1/auth/register/verify',json={'code':code,'password':'newpassword123'}).status_code == 400
    login=client.post('/api/v1/auth/login',json={'email':'new@example.com','password':'newpassword123'})
    new_headers={'Authorization':'Bearer '+login.json()['access_token'],'X-Tenant-ID':tenant}
    assert client.get('/api/v1/companies',headers=new_headers).status_code == 403
    ok=client.patch('/api/v1/members/'+new['id'],headers={**admin_headers,'Idempotency-Key':'approve'},json={'status':'active'})
    assert ok.status_code == 200
    assert client.get('/api/v1/companies',headers=new_headers).status_code == 200
    assert client.post('/api/v1/auth/password/reset-request',json={'email':'new@example.com'}).status_code == 200
    resetcode=codes[-1][1]
    assert client.post('/api/v1/auth/password/reset',json={'code':resetcode,'password':'changedpass123'}).status_code == 200
    assert client.post('/api/v1/auth/password/reset',json={'code':resetcode,'password':'changedpass123'}).status_code == 400
    assert client.get('/api/v1/companies',headers=new_headers).status_code == 401
    login=client.post('/api/v1/auth/login',json={'email':'new@example.com','password':'changedpass123'})
    hdr={'Authorization':'Bearer '+login.json()['access_token']}
    assert client.post('/api/v1/auth/password/change',headers=hdr,json={'current_password':'bad','new_password':'anotherpass123'}).status_code == 400
    assert client.post('/api/v1/auth/password/change',headers=hdr,json={'current_password':'changedpass123','new_password':'anotherpass123'}).status_code == 200
    assert client.get('/api/v1/auth/tenants',headers=hdr).status_code == 401
    assert client.post('/api/v1/auth/login',json={'email':'new@example.com','password':'anotherpass123'}).status_code == 200


def test_manager_scope_and_cycle_protection(env):
    client, sessions, (tenant, _, admin, sales), auth = env
    with sessions.begin() as db:
        manager=User(email='manager@example.com',name='Manager',password_hash=passwords.hash('password12345'))
        outsider=User(email='outside@example.com',name='Outside',password_hash=passwords.hash('password12345'))
        db.add_all([manager,outsider]);db.flush()
        db.add_all([Membership(tenant_id=UUID(tenant),user_id=manager.id,role='manager'),Membership(tenant_id=UUID(tenant),user_id=outsider.id,role='sales')]);db.flush()
        seller=db.scalar(select(Membership).where(Membership.tenant_id==UUID(tenant),Membership.user_id==UUID(sales)))
        seller.manager_id=manager.id
        applicant=User(email='applicant@example.com',name='Applicant',password_hash=passwords.hash('password12345'))
        db.add(applicant);db.flush()
        applicant_member=Membership(tenant_id=UUID(tenant),user_id=applicant.id,role='sales',status='pending',manager_id=manager.id)
        db.add(applicant_member);db.flush()
        applicant_id=applicant_member.id
        manager_id=manager.id; seller_member=seller.id
    manager_headers=auth('manager@example.com',tenant); admin_headers=auth('admin@example.com',tenant)
    items=client.get('/api/v1/members',headers=manager_headers).json()['items']
    assert {item['email'] for item in items} == {'manager@example.com','sales@example.com','applicant@example.com'}
    assert client.patch('/api/v1/members/'+str(applicant_id),headers={**manager_headers,'Idempotency-Key':'direct-approval'},json={'status':'active'}).status_code == 200
    admin_company=client.post('/api/v1/companies',headers={**admin_headers,'Idempotency-Key':'a-company'},json={'name':'Admin company'}).json()
    seller_headers=auth('sales@example.com',tenant)
    seller_company=client.post('/api/v1/companies',headers={**seller_headers,'Idempotency-Key':'s-company'},json={'name':'Seller company'}).json()
    assert client.get('/api/v1/companies/'+admin_company['id'],headers=manager_headers).status_code == 404
    assert client.get('/api/v1/companies/'+seller_company['id'],headers=manager_headers).status_code == 200
    assert client.patch('/api/v1/members/'+str(seller_member),headers={**manager_headers,'Idempotency-Key':'promote-admin'},json={'role':'admin'}).status_code == 403
    assert client.patch('/api/v1/members/'+str(seller_member),headers={**manager_headers,'Idempotency-Key':'promote-manager'},json={'role':'manager'}).status_code == 200
    with sessions.begin() as db:
        leaf=User(email='leaf@example.com',name='Leaf',password_hash=passwords.hash('password12345'))
        db.add(leaf);db.flush()
        db.add(Membership(tenant_id=UUID(tenant),user_id=leaf.id,role='sales',manager_id=UUID(sales)));db.flush()
        leaf_id=leaf.id
        db.add(Company(tenant_id=UUID(tenant),name='Leaf company',owner_id=leaf.id,updated_by=UUID(admin)))
    assert 'leaf@example.com' in {item['email'] for item in client.get('/api/v1/members',headers=manager_headers).json()['items']}
    with sessions() as db: manager_member=db.scalar(select(Membership).where(Membership.tenant_id==UUID(tenant),Membership.user_id==manager_id)).id
    assert client.patch('/api/v1/members/'+str(manager_member),headers={**admin_headers,'Idempotency-Key':'cycle'},json={'manager_id':sales}).status_code == 409
    assert any(x['name']=='Leaf company' for x in client.get('/api/v1/companies',headers=manager_headers).json()['items'])
    assert client.patch('/api/v1/members/'+str(seller_member),headers={**admin_headers,'Idempotency-Key':'detach'},json={'manager_id':None}).status_code == 200
    remaining=client.get('/api/v1/members',headers=manager_headers).json()['items']
    assert {x['email'] for x in remaining} == {'manager@example.com','applicant@example.com'}
    assert client.get('/api/v1/companies/'+seller_company['id'],headers=manager_headers).status_code == 404
    assert not any(x['name']=='Leaf company' for x in client.get('/api/v1/companies',headers=manager_headers).json()['items'])


def test_activity_concurrent_update_and_delete_require_version(env):
    client, sessions, (tenant, _, admin, sales), auth=env
    headers=auth('admin@example.com',tenant)
    company=client.post('/api/v1/companies',headers={**headers,'Idempotency-Key':'ac-company'},json={'name':'Activity Co'}).json()
    activity=client.post('/api/v1/activities',headers={**headers,'Idempotency-Key':'activity'},json={'company_id':company['id'],'activity_type':'note','summary':'Initial','occurred_at':datetime.now(timezone.utc).isoformat()}).json()
    assert activity['version'] == 1
    def patch(i): return client.patch('/api/v1/activities/'+activity['id'],headers={**headers,'Idempotency-Key':f'ac-{i}'},json={'expected_version':1,'summary':f'Changed {i}'})
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(patch,range(2)))
    assert sorted(r.status_code for r in results)==[200,409]
    assert next(r for r in results if r.status_code==409).json()['error']['code']=='VERSION_CONFLICT'
    assert client.delete('/api/v1/activities/'+activity['id'],headers={**headers,'Idempotency-Key':'missing-version'}).status_code == 422
    assert client.delete('/api/v1/activities/'+activity['id']+'?expected_version=1',headers={**headers,'Idempotency-Key':'stale-delete'}).status_code == 409
    assert client.delete('/api/v1/activities/'+activity['id']+'?expected_version=2',headers={**headers,'Idempotency-Key':'valid-delete'}).status_code == 200


def test_login_lockout_and_recovery_expiry(env, monkeypatch):
    client, sessions, (tenant, _, admin, sales), auth = env
    accounts._attempts.clear(); codes=[]
    monkeypatch.setattr(accounts.settings,'smtp_host','test');monkeypatch.setattr(accounts.settings,'smtp_sender','test@example.com')
    monkeypatch.setattr(accounts,'send_code',lambda email,code,purpose:codes.append(code))
    for _ in range(5): assert client.post('/api/v1/auth/login',json={'email':'sales@example.com','password':'wrong'}).status_code == 401
    assert client.post('/api/v1/auth/login',json={'email':'sales@example.com','password':'password12345'}).status_code == 401
    assert client.post('/api/v1/auth/password/reset-request',json={'email':'sales@example.com'}).status_code == 200
    code=codes[-1]
    with sessions.begin() as db:
        user=db.scalar(select(User).where(User.email=='sales@example.com'))
        assert user.reset_hash != code
        user.reset_expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)
    assert client.post('/api/v1/auth/password/reset',json={'code':code,'password':'newpassword123'}).status_code == 400
    assert client.post('/api/v1/auth/password/reset-request',json={'email':'sales@example.com'}).status_code == 200
    assert client.post('/api/v1/auth/password/reset',json={'code':codes[-1],'password':'newpassword123'}).status_code == 200
    assert client.post('/api/v1/auth/login',json={'email':'sales@example.com','password':'newpassword123'}).status_code == 200


def test_email_delivery_failure_does_not_leave_unusable_registration(env, monkeypatch):
    client, sessions, (tenant, _, admin, sales), auth=env
    accounts._attempts.clear()
    monkeypatch.setattr(accounts.settings,'smtp_host','test');monkeypatch.setattr(accounts.settings,'smtp_sender','test@example.com')
    def fail(*args): raise OSError('delivery failed')
    monkeypatch.setattr(accounts,'send_code',fail)
    result=client.post('/api/v1/auth/register',json={'email':'failed@example.com','name':'Failed','tenant_id':tenant})
    assert result.status_code == 200
    with sessions() as db: assert not db.scalar(select(User).where(User.email=='failed@example.com'))
