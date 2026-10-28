import os
os.environ.setdefault('DATABASE_URL', 'postgresql+psycopg://crm:crm@localhost/crm')
import pytest
from pydantic import ValidationError
from app.schemas import CompanyFields, CompanyPatch, ContactFields, ContactPatch
from app.service import domain


def test_domain_normalization():
    assert domain('https://WWW.Example.COM./path') == 'example.com'


def test_untrusted_fields_are_rejected():
    with pytest.raises(ValidationError): CompanyFields(name='A', tenant_id='forged')
    with pytest.raises(ValidationError): CompanyPatch(expected_version=1, user_id='forged')


def test_contact_requires_channel_and_normalizes():
    with pytest.raises(ValidationError): ContactFields(name='A')
    with pytest.raises(ValidationError): ContactFields(name='A', whatsapp_id=' ')
    contact = ContactFields(name='A', email='SALES@EXAMPLE.COM', phone='+1 (202) 555-0100')
    assert contact.email == 'sales@example.com'
    assert contact.phone == '+12025550100'


def test_patch_rejects_non_international_phone():
    with pytest.raises(ValidationError): ContactPatch(expected_version=1, phone='123')
