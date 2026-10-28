"""Verify the migration upgrades an existing phase-one schema without data loss."""
import os
import subprocess
import sys
import uuid
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url


@pytest.mark.skipif(not os.getenv('TEST_DATABASE_URL'), reason='TEST_DATABASE_URL is not configured')
def test_upgrade_preserves_phase_one_data():
    url = os.environ['TEST_DATABASE_URL']
    engine = create_engine(url)
    schema = 'migration_' + uuid.uuid4().hex
    with engine.begin() as connection: connection.execute(text(f'CREATE SCHEMA {schema}'))
    scoped_url = make_url(url).update_query_dict({'options': f'-csearch_path={schema}'})
    test_env = os.environ.copy()
    test_env['DATABASE_URL'] = scoped_url.render_as_string(hide_password=False)
    scoped = create_engine(scoped_url)
    try:
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', '0002'], env=test_env, check=True, capture_output=True)
        tenant, user, membership, company = (uuid.uuid4() for _ in range(4))
        with scoped.begin() as conn:
            conn.execute(text("INSERT INTO tenants(id,name,status) VALUES (:id,'existing','active')"), {'id':tenant})
            conn.execute(text("INSERT INTO users(id,email,name,password_hash,status) VALUES (:id,'existing@example.com','existing','test','active')"), {'id':user})
            conn.execute(text("INSERT INTO tenant_memberships(id,tenant_id,user_id,role,status) VALUES (:id,:tenant,:user,'admin','active')"), {'id':membership,'tenant':tenant,'user':user})
            conn.execute(text("INSERT INTO companies(id,tenant_id,name,owner_id,version,updated_by) VALUES (:id,:tenant,'Existing company',:user,1,:user)"), {'id':company,'tenant':tenant,'user':user})
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', 'head'], env=test_env, check=True, capture_output=True)
        with scoped.connect() as conn:
            assert conn.scalar(text('SELECT name FROM companies WHERE id=:id'), {'id':company}) == 'Existing company'
            assert conn.scalar(text('SELECT version_num FROM alembic_version')) == '0006'
            assert conn.scalar(text("SELECT count(*) FROM information_schema.tables WHERE table_schema=:schema AND table_name IN ('leads','lead_evidence','opportunities','opportunity_contacts','follow_up_tasks','activities')"), {'schema':schema}) == 6
    finally:
        scoped.dispose()
        with engine.begin() as connection: connection.execute(text(f'DROP SCHEMA {schema} CASCADE'))
        engine.dispose()
