"""Allow different quotes from one message while rejecting duplicate evidence."""
from alembic import op

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None

def upgrade():
    op.execute('DROP INDEX uq_evidence_source')
    op.execute("CREATE UNIQUE INDEX uq_evidence_source ON lead_evidence (tenant_id, source_type, source_id, md5(coalesce(original_quote, manual_note, ''))) WHERE source_id IS NOT NULL")

def downgrade():
    op.execute('DROP INDEX uq_evidence_source')
    op.execute('CREATE UNIQUE INDEX uq_evidence_source ON lead_evidence (tenant_id, source_type, source_id) WHERE source_id IS NOT NULL')
