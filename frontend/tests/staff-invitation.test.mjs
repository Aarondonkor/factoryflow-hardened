// Legacy filename retained to overwrite the old invitation tests when a patch ZIP
// is copied into an existing checkout. These tests cover registration CODES.
// Static tests: the migration must also be tested in a disposable Supabase project.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const sql = read('supabase/migrations/20261115000024_staff_registration_codes.sql')

test('only an administrator can issue a code for an existing employee email and non-admin role', () => {
  assert.match(sql, /FUNCTION public\.admin_create_staff_registration_code\(/)
  assert.match(sql, /public\.get_user_role\(\) IS DISTINCT FROM 'admin'/)
  assert.match(sql, /'staff','production_supervisor','sales_staff','hr_officer'/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.admin_create_staff_registration_code[\s\S]*?TO authenticated/)
  assert.match(sql, /REVOKE ALL ON TABLE public\.staff_registration_codes FROM PUBLIC, anon, authenticated/)
  assert.match(sql, /employee_email = lower\(btrim\(NEW\.email\)\)/)
})

test('code is unguessable, hashed, single use, expires, can be revoked, and never persisted to user metadata', () => {
  assert.match(sql, /gen_random_uuid\(\)/)
  assert.match(sql, /sha256\(convert_to\(v_code, 'UTF8'\)\)/)
  assert.match(sql, /redeemed_user_id IS NULL/)
  assert.match(sql, /revoked_at IS NULL/)
  assert.match(sql, /expires_at > now\(\)/)
  assert.match(sql, /UPDATE public\.staff_registration_codes[\s\S]*?SET redeemed_user_id = NEW\.id, redeemed_at = now\(\)/)
  assert.match(sql, /NEW\.raw_user_meta_data :=[\s\S]*?- 'employee_registration_code'/)
  assert.match(sql, /BEFORE INSERT ON auth\.users/)
})

test('signup role is assigned only from redeemed code row and creates an HR employee atomically', () => {
  const after = sql.split('CREATE OR REPLACE FUNCTION public.handle_new_user()')[1]
  assert.match(after, /WHERE c\.redeemed_user_id = NEW\.id/)
  assert.match(after, /INSERT INTO public\.employees\(/)
  assert.match(after, /'customer'/)
  assert.doesNotMatch(after, /raw_user_meta_data->>'role'/)
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.finalize_staff_invitation/)
})

test('staff signup submits code without choosing any privileged role', () => {
  const signup = read('frontend/src/pages/StaffSignupPage.tsx')
  const store = read('frontend/src/stores/authStore.ts')
  assert.match(signup, /signUpStaff\(/)
  assert.match(signup, /password\.length < 12/)
  assert.match(signup, /code\.trim\(\)\.toUpperCase\(\)/)
  const staffSignup = store.split('signUpStaff: async')[1].split('signOut: async')[0]
  assert.match(staffSignup, /employee_registration_code: code/)
  assert.doesNotMatch(staffSignup, /role\s*:/)
  assert.match(read('frontend/src/App.tsx'), /path="\/staff\/signup"/)
  assert.doesNotMatch(read('frontend/src/App.tsx'), /accept-invite/)
})

test('admin UI generates, lists, and revokes codes instead of emailing invitations', () => {
  const settings = read('frontend/src/pages/SettingsPage.tsx')
  assert.match(settings, /admin_create_staff_registration_code/)
  assert.match(settings, /admin_list_staff_registration_codes/)
  assert.match(settings, /admin_revoke_staff_registration_code/)
  assert.doesNotMatch(settings, /admin-invite-staff/)
  assert.match(settings, /shown only once/)
  assert.match(read('frontend/src/pages/LoginPage.tsx'), /\/staff\/signup/)
})
