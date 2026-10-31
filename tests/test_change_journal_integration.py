from uuid import UUID

from sqlalchemy import select
from test_integration import env

from app.models import AuditLog, OutboxEvent


def test_customer_and_sales_journals_keep_their_distinct_change_values(env):
    client, sessions, (tenant, _, _, _), auth = env
    headers = {**auth('admin@example.com', tenant), 'X-Operation-Source': 'agent', 'X-Agent-Run-ID': 'run-1'}

    company = client.post('/api/v1/companies', headers={**headers, 'Idempotency-Key': 'journal-company'}, json={'name': 'Journal buyer'}).json()
    company_id = company['id']
    updated = client.patch('/api/v1/companies/' + company_id, headers={**headers, 'Idempotency-Key': 'journal-update'}, json={'expected_version': 1, 'industry': 'Manufacturing'})
    assert updated.status_code == 200, updated.text
    opportunity = client.post('/api/v1/opportunities', headers={**headers, 'Idempotency-Key': 'journal-opportunity'}, json={'company_id': company_id, 'name': 'Journal deal'})
    assert opportunity.status_code == 201, opportunity.text
    opportunity_id = opportunity.json()['id']
    staged = client.post('/api/v1/opportunities/' + opportunity_id + '/stage', headers={**headers, 'Idempotency-Key': 'journal-stage'}, json={'expected_version': 1, 'stage': 'quoting'})
    assert staged.status_code == 200, staged.text

    with sessions() as db:
        customer_audit = db.scalar(select(AuditLog).where(AuditLog.object_id == UUID(company_id), AuditLog.action == 'update'))
        customer_event = db.scalar(select(OutboxEvent).where(OutboxEvent.entity_id == UUID(company_id), OutboxEvent.action == 'update'))
        sales_audit = db.scalar(select(AuditLog).where(AuditLog.object_id == UUID(opportunity_id), AuditLog.action == 'stage'))
        sales_event = db.scalar(select(OutboxEvent).where(OutboxEvent.entity_id == UUID(opportunity_id), OutboxEvent.action == 'stage'))
        assert customer_audit.changes is None
        assert customer_event.changes == {'industry': 'Manufacturing'}
        assert sales_audit.changes['stage'] == {'old': 'discovery', 'new': 'quoting'}
        assert sales_event.changes == {'stage': 'quoting'}
        assert customer_audit.source == sales_audit.source == 'agent'
        assert customer_audit.agent_run_id == sales_audit.agent_run_id == 'run-1'
