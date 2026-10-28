"""Disposable PostgreSQL smoke load: 500 separate users, streams, and paged reads."""
import asyncio
import hashlib
import json
import os
import socket
import statistics
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
import httpx
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from app.database import Base
from app.models import Tenant, User, Membership, LoginSession
from app import phase2_models


async def measure(port, identities):
    limits = httpx.Limits(max_connections=1200, max_keepalive_connections=1200)
    latencies = []
    opened = 0
    failures = []
    stop = asyncio.Event()
    event_mode = os.getenv('LOAD_EVENT') == '1'
    received = [set() for _ in identities]
    expected_id = None
    async with httpx.AsyncClient(limits=limits, timeout=60) as client:
        async def stream(index, identity):
            nonlocal opened
            token, tenant = identity
            try:
                async with client.stream('GET', f'http://127.0.0.1:{port}/api/v1/sync/events', headers={'Authorization':'Bearer '+token, 'X-Tenant-ID':tenant}) as response:
                    if response.status_code != 200: failures.append(response.status_code); return
                    lines = response.aiter_lines()
                    async for line in lines:
                        if line.startswith('data:'):
                            opened += 1; break
                    if event_mode:
                        async for line in lines:
                            if line.startswith('data:'):
                                batch = json.loads(line[5:].strip())
                                received[index].update(e.get('entity_id') for e in batch.get('events', []) if e.get('entity_id'))
                                if expected_id and expected_id in received[index]: break
                    else: await stop.wait()
            except Exception as exc: failures.append(type(exc).__name__)
        workers = [] if os.getenv('LOAD_SKIP_STREAMS') == '1' else [asyncio.create_task(stream(index, identity)) for index, identity in enumerate(identities)]
        deadline = time.monotonic() + 60
        while workers and opened + len(failures) < len(identities) and time.monotonic() < deadline: await asyncio.sleep(.1)
        if event_mode:
            token, tenant = identities[0]
            created = await client.post(f'http://127.0.0.1:{port}/api/v1/companies', headers={'Authorization':'Bearer '+token, 'X-Tenant-ID':tenant, 'Idempotency-Key':'load-event'}, json={'name':'Load event'})
            if created.status_code != 201: raise RuntimeError(f'Event setup failed: {created.status_code}')
            expected_id = created.json()['id']
        async def read(identity):
            token, tenant = identity; start = time.monotonic()
            try:
                result = await client.get(f'http://127.0.0.1:{port}/api/v1/companies?limit=20&offset=0', headers={'Authorization':'Bearer '+token, 'X-Tenant-ID':tenant})
                if result.status_code != 200: failures.append(result.status_code)
            except Exception as exc: failures.append(type(exc).__name__)
            latencies.append(time.monotonic()-start)
        await asyncio.gather(*(read(i) for i in identities))
        if event_mode:
            event_deadline = time.monotonic() + 45
            while sum(expected_id in item for item in received) < len(identities) and time.monotonic() < event_deadline:
                await asyncio.sleep(.1)
            count = sum(expected_id in item for item in received)
            print(f'event_received={count}/{len(identities)}')
            if count != len(identities): failures.append('EventDeliveryTimeout')
            for worker in workers: worker.cancel()
        stop.set(); await asyncio.gather(*workers, return_exceptions=True)
    latencies.sort()
    print(f'users={len(identities)} sse_open={opened} failures={len(failures)} read_p50={statistics.median(latencies):.2f}s read_p95={latencies[int(len(latencies)*.95)-1]:.2f}s')
    if failures: print('failure types:', sorted(set(map(str, failures))))
    return not failures and (os.getenv('LOAD_SKIP_STREAMS') == '1' or opened == len(identities))


def main():
    if not os.getenv('TEST_DATABASE_URL'): raise SystemExit('TEST_DATABASE_URL must point to a disposable database')
    url = os.environ['TEST_DATABASE_URL']; schema = 'load_' + uuid.uuid4().hex
    admin = create_engine(url)
    with admin.begin() as conn: conn.execute(text(f'CREATE SCHEMA {schema}'))
    scoped = make_url(url).update_query_dict({'options': f'-csearch_path={schema}'})
    engine = create_engine(scoped)
    process = None
    try:
        Base.metadata.create_all(engine)
        identities=[]
        with Session(engine) as db, db.begin():
            tenant=Tenant(name='Load test'); db.add(tenant); db.flush()
            for i in range(int(os.getenv('LOAD_USERS', '500'))):
                user=User(email=f'load{i}@example.com',name=f'User {i}',password_hash='unused'); db.add(user); db.flush()
                token=uuid.uuid4().hex + uuid.uuid4().hex
                db.add_all([Membership(tenant_id=tenant.id,user_id=user.id,role='admin' if os.getenv('LOAD_EVENT') == '1' else 'sales'),LoginSession(token_hash=hashlib.sha256(token.encode()).hexdigest(),user_id=user.id,expires_at=datetime.now(timezone.utc)+timedelta(hours=1))])
                identities.append((token,str(tenant.id)))
        with socket.socket() as sock: sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
        env=os.environ.copy(); env['DATABASE_URL']=scoped.render_as_string(hide_password=False)
        process=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(port)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for _ in range(100):
            if process.poll() is not None: raise RuntimeError('Test server exited during startup')
            try:
                if httpx.get(f'http://127.0.0.1:{port}/health', timeout=.3).status_code==200: break
            except httpx.HTTPError: time.sleep(.1)
        else: raise RuntimeError('Test server failed to start')
        if not asyncio.run(measure(port,identities)): raise SystemExit(1)
    finally:
        if process: process.terminate(); process.wait(timeout=15)
        engine.dispose()
        with admin.begin() as conn: conn.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        admin.dispose()


if __name__ == '__main__': main()
