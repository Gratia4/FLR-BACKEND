# FLR Backend

Secure B2B API for FLR Ltd. Pharmaceutical Wholesale / Dépôt Pharmaceutique.

## Architecture

- Node.js 20+ and Express 5
- TypeScript
- PostgreSQL on Railway
- SQL migrations with no database credentials committed
- JWT authentication and role-based authorization
- Zod request validation

The Firebase frontend calls this service through its Railway public HTTPS domain. The API connects privately to PostgreSQL inside the same Railway project.

Build the Firebase frontend with `NEXT_PUBLIC_API_URL` set to the Railway API's public HTTPS URL. The browser cannot use a `railway.internal` address.

## Local setup

```bash
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev
```

Use Railway's public PostgreSQL TCP proxy URL for local development. Never commit `.env`.

## Railway setup

1. Add this GitHub repository as a new service in the same Railway project as PostgreSQL.
2. Add `DATABASE_URL` using a Railway reference variable to the Postgres service.
3. Add `JWT_SECRET` with at least 32 random characters.
4. Set `CORS_ORIGINS=https://flrltd-b432d.web.app`.
5. Generate a public domain for the API service.
6. Railway runs `npm run start:railway`, which applies pending migrations at runtime and starts the API.

After the first deployment, provision the first administrator once from the Railway service shell:

```bash
ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_NAME=... ADMIN_PHONE=... npm run create-admin
```

Remove those four one-time values after the command succeeds. Brand seeding is idempotent and runs automatically at startup.

Do not test private database connectivity during the image build: Railway private networking is available at runtime.

## API routes

| Method | Route | Access |
|---|---|---|
| GET | `/health` | Public |
| GET | `/ready` | Public readiness check |
| POST | `/api/v1/registrations` | Public, multipart form |
| POST | `/api/v1/auth/login` | Public |
| GET | `/api/v1/catalog/brands` | Public |
| GET | `/api/v1/catalog/brands/:slug/products` | Public, prices excluded |
| GET | `/api/v1/catalog/wholesale/products` | Approved authenticated users |
| POST | `/api/v1/orders` | Approved client |
| GET | `/api/v1/orders` | Approved client; own business only |
| GET | `/api/v1/admin/registrations` | Super Admin / Sales Manager |
| PATCH | `/api/v1/admin/registrations/:id/status` | Super Admin / Sales Manager |

## Security notes

- Passwords are hashed with bcrypt cost 12.
- Wholesale pricing never appears in public catalogue responses.
- Client login is rejected unless the business status is `APPROVED`.
- Order creation validates MOQ and stock within a database transaction.
- Authorization headers and passwords are redacted from logs.
- Registration file uploads are limited by type and size.
- Local filesystem uploads are an MVP adapter. Configure persistent object storage and malware scanning before accepting production documents.
- The first admin user should be provisioned through an audited one-time operational process, not a public endpoint.
