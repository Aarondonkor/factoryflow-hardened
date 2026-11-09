-- FactoryFlow: Customer portal — new enum values.
-- Postgres requires new enum values to be committed before they're used in
-- other statements, so these ADD VALUE calls are isolated in their own
-- migration file, ahead of 007_customer_portal.sql which uses them.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'customer';
ALTER TYPE output_unit ADD VALUE IF NOT EXISTS 'bundle';
