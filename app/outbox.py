"""Durable, transaction-scoped change events; no credentials are recorded."""
from fastapi.encoders import jsonable_encoder
from sqlalchemy import text
from app.models import OutboxEvent


def emit(db, obj, action, changes=None):
    # Serialize event allocation until commit, so a polling cursor cannot pass
    # a lower ID belonging to a transaction that has not committed yet.
    db.execute(text('SELECT pg_advisory_xact_lock(738240627195)'))
    safe_changes = None
    if changes:
        safe_changes = {key: item.get('new') for key, item in changes.items() if isinstance(item, dict) and 'new' in item}
    db.add(OutboxEvent(tenant_id=obj.tenant_id, entity=obj.__tablename__, entity_id=obj.id, action=action, version=getattr(obj, 'version', None), changes=jsonable_encoder(safe_changes) if safe_changes else None))
