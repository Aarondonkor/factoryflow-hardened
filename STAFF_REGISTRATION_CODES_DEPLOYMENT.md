# Purifa Ventures: Employee registration codes (migration 024)

This update **replaces staff invitations**. An admin generates a one-time code with an employee's **full name**, **exact registration email**, **role**, and **expiry**. The admin hands the code to the employee privately. The employee enters the code with their email and new password on `/staff/signup`. Supabase verifies the code **inside the signup database transaction** and creates a staff profile plus HR employee record. There is no invitation email, no role selection during signup, and no browser-side service-role secret.

## Set up in your existing GitHub / Supabase / Netlify installation

Project: `dsnqcexijpcvckdcfser` • GitHub: `https://github.com/Aarondonkor/factoryflow-hardened`.

1. **Back up your Supabase database** before applying a new Auth trigger migration. Apply this only after previous migrations 001–023 succeed. Extract the patch archive into the **repository root**, not one directory deeper. Preserve your existing `.env` files; the patch does not contain or require secrets.
2. In PowerShell at `C:\Users\sally\Downloads\factoryflow-hardened`:
   ```powershell
   npx.cmd supabase migration list --remote
   npx.cmd supabase db push --remote --dry-run
   ```
   Verify that `20261115000024_staff_registration_codes.sql` is the expected pending migration. If any other migrations are pending, review them too. Then run:
   ```powershell
   npx.cmd supabase db push --remote
   ```
3. **Remove the old invitation implementation from your local repository** (these files are deliberately absent from the new complete ZIP):
   ```powershell
   Remove-Item .\frontend\src\pages\StaffInviteAcceptancePage.tsx -ErrorAction SilentlyContinue
   Remove-Item .\supabase\functions\admin-invite-staff -Recurse -Force -ErrorAction SilentlyContinue
   Remove-Item .\STAFF_INVITATION_DEPLOYMENT.md -ErrorAction SilentlyContinue
   ```
   The existing old test file has been replaced with registration-code regression tests; retain the replacement test.
4. **Remove the old invitation Edge Function from the *cloud project*** if previously deployed:
   ```powershell
   npx.cmd supabase functions delete admin-invite-staff --project-ref dsnqcexijpcvckdcfser
   ```
   If it reports that the function does not exist, no further action is necessary. Database migration 024 also removes the old `finalize_staff_invitation` function.
5. Verify locally and push to the existing `main` branch:
   ```powershell
   cd frontend
   npm.cmd run check
   cd ..
   git status
   git add -A
   git commit -m "Replace staff invitations with secure employee registration codes"
   git push origin main
   ```
   Netlify will rebuild using the existing `frontend` base and `npm run check` command.
6. In Supabase **Authentication → URL Configuration**, set your existing Netlify site URL and allow the `/login` redirect. If **Confirm email** is enabled, employees must confirm their email as in standard self-service signup (this is *not* a staff invitation). Supabase's default email limits apply; configure SMTP for reliable confirmation mail. Alternatively, opting out of email confirmation reduces assurance of mailbox ownership and is not recommended for privileged accounts.

## How it works

- **Admin**: Settings → Generate Employee Registration Code → enter name, employee email, assigned staff role, expiration (24h, 48h, 72h, 7 days). Copy the generated code immediately; its plaintext is **never stored**. The admin may list issue records, view used/expired status, or revoke an unused code.
- **Employee**: Login → Employee Sign Up (`https://YOUR-NETLIFY-HOST/staff/signup`) → enter the **same email** specified by the admin, the code, and a password of at least 12 characters. Role and recorded employee name are assigned from the administrator's verified database record. If email confirmation is on, confirm before signing in.
- **Security**: UUID-derived 122-bit random code; SHA-256 hash stored; 1–168h expiry; bound email and selected non-admin role; atomic one-use redemption; revocation; strict admin-only issue/list/revoke database RPCs; all direct table access denied; submitted code deleted from user metadata *before* Auth persists it. Existing customer signup remains available and cannot select staff roles by forging metadata.

## Acceptance tests (in staging first)

1. Admin generates a code for a test employee email + Sales Staff role; copy it at generation time.
2. Use an incognito window, go to `/staff/signup`, sign up with matching email + code, and confirm email if prompted.
3. Sign in and verify `profiles.role = sales_staff` and a matching `employees` row; verify there is **no** customer shell for that user.
4. Try the same code again: must fail; it must not create another staff profile.
5. Try a wrong code, an expired code, a revoked code, and the correct code with the wrong email: each must fail.
6. A customer signup with `role: 'admin'` metadata (API test, not production) must create **only** a customer.
7. A non-admin authenticated user calling `admin_create_staff_registration_code` must be rejected.
8. Refresh `/staff/signup` in Netlify and verify SPA routing, no 404.

**Validation boundary:** Static source checks, TypeScript and lint checks can run locally. The Auth trigger and Supabase email-confirmation behavior require an actual staging project to be end-to-end tested before issuing real employee codes. No migration or Netlify deployment has been performed by this archive.
