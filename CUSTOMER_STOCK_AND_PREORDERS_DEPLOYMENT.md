# FactoryFlow Hardened — Customer Stock & Production Preorders

**Target:** `https://github.com/Aarondonkor/factoryflow-hardened` and Supabase project `dsnqcexijpcvckdcfser`.

## What this update adds

- Customer portal → **My Stock**: each customer sees the available quantity of **their own branded products**, including the count and *measured* weight of physical rolls. The database aggregates stock; the client does not trust an editable stock total.
- **Request Production** appears only for a company-owned branded roll product with zero available physical rolls, a valid selling price, and `customer_orderable = true`.
- A made-to-order request is **one branded product per order**, with minimum **5 rolls / 100 kg**, at **20 kg nominal per roll**.
- Exactly 5 rolls (100 kg) can be submitted **without any upfront payment** and await staff confirmation.
- More than 5 rolls (more than 100 kg) require **at least 50% of the total price, rounded up to the nearest GHS 0.01**. Factory confirmation is blocked until a Paystack-verified deposit covers this amount.
- The order is saved as `pending` while awaiting payment; **it cannot proceed to confirmed production before the required deposit is recorded**.
- Once confirmed, factory staff log production normally. Sales then use **Allocate Rolls** to bind the real produced rolls to that order. Stock is debited **once on allocation**; production logging credits stock in the existing workflow.
- Dispatch is blocked until exactly the ordered number of rolls is allocated and the measured weight reaches the ordered nominal kg.
- Existing *in-stock* ordering, reservations and payment processing continue as before.

**Important assumption:** The user's instruction equates **5 rolls to 100 kg**. This update therefore prices made-to-order output using a **nominal 20 kg per roll** and stores actual measured weights at production time. This is not suitable for variable-weight contract terms without changing the business rule.

## Installation order (do not reset Supabase)

1. Back up your current repo/changes. Extract the small patch so its `frontend/` and `supabase/` directories merge with the root of the Git-connected repository, e.g. `C:\Users\sally\Projects\factoryflow-hardened-git`. Do not add another nested `factoryflow-hardened` folder.
2. Verify `supabase/migrations/20261115000026_customer_stock_and_production_preorders.sql` exists.
3. From repository root:

   ```powershell
   npx.cmd supabase link --project-ref dsnqcexijpcvckdcfser
   npx.cmd supabase migration list --remote
   npx.cmd supabase db push --remote --dry-run
   ```

   Verify only the intended unapplied migrations are listed, including `20261115000026`. Then apply:

   ```powershell
   npx.cmd supabase db push --remote
   ```

4. Supabase Edge Functions need redeploying because payment initialization and webhook handling have changed:

   ```powershell
   npx.cmd supabase functions deploy paystack-payment --project-ref dsnqcexijpcvckdcfser
   npx.cmd supabase functions deploy paystack-webhook --no-verify-jwt --project-ref dsnqcexijpcvckdcfser
   ```

   These functions reuse your existing `SITE_URL`, `ALLOWED_ORIGINS`, `PAYSTACK_SECRET_KEY` and Supabase-managed credentials. **Do not place the Paystack secret in Git, Vite, or Netlify browser environment variables.** Check that Paystack's webhook URL is configured to point at your deployed `paystack-webhook` Edge Function.
5. Validate and deploy frontend from the Git-connected repository:

   ```powershell
   cd frontend
   npm.cmd ci --include=dev
   npm.cmd run check
   cd ..
   git status
   git add frontend supabase CUSTOMER_STOCK_AND_PREORDERS_DEPLOYMENT.md
   git commit -m "Add customer stock visibility and 50 percent production deposits"
   git push origin main
   ```

   Verify the Netlify deployment succeeded before testing orders.

## Preparing a branded product

The admin must configure a product in Inventory with these attributes:
- `customer_id`: the actual customer's company record
- `unit`: `rolls`
- `customer_orderable`: `true`
- `unit_price`: **positive GHS price per kg**
- `spec_thickness`, or an appropriate micron range to be entered when ordering

The customer can order existing physical rolls under **Place Order**. If their branded product has zero available physical rolls, the **Request Production** button appears in **My Stock**.

## Required staging acceptance tests (Paystack TEST mode; no real payments)

1. **Separate customer visibility:** Create two approved customer accounts with distinct branded product records. Each sees only their own branded stock, not the other's.
2. **Available stock:** Create three available rolls with different real weights. My Stock must show count 3 and their actual summed kg. The Request Production button must not appear.
3. **Exact threshold:** With no available rolls, submit **5 rolls / 100 kg**. No Paystack checkout appears, `deposit_required = 0`, and Sales can confirm without payment. No stock is debited on confirmation.
4. **Below minimum:** Try 4 rolls or a fractional roll count directly via the RPC. The database must reject it.
5. **Above minimum:** Request **6 rolls / 120 kg** with a product price of GHS 10/kg. The order total must be **GHS 1,200**, deposit at least **GHS 600**. The customer is sent to Paystack's test checkout. Sales Confirm is disabled and the server rejects confirmation before deposit settlement.
6. **Verified payment:** Complete the Paystack TEST payment. Confirm in `payment_attempts`, `payments`, and `orders.amount_paid` that the amount and reference match and no double settlement occurs from webhook + callback. Only after verification can Sales confirm.
7. **Retry:** Abandon checkout, reopen My Orders → View → Pay Deposit. The existing pending checkout should be reused; no second pending deposit is created.
8. **Unauthenticated/foreign customer:** Calls to `customer_available_stock()` and `customer_request_production_order()` must reject unauthorized accounts and foreign branded products.
9. **Produced stock allocation:** After factory staff log the physical rolls, Sales can allocate exactly 6 rolls of the ordered product (total measured weight at least 120 kg). The FG stock decreases by 6 exactly once; second allocation is rejected.
10. **Dispatch guard:** Dispatch before allocation or with insufficient total measured weight must fail. After valid allocation, dispatch and delivery proceed normally.
11. **Cancellation:** An unpaid, unallocated pending/confirmed production order can be cancelled without adding imaginary stock. An order with a deposit cannot be cancelled until payments are refunded through the existing verified refund flow.
12. **Existing in-stock orders:** Reserve and confirm existing rolls, pay and dispatch normally. Verify no change in their inventory movements.

## Operational caveats

- Product prices and nominal roll weights must be configured before accepting custom orders.
- Paystack deposits are recorded **before order confirmation** specifically for production requests over 100 kg; normal stock orders retain the existing confirmation-before-payment rule.
- A Paystack checkout can remain pending if the customer doesn't complete it. Existing attempt URLs are reused; reconcile unresolved attempts with the payment provider before reissuing any link. Do not manually mark a payment as successful.
- The frontend shows **nominal** contracted kg; actual production rolls must be measured and allocated before dispatch. If measured output falls short, production needs to correct the shortfall; this patch does not silently under-deliver.
- Source checks are not a live Supabase integration test. Run the staging acceptance tests above before using real payment credentials.
