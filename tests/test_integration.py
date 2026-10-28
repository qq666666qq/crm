"""PostgreSQL integration tests. TEST_DATABASE_URL must point to a disposable database."""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
import pytest

pytestmark = pytest.mark.skipif(not os.getenv('TEST_DATABASE_URL'), reason='TEST_DATABASE_URL is not configured')
os.environ.setdefault('DATABASE_URL', os.getenv('TEST_DATABASE_URL', 'postgresql+psycopg://crm:crm@localhost/crm'))

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.exc import IntegrityError
from app.database import Base, get_db
from app.main import app
from app.models import Tenant, User, Membership, Company, Contact, AuditLog
from app.security import passwords


@pytest.fixture
def env():
    url = os.environ['TEST_DATABASE_URL']
    schema = 'test_' + uuid.uuid4().hex
    admin_engine = create_engine(url)
    with admin_engine.begin() as conn: conn.execute(text(f'CREATE SCHEMA {schema}'))
    engine = create_engine(url, connect_args={'options': f'-csearch_path={schema}'}, pool_size=10)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    def db_override():
        with sessions() as db: yield db
    app.dependency_overrides[get_db] = db_override
    with sessions.begin() as db:
        a, b = Tenant(name='A'), Tenant(name='B')
        admin = User(email='admin@example.com', name='Admin', password_hash=passwords.hash('password12345'))
        sales = User(email='sales@example.com', name='Sales', password_hash=passwords.hash('password12345'))
        outsider = User(email='other@example.com', name='Other', password_hash=passwords.hash('password12345'))
        db.add_all([a, b, admin, sales, outsider]); db.flush()
        db.add_all([Membership(tenant_id=a.id, user_id=admin.id, role='admin'), Membership(tenant_id=a.id, user_id=sales.id, role='sales'), Membership(tenant_id=b.id, user_id=outsider.id, role='admin')])
        ids = (str(a.id), str(b.id), str(admin.id), str(sales.id))
    with TestClient(app) as client:
        def headers(email, tenant):
            token = client.post('/api/v1/auth/login', json={'email': email, 'password': 'password12345'}).json()['access_token']
            return {'Authorization': 'Bearer ' + token, 'X-Tenant-ID': tenant}
        yield client, sessions, ids, headers
    app.dependency_overrides.clear()
    engine.dispose()
    with admin_engine.begin() as conn: conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
    admin_engine.dispose()


def test_isolation_idempotency_and_versions(env):
    client, sessions, (a, b, admin, sales), auth = env
    h = auth('admin@example.com', a)
    h['Idempotency-Key'] = 'create-a'
    body = {'name': 'Example', 'website': 'https://example.com'}
    r = client.post('/api/v1/companies', json=body, headers=h)
    assert r.status_code == 201, r.text
    obj = r.json(); ident = obj['id']
    assert client.post('/api/v1/companies', json=body, headers=h).json()['id'] == ident
    assert client.post('/api/v1/companies', json={'name': 'Different'}, headers=h).status_code == 409
    other = auth('other@example.com', b)
    assert client.get('/api/v1/companies/' + ident, headers=other).status_code == 404
    seller = auth('sales@example.com', a)
    assert client.get('/api/v1/companies/' + ident, headers=seller).status_code == 404
    seller['Idempotency-Key'] = 'forged'
    assert client.post('/api/v1/companies', headers=seller, json={'name': 'X', 'tenant_id': b}).status_code == 422
    h['Idempotency-Key'] = 'update'
    assert client.patch('/api/v1/companies/' + ident, headers=h, json={'expected_version': 1, 'name': 'Changed'}).status_code == 200
    h['Idempotency-Key'] = 'stale'
    assert client.patch('/api/v1/companies/' + ident, headers=h, json={'expected_version': 1, 'name': 'Lost'}).json()['error']['code'] == 'VERSION_CONFLICT'
    with sessions() as db: assert db.scalar(select(Company).where(Company.id == uuid.UUID(ident))).name == 'Changed'


