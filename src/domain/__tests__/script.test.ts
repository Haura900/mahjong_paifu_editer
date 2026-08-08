import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAiEditPrompt, spareHonorTiles } from '../aiPrompt'
import { parseTenhouLog } from '../codec'
import { decodeMatch } from '../replay'
import { executePaifuScript, parsePaifuScript } from '../script'

const sample = parseTenhouLog(readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8'))

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
    expect(prompt).toContain('SELF RIVER 10 9s(9索)')
    expect(prompt).toContain('REACH <相手席> ON BEFORE SELF RIVER 10')
    expect(prompt).toContain('下家のチー・ポン有無を優先的な比較軸')
    expect(prompt).toContain('MELD_ADD / MELD_REMOVE')
    expect(prompt).toContain('REACH <席> ON')
    expect(prompt).toContain('SET <席> RIVER <巡目> <牌>')
    expect(prompt).toContain('SCENE "名前" ～ END')
    expect(prompt).toContain('- 手牌:')
    expect(prompt).toContain('- 河:')
    expect(prompt).toContain('- ドラ表示牌:')

    const spare = spareHonorTiles(state, 0)
    expect(spare.every(({ count }) => count >= 1 && count <= 4)).toBe(true)
  })
})
