# FORM Fitness

Private gym membership management running entirely on this computer. The app binds to loopback and stores its data in `.local/form-fitness.json`. It does not use Supabase, cloud hosting, or external email delivery.

## Architecture

- `public/`: local HTML, CSS, JavaScript and licensed QR libraries.
- `src/dev.js`: loopback-only HTTP server.
- `src/local-api.js`: local authentication, membership, payment and check-in API.
- `src/local-store.js`: atomic local file persistence and password hashing.

Persistent features include profiles, plans, membership cycles, invoices, partial payments, receipt review, signed member passes, check-ins, dashboards and notification records. Prices and payment balances use integer centavos. Staff must verify funds and identity; submitting a receipt or scanning a QR never pays an invoice automatically.

## Windows and VS Code

Install Node.js 22 or later and open this folder in VS Code. Run in PowerShell:

```powershell
npm ci
npm run check
npm test
npm start
```

Open http://localhost:4173. On first launch, create the local administrator account in the browser. Subsequent runs use the same account and records. The server listens only on `127.0.0.1`; it is not accessible to other devices on the network.

Passwords are stored as salted hashes and login sessions are local, HTTP-only cookies. Back up `.local/form-fitness.json` while the server is stopped to preserve records. It contains private member data and should not be shared. There is no automated cloud backup or email password recovery; the local administrator must assist with account recovery.

The first local run starts with an empty data file. Existing hosted records are not imported, and the remote Supabase project is not changed by this app.

Member account creation, invoices, partial payments, payment review, plan management, local notifications, member passes, and staff-confirmed check-ins are stored locally. No payment processor is connected; staff must verify funds manually.