def test_concurrent_duplicate_and_contact_delete_guard(env):
    client, sessions, (a, b, admin, sales), auth = env
    h = auth('admin@example.com', a)
    def create(i): return client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'parallel-' + str(i)}, json={'name': 'A', 'website': 'https://example.org'})
    with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(create, range(2)))
    assert sorted(r.status_code for r in results) == [201, 409]
    ident = next(r.json()['id'] for r in results if r.status_code == 201)
    contact = client.post(f'/api/v1/companies/{ident}/contacts', headers={**h, 'Idempotency-Key': 'contact'}, json={'name': 'Jane', 'email': 'jane@example.org'})
    assert contact.status_code == 201
    deleted = client.delete(f'/api/v1/companies/{ident}?expected_version=1', headers={**h, 'Idempotency-Key': 'delete-company'})
    assert deleted.status_code == 409
    with sessions() as db:
        assert len(list(db.scalars(select(Company)))) == 1
        assert len(list(db.scalars(select(Contact)))) == 1
        logs = list(db.scalars(select(AuditLog)))
        assert sum(log.result == 'success' for log in logs) == 2
        assert any(log.result == 'DUPLICATE_DETECTED' for log in logs)
        assert any(log.result == 'VALIDATION_ERROR' for log in logs)


def test_concurrent_updates_soft_delete_and_database_constraint(env):
    client, sessions, (a, b, admin, sales), auth = env
    h = auth('admin@example.com', a)
    created = client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'new'}, json={'name': 'New'})
    assert created.status_code == 201
    ident = created.json()['id']
    def edit(i):
        return client.patch('/api/v1/companies/' + ident, headers={**h, 'Idempotency-Key': f'edit-{i}'}, json={'expected_version': 1, 'name': f'Name {i}'})
    with ThreadPoolExecutor(max_workers=2) as pool: responses = list(pool.map(edit, range(2)))
    assert sorted(r.status_code for r in responses) == [200, 409]
    with pytest.raises(IntegrityError):
        with sessions.begin() as db:
            db.add(Contact(tenant_id=uuid.UUID(b), company_id=uuid.UUID(ident), name='Wrong tenant', email='x@example.com', updated_by=uuid.UUID(admin)))
            db.flush()
    with sessions() as db:
        assert db.scalar(select(Contact).where(Contact.company_id == uuid.UUID(ident))) is None
    deleted = client.delete(f'/api/v1/companies/{ident}?expected_version=2', headers={**h, 'Idempotency-Key': 'deleted'})
    assert deleted.status_code == 200
    assert client.get('/api/v1/companies/' + ident, headers=h).status_code == 404
    assert client.delete(f'/api/v1/companies/{ident}?expected_version=2', headers={**h, 'Idempotency-Key': 'deleted'}).status_code == 200


def test_revocation_and_inactive_membership(env):
    client, sessions, (a, b, admin, sales), auth = env
    h = auth('sales@example.com', a)
    assert client.get('/api/v1/auth/me', headers=h).status_code == 200
    with sessions.begin() as db:
        membership = db.scalar(select(Membership).where(Membership.user_id == uuid.UUID(sales)))
        membership.status = 'inactive'
    assert client.get('/api/v1/companies', headers=h).status_code == 403
    with sessions.begin() as db:
        membership = db.scalar(select(Membership).where(Membership.user_id == uuid.UUID(sales)))
        membership.status = 'active'
    assert client.post('/api/v1/auth/logout', headers=h).status_code == 200
    assert client.get('/api/v1/companies', headers=h).status_code == 401


def test_audit_failure_rolls_back_create(env, monkeypatch):
    from app import service
    client, sessions, (a, b, admin, sales), auth = env
    h = auth('admin@example.com', a)
    def fail(*args, **kwargs): raise RuntimeError('simulated audit failure')
    monkeypatch.setattr(service, 'audit', fail)
    with pytest.raises(RuntimeError):
        client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'rollback'}, json={'name': 'Rollback'})
    with sessions() as db: assert db.scalar(select(Company).where(Company.name == 'Rollback')) is None


