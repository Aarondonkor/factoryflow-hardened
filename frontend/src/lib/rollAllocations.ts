/** Input portions are measured in kg. A physical roll may feed multiple outputs. */
export interface RollPortion { roll_id: string; weight_kg: number }

export function checkRollPortions(
  availableKgByRoll: Record<string, number>,
  portions: RollPortion[],
): string | null {
  const used = new Map<string, number>()
  for (const part of portions) {
    if (!part.roll_id || !Number.isFinite(part.weight_kg) || part.weight_kg <= 0 ||
      Math.abs(Math.round(part.weight_kg * 100) - part.weight_kg * 100) > 1e-7) {
      return 'Enter a positive consumed weight in kg, with at most two decimal places, for each selected roll'
    }
    const available = availableKgByRoll[part.roll_id]
    if (!Number.isFinite(available)) return 'Selected roll is no longer available; refresh the input list'
    used.set(part.roll_id, Math.round(((used.get(part.roll_id) || 0) + part.weight_kg) * 100) / 100)
    if (used.get(part.roll_id)! > available + 0.00001) {
      return `Roll allocation exceeds its remaining ${available.toFixed(2)} kg`
    }
  }
  return null
}
