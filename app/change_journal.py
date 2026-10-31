"""Record a successful change and its sync event in the caller's transaction."""
from fastapi.encoders import jsonable_encoder
from app.models import AuditLog
from app.outbox import emit


def _record(db, principal, request, action, obj, fields, changes, *, include_audit_changes):
    source = request.headers.get('X-Operation-Source')
    values = {
        'tenant_id': principal.membership.tenant_id,
        'actor_id': principal.user.id,
        'action': action,
        'object_type': obj.__tablename__,
        'object_id': obj.id,
        'changed_fields': list(fields),
        'request_id': request.state.request_id,
        'source': source if source in ('human', 'agent') else 'human',
        'agent_run_id': (request.headers.get('X-Agent-Run-ID') or '')[:100] or None,
    }
    # Customer/member audits historically omit values; sales audits include them.
    if include_audit_changes:
        values['changes'] = jsonable_encoder(changes) if changes else None
    db.add(AuditLog(**values))
    emit(db, obj, action, changes)


def record_customer_change(db, principal, request, action, obj, fields, changes=None):
    _record(db, principal, request, action, obj, fields, changes, include_audit_changes=False)


def record_sales_change(db, principal, request, action, obj, fields, changes=None):
    _record(db, principal, request, action, obj, fields, changes, include_audit_changes=True)
