from sqlalchemy import select
from test_integration import env
from app.models import AuditLog


def test_agent_writes_obey_idempotency_scope_and_versions(env):
    client, sessions, (tenant, other_tenant, _, _), auth = env
    admin = {**auth('admin@example.com', tenant), 'X-Operation-Source': 'agent'}
    def post(path, key, body):
        return client.post(path, headers={**admin, 'Idempotency-Key': key}, json=body)

    company_body = {'name': 'Agent integration buyer'}
    company = post('/api/v1/companies', 'agent-company', company_body)
    assert company.status_code == 201, company.text
    company_id = company.json()['id']
    assert post('/api/v1/companies', 'agent-company', company_body).json()['id'] == company_id
    assert post('/api/v1/companies', 'agent-company', {'name': 'different'}).status_code == 409

    contact_body = {'name': 'Buyer', 'email': 'buyer@example.com'}
    contact_path = f'/api/v1/companies/{company_id}/contacts'
    contact = post(contact_path, 'agent-contact', contact_body)
    assert contact.status_code == 201, contact.text
    assert post(contact_path, 'agent-contact', contact_body).json()['id'] == contact.json()['id']

    opportunity_body = {'company_id': company_id, 'name': 'Sample order'}
    opportunity = post('/api/v1/opportunities', 'agent-opportunity', opportunity_body)
    assert opportunity.status_code == 201, opportunity.text
    assert post('/api/v1/opportunities', 'agent-opportunity', opportunity_body).json()['id'] == opportunity.json()['id']

    task_body = {'company_id': company_id, 'title': 'Follow up', 'due_at': '2026-10-29T08:00:00Z'}
    task = post('/api/v1/follow-up-tasks', 'agent-task', task_body)
    assert task.status_code == 201, task.text
    assert post('/api/v1/follow-up-tasks', 'agent-task', task_body).json()['id'] == task.json()['id']

    activity_body = {'company_id': company_id, 'activity_type': 'phone', 'summary': 'Discussed samples', 'occurred_at': '2026-10-29T08:00:00Z'}
    activity = post('/api/v1/activities', 'agent-activity', activity_body)
    assert activity.status_code == 201, activity.text
    assert post('/api/v1/activities', 'agent-activity', activity_body).json()['id'] == activity.json()['id']

    other = {**auth('other@example.com', other_tenant), 'X-Operation-Source': 'agent', 'Idempotency-Key': 'other-activity'}
    assert client.post('/api/v1/activities', headers=other, json=activity_body).status_code in (403, 404)
    seller = {**auth('sales@example.com', tenant), 'X-Operation-Source': 'agent', 'Idempotency-Key': 'seller-company'}
    assert client.patch('/api/v1/companies/' + company_id, headers=seller, json={'expected_version': 1, 'name': 'Unauthorized'}).status_code in (403, 404)
    update = client.patch('/api/v1/companies/' + company_id, headers={**admin, 'Idempotency-Key': 'agent-update'}, json={'expected_version': 1, 'industry': 'Manufacturing'})
    assert update.status_code == 200, update.text
    stale = client.patch('/api/v1/companies/' + company_id, headers={**admin, 'Idempotency-Key': 'agent-stale'}, json={'expected_version': 1, 'industry': 'Trade'})
    assert stale.status_code == 409 and stale.json()['error']['code'] == 'VERSION_CONFLICT'
    with sessions() as db:
        assert any(log.source == 'agent' for log in db.scalars(select(AuditLog)))
