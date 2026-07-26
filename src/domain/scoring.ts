import type { Seat } from './types'

export interface LedgerEntry {
  type: 'reach' | 'win' | 'draw-penalty' | 'honba' | 'deposit'
  label: string
  delta: [number, number, number, number]
}

export function applyLedger(
  scores: number[],
  entries: LedgerEntry[],
): [number, number, number, number] {
  const result = [scores[0]!, scores[1]!, scores[2]!, scores[3]!] as [number, number, number, number]
  for (const entry of entries) {
    entry.delta.forEach((value, seat) => { result[seat]! += value })
  }
  return result
}

export function deltaEntry(
  type: LedgerEntry['type'],
  label: string,
  values: number[],
): LedgerEntry {
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label}の点数移動は4人分の有限数である必要があります`)
  }
  return { type, label, delta: [values[0]!, values[1]!, values[2]!, values[3]!] }
}

export function exhaustiveDrawDelta(tenpai: Seat[]): [number, number, number, number] {
  const delta: [number, number, number, number] = [0, 0, 0, 0]
  if (tenpai.length === 0 || tenpai.length === 4) return delta
  const gain = 3000 / tenpai.length
  const loss = 3000 / (4 - tenpai.length)
  for (let seat = 0; seat < 4; seat += 1) {
    delta[seat] = tenpai.includes(seat as Seat) ? gain : -loss
  }
  return delta
}
