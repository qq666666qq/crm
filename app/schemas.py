import re
import uuid
from typing import Literal
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Login(Strict):
    email: EmailStr
    password: str = Field(min_length=1, max_length=1024)


class MemberCreate(Strict):
    email: EmailStr
    name: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=12, max_length=1024)
    role: Literal['admin', 'manager', 'sales']


class MemberPatch(Strict):
    role: Literal['admin', 'manager', 'sales'] | None = None
    status: Literal['active', 'inactive'] | None = None


class MemberAttach(Strict):
    user_id: uuid.UUID
    role: Literal['admin', 'manager', 'sales']


class Restore(Strict):
    expected_version: int = Field(ge=1)


class CompanyFields(Strict):
    name: str = Field(min_length=1, max_length=255)
    country: str | None = Field(default=None, max_length=100)
    industry: str | None = Field(default=None, max_length=100)
    company_type: str | None = Field(default=None, max_length=50)
    company_size: str | None = Field(default=None, max_length=50)
    website: str | None = Field(default=None, max_length=2048)
    business_summary: str | None = Field(default=None, max_length=10000)
    summary_source: str | None = Field(default=None, max_length=2048)
    relationship_status: str | None = Field(default=None, max_length=30)
    owner_id: uuid.UUID | None = None
    source: str | None = Field(default=None, max_length=50)

    @field_validator('website')
    @classmethod
    def valid_website(cls, value):
        if value is not None:
            parsed = urlsplit(value)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError('website must be an HTTP(S) URL without credentials')
        return value


class CompanyPatch(Strict):
    expected_version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=255)
    country: str | None = Field(default=None, max_length=100)
    industry: str | None = Field(default=None, max_length=100)
    company_type: str | None = Field(default=None, max_length=50)
    company_size: str | None = Field(default=None, max_length=50)
    website: str | None = Field(default=None, max_length=2048)
    business_summary: str | None = Field(default=None, max_length=10000)
    summary_source: str | None = Field(default=None, max_length=2048)
    relationship_status: str | None = Field(default=None, max_length=30)
    owner_id: uuid.UUID | None = None
    source: str | None = Field(default=None, max_length=50)
    _validate_website = field_validator('website')(CompanyFields.valid_website.__func__)


class ContactFields(Strict):
    name: str = Field(min_length=1, max_length=100)
    job_title: str | None = Field(default=None, max_length=100)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50)
    whatsapp_id: str | None = Field(default=None, max_length=100)
    preferred_language: str | None = Field(default=None, max_length=30)
    contact_status: str | None = Field(default=None, max_length=30)

    @field_validator('whatsapp_id')
    @classmethod
    def whatsapp_not_blank(cls, value):
        if value is not None and not value.strip(): raise ValueError('whatsapp_id cannot be blank')
        return value.strip().casefold() if value else None

    @field_validator('phone')
    @classmethod
    def normalize_phone(cls, value):
        if value is None: return None
        value = re.sub(r'[\s().-]', '', value)
        if not re.fullmatch(r'\+[1-9]\d{7,14}', value):
            raise ValueError('phone must be in international E.164 form')
        return value

    @field_validator('email')
    @classmethod
    def normalize_email(cls, value): return value.lower() if value else None

    @model_validator(mode='after')
    def reachable(self):
        if not (self.email or self.phone or self.whatsapp_id): raise ValueError('at least one contact channel is required')
        return self


class ContactPatch(Strict):
    expected_version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=100)
    job_title: str | None = Field(default=None, max_length=100)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50)
    whatsapp_id: str | None = Field(default=None, max_length=100)
    preferred_language: str | None = Field(default=None, max_length=30)
    contact_status: str | None = Field(default=None, max_length=30)
    _phone = field_validator('phone')(ContactFields.normalize_phone.__func__)
    _email = field_validator('email')(ContactFields.normalize_email.__func__)
    _whatsapp = field_validator('whatsapp_id')(ContactFields.whatsapp_not_blank.__func__)
