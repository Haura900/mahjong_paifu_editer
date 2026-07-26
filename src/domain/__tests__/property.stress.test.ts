import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMatch } from '../replay'
import { solveEdit } from '../solver'
import { ALL_TILE_CODES, sameTileKind } from '../tile'
import type { TenhouLog } from '../types'

const sample = JSON.parse(readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8')) as TenhouLog

describe('long deterministic solver stress', () => {
  it('repeats edits without nondeterminism or physical-tile growth', () => {
    const decoded = decodeMatch(sample)
    for (let index = 0; index < 40; index += 1) {
      const round = index % decoded.rounds.length
      const sourceRound = decoded.rounds[round]!
      const event = 1 + (index * 17) % (sourceRound.snapshots.length - 1)
      const state = sourceRound.snapshots[event]!
      const tileId = state.hands[index % 4]![0] ?? state.dora[0]
      if (!tileId) continue
      const tile = state.tiles[tileId]!
      const code = ALL_TILE_CODES.find((candidate) => candidate < 50 && !sameTileKind(candidate, tile.code))!
      const first = solveEdit(sample, { type: 'tile', round, event, tileId, code }, { seed: 99173 + index })
      const second = solveEdit(sample, { type: 'tile', round, event, tileId, code }, { seed: 99173 + index })
      expect(second.output).toEqual(first.output)
    }
  }, 180_000)
})
