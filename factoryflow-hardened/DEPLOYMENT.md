# FactoryFlow — staged deployment / migration runbook

## Release status

This repository is **implementation-complete as a source patch** but **NOT validated for live production**. The reviewer could compile TypeScript, lint it, run seven local Node tests, and inspect SQL/Edge code. **No Postgres database, Paystack test account, Deno runtime, staging deployment or browser E2E environment were available.** You must run the steps below in staging and repair any migration/data-incompatibility issues before switching traffic. Back up your live database and media first; do NOT casually reapply migrations already deployed.

## 1. Required safeguards before migration

1. Schedule a maintenance window, put the current deployed site into read-only mode, and take a point-in-time database backup that you have tested restoring.
2. Clone the live project to an isolated Supabase staging project with sanitized customer and employee data. Use **Paystack test keys** only in staging.
3. Run `scripts/preflight.sql` against the current database. Manually review unexpected privileged users, previously inserted Paystack references against the Paystack dashboard, conflicting employee profiles, amount_paid > total, old payroll anomalies and roll inventory. Do not automatically delete historical data to make checks pass.
4. Confirm migrations **001 through 016** match your actual database history. They are included for completeness. On an existing installation, apply only the new, **ordered migrations 017, 018, 019, 020, 021** once. Fresh projects need all 21 migrations in order. In this clean-install package, their **filenames have been normalized to 14-digit timestamp prefixes** so the CLI can track them; logical migration numbers 001–021 remain the same. Do not use this renamed set for an already-migrated project without reconciling its migration history.
5. A confirmed order with an unresolved Paystack checkout cannot be cancelled until the attempt is reconciled. This avoids cancelling an order while a delayed provider settlement is still possible. A support review may be required for abandoned attempts.
6. If legacy records violate the new constraints, repair them via a documented, approved data-cleaning migration on a copy. `017` may reject duplicate employee profiles or invalid balances; `019` may reject multiple open clock sessions.
6. Review the already-granted admin accounts. New public registrations are **always customers**, regardless of the user-supplied metadata `role`. Invite new staff from Settings as an existing admin. Bootstrap the first admin using an out-of-band SQL Editor session; never expose a signup role selector.

### Database deployment

With the Supabase CLI authenticated and linked to a **staging** project, use your normal migration workflow:

```bash
supabase db push
```

Or execute the ordered SQL files in the Supabase SQL Editor against staging if CLI history does not match. Never blindly replay older migrations on a populated database. After running, execute `scripts/postflight.sql` and review privilege results. Unprivileged users must not be able to invoke `record_stock_movement`, `settle_verified_paystack`, `reserve_paystack_refund`, or `complete_paystack_refund`.

## 2. Deploy server functions

```bash
supabase functions deploy paystack-payment
supabase functions deploy paystack-webhook --no-verify-jwt
supabase functions deploy paystack-refund
supabase functions deploy reconcile-payments --no-verify-jwt
supabase functions deploy admin-invite-staff
```

Set secrets using Supabase project secret management; **never** place them in `.env` committed to Git or any `VITE_` prefixed variable:

| Edge function secret | Purpose |
|---|---|
| `SUPABASE_URL` | Project URL (normally automatically provided) |
| `SUPABASE_ANON_KEY` | Publishable anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only database administrator credential |
| `PAYSTACK_SECRET_KEY` | Paystack test/live secret (`sk_...`) |
| `PAYSTACK_WEBHOOK_SIGNING_SECRET` | New Paystack webhook secret (`whsec_...`), if enabled |
| `SITE_URL` | Exact SPA origin, e.g. `https://factory.example.com` |
| `ALLOWED_ORIGINS` | Comma-separated authorized SPA origins (staging/live separate) |
| `PAYMENT_RECONCILE_TOKEN` | Unique random 32+-character scheduler bearer token |

**Paystack:** In the Paystack dashboard configure the webhook URL as `https://<project-ref>.supabase.co/functions/v1/paystack-webhook`. Both the timestamped `Paystack-Signature` and legacy `x-paystack-signature` are handled. Webhook signature checks are mandatory and the handler verifies transaction or refund status with Paystack again before crediting the database. Hosted checkout uses `https://checkout.paystack.com/` and callback to `SITE_URL`. Paystack processing may be asynchronous; a refund request is **not** a refund completion.

**Reconciliation:** Schedule an HTTPS POST to `.../functions/v1/reconcile-payments` about every 15 minutes with `Authorization: Bearer <PAYMENT_RECONCILE_TOKEN>`. This endpoint validates its separate high-entropy bearer secret, checks up to 40 pending payments and 40 pending refunds each call, and never credits an unverified attempt. Monitor failed counts. Alternatively have an administrator press **Check provider** on a pending refund in Sales.

## 3. Deploy the frontend

Node.js **22** recommended (matches CI/test runner). Netlify: base `frontend`, build command `npm ci && npm run build`, publish `frontend/dist` (when base directory is `frontend`, publish `dist`). Vercel: root directory `frontend`; build `npm run build`, output `dist`. Security headers and SPA rewrites are supplied in both `frontend/public/_headers` (Netlify) and `frontend/vercel.json` (Vercel). Review CSP in the browser console before launch.

```bash
cd frontend
cp .env.example .env
# Set the PUBLIC project URL + anon key only; NEVER put secrets here
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

The provided archive's installed node_modules had only Windows Rollup binaries, so the reviewer could not build **in the Linux audit environment**. A clean `npm ci` on a supported OS downloads the correct optional package; CI verifies that. Do not include `node_modules` or `.env` in release ZIPs. The source ZIP you received excludes both.

## 4. Inventory reconciliation

1. Before going live, run `SELECT * FROM public.roll_stock_discrepancies;`.
2. For any old roll product with positive missing count, the factory supervisor must physically count **and individually weigh** those rolls. In Inventory > Finished Goods, click **Reconcile N rolls** and enter the exact measured weights. The RPC will not increase aggregate stock; it only creates the missing physical records.
3. If counted physical rolls exceed recorded aggregate stock (negative discrepancy), investigate; do not invent weight values. A documented corrective stock operation must be designed and approved for that case.
4. When recording a new roll-counted production output, enter the weight of **each** roll. When a conversion consumes roll-counted input, select the physical input roll IDs; the run marks them `consumed` and records the run ID. Never adjust roll aggregate stock via the generic manual adjustment dialog.
5. Review `production_run_materials` and `stock_movements` against a few known stock/production records. Historic aggregate stock might need a manual opening-balance review.

## 5. Critical staging acceptance gates

Run every scenario in `TEST_PLAN.md`, including negative RLS tests, two simultaneous roll reservations, empty staff orders, invalid material posting rollback, Paystack mismatch/fake payment and duplicate webhook, a real *test* refund through `refund.processed`, overnight attendance, payroll reconciliation, full and partial refunds, profile role self-edit failure, and CSP/header inspection. Confirm each transaction and expected Postgres side-effect on staging. Test recovery from network failures and restore your database backup. No production credentials are present in this ZIP.

## 6. Post-release operations

- Monitor Supabase Edge Function and Postgres logs, delayed webhooks, reconciliation-job error counts, underflow stock rejections, and failed login attempts.
- Back up daily, test restores quarterly, document PII retention and access reviews (`SECURITY.md`), audit account roles monthly and reconcile payment processor statements with the immutable receipt/refund ledgers.
- Use lower-privileged roles for staff; review admin role requests out of band. Establish a refunds/returns SOP for already dispatched merchandise.
- Do not turn on production payments until live webhook and edge secrets are configured, security checks pass and your first staging Paystack transaction is verified end to end.
