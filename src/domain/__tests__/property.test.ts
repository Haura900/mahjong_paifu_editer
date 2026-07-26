import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refKey } from '../codec'
import { applyProjectEdit, createProject, undoProject } from '../project'
import { decodeMatch } from '../replay'
import { solveEdit } from '../solver'
import { ALL_TILE_CODES, normalizeTile, sameTileKind } from '../tile'
import type { EditRequest, TenhouLog } from '../types'

const sample = JSON.parse(readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8')) as TenhouLog

function randomGenerator(seed: number) {
  let value = seed >>> 0
  return () => {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    return (value >>> 0) / 0x1_0000_0000
  }
}

function generatedRequests(log: TenhouLog, seed: number, count: number): EditRequest[] {
  const random = randomGenerator(seed)
  const decoded = decodeMatch(log)
  const result: EditRequest[] = []
  while (result.length < count) {
    const round = Math.floor(random() * decoded.rounds.length)
    const sourceRound = decoded.rounds[round]!
    const event = Math.max(1, Math.floor(random() * (sourceRound.snapshots.length - 1)))
    const state = sourceRound.snapshots[event]!
    const visible = [...state.hands.flat(), ...state.dora]
    if (!visible.length) continue
    const tileId = visible[Math.floor(random() * visible.length)]!
    const tile = state.tiles[tileId]!
    const final = sourceRound.snapshots.at(-1)!
    const counts = new Map<number, number>()
    Object.values(final.tiles).forEach((trace) => counts.set(trace.kind, (counts.get(trace.kind) ?? 0) + 1))
    const candidates = ALL_TILE_CODES.filter((code) =>
      code < 50
      && !sameTileKind(code, tile.code)
      && (counts.get(normalizeTile(code)) ?? 0) < 4)
    if (!candidates.length) continue
    result.push({
      type: 'tile',
      round,
      event,
      tileId,
      code: candidates[Math.floor(random() * candidates.length)]!,
    })
  }
  return result
}

describe('seeded property checks', () => {
  it('keeps successful edits legal, deterministic and undoable', () => {
    const requests = generatedRequests(sample, 0x5eedc0de, 6)
    let successful = 0
    for (const request of requests) {
      const result = solveEdit(sample, request, { seed: 73013 })
      if (!result.ok || !result.output) continue
      successful += 1
      const decoded = decodeMatch(result.output)
      expect(decoded.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
      for (const round of decoded.rounds) {
        const final = round.snapshots.at(-1)!
        const counts = new Map<number, number>()
        Object.values(final.tiles).forEach((tile) => counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1))
        expect(Math.max(...counts.values())).toBeLessThanOrEqual(4)
      }
      const project = createProject(sample, 73013)
      const applied = applyProjectEdit(project, request)
      expect(applied.result.ok).toBe(true)
      expect(undoProject(applied.project).current).toEqual(project.current)
    }
    expect(successful).toBeGreaterThanOrEqual(4)

    const deterministicRequest = requests[0]!
    const first = solveEdit(sample, deterministicRequest, { seed: 123456 })
    const second = solveEdit(sample, deterministicRequest, { seed: 123456 })
    expect(second.output).toEqual(first.output)
    expect(second.changes).toEqual(first.changes)
  }, 30_000)

  it('does not leave partial changes when a fixed origin makes the request impossible', () => {
    const decoded = decodeMatch(sample)
    const state = decoded.rounds[0]!.snapshots[10]!
    const tile = state.tiles[state.hands[0]![0]!]!
    const request: EditRequest = {
      type: 'tile',
      round: 0,
      event: 10,
      tileId: tile.id,
      code: ALL_TILE_CODES.find((code) => !sameTileKind(code, tile.code))!,
    }
    const before = structuredClone(sample)
    const result = solveEdit(sample, request, { lockedRefs: [refKey(tile.acquisitionRef)] })
    expect(result.ok).toBe(false)
    expect(result.output).toBeUndefined()
    expect(sample).toEqual(before)
  })
})
