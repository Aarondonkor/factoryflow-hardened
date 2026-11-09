-- FactoryFlow: Row Level Security Policies

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE finished_goods ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_downtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;

-- Profiles
CREATE POLICY "Users can read own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Admins can read all profiles" ON profiles
  FOR SELECT USING (get_user_role() = 'admin');

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id AND role = (SELECT role FROM profiles WHERE id = auth.uid()));

CREATE POLICY "Admins can update any profile" ON profiles
  FOR UPDATE USING (get_user_role() = 'admin');

-- Inventory: raw materials
CREATE POLICY "Admin full access raw materials" ON raw_materials
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Production supervisor read raw materials" ON raw_materials
  FOR SELECT USING (get_user_role() IN ('production_supervisor', 'sales_staff'));

CREATE POLICY "Production supervisor write raw materials" ON raw_materials
  FOR INSERT WITH CHECK (get_user_role() = 'admin');

CREATE POLICY "Production supervisor update raw materials" ON raw_materials
  FOR UPDATE USING (get_user_role() = 'admin');

-- Inventory: finished goods
CREATE POLICY "Admin full access finished goods" ON finished_goods
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Staff read finished goods" ON finished_goods
  FOR SELECT USING (get_user_role() IN ('production_supervisor', 'sales_staff'));

CREATE POLICY "Production supervisor write finished goods" ON finished_goods
  FOR INSERT WITH CHECK (get_user_role() IN ('admin', 'production_supervisor'));

CREATE POLICY "Production supervisor update finished goods" ON finished_goods
  FOR UPDATE USING (get_user_role() IN ('admin', 'production_supervisor'));

-- Stock movements (read for authorized roles)
CREATE POLICY "Admin full access stock movements" ON stock_movements
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Read stock movements" ON stock_movements
  FOR SELECT USING (get_user_role() IN ('production_supervisor', 'sales_staff'));

CREATE POLICY "Insert stock movements via functions" ON stock_movements
  FOR INSERT WITH CHECK (get_user_role() IN ('admin', 'production_supervisor', 'sales_staff'));

-- Production
CREATE POLICY "Admin full access machines" ON machines
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Production read machines" ON machines
  FOR SELECT USING (get_user_role() IN ('production_supervisor', 'admin'));

CREATE POLICY "Production write machines" ON machines
  FOR INSERT WITH CHECK (get_user_role() IN ('admin', 'production_supervisor'));

CREATE POLICY "Admin full access production runs" ON production_runs
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Production supervisor manage runs" ON production_runs
  FOR ALL USING (get_user_role() = 'production_supervisor')
  WITH CHECK (get_user_role() = 'production_supervisor');

CREATE POLICY "Admin full access downtime" ON machine_downtime
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Production supervisor manage downtime" ON machine_downtime
  FOR ALL USING (get_user_role() = 'production_supervisor')
  WITH CHECK (get_user_role() = 'production_supervisor');

-- Sales
CREATE POLICY "Admin full access customers" ON customers
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Sales staff manage customers" ON customers
  FOR ALL USING (get_user_role() = 'sales_staff')
  WITH CHECK (get_user_role() = 'sales_staff');

CREATE POLICY "Admin full access orders" ON orders
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Sales staff manage orders" ON orders
  FOR ALL USING (get_user_role() = 'sales_staff')
  WITH CHECK (get_user_role() = 'sales_staff');

CREATE POLICY "Admin full access order items" ON order_items
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Sales staff manage order items" ON order_items
  FOR ALL USING (get_user_role() = 'sales_staff')
  WITH CHECK (get_user_role() = 'sales_staff');

CREATE POLICY "Admin full access payments" ON payments
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "Sales staff manage payments" ON payments
  FOR ALL USING (get_user_role() = 'sales_staff')
  WITH CHECK (get_user_role() = 'sales_staff');

-- HR
CREATE POLICY "Admin full access employees" ON employees
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "HR officer manage employees" ON employees
  FOR ALL USING (get_user_role() = 'hr_officer')
  WITH CHECK (get_user_role() = 'hr_officer');

CREATE POLICY "Staff read own employee record" ON employees
  FOR SELECT USING (
    get_user_role() = 'staff' AND profile_id = auth.uid()
  );

CREATE POLICY "Admin full access attendance" ON attendance
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "HR officer manage attendance" ON attendance
  FOR ALL USING (get_user_role() = 'hr_officer')
  WITH CHECK (get_user_role() = 'hr_officer');

CREATE POLICY "Staff manage own attendance" ON attendance
  FOR ALL USING (
    get_user_role() = 'staff' AND
    employee_id IN (SELECT id FROM employees WHERE profile_id = auth.uid())
  )
  WITH CHECK (
    get_user_role() = 'staff' AND
    employee_id IN (SELECT id FROM employees WHERE profile_id = auth.uid())
  );

CREATE POLICY "Admin full access payroll" ON payroll_records
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "HR officer manage payroll" ON payroll_records
  FOR ALL USING (get_user_role() = 'hr_officer')
  WITH CHECK (get_user_role() = 'hr_officer');

CREATE POLICY "Admin full access leave" ON leave_requests
  FOR ALL USING (get_user_role() = 'admin');

CREATE POLICY "HR officer manage leave" ON leave_requests
  FOR ALL USING (get_user_role() IN ('hr_officer', 'admin'))
  WITH CHECK (get_user_role() IN ('hr_officer', 'admin'));

CREATE POLICY "Staff manage own leave" ON leave_requests
  FOR ALL USING (
    get_user_role() = 'staff' AND
    employee_id IN (SELECT id FROM employees WHERE profile_id = auth.uid())
  )
  WITH CHECK (
    get_user_role() = 'staff' AND
    employee_id IN (SELECT id FROM employees WHERE profile_id = auth.uid())
  );

-- Seed data
INSERT INTO machines (machine_code, name) VALUES
  ('BF-01', 'Blown Film Line 1'),
  ('BF-02', 'Blown Film Line 2'),
  ('BF-03', 'Blown Film Line 3');

INSERT INTO raw_materials (name, unit, current_stock, reorder_threshold, supplier_name) VALUES
  ('LDPE Resin', 'kg', 5000, 1000, 'Ghana Polymer Supplies'),
  ('LLDPE Resin', 'kg', 2000, 500, 'Ghana Polymer Supplies'),
  ('Color Masterbatch - Blue', 'kg', 200, 50, 'ColorTech Ghana'),
  ('Color Masterbatch - Clear', 'kg', 150, 50, 'ColorTech Ghana'),
  ('Slip Additive', 'kg', 100, 25, 'Additives Ltd'),
  ('Anti-block Additive', 'kg', 80, 20, 'Additives Ltd');

INSERT INTO finished_goods (product_name, spec_thickness, spec_width, color, unit, current_stock, warehouse_location) VALUES
  ('LDPE Film 25mic', 25, 500, 'Clear', 'kg', 0, 'Warehouse A - Bin 1'),
  ('LDPE Film 30mic', 30, 600, 'Clear', 'kg', 0, 'Warehouse A - Bin 2'),
  ('LDPE Film 25mic Blue', 25, 500, 'Blue', 'rolls', 0, 'Warehouse B - Bin 1');
