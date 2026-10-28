"""Create the first local tenant and administrator. Run inside the API container."""
import getpass
from sqlalchemy import select
from app.database import SessionLocal
from app.models import Tenant, User, Membership
from app.security import passwords

def main():
    tenant_name = input('Tenant name: ').strip()
    name = input('Administrator name: ').strip()
    email = input('Administrator email: ').strip().lower()
    password = getpass.getpass('Password (at least 12 characters): ')
    if not tenant_name or not name or '@' not in email or len(password) < 12:
        raise SystemExit('Invalid input')
    with SessionLocal() as db:
        if db.scalar(select(User.id).where(User.email == email)):
            raise SystemExit('User already exists')
        tenant = Tenant(name=tenant_name)
        user = User(name=name, email=email, password_hash=passwords.hash(password))
        db.add_all([tenant, user]); db.flush()
        db.add(Membership(tenant_id=tenant.id, user_id=user.id, role='admin'))
        db.commit()
        print(f'Tenant ID: {tenant.id}')

if __name__ == '__main__': main()
