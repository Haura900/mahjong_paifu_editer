import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMatch } from '../replay'
import { keepOnlyRound, parseClipboardRound, replaceRound, singleRoundLog } from '../rounds'
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

  it('copies one compatible round and pastes it over the selected round', () => {
    const copiedText = JSON.stringify(singleRoundLog(sample, 0))
    const copied = parseClipboardRound(copiedText, sample)
    const output = replaceRound(sample, 1, copied.round)
    expect(output.log).toHaveLength(sample.log.length)
    expect(output.log[1]).toEqual(sample.log[0])
    expect(output.log[0]).toEqual(sample.log[0])
  })

  it('rejects a copied round whose player order differs', () => {
    const foreign = singleRoundLog(sample, 0)
    foreign.name = [...foreign.name].reverse()
    expect(() => parseClipboardRound(JSON.stringify(foreign), sample)).toThrow(/プレイヤーの並び/)
  })
})
