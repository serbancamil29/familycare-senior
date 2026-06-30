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

---

# FamilyCare Senior V1.0.62 Universal PWA

Aceeași aplicație Senior este adaptată pentru desktop, laptop, tabletă și telefon, inclusiv Realme și Samsung.

## Pornire

- Numai pe PC: rulează `START_FAMILYCARE_SENIOR.bat`.
- PC + telefoane/tablete în aceeași rețea Wi-Fi: rulează `START_FAMILYCARE_SENIOR_NETWORK.bat`.
- Instrucțiuni Android și instalare PWA: `MOBILE_TABLET_SETUP.md`.

## Ce aduce V1.0.62

- Culoarea configurată pentru senior este folosită atât la selectorul de sus, cât și la cardul mare de confirmare.
- Layout unificat pe containere; rândurile, minicardurile și textele se adaptează la lățimea și înălțimea ferestrei.
- Ora duplicată de sub cardurile din Program a fost eliminată.
- Ecranul Senior se compactează pe telefon și în ferestre înguste astfel încât toate zonele principale să rămână vizibile simultan.
- Controalele de sus, zilele, programul, confirmările și cele trei acțiuni rămân accesibile în portret și landscape.
- Carduri Senior cu fundal și text configurabile din aplicația Main.
- Aranjare automată pentru 1–4+ seniori: un rând pe ecrane late și grilă 2×2 pe telefon pentru patru seniori.
- PWA instalabilă separat ca „FamilyCare Senior”.
- Layout universal portret/landscape, safe-area pentru notch și butoane mari.
- PIN verificat pe server și sesiune cu expirare.
- Service worker numai pentru interfață; confirmările și tratamentele cer conexiune la server.
- Certificat local cu SAN pentru localhost, numele PC-ului și adresele IPv4 active.
- Mod Network separat și regulă firewall opțională pentru rețeaua Private.
- Păstrează protecțiile HTTPS și API din V1.0.57.

## Limită de securitate

Modul Network este pentru o rețea Wi-Fi privată. Nu publica portul 31001 direct pe internet.

Vezi `RESPONSIVE_TEST_MATRIX.md` pentru dimensiunile verificate și pașii de test pe dispozitiv fizic.
