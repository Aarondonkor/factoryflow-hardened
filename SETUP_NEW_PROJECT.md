# FactoryFlow Hardened — clean three-service installation (Windows / GitHub / Supabase / Netlify)

This is for your **NEW, EMPTY Supabase project** and **NEW GitHub repository**, not an upgrade of the original production application. The existing project stays untouched. Do not reuse old Paystack live keys while testing.

## A. Place the files in the new GitHub repository

1. Extract this ZIP. The inner folder is called `factoryflow-hardened`.
2. Open/clone your new GitHub repository on your PC. Copy the **contents** of the extracted `factoryflow-hardened` folder into the **root** of that Git repository (so `frontend/`, `supabase/`, `netlify.toml`, and `README.md` are at the repo root). Do not create an additional `factoryflow-hardened/factoryflow-hardened/` nesting level. Copy the hidden `.gitignore` file too.
3. In PowerShell, from your Git repository root:

```powershell
git add .
git commit -m "Deploy FactoryFlow Hardened source"
git push origin main
```

Use your repository's actual branch if it is not named `main`. No `.env` or secret key belongs in Git.

## B. Install all database migrations into the NEW Supabase project

Find your project reference in the Supabase project URL: `https://<PROJECT_REF>.supabase.co`. Find the database password in the project setup or database settings (reset if forgotten). From the repository **root** (the folder with `supabase/config.toml`) use PowerShell:

```powershell
node --version
npx supabase login
npx supabase link --project-ref YOUR_NEW_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

Node.js 22 is recommended. The first `npx` call may prompt to install the Supabase CLI. If the project is fresh, the migration plan should cover all **21** timestamped files, from `20261108000001_initial_schema.sql` through `20261108000021_consumed_roll_traceability.sql`. These correspond to the original logical migrations **001–021**. The filenames have been normalized to Supabase CLI timestamp format **for this brand-new project only**; do not replace migration filenames in a database that has already applied them. Do not run `supabase init` (the project already contains `supabase/config.toml`). If any migration fails, **STOP** and inspect the exact SQL error rather than skipping or re-running arbitrary statements.

Open Supabase **SQL Editor** and run the contents of `scripts/postflight.sql` to inspect authorization and tables. A missing physical-roll reconciliation record is only expected when migrating old data; a truly empty project should have no old rolls.

## C. Create the FIRST admin user

Supabase Dashboard → Authentication → Users → Add user → Create new user. Enter your own admin email and a long unique password. The database signup trigger safely creates a **customer** role by default. After the user appears, go to SQL Editor and execute the following, replacing the sample email:

```sql
BEGIN;
UPDATE public.profiles
SET role = 'admin'
WHERE id = (SELECT id FROM auth.users WHERE lower(email) = lower('your-admin-email@example.com'));
DELETE FROM public.customers
WHERE owner_profile_id = (SELECT id FROM auth.users WHERE lower(email) = lower('your-admin-email@example.com'))
  AND NOT EXISTS (SELECT 1 FROM public.orders WHERE customer_id = public.customers.id);
COMMIT;
SELECT id, email, role FROM public.profiles WHERE lower(email) = lower('your-admin-email@example.com');
```

The SELECT must return exactly one row with role `admin`. This one-time SQL Editor step is only for the **first** admin. Add future staff through the admin invitation workflow. Never expose administrator creation to public signup.

## D. Deploy the Netlify frontend

Netlify → Add new project → Import an existing project → GitHub → select your new `factoryflow-hardened` repository. The included root `netlify.toml` sets:

- Base directory: `frontend`
- Build command: `npm run check` (typecheck, lint, tests, then Vite build)
- Publish directory: `dist` (relative to `frontend`)
- Node version: 22

Before you publish a working site, in Netlify → Project configuration → Environment variables, add **only public browser credentials** from your NEW Supabase project:

```text
VITE_SUPABASE_URL = https://YOUR_NEW_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY = YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

The frontend requires these at **build time**: after adding/changing them, trigger a new Netlify deployment. Never store the `service_role` key or Paystack secret here. Confirm the Netlify site opens `/login` and is not a blank page.

Supabase → Authentication → URL Configuration: set the **Site URL** to your new `https://...netlify.app` URL; add that same origin and allowed callback routes to the redirect allow list, according to your auth/email configuration. If email confirmation is enabled, configure an email provider and test the confirmation workflow.

## E. Deploy backend Edge Functions

From the same Git repository root:

```powershell
npx supabase functions deploy admin-invite-staff
npx supabase functions deploy paystack-payment
npx supabase functions deploy paystack-refund
npx supabase functions deploy paystack-webhook --no-verify-jwt
npx supabase functions deploy reconcile-payments --no-verify-jwt
```

In Supabase → Edge Functions → Secrets, set the following for this **NEW** project:

```text
SITE_URL = https://YOUR_NEW_SITE.netlify.app
ALLOWED_ORIGINS = https://YOUR_NEW_SITE.netlify.app
PAYSTACK_SECRET_KEY = sk_test_...  (only when ready for Paystack TEST payments)
PAYSTACK_WEBHOOK_SIGNING_SECRET = whsec_... (if provided by Paystack)
PAYMENT_RECONCILE_TOKEN = a separate random 32+ character secret (for scheduled reconciliation)
```

Supabase supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` as platform-managed environment variables for hosted Edge Functions. Do not put the service-role key in Netlify. For payment tests, configure Paystack's webhook endpoint:

```text
https://YOUR_NEW_PROJECT_REF.supabase.co/functions/v1/paystack-webhook
```

`reconcile-payments` is intentionally not a public user endpoint. Configure a secret-bearing HTTPS scheduler only after you have confirmed the token and the function, or use the existing admin manual provider check while testing. Do not treat an unconfirmed payment as paid.

## F. Test before using the new app with real operations

1. Sign in using the admin created in section C and confirm Dashboard, Production, Inventory, Sales, HR, and Settings load.
2. Add a test material and finished-good product; create a test machine.
3. Record a test production run and verify the input stock is deducted **once**, the output stock is added **once**, and the movements are logged.
4. Create a pending customer order and verify staff confirmation precedes payment; test cancel/edit only while pending.
5. Use Paystack **test mode** to verify one checkout, one webhook, duplicate webhook safety, and a refund, then reconcile receipts.
6. Review `TEST_PLAN.md` for further authorization, race-condition, roll-traceability, HR and reporting checks.

**Important:** A new Supabase project starts with **no existing production data**. Inventory, customers, machines, staff and historical orders from your old project do NOT appear automatically. Do not bulk import the old database into the new schema without a separate reviewed migration and verification of payments, roles, and stock.

## Local preview (optional)

```powershell
cd frontend
Copy-Item .env.example .env
# Edit the .env file with ONLY the NEW public Supabase URL and public key.
npm ci
npm run check
npm run dev
```

**When something fails:** Copy the exact CLI or Netlify build error message (redact all credentials) and troubleshoot that stage. Do not run database reset commands against a deployed project.
