"""Sales domain models. Composite foreign keys enforce tenant boundaries."""
import uuid
from datetime import datetime
from decimal import Decimal
from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, Numeric, String, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base
from app.models import uid


class Record:
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('tenants.id'), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MutableRecord(Record):
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey('users.id'))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey('users.id'))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, default=1)


class Lead(MutableRecord, Base):
    __tablename__ = 'leads'
    __table_args__ = (UniqueConstraint('tenant_id', 'id'),
        ForeignKeyConstraint(['tenant_id', 'created_by'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        ForeignKeyConstraint(['tenant_id', 'updated_by'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        ForeignKeyConstraint(['tenant_id', 'company_id'], ['companies.tenant_id', 'companies.id']),
        ForeignKeyConstraint(['tenant_id', 'contact_id'], ['contacts.tenant_id', 'contacts.id']),
        ForeignKeyConstraint(['tenant_id', 'owner_id'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        CheckConstraint("status IN ('new','working','qualified','converted','disqualified')"),
        CheckConstraint("intent_level IN ('unknown','low','medium','high')"),
        CheckConstraint('estimated_quantity IS NULL OR estimated_quantity > 0'),
        CheckConstraint('budget_amount IS NULL OR (budget_amount >= 0 AND budget_currency IS NOT NULL)'))
    company_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    contact_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    company_name_raw: Mapped[str | None] = mapped_column(String(255))
    contact_name_raw: Mapped[str | None] = mapped_column(String(100))
    contact_email: Mapped[str | None] = mapped_column(String(255))
    contact_phone: Mapped[str | None] = mapped_column(String(50))
    title: Mapped[str] = mapped_column(String(255))
    source: Mapped[str] = mapped_column(String(30))
    product_interest: Mapped[str | None] = mapped_column(Text)
    requirement_notes: Mapped[str | None] = mapped_column(Text)
    estimated_quantity: Mapped[Decimal | None] = mapped_column(Numeric(20, 4))
    quantity_unit: Mapped[str | None] = mapped_column(String(30))
    budget_amount: Mapped[Decimal | None] = mapped_column(Numeric(20, 4))
    budget_currency: Mapped[str | None] = mapped_column(String(3))
    intent_level: Mapped[str] = mapped_column(String(20), default='unknown')
    status: Mapped[str] = mapped_column(String(30), default='new')
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    disqualification_reason: Mapped[str | None] = mapped_column(Text)


class LeadEvidence(Record, Base):
    __tablename__ = 'lead_evidence'
    __table_args__ = (ForeignKeyConstraint(['tenant_id', 'lead_id'], ['leads.tenant_id', 'leads.id']),
        ForeignKeyConstraint(['tenant_id', 'created_by'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        CheckConstraint("(evidence_type = 'manual' AND manual_note IS NOT NULL AND length(trim(manual_note)) > 0) OR (evidence_type = 'quote' AND original_quote IS NOT NULL AND length(trim(original_quote)) > 0)"),
        CheckConstraint('(quote_start IS NULL AND quote_end IS NULL) OR (quote_start IS NOT NULL AND quote_end IS NOT NULL AND quote_start >= 0 AND quote_end > quote_start AND source_snapshot_text IS NOT NULL)', name='ck_evidence_offsets_pair'),
        Index('uq_evidence_source', 'tenant_id', 'source_type', 'source_id', text("md5(coalesce(original_quote, manual_note, ''))"), unique=True, postgresql_where=text('source_id IS NOT NULL')))
    lead_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    evidence_type: Mapped[str] = mapped_column(String(20))
    source_type: Mapped[str] = mapped_column(String(30))
    source_id: Mapped[str | None] = mapped_column(String(255))
    source_uri: Mapped[str | None] = mapped_column(Text)
    source_snapshot_text: Mapped[str | None] = mapped_column(Text)
    original_quote: Mapped[str | None] = mapped_column(Text)
    manual_note: Mapped[str | None] = mapped_column(Text)
    quote_start: Mapped[int | None] = mapped_column(Integer)
    quote_end: Mapped[int | None] = mapped_column(Integer)
    source_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey('users.id'))


class Opportunity(MutableRecord, Base):
    __tablename__ = 'opportunities'
    __table_args__ = (UniqueConstraint('tenant_id', 'id'), UniqueConstraint('tenant_id', 'originating_lead_id'),
        ForeignKeyConstraint(['tenant_id', 'created_by'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        ForeignKeyConstraint(['tenant_id', 'updated_by'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        ForeignKeyConstraint(['tenant_id', 'company_id'], ['companies.tenant_id', 'companies.id']),
        ForeignKeyConstraint(['tenant_id', 'originating_lead_id'], ['leads.tenant_id', 'leads.id']),
        ForeignKeyConstraint(['tenant_id', 'owner_id'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        CheckConstraint("stage IN ('discovery','quoting','negotiating','won','lost')"),
        CheckConstraint('expected_amount IS NULL OR (expected_amount >= 0 AND currency IS NOT NULL)'),
        CheckConstraint("(stage IN ('won','lost') AND closed_at IS NOT NULL) OR (stage NOT IN ('won','lost') AND closed_at IS NULL)"),
        CheckConstraint("stage <> 'lost' OR (lost_reason IS NOT NULL AND length(trim(lost_reason)) > 0)"))
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    originating_lead_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    name: Mapped[str] = mapped_column(String(255))
    product_summary: Mapped[str | None] = mapped_column(Text)
    requirement_notes: Mapped[str | None] = mapped_column(Text)
    expected_amount: Mapped[Decimal | None] = mapped_column(Numeric(20, 4))
    currency: Mapped[str | None] = mapped_column(String(3))
    stage: Mapped[str] = mapped_column(String(30), default='discovery')
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    close_note: Mapped[str | None] = mapped_column(Text)
    lost_reason: Mapped[str | None] = mapped_column(Text)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OpportunityContact(Record, Base):
    __tablename__ = 'opportunity_contacts'
    __table_args__ = (UniqueConstraint('tenant_id', 'opportunity_id', 'contact_id'),
        ForeignKeyConstraint(['tenant_id', 'opportunity_id'], ['opportunities.tenant_id', 'opportunities.id']),
        ForeignKeyConstraint(['tenant_id', 'contact_id'], ['contacts.tenant_id', 'contacts.id']))
    opportunity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    contact_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    role_note: Mapped[str | None] = mapped_column(String(255))


class FollowUpTask(MutableRecord, Base):
    __tablename__ = 'follow_up_tasks'
    __table_args__ = (UniqueConstraint('tenant_id', 'id'),
        ForeignKeyConstraint(['tenant_id', 'created_by'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        ForeignKeyConstraint(['tenant_id', 'updated_by'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        ForeignKeyConstraint(['tenant_id', 'company_id'], ['companies.tenant_id', 'companies.id']),
        ForeignKeyConstraint(['tenant_id', 'lead_id'], ['leads.tenant_id', 'leads.id']),
        ForeignKeyConstraint(['tenant_id', 'opportunity_id'], ['opportunities.tenant_id', 'opportunities.id']),
        ForeignKeyConstraint(['tenant_id', 'assigned_to'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        CheckConstraint('company_id IS NOT NULL OR lead_id IS NOT NULL OR opportunity_id IS NOT NULL'),
        CheckConstraint("priority IN ('low','normal','high')"),
        CheckConstraint("status IN ('pending','completed','cancelled')"),
        CheckConstraint("(status = 'completed' AND completed_at IS NOT NULL) OR (status <> 'completed' AND completed_at IS NULL)"))
    company_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    lead_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    opportunity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    assigned_to: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    remind_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    priority: Mapped[str] = mapped_column(String(20), default='normal')
    status: Mapped[str] = mapped_column(String(20), default='pending')
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completion_note: Mapped[str | None] = mapped_column(Text)


class Activity(Record, Base):
    __tablename__ = 'activities'
    __table_args__ = (UniqueConstraint('tenant_id', 'id'),
        ForeignKeyConstraint(['tenant_id', 'created_by'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        ForeignKeyConstraint(['tenant_id', 'company_id'], ['companies.tenant_id', 'companies.id']),
        ForeignKeyConstraint(['tenant_id', 'contact_id'], ['contacts.tenant_id', 'contacts.id']),
        ForeignKeyConstraint(['tenant_id', 'lead_id'], ['leads.tenant_id', 'leads.id']),
        ForeignKeyConstraint(['tenant_id', 'opportunity_id'], ['opportunities.tenant_id', 'opportunities.id']),
        ForeignKeyConstraint(['tenant_id', 'follow_up_task_id'], ['follow_up_tasks.tenant_id', 'follow_up_tasks.id']),
        CheckConstraint('company_id IS NOT NULL OR contact_id IS NOT NULL OR lead_id IS NOT NULL OR opportunity_id IS NOT NULL OR follow_up_task_id IS NOT NULL'),
        CheckConstraint("activity_type IN ('email','phone','whatsapp','meeting','note')"),
        CheckConstraint("direction IS NULL OR direction IN ('inbound','outbound')"))
    company_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    contact_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    lead_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    opportunity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    follow_up_task_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    activity_type: Mapped[str] = mapped_column(String(30))
    direction: Mapped[str | None] = mapped_column(String(20))
    subject: Mapped[str | None] = mapped_column(String(255))
    summary: Mapped[str] = mapped_column(Text)
    outcome: Mapped[str | None] = mapped_column(Text)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey('users.id'))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
