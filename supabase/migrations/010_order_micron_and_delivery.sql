-- FactoryFlow: support the full order → confirm → pay → deliver flow.
-- 1) Customers can specify a micron/thickness for roll-unit order items at
--    order time (their exclusive branded roll stays one catalog product;
--    the micron is a per-order request, not a separate SKU per thickness).
-- 2) Delivery progress (dispatched/delivered) becomes staff-actionable and
--    notifies the customer, using the existing (until now unused)
--    orders.delivery_status column.

ALTER TABLE order_items
  ADD COLUMN specified_micron NUMERIC(6, 2);

COMMENT ON COLUMN order_items.specified_micron IS
  'Customer-requested thickness in microns for this line item, for roll-unit products. NULL when not applicable or not specified.';

-- Notify the customer when their order's delivery status moves to dispatched or delivered.
CREATE OR REPLACE FUNCTION notify_customer_on_delivery_update()
RETURNS TRIGGER AS $$
DECLARE
  v_owner_profile_id UUID;
BEGIN
  IF NEW.delivery_status IS DISTINCT FROM OLD.delivery_status
     AND NEW.delivery_status IN ('dispatched', 'delivered') THEN
    SELECT owner_profile_id INTO v_owner_profile_id FROM customers WHERE id = NEW.customer_id;

    IF v_owner_profile_id IS NOT NULL THEN
      INSERT INTO notifications (profile_id, type, title, message, order_id)
      VALUES (
        v_owner_profile_id,
        'delivery_' || NEW.delivery_status,
        CASE WHEN NEW.delivery_status = 'dispatched' THEN 'Order Dispatched' ELSE 'Order Delivered' END,
        CASE WHEN NEW.delivery_status = 'dispatched'
          THEN 'Your order ' || NEW.order_number || ' is on its way.'
          ELSE 'Your order ' || NEW.order_number || ' has been delivered.'
        END,
        NEW.id
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_notify_customer_delivery
  AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION notify_customer_on_delivery_update();
