from types import SimpleNamespace
from uuid import uuid4

import pytest

from app import sales_service, service
from app.models import AuditLog, OutboxEvent


class PendingTransaction:
    """Collect rows without committing, just like a caller-owned transaction."""
    def __init__(self):
        self.rows = []
        self.statements = []

    def add(self, row):
        self.rows.append(row)

    def execute(self, statement, *args):
        self.statements.append(statement)


@pytest.mark.parametrize(('record', 'stores_audit_changes'), [
    (service.audit, False),
    (sales_service.record, True),
])
def test_successful_change_adds_audit_and_sync_event_to_caller_transaction(record, stores_audit_changes):
    tenant_id, user_id, object_id = uuid4(), uuid4(), uuid4()
    principal = SimpleNamespace(membership=SimpleNamespace(tenant_id=tenant_id), user=SimpleNamespace(id=user_id))
    request = SimpleNamespace(state=SimpleNamespace(request_id='req-1'), headers={'X-Operation-Source': 'agent', 'X-Agent-Run-ID': 'r' * 120})
    obj = SimpleNamespace(__tablename__='companies', id=object_id, tenant_id=tenant_id, version=2)
    changes = {'industry': {'old': 'old', 'new': 'new'}}
    db = PendingTransaction()

    record(db, principal, request, 'update', obj, iter(['industry']), changes)

    assert len(db.rows) == 2
    audit, event = db.rows
    assert isinstance(audit, AuditLog) and isinstance(event, OutboxEvent)
    assert (audit.tenant_id, audit.actor_id, audit.object_id) == (tenant_id, user_id, object_id)
    assert audit.changed_fields == ['industry']
    assert audit.source == 'agent' and audit.agent_run_id == 'r' * 100
    assert audit.request_id == 'req-1'
    assert ('changes' in audit.__dict__) is stores_audit_changes
    assert audit.changes == (changes if stores_audit_changes else None)
    assert (event.tenant_id, event.entity, event.entity_id, event.version) == (tenant_id, 'companies', object_id, 2)
    assert event.changes == {'industry': 'new'}
    assert len(db.statements) == 1


@pytest.mark.parametrize('record', [service.audit, sales_service.record])
def test_unknown_source_defaults_to_human_without_agent_run(record):
    tenant_id = uuid4()
    principal = SimpleNamespace(membership=SimpleNamespace(tenant_id=tenant_id), user=SimpleNamespace(id=uuid4()))
    request = SimpleNamespace(state=SimpleNamespace(request_id='req-2'), headers={'X-Operation-Source': 'unknown'})
    obj = SimpleNamespace(__tablename__='leads', id=uuid4(), tenant_id=tenant_id, version=1)
    db = PendingTransaction()

    record(db, principal, request, 'create', obj, ['title'])

    assert db.rows[0].source == 'human'
    assert db.rows[0].agent_run_id is None
    assert db.rows[1].changes is None
