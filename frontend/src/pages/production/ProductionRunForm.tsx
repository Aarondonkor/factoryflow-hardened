import { useState,useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import type { Machine, RawMaterial, FinishedGood, ConversionProcessType } from '@/types/database'
import { toInputDate } from '@/lib/format'
import { checkRollPortions, type RollPortion } from '@/lib/rollAllocations'
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

interface SharedInputGroup {
  key: string
  input_product_id: string
  roll_weights: Record<string,string>
  output_keys: string[]
}

interface MaterialLine {
  raw_material_id: string
  quantity_kg: string
  proportion_pct: string
}

interface AdditionalOutputLine {
  key: string
  finished_good_id: string
  output_quantity: string
  roll_weights_text: string
  batch_id: string
  film_thickness: string
  film_width: string
  film_color: string
  quality_grade: string
  input_product_id: string
  input_quantity_consumed: string
  input_roll_ids: string[]
  input_roll_weights: Record<string,string>
}

function parseRollWeights(text: string): number[] {
  return text.split(/[\s,;]+/).filter(Boolean).map(Number)
}

function emptyAdditionalOutput(): AdditionalOutputLine {
  return {
    key: crypto.randomUUID(), finished_good_id: '', output_quantity: '',
    roll_weights_text: '', batch_id: '', film_thickness: '', film_width: '',
    film_color: '', quality_grade: '', input_product_id: '',
    input_quantity_consumed: '', input_roll_ids: [], input_roll_weights: {},
  }
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
  type AvailableRoll = {id:string;roll_no:number;weight_kg:number;micron:number|null}
  const [availableRollsByProduct,setAvailableRollsByProduct]=useState<Record<string,AvailableRoll[]>>({})
  const [rollErrorsByProduct,setRollErrorsByProduct]=useState<Record<string,string>>({})
  const [selectedInputRollIds,setSelectedInputRollIds]=useState<string[]>([])
  const [primaryRollWeights,setPrimaryRollWeights]=useState<Record<string,string>>({})

  const semiFinishedGoods = finishedGoods.filter((g) => g.stage === 'semi_finished')
  const finishedOnlyGoods = finishedGoods.filter((g) => g.stage === 'finished')

  const initialMachine = machines[0]
  const initialIsConversion = initialMachine?.stage === 'conversion'

  const [materials, setMaterials] = useState<MaterialLine[]>([emptyMaterialLine(rawMaterials)])
  const [additionalOutputs, setAdditionalOutputs] = useState<AdditionalOutputLine[]>([])
  const [inputRecordingMode,setInputRecordingMode] = useState<'individual'|'shared'>('individual')
  const [sharedGroups,setSharedGroups] = useState<SharedInputGroup[]>([])


  const updateOutput = (key: string, patch: Partial<AdditionalOutputLine>) => {
    setAdditionalOutputs((outputs) => outputs.map((item) => item.key === key ? { ...item, ...patch } : item))
  }

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
  const isSharedMode = isConversion && additionalOutputs.length > 0 && inputRecordingMode === 'shared'
  const isPrinting = isConversion && form.process_type === 'printing'
  const isCutting = isConversion && form.process_type === 'cutting'
  const outputOptions = isConversion ? finishedOnlyGoods : semiFinishedGoods
  const selectedInputProduct = semiFinishedGoods.find((g) => g.id === form.input_product_id)
  const qcIssueOptions = isPrinting ? PRINTING_QC_ISSUES : EXTRUSION_QC_ISSUES
  // Printing runs that produce a roll product log the weight of every roll,
  // e.g. "12.3, 14.6, 20, 11, 19.9". Each weight becomes one sellable roll.
  const outputProduct = finishedGoods.find((g) => g.id === form.finished_good_id)
  const rollMode = outputProduct?.unit === 'rolls'
  const parsedWeights = parseRollWeights(form.roll_weights_text)
  // Fetch physical rolls for every independently selected semi-finished product.
  const inputProductIds = isConversion
    ? [...new Set([form.input_product_id, ...additionalOutputs.map(o => o.input_product_id), ...sharedGroups.map(g => g.input_product_id)].filter(Boolean))].sort().join(',')
    : ''
  useEffect(() => {
    let active = true
    if (!inputProductIds) {
      setAvailableRollsByProduct({})
      setRollErrorsByProduct({})
      return
    }
    const productIds = inputProductIds.split(',')
      .filter(id => finishedGoods.some(g => g.id === id && g.stage === 'semi_finished' && g.unit === 'rolls'))
    Promise.all(productIds.map(async (id) => {
      const { data, error } = await supabase.from('product_rolls')
        .select('id,roll_no,weight_kg,micron')
        .eq('finished_good_id', id).eq('status', 'available')
        .order('roll_no', { ascending: false }).limit(500)
      return { id, data: (data || []) as AvailableRoll[], error: error?.message }
    })).then(results => {
      if (!active) return
      setAvailableRollsByProduct(Object.fromEntries(results.map(r => [r.id, r.data])))
      setRollErrorsByProduct(Object.fromEntries(results.filter(r => r.error).map(r => [r.id, r.error!])))
    })
    return () => { active = false }
  }, [inputProductIds, isConversion, finishedGoods])

  const selectedRollIdsAcrossOutputs = new Set([
    ...selectedInputRollIds,
    ...additionalOutputs.flatMap(o => o.input_roll_ids),
  ])
  // In a multi-output conversion run, kilogram portions can be allocated from
  // the SAME physical roll to more than one finished output.
  const allocatedRollMode = !isSharedMode && isConversion && additionalOutputs.length > 0 &&
    selectedInputProduct?.unit === 'rolls' && additionalOutputs.every(o =>
      semiFinishedGoods.find(g => g.id === o.input_product_id)?.unit === 'rolls')
  const measuredPortions: RollPortion[] = [
    ...selectedInputRollIds.map(id => ({ roll_id:id, weight_kg: Number(primaryRollWeights[id]) })),
    ...additionalOutputs.flatMap(o => o.input_roll_ids.map(id => ({
      roll_id:id, weight_kg: Number(o.input_roll_weights[id]),
    }))),
  ]
  const availableRollWeights: Record<string,number> = Object.fromEntries(
    Object.values(availableRollsByProduct).flat().map(r => [r.id,r.weight_kg]))
  const portionError = allocatedRollMode ? checkRollPortions(availableRollWeights, measuredPortions) : null
  // Preserve the detailed allocation option for measured per-brand consumption.
  const primaryAllocatedKg = selectedInputRollIds.reduce(
    (sum,id)=>sum+Number(primaryRollWeights[id] || 0),0)
  const allocationMatches = (entered:string, measured:number) =>
    Number.isFinite(Number(entered)) && Number(entered)>0 &&
    Math.abs(Number(entered)-measured)<0.005
  const inputRolls = availableRollsByProduct[form.input_product_id] || []
  const inputRollError = rollErrorsByProduct[form.input_product_id] || null
  const micronMismatch = (inputId: string, outputId: string, thickness = '') => {
    const input = semiFinishedGoods.find(g => g.id === inputId)
    const output = finishedOnlyGoods.find(g => g.id === outputId)
    const inputMicron = input?.spec_thickness
    const outputMicron = output?.spec_thickness
    const enteredMicron = thickness ? Number(thickness) : null
    return (inputMicron != null && outputMicron != null &&
        Math.abs(Number(inputMicron) - Number(outputMicron)) > 0.1) ||
      (inputMicron != null && enteredMicron != null &&
        Math.abs(Number(inputMicron) - enteredMicron) > 0.1) ||
      (outputMicron != null && enteredMicron != null &&
        Math.abs(Number(outputMicron) - enteredMicron) > 0.1)
  }

  const rollMicronMismatch = (micron: number | null, inputId: string, outputId: string, thickness = '') => {
    if (micron == null) return false
    const input = semiFinishedGoods.find(g => g.id === inputId)
    const output = finishedOnlyGoods.find(g => g.id === outputId)
    return (input?.spec_thickness != null && Math.abs(micron - Number(input.spec_thickness)) > 0.1) ||
      (output?.spec_thickness != null && Math.abs(micron - Number(output.spec_thickness)) > 0.1) ||
      (thickness !== '' && Math.abs(micron - Number(thickness)) > 0.1)
  }

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
    setAdditionalOutputs([])
    setInputRecordingMode('individual')
    setSharedGroups([])
    setSelectedInputRollIds([])
    setPrimaryRollWeights({})
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

    if(!isSharedMode && isConversion && selectedInputProduct?.unit==='rolls' &&
      (selectedInputRollIds.length===0 || inputRollError)) {
      addToast('Select the available physical input rolls before logging conversion','error')
      return
    }
    if (!isSharedMode && isConversion && (!selectedInputProduct ||
      (selectedInputProduct.unit !== 'rolls' && !(Number(form.input_quantity_consumed) > 0)))) {
      addToast('Choose a semi-finished input and enter its consumed quantity', 'error')
      return
    }
    if (!isSharedMode && isConversion && micronMismatch(form.input_product_id, form.finished_good_id, form.film_thickness)) {
      addToast('Primary input micron must match its finished product', 'error')
      return
    }
    if (!isSharedMode && !allocatedRollMode && selectedRollIdsAcrossOutputs.size !== selectedInputRollIds.length +
        additionalOutputs.reduce((total, o) => total + o.input_roll_ids.length, 0)) {
      addToast('Physical roll sharing requires roll-counted semi-finished inputs for every output', 'error')
      return
    }
    if (allocatedRollMode && portionError) {
      addToast(portionError, 'error')
      return
    }
    if (allocatedRollMode && !allocationMatches(form.input_quantity_consumed,primaryAllocatedKg)) {
      addToast('Primary finished product consumed kg must match the source-roll portions','error')
      return
    }
    if (allocatedRollMode && measuredPortions.length !==
        selectedInputRollIds.length + additionalOutputs.reduce((sum,o)=>sum+o.input_roll_ids.length,0)) {
      addToast('Every selected physical roll requires a measured kilogram portion', 'error')
      return
    }
    if (!isSharedMode && isConversion && inputRolls.some(r => selectedInputRollIds.includes(r.id) &&
        rollMicronMismatch(r.micron, form.input_product_id, form.finished_good_id, form.film_thickness))) {
      addToast('A selected primary input roll has a mismatched micron thickness', 'error')
      return
    }
    if (!outputProduct || !outputOptions.some((g) => g.id === outputProduct.id)) {
      addToast('Select a valid output product for the selected machine', 'error')
      return
    }
    if (rollMode && (parsedWeights.length === 0 || parsedWeights.length > 1000 || weightsInvalid)) {
      addToast('Enter 1–1000 measured roll weights, each greater than 0 and at most 500 kg', 'error')
      return
    }
    if (!rollMode && !(Number(form.output_quantity) > 0)) {
      addToast('Enter a positive output quantity', 'error')
      return
    }
    if (additionalOutputs.length > 19) {
      addToast('A run can include at most 20 output lines', 'error')
      return
    }

    const moreOutputs = []
    for (const line of additionalOutputs) {
      const product = outputOptions.find((g) => g.id === line.finished_good_id)
      if (!product) {
        addToast('Choose a valid product for every additional output', 'error')
        return
      }
      const weights = parseRollWeights(line.roll_weights_text)
      if (product.unit === 'rolls' && (weights.length === 0 || weights.length > 1000 ||
        weights.some((w) => !Number.isFinite(w) || w <= 0 || w > 500))) {
        addToast(`Enter valid individual weights for ${product.product_name}`, 'error')
        return
      }
      const quantity = product.unit === 'rolls' ? weights.length : Number(line.output_quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        addToast(`Enter a positive output quantity for ${product.product_name}`, 'error')
        return
      }
      const input = isConversion ? semiFinishedGoods.find(g => g.id === line.input_product_id) : undefined
      if (!isSharedMode && isConversion && !input) {
        addToast(`Choose a semi-finished input for ${product.product_name}`, 'error')
        return
      }
      if (!isSharedMode && isConversion && micronMismatch(line.input_product_id, product.id, line.film_thickness)) {
        addToast(`Input and finished product micron differ for ${product.product_name}`, 'error')
        return
      }
      if (!isSharedMode && isConversion && input?.unit === 'rolls' &&
          (line.input_roll_ids.length === 0 || !!rollErrorsByProduct[line.input_product_id])) {
        addToast(`Choose available physical input rolls for ${product.product_name}`, 'error')
        return
      }
      if (!isSharedMode && isConversion && input?.unit === 'rolls' &&
          (availableRollsByProduct[input.id] || []).some(r => line.input_roll_ids.includes(r.id) &&
            rollMicronMismatch(r.micron, input.id, product.id, line.film_thickness))) {
        addToast(`A semi-finished roll's micron does not match ${product.product_name}`, 'error')
        return
      }
      if (!isSharedMode && isConversion && input?.unit !== 'rolls' && !(Number(line.input_quantity_consumed) > 0)) {
        addToast(`Enter the semi-finished quantity consumed for ${product.product_name}`, 'error')
        return
      }
      if (allocatedRollMode) {
        const consumed = line.input_roll_ids.reduce((sum,id) => sum + Number(line.input_roll_weights[id] || 0),0)
        if (!allocationMatches(line.input_quantity_consumed,consumed)) {
          addToast(`Consumed kg for ${product.product_name} must match source-roll portions`,'error')
          return
        }
        const actualOutputKg = product.unit === 'rolls' ? weights.reduce((sum,w)=>sum+w,0) : quantity
        if (product.unit !== 'bundle' && actualOutputKg > consumed + 0.01) {
          addToast(`Output ${product.product_name} weighs more than its allocated input`, 'error')
          return
        }
      }
      moreOutputs.push({
        ...(isSharedMode ? {} : allocatedRollMode ? {
          input_product_id: input!.id,
          input_quantity_consumed: line.input_roll_ids.reduce((sum,id)=>sum+Number(line.input_roll_weights[id]),0),
          input_roll_allocations: line.input_roll_ids.map(id=>({roll_id:id,weight_kg:Number(line.input_roll_weights[id])})),
        } : isConversion ? {
          input_product_id: input!.id,
          input_quantity_consumed: input!.unit === 'rolls'
            ? line.input_roll_ids.length : Number(line.input_quantity_consumed),
          input_roll_ids: input!.unit === 'rolls' ? line.input_roll_ids : [],
        } : {}),
        finished_good_id: product.id,
        output_unit: product.unit,
        output_quantity: quantity,
        roll_weights: product.unit === 'rolls' ? weights : null,
        batch_id: line.batch_id || null,
        film_thickness: line.film_thickness ? Number(line.film_thickness) : null,
        film_width: line.film_width ? Number(line.film_width) : null,
        film_color: line.film_color || null,
        quality_grade: line.quality_grade ? Number(line.quality_grade) : null,
      })
    }

    if (allocatedRollMode) {
      const primaryKg = selectedInputRollIds.reduce((sum,id)=>sum+Number(primaryRollWeights[id] || 0),0)
      const primaryOutputKg = rollMode ? weightsTotal : Number(form.output_quantity)
      if (outputProduct.unit !== 'bundle' && primaryOutputKg > primaryKg + 0.01) {
        addToast('Primary output weighs more than its allocated semi-finished input','error')
        return
      }
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
    const runPayload = {
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
        output_unit: outputProduct.unit,
        roll_weights: rollMode ? parsedWeights : null,
        input_product_id: isSharedMode ? null : isConversion ? (form.input_product_id || null) : null,
        input_quantity_consumed: isSharedMode ? 0 : isConversion ? (allocatedRollMode
          ? selectedInputRollIds.reduce((sum,id)=>sum+Number(primaryRollWeights[id]),0)
          : selectedInputProduct?.unit==='rolls' ? selectedInputRollIds.length : (parseFloat(form.input_quantity_consumed) || 0)) : 0,
        ...(allocatedRollMode ? {input_roll_allocations: selectedInputRollIds.map(id=>({
          roll_id:id, weight_kg:Number(primaryRollWeights[id]),
        }))} : {}),
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
      }
    // Both paths are atomic. Multi-output posting consumes the selected inputs
    // once, then credits each additional product and its individual rolls.
    // A shared input group records only total source-roll consumption. It never
    // invents per-brand consumption weights.
    const outputKeys = ['primary',...additionalOutputs.map(o => o.key)]
    const groupPayload = sharedGroups.map(g=>({
      input_product_id:g.input_product_id,
      output_indices:g.output_keys.map(key=>outputKeys.indexOf(key)),
      roll_allocations:Object.entries(g.roll_weights).filter(([,kg])=>Number(kg)>0)
        .map(([roll_id,kg])=>({roll_id,weight_kg:Number(kg)})),
    }))
    if(isSharedMode) {
      if(sharedGroups.length===0 || sharedGroups.some(g=>!g.input_product_id ||
        g.output_keys.length===0 || Object.values(g.roll_weights).length===0)) {
        addToast('Assign every finished output to a shared semi-finished input group and enter consumed roll weights','error')
        return
      }
      const counts=outputKeys.map(key=>sharedGroups.filter(g=>g.output_keys.includes(key)).length)
      if(counts.some(n=>n!==1)) {
        addToast('Each finished product must belong to exactly one shared input group','error')
        return
      }
      const used=new Set<string>()
      for(const g of sharedGroups) {
        const input=semiFinishedGoods.find(x=>x.id===g.input_product_id)
        if(!input || input.unit!=='rolls') {addToast('Shared groups require a roll-counted semi-finished product','error');return}
        const selected=Object.entries(g.roll_weights)
        if(selected.some(([id,kg])=>!Number.isFinite(Number(kg))||Number(kg)<=0 ||
          Number(kg)>Number(availableRollWeights[id]||0)||Math.abs(Math.round(Number(kg)*100)-Number(kg)*100)>1e-6 || used.has(id))) {
          addToast('Shared group weights must be positive, at most the available roll weight, and each roll can belong to only one group','error');return
        }
        for(const [id] of selected) used.add(id)
        for(const key of g.output_keys) {
          const idx=outputKeys.indexOf(key)
          const product=finishedOnlyGoods.find(x=>x.id===(idx===0?form.finished_good_id:additionalOutputs[idx-1].finished_good_id))
          const thickness=idx===0?form.film_thickness:additionalOutputs[idx-1].film_thickness
          if(!product || micronMismatch(input.id,product.id,thickness) ||
            selected.some(([id])=>{
              const roll=(availableRollsByProduct[input.id]||[]).find(r=>r.id===id)
              return !roll || rollMicronMismatch(roll.micron,input.id,product.id,thickness)
            })) {addToast('Shared input group contains an incompatible finished product or physical roll','error');return}
        }
      }
    }
    const { error } = isSharedMode
      ? await supabase.rpc('post_shared_conversion_run', {
          p_run: runPayload,p_additional_outputs: moreOutputs,p_input_groups: groupPayload,
        })
      : allocatedRollMode
      ? await supabase.rpc('post_allocated_conversion_run', {
          p_run: runPayload, p_additional_outputs: moreOutputs,
        })
      : additionalOutputs.length > 0
      ? await supabase.rpc('post_multi_production_run', {
          p_run: runPayload, p_materials: materialRows, p_additional_outputs: moreOutputs,
        })
      : await supabase.rpc('post_production_run', { p_run: runPayload, p_materials: materialRows })
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
            <div>
              <p className="label">Stock Unit</p>
              <p className="input flex items-center bg-slate-50">{outputProduct?.unit || 'Select a product'}</p>
            </div>
            <Input
              label="Batch ID"
              value={form.batch_id}
              onChange={(e) => setForm({ ...form, batch_id: e.target.value })}
            />
          </div>
        )}

        {isConversion && <section className="rounded-lg border p-3 space-y-2" aria-label="Input consumption recording method">
          <p className="font-medium text-sm">How was semi-finished material consumption measured?</p>
          <div className="flex gap-4 text-sm">
            <label><input type="radio" name="input-mode" checked={inputRecordingMode==='individual'} onChange={()=>setInputRecordingMode('individual')} /> Individual allocation per finished product</label>
            <label><input type="radio" name="input-mode" checked={inputRecordingMode==='shared'} onChange={()=>setInputRecordingMode('shared')} /> Shared total by input material</label>
          </div>
          <p className="text-xs text-slate-600">Shared mode records the total kg used by each semi-finished material, linked to multiple finished outputs. It does not estimate per-brand input quantities.</p>
          {inputRecordingMode==='shared' && additionalOutputs.length===0 && <p className="text-xs text-amber-700">Add another finished product to enable shared input groups.</p>}
        </section>}
        {isSharedMode && <section aria-label="Shared semi-finished input groups" className="rounded-lg bg-blue-50 border border-blue-200 p-4 space-y-3">
          <div className="flex justify-between items-center gap-2">
            <h3 className="font-semibold">Shared input groups (measured total kg)</h3>
            <Button type="button" variant="secondary" onClick={()=>setSharedGroups(groups=>[...groups,{
              key:crypto.randomUUID(),input_product_id:'',roll_weights:{},output_keys:[],
            }])}>+ Add input group</Button>
          </div>
          {sharedGroups.map((group,i)=>{
            const rolls=availableRollsByProduct[group.input_product_id]||[]
            const groupTotal=Object.values(group.roll_weights).reduce((a,v)=>a+Number(v||0),0)
            const outputs=[{key:'primary',name:outputProduct?.product_name||'Primary output'},
              ...additionalOutputs.map((o,j)=>({key:o.key,name:finishedOnlyGoods.find(g=>g.id===o.finished_good_id)?.product_name||`Output ${j+2}`}))]
            return <div key={group.key} className="bg-white p-3 rounded-lg border space-y-3">
              <div className="flex justify-between"><strong className="text-sm">Input group {i+1}</strong>
                <Button type="button" variant="secondary" onClick={()=>setSharedGroups(items=>items.filter(g=>g.key!==group.key))}>Remove</Button></div>
              <Select label="Semi-finished input product (micron)" value={group.input_product_id}
                onChange={e=>setSharedGroups(items=>items.map(g=>g.key===group.key?{...g,input_product_id:e.target.value,roll_weights:{}}:g))} required>
                <option value="">— Select material —</option>
                {semiFinishedGoods.filter(g=>g.unit==='rolls').map(g=><option key={g.id} value={g.id}>{g.product_name} ({g.spec_thickness??'—'} µ)</option>)}
              </Select>
              <p className="text-sm font-medium">Finished products sharing this input (no per-product kg required)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {outputs.map(o=><label key={o.key} className="text-sm flex items-center gap-2">
                  <input type="checkbox" checked={group.output_keys.includes(o.key)}
                    onChange={e=>setSharedGroups(items=>items.map(g=>g.key===group.key?{
                      ...g,output_keys:e.target.checked?[...g.output_keys,o.key]:g.output_keys.filter(key=>key!==o.key),
                    }:g))} /> {o.name}
                </label>)}
              </div>
              <p className="text-sm font-medium">Source rolls and total measured kg used</p>
              {rollErrorsByProduct[group.input_product_id] && <p role="alert" className="text-red-700">{rollErrorsByProduct[group.input_product_id]}</p>}
              <div className="max-h-44 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-2">
                {rolls.map(roll=><div key={roll.id} className="text-xs border p-2 rounded">
                  <label className="flex gap-2 items-center">
                    <input type="checkbox" checked={group.roll_weights[roll.id]!==undefined}
                      onChange={e=>setSharedGroups(items=>items.map(g=>g.key===group.key?{
                        ...g,roll_weights:e.target.checked?{...g.roll_weights,[roll.id]:''}:Object.fromEntries(Object.entries(g.roll_weights).filter(([id])=>id!==roll.id)),
                      }:g))} /> Roll #{roll.roll_no} · {roll.weight_kg} kg remaining
                  </label>
                  {group.roll_weights[roll.id]!==undefined && <Input label="Total kg consumed from roll" type="number" min="0.01" max={roll.weight_kg} step="0.01"
                    value={group.roll_weights[roll.id]} onChange={e=>setSharedGroups(items=>items.map(g=>g.key===group.key?{
                      ...g,roll_weights:{...g.roll_weights,[roll.id]:e.target.value},
                    }:g))} required />}
                </div>)}
              </div>
              <p className="text-sm">Total group input: <strong>{groupTotal.toFixed(2)} kg</strong></p>
            </div>
          })}
        </section>}
        <section aria-label="Additional production outputs" className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Additional Products</h3>
              <p className="text-xs text-slate-600">
                Add other {isConversion ? 'finished' : 'semi-finished'} products produced in the same run.
                {isConversion ? 'Choose a semi-finished input for each product. One physical roll may supply multiple finished products; record its kg used for each output.' : 'Raw materials are deducted once for this extrusion run.'}
              </p>
            </div>
            <Button type="button" variant="secondary" disabled={additionalOutputs.length >= 19 || outputOptions.length === 0}
              onClick={() => setAdditionalOutputs((list) => [...list, emptyAdditionalOutput()])}>
              + Add Product
            </Button>
          </div>
          {additionalOutputs.map((line, index) => {
            const product = outputOptions.find((g) => g.id === line.finished_good_id)
            const isRoll = product?.unit === 'rolls'
            const weights = parseRollWeights(line.roll_weights_text)
            return (
              <div key={line.key} className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">Output {index + 2}</p>
                  <Button type="button" variant="secondary" onClick={() => setAdditionalOutputs((items) => items.filter((o) => o.key !== line.key))}>
                    Remove
                  </Button>
                </div>
                <Select label="Product" required value={line.finished_good_id}
                  onChange={(e) => updateOutput(line.key, {
                    finished_good_id: e.target.value, output_quantity: '', roll_weights_text: '',
                  })}>
                  <option value="">— Select product —</option>
                  {outputOptions.map((g) => <option key={g.id} value={g.id}>{g.product_name} ({g.unit})</option>)}
                </Select>
                {isRoll ? (
                  <div>
                    <label htmlFor={`output-rolls-${line.key}`} className="label">Individual roll weights (kg)</label>
                    <textarea id={`output-rolls-${line.key}`} required className="input min-h-[4rem]"
                      placeholder="12.3, 14.6, 20" value={line.roll_weights_text}
                      onChange={(e) => updateOutput(line.key, { roll_weights_text: e.target.value })} />
                    <p className="text-xs text-slate-500 mt-1">{weights.length} rolls · {weights.reduce((sum, w) => sum + (Number.isFinite(w) ? w : 0), 0).toFixed(2)} kg</p>
                  </div>
                ) : (
                  <Input label={`Quantity${product ? ` (${product.unit})` : ''}`} type="number" min="0.01" step="0.01" required
                    value={line.output_quantity} onChange={(e) => updateOutput(line.key, { output_quantity: e.target.value })} />
                )}
                {isConversion && allocatedRollMode && <Input
                  label={`Measured input used for ${product?.product_name || 'finished product'} (kg)`}
                  type="number" min="0.01" step="0.01" required
                  value={line.input_quantity_consumed}
                  onChange={e=>updateOutput(line.key,{input_quantity_consumed:e.target.value})} />}
                {isConversion && !isSharedMode && <section aria-label={`Semi-finished input for output ${index + 2}`}
                  className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-3">
                  <h4 className="text-sm font-semibold text-amber-950">Input for output {index + 2}</h4>
                  <Select label="Semi-finished input product" required value={line.input_product_id}
                    onChange={(e) => updateOutput(line.key, {
                      input_product_id: e.target.value,
                      input_quantity_consumed: '', input_roll_ids: [], input_roll_weights: {},
                    })}>
                    <option value="">— Select input —</option>
                    {semiFinishedGoods.map(g => <option key={g.id} value={g.id}>
                      {g.product_name} ({g.spec_thickness ?? '—'} µ · {g.current_stock} {g.unit} available)
                    </option>)}
                  </Select>
                  {(() => {
                    const input = semiFinishedGoods.find(g => g.id === line.input_product_id)
                    if (!input) return <p className="text-xs text-amber-900">Choose an input for this output.</p>
                    if (input.unit !== 'rolls') return <Input
                      label={`Quantity consumed (${input.unit})`} type="number" min="0.01" step="0.01" required
                      value={line.input_quantity_consumed}
                      onChange={(e) => updateOutput(line.key, { input_quantity_consumed: e.target.value })} />
                    const rolls = availableRollsByProduct[input.id] || []
                    const error = rollErrorsByProduct[input.id]
                    return <div className="space-y-2">
                      <p className="text-xs font-medium">Select physical input rolls (500 latest available)</p>
                      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
                      <p className="text-xs text-slate-700">{line.input_roll_ids.length} roll(s) selected · {
                        allocatedRollMode ? line.input_roll_ids.reduce((sum,id) => sum+Number(line.input_roll_weights[id]||0),0).toFixed(2)
                          : rolls.filter(r => line.input_roll_ids.includes(r.id)).reduce((sum,r) => sum + r.weight_kg, 0).toFixed(2)
                      } kg {allocatedRollMode ? 'allocated' : 'available'}</p>
                      <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto">
                        {rolls.map(roll => <div key={roll.id} className="space-y-1 rounded-md border bg-white p-2 text-xs">
                          <label className="flex gap-2 items-center">
                            <input type="checkbox" checked={line.input_roll_ids.includes(roll.id)}
                              disabled={!line.input_roll_ids.includes(roll.id) && (
                                (!allocatedRollMode && selectedRollIdsAcrossOutputs.has(roll.id)) ||
                                rollMicronMismatch(roll.micron, input.id, line.finished_good_id, line.film_thickness))}
                              onChange={e => updateOutput(line.key, {
                                input_roll_ids: e.target.checked ? [...line.input_roll_ids, roll.id]
                                  : line.input_roll_ids.filter(id => id !== roll.id),
                                input_roll_weights: e.target.checked ? line.input_roll_weights :
                                  Object.fromEntries(Object.entries(line.input_roll_weights).filter(([id]) => id !== roll.id)),
                              })} />
                            #{roll.roll_no} · {roll.weight_kg} kg available · {roll.micron ?? '—'} µ
                          </label>
                          {allocatedRollMode && line.input_roll_ids.includes(roll.id) && <Input
                            label="Kg used for this finished product" type="number" min="0.01" max={roll.weight_kg}
                            step="0.01" required value={line.input_roll_weights[roll.id] || ''}
                            onChange={e => updateOutput(line.key, {
                              input_roll_weights: {...line.input_roll_weights, [roll.id]: e.target.value},
                            })} />}
                        </div>)}
                      </div>
                      {!rolls.length && !error && <p className="text-xs text-amber-900">No available physical rolls for this product.</p>}
                    </div>
                  })()}
                  {micronMismatch(line.input_product_id, line.finished_good_id, line.film_thickness) &&
                    <p role="alert" className="text-xs text-red-700">Input micron differs from this output. Select a matching product.</p>}
                </section>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Batch ID" value={line.batch_id} onChange={(e) => updateOutput(line.key, { batch_id: e.target.value })} />
                  <Select label="Quality Grade" value={line.quality_grade}
                    onChange={(e) => updateOutput(line.key, { quality_grade: e.target.value })}>
                    <option value="">— Not recorded —</option>
                    <option value="1">1 — Best</option><option value="2">2</option><option value="3">3 — Lowest</option>
                  </Select>
                  <Input label="Thickness (µ)" type="number" step="0.01" min="0" value={line.film_thickness}
                    onChange={(e) => updateOutput(line.key, { film_thickness: e.target.value })} />
                  <Input label="Width (mm)" type="number" step="0.01" min="0" value={line.film_width}
                    onChange={(e) => updateOutput(line.key, { film_width: e.target.value })} />
                  <Input label="Colour" value={line.film_color} onChange={(e) => updateOutput(line.key, { film_color: e.target.value })} />
                </div>
              </div>
            )
          })}
        </section>

        {isSharedMode && <section className="border-t pt-3 space-y-3" aria-label="Shared conversion process settings">
          <p className="font-medium text-sm">Conversion process settings</p>
          {isCutting && <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Input label="Cut Length (mm)" type="number" value={form.cut_length_mm}
              onChange={e=>setForm({...form,cut_length_mm:e.target.value})} />
            <Input label="Bottom Seal Offset (mm)" type="number" value={form.bottom_seal_offset_mm}
              onChange={e=>setForm({...form,bottom_seal_offset_mm:e.target.value})} />
            <Input label="Cutting Speed (cuts/min)" type="number" value={form.cutting_speed_cpm}
              onChange={e=>setForm({...form,cutting_speed_cpm:e.target.value})} />
          </div>}
          {isPrinting && <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Input label="Colours" type="number" value={form.print_colours_count}
              onChange={e=>setForm({...form,print_colours_count:e.target.value})} />
            <Input label="Print Speed" type="number" value={form.print_speed}
              onChange={e=>setForm({...form,print_speed:e.target.value})} />
            <Input label="Print Tension" type="number" value={form.print_tension}
              onChange={e=>setForm({...form,print_tension:e.target.value})} />
          </div>}
        </section>}
        {isConversion && !isSharedMode ? (
          <div className="border-t pt-4">
            <p className="text-sm font-medium text-slate-700 mb-3">Semi-Finished Input for Primary Output</p>
            {allocatedRollMode && <Input label="Measured input consumed by primary finished product (kg)"
              type="number" min="0.01" step="0.01" required
              value={form.input_quantity_consumed}
              onChange={e=>setForm({...form,input_quantity_consumed:e.target.value})} />}
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Semi-Finished Roll (input)"
                value={form.input_product_id}
                onChange={(e) => {setForm({ ...form, input_product_id: e.target.value, input_quantity_consumed: '' });setSelectedInputRollIds([]);setPrimaryRollWeights({})}}
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

            {micronMismatch(form.input_product_id, form.finished_good_id, form.film_thickness) &&
              <p role="alert" className="text-xs text-red-700 mt-2">Primary input micron differs from the finished output.</p>}
            {selectedInputProduct?.unit==='rolls' && <div className="mt-3 rounded-lg border border-slate-200 p-3">
              <p className="font-medium text-sm">Select physical input rolls (500 most recent available)</p>
              {allocatedRollMode && <p className="text-xs text-amber-800 mt-1">
                The same physical roll can feed multiple finished products in this run. Enter the kilograms
                used for this output; remaining kilograms stay available for later production.
              </p>}
              {inputRollError && <p role="alert" className="text-red-700 text-sm">{inputRollError}</p>}
              <p className="text-xs text-slate-500">{selectedInputRollIds.length} rolls selected · {inputRolls.filter(r=>selectedInputRollIds.includes(r.id)).reduce((a,r)=>a+r.weight_kg,0).toFixed(2)} kg</p>
              <div className="max-h-44 overflow-auto grid grid-cols-2 gap-2 mt-2">
                {inputRolls.map(roll=><div key={roll.id} className="space-y-1 rounded-md border p-2 text-xs">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={selectedInputRollIds.includes(roll.id)}
                      disabled={!selectedInputRollIds.includes(roll.id) && (
                        (!allocatedRollMode && selectedRollIdsAcrossOutputs.has(roll.id)) ||
                        rollMicronMismatch(roll.micron, form.input_product_id, form.finished_good_id, form.film_thickness))}
                      onChange={e=>{
                        setSelectedInputRollIds(old=>e.target.checked?[...old,roll.id]:old.filter(id=>id!==roll.id))
                        if(!e.target.checked) setPrimaryRollWeights(old=>Object.fromEntries(Object.entries(old).filter(([id])=>id!==roll.id)))
                      }}/>
                    #{roll.roll_no} · {roll.weight_kg} kg available · {roll.micron ?? '—'} µ
                  </label>
                  {allocatedRollMode && selectedInputRollIds.includes(roll.id) && <Input
                    label="Kg used for primary finished product" type="number" min="0.01" max={roll.weight_kg}
                    step="0.01" required value={primaryRollWeights[roll.id] || ''}
                    onChange={e=>setPrimaryRollWeights(old=>({...old,[roll.id]:e.target.value}))} />}
                </div>)}
              </div>
              {allocatedRollMode && portionError && <p role="alert" className="text-red-700 text-xs">{portionError}</p>}
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
        ) : isConversion ? null : (
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
