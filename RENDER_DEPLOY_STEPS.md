# FamilyCare Senior V1.0.62 Render

## Render Web Service
- Build Command: `npm install`
- Start Command: `npm start`

## Environment Variables
```text
NODE_ENV=production
DATABASE_URL=<Internal Database URL from Render PostgreSQL>
PGSCHEMA=familycare
MAIN_BASE_URL=https://familycare-main.onrender.com
SENIOR_PIN=2829
```

## Database
Folosește aceeași bază PostgreSQL ca aplicația Main. Rulează `postgresql_schema.sql` o singură dată, nu separat pentru fiecare aplicație.

## Mobil / PWA
După deploy, deschizi URL-ul Senior pe telefon și alegi `Install app` / `Add to Home screen`.
