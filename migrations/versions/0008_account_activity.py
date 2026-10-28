"""Add account verification and activity version fields without new tables."""
from alembic import op
revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None

def upgrade():
    op.execute("ALTER TABLE activities ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)")
    op.execute("ALTER TABLE users ADD COLUMN verification_hash VARCHAR(64), ADD COLUMN verification_expires_at TIMESTAMPTZ, ADD COLUMN reset_hash VARCHAR(64), ADD COLUMN reset_expires_at TIMESTAMPTZ, ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0, ADD COLUMN locked_until TIMESTAMPTZ")
    op.execute("ALTER TABLE tenant_memberships ADD COLUMN manager_id UUID, ADD CONSTRAINT fk_membership_manager FOREIGN KEY (tenant_id, manager_id) REFERENCES tenant_memberships (tenant_id, user_id), ADD CONSTRAINT ck_membership_not_self CHECK (manager_id IS NULL OR manager_id <> user_id)")
    op.execute("CREATE INDEX ix_tenant_memberships_manager_id ON tenant_memberships (manager_id)")
    op.execute("CREATE UNIQUE INDEX uq_users_verification_hash ON users (verification_hash) WHERE verification_hash IS NOT NULL")
    op.execute("CREATE UNIQUE INDEX uq_users_reset_hash ON users (reset_hash) WHERE reset_hash IS NOT NULL")

def downgrade():
    op.execute('DROP INDEX ix_tenant_memberships_manager_id')
    op.execute('ALTER TABLE tenant_memberships DROP CONSTRAINT fk_membership_manager, DROP CONSTRAINT ck_membership_not_self, DROP COLUMN manager_id')
    op.execute('DROP INDEX uq_users_reset_hash')
    op.execute('DROP INDEX uq_users_verification_hash')
    op.execute('ALTER TABLE users DROP COLUMN locked_until, DROP COLUMN failed_logins, DROP COLUMN reset_expires_at, DROP COLUMN reset_hash, DROP COLUMN verification_expires_at, DROP COLUMN verification_hash')
    op.execute('ALTER TABLE activities DROP COLUMN version')
