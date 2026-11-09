export type UserRole =
  | 'admin'
  | 'production_supervisor'
  | 'sales_staff'
  | 'hr_officer'
  | 'staff'
  | 'customer'

export interface Profile {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  created_at: string
  updated_at: string
}

export interface RawMaterial {
  id: string
  name: string
  unit: string
  current_stock: number
  reorder_threshold: number
  supplier_name: string | null
  supplier_contact: string | null
  last_restock_date: string | null
  material_code: string | null
  created_at: string
  updated_at: string
}

export type ProductStage = 'semi_finished' | 'finished'

export interface FinishedGood {
  id: string
  product_name: string
  spec_thickness: number | null
  spec_width: number | null
  color: string | null
  unit: 'kg' | 'rolls' | 'bundle'
  current_stock: number
  warehouse_location: string | null
  stage: ProductStage
  customer_id: string | null
  customer_orderable: boolean
  unit_price: number | null
  bundle_size: number | null
  created_at: string
  updated_at: string
}

export interface StockMovement {
  id: string
  material_type: 'raw' | 'finished'
  material_id: string
  movement_type: 'in' | 'out'
  quantity: number
  source: string
  source_id: string | null
  reason: string | null
  created_by: string | null
  created_at: string
}

export type MachineStage = 'extrusion' | 'conversion'

export interface Machine {
  id: string
  machine_code: string
  name: string
  is_active: boolean
  stage: MachineStage
  created_at: string
}

export type ConversionProcessType = 'cutting' | 'printing'

export interface ProductionRunMaterial {
  id: string
  production_run_id: string
  raw_material_id: string
  quantity_kg: number
  proportion_pct: number | null
  created_at: string
  raw_materials?: RawMaterial
}

export interface ProductionRun {
  id: string
  run_date: string
  shift: 'morning' | 'afternoon' | 'night'
  machine_id: string
  operator_name: string
  supervisor_name: string | null
  finished_good_id: string | null
  film_thickness: number | null
  film_width: number | null
  film_color: string | null
  output_quantity: number
  output_unit: 'kg' | 'rolls'
  resin_material_id: string | null
  resin_consumed: number
  additive_material_id: string | null
  additive_consumed: number
  input_product_id: string | null
  input_quantity_consumed: number
  roll_weights: number[] | null
  process_type: ConversionProcessType | null

  formula_code: string | null
  roll_count: number | null
  roll_length: number | null
  avg_weight_per_roll: number | null
  start_time: string | null
  end_time: string | null
  total_runtime_hours: number | null
  downtime_hours: number

  temp_z1: number | null
  temp_z2: number | null
  temp_z3: number | null
  temp_z4: number | null
  temp_z5: number | null
  temp_z6: number | null
  screw_speed_rpm: number | null
  line_speed_mpm: number | null

  cut_length_mm: number | null
  bottom_seal_offset_mm: number | null
  cutting_speed_cpm: number | null

  print_colours_count: number | null
  print_speed: number | null
  print_tension: number | null
  cleaned_rollers: boolean | null
  roll_edges_ok: boolean | null
  neatness_rating: number | null

  samples_tested: number | null
  samples_passed: number | null
  samples_failed: number | null
  qc_issues: string[] | null
  qc_issue_other: string | null

  batch_id: string | null
  quality_grade: number | null

  waste_quantity: number
  notes: string | null
  created_at: string
  machines?: Machine
  finished_goods?: FinishedGood
  input_product?: FinishedGood
  production_run_materials?: ProductionRunMaterial[]
}

export interface MachineDowntime {
  id: string
  machine_id: string
  reason: 'maintenance' | 'power_outage' | 'breakdown' | 'other'
  reason_detail: string | null
  start_time: string
  end_time: string | null
  duration_minutes: number | null
  machines?: Machine
}

export type CustomerApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface Customer {
  id: string
  name: string
  business_name: string | null
  contact_phone: string | null
  contact_email: string | null
  address: string | null
  credit_terms_days: number
  owner_profile_id: string | null
  approval_status: CustomerApprovalStatus
  created_at: string
  updated_at: string
}

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'in_production'
  | 'dispatched'
  | 'delivered'
  | 'paid'
  | 'cancelled'

export interface Order {
  id: string
  order_number: string
  customer_id: string
  status: OrderStatus
  delivery_date: string | null
  delivery_status: 'pending' | 'dispatched' | 'delivered'
  subtotal: number
  total: number
  amount_paid: number
  balance_due: number
  notes: string | null
  created_by: string | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
  customers?: Customer
  order_items?: OrderItem[]
}

export interface OrderItem {
  id: string
  order_id: string
  finished_good_id: string
  quantity: number
  unit_price: number
  line_total: number
  specified_micron: number | null
  created_at: string
  finished_goods?: FinishedGood
}

export interface Payment {
  id: string
  order_id: string
  amount: number
  payment_method: 'paystack' | 'cash' | 'mobile_money' | 'bank_transfer'
  paystack_reference: string | null
  notes: string | null
  recorded_by: string | null
  created_at: string
  orders?: Order
}

export interface Employee {
  id: string
  profile_id: string | null
  full_name: string
  role_title: string
  contact_phone: string | null
  contact_email: string | null
  hire_date: string
  salary_rate: number | null
  wage_rate: number | null
  rate_type: 'monthly' | 'hourly' | 'daily'
  ghana_card_number: string | null
  next_of_kin_name: string | null
  next_of_kin_phone: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Attendance {
  id: string
  employee_id: string
  attendance_date: string
  clock_in: string | null
  clock_out: string | null
  clock_in_at?: string | null
  clock_out_at?: string | null
  hours_worked: number | null
  notes: string | null
  employees?: Employee
}

export interface PayrollRecord {
  id: string
  employee_id: string
  period_month: number
  period_year: number
  days_worked: number
  hours_worked: number
  gross_pay: number
  deductions: number
  net_pay: number
  notes: string | null
  employees?: Employee
}

export interface DashboardMetrics {
  totalProductionKg: number
  totalDowntimeHours: number
  avgYieldPercent: number
  avgWastePercent: number
  lowStockCount: number
  totalRevenue: number
  outstandingBalance: number
  activeEmployees: number
  todayAttendance: number
}

export interface Notification {
  id: string
  profile_id: string
  type: string
  title: string
  message: string
  order_id: string | null
  is_read: boolean
  created_at: string
}

export type RollStatus = 'available' | 'reserved' | 'sold' | 'consumed'

export interface ProductRoll {
  id: string
  roll_no: number
  finished_good_id: string
  production_run_id: string | null
  weight_kg: number
  micron: number | null
  status: RollStatus
  order_item_id: string | null
  created_at: string
  finished_goods?: FinishedGood
}
