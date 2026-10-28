from test_integration import env
from uuid import UUID
from app.models import Company, Contact, Membership, User
from app.phase2_models import Opportunity
from app.security import passwords


def test_paged_search_and_owner_names_respect_permissions(env):
    client, sessions, (tenant, other_tenant, admin, sales), auth = env
    with sessions.begin() as db:
        manager = User(email='manager@example.com', name='Manager', password_hash=passwords.hash('password12345'))
        db.add(manager); db.flush()
        db.add(Membership(tenant_id=UUID(tenant), user_id=manager.id, role='manager')); db.flush()
        company = Company(tenant_id=UUID(tenant), name='Target Company', owner_id=manager.id, updated_by=UUID(admin))
        private = Company(tenant_id=UUID(tenant), name='Private Company', owner_id=UUID(sales), updated_by=UUID(sales))
        db.add_all([company, private]); db.flush()
        company_id = company.id
        db.add(Contact(tenant_id=UUID(tenant), company_id=company_id, name='Alice Match', email='alice@example.com', updated_by=UUID(admin)))
        for i in range(45):
            db.add(Opportunity(tenant_id=UUID(tenant), company_id=company_id, name=f'Match {i:02}', stage='discovery' if i < 35 else 'quoting', owner_id=manager.id, created_by=UUID(admin)))
    manager_headers = auth('manager@example.com', tenant)
    seller_headers = auth('sales@example.com', tenant)
    assert client.get('/api/v1/members', headers=manager_headers).status_code == 200
    results = client.get('/api/v1/companies?q=Target', headers=manager_headers).json()['items']
    assert len(results) == 1 and results[0]['owner_name'] == 'Manager'
    assert 'email' not in results[0] and 'password_hash' not in results[0]
    assert client.get(f'/api/v1/companies/{company_id}', headers=seller_headers).status_code == 404
    assert client.get('/api/v1/companies?q=Target', headers=seller_headers).json()['items'] == []
    assert client.get(f'/api/v1/companies/{company_id}/contacts?q=Alice', headers=manager_headers).json()['items'][0]['name'] == 'Alice Match'
    assert client.get(f'/api/v1/companies/{company_id}/contacts?q=Alice', headers=seller_headers).status_code == 404
    first = client.get('/api/v1/opportunities?limit=20&offset=0&stage=discovery&q=Match', headers=manager_headers).json()['items']
    second = client.get('/api/v1/opportunities?limit=20&offset=20&stage=discovery&q=Match', headers=manager_headers).json()['items']
    assert len(first) == 20 and len(second) == 15
    assert not {x['id'] for x in first} & {x['id'] for x in second}
    assert all(x['owner_name'] == 'Manager' for x in first + second)
    assert len(client.get('/api/v1/opportunities?limit=100&states=discovery,quoting', headers=manager_headers).json()['items']) == 45
    moved = first[0]
    transition = client.post(f'/api/v1/opportunities/{moved["id"]}/stage', headers={**manager_headers, 'Idempotency-Key':'move-page'}, json={'expected_version':moved['version'], 'stage':'quoting'})
    assert transition.status_code == 200
    refreshed = []
    for offset in (0, 20):
        refreshed.extend(client.get(f'/api/v1/opportunities?limit=20&offset={offset}&stage=discovery&q=Match', headers=manager_headers).json()['items'])
    assert len(refreshed) == 34 and len({x['id'] for x in refreshed}) == 34
    assert moved['id'] not in {x['id'] for x in refreshed}
    quoting = client.get('/api/v1/opportunities?limit=20&stage=quoting', headers=manager_headers).json()['items']
    assert moved['id'] in {x['id'] for x in quoting}
    assert client.get('/api/v1/opportunities?q=Match', headers=seller_headers).json()['items'] == []
    other = auth('other@example.com', other_tenant)
    assert client.get('/api/v1/opportunities?q=Match', headers=other).json()['items'] == []
    assert client.get('/api/v1/companies?q=Target', headers=other).json()['items'] == []
