-- Compatibility repair for customer stock/preorder functions introduced in migration 026.
-- Migration 012 intentionally removed the optional per-product micron range,
-- but migration 026 still references finished_goods.spec_thickness_min/max.
-- Add nullable compatibility columns, WITHOUT range enforcement; micron remains
-- specified per order on order_items.specified_micron.
ALTER TABLE public.finished_goods
  ADD COLUMN IF NOT EXISTS spec_thickness_min numeric(6,2),
  ADD COLUMN IF NOT EXISTS spec_thickness_max numeric(6,2);

COMMENT ON COLUMN public.finished_goods.spec_thickness_min IS
  'Legacy compatibility field for customer stock/preorder RPCs; nullable and not a restriction on order micron.';
COMMENT ON COLUMN public.finished_goods.spec_thickness_max IS
  'Legacy compatibility field for customer stock/preorder RPCs; nullable and not a restriction on order micron.';

NOTIFY pgrst, 'reload schema';
