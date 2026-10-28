"""Reject partial evidence offsets at database level."""
from alembic import op
revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None

def upgrade():
    op.execute('ALTER TABLE lead_evidence ADD CONSTRAINT ck_evidence_offsets_pair CHECK ((quote_start IS NULL AND quote_end IS NULL) OR (quote_start IS NOT NULL AND quote_end IS NOT NULL AND quote_start >= 0 AND quote_end > quote_start AND source_snapshot_text IS NOT NULL))')

def downgrade():
    op.execute('ALTER TABLE lead_evidence DROP CONSTRAINT ck_evidence_offsets_pair')
