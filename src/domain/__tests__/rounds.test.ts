import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMatch } from '../replay'
import {
  insertRound,
  keepOnlyRound,
  lockedRefsForSingleRound,
  shiftLockedRefsForInsert,
} from '../rounds'
import type { TenhouLog } from '../types'

const sample = JSON.parse(readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8')) as TenhouLog

describe('round structure operations', () => {
  it('keeps one round without changing player order or its original round number', () => {
    const output = keepOnlyRound(sample, 3)
    expect(output.log).toHaveLength(1)
    expect(output.log[0]).toEqual(sample.log[3])
    expect(output.log[0]).not.toBe(sample.log[3])
    expect(output.name).toEqual(sample.name)
    expect(output.log[0]![0][0]).toBe(sample.log[3]![0][0])
    expect(() => decodeMatch(output)).not.toThrow()
  })

  it('copies one round and repeats it after the selected round', () => {
    const copied = structuredClone(sample.log[1]!)
    const output = insertRound(sample, 2, copied)
    expect(output.log).toHaveLength(sample.log.length + 1)
    expect(output.log[1]).toEqual(sample.log[1])
    expect(output.log[2]).toEqual(sample.log[1])
    expect(output.log[2]).not.toBe(copied)
  })

  it('remaps locks when rounds are inserted or all other rounds are removed', () => {
    const locks = ['0:deal:0:0:-', '4:draw:1:2:-', 'score:4:2']
    expect(shiftLockedRefsForInsert(locks, 2)).toEqual([
      '0:deal:0:0:-',
      '5:draw:1:2:-',
      'score:5:2',
    ])
    expect(lockedRefsForSingleRound(locks, 4)).toEqual([
      '0:draw:1:2:-',
      'score:0:2',
    ])
  })
})
