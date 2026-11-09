import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useToastStore } from '@/stores/toastStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface Props { productId: string; name: string; missing: number; onClose: () => void; onSuccess: () => void }

export function RollReconcileModal({ productId, name, missing, onClose, onSuccess }: Props) {
  const [weights,setWeights]=useState('')
  const [micron,setMicron]=useState('')
  const [submitting,setSubmitting]=useState(false)
  const toast=useToastStore(s=>s.addToast)
  const parsed=weights.split(/[\s,;]+/).filter(Boolean).map(Number)
  const valid=Number.isInteger(missing) && missing>0 && parsed.length===missing &&
    parsed.every(weight=>Number.isFinite(weight)&&weight>0&&weight<=500)
  const submit=async(e:React.FormEvent)=>{
    e.preventDefault()
    if(!valid){toast(`Enter exactly ${missing} measured, positive weights (maximum 500 kg each)`,'error');return}
    if(!window.confirm(`Confirm that ${parsed.length} physical rolls were individually weighed and counted? Aggregate stock will NOT be increased.`))return
    setSubmitting(true)
    const {error}=await supabase.rpc('register_legacy_rolls',{
      p_finished_good:productId,p_weights:parsed,p_micron:micron?Number(micron):null,
    })
    setSubmitting(false)
    if(error)toast(error.message,'error');else onSuccess()
  }
  return <Modal open onClose={onClose} title={`Reconcile physical rolls — ${name}`} size="lg">
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-slate-600">The aggregate stock contains <strong>{missing} rolls without a matching individual roll record</strong>. Physically count and weigh each missing roll. Do not make up weights; these records will become selectable in customer and sales orders.</p>
      <label className="block text-sm font-medium text-slate-700" htmlFor="roll-weights">Each measured roll weight (kg), separated by commas</label>
      <textarea id="roll-weights" value={weights} onChange={e=>setWeights(e.target.value)} rows={4}
        placeholder="12.35, 13.25, 10.50" className="w-full rounded-lg border border-slate-300 p-3 text-sm" required/>
      <Input label="Film micron (optional)" type="number" min="0.01" step="0.01" value={micron} onChange={e=>setMicron(e.target.value)}/>
      <p className="text-xs text-slate-500">Measured: {parsed.length} of {missing} rolls. Total weight: {parsed.reduce((s,n)=>s+(Number.isFinite(n)?n:0),0).toFixed(2)} kg.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
      <Button type="submit" loading={submitting} disabled={!valid}>Confirm physical reconciliation</Button></div>
    </form>
  </Modal>
}
