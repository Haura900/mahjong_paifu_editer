import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeTenhouLog, parseTenhouLog } from '../codec'
import { decodeMatch } from '../replay'

const sampleText = readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8')

describe('tenhou.net/6 sample codec and replay', () => {
  it('decodes every round and preserves the source structure', () => {
    const source = JSON.parse(sampleText)
    const parsed = parseTenhouLog(sampleText)
    const match = decodeMatch(parsed)

    expect(match.rounds).toHaveLength(source.log.length)
    expect(match.rounds.every((round) => round.events.length > 1)).toBe(true)
    expect(JSON.parse(encodeTenhouLog(parsed))).toEqual(source)
    expect(parseTenhouLog(encodeTenhouLog(parsed))).toEqual(parsed)
  })

  it('replays all streams without losing physical tiles', () => {
    const match = decodeMatch(sampleText)
    expect(match.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    for (const round of match.rounds) {
      const final = round.snapshots.at(-1)!
      const counts = new Map<number, number>()
      for (const tile of Object.values(final.tiles)) {
        counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1)
      }
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(4)
      expect(final.ended).toBe(true)
      expect(final.scores).toHaveLength(4)
    }
  })

  it('has actionable diagnostics with exact positions when input is invalid', () => {
    const raw = JSON.parse(sampleText)
    raw.log[0][4][2] = 99
    expect(() => parseTenhouLog(raw)).toThrow(/配牌\[2\]/)
  })
})
