from test_integration import env
from sqlalchemy import select
from app.models import OutboxEvent, Membership
from uuid import UUID
import pytest
import asyncio
import os
import socket
import subprocess
import sys
import time
import httpx


def test_changes_commit_and_permission_filter(env):
    client, sessions, (tenant, _, admin, sales), auth = env
    manager = auth('admin@example.com', tenant)
    seller = auth('sales@example.com', tenant)
    start = client.get('/api/v1/sync/changes', headers=manager).json()['cursor']
    created = client.post('/api/v1/companies', headers={**manager, 'Idempotency-Key': 'sync-company'}, json={'name': 'Private buyer'})
    assert created.status_code == 201
    changes = client.get('/api/v1/sync/changes', headers=manager, params={'cursor': start}).json()
    assert any(event.get('entity_id') == created.json()['id'] for event in changes['events'])
    filtered = client.get('/api/v1/sync/changes', headers=seller, params={'cursor': start}).json()
    assert all(event.get('entity_id') != created.json()['id'] for event in filtered['events'])
    assert filtered['events'] == []


def test_rollback_and_replay_do_not_emit_extra_events(env, monkeypatch):
    from app import service
    client, sessions, (tenant, _, admin, sales), auth = env
    headers = auth('admin@example.com', tenant)
    before = client.get('/api/v1/sync/changes', headers=headers).json()['cursor']
    request_headers = {**headers, 'Idempotency-Key':'same'}
    first = client.post('/api/v1/companies', headers=request_headers, json={'name':'Once'})
    assert first.status_code == 201
    assert client.post('/api/v1/companies', headers=request_headers, json={'name':'Once'}).status_code == 201
    events = client.get('/api/v1/sync/changes', headers=headers, params={'cursor':before}).json()['events']
    assert len([e for e in events if e.get('entity_id') == first.json()['id']]) == 1
    original = service.audit
    def fail(db, p, request, action, obj, fields):
        original(db, p, request, action, obj, fields)
        raise RuntimeError('simulate failure after event')
    monkeypatch.setattr(service, 'audit', fail)
    with pytest.raises(RuntimeError): client.post('/api/v1/companies', headers={**headers,'Idempotency-Key':'rollback'}, json={'name':'Rollback'})
    with sessions() as db: assert len(list(db.scalars(select(OutboxEvent)))) == 1


def test_ownership_change_hides_object_and_member_revocation_denies_poll(env):
    client, sessions, (tenant, _, admin, sales), auth = env
    manager = auth('admin@example.com', tenant)
    seller = auth('sales@example.com', tenant)
    company = client.post('/api/v1/companies', headers={**seller,'Idempotency-Key':'own'}, json={'name':'Owned'}).json()
    cursor = client.get('/api/v1/sync/changes', headers=seller).json()['cursor']
    moved = client.patch('/api/v1/companies/' + company['id'], headers={**manager,'Idempotency-Key':'transfer'}, json={'expected_version':1, 'owner_id':admin})
    assert moved.status_code == 200
    batch = client.get('/api/v1/sync/changes', headers=seller, params={'cursor':cursor}).json()
    assert batch['events'] == [{'action':'reset'}]
    with sessions.begin() as db:
        member = db.scalar(select(Membership).where(Membership.tenant_id == UUID(tenant), Membership.user_id == UUID(sales)))
        member.status = 'inactive'
    assert client.get('/api/v1/sync/changes', headers=seller, params={'cursor':cursor}).status_code == 403


def test_live_sse_reconnect_and_revocation(env):
    client, sessions, (tenant, _, admin, sales), auth = env
    seller = auth('sales@example.com', tenant)
    with sessions() as db: schema = db.execute(__import__('sqlalchemy').text('SELECT current_schema()')).scalar_one()
    from sqlalchemy.engine import make_url
    url = make_url(os.environ['TEST_DATABASE_URL']).update_query_dict({'options': f'-csearch_path={schema}'}).render_as_string(hide_password=False)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    env_vars = os.environ.copy(); env_vars['DATABASE_URL'] = url
    process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', str(port)], env=env_vars, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                if httpx.get(f'http://127.0.0.1:{port}/health', timeout=.3).status_code == 200: break
            except httpx.HTTPError: time.sleep(.1)
        else: raise AssertionError('Test server did not start')
        async def exercise():
            async with httpx.AsyncClient(timeout=10) as http:
                async with http.stream('GET', f'http://127.0.0.1:{port}/api/v1/sync/events', headers=seller) as stream:
                    assert stream.status_code == 200
                    lines = stream.aiter_lines()
                    assert (await asyncio.wait_for(anext(lines), 5)).startswith('id: ')
                    assert await asyncio.wait_for(anext(lines), 5) == 'event: changes'
                    payload = await asyncio.wait_for(anext(lines), 5)
                    import json
                    cursor = json.loads(payload.removeprefix('data: '))['cursor']
                    await asyncio.wait_for(anext(lines), 5)
                    created = client.post('/api/v1/companies', headers={**seller,'Idempotency-Key':'during-disconnect'}, json={'name':'Reconnect'})
                    assert created.status_code == 201
                    assert (await asyncio.wait_for(anext(lines), 5)).startswith('id: ')
                    assert await asyncio.wait_for(anext(lines), 5) == 'event: changes'
                    live = json.loads((await asyncio.wait_for(anext(lines), 5)).removeprefix('data: '))
                    assert any(e.get('entity_id') == created.json()['id'] for e in live['events'])
                async with http.stream('GET', f'http://127.0.0.1:{port}/api/v1/sync/events', headers={**seller,'Last-Event-ID':str(cursor)}) as stream:
                    lines = stream.aiter_lines()
                    await asyncio.wait_for(anext(lines), 5)
                    assert await asyncio.wait_for(anext(lines), 5) == 'event: changes'
                    batch = json.loads((await asyncio.wait_for(anext(lines), 5)).removeprefix('data: '))
                    assert any(e.get('entity_id') == created.json()['id'] for e in batch['events'])
                    await asyncio.wait_for(anext(lines), 5)
                    with sessions.begin() as db:
                        member = db.scalar(select(Membership).where(Membership.tenant_id == UUID(tenant), Membership.user_id == UUID(sales)))
                        member.status = 'inactive'
                    assert await asyncio.wait_for(anext(lines), 6) == 'event: revoked'
        asyncio.run(exercise())
    finally:
        process.terminate(); process.wait(timeout=10)


