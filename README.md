# FactoryFlow — hardened factory management source

FactoryFlow covers production (extrusion, cutting and printing), raw/finished inventory, numbered individual rolls, customer and staff sales orders, Paystack and offline receipts/refunds, staff/HR/payroll, and aggregate analytics. Built with React 19, Vite, TypeScript, Zustand, Tailwind and Supabase Postgres/Auth/Edge Functions. Currency is GHS and staff time is interpreted as Africa/Accra.

**Read [DEPLOYMENT.md](DEPLOYMENT.md) before running migrations or using real money.** This archive is a source-level implementation, **not** a completed live deployment or an assurance of production security. The independent audit identified unsafe auth/payment/stock behavior in the original migrations; new migrations `017`–`021` harden the database and move critical workflows into role-checked transactions.

## Local development

```bash
cd frontend
cp .env.example .env
# Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY only
npm ci
npm run dev
```

Do not place a Paystack **secret**, Supabase `service_role` credential or scheduler token in the browser `.env` or a `VITE_` variable. Paystack checkouts and staff invitations use server-side Supabase Edge Functions. Copy `supabase/migrations/` into a **staging** Supabase project, apply sequentially and deploy the named functions as detailed in the deployment guide.

## Quality checks

```bash
cd frontend
npm run typecheck
npm run lint
npm run test
npm run build
```

`npm run check` runs all four. CI also runs an online dependency advisory check. Seven local source/unit tests are included. Live Postgres migrations, role/RLS integration tests, Paystack settlement and refund tests, browser E2E, production build from a clean dependency install, load testing and CSP acceptance **still need staging validation**. See [TEST_PLAN.md](TEST_PLAN.md).

## Major changes

- No client-supplied privileged signup role; administrator invite and staff role controls.
- Direct mutation of order/payment/stock/production ledgers revoked; guarded database RPC workflows.
- Atomic production runs and formula stock debits; physical roll selection for order and conversion usage.
- Verified Paystack hosted checkout/webhook, replay-proof receipts, verified refunds and reconciliation endpoint.
- Admin-only offline refunds and audit records; customer editing/cancellation before confirmation.
- Measured physical-roll reconciliation UI for legacy inventory, without double-crediting stock.
- HR attendance with overnight time support, payroll from attendance, improved dashboard units/periods.
- Accessible table/dialog fixes, UI error states, bounded queries, TypeScript/ESLint tests and CI, Netlify/Vercel headers.

## Project layout

`frontend/` — React SPA, local tests, Netlify/Vercel configs.  
`supabase/migrations/` — all 21 ordered SQL migrations; this clean-install archive uses timestamped CLI-compatible filenames corresponding to logical migrations 001–021.  
`supabase/functions/` — verified payment, refund, staff invitation and reconciler Edge functions.  
`scripts/preflight.sql`, `scripts/postflight.sql` — read-only migration and privilege sanity checks.  
`DEPLOYMENT.md`, `SECURITY.md`, `TEST_PLAN.md` — release, privacy, and integration checklists.
