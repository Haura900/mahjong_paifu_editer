import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAiEditPrompt, spareHonorTiles } from '../aiPrompt'
import { parseTenhouLog, refKey } from '../codec'
import { decodeMatch, snapshotAt } from '../replay'
import { executePaifuScript, parsePaifuScript } from '../script'
import { toMajiangTile } from '../tile'
import type { RoundState, Seat } from '../types'

const sample = parseTenhouLog(readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8'))
const lateReachSample = parseTenhouLog({
  title: ['', ''],
  name: ['はうらC', 'あっぴん1210', 'エンペラー7', 'カネマロ'],
  rule: { disp: '四南喰赤', aka: 1, aka51: 1, aka52: 1, aka53: 1 },
  log: [[
    [0, 0, 0], [25000, 25000, 25000, 25000], [11], [41],
    [34, 25, 33, 23, 44, 17, 24, 25, 35, 17, 21, 31, 36],
    [42, 44, 27, 42, 39, 31, 21, 39, 34, 42, 16, 19, 35, 33, 24],
    [60, 21, 44, 60, 60, 44, 60, 60, 31, 31, 42, 60, 'r16', 60, 60],
    [23, 52, 21, 46, 38, 22, 19, 41, 13, 36, 24, 47, 53],
    [33, 45, 15, 43, 26, 26, 16, 18, 46, 42, 46, 29, 15, 21, 41],
    [19, 47, 46, 60, 45, 41, 13, 60, 36, 60, 22, 15, 16, 33, 24],
    [19, 12, 39, 31, 36, 13, 14, 29, 28, 32, 32, 29, 18],
    [28, 19, 17, 22, 15, 12, 43, 27, 14, 45, 18, 41, 17, 37, 26],
    [39, 36, 19, 60, 60, 31, 60, 'r12', 60, 60, 60, 60, 60, 60, 60],
    [22, 22, 24, 51, 33, 37, 31, 37, 44, 47, 11, 36, 11],
    [14, 13, 26, 45, 45, 44, 38, 43, 34, 34, 16, 27, 25, 13],
    [47, 44, 37, 60, 60, 60, 22, 60, 31, 22, 11, 11, 16, 33],
    ['和了', [5900, 0, -3900, 0], [0, 2]],
  ]],
})

function handSignature(state: RoundState, seat: Seat): string[] {
  return state.hands[seat]!.map((id) => {
    const tile = state.tiles[id]!
    return `${refKey(tile.acquisitionRef)}=${tile.code}:${tile.red}`
  }).sort()
}

function scriptTile(code: number): string {
  const value = toMajiangTile(code)
  return `${value[1]}${value[0]}`
}

describe('paifu text script', () => {
  it('parses independent scenes and relative river edits', () => {
    const parsed = parsePaifuScript(`
# two alternatives
KEEP_ONLY
SCENE "10巡目案"
SET KAMI RIVER 7 1z
SET KAMI RIVER 10 4p
END
SCENE "14巡目案"
SET KAMI RIVER 7 2z
SET KAMI RIVER 14 4p
END
`)
    expect(parsed.actions).toHaveLength(0)
    expect(parsed.keepOnly).toBe(true)
    expect(parsed.scenes).toHaveLength(2)
    expect(parsed.scenes[0]?.actions).toHaveLength(2)
  })

  it('parses meld and reach operations', () => {
    const parsed = parsePaifuScript(`
MELD_ADD SHIMO PON 6z FROM SELF RIVER 7
MELD_ADD SHIMO CHI 2s 3s 4s FROM SELF RIVER 9
MELD_REMOVE SHIMO 1
REACH TOIMEN ON AT 8
REACH KAMI ON BEFORE SELF RIVER 10
REACH TOIMEN OFF
`)
    expect(parsed.actions.map((action) => action.kind)).toEqual([
      'meld-add', 'meld-add', 'meld-remove', 'reach', 'reach', 'reach',
    ])
  })

  it('creates each scene from the unedited current round', () => {
    const decoded = decodeMatch(sample)
    const source = decoded.rounds[0]!
    const final = source.snapshots.at(-1)!
    const kami = 3
    expect(final.rivers[kami]!.length).toBeGreaterThanOrEqual(14)

    const result = executePaifuScript(sample, `
KEEP_ONLY
SCENE "10巡目案"
SET KAMI RIVER 7 1z
SET KAMI RIVER 10 4p
END
SCENE "14巡目案"
SET KAMI RIVER 7 2z
SET KAMI RIVER 14 4p
END
`, { round: 0, event: source.events.length - 1, self: 0, seed: 20260726 })

    expect(result.sceneCount).toBe(2)
    expect(result.keepOnly).toBe(true)
    expect(result.output.log).toHaveLength(3)
    const scenes = decodeMatch(result.output).rounds
    expect(scenes[1]!.snapshots.at(-1)!.rivers[kami]![9]!.code).toBe(24)
    expect(scenes[2]!.snapshots.at(-1)!.rivers[kami]![13]!.code).toBe(24)
    expect(result.changes.length).toBeGreaterThan(0)
  }, 30_000)

  it('skips only failed scenes and continues creating later scenes', () => {
    const decoded = decodeMatch(sample)
    const source = decoded.rounds[0]!
    const original = source.snapshots.at(-1)!.rivers[3]![6]!.code
    const result = executePaifuScript(sample, `
KEEP_ONLY
SCENE "途中で適用失敗"
SET KAMI RIVER 7 1z
SET KAMI RIVER 999 4p
END
SCENE "構文失敗"
UNKNOWN KAMI RIVER 7 1z
END
SCENE "成功"
SET KAMI RIVER 10 4p
END
`, { round: 0, event: source.events.length - 1, self: 0, seed: 20260726 })

    expect(result.sceneCount).toBe(1)
    expect(result.sceneErrors).toHaveLength(2)
    expect(result.sceneErrors.map((error) => error.name)).toEqual(['途中で適用失敗', '構文失敗'])
    expect(result.output.log).toHaveLength(2)
    const rounds = decodeMatch(result.output).rounds
    expect(rounds[0]!.snapshots.at(-1)!.rivers[3]![6]!.code).toBe(original)
    expect(rounds[1]!.snapshots.at(-1)!.rivers[3]![9]!.code).toBe(24)
  }, 30_000)

  it('enables reach from text and forces the selected hand into tenpai', () => {
    const round = decodeMatch(sample).rounds[0]!
    const result = executePaifuScript(sample, 'KEEP_ONLY\nREACH SELF ON AT 1', {
      round: 0,
      event: round.events.length - 1,
      self: 0,
      seed: 20260808,
    })

    expect(result.output.log).toHaveLength(1)
    const after = decodeMatch(result.output).rounds[0]!
    expect(after.snapshots.at(-1)!.reach[0]).toBe(true)
    expect(result.changes.some((change) => change.reason.includes('聴牌形へ補正'))).toBe(true)
  }, 30_000)

  it('places reach on the last actor discard before the decision tile', () => {
    const round = decodeMatch(sample).rounds[0]!
    const result = executePaifuScript(sample, 'KEEP_ONLY\nREACH KAMI ON BEFORE SELF RIVER 10', {
      round: 0,
      event: round.events.length - 1,
      self: 0,
      seed: 20260808,
    })

    const final = decodeMatch(result.output).rounds[0]!.snapshots.at(-1)!
    const decision = final.rivers[0]![9]!
    const reachDiscard = final.rivers[3]!.find((discard) => discard.reach)
    expect(reachDiscard).toBeDefined()
    expect(reachDiscard!.eventIndex).toBeLessThan(decision.eventIndex)
    expect(final.rivers[3]!.filter((discard) => discard.eventIndex < decision.eventIndex).at(-1)?.reach).toBe(true)
  }, 30_000)

  it('adds and removes an opponents pon from text', () => {
    const round = decodeMatch(sample).rounds[0]!
    const final = round.snapshots.at(-1)!
    const source = final.rivers[0]!.find((river) => !river.called && river.code < 50)!
    const turn = final.rivers[0]!.indexOf(source) + 1
    const code = `${source.code % 10}${['', 'm', 'p', 's', 'z'][Math.floor(source.code / 10)]}`
    const added = executePaifuScript(sample, `MELD_ADD SHIMO PON ${code} FROM SELF RIVER ${turn}`, {
      round: 0,
      event: round.events.length - 1,
      self: 0,
      seed: 20260808,
    })
    const addedRound = decodeMatch(added.output).rounds[0]!
    const addedMelds = addedRound.snapshots.at(-1)!.melds[1]!
    expect(addedMelds.some((meld) => meld.type === 'pon')).toBe(true)

    const ponIndex = addedMelds.findIndex((meld) => meld.type === 'pon') + 1
    const removed = executePaifuScript(added.output, `MELD_REMOVE SHIMO ${ponIndex}`, {
      round: 0,
      event: addedRound.events.length - 1,
      self: 0,
      seed: 20260808,
    })
    expect(decodeMatch(removed.output).rounds[0]!.snapshots.at(-1)!.melds[1]!.length)
      .toBe(addedMelds.length - 1)
  }, 40_000)

  it('adds a chi from the actors upper player river', () => {
    const round = decodeMatch(sample).rounds[0]!
    const final = round.snapshots.at(-1)!
    const source = final.rivers[0]!.find((river) => !river.called && river.code < 40)!
    const turn = final.rivers[0]!.indexOf(source) + 1
    const suit = ['m', 'p', 's'][Math.floor(source.code / 10) - 1]!
    const rank = source.code % 10
    const start = Math.max(1, Math.min(7, rank - 1))
    const sequence = [start, start + 1, start + 2].map((value) => `${value}${suit}`).join(' ')
    const result = executePaifuScript(
      sample,
      `MELD_ADD SHIMO CHI ${sequence} FROM SELF RIVER ${turn}`,
      { round: 0, event: round.events.length - 1, self: 0, seed: 20260808 },
    )
    expect(decodeMatch(result.output).rounds[0]!.snapshots.at(-1)!.melds[1]!.some((meld) =>
      meld.type === 'chi')).toBe(true)
  }, 30_000)
})

describe('LOCK SELF HAND ALL', () => {
  it('parses only the formal syntax and rejects invalid targets or extra arguments', () => {
    expect(parsePaifuScript('LOCK SELF HAND ALL').actions[0]).toMatchObject({ kind: 'lock-self-hand-all' })
    for (const invalid of [
      'LOCK KAMI HAND ALL',
      'LOCK SELF RIVER ALL',
      'LOCK SELF HAND',
      'LOCK SELF HAND ALL EXTRA',
    ]) {
      expect(() => parsePaifuScript(invalid)).toThrow('LOCKの正式構文')
    }
  })

  it('parses a hand copy between discard turns', () => {
    expect(parsePaifuScript('COPY SELF HAND FROM 13 TO 9').actions[0]).toMatchObject({
      kind: 'copy-hand', actor: 'SELF', fromTurn: 13, toTurn: 9,
    })
    expect(() => parsePaifuScript('COPY SELF HAND 13 TO 9')).toThrow('COPYの正式構文')
    expect(() => parsePaifuScript('COPY SELF HAND FROM 9 TO 9')).toThrow('別にしてください')
  })

  it('copies the late reach hand to turn 9, breaks turn 8, locks it, and permits reach', () => {
    const before = decodeMatch(lateReachSample).rounds[0]!
    const sourceCodes = before.snapshots[before.snapshots.at(-1)!.rivers[0]![12]!.eventIndex]!
      .hands[0]!.map((id) => before.snapshots.at(-1)!.tiles[id]!.code)
      .sort((a, b) => a - b)
    const result = executePaifuScript(
      lateReachSample,
      'KEEP_ONLY\nCOPY SELF HAND FROM 13 TO 9\nREACH SELF ON AT 9',
      { round: 0, event: before.events.length - 1, self: 0, seed: 20260811 },
    )
    const after = decodeMatch(result.output).rounds[0]!
    const final = after.snapshots.at(-1)!
    const turn9 = after.snapshots[final.rivers[0]![8]!.eventIndex]!
    const turn8 = after.snapshots[final.rivers[0]![7]!.eventIndex]!
    const codes = (state: RoundState) => state.hands[0]!
      .map((id) => state.tiles[id]!.code)
      .sort((a, b) => a - b)

    expect(codes(turn9)).toEqual(sourceCodes)
    expect(codes(turn8)).not.toEqual(sourceCodes)
    expect(final.rivers[0]![8]!.reach).toBe(true)
    expect(final.rivers[0]![12]!.reach).toBe(false)
    expect(() => executePaifuScript(
      lateReachSample,
      'KEEP_ONLY\nCOPY SELF HAND FROM 13 TO 9\nSET SELF DRAW 9 1m',
      { round: 0, event: before.events.length - 1, self: 0, seed: 20260811 },
    )).toThrow('固定')
  }, 60_000)

  it('copies to a tsumogiri turn by converting it into an honor hand discard', () => {
    const before = decodeMatch(lateReachSample).rounds[0]!
    const finalBefore = before.snapshots.at(-1)!
    const sourceState = before.snapshots[finalBefore.rivers[2]![7]!.eventIndex]!
    const sourceCodes = sourceState.hands[2]!
      .map((id) => sourceState.tiles[id]!.code)
      .sort((a, b) => a - b)
    expect(finalBefore.rivers[2]![12]!.tsumogiri).toBe(true)

    const result = executePaifuScript(
      lateReachSample,
      'KEEP_ONLY\nCOPY SELF HAND FROM 8 TO 13\nREACH SELF ON AT 13',
      { round: 0, event: before.events.length - 1, self: 2, seed: 20260811 },
    )
    const after = decodeMatch(result.output).rounds[0]!
    const final = after.snapshots.at(-1)!
    const turn13 = after.snapshots[final.rivers[2]![12]!.eventIndex]!
    const turn12 = after.snapshots[final.rivers[2]![11]!.eventIndex]!
    const codes = (state: RoundState) => state.hands[2]!
      .map((id) => state.tiles[id]!.code)
      .sort((a, b) => a - b)

    expect(codes(turn13)).toEqual(sourceCodes)
    expect(codes(turn12)).not.toEqual(sourceCodes)
    expect(final.rivers[2]![12]!.tsumogiri).toBe(false)
    expect(final.rivers[2]![12]!.reach).toBe(true)
    expect(after.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(false)
  }, 60_000)

  it('atomically carries a copied reach hand to turn 14 before locking it', () => {
    const before = decodeMatch(lateReachSample).rounds[0]!
    const result = executePaifuScript(lateReachSample, `KEEP_ONLY
SCENE "対面リーチ直後_同一手牌"
COPY SELF HAND FROM 8 TO 14
REACH SELF ON AT 14
END`, { round: 0, event: before.events.length - 1, self: 2, seed: 20260811 })

    expect(result.sceneErrors).toEqual([])
    const scene = decodeMatch(result.output).rounds[1]!
    const final = scene.snapshots.at(-1)!
    expect(final.rivers[2]![7]!.reach).toBe(false)
    expect(final.rivers[2]![13]!.reach).toBe(true)
    expect(result.changes.some((change) =>
      change.reason.includes('同一聴牌手を固定したまま'))).toBe(true)
    expect(result.changes.some((change) =>
      change.reason === '門前・聴牌・持ち点を確認してリーチを設定')).toBe(false)
    expect(scene.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(false)
  }, 60_000)

  it('copies Haura C late hand from turn 14 to turn 8 in the documented direction', () => {
    const before = decodeMatch(lateReachSample).rounds[0]!
    const finalBefore = before.snapshots.at(-1)!
    const source = before.snapshots[finalBefore.rivers[0]![13]!.eventIndex]!
    const sourceCodes = source.hands[0]!
      .map((id) => source.tiles[id]!.code)
      .sort((a, b) => a - b)
    const result = executePaifuScript(lateReachSample, `KEEP_ONLY
SCENE "対面リーチ直後_同一手牌"
COPY SELF HAND FROM 14 TO 8
REACH SELF ON AT 8
END
SCENE "赤ドラ1枚_打点増"
SET SELF HAND 1 0m
END`, { round: 0, event: before.events.length - 1, self: 0, seed: 20260811 })

    expect(result.sceneErrors).toEqual([])
    const scene = decodeMatch(result.output).rounds[1]!
    const final = scene.snapshots.at(-1)!
    const turn8 = scene.snapshots[final.rivers[0]![7]!.eventIndex]!
    const turn8Codes = turn8.hands[0]!
      .map((id) => turn8.tiles[id]!.code)
      .sort((a, b) => a - b)
    expect(turn8Codes).toEqual(sourceCodes)
    expect(final.rivers[0]![7]!.reach).toBe(true)
    expect(final.rivers[0]![12]!.reach).toBe(false)
    expect(scene.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(false)

    const prompt = buildAiEditPrompt({
      instruction: '同じリーチ手を別巡目へ移す',
      state: finalBefore,
      self: 0,
      eventCount: before.events.length,
    })
    expect(prompt).toContain(`SELF / ${finalBefore.names[0]}: 13巡目`)
    expect(prompt).toContain('COPY SELF HAND FROM 14 TO 8')
    expect(prompt).toContain('FROM=残したいSELF牌姿の元巡目、TO=比較先のSELF巡目')

    const reversed = executePaifuScript(lateReachSample, `KEEP_ONLY
SCENE "逆方向"
COPY SELF HAND FROM 8 TO 14
REACH SELF ON AT 14
END`, { round: 0, event: before.events.length - 1, self: 0, seed: 20260811 })
    expect(reversed.sceneErrors[0]?.message).toContain('FROM 8は残したい聴牌形が存在する元巡目')
  }, 60_000)

  it('turns every later discard into tsumogiri when reach is moved earlier', () => {
    const round = decodeMatch(lateReachSample).rounds[0]!
    const result = executePaifuScript(lateReachSample, `KEEP_ONLY
SCENE "8巡目追いかけ_赤5m保持"
SET SELF DRAW 5 0m
SET SELF RIVER 5 1z
REACH TOIMEN OFF
REACH TOIMEN ON BEFORE SELF RIVER 8
REACH SELF OFF
REACH SELF ON AT 8
END`, { round: 0, event: round.events.length - 1, self: 2, seed: 20260811 })

    expect(result.sceneErrors).toEqual([])
    const scene = decodeMatch(result.output).rounds[1]!
    const final = scene.snapshots.at(-1)!
    for (const seat of [0, 2] as Seat[]) {
      const reach = final.rivers[seat]!.find((river) => river.reach)
      expect(reach).toBeDefined()
      expect(final.rivers[seat]!
        .filter((river) => river.eventIndex > reach!.eventIndex)
        .every((river) => river.tsumogiri)).toBe(true)
    }
    expect(scene.diagnostics.some((diagnostic) => diagnostic.code === 'REACH_HAND_CHANGE')).toBe(false)
  }, 60_000)

  it('diagnoses a raw hand discard after reach as a rule violation', () => {
    const invalid = structuredClone(lateReachSample)
    invalid.log[0]![6][7] = 'r60'
    invalid.log[0]![6][12] = 16
    expect(decodeMatch(invalid).rounds[0]!.diagnostics.some((diagnostic) =>
      diagnostic.code === 'REACH_HAND_CHANGE' && diagnostic.seat === 0)).toBe(true)
  })

  it('is idempotent and includes every occupied hand source plus the current draw', () => {
    const round = decodeMatch(sample).rounds[0]!
    const event = round.snapshots.findIndex((state) => state.lastDraw?.seat === 0)
    expect(event).toBeGreaterThanOrEqual(0)
    const state = snapshotAt(round, event)
    const once = executePaifuScript(sample, 'KEEP_ONLY\nLOCK SELF HAND ALL', {
      round: 0, event, self: 0,
    })
    const twice = executePaifuScript(sample, 'KEEP_ONLY\nLOCK SELF HAND ALL\nLOCK SELF HAND ALL', {
      round: 0, event, self: 0,
    })
    expect(twice.output).toEqual(once.output)
    expect(state.hands[0]).toContain(state.lastDraw!.tileId)
    expect(state.hands[0]).toHaveLength(14)
  })

  it('keeps a red five distinct and rejects SET or either side of SWAP', () => {
    const decoded = decodeMatch(sample)
    const found = decoded.rounds.flatMap((round, roundIndex) =>
      round.snapshots.map((state, event) => ({ state, round: roundIndex, event })))
      .find(({ state }) => state.hands[0]!.some((id) => state.tiles[id]!.red))
    expect(found).toBeDefined()
    const redBefore = handSignature(found!.state, 0)
    const redLocked = executePaifuScript(sample, 'KEEP_ONLY\nLOCK SELF HAND ALL', {
      round: found!.round, event: found!.event, self: 0,
    })
    expect(handSignature(snapshotAt(decodeMatch(redLocked.output).rounds[0]!, found!.event), 0)).toEqual(
      redBefore.map((entry) => entry.replace(/^\d+:/, '0:')),
    )

    const state = decoded.rounds[0]!.snapshots[0]!
    const current = state.tiles[state.hands[0]![0]!]!.code
    const replacement = current === 11 ? 12 : 11
    expect(() => executePaifuScript(sample, `KEEP_ONLY\nLOCK SELF HAND ALL\nSET SELF HAND 1 ${scriptTile(replacement)}`, {
      round: 0, event: 0, self: 0,
    })).toThrow('固定')
    expect(() => executePaifuScript(sample, 'KEEP_ONLY\nLOCK SELF HAND ALL\nSWAP KAMI HAND 1 WITH SELF HAND 1', {
      round: 0, event: 0, self: 0,
    })).toThrow('交換先は固定')
  })

  it('excludes SELF from automatic fifth-tile repair while allowing another tile to move', () => {
    const before = decodeMatch(sample).rounds[0]!.snapshots[0]!
    const original = handSignature(before, 0).map((entry) => entry.replace(/^\d+:/, '0:'))
    const result = executePaifuScript(sample, 'KEEP_ONLY\nLOCK SELF HAND ALL\nSET SHIMO HAND 1 5m', {
      round: 0, event: 0, self: 0, seed: 20260726,
    })
    expect(result.changes.some((change) => change.kind === 'automatic')).toBe(true)
    expect(handSignature(decodeMatch(result.output).rounds[0]!.snapshots[0]!, 0)).toEqual(original)
  }, 30_000)

  it('rolls back a conflicting scene, continues later scenes, and does not leak the lock', () => {
    const state = decodeMatch(sample).rounds[0]!.snapshots[0]!
    const current = state.tiles[state.hands[0]![0]!]!.code
    const replacement = current === 11 ? 12 : 11
    const result = executePaifuScript(sample, `KEEP_ONLY
SCENE "固定競合"
LOCK SELF HAND ALL
SET SELF HAND 1 ${scriptTile(replacement)}
END
SCENE "後続成功"
SET SELF HAND 1 ${scriptTile(replacement)}
END`, { round: 0, event: 0, self: 0, seed: 20260726 })
    expect(result.sceneErrors.map((error) => error.name)).toEqual(['固定競合'])
    expect(result.sceneCount).toBe(1)
    expect(result.output.log).toHaveLength(2)
    const changed = decodeMatch(result.output).rounds[1]!.snapshots[0]!
    expect(changed.tiles[changed.hands[0]![0]!]!.code).toBe(replacement)
  }, 30_000)

  it('keeps the exact SELF hand across early, middle, and late comparison scenes', () => {
    const original = handSignature(decodeMatch(sample).rounds[0]!.snapshots[0]!, 0)
      .map((entry) => entry.replace(/^\d+:/, 'SCENE:'))
    const result = executePaifuScript(sample, `KEEP_ONLY
SCENE "序盤"
LOCK SELF HAND ALL
END
SCENE "中盤"
LOCK SELF HAND ALL
END
SCENE "終盤"
LOCK SELF HAND ALL
END`, { round: 0, event: 0, self: 0 })
    expect(result.sceneCount).toBe(3)
    for (const round of decodeMatch(result.output).rounds.slice(1)) {
      expect(handSignature(round.snapshots[0]!, 0).map((entry) => entry.replace(/^\d+:/, 'SCENE:'))).toEqual(original)
    }
  })
})

describe('AI editing prompt', () => {
  it('includes the instruction, full table, script spec, and honor preference', () => {
    const round = decodeMatch(sample).rounds[0]!
    const state = round.snapshots.at(-1)!
    const instruction = '上家の7巡目の4pを10巡目へずらす'
    const prompt = buildAiEditPrompt({ instruction, state, self: 0, eventCount: round.events.length })

    expect(prompt).toContain(instruction)
    sample.name.forEach((name) => expect(prompt).toContain(name))
    expect(prompt).toContain('# 余っている字牌')
    expect(prompt).toContain('差替え用の牌が必要なら')
    expect(prompt).toContain('スクリプトの先頭行を必ず KEEP_ONLY')
    expect(prompt).toContain('KEEP_ONLY                         現在局以外を削除する')
    expect(prompt).toContain('聴牌確率 × その牌が当たり牌である確率 × 放銃時の打点')
    expect(prompt).toContain('単に相手手牌へ対象牌や隣接牌を入れただけでは')
    expect(prompt).toContain('SET <席> HAND は仕様として残しているが、AI生成では原則使用禁止')
    expect(prompt).toContain('危険度を変えるシーンではHANDを使わず')
    expect(prompt).toContain('REACHとMELD_ADDは必要な聴牌形・手牌を実行時に自動補正')
    expect(prompt).toContain('REACH <席> ON BEFORE SELF RIVER <対象巡目>')
    expect(prompt).toContain('SELFのリーチ・聴牌時期を早める／遅らせる比較')
    expect(prompt).toContain('COPYの方向は必ず FROM → TO')
    expect(prompt).toContain('必ず COPY SELF HAND FROM <残したい手牌の元巡目> TO <比較先巡目>')
    expect(prompt).toContain('REACH SELF ON ATだけの自動聴牌補正')
    expect(prompt).toContain('COPY SELF HAND を使う場合はCOPY自体が完成手牌を固定')
    expect(prompt).toContain('現在河の [リーチ] が付いたSELF打牌位置と、それ以降にツモ切りで維持された同一手牌はFROM候補')
    expect(prompt).toContain('SELF RIVER 10 9s(9索)')
    expect(prompt).toContain('REACH <相手席> ON BEFORE SELF RIVER 10')
    expect(prompt).toContain('下家のチー・ポン有無を優先的な比較軸')
    expect(prompt).toContain('MELD_ADD / MELD_REMOVE')
    expect(prompt).toContain('REACH <席> ON')
    expect(prompt).toContain('SET <席> RIVER <巡目> <牌>')
    expect(prompt).toContain('SCENE "名前" ～ END')
    expect(prompt).toContain('各SCENEの最初の命令を LOCK SELF HAND ALL')
    expect(prompt).toContain('現在判断から目標判断へ近づく方向だけ')
    expect(prompt).toContain('巡目は独立軸として序盤・中盤・終盤')
    expect(prompt).toContain('LOCK SELF HAND ALL              実行時点のSELF手牌')
    expect(prompt).toContain('- 手牌:')
    expect(prompt).toContain('- 河:')
    expect(prompt).toContain('- ドラ表示牌:')

    const spare = spareHonorTiles(state, 0)
    expect(spare.every(({ count }) => count >= 1 && count <= 4)).toBe(true)
  })
})
