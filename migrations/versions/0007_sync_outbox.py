"""Transactional change notifications; existing business tables remain unchanged."""
from alembic import op

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade():
    op.execute('CREATE TABLE crm_outbox_events (id BIGSERIAL PRIMARY KEY, tenant_id UUID NOT NULL REFERENCES tenants(id), entity VARCHAR(50) NOT NULL, entity_id UUID NOT NULL, action VARCHAR(30) NOT NULL, version INTEGER, changes JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now())')
    op.execute('CREATE INDEX ix_outbox_tenant_id ON crm_outbox_events (tenant_id, id)')
    op.execute('CREATE INDEX ix_outbox_created_at ON crm_outbox_events (created_at)')


def downgrade():
    op.execute('DROP TABLE crm_outbox_events')
