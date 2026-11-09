# FactoryFlow — staging regression matrix

The seven local tests (`cd frontend && npm run test`) check pure date/format logic and source-level security invariants. **They do not execute PostgreSQL, validate RLS, contact Paystack or exercise a browser.** These integration cases are mandatory in a test Supabase project before production approval.

| # | Test in staging (real auth sessions and database) | Pass criterion |
|---|---|---|
| 1 | Register a user with forged `user_metadata.role=admin` | Profile is customer, company is pending, cannot call staff RPCs |
| 2 | Try `UPDATE profiles SET role='admin'` as customer/staff | Denied by column grants/RLS |
| 3 | Try `adjust_stock`, `record_stock_movement`, payment and refund settlement RPCs as customer | All unauthorized calls rejected |
| 4 | Try direct INSERT/UPDATE/DELETE on `payments`, `orders`, `order_items`, `product_rolls`, `stock_movements`, `production_runs` as customer | Rejected even with crafted REST requests |
| 5 | Record a fake Paystack reference, mismatched currency/amount/order, and cancelled checkout | Never increments amount_paid; verified attempt remains pending |
| 6 | Replay the same `charge.success` webhook; simulate webhook/callback race | Exactly one payment and single increment |
| 7 | Disable webhook during a real Paystack test transaction; invoke reconciler later | Verified payment eventually settles once |
| 8 | Attempt to create an empty/invalid staff order | Entire operation fails, no empty order parent |
| 9 | Customer selects same roll in two concurrent sessions | At most one reservation; other fails completely |
| 10 | Edit/delete pending customer order with previously reserved rolls | Old reservations released, selected new roll IDs reserved atomically |
| 11 | Add/change order line after confirmation/dispatch/delivery | Server denies any write; no stock mismatch |
| 12 | Confirm with insufficient finished stock or missing physical roll allocation | Atomic rejection; no partial stock debit |
| 13 | Log extrusion run with mixed raw materials, then a deliberately insufficient line | Whole run and all stock movements rolled back on failure |
| 14 | Log printing/cutting run consuming selected physical roll IDs | Input rolls marked consumed with run ID; product stock decremented once |
| 15 | Cancel pending and then confirmed unpaid order | Reserved/committed rolls restored correctly; no duplicate stock movement |
| 16 | Pay fully before order confirmation and dispatch pending order | Both disallowed; payment status remains separate from fulfillment |
| 17 | Request a Paystack refund, duplicate webhook, failed refund and processed refund | Pending/failed never debits paid balance; processed once only |
| 18 | Record and partially refund cash/bank receipt as admin; try as sales staff | Admin may refund, sales staff denied; net receipts and balance correct |
| 19 | Compare monthly dashboard production yield with measured kg/material weights | kg never added to roll count; only extrusion material basis included |
| 20 | Compare same order paid in another month and refunded later | Receipt recognized in payment month, refund in processing month |
| 21 | Staff clock-in 23:00, clock-out 07:00, then generate payroll | 8.00 hours, correct month/employee totals and role restrictions |
| 22 | Submit duplicate same-day clock in / double open session | Unique constraint or RPC rejects without duplicate attendance |
| 23 | Try to view employee salary/identity identifiers as customer and non-HR | RLS denies |
| 24 | Open dialogs with keyboard; tab and Shift+Tab; Escape | Focus stays inside, closes/restores previous focus |
| 25 | Test Netlify/Vercel headers, SPA deep links, login, admin invite and role changes | Secure HTTPS headers, no service keys in JS; navigation and API work |
| 26 | Load thousands of orders and rolls; verify pagination/recent-list labels | Pages respond acceptably, server metrics correct across all records |

Record a screenshot/SQL query of before+after data for #4, #6, #9, #13, #14, #17, and #21. Run `scripts/postflight.sql` after every staged migration release and have a second reviewer sign off on financial and warehouse totals.

**Not yet included:** a runnable Postgres/Paystack integration test harness; this requires a Supabase CLI/Docker database and provider test credentials that were not part of the uploaded ZIP. Do not mistake the source tests for live certification.
