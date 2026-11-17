# FactoryFlow Hardened — Separate semi-finished inputs per finished output

## What changes

In **Production → Log Production Run**, choose a **conversion** machine.

- The primary finished output keeps its own **Semi-Finished Input for Primary Output** section.
- Every **Additional Product** now has an independent **Semi-finished input product** selector.
- For roll-counted semi-finished products, choose the exact physical rolls for that output. For kilogram-counted products, enter the quantity consumed.
- Input and output thicknesses must agree when recorded. Physical roll micron values are also checked when known.
- The same physical roll cannot be assigned to two outputs; the database verifies availability again when saving.
- Each additional output records its `input_product_id` and `input_quantity_consumed`; its consumed physical rolls link through `product_rolls.consumed_in_output_id`.
- Input deductions, individual roll consumption, and finished-product stock credits occur in one PostgreSQL transaction. If any line fails, the run is not posted.
- Existing production history remains readable. Historical additional output lines without their own input record show that the input was not separately recorded.

### Example

| Output | Finished output | Independent semi-finished input | Roll allocation |
| --- | --- | --- | --- |
| Primary | Branded film 30 micron | Semi-finished film 30 micron | Select 30 µm physical rolls |
| Additional | Branded film 40 micron | Semi-finished film 40 micron | Select 40 µm physical rolls |

This is **one conversion run** with two independent input deductions and two output credits. It does **not** deduct the same semi-finished material for every output.

## Apply to the existing Git-connected checkout

1. Back up any uncommitted changes first with `git status`. Extract the patch ZIP into the **repository root**, preserving paths. The patch contains no `package.json` or `package-lock.json` and won't replace recent React Router security updates.
2. Confirm the migration file exists: `supabase/migrations/20261117000027_per_output_conversion_inputs.sql`.
3. Run the Supabase dry run and examine the migration list:

   ```powershell
   cd C:\Users\sally\Projects\factoryflow-hardened-git
   npx.cmd supabase link --project-ref dsnqcexijpcvckdcfser
   npx.cmd supabase db push --remote --dry-run
   ```

4. Only if previous migrations through 026 are already applied and 027 is the expected pending migration, apply it:

   ```powershell
   npx.cmd supabase db push --remote
   npx.cmd supabase migration list --remote
   ```

5. Test the frontend locally (install dependencies if necessary):

   ```powershell
   cd frontend
   npm.cmd ci --include=dev
   npm.cmd run check
   cd ..
   ```

6. Commit the patch, not credentials or `node_modules`:

   ```powershell
   git status
   git add frontend/src/pages/production/ProductionRunForm.tsx frontend/src/pages/production/ProductionPage.tsx frontend/src/types/database.ts frontend/tests/per-output-conversion.test.mjs supabase/migrations/20261117000027_per_output_conversion_inputs.sql PER_OUTPUT_CONVERSION_INPUTS_DEPLOYMENT.md
   git commit -m "Allocate semi-finished inputs per finished production output"
   git push origin main
   ```

   Netlify should deploy the frontend from the connected `main` branch.

## Acceptance tests on staging, before live use

- Create separate stock items for 30 µm and 40 µm semi-finished film. Each roll must have an accurate recorded micron and measured weight, where available.
- Create a conversion run with one 30 µm finished product and one additional 40 µm finished product; select physical 30 µm inputs for the first and 40 µm inputs for the second.
- Save; verify **one** production run with **two** output entries, two distinct input stock movements, and physical rolls marked `consumed` with the same run ID and (for additional lines) the additional output ID.
- Verify both input stocks decreased by the quantity of their own selected rolls; neither decreased twice.
- Verify both finished stocks increased by their actual output quantities and the finished rolls have their respective batch IDs.
- Try selecting the same input roll for both outputs; the UI should prevent it and the backend should reject any forged duplicate request.
- Try mismatched 30 µm semi-finished input on a 40 µm finished product; the UI and backend should reject it when thickness data is present.
- Try selecting a roll already consumed or reserved, or more rolls than are in stock; nothing should post.
- Test an extrusion run with multiple semi-finished outputs to confirm that raw-material consumption still happens once and no per-output semi-finished inputs are needed.
- Test historical conversion runs for backward compatibility, and check Supabase logs for database errors.

## Verification limits

The included source regression suite passed locally (30/30), and the changed TypeScript files parsed successfully. A complete `tsc`/ESLint/Vite build was not performed in the isolated source environment because the project's npm dependencies are not installed there. **The migration has not been run against your Supabase project**, and stock updates have not been integration-tested with your live data. Run these checks in staging first; never reset the live database to apply this patch.
