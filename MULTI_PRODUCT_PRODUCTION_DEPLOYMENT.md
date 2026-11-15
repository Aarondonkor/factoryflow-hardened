# FactoryFlow Hardened — Multi-Product Production Logging

Target repository: `https://github.com/Aarondonkor/factoryflow-hardened`
Target Supabase project: `dsnqcexijpcvckdcfser`

## Feature

The **Log Production Run** dialog still accepts one primary product, and now includes **Additional Products → + Add Product** for up to 19 extra output lines (20 products total). Each output has its own product, batch ID, unit-specific quantity (including individual physical roll weights), quality grade, thickness, width and colour. The machine, shift, operator, consumed materials or input rolls, waste, and other run-wide parameters are shared.

- On an **extrusion** machine, all outputs must be **semi-finished** products.
- On a **conversion** machine, all outputs must be **finished** products.
- It is valid to enter the same product twice using distinct batch IDs, if produced as separate batches within the run.
- Stock is credited once for **each** output. The input formula or selected semi-finished input rolls are deducted **once** for the entire run.
- Individual rolls generated from additional outputs are linked to the shared production run AND their particular output line. Admin inventory roll search returns their **own batch ID** and original run date. A blank batch ID remains unrecorded, not borrowed from the first product.
- Production history and dashboard output metrics include additional outputs. Single-product production logs remain supported without requiring changes to old records.

## Files changed

1. `supabase/migrations/20261115000025_multi_product_production.sql` — NEW SQL migration.
2. `frontend/src/pages/production/ProductionRunForm.tsx` — multi-output form and atomic RPC.
3. `frontend/src/pages/production/ProductionPage.tsx` — show all output lines, include them in summaries.
4. `frontend/src/types/database.ts` — types for additional output lines.
5. `frontend/tests/multi-product-production.test.mjs` — NEW regression checks.

## Deployment (Windows PowerShell)

**Before extracting the patch:** Save a backup and ensure the local repository is clean or that you have reviewed local changes. Extract the patch into the **Git-connected repository root**, preserving folders:

`C:\Users\sally\Projects\factoryflow-hardened-git`

1. Inspect your current migration history:

   ```powershell
   cd C:\Users\sally\Projects\factoryflow-hardened-git
   npx.cmd supabase migration list --remote
   ```

2. Verify the new SQL file exists:

   ```powershell
   Test-Path .\supabase\migrations\20261115000025_multi_product_production.sql
   ```

3. **Preview** migrations targeting the cloud project:

   ```powershell
   npx.cmd supabase db push --remote --dry-run
   ```

   Expected: the new `20261115000025` migration is pending. If prior migrations (such as 024) are also pending, review them before applying. Do **not** reset your database or replay old migrations.

4. If the preview is correct, apply migrations:

   ```powershell
   npx.cmd supabase db push --remote
   ```

   If SQL fails, stop; send the exact error output before trying anything else. Do not run SQL twice manually and via CLI.

5. Check the RPC signature in **Supabase SQL Editor**:

   ```sql
   SELECT
     to_regclass('public.production_run_additional_outputs') AS output_lines,
     to_regprocedure('public.post_multi_production_run(jsonb,jsonb,jsonb)') AS posting_rpc,
     to_regprocedure('public.search_inventory_rolls(text,text,integer,integer)') AS roll_search_rpc;
   ```

   All three should be non-NULL. Refresh PostgREST schema metadata only if necessary:

   ```sql
   NOTIFY pgrst, 'reload schema';
   ```

6. Verify frontend checks (npm dependencies need to be installed in this clone):

   ```powershell
   cd .\frontend
   npm.cmd ci --include=dev
   npm.cmd run check
   cd ..
   ```

7. Review the commit, then push:

   ```powershell
   git status --short
   git add supabase/migrations/20261115000025_multi_product_production.sql frontend/src/pages/production/ProductionRunForm.tsx frontend/src/pages/production/ProductionPage.tsx frontend/src/types/database.ts frontend/tests/multi-product-production.test.mjs MULTI_PRODUCT_PRODUCTION_DEPLOYMENT.md
   git commit -m "Add atomic multi-product production logging"
   git push origin main
   ```

   Netlify should rebuild automatically. If your previous Supabase migrations are not yet applied, complete them before using the new frontend.

## Manual acceptance tests (preferably staging)

1. **Single output compatibility:** Log one semi-finished roll product, confirm normal stock credit and one physical `product_rolls` record per measured roll.
2. **Multi extrusion:** One machine/shift, two semi-finished roll products (for example, 3 rolls of A and 2 rolls of B) and one shared raw-material formula. Confirm each output product has exactly its own 3/2 rolls, raw materials deducted only once, and production history lists both output products.
3. **Multi conversion:** Choose available semi-finished input rolls; produce two finished product outputs with individual weights and batch IDs. Confirm input rolls are marked consumed exactly once and finished inventory is credited correctly.
4. **Roll traceability:** Search and open one physical roll from the *second* output. Its batch ID must match that second line; date/shift/machine/operator must match the shared run.
5. **Rollback:** Try to log a multi-output report containing an invalid second product or insufficient input stock. Confirm *no* production run, inventory credit, or material debit persists.
6. **Roles:** Verify a normal employee/customer cannot call `post_multi_production_run` directly. Verify only admin and production supervisor can log production.
7. **Dashboard:** Confirm production output measured kg and roll counts include extra outputs without multiplying input consumption or waste.
8. **Preservation:** Confirm previous production runs, employee registration codes, sales and payments still operate normally.

## Verification limits

Source review and local Node regression tests are **not** a database integration test. The database migration has not been executed against your hosted Supabase project by the author of this patch. The full TypeScript/ESLint/Vite check also requires installing the frontend dependencies in your environment. This patch changes no previously applied migrations or live user records.
