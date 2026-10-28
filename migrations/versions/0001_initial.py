"""Initial CRM schema, frozen at revision creation."""
from alembic import op

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None

def upgrade():
    op.execute('CREATE TABLE tenants (\n\tid UUID NOT NULL, \n\tname VARCHAR(255) NOT NULL, \n\tstatus VARCHAR(20) NOT NULL, \n\tcreated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, \n\tPRIMARY KEY (id)\n)')
    op.execute('CREATE TABLE users (\n\tid UUID NOT NULL, \n\temail VARCHAR(255) NOT NULL, \n\tname VARCHAR(255) NOT NULL, \n\tpassword_hash TEXT NOT NULL, \n\tstatus VARCHAR(20) NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (email)\n)')
    op.execute('CREATE TABLE tenant_memberships (\n\tid UUID NOT NULL, \n\ttenant_id UUID NOT NULL, \n\tuser_id UUID NOT NULL, \n\trole VARCHAR(20) NOT NULL, \n\tstatus VARCHAR(20) NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (tenant_id, user_id), \n\tFOREIGN KEY(tenant_id) REFERENCES tenants (id), \n\tFOREIGN KEY(user_id) REFERENCES users (id)\n)')
    op.execute('CREATE TABLE login_sessions (\n\ttoken_hash VARCHAR(64) NOT NULL, \n\tuser_id UUID NOT NULL, \n\texpires_at TIMESTAMP WITH TIME ZONE NOT NULL, \n\trevoked_at TIMESTAMP WITH TIME ZONE, \n\tPRIMARY KEY (token_hash), \n\tFOREIGN KEY(user_id) REFERENCES users (id)\n)')
    op.execute('CREATE TABLE audit_logs (\n\tid UUID NOT NULL, \n\ttenant_id UUID NOT NULL, \n\tactor_id UUID NOT NULL, \n\taction VARCHAR(50) NOT NULL, \n\tobject_type VARCHAR(50) NOT NULL, \n\tobject_id UUID NOT NULL, \n\tchanged_fields JSONB NOT NULL, \n\tresult VARCHAR(20) NOT NULL, \n\trequest_id VARCHAR(100) NOT NULL, \n\tsource VARCHAR(20) NOT NULL, \n\tagent_run_id VARCHAR(100), \n\tcreated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(tenant_id) REFERENCES tenants (id), \n\tFOREIGN KEY(actor_id) REFERENCES users (id)\n)')
    op.execute('CREATE TABLE idempotency_keys (\n\tid UUID NOT NULL, \n\ttenant_id UUID NOT NULL, \n\tactor_id UUID NOT NULL, \n\tkey VARCHAR(128) NOT NULL, \n\trequest_hash VARCHAR(64) NOT NULL, \n\tstatus_code INTEGER NOT NULL, \n\tresponse JSONB NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (tenant_id, actor_id, key), \n\tFOREIGN KEY(tenant_id) REFERENCES tenants (id), \n\tFOREIGN KEY(actor_id) REFERENCES users (id)\n)')
    op.execute('CREATE TABLE companies (\n\tid UUID NOT NULL, \n\ttenant_id UUID NOT NULL, \n\tname VARCHAR(255) NOT NULL, \n\tcountry VARCHAR(100), \n\tindustry VARCHAR(100), \n\tcompany_type VARCHAR(50), \n\tcompany_size VARCHAR(50), \n\twebsite TEXT, \n\twebsite_domain VARCHAR(253), \n\tbusiness_summary TEXT, \n\tsummary_source TEXT, \n\trelationship_status VARCHAR(30), \n\towner_id UUID NOT NULL, \n\tsource VARCHAR(50), \n\tversion INTEGER NOT NULL, \n\tdeleted_at TIMESTAMP WITH TIME ZONE, \n\tcreated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, \n\tupdated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, \n\tupdated_by UUID NOT NULL, \n\tPRIMARY KEY (id), \n\tUNIQUE (tenant_id, id), \n\tFOREIGN KEY(tenant_id, owner_id) REFERENCES tenant_memberships (tenant_id, user_id), \n\tFOREIGN KEY(tenant_id) REFERENCES tenants (id), \n\tFOREIGN KEY(updated_by) REFERENCES users (id)\n)')
    op.execute('CREATE INDEX ix_companies_tenant_id ON companies (tenant_id)')
    op.execute('CREATE UNIQUE INDEX uq_company_domain_active ON companies (tenant_id, website_domain) WHERE deleted_at IS NULL AND website_domain IS NOT NULL')
    op.execute('CREATE TABLE contacts (\n\tid UUID NOT NULL, \n\ttenant_id UUID NOT NULL, \n\tcompany_id UUID NOT NULL, \n\tname VARCHAR(100) NOT NULL, \n\tjob_title VARCHAR(100), \n\temail VARCHAR(255), \n\tphone VARCHAR(50), \n\twhatsapp_id VARCHAR(100), \n\tpreferred_language VARCHAR(30), \n\tcontact_status VARCHAR(30), \n\tversion INTEGER NOT NULL, \n\tdeleted_at TIMESTAMP WITH TIME ZONE, \n\tcreated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, \n\tupdated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, \n\tupdated_by UUID NOT NULL, \n\tPRIMARY KEY (id), \n\tFOREIGN KEY(tenant_id, company_id) REFERENCES companies (tenant_id, id), \n\tFOREIGN KEY(tenant_id) REFERENCES tenants (id), \n\tFOREIGN KEY(updated_by) REFERENCES users (id)\n)')
    op.execute('CREATE INDEX ix_contact_tenant_company ON contacts (tenant_id, company_id)')

def downgrade():
    op.execute('DROP TABLE contacts CASCADE')
    op.execute('DROP TABLE companies CASCADE')
    op.execute('DROP TABLE tenant_memberships CASCADE')
    op.execute('DROP TABLE login_sessions CASCADE')
    op.execute('DROP TABLE idempotency_keys CASCADE')
    op.execute('DROP TABLE audit_logs CASCADE')
    op.execute('DROP TABLE users CASCADE')
    op.execute('DROP TABLE tenants CASCADE')
