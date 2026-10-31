"""Authenticated outbox polling and SSE delivery."""
import asyncio
import json
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, delete, tuple_
from sqlalchemy.orm import Session, sessionmaker
from app.database import get_db, SessionLocal, engine
from app.errors import error
from app.models import Company, Contact, LoginSession, Membership, OutboxEvent, Tenant, User
from app.security import Principal, principal, bearer, token_hash
from app import access
from app import sales_access
from fastapi.security import HTTPAuthorizationCredentials
from uuid import UUID
from app.phase2_models import Lead, Opportunity, FollowUpTask, Activity

router = APIRouter(prefix='/api/v1/sync', tags=['sync'])
MODELS = {'companies': Company, 'contacts': Contact, 'leads': Lead, 'opportunities': Opportunity, 'follow_up_tasks': FollowUpTask, 'activities': Activity}
PATCHABLE = {'companies': {'industry', 'country', 'company_type', 'company_size', 'relationship_status'}, 'opportunities': {'product_summary', 'requirement_notes', 'stage'}, 'leads': {'title', 'intent_level', 'product_interest'}, 'follow_up_tasks': {'title', 'priority', 'status', 'due_at'}}


def allowed_object(db, p, event):
    model = MODELS.get(event.entity)
    if model is None: return None
    try:
        if model is Company: return access.get_company(db, p, event.entity_id)
        if model is Contact: return access.get_contact(db, p, event.entity_id)
        return sales_access.get(db, p, model, event.entity_id)
    except Exception as exc:
        if getattr(exc, 'status_code', None) in (403, 404): return None
        raise


def changes(db, p, cursor):
    latest = db.scalar(select(func.coalesce(func.max(OutboxEvent.id), 0)))
    oldest = db.scalar(select(func.min(OutboxEvent.id)))
    if cursor is None or cursor > latest or (oldest is not None and cursor < oldest - 1):
        return {'events': [{'action': 'reset'}], 'cursor': latest, 'reset': True}
    rows = list(db.scalars(select(OutboxEvent).where(OutboxEvent.id > cursor, OutboxEvent.tenant_id == p.membership.tenant_id).order_by(OutboxEvent.id).limit(200)))
    output = []
    for event in rows:
        if event.entity == 'tenant_memberships' or event.action == 'delete' or (event.changes and set(event.changes) & {'owner_id', 'assigned_to', 'company_id', 'contact_id', 'lead_id', 'opportunity_id', 'follow_up_task_id'}):
            output.append({'action': 'reset'})
            continue
        if event.entity not in MODELS:
            output.append({'action': 'resync'})
            continue
        obj = allowed_object(db, p, event)
        if obj is None: continue
        item = {'action': 'invalidate', 'entity': event.entity, 'entity_id': str(event.entity_id), 'version': event.version}
        # Never replay historical field values after a permission change.
        safe = PATCHABLE.get(event.entity, set())
        if event.version and getattr(obj, 'version', None) == event.version and event.changes and set(event.changes) <= safe and event.action not in ('create', 'delete', 'restore'):
            item.update(action='updated', base_version=event.version - 1, changes=event.changes)
        output.append(item)
    # When the batch is exhausted, advance across events belonging to other tenants.
    next_cursor = rows[-1].id if len(rows) == 200 else latest
    return {'events': output, 'cursor': next_cursor, 'reset': False}


@router.get('/changes')
def poll_changes(cursor: int | None = None, p=Depends(principal), db: Session = Depends(get_db)):
    if cursor is not None and cursor < 0: raise error(422, 'VALIDATION_ERROR', 'Invalid cursor')
    return changes(db, p, cursor)


def revalidate(db, user_id, tenant_id, digest):
    session = db.get(LoginSession, digest)
    user = db.get(User, user_id)
    member = db.scalar(select(Membership).join(Tenant, Tenant.id == Membership.tenant_id).where(Membership.user_id == user_id, Membership.tenant_id == tenant_id, Membership.status == 'active', Tenant.status == 'active'))
    if not session or session.user_id != user_id or session.revoked_at or session.expires_at <= datetime.now(timezone.utc) or not user or user.status != 'active' or not member or member.role not in ('admin', 'manager', 'sales'):
        return None
    return Principal(user, member, session)


