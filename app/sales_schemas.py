from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator, create_model
from app.schemas import CompanyFields, ContactFields


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)

    @field_validator('*', mode='after')
    @classmethod
    def aware_datetime(cls, value):
        if isinstance(value, datetime):
            if value.tzinfo is None or value.utcoffset() is None: raise ValueError('Datetime must include a timezone')
            return value.astimezone(timezone.utc)
        return value


class EvidenceIn(Strict):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=False)
    evidence_type: Literal['quote', 'manual']
    source_type: str = Field(min_length=1, max_length=30)
    source_id: str | None = Field(default=None, min_length=1, max_length=255)
    source_uri: str | None = Field(default=None, max_length=2048)
    source_snapshot_text: str | None = None
    original_quote: str | None = None
    manual_note: str | None = None
    quote_start: int | None = Field(default=None, ge=0)
    quote_end: int | None = Field(default=None, ge=0)
    source_at: datetime | None = None

    @model_validator(mode='after')
    def check_evidence(self):
        if self.evidence_type == 'manual':
            if not self.manual_note or not self.manual_note.strip() or self.source_type.lower() != 'manual': raise ValueError('Manual evidence requires a manual note and manual source')
        elif not self.original_quote or not self.original_quote.strip():
            raise ValueError('Quote evidence requires the original quote')
        if (self.quote_start is None) != (self.quote_end is None): raise ValueError('Both quote offsets are required')
        if self.quote_start is not None:
            if self.source_snapshot_text is None or self.quote_end <= self.quote_start or self.source_snapshot_text[self.quote_start:self.quote_end] != self.original_quote: raise ValueError('Offsets must match the quote in the snapshot')
        return self


class LeadData(Strict):
    company_id: UUID | None = None
    contact_id: UUID | None = None
    company_name_raw: str | None = Field(default=None, max_length=255)
    contact_name_raw: str | None = Field(default=None, max_length=100)
    contact_email: EmailStr | None = None
    contact_phone: str | None = Field(default=None, max_length=50)
    title: str = Field(min_length=1, max_length=255)
    source: str = Field(min_length=1, max_length=30)
    product_interest: str | None = None
    requirement_notes: str | None = None
    estimated_quantity: Decimal | None = Field(default=None, gt=0, max_digits=20, decimal_places=4)
    quantity_unit: str | None = Field(default=None, max_length=30)
    budget_amount: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=4)
    budget_currency: str | None = Field(default=None, pattern='^[A-Z]{3}$')
    intent_level: Literal['unknown', 'low', 'medium', 'high'] = 'unknown'
    owner_id: UUID | None = None

    @model_validator(mode='after')
    def money(self):
        if self.budget_amount is not None and not self.budget_currency: raise ValueError('Budget currency is required')
        return self


class LeadCreate(LeadData):
    evidence: list[EvidenceIn] = Field(min_length=1)


class OpportunityData(Strict):
    company_id: UUID
    name: str = Field(min_length=1, max_length=255)
    product_summary: str | None = None
    requirement_notes: str | None = None
    expected_amount: Decimal | None = Field(default=None, ge=0, max_digits=20, decimal_places=4)
    currency: str | None = Field(default=None, pattern='^[A-Z]{3}$')
    owner_id: UUID | None = None

    @model_validator(mode='after')
    def money(self):
        if self.expected_amount is not None and not self.currency: raise ValueError('Currency is required')
        return self


class TaskData(Strict):
    company_id: UUID | None = None
    lead_id: UUID | None = None
    opportunity_id: UUID | None = None
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    assigned_to: UUID | None = None
    due_at: datetime
    remind_at: datetime | None = None
    priority: Literal['low', 'normal', 'high'] = 'normal'

    @model_validator(mode='after')
    def relation(self):
        if not (self.company_id or self.lead_id or self.opportunity_id): raise ValueError('At least one business object is required')
        return self


class ActivityData(Strict):
    company_id: UUID | None = None
    contact_id: UUID | None = None
    lead_id: UUID | None = None
    opportunity_id: UUID | None = None
    follow_up_task_id: UUID | None = None
    activity_type: Literal['email', 'phone', 'whatsapp', 'meeting', 'note']
    direction: Literal['inbound', 'outbound'] | None = None
    subject: str | None = Field(default=None, max_length=255)
    summary: str = Field(min_length=1)
    outcome: str | None = None
    occurred_at: datetime

    @model_validator(mode='after')
    def relation(self):
        if not (self.company_id or self.contact_id or self.lead_id or self.opportunity_id or self.follow_up_task_id): raise ValueError('At least one business object is required')
        return self


class Version(Strict):
    expected_version: int = Field(ge=1)


class Reason(Version):
    reason: str = Field(min_length=1)


class Note(Version):
    note: str | None = None


class Stage(Version):
    stage: Literal['discovery', 'quoting', 'negotiating']


class Convert(Version):
    company_id: UUID | None = None
    company_new: CompanyFields | None = None
    contact_id: UUID | None = None
    contact_new: ContactFields | None = None
    name: str = Field(min_length=1, max_length=255)

    @model_validator(mode='after')
    def exclusive_choices(self):
        if self.company_id and self.company_new: raise ValueError('Choose an existing company or a new company')
        if self.contact_id and self.contact_new: raise ValueError('Choose an existing contact or a new contact')
        if self.company_new and self.contact_id: raise ValueError('An existing contact cannot belong to a newly created company')
        return self


class ContactLink(Strict):
    contact_id: UUID
    is_primary: bool = False
    role_note: str | None = Field(default=None, max_length=255)


def patch_model(name, base, versioned=True):
    fields = {key: (info.annotation | None, None) for key, info in base.model_fields.items()}
    if versioned: fields['expected_version'] = (int, Field(ge=1))
    return create_model(name, __base__=Strict, **fields)


LeadPatch = patch_model('LeadPatch', LeadData)
OpportunityPatch = patch_model('OpportunityPatch', OpportunityData)
TaskPatch = patch_model('TaskPatch', TaskData)
ActivityPatch = patch_model('ActivityPatch', ActivityData, False)