def test_monitor_batches_identities_and_filters_revoked(env, monkeypatch):
    from app import sync
    from app.security import token_hash
    client, sessions, (tenant, _, admin, sales), auth = env
    admin_headers = auth('admin@example.com', tenant)
    sales_headers = auth('sales@example.com', tenant)
    identities = [(UUID(admin), UUID(tenant), token_hash(admin_headers['Authorization'].split()[1])),
                  (UUID(sales), UUID(tenant), token_hash(sales_headers['Authorization'].split()[1]))]
    monkeypatch.setattr(sync, 'SessionLocal', sessions)
    state, bounds = sync.StreamMonitor.snapshot(identities)
    assert state[identities[0]] == 'admin'
    assert state[identities[1]] == 'sales'
    with sessions.begin() as db:
        member = db.scalar(select(Membership).where(Membership.tenant_id == UUID(tenant), Membership.user_id == UUID(sales)))
        member.status = 'inactive'
    state, _ = sync.StreamMonitor.snapshot(identities)
    assert identities[0] in state
    assert identities[1] not in state


def test_monitor_shares_one_snapshot_for_many_connections(monkeypatch):
    from app.sync import StreamMonitor
    calls = []
    def snapshot(identities):
        calls.append(list(identities))
        return {identity: 'sales' for identity in identities}, (None, 0)
    monkeypatch.setattr(StreamMonitor, 'snapshot', staticmethod(snapshot))
    async def run():
        monitor = StreamMonitor()
        identities = [(i, i, str(i)) for i in range(100)]
        for identity in identities: monitor.add(identity)
        await asyncio.wait_for(monitor.signal.wait(), 3)
        assert len(calls) == 1
        assert len(calls[0]) == 100
        for identity in identities: monitor.remove(identity)
        monitor.task.cancel()
        try: await monitor.task
        except asyncio.CancelledError: pass
    asyncio.run(run())


def test_server_restart_replay_and_session_expiry(env):
    import json
    from datetime import datetime, timedelta, timezone
    from sqlalchemy.engine import make_url
    from app.models import LoginSession
    from app.security import token_hash
    client, sessions, (tenant, _, admin, sales), auth = env
    headers = auth('sales@example.com', tenant)
    with sessions() as db: schema = db.execute(__import__('sqlalchemy').text('SELECT current_schema()')).scalar_one()
    url = make_url(os.environ['TEST_DATABASE_URL']).update_query_dict({'options': f'-csearch_path={schema}'}).render_as_string(hide_password=False)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env_vars = os.environ.copy(); env_vars['DATABASE_URL'] = url
    def start():
        process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', str(port)], env=env_vars, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if process.poll() is not None: raise AssertionError('Test server exited')
            try:
                if httpx.get(base + '/health', timeout=.3).status_code == 200: return process
            except httpx.HTTPError: time.sleep(.1)
        process.terminate(); process.wait(timeout=10)
        raise AssertionError('Test server did not start')
    async def initial():
        async with httpx.AsyncClient(timeout=10) as http:
            async with http.stream('GET', base + '/api/v1/sync/events', headers=headers) as response:
                assert response.status_code == 200
                lines = response.aiter_lines()
                await asyncio.wait_for(anext(lines), 5)
                assert await asyncio.wait_for(anext(lines), 5) == 'event: changes'
                return json.loads((await asyncio.wait_for(anext(lines), 5)).removeprefix('data: '))['cursor']
    process = start()
    try:
        cursor = asyncio.run(initial())
        process.terminate(); process.wait(timeout=10)
        created = client.post('/api/v1/companies', headers={**headers, 'Idempotency-Key':'restart-company'}, json={'name':'During restart'})
        assert created.status_code == 201
        process = start()
        async def replay_and_expire():
            async with httpx.AsyncClient(timeout=10) as http:
                async with http.stream('GET', base + '/api/v1/sync/events', headers={**headers, 'Last-Event-ID':str(cursor)}) as response:
                    assert response.status_code == 200
                    lines = response.aiter_lines()
                    assert (await asyncio.wait_for(anext(lines), 6)).startswith('id: ')
                    assert await asyncio.wait_for(anext(lines), 6) == 'event: changes'
                    batch = json.loads((await asyncio.wait_for(anext(lines), 6)).removeprefix('data: '))
                    assert any(item.get('entity_id') == created.json()['id'] for item in batch['events'])
                    await asyncio.wait_for(anext(lines), 6)
                    with sessions.begin() as db:
                        session = db.get(LoginSession, token_hash(headers['Authorization'].split()[1]))
                        session.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
                    assert await asyncio.wait_for(anext(lines), 6) == 'event: revoked'
                result = await http.get(base + '/api/v1/companies', headers=headers)
                assert result.status_code == 401
        asyncio.run(replay_and_expire())
    finally:
        if process.poll() is None: process.terminate(); process.wait(timeout=10)
