import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cloneLog, getRoundSection, refKey, writeRawRef } from '../codec'
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

  it('creates a requested 4萬・5萬・6萬 chi by correcting the prior discard and recent hand tiles', () => {
    const result = solveEdit(sample, {
      type: 'meld-add',
      round: 4,
      event: 16,
      actor: 1,
      meldType: 'chi',
      forced: {
        codes: [14, 15, 16],
        calledIndex: 1,
        target: 0,
      },
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes.some((change) => change.kind === 'automatic' && change.reason.includes('副露元'))).toBe(true)
    expect(result.changes.some((change) => change.kind === 'automatic' && change.reason.includes('手牌を補正'))).toBe(true)
    const replayed = replayRound(result.output!, 4)
    expect(replayed.snapshots.at(-1)!.melds[1]!.some((meld) =>
      meld.type === 'chi'
      && [14, 15, 16].every((code, index) => sameTileKind(code, meld.codes[index]!)))).toBe(true)
    expectPlayable(result.output!)
  }, 20_000)

  it('creates the requested East 2 third-discard 2筒 pon without leaving a fifth honor tile', () => {
    const result = solveEdit(sample, {
      type: 'meld-add',
      round: 1,
      event: 6,
      actor: 1,
      meldType: 'pon',
      forced: {
        codes: [22, 22, 22],
        target: 3,
      },
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes.some((change) => change.reason.includes('玉突き'))).toBe(true)
    const final = replayRound(result.output!, 1).snapshots.at(-1)!
    expect(final.melds[1]!.some((meld) =>
      meld.type === 'pon'
      && meld.codes.every((code) => sameTileKind(code, 22)))).toBe(true)
    expectPlayable(result.output!)
  }, 30_000)

  it.each([
    ['ポン', { meldType: 'pon' as const, forced: { codes: [14, 14, 14] as TileCode[], target: 2 as const } }],
    ['大明槓', { meldType: 'daiminkan' as const, forced: { codes: [24, 24, 24, 24] as TileCode[], target: 3 as const } }],
    ['暗槓', { meldType: 'ankan' as const, forced: { codes: [34, 34, 34, 34] as TileCode[] } }],
    ['加槓', { meldType: 'kakan' as const, forced: { codes: [29, 29, 29, 29] as TileCode[] } }],
  ])('creates a requested %s by correcting the surrounding history', (_label, plan) => {
    const result = solveEdit(sample, {
      type: 'meld-add',
      round: 4,
      event: 16,
      actor: 1,
      ...plan,
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes.some((change) => change.kind === 'automatic')).toBe(true)
    expectPlayable(result.output!)
  }, 40_000)

  it('borrows other players physical 2萬 tiles when creating a forced concealed kan', () => {
    const result = solveEdit(sample, {
      type: 'meld-add',
      round: 0,
      event: 64,
      actor: 0,
      meldType: 'ankan',
      forced: { codes: [12, 12, 12, 12] },
    })
    expect(result.ok, result.conflict).toBe(true)
    const final = replayRound(result.output!, 0).snapshots.at(-1)!
    expect(final.melds[0]!.some((meld) =>
      meld.type === 'ankan'
      && meld.codes.length === 4
      && meld.codes.every((code) => sameTileKind(code, 12)))).toBe(true)
    expectPlayable(result.output!)
  }, 30_000)

  it('replaces an existing concealed kan as a whole when a river edit needs its tile kind', () => {
    const created = solveEdit(sample, {
      type: 'meld-add',
      round: 0,
      event: 64,
      actor: 0,
      meldType: 'ankan',
      forced: { codes: [11, 11, 11, 11] },
    })
    expect(created.ok, created.conflict).toBe(true)
    const beforeEdit = replayRound(created.output!, 0).snapshots.at(-1)!
    const river1s = beforeEdit.rivers.flat().find((river) =>
      sameTileKind(beforeEdit.tiles[river.tileId]!.code, 31))!
    const changed = solveEdit(created.output!, {
      type: 'tile',
      round: 0,
      event: beforeEdit.eventIndex,
      tileId: river1s.tileId,
      code: 11,
    })
    expect(changed.ok, changed.conflict).toBe(true)
    expect(changed.changes.some((change) => change.reason.includes('組単位'))).toBe(true)
    const afterEdit = replayRound(changed.output!, 0).snapshots.at(-1)!
    const ankan = afterEdit.melds[0]!.find((meld) => meld.type === 'ankan')!
    expect(ankan.codes).toHaveLength(4)
    expect(ankan.codes.every((code) => sameTileKind(code, ankan.codes[0]!))).toBe(true)
    expectPlayable(changed.output!)
  }, 40_000)

  it('uses another players winning hand before making a no-op swap inside the edited hand', () => {
    const arranged = cloneLog(sample)
    const source = decodeMatch(arranged).rounds[1]!
    const final = source.snapshots.at(-1)!
    const rewriteDealTile = (seat: 0 | 1 | 2 | 3, index: number, code: TileCode) => {
      const trace = Object.values(final.tiles).find((tile) =>
        tile.acquisitionRef.section === 'deal'
        && tile.acquisitionRef.seat === seat
        && tile.acquisitionRef.index === index)!
      const refs = new Map([trace.acquisitionRef, ...trace.references].map((ref) => [refKey(ref), ref]))
      refs.forEach((ref) => writeRawRef(arranged, ref, code))
    }
    rewriteDealTile(0, 10, 11)
    rewriteDealTile(2, 6, 12)
    rewriteDealTile(0, 1, 11)
    rewriteDealTile(3, 9, 14)
    expectPlayable(arranged)

    const arrangedStart = decodeMatch(arranged).rounds[1]!.snapshots[0]!
    const selected = arrangedStart.hands[0]!.find((id) => sameTileKind(arrangedStart.tiles[id]!.code, 13))!
    const result = solveEdit(arranged, {
      type: 'tile',
      round: 1,
      event: 0,
      tileId: selected,
      code: 11,
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes.some((change) =>
      change.kind === 'automatic'
      && change.ref.seat === 1
      && change.reason.includes('はうらC'))).toBe(true)
    const after = replayRound(result.output!, 1).snapshots[0]!
    expect(after.hands[0]!.filter((id) => sameTileKind(after.tiles[id]!.code, 11))).toHaveLength(4)
    expectPlayable(result.output!)
  }, 30_000)

  it('removes a later reach when changing the initial 3萬 to 6萬 breaks tenpai', () => {
    const decoded = decodeMatch(sample)
    const state = decoded.rounds[4]!.snapshots[0]!
    const tileId = state.hands[1]!.find((id) => state.tiles[id]!.code === 13)!
    const result = solveEdit(sample, {
      type: 'tile',
      round: 4,
      event: 0,
      tileId,
      code: 16,
    })
    expect(result.ok, result.conflict).toBe(true)
    expect(result.changes.some((change) =>
      change.kind === 'automatic'
      && change.reason.includes('リーチ成立時の門前・聴牌条件を失った'))).toBe(true)
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
