"""Prevent duplicate active channels within a company."""
from alembic import op

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None

def upgrade():
    op.execute('UPDATE contacts SET whatsapp_id = lower(trim(whatsapp_id)) WHERE whatsapp_id IS NOT NULL')
    for field in ('email', 'phone', 'whatsapp_id'):
        op.execute(f'CREATE UNIQUE INDEX uq_contact_{"whatsapp" if field == "whatsapp_id" else field}_active ON contacts (tenant_id, company_id, {field}) WHERE deleted_at IS NULL AND {field} IS NOT NULL')

def downgrade():
    for field in ('email', 'phone', 'whatsapp'):
        op.execute(f'DROP INDEX uq_contact_{field}_active')