def test_member_admin_and_agent_boundaries(env):
    client, sessions, (a, b, admin, sales), auth = env
    h = auth('admin@example.com', a)
    sh = auth('sales@example.com', a)
    payload = {'email': 'new@example.com', 'name': 'New', 'password': 'a-secure-password', 'role': 'sales'}
    assert client.post('/api/v1/members', headers={**sh, 'Idempotency-Key': 'bad', 'X-Operation-Source': 'agent'}, json=payload).status_code == 403
    created = client.post('/api/v1/members', headers={**h, 'Idempotency-Key': 'new-member'}, json=payload)
    assert created.status_code == 201, created.text
    assert 'password' not in str(created.json())
    assert client.post('/api/v1/members', headers={**h, 'Idempotency-Key': 'new-member'}, json=payload).json() == created.json()
    listed = client.get('/api/v1/members', headers=h).json()['items']
    admin_id = next(x['id'] for x in listed if x['user_id'] == admin)
    blocked = client.patch('/api/v1/members/' + admin_id, headers={**h, 'Idempotency-Key': 'last-admin'}, json={'status': 'inactive'})
    assert blocked.status_code == 409
    disabled = client.patch('/api/v1/members/' + created.json()['id'], headers={**h, 'Idempotency-Key': 'disable'}, json={'status': 'inactive'})
    assert disabled.status_code == 200
    token = client.post('/api/v1/auth/login', json={'email': 'new@example.com', 'password': 'a-secure-password'}).json()['access_token']
    new = {'Authorization': 'Bearer ' + token, 'X-Tenant-ID': a}
    assert client.get('/api/v1/companies', headers=new).status_code == 403
    with sessions() as db:
        logs = list(db.scalars(select(AuditLog).where(AuditLog.action == 'post', AuditLog.result == 'FORBIDDEN')))
        assert logs and logs[0].source == 'agent'
    other = auth('other@example.com', b)
    attached = client.post('/api/v1/members/attach', headers={**other, 'Idempotency-Key': 'attach'}, json={'user_id': sales, 'role': 'sales'})
    assert attached.status_code == 201
    assert client.get('/api/v1/companies', headers={**sh, 'X-Tenant-ID': b}).status_code == 200
    assert client.patch('/api/v1/members/' + created.json()['id'], headers={**other, 'Idempotency-Key': 'cross'}, json={'status': 'active'}).status_code == 404


def test_contact_duplicate_concurrency_and_restore(env):
    client, sessions, (a, b, admin, sales), auth = env
    h = auth('admin@example.com', a)
    company = client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'company'}, json={'name': 'A'}).json()
    path = '/api/v1/companies/' + company['id'] + '/contacts'
    def create(i):
        return client.post(path, headers={**h, 'Idempotency-Key': f'contact-{i}'}, json={'name': f'Person {i}', 'email': 'IDENTITY@example.com'})
    with ThreadPoolExecutor(max_workers=2) as pool: result = list(pool.map(create, range(2)))
    assert sorted(r.status_code for r in result) == [201, 409]
    contact = next(r.json() for r in result if r.status_code == 201)
    deleted = client.delete('/api/v1/contacts/' + contact['id'] + '?expected_version=1', headers={**h, 'Idempotency-Key': 'delete'})
    assert deleted.status_code == 200
    replacement = create(3)
    assert replacement.status_code == 201
    restore = client.post('/api/v1/contacts/' + contact['id'] + '/restore', headers={**h, 'Idempotency-Key': 'restore'}, json={'expected_version': 2})
    assert restore.status_code == 409
    assert restore.json()['error']['code'] == 'DUPLICATE_DETECTED'
    client.delete('/api/v1/contacts/' + replacement.json()['id'] + '?expected_version=1', headers={**h, 'Idempotency-Key': 'delete-replacement'})
    restored = client.post('/api/v1/contacts/' + contact['id'] + '/restore', headers={**h, 'Idempotency-Key': 'restore-again'}, json={'expected_version': 2})
    assert restored.status_code == 200
    assert restored.json()['version'] == 3


def test_contact_write_rolls_back_and_possible_company_match(env, monkeypatch):
    from app import service
    client, sessions, (a, b, admin, sales), auth = env
    h = auth('admin@example.com', a)
    body = {'name': 'Same name', 'country': 'France'}
    first = client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'one'}, json=body)
    second = client.post('/api/v1/companies', headers={**h, 'Idempotency-Key': 'two'}, json=body)
    assert first.status_code == second.status_code == 201
    matches = client.get('/api/v1/companies/duplicates', headers=h, params=body).json()
    assert matches['classification'] == 'possible_duplicate' and len(matches['items']) == 2
    def fail(*args, **kwargs): raise RuntimeError('audit failure')
    monkeypatch.setattr(service, 'audit', fail)
    with pytest.raises(RuntimeError):
        client.post('/api/v1/companies/' + first.json()['id'] + '/contacts', headers={**h, 'Idempotency-Key': 'rollback-contact'}, json={'name': 'Jane', 'email': 'jane@example.com'})
    with sessions() as db: assert list(db.scalars(select(Contact))) == []


def test_same_idempotency_key_concurrent(env):
    client, sessions, (a, b, admin, sales), auth = env
    h = {**auth('admin@example.com', a), 'Idempotency-Key': 'same-key'}
    def create(_): return client.post('/api/v1/companies', headers=h, json={'name': 'Once'})
    with ThreadPoolExecutor(max_workers=2) as pool: responses = list(pool.map(create, range(2)))
    assert [r.status_code for r in responses] == [201, 201]
    assert responses[0].json()['id'] == responses[1].json()['id']
    with sessions() as db: assert len(list(db.scalars(select(Company)))) == 1
