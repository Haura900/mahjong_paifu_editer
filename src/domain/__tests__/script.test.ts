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
    expect(parsed.scenes).toHaveLength(2)
    expect(parsed.scenes[0]?.actions).toHaveLength(2)
  })

  it('creates each scene from the unedited current round', () => {
    const decoded = decodeMatch(sample)
    const source = decoded.rounds[0]!
    const final = source.snapshots.at(-1)!
    const kami = 3
    expect(final.rivers[kami]!.length).toBeGreaterThanOrEqual(14)

    const result = executePaifuScript(sample, `
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
    expect(result.output.log).toHaveLength(sample.log.length + 2)
    const scenes = decodeMatch(result.output).rounds
    expect(scenes[1]!.snapshots.at(-1)!.rivers[kami]![9]!.code).toBe(24)
    expect(scenes[2]!.snapshots.at(-1)!.rivers[kami]![13]!.code).toBe(24)
    expect(result.changes.length).toBeGreaterThan(0)
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
    expect(prompt).toContain('SET <席> RIVER <巡目> <牌>')
    expect(prompt).toContain('SCENE "名前" ～ END')
    expect(prompt).toContain('- 手牌:')
    expect(prompt).toContain('- 河:')
    expect(prompt).toContain('- ドラ表示牌:')

    const spare = spareHonorTiles(state, 0)
    expect(spare.every(({ count }) => count >= 1 && count <= 4)).toBe(true)
  })
})
