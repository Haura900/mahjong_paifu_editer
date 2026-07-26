import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { meldTarget, parseMeldString } from '../codec'
import { isTenpai, isWinningHand, winningTiles } from '../hand'
import { exhaustiveDrawDelta } from '../scoring'
import { ALL_TILE_CODES, normalizeTile, tileImageFilename } from '../tile'

describe('tile notation and rules', () => {
  it('counts red fives inside the same four physical copies', () => {
    expect(normalizeTile(51)).toBe(15)
    expect(normalizeTile(52)).toBe(25)
    expect(normalizeTile(53)).toBe(35)
  })

  it('maps normal, honor and red-five codes to bundled artwork', () => {
    expect(tileImageFilename(11)).toBe('Man1.png')
    expect(tileImageFilename(29)).toBe('Pin9.png')
    expect(tileImageFilename(46)).toBe('Hatsu.png')
    expect(tileImageFilename(53)).toBe('Sou5-Dora.png')
    for (const code of ALL_TILE_CODES) {
      expect(existsSync(resolve(process.cwd(), 'public', 'tiles', tileImageFilename(code)))).toBe(true)
    }
  })

  it('parses the marker position and relative source of calls', () => {
    const chi = parseMeldString('c343536')!
    expect(chi.type).toBe('chi')
    expect(chi.calledIndex).toBe(0)
    expect(meldTarget(1, chi)).toBe(0)

    const ponRight = parseMeldString('4141p41')!
    expect(ponRight.type).toBe('pon')
    expect(ponRight.calledIndex).toBe(2)
    expect(meldTarget(0, ponRight)).toBe(1)

    expect(parseMeldString('k38383838')?.type).toBe('kakan')
  })

  it('recognizes standard, seven-pairs and thirteen-orphans waits', () => {
    expect(isWinningHand([11, 12, 13, 21, 22, 23, 31, 32, 33, 41, 41, 41, 47, 47])).toBe(true)
    expect(isWinningHand([11, 11, 19, 19, 21, 21, 29, 29, 31, 31, 39, 39, 41, 41])).toBe(true)
    expect(isWinningHand([11, 19, 21, 29, 31, 39, 41, 42, 43, 44, 45, 46, 47, 47])).toBe(true)
    const ready = [11, 12, 13, 21, 22, 23, 31, 32, 33, 41, 41, 41, 47]
    expect(isTenpai(ready)).toBe(true)
    expect(winningTiles(ready)).toContain(47)
  })

  it('balances exhaustive-draw penalties', () => {
    expect(exhaustiveDrawDelta([])).toEqual([0, 0, 0, 0])
    expect(exhaustiveDrawDelta([0])).toEqual([3000, -1000, -1000, -1000])
    expect(exhaustiveDrawDelta([0, 2])).toEqual([1500, -1500, 1500, -1500])
    expect(exhaustiveDrawDelta([0, 1, 3])).toEqual([1000, 1000, -3000, 1000])
  })
})
