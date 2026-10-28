"""Enforce tenant membership for sales-record actors."""
from alembic import op
revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None

def upgrade():
    for table in ('leads', 'opportunities', 'follow_up_tasks', 'lead_evidence', 'activities'):
        op.execute(f'ALTER TABLE {table} ADD CONSTRAINT fk_{table}_creator_membership FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_memberships (tenant_id, user_id)')
    for table in ('leads', 'opportunities', 'follow_up_tasks'):
        op.execute(f'ALTER TABLE {table} ADD CONSTRAINT fk_{table}_updater_membership FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_memberships (tenant_id, user_id)')

def downgrade():
    for table in ('leads', 'opportunities', 'follow_up_tasks'):
        op.execute(f'ALTER TABLE {table} DROP CONSTRAINT fk_{table}_updater_membership')
    for table in ('leads', 'opportunities', 'follow_up_tasks', 'lead_evidence', 'activities'):
        op.execute(f'ALTER TABLE {table} DROP CONSTRAINT fk_{table}_creator_membership')
