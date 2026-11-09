# Individual Rolls: Admin Search & Production Details

This update adds database migration `20261109000022_admin_roll_search.sql` and an admin-only Individual Rolls inventory search. It works with the existing FactoryFlow Hardened Supabase project `dsnqcexijpcvckdcfser` and Netlify-connected GitHub repository `Aarondonkor/factoryflow-hardened`.

## What it does

- Admin can find any physical roll by product/branded roll name, linked customer/business name, roll number, production batch ID, production date (`YYYY-MM-DD`), production run UUID or roll UUID. Searches all database records with pages of 50, not just the last 500 rolls.
- Admin can filter by available, reserved, sold or consumed status.
- Click a roll number or **View details** to inspect roll weight, micron, product colour and width, warehouse, customer/brand, status, order-item linkage, exact batch ID, production date, shift, machine, operator, supervisor, quality grade and notes.
- Batch ID comes from `production_runs.batch_id`; production date comes from `production_runs.run_date`. `product_rolls.created_at` is shown separately as the roll record creation timestamp. If no run is linked (e.g. a reconciled roll), the app shows **Not recorded**, never invents a date.
- Search is **read-only and admin-only**. The RPC is SECURITY INVOKER so existing RLS applies, and execution is not granted to `anon`.

## Deploy (Windows PowerShell, repository root)

```powershell
cd C:\Users\sally\Downloads\factoryflow-hardened
# Copy all included changed files to their matching locations first.
# Confirm the SQL is under supabase/migrations, not frontend/.
npx.cmd supabase migration list --remote
npx.cmd supabase db push --remote --dry-run
npx.cmd supabase db push --remote
npx.cmd supabase migration list --remote
cd frontend
npm.cmd run check
cd ..
git add supabase/migrations/20261109000022_admin_roll_search.sql frontend/src/pages/inventory/InventoryPage.tsx frontend/src/pages/inventory/RollDetailModal.tsx frontend/src/pages/inventory/rollSearch.ts frontend/tests/inventory-roll-search.test.mjs ROLL_SEARCH_DEPLOYMENT.md
git commit -m "Add admin individual roll brand search and production batch details"
git push origin main
```

Never rewrite or rename previously applied migrations 001–021. Migration 022 is a separate, additive change. Back up your database before production migrations. `db push --remote --dry-run` should list **only** the new migration 022 if prior migrations are complete. If it lists other unexpected migrations, stop and inspect migration history before applying.

## Check in deployed site

1. Sign in as admin, go to **Inventory → Individual Rolls**.
2. Search using a branded product name, customer business name, batch ID, a roll number and a production date. Verify older rolls are reachable across pages.
3. Filter `available` and `sold`. Click a roll number, verify the displayed batch ID and production date against the original production report.
4. Check a historical/reconciled roll with no production-run link: confirm missing details are explicitly labelled **Not recorded**.
5. Non-admin roles must not be able to execute `search_inventory_rolls`. Test using a non-admin authenticated session (expect permission error); do not rely only on the hidden UI.
6. Verify `npm run check` passes in Netlify and Netlify deploy shows **Published**. No new Netlify variables are needed.

## Notes

`brand_name` is the customer/business name currently associated with the finished product (or customer name if business name is empty). FactoryFlow has no dedicated immutable brand-history field; if a customer's business name is renamed later, searches will reflect the current name. Adding historic printed branding/artwork tracking would be a separate data-model enhancement.
