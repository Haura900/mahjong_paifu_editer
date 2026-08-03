import { parseTenhouLog } from './codec'
import type { RawRound, TenhouLog } from './types'

export interface ClipboardRound {
  round: RawRound
  sourceNames?: string[]
  sourceRoundNumber: number
}

export function singleRoundLog(log: TenhouLog, round: number): TenhouLog {
  const selected = log.log[round]
  if (!selected) throw new Error('指定された局がありません')
  return {
    ...structuredClone(log),
    log: [structuredClone(selected)],
  }
}

export function keepOnlyRound(log: TenhouLog, round: number): TenhouLog {
  return singleRoundLog(log, round)
}

export function replaceRound(log: TenhouLog, round: number, source: RawRound): TenhouLog {
  if (!log.log[round]) throw new Error('貼り付け先の局がありません')
  const output = structuredClone(log)
  output.log[round] = structuredClone(source)
  return parseTenhouLog(output)
}

export function parseClipboardRound(input: string, target: TenhouLog): ClipboardRound {
  let value: unknown
  try {
    value = JSON.parse(input) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`局面JSONを解析できません: ${detail}`)
  }

  if (Array.isArray(value)) {
    const parsed = parseTenhouLog({
      ...structuredClone(target),
      log: [value],
    })
    return {
      round: parsed.log[0]!,
      sourceRoundNumber: parsed.log[0]![0][0],
    }
  }

  const parsed = parseTenhouLog(value)
  if (parsed.log.length !== 1) {
    throw new Error('貼り付けるJSONには局面を1局だけ含めてください')
  }
  if (parsed.name.some((name, seat) => name !== target.name[seat])) {
    throw new Error('コピー元と貼り付け先でプレイヤーの並びが異なります')
  }
  return {
    round: parsed.log[0]!,
    sourceNames: [...parsed.name],
    sourceRoundNumber: parsed.log[0]![0][0],
  }
}
