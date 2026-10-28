import uuid
from datetime import datetime
from sqlalchemy import String, Text, Integer, DateTime, ForeignKey, ForeignKeyConstraint, UniqueConstraint, Index, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


def uid(): return uuid.uuid4()


class Tenant(Base):
    __tablename__ = 'tenants'
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    name: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default='active')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class User(Base):
    __tablename__ = 'users'
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    password_hash: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default='active')


class Membership(Base):
    __tablename__ = 'tenant_memberships'
    __table_args__ = (UniqueConstraint('tenant_id', 'user_id'),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('tenants.id'))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('users.id'))
    role: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default='active')


class LoginSession(Base):
    __tablename__ = 'login_sessions'
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('users.id'))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Company(Base):
    __tablename__ = 'companies'
    __table_args__ = (
        UniqueConstraint('tenant_id', 'id'),
        ForeignKeyConstraint(['tenant_id', 'owner_id'], ['tenant_memberships.tenant_id', 'tenant_memberships.user_id']),
        Index('uq_company_domain_active', 'tenant_id', 'website_domain', unique=True, postgresql_where=__import__('sqlalchemy').text('deleted_at IS NULL AND website_domain IS NOT NULL')),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('tenants.id'), index=True)
    name: Mapped[str] = mapped_column(String(255))
    country: Mapped[str | None] = mapped_column(String(100))
    industry: Mapped[str | None] = mapped_column(String(100))
    company_type: Mapped[str | None] = mapped_column(String(50))
    company_size: Mapped[str | None] = mapped_column(String(50))
    website: Mapped[str | None] = mapped_column(Text)
    website_domain: Mapped[str | None] = mapped_column(String(253))
    business_summary: Mapped[str | None] = mapped_column(Text)
    summary_source: Mapped[str | None] = mapped_column(Text)
    relationship_status: Mapped[str | None] = mapped_column(String(30))
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    source: Mapped[str | None] = mapped_column(String(50))
    version: Mapped[int] = mapped_column(Integer, default=1)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    updated_by: Mapped[uuid.UUID] = mapped_column(ForeignKey('users.id'))


class Contact(Base):
    __tablename__ = 'contacts'
    __table_args__ = (UniqueConstraint('tenant_id', 'id'), ForeignKeyConstraint(['tenant_id', 'company_id'], ['companies.tenant_id', 'companies.id']), Index('ix_contact_tenant_company', 'tenant_id', 'company_id'),
        Index('uq_contact_email_active', 'tenant_id', 'company_id', 'email', unique=True, postgresql_where=__import__('sqlalchemy').text('deleted_at IS NULL AND email IS NOT NULL')),
        Index('uq_contact_phone_active', 'tenant_id', 'company_id', 'phone', unique=True, postgresql_where=__import__('sqlalchemy').text('deleted_at IS NULL AND phone IS NOT NULL')),
        Index('uq_contact_whatsapp_active', 'tenant_id', 'company_id', 'whatsapp_id', unique=True, postgresql_where=__import__('sqlalchemy').text('deleted_at IS NULL AND whatsapp_id IS NOT NULL')))
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('tenants.id'))
    company_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    name: Mapped[str] = mapped_column(String(100))
    job_title: Mapped[str | None] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(50))
    whatsapp_id: Mapped[str | None] = mapped_column(String(100))
    preferred_language: Mapped[str | None] = mapped_column(String(30))
    contact_status: Mapped[str | None] = mapped_column(String(30))
    version: Mapped[int] = mapped_column(Integer, default=1)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    updated_by: Mapped[uuid.UUID] = mapped_column(ForeignKey('users.id'))


class AuditLog(Base):
    __tablename__ = 'audit_logs'
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('tenants.id'))
    actor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('users.id'))
    action: Mapped[str] = mapped_column(String(50))
    object_type: Mapped[str] = mapped_column(String(50))
    object_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    changed_fields: Mapped[list] = mapped_column(JSONB)
    changes: Mapped[dict | None] = mapped_column(JSONB)
    result: Mapped[str] = mapped_column(String(20), default='success')
    request_id: Mapped[str] = mapped_column(String(100))
    source: Mapped[str] = mapped_column(String(20))
    agent_run_id: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Idempotency(Base):
    __tablename__ = 'idempotency_keys'
    __table_args__ = (UniqueConstraint('tenant_id', 'actor_id', 'key'),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uid)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('tenants.id'))
    actor_id: Mapped[uuid.UUID] = mapped_column(ForeignKey('users.id'))
    key: Mapped[str] = mapped_column(String(128))
    request_hash: Mapped[str] = mapped_column(String(64))
    status_code: Mapped[int] = mapped_column(Integer)
    response: Mapped[dict] = mapped_column(JSONB)
