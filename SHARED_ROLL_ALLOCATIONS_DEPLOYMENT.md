# FactoryFlow Hardened — Shared semi-finished roll allocations

## Feature

A conversion production report with two or more finished products can allocate measured kilograms from the **same physical semi-finished roll** to different outputs, provided micron specifications match.

Example, one 30 µm source roll with 50.00 kg remaining:

| Finished output | Source | Kg drawn |
|---|---|---:|
| Finished brand A (30 µm) | Semi-finished roll #45 | 20.00 |
| Finished brand B (30 µm) | Semi-finished roll #45 | 15.00 |
| Remaining available on roll #45 | — | **15.00** |

The roll remains **available** until its remaining weight reaches zero. When it is exhausted, its status changes to **consumed** and the semi-finished product's *roll-count* stock decreases by one, **exactly once**. A different production run can later use the remaining weight.

Each output retains its batch ID, measured finished-roll weights (where applicable), source roll ID, and consumed kilogram quantity. The immutable `production_run_roll_allocations` ledger stores the source/output trace. The customer sales flow uses the remaining `weight_kg`, while `original_weight_kg` preserves the originally recorded roll weight.

### Scope

- Conversion machine; two or more finished products; each input is a roll-counted semi-finished product. A separate input product may be selected per finished output.
- For multi-output conversion, enter **Kg used for this finished product** for every selected input roll.
- The same source roll may appear on more than one output. The combined portions must not exceed its current available weight.
- Finished output kilograms cannot exceed the kilograms allocated to that output (for finished goods recorded in kg or individual rolls). Record process waste accurately in the existing waste field.
- Existing single-output and kg-counted-input workflows remain on their previous RPCs. The new partial-weight flow is not yet used for single-output runs or mixed roll-counted / kg-counted inputs in the same report.

## Install into your EXISTING Git-connected repository

Do **not** overwrite your repository with an older full-source ZIP. Make a backup/commit first, then extract the patch ZIP directly into the repository root, preserving `frontend/...` and `supabase/...` paths.

```powershell
cd C:\Users\sally\Projects\factoryflow-hardened-git

git status
npx.cmd supabase migration list --remote
npx.cmd supabase db push --remote --dry-run
```

Confirm previous migrations through `20261117000027` and the new migration:

`20261117000028_shared_semi_finished_roll_allocations.sql`

If your remote is linked to `dsnqcexijpcvckdcfser` and the dry run is correct:

```powershell
npx.cmd supabase db push --remote
npx.cmd supabase migration list --remote
```

The migration creates the weight-allocation ledger, introduces original-roll-weight preservation, changes consumption to weight-based for the new RPC, and extends the administrator roll search result. It does **not** reset existing production, stock, orders or user accounts. The frontend production history will refer to the new ledger, so apply the migration **before** pushing the frontend update.

## Local validation and GitHub deployment

```powershell
cd C:\Users\sally\Projects\factoryflow-hardened-git\frontend
npm.cmd ci --include=dev
npm.cmd run check
cd ..
git add frontend/src/lib/rollAllocations.ts frontend/src/pages/production/ProductionRunForm.tsx frontend/src/pages/production/ProductionPage.tsx frontend/src/pages/inventory/RollDetailModal.tsx frontend/src/types/database.ts frontend/tests/shared-roll-allocation.test.mjs supabase/migrations/20261117000028_shared_semi_finished_roll_allocations.sql SHARED_ROLL_ALLOCATIONS_DEPLOYMENT.md
git commit -m "Support shared semi-finished source rolls across finished outputs"
git push origin main
```

Netlify should deploy from the connected GitHub `main` branch.

## Staging acceptance tests — required before production inventory

1. On a staging copy of the database, create a 30 µm semi-finished roll with original weight 50.00 kg and **available** status. Note its roll number and the semi-finished product's current **roll** stock.
2. Open **Production → Log Production Run**, select a conversion machine, select finished brand A (30 µm), add a second finished brand B (30 µm), and select the same physical source roll for both outputs.
3. Allocate 20.00 kg to A and 15.00 kg to B. Record the outputs and submit.
4. Confirm both finished-product stocks increase correctly; the source roll retains status `available` with **15.00 kg** remaining, `original_weight_kg=50.00`, and the source product's **roll-count** remains unchanged. Confirm two ledger records (20 and 15 kg) linked to their respective output IDs.
5. Attempt another run allocating 16 kg from the 15 kg remainder — **must fail** without posting finished stock or input entries.
6. Consume the final 15 kg in another conversion run — roll becomes `consumed`, remaining `weight_kg=0`, and source product's roll-count decreases **once**.
7. Attempt to select a 40 µm physical roll for a 30 µm product — **must fail** where microns are recorded.
8. Test an attempt by a non-production user to call the new RPC — **must fail**. Test concurrent postings from separate production supervisors against the same remaining roll: only weight within the remaining total may post.
9. Verify the source roll details show original and remaining weights; verify production history shows both finished outputs' respective roll allocation entries.

Suggested audit SQL in the **Supabase SQL Editor** (read-only):

```sql
SELECT id,roll_no,finished_good_id,original_weight_kg,weight_kg,status
FROM public.product_rolls WHERE roll_no = 45;

SELECT a.production_run_id, a.production_output_id, r.roll_no,
       a.consumed_weight_kg, a.created_at
FROM public.production_run_roll_allocations a
JOIN public.product_rolls r ON r.id=a.input_roll_id
WHERE r.roll_no = 45 ORDER BY a.created_at;
```

Replace `45` with your real test roll number. Do not test against production inventory until staging results pass.

## Validation status of this patch

- Source-level automated tests: **34 passed**.
- Modified TypeScript/TSX source: parsed successfully.
- Full TypeScript compilation, ESLint, Vite production build, and live PostgreSQL migration/integration testing: **not run successfully here**. The available dependencies were incomplete, and there is no connection to your live Supabase project. These must pass on your machine/Netlify and staging Supabase before production rollout.
