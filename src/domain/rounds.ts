import { parseTenhouLog } from './codec'
import type { RawRound, TenhouLog } from './types'

export function keepOnlyRound(log: TenhouLog, round: number): TenhouLog {
  const selected = log.log[round]
  if (!selected) throw new Error('指定された局がありません')
  return {
    ...structuredClone(log),
    log: [structuredClone(selected)],
  }
}

export function insertRound(log: TenhouLog, round: number, source: RawRound): TenhouLog {
  const insertAt = Math.max(0, Math.min(round, log.log.length))
  const output = structuredClone(log)
  output.log.splice(insertAt, 0, structuredClone(source))
  return parseTenhouLog(output)
}

export function shiftLockedRefsForInsert(lockedRefs: string[], insertAt: number): string[] {
  return lockedRefs.map((key) => {
    const score = key.match(/^score:(\d+):(\d+)$/)
    if (score) {
      const round = Number(score[1])
      return round >= insertAt ? `score:${round + 1}:${score[2]}` : key
    }
    const raw = key.match(/^(\d+):(deal|draw|discard|dora|ura):(.*)$/)
    if (!raw) return key
    const round = Number(raw[1])
    return round >= insertAt ? `${round + 1}:${raw[2]}:${raw[3]}` : key
  }).sort()
}

export function lockedRefsForSingleRound(lockedRefs: string[], keptRound: number): string[] {
  const kept: string[] = []
  for (const key of lockedRefs) {
    const score = key.match(/^score:(\d+):(\d+)$/)
    if (score) {
      if (Number(score[1]) === keptRound) kept.push(`score:0:${score[2]}`)
      continue
    }
    const raw = key.match(/^(\d+):(deal|draw|discard|dora|ura):(.*)$/)
    if (raw) {
      if (Number(raw[1]) === keptRound) kept.push(`0:${raw[2]}:${raw[3]}`)
      continue
    }
    kept.push(key)
  }
  return [...new Set(kept)].sort()
}
