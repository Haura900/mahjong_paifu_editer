import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cloneLog, getRoundSection, refKey } from '../codec'
import { winningTiles } from '../hand'
import {
  applyProjectEdit,
  createProject,
  parseProject,
  redoProject,
  serializeProject,
  undoProject,
} from '../project'
import { decodeMatch, replayRound } from '../replay'
import { solveEdit } from '../solver'
import { ALL_TILE_CODES, normalizeTile, sameTileKind } from '../tile'
import type { EditRequest, TenhouLog, TileCode, TileTrace } from '../types'

const sample = JSON.parse(readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8')) as TenhouLog

function expectPlayable(log: TenhouLog) {
  const decoded = decodeMatch(log)
  expect(decoded.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
  expect(decoded.rounds.every((round) => round.snapshots.at(-1)?.ended)).toBe(true)
}

describe('deterministic automatic correction solver', () => {
  it('swaps an existing physical tile instead of creating a fifth copy', () => {
    const decoded = decodeMatch(sample)
    const round = decoded.rounds.findIndex((item) => {
      const final = item.snapshots.at(-1)!
      const counts = new Map<number, number>()
      Object.values(final.tiles).forEach((tile) => counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1))
      return Object.values(final.tiles).some((tile) => tile.location === 'dora' && [...counts].some(([kind, count]) => count === 4 && kind !== tile.kind))
    })
    expect(round).toBeGreaterThanOrEqual(0)
    const sourceRound = decoded.rounds[round]!
    const state = sourceRound.snapshots.at(-1)!
    const counts = new Map<number, number>()
    Object.values(state.tiles).forEach((tile) => counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1))
    const target = Object.values(state.tiles).find((tile) => tile.location === 'dora' && [...counts].some(([kind, count]) => count === 4 && kind !== tile.kind))!
    const requestedKind = [...counts].find(([kind, count]) => count === 4 && kind !== target.kind)![0]
    const requestedCode = ALL_TILE_CODES.find((code) => normalizeTile(code) === requestedKind && code < 50)!

    const result = solveEdit(sample, {
      type: 'tile',
      round,
      event: sourceRound.events.length - 1,
      tileId: target.id,
      code: requestedCode,
    })

    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes.some((change) => change.kind === 'automatic' && change.reason.includes('5枚'))).toBe(true)
    expectPlayable(result.output!)
    const final = replayRound(result.output!, round).snapshots.at(-1)!
    const kindCount = Object.values(final.tiles).filter((tile) => sameTileKind(tile.code, requestedCode)).length
    expect(kindCount).toBe(4)
  })

  it('traces a displayed hand tile back to its deal or draw and follows later references', () => {
    const decoded = decodeMatch(sample)
    let picked: { round: number; event: number; tile: TileTrace; code: TileCode } | undefined
    for (let round = 0; round < decoded.rounds.length && !picked; round += 1) {
      const sourceRound = decoded.rounds[round]!
      for (let event = 8; event < Math.min(45, sourceRound.snapshots.length); event += 5) {
        const state = sourceRound.snapshots[event]!
        const tile = state.hands[0]![0] ? state.tiles[state.hands[0]![0]!] : undefined
        if (!tile) continue
        const counts = new Map<number, number>()
        Object.values(sourceRound.snapshots.at(-1)!.tiles).forEach((trace) => counts.set(trace.kind, (counts.get(trace.kind) ?? 0) + 1))
        const code = ALL_TILE_CODES.find((candidate) =>
          candidate < 50
          && !sameTileKind(candidate, tile.code)
          && (counts.get(normalizeTile(candidate)) ?? 0) < 4)
        if (code) picked = { round, event, tile, code }
      }
    }
    expect(picked).toBeDefined()
    const result = solveEdit(sample, {
      type: 'tile',
      round: picked!.round,
      event: picked!.event,
      tileId: picked!.tile.id,
      code: picked!.code,
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes[0]?.reason).toMatch(/配牌|取得ツモ/)
    const acquisitionKey = refKey(picked!.tile.acquisitionRef)
    expect(result.changes.some((change) => refKey(change.ref) === acquisitionKey)).toBe(true)
    expectPlayable(result.output!)
  })

  it('removes a real meld and rebuilds the event stream without leaving a partial edit', () => {
    const decoded = decodeMatch(sample)
    const sourceRound = decoded.rounds.find((item) => item.events.some((event) => event.meld))
    const meldEvent = sourceRound!.events.find((event) => event.meld)!
    const request: EditRequest = {
      type: 'meld-remove',
      round: sourceRound!.raw === decoded.raw.log[0] ? 0 : decoded.rounds.indexOf(sourceRound!),
      event: meldEvent.index,
      actor: meldEvent.actor!,
      meldId: meldEvent.meld!.id,
    }
    const result = solveEdit(sample, request)
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes[0]?.reason).toContain('通常手番へ復元')
    expectPlayable(result.output!)
  })

  it('adds a chi or pon from an actual uncalled river/hand combination', () => {
    const decoded = decodeMatch(sample)
    const round = decoded.rounds.findIndex((item) => item.events.some((event) => event.meld && ['chi', 'pon'].includes(event.meld.type)))
    const sourceEvent = decoded.rounds[round]!.events.find((event) => event.meld && ['chi', 'pon'].includes(event.meld.type))!
    const sourceMeld = sourceEvent.meld!
    const without = cloneLog(sample)
    getRoundSection(without.log[round]!, sourceMeld.rawRef.section, sourceMeld.rawRef.seat).splice(sourceMeld.rawRef.index, 1)
    const replayed = replayRound(without, round)
    const event = replayed.snapshots.findIndex((state) => {
      if (!state.lastDiscard || state.lastDiscard.seat !== sourceMeld.target) return false
      const code = state.tiles[state.lastDiscard.tileId]!.code
      return sameTileKind(code, sourceMeld.codes[sourceMeld.calledIndex ?? 0]!)
        && state.streamCursors.draws[sourceMeld.actor] === sourceMeld.rawRef.index
    })
    expect(event).toBeGreaterThan(0)
    const successful = solveEdit(without, {
      type: 'meld-add',
      round,
      event,
      actor: sourceMeld.actor,
      meldType: sourceMeld.type,
    })
    expect(successful?.ok, successful?.conflict).toBe(true)
    expect(successful!.changes.some((change) => change.kind === 'manual' && /チー|ポン/.test(change.reason))).toBe(true)
    expectPlayable(successful!.output!)
  }, 20_000)

  it('adds the requested 6索・8索 chi and removes the actor future reach declaration', () => {
    const result = solveEdit(sample, {
      type: 'meld-add',
      round: 4,
      event: 16,
      actor: 1,
      meldType: 'chi',
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes.some((change) => change.kind === 'manual' && change.reason.includes('チー'))).toBe(true)
    expect(result.changes.some((change) => change.kind === 'automatic' && change.reason.includes('リーチ宣言'))).toBe(true)
    expect(getRoundSection(result.output!.log[4]!, 'discard', 1).some((item) =>
      typeof item === 'string' && /^r/.test(item))).toBe(false)
    expectPlayable(result.output!)
  }, 20_000)

  it('repairs a river edit at the acquisition source instead of leaving an impossible discard', () => {
    const decoded = decodeMatch(sample)
    const sourceRound = decoded.rounds[1]!
    const state = sourceRound.snapshots.find((snapshot) => snapshot.rivers.some((river) => river.length >= 2))!
    const river = state.rivers.find((items) => items.length >= 2)![1]!
    const trace = state.tiles[river.tileId]!
    const final = sourceRound.snapshots.at(-1)!
    const counts = new Map<number, number>()
    Object.values(final.tiles).forEach((tile) => counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1))
    const code = ALL_TILE_CODES.find((candidate) =>
      candidate < 50
      && !sameTileKind(candidate, trace.code)
      && (counts.get(normalizeTile(candidate)) ?? 0) < 4)!
    const result = solveEdit(sample, {
      type: 'tile',
      round: 1,
      event: state.eventIndex,
      tileId: trace.id,
      code,
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes[0]?.reason).toContain('河')
    expect(result.changes.some((change) => refKey(change.ref) === refKey(trace.acquisitionRef))).toBe(true)
    expectPlayable(result.output!)
  })

  it('recreates a kakan with rinshan flow and a matching kan-dora indicator', () => {
    const decoded = decodeMatch(sample)
    const round = decoded.rounds.findIndex((item) => item.events.some((event) => event.type === 'kakan'))
    expect(round).toBeGreaterThanOrEqual(0)
    const kanEvent = decoded.rounds[round]!.events.find((event) => event.type === 'kakan')!
    const before = cloneLog(sample)
    const ref = kanEvent.rawRef!
    getRoundSection(before.log[round]!, ref.section, ref.seat).splice(ref.index, 1)
    const without = replayRound(before, round)
    const targetEvent = without.snapshots.findIndex((state) =>
      state.melds[kanEvent.actor!]!.some((meld) =>
        meld.type === 'pon'
        && state.hands[kanEvent.actor!]!.some((id) => sameTileKind(state.tiles[id]!.code, meld.codes[0]!))))
    expect(targetEvent).toBeGreaterThan(0)
    const result = solveEdit(before, {
      type: 'meld-add',
      round,
      event: targetEvent,
      actor: kanEvent.actor!,
      meldType: 'kakan',
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes.some((change) => change.reason.includes('加槓'))).toBe(true)
    expectPlayable(result.output!)
  })

  it('turns a broken ron into a deterministic exhaustive draw and propagates its ledger', () => {
    const decoded = decodeMatch(sample)
    const round = decoded.rounds.findIndex((item) => item.events.some((event) => event.type === 'ron'))
    const sourceRound = decoded.rounds[round]!
    const winEvent = sourceRound.events.find((event) => event.type === 'ron')!
    const state = sourceRound.snapshots[winEvent.index]!
    const winner = winEvent.actor!
    const handCodes = state.hands[winner]!.map((id) => state.tiles[id]!.code)
    const waits = winningTiles(handCodes, state.melds[winner]!.length)
    const finalCounts = new Map<number, number>()
    Object.values(sourceRound.snapshots.at(-1)!.tiles).forEach((tile) => finalCounts.set(tile.kind, (finalCounts.get(tile.kind) ?? 0) + 1))
    const code = ALL_TILE_CODES.find((candidate) =>
      candidate < 50
      && !waits.some((wait) => sameTileKind(wait, candidate))
      && (finalCounts.get(normalizeTile(candidate)) ?? 0) < 4)!
    const result = solveEdit(sample, {
      type: 'tile',
      round,
      event: winEvent.index,
      tileId: winEvent.tileId!,
      code,
    }, { seed: 424242 })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.output!.log[round]![16][0]).toBe('流局')
    expect(result.changes.some((change) => change.reason.includes('牌山を補完'))).toBe(true)
    expectPlayable(result.output!)
  }, 20_000)

  it('propagates score changes and stops at a fixed start-score boundary', () => {
    const project = createProject(sample)
    const first = applyProjectEdit(project, { type: 'score', round: 0, seat: 0, score: 26000 })
    expect(first.result.ok, first.result.conflict).toBe(true)
    expect(first.project.lockedRefs).toContain('score:0:0')
    const second = applyProjectEdit(first.project, { type: 'score', round: 1, seat: 0, score: 30000 })
    expect(second.result.ok, second.result.conflict).toBe(true)
    expect(second.project.lockedRefs).toContain('score:1:0')
    expect(second.project.current.log[1]![1][0]).toBe(30000)
  })

  it('undoes and redoes a manual edit plus every automatic change atomically', () => {
    const decoded = decodeMatch(sample)
    const state = decoded.rounds[0]!.snapshots[10]!
    const tile = state.tiles[state.hands[0]![0]!]!
    const code = ALL_TILE_CODES.find((candidate) => candidate < 50 && !sameTileKind(candidate, tile.code))!
    const project = createProject(sample, 314159)
    const applied = applyProjectEdit(project, { type: 'tile', round: 0, event: 10, tileId: tile.id, code })
    expect(applied.result.ok, applied.result.conflict).toBe(true)
    const undone = undoProject(applied.project)
    expect(undone.current).toEqual(project.current)
    const redone = redoProject(undone)
    expect(redone.current).toEqual(applied.project.current)
    expect(redone.transactions.at(-1)?.changes).toEqual(applied.project.transactions.at(-1)?.changes)
  })

  it('round-trips the resumable project including history, locks and seed', () => {
    const original = createProject(sample, 8675309)
    const loaded = parseProject(serializeProject(original))
    expect(loaded).toEqual(original)
    expectPlayable(loaded.current)
  })
})