def stream_identity(tenant: str | None = Header(default=None, alias='X-Tenant-ID'), credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    # Authenticate in one bounded database session; a streaming response must not
    # retain a connection while waiting for its next event.
    if not credentials: raise error(401, 'UNAUTHORIZED', 'Authentication required')
    try: tenant_id = UUID(tenant or '')
    except ValueError: raise error(403, 'FORBIDDEN', 'A valid tenant selection is required')
    digest = token_hash(credentials.credentials)
    with SessionLocal() as db:
        session = db.get(LoginSession, digest)
        if not session or session.revoked_at or session.expires_at <= datetime.now(timezone.utc): raise error(401, 'UNAUTHORIZED', 'Session invalid or expired')
        user = db.get(User, session.user_id)
        if not user or user.status != 'active': raise error(401, 'UNAUTHORIZED', 'User disabled')
        current = revalidate(db, user.id, tenant_id, digest)
        if current is None: raise error(403, 'FORBIDDEN', 'Tenant access denied')
        return (user.id, tenant_id, digest)


class StreamMonitor:
    """One bounded status and outbox check per process, shared by its streams."""
    def __init__(self):
        self.subscribers = {}
        self.signal = asyncio.Event()
        self.task = None
        self.state = {}
        self.scanned = set()
        self.bounds = None
        self.failed = False

    def add(self, identity):
        self.subscribers[identity] = self.subscribers.get(identity, 0) + 1
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.run())

    def remove(self, identity):
        count = self.subscribers.get(identity, 0)
        if count <= 1: self.subscribers.pop(identity, None)
        else: self.subscribers[identity] = count - 1

    @staticmethod
    def snapshot(identities):
        state = {}
        with SessionLocal() as db:
            now = datetime.now(timezone.utc)
            pairs = [(digest, tenant_id) for _, tenant_id, digest in identities]
            # PostgreSQL parameter limits and very large tenants are handled in batches.
            for start in range(0, len(pairs), 500):
                rows = db.execute(select(LoginSession.token_hash, LoginSession.user_id, Membership.tenant_id, Membership.role)
                    .join(User, User.id == LoginSession.user_id)
                    .join(Membership, Membership.user_id == User.id)
                    .join(Tenant, Tenant.id == Membership.tenant_id)
                    .where(tuple_(LoginSession.token_hash, Membership.tenant_id).in_(pairs[start:start + 500]),
                           LoginSession.revoked_at.is_(None), LoginSession.expires_at > now,
                           User.status == 'active', Membership.status == 'active', Tenant.status == 'active',
                           Membership.role.in_(['admin', 'manager', 'sales'])))
                for digest, user_id, tenant_id, role in rows:
                    state[(user_id, tenant_id, digest)] = role
            latest = db.scalar(select(func.coalesce(func.max(OutboxEvent.id), 0)))
            oldest = db.scalar(select(func.min(OutboxEvent.id)))
            return state, (oldest, latest)

    async def run(self):
        try:
            while self.subscribers:
                identities = list(self.subscribers)
                try:
                    state, bounds = await asyncio.to_thread(self.snapshot, identities)
                    self.state, self.scanned, self.bounds, self.failed = state, set(identities), bounds, False
                except Exception:
                    # A stale authorization snapshot must never permit event delivery.
                    self.state, self.failed = {}, True
                previous = self.signal
                self.signal = asyncio.Event()
                previous.set()
                await asyncio.sleep(1.5)
        finally:
            self.task = None
            self.signal.set()


monitor = StreamMonitor()
# Bound concurrent event delivery queries so ordinary API requests retain capacity.
delivery_limit = asyncio.Semaphore(6)


@router.get('/events')
async def events(request: Request, cursor: int | None = None, last_event_id: str | None = Header(None, alias='Last-Event-ID'), identity=Depends(stream_identity)):
    if last_event_id:
        try: cursor = int(last_event_id)
        except ValueError: raise error(422, 'VALIDATION_ERROR', 'Invalid event cursor')
    if cursor is not None and cursor < 0: raise error(422, 'VALIDATION_ERROR', 'Invalid event cursor')
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    def poll(position):
        with factory() as session:
            current = revalidate(session, *identity)
            return None if current is None else changes(session, current, position)
    async def stream():
        position = cursor
        observed_bounds = None
        observed_role = None
        heartbeat = 0
        monitor.add(identity)
        try:
            # Establish a cursor and check authorization even before the first monitor tick.
            async with delivery_limit:
                batch = await asyncio.to_thread(poll, position)
            if batch is None:
                yield 'event: revoked\ndata: {}\n\n'
                return
            position = batch['cursor']
            if batch['events'] or cursor is None:
                yield f"id: {position}\nevent: changes\ndata: {json.dumps(batch, ensure_ascii=False, separators=(',', ':'))}\n\n"
            while not await request.is_disconnected():
                signal = monitor.signal
                try:
                    await asyncio.wait_for(signal.wait(), timeout=15)
                except asyncio.TimeoutError:
                    yield ': heartbeat\n\n'
                    continue
                if monitor.failed:
                    return
                if identity not in monitor.scanned:
                    # This subscriber joined after the current snapshot began.
                    continue
                if identity not in monitor.state:
                    yield 'event: revoked\ndata: {}\n\n'
                    return
                role, bounds = monitor.state[identity], monitor.bounds
                if observed_bounds != bounds or (observed_role is not None and observed_role != role):
                    async with delivery_limit:
                        batch = await asyncio.to_thread(poll, position)
                    if batch is None:
                        yield 'event: revoked\ndata: {}\n\n'
                        return
                    if observed_role is not None and observed_role != role:
                        batch['events'].insert(0, {'action': 'reset'})
                    position = batch['cursor']
                    if batch['events']:
                        yield f"id: {position}\nevent: changes\ndata: {json.dumps(batch, ensure_ascii=False, separators=(',', ':'))}\n\n"
                    observed_bounds, observed_role = bounds, role
                heartbeat += 1
                if heartbeat >= 10:
                    heartbeat = 0
                    yield ': heartbeat\n\n'
        finally:
            monitor.remove(identity)
    return StreamingResponse(stream(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no'})


@router.get('/status')
def status(p=Depends(principal), db: Session = Depends(get_db)):
    if p.membership.role != 'admin': raise error(403, 'FORBIDDEN', 'Administrator required')
    return {'events': db.scalar(select(func.count()).select_from(OutboxEvent).where(OutboxEvent.tenant_id == p.membership.tenant_id)), 'oldest_at': db.scalar(select(func.min(OutboxEvent.created_at)).where(OutboxEvent.tenant_id == p.membership.tenant_id))}


def cleanup(db, days=30):
    if days < 1: raise ValueError('Retention must be at least one day')
    result = db.execute(delete(OutboxEvent).where(OutboxEvent.created_at < datetime.now(timezone.utc) - timedelta(days=days)))
    db.commit()
    return result.rowcount


if __name__ == '__main__':
    import argparse
    from app.database import SessionLocal
    parser = argparse.ArgumentParser()
    parser.add_argument('--retention-days', type=int, default=30)
    args = parser.parse_args()
    with SessionLocal() as db: print(f'Deleted {cleanup(db, args.retention_days)} expired events')
