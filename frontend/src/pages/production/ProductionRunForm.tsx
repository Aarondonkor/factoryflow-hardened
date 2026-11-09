import { useState,useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { Machine, RawMaterial, FinishedGood, ConversionProcessType } from '@/types/database'
import { toInputDate } from '@/lib/format'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

interface ProductionRunFormProps {
  machines: Machine[]
  rawMaterials: RawMaterial[]
  finishedGoods: FinishedGood[]
  onClose: () => void
  onSuccess: () => void
}

interface MaterialLine {
  raw_material_id: string
  quantity_kg: string
  proportion_pct: string
}

const EXTRUSION_QC_ISSUES = ['Dimensional variance', 'Button Sealing Off', 'Machine Performance Anomaly', 'Other']
const PRINTING_QC_ISSUES = ['Faded Prints', 'Wet Prints', 'Machine Anomaly', 'Other']

function emptyMaterialLine(rawMaterials: RawMaterial[]): MaterialLine {
  return { raw_material_id: rawMaterials[0]?.id || '', quantity_kg: '', proportion_pct: '' }
}

export function ProductionRunForm({
  machines,
  rawMaterials,
  finishedGoods,
  onClose,
  onSuccess,
}: ProductionRunFormProps) {
  const user = useAuthStore((s) => s.user)
  const addToast = useToastStore((s) => s.addToast)
  const [loading, setLoading] = useState(false)
  const [inputRolls,setInputRolls]=useState<{id:string;roll_no:number;weight_kg:number}[]>([])
  const [selectedInputRollIds,setSelectedInputRollIds]=useState<string[]>([])
  const [inputRollError,setInputRollError]=useState<string|null>(null)

  const semiFinishedGoods = finishedGoods.filter((g) => g.stage === 'semi_finished')
  const finishedOnlyGoods = finishedGoods.filter((g) => g.stage === 'finished')

  const initialMachine = machines[0]
  const initialIsConversion = initialMachine?.stage === 'conversion'

  const [materials, setMaterials] = useState<MaterialLine[]>([emptyMaterialLine(rawMaterials)])

  const [form, setForm] = useState({
    run_date: toInputDate(),
    shift: 'morning' as 'morning' | 'afternoon' | 'night',
    machine_id: initialMachine?.id || '',
    operator_name: '',
    supervisor_name: '',
    finished_good_id: (initialIsConversion ? finishedOnlyGoods[0]?.id : semiFinishedGoods[0]?.id) || '',
    film_thickness: '',
    film_width: '',
    film_color: '',
    output_quantity: '',
    output_unit: 'kg' as 'kg' | 'rolls',
    input_product_id: initialIsConversion ? (semiFinishedGoods[0]?.id || '') : '',
    input_quantity_consumed: '',
    process_type: 'cutting' as ConversionProcessType,

    formula_code: '',
    roll_count: '',
    roll_length: '',
    avg_weight_per_roll: '',
    start_time: '',
    end_time: '',
    total_runtime_hours: '',
    downtime_hours: '0',
    temp_z1: '', temp_z2: '', temp_z3: '', temp_z4: '', temp_z5: '', temp_z6: '',
    screw_speed_rpm: '',
    line_speed_mpm: '',

    cut_length_mm: '',
    bottom_seal_offset_mm: '',
    cutting_speed_cpm: '',

    print_colours_count: '',
    print_speed: '',
    print_tension: '',
    cleaned_rollers: false,
    roll_edges_ok: false,
    neatness_rating: '',

    samples_tested: '',
    samples_passed: '',
    samples_failed: '',
    qc_issues: [] as string[],
    qc_issue_other: '',

    batch_id: '',
    quality_grade: '',

    roll_weights_text: '',
    waste_quantity: '0',
    notes: '',
  })

  const selectedMachine = machines.find((m) => m.id === form.machine_id)
  const isConversion = selectedMachine?.stage === 'conversion'
  const isPrinting = isConversion && form.process_type === 'printing'
  const isCutting = isConversion && form.process_type === 'cutting'
  const outputOptions = isConversion ? finishedOnlyGoods : semiFinishedGoods
  const selectedInputProduct = semiFinishedGoods.find((g) => g.id === form.input_product_id)
  const qcIssueOptions = isPrinting ? PRINTING_QC_ISSUES : EXTRUSION_QC_ISSUES
  // Printing runs that produce a roll product log the weight of every roll,
  // e.g. "12.3, 14.6, 20, 11, 19.9". Each weight becomes one sellable roll.
  const outputProduct = finishedGoods.find((g) => g.id === form.finished_good_id)
  const rollMode = outputProduct?.unit === 'rolls'
  const parsedWeights = form.roll_weights_text
    .split(/[\s,;]+/)
    .filter((t) => t.length > 0)
    .map((t) => Number(t))
  useEffect(()=>{
    setSelectedInputRollIds([])
    if(!isConversion||selectedInputProduct?.unit!=='rolls') {setInputRolls([]);setInputRollError(null);return}
    let active=true
    supabase.from('product_rolls').select('id,roll_no,weight_kg')
      .eq('finished_good_id',form.input_product_id).eq('status','available')
      .order('roll_no',{ascending:false}).limit(500)
      .then(({data,error})=>{
        if(!active)return
        if(error){setInputRollError(error.message);setInputRolls([])}
        else {setInputRollError(null);setInputRolls(data||[])}
      })
    return ()=>{active=false}
  },[isConversion,form.input_product_id,selectedInputProduct?.unit])

  const weightsInvalid = parsedWeights.some((w) => !Number.isFinite(w) || w <= 0 || w > 500)
  const weightsTotal = parsedWeights.reduce((sum, w) => sum + (Number.isFinite(w) ? w : 0), 0)
  const proportionTotal = materials.reduce((sum, m) => sum + (parseFloat(m.proportion_pct) || 0), 0)

  const handleMachineChange = (machineId: string) => {
    const machine = machines.find((m) => m.id === machineId)
    const conversion = machine?.stage === 'conversion'
    setForm({
      ...form,
      machine_id: machineId,
      finished_good_id: (conversion ? finishedOnlyGoods[0]?.id : semiFinishedGoods[0]?.id) || '',
      input_product_id: conversion ? (semiFinishedGoods[0]?.id || '') : '',
      input_quantity_consumed: '',
      qc_issues: [],
    })
    setMaterials([emptyMaterialLine(rawMaterials)])
  }

  const updateMaterial = (index: number, patch: Partial<MaterialLine>) => {
    setMaterials(materials.map((m, i) => (i === index ? { ...m, ...patch } : m)))
  }

  const toggleQcIssue = (issue: string) => {
    setForm((f) => ({
      ...f,
      qc_issues: f.qc_issues.includes(issue) ? f.qc_issues.filter((i) => i !== issue) : [...f.qc_issues, issue],
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if(isConversion && selectedInputProduct?.unit==='rolls' &&
      (selectedInputRollIds.length===0 || inputRollError)) {
      addToast('Select the available physical input rolls before logging conversion','error')
      return
    }
    if (rollMode && (parsedWeights.length === 0 || weightsInvalid)) {
      addToast('Enter the weight of each roll in kg, separated by commas (e.g. 12.3, 14.6, 20)', 'error')
      return
    }

    setLoading(true)

    const materialRows = isConversion ? [] : materials
      .filter((m) => m.raw_material_id && parseFloat(m.quantity_kg) > 0)
      .map((m) => ({
        raw_material_id: m.raw_material_id,
        quantity_kg: parseFloat(m.quantity_kg),
        proportion_pct: m.proportion_pct ? parseFloat(m.proportion_pct) : null,
      }))

    // Atomic database transaction: all run fields, raw consumption, finished
    // output and physical rolls roll back together on any error.
    const { error } = await supabase.rpc('post_production_run', {
      p_run: {
        run_date: form.run_date,
        shift: form.shift,
        machine_id: form.machine_id,
        operator_name: form.operator_name,
        supervisor_name: form.supervisor_name || null,
        finished_good_id: form.finished_good_id || null,
        film_thickness: form.film_thickness ? parseFloat(form.film_thickness) : null,
        film_width: form.film_width ? parseFloat(form.film_width) : null,
        film_color: form.film_color || null,
        output_quantity: rollMode ? parsedWeights.length : parseFloat(form.output_quantity),
        output_unit: rollMode ? 'rolls' : form.output_unit,
        roll_weights: rollMode ? parsedWeights : null,
        input_product_id: isConversion ? (form.input_product_id || null) : null,
        input_quantity_consumed: isConversion ? (selectedInputProduct?.unit==='rolls' ? selectedInputRollIds.length : (parseFloat(form.input_quantity_consumed) || 0)) : 0,
        input_roll_ids: isConversion && selectedInputProduct?.unit==='rolls' ? selectedInputRollIds : [],
        process_type: isConversion ? form.process_type : null,

        formula_code: !isConversion ? (form.formula_code || null) : null,
        roll_count: !isConversion && form.roll_count ? parseInt(form.roll_count, 10) : null,
        roll_length: !isConversion && form.roll_length ? parseFloat(form.roll_length) : null,
        avg_weight_per_roll: !isConversion && form.avg_weight_per_roll ? parseFloat(form.avg_weight_per_roll) : null,
        start_time: !isConversion ? (form.start_time || null) : null,
        end_time: !isConversion ? (form.end_time || null) : null,
        total_runtime_hours: !isConversion && form.total_runtime_hours ? parseFloat(form.total_runtime_hours) : null,
        downtime_hours: parseFloat(form.downtime_hours) || 0,
        temp_z1: !isConversion && form.temp_z1 ? parseFloat(form.temp_z1) : null,
        temp_z2: !isConversion && form.temp_z2 ? parseFloat(form.temp_z2) : null,
        temp_z3: !isConversion && form.temp_z3 ? parseFloat(form.temp_z3) : null,
        temp_z4: !isConversion && form.temp_z4 ? parseFloat(form.temp_z4) : null,
        temp_z5: !isConversion && form.temp_z5 ? parseFloat(form.temp_z5) : null,
        temp_z6: !isConversion && form.temp_z6 ? parseFloat(form.temp_z6) : null,
        screw_speed_rpm: !isConversion && form.screw_speed_rpm ? parseFloat(form.screw_speed_rpm) : null,
        line_speed_mpm: !isConversion && form.line_speed_mpm ? parseFloat(form.line_speed_mpm) : null,

        cut_length_mm: isCutting && form.cut_length_mm ? parseFloat(form.cut_length_mm) : null,
        bottom_seal_offset_mm: isCutting && form.bottom_seal_offset_mm ? parseFloat(form.bottom_seal_offset_mm) : null,
        cutting_speed_cpm: isCutting && form.cutting_speed_cpm ? parseFloat(form.cutting_speed_cpm) : null,

        print_colours_count: isPrinting && form.print_colours_count ? parseInt(form.print_colours_count, 10) : null,
        print_speed: isPrinting && form.print_speed ? parseFloat(form.print_speed) : null,
        print_tension: isPrinting && form.print_tension ? parseFloat(form.print_tension) : null,
        cleaned_rollers: isPrinting ? form.cleaned_rollers : null,
        roll_edges_ok: isPrinting ? form.roll_edges_ok : null,
        neatness_rating: isPrinting && form.neatness_rating ? parseInt(form.neatness_rating, 10) : null,

        samples_tested: !isPrinting && form.samples_tested ? parseInt(form.samples_tested, 10) : null,
        samples_passed: !isPrinting && form.samples_passed ? parseInt(form.samples_passed, 10) : null,
        samples_failed: !isPrinting && form.samples_failed ? parseInt(form.samples_failed, 10) : null,
        qc_issues: form.qc_issues.length > 0 ? form.qc_issues : null,
        qc_issue_other: form.qc_issue_other || null,

        batch_id: form.batch_id || null,
        quality_grade: form.quality_grade ? parseInt(form.quality_grade, 10) : null,

        waste_quantity: parseFloat(form.waste_quantity) || 0,
        notes: form.notes || null,
        created_by: user?.id,
      },
      p_materials: materialRows,
    })
    if (error) {
      setLoading(false)
      addToast(error.message, 'error')
      return
    }

    setLoading(false)
    onSuccess()
  }

  return (
    <Modal open title="Log Production Run" onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Date"
            type="date"
            value={form.run_date}
            onChange={(e) => setForm({ ...form, run_date: e.target.value })}
            required
          />
          <Select
            label="Shift"
            value={form.shift}
            onChange={(e) => setForm({ ...form, shift: e.target.value as typeof form.shift })}
          >
            <option value="morning">Morning</option>
            <option value="afternoon">Afternoon</option>
            <option value="night">Night</option>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Machine"
            value={form.machine_id}
            onChange={(e) => handleMachineChange(e.target.value)}
            required
          >
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.machine_code} — {m.name} ({m.stage === 'conversion' ? 'Conversion' : 'Extrusion'})
              </option>
            ))}
          </Select>
          {isConversion && (
            <Select
              label="Process"
              value={form.process_type}
              onChange={(e) => setForm({ ...form, process_type: e.target.value as ConversionProcessType, qc_issues: [] })}
            >
              <option value="cutting">Cutting (→ bags/sachets)</option>
              <option value="printing">Printing (→ branded roll)</option>
            </Select>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Operator Name"
            value={form.operator_name}
            onChange={(e) => setForm({ ...form, operator_name: e.target.value })}
            required
          />
          <Input
            label="Supervisor"
            value={form.supervisor_name}
            onChange={(e) => setForm({ ...form, supervisor_name: e.target.value })}
          />
        </div>

        <Select
          label={isConversion ? 'Finished Product (output)' : 'Semi-Finished Product (output)'}
          value={form.finished_good_id}
          onChange={(e) => setForm({ ...form, finished_good_id: e.target.value })}
        >
          <option value="">— Select —</option>
          {outputOptions.map((g) => (
            <option key={g.id} value={g.id}>{g.product_name}</option>
          ))}
        </Select>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Input
            label="Thickness (µ)"
            type="number"
            value={form.film_thickness}
            onChange={(e) => setForm({ ...form, film_thickness: e.target.value })}
          />
          <Input
            label="Width (mm)"
            type="number"
            value={form.film_width}
            onChange={(e) => setForm({ ...form, film_width: e.target.value })}
          />
          <Input
            label="Color"
            value={form.film_color}
            onChange={(e) => setForm({ ...form, film_color: e.target.value })}
          />
        </div>

        {rollMode ? (
          <div className="space-y-3">
            <div>
              <label className="label" htmlFor="roll-weights">Individual roll weights (kg)</label>
              <textarea
                id="roll-weights"
                className="input min-h-[5rem]"
                value={form.roll_weights_text}
                onChange={(e) => setForm({ ...form, roll_weights_text: e.target.value })}
                placeholder="12.3, 14.6, 20, 11, 19.9"
                required
              />
              <p className={`mt-1 text-xs ${weightsInvalid ? 'text-red-600' : 'text-slate-500'}`}>
                {weightsInvalid
                  ? 'Every weight must be a number above 0 and at most 500.'
                  : parsedWeights.length === 0
                  ? `One weight per roll produced, separated by commas${outputProduct ? ` — logged against ${outputProduct.product_name}` : ''}.`
                  : `${parsedWeights.length} roll${parsedWeights.length === 1 ? '' : 's'} · ${weightsTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg total`}
              </p>
            </div>
            <Input
              label="Batch ID"
              value={form.batch_id}
              onChange={(e) => setForm({ ...form, batch_id: e.target.value })}
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Input
              label="Output Quantity"
              type="number"
              step="0.01"
              value={form.output_quantity}
              onChange={(e) => setForm({ ...form, output_quantity: e.target.value })}
              required
            />
            <Select
              label="Output Unit"
              value={form.output_unit}
              onChange={(e) => setForm({ ...form, output_unit: e.target.value as 'kg' | 'rolls' })}
            >
              <option value="kg">Kilograms</option>
              <option value="rolls">Rolls</option>
            </Select>
            <Input
              label="Batch ID"
              value={form.batch_id}
              onChange={(e) => setForm({ ...form, batch_id: e.target.value })}
            />
          </div>
        )}

        {isConversion ? (
          <div className="border-t pt-4">
            <p className="text-sm font-medium text-slate-700 mb-3">Semi-Finished Input</p>
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Semi-Finished Roll (input)"
                value={form.input_product_id}
                onChange={(e) => {setForm({ ...form, input_product_id: e.target.value, input_quantity_consumed: '' });setSelectedInputRollIds([])}}
                required
              >
                <option value="">— Select —</option>
                {semiFinishedGoods.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.product_name} ({g.current_stock} {g.unit} available)
                  </option>
                ))}
              </Select>
              {selectedInputProduct?.unit !== 'rolls' && <Input
                label={`Quantity Consumed${selectedInputProduct ? ` (${selectedInputProduct.unit})` : ''}`}
                type="number"
                min="0.01"
                step="0.01"
                value={form.input_quantity_consumed}
                onChange={(e) => setForm({ ...form, input_quantity_consumed: e.target.value })}
                required
              />}
            </div>

            {selectedInputProduct?.unit==='rolls' && <div className="mt-3 rounded-lg border border-slate-200 p-3">
              <p className="font-medium text-sm">Select physical input rolls (500 most recent available)</p>
              {inputRollError && <p role="alert" className="text-red-700 text-sm">{inputRollError}</p>}
              <p className="text-xs text-slate-500">{selectedInputRollIds.length} rolls selected · {inputRolls.filter(r=>selectedInputRollIds.includes(r.id)).reduce((a,r)=>a+r.weight_kg,0).toFixed(2)} kg</p>
              <div className="max-h-44 overflow-auto grid grid-cols-2 gap-2 mt-2">
                {inputRolls.map(roll=><label key={roll.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={selectedInputRollIds.includes(roll.id)}
                    onChange={e=>setSelectedInputRollIds(old=>e.target.checked?[...old,roll.id]:old.filter(id=>id!==roll.id))}/>
                  #{roll.roll_no} · {roll.weight_kg} kg
                </label>)}
              </div>
              {inputRolls.length===0&&!inputRollError&&<p className="text-xs text-amber-700 mt-2">No physical rolls available. Reconcile historical rolls in Inventory or produce new rolls first.</p>}
            </div>}

            {isCutting && (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4">
                <Input
                  label="Cut Length (mm)"
                  type="number"
                  value={form.cut_length_mm}
                  onChange={(e) => setForm({ ...form, cut_length_mm: e.target.value })}
                />
                <Input
                  label="Bottom Seal Offset (mm)"
                  type="number"
                  value={form.bottom_seal_offset_mm}
                  onChange={(e) => setForm({ ...form, bottom_seal_offset_mm: e.target.value })}
                />
                <Input
                  label="Cutting Speed (cuts/min)"
                  type="number"
                  value={form.cutting_speed_cpm}
                  onChange={(e) => setForm({ ...form, cutting_speed_cpm: e.target.value })}
                />
              </div>
            )}

            {isPrinting && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4">
                  <Input
                    label="No. of Colours"
                    type="number"
                    value={form.print_colours_count}
                    onChange={(e) => setForm({ ...form, print_colours_count: e.target.value })}
                  />
                  <Input
                    label="Print Speed"
                    type="number"
                    value={form.print_speed}
                    onChange={(e) => setForm({ ...form, print_speed: e.target.value })}
                  />
                  <Input
                    label="Tension"
                    type="number"
                    value={form.print_tension}
                    onChange={(e) => setForm({ ...form, print_tension: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4 items-end">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={form.cleaned_rollers}
                      onChange={(e) => setForm({ ...form, cleaned_rollers: e.target.checked })}
                    />
                    Rollers Cleaned
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={form.roll_edges_ok}
                      onChange={(e) => setForm({ ...form, roll_edges_ok: e.target.checked })}
                    />
                    Edges OK
                  </label>
                  <Select
                    label="Neatness (1–5)"
                    value={form.neatness_rating}
                    onChange={(e) => setForm({ ...form, neatness_rating: e.target.value })}
                  >
                    <option value="">—</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </Select>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="border-t pt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-slate-700">Mixing Formula</p>
              <span className={`text-xs ${proportionTotal > 0 && proportionTotal !== 100 ? 'text-amber-600' : 'text-slate-400'}`}>
                Total: {proportionTotal}%
              </span>
            </div>
            {materials.map((line, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end mb-2">
                <Select
                  label={i === 0 ? 'Material' : undefined}
                  value={line.raw_material_id}
                  onChange={(e) => updateMaterial(i, { raw_material_id: e.target.value })}
                >
                  {rawMaterials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}{m.material_code ? ` (${m.material_code})` : ''} — {m.current_stock} {m.unit} available
                    </option>
                  ))}
                </Select>
                <Input
                  label={i === 0 ? 'Qty (kg)' : undefined}
                  type="number"
                  step="0.01"
                  className="w-full sm:w-28"
                  value={line.quantity_kg}
                  onChange={(e) => updateMaterial(i, { quantity_kg: e.target.value })}
                />
                <Input
                  label={i === 0 ? 'Proportion %' : undefined}
                  type="number"
                  step="0.1"
                  className="w-full sm:w-28"
                  value={line.proportion_pct}
                  onChange={(e) => updateMaterial(i, { proportion_pct: e.target.value })}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setMaterials(materials.filter((_, idx) => idx !== i))}
                  disabled={materials.length === 1}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              onClick={() => setMaterials([...materials, emptyMaterialLine(rawMaterials)])}
            >
              + Add Material
            </Button>

            <Input
              label="Formula Code"
              className="mt-4"
              value={form.formula_code}
              onChange={(e) => setForm({ ...form, formula_code: e.target.value })}
            />

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-4">
              <Input
                label="Number of Rolls"
                type="number"
                value={form.roll_count}
                onChange={(e) => setForm({ ...form, roll_count: e.target.value })}
              />
              <Input
                label="Length of Roll"
                type="number"
                value={form.roll_length}
                onChange={(e) => setForm({ ...form, roll_length: e.target.value })}
              />
              <Input
                label="Avg Weight per Roll (kg)"
                type="number"
                step="0.01"
                value={form.avg_weight_per_roll}
                onChange={(e) => setForm({ ...form, avg_weight_per_roll: e.target.value })}
              />
            </div>

            <p className="text-sm font-medium text-slate-700 mt-4 mb-3">Production Time</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Input
                label="Start Time"
                type="time"
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
              />
              <Input
                label="End Time"
                type="time"
                value={form.end_time}
                onChange={(e) => setForm({ ...form, end_time: e.target.value })}
              />
              <Input
                label="Total Runtime (hrs)"
                type="number"
                step="0.1"
                value={form.total_runtime_hours}
                onChange={(e) => setForm({ ...form, total_runtime_hours: e.target.value })}
              />
              <Input
                label="Downtime (hrs)"
                type="number"
                step="0.1"
                value={form.downtime_hours}
                onChange={(e) => setForm({ ...form, downtime_hours: e.target.value })}
              />
            </div>

            <p className="text-sm font-medium text-slate-700 mt-4 mb-3">Machine Parameters</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {(['temp_z1', 'temp_z2', 'temp_z3', 'temp_z4', 'temp_z5', 'temp_z6'] as const).map((z, i) => (
                <Input
                  key={z}
                  label={`Z${i + 1} °C`}
                  type="number"
                  value={form[z]}
                  onChange={(e) => setForm({ ...form, [z]: e.target.value })}
                />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4 mt-4">
              <Input
                label="Screw Speed (RPM)"
                type="number"
                value={form.screw_speed_rpm}
                onChange={(e) => setForm({ ...form, screw_speed_rpm: e.target.value })}
              />
              <Input
                label="Line Speed (m/min)"
                type="number"
                value={form.line_speed_mpm}
                onChange={(e) => setForm({ ...form, line_speed_mpm: e.target.value })}
              />
            </div>
          </div>
        )}

        <div className="border-t pt-4">
          <p className="text-sm font-medium text-slate-700 mb-3">Quality Control</p>
          {!isPrinting && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-3">
              <Input
                label="Samples Tested"
                type="number"
                value={form.samples_tested}
                onChange={(e) => setForm({ ...form, samples_tested: e.target.value })}
              />
              <Input
                label="Passed"
                type="number"
                value={form.samples_passed}
                onChange={(e) => setForm({ ...form, samples_passed: e.target.value })}
              />
              <Input
                label="Failed"
                type="number"
                value={form.samples_failed}
                onChange={(e) => setForm({ ...form, samples_failed: e.target.value })}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-4 mb-3">
            {qcIssueOptions.map((issue) => (
              <label key={issue} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.qc_issues.includes(issue)}
                  onChange={() => toggleQcIssue(issue)}
                />
                {issue}
              </label>
            ))}
          </div>
          {form.qc_issues.includes('Other') && (
            <Input
              label="Other Issue (detail)"
              value={form.qc_issue_other}
              onChange={(e) => setForm({ ...form, qc_issue_other: e.target.value })}
            />
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Quality Grade (1–3)"
            value={form.quality_grade}
            onChange={(e) => setForm({ ...form, quality_grade: e.target.value })}
          >
            <option value="">—</option>
            <option value="1">1 — Best</option>
            <option value="2">2</option>
            <option value="3">3 — Lowest</option>
          </Select>
          <Input
            label="Waste / Scrap (kg)"
            type="number"
            step="0.01"
            value={form.waste_quantity}
            onChange={(e) => setForm({ ...form, waste_quantity: e.target.value })}
          />
        </div>

        <Input
          label="Remarks / Notes"
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save Production Run</Button>
        </div>
      </form>
    </Modal>
  )
}
