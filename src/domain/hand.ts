import { indexToTileCode, normalizeTile, tileKindIndex } from './tile'
import type { Meld, TileCode } from './types'

export function countsFromCodes(codes: number[]): number[] {
  const counts = Array<number>(34).fill(0)
  for (const code of codes) counts[tileKindIndex(code)]! += 1
  return counts
}

function canFormMelds(counts: number[], needed: number): boolean {
  if (needed === 0) return counts.every((count) => count === 0)
  const first = counts.findIndex((count) => count > 0)
  if (first < 0) return false
  if (counts[first]! >= 3) {
    counts[first]! -= 3
    if (canFormMelds(counts, needed - 1)) {
      counts[first]! += 3
      return true
    }
    counts[first]! += 3
  }
  if (first < 27 && first % 9 <= 6 && counts[first + 1]! > 0 && counts[first + 2]! > 0) {
    counts[first]!--
    counts[first + 1]!--
    counts[first + 2]!--
    if (canFormMelds(counts, needed - 1)) {
      counts[first]!++
      counts[first + 1]!++
      counts[first + 2]!++
      return true
    }
    counts[first]!++
    counts[first + 1]!++
    counts[first + 2]!++
  }
  return false
}

export function isWinningHand(codes: number[], openMeldCount = 0): boolean {
  const neededMelds = 4 - openMeldCount
  if (codes.length !== neededMelds * 3 + 2) return false
  const counts = countsFromCodes(codes)
  if (openMeldCount === 0) {
    const pairs = counts.filter((count) => count === 2).length
    if (pairs === 7) return true
    const terminals = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]
    if (terminals.every((index) => counts[index]! > 0) && terminals.some((index) => counts[index]! > 1)) return true
  }
  for (let pair = 0; pair < 34; pair += 1) {
    if (counts[pair]! < 2) continue
    counts[pair]! -= 2
    const ok = canFormMelds(counts, neededMelds)
    counts[pair]! += 2
    if (ok) return true
  }
  return false
}

export function winningTiles(codes: number[], openMeldCount = 0): TileCode[] {
  const result: TileCode[] = []
  const counts = countsFromCodes(codes)
  for (let index = 0; index < 34; index += 1) {
    if (counts[index]! >= 4) continue
    const code = indexToTileCode(index)
    if (isWinningHand([...codes, code], openMeldCount)) result.push(code)
  }
  return result
}

export function isTenpai(codes: number[], openMeldCount = 0): boolean {
  return winningTiles(codes, openMeldCount).length > 0
}

export function hasBasicYaku(
  codes: number[],
  melds: Meld[],
  options: { reach: boolean; selfDraw: boolean; seatWind: number; roundWind: number },
): boolean {
  if (options.reach) return true
  if (options.selfDraw && melds.every((meld) => meld.type === 'ankan')) return true
  const allCodes = [...codes, ...melds.flatMap((meld) => meld.codes)].map(normalizeTile)
  const simple = allCodes.every((code) => {
    const suit = Math.floor(code / 10)
    const rank = code % 10
    return suit <= 3 && rank > 1 && rank < 9
  })
  if (simple) return true
  const valueHonors = new Set([45, 46, 47, options.seatWind, options.roundWind])
  const counts = countsFromCodes(codes)
  for (const code of valueHonors) {
    if (counts[tileKindIndex(code)]! >= 3) return true
    if (melds.some((meld) => meld.codes.filter((tile) => normalizeTile(tile) === code).length >= 3)) return true
  }
  return false
}

/**
 * Deterministic shanten calculation for standard, seven-pairs and thirteen-orphans hands.
 * It is kept in the adapter layer so the editor can fall back when a third-party API
 * cannot represent a partially edited hand.
 */
export function shanten(codes: number[], openMeldCount = 0): number {
  const counts = countsFromCodes(codes)
  let best = 8
  const visit = (index: number, melds: number, pairs: number, taatsu: number): void => {
    while (index < 34 && counts[index] === 0) index += 1
    if (index >= 34) {
      const cappedTaatsu = Math.min(taatsu, 4 - openMeldCount - melds)
      best = Math.min(best, 8 - (openMeldCount + melds) * 2 - cappedTaatsu - Math.min(pairs, 1))
      return
    }
    if (counts[index]! >= 3) {
      counts[index]! -= 3
      visit(index, melds + 1, pairs, taatsu)
      counts[index]! += 3
    }
    if (index < 27 && index % 9 <= 6 && counts[index + 1]! && counts[index + 2]!) {
      counts[index]!--
      counts[index + 1]!--
      counts[index + 2]!--
      visit(index, melds + 1, pairs, taatsu)
      counts[index]!++
      counts[index + 1]!++
      counts[index + 2]!++
    }
    if (counts[index]! >= 2) {
      counts[index]! -= 2
      visit(index, melds, pairs + 1, taatsu)
      counts[index]! += 2
    }
    if (index < 27 && index % 9 <= 7 && counts[index + 1]!) {
      counts[index]!--
      counts[index + 1]!--
      visit(index, melds, pairs, taatsu + 1)
      counts[index]!++
      counts[index + 1]!++
    }
    if (index < 27 && index % 9 <= 6 && counts[index + 2]!) {
      counts[index]!--
      counts[index + 2]!--
      visit(index, melds, pairs, taatsu + 1)
      counts[index]!++
      counts[index + 2]!++
    }
    counts[index]!--
    visit(index, melds, pairs, taatsu)
    counts[index]!++
  }
  visit(0, 0, 0, 0)

  if (openMeldCount === 0) {
    const pairKinds = counts.filter((count) => count >= 2).length
    const distinct = counts.filter((count) => count > 0).length
    best = Math.min(best, 6 - pairKinds + Math.max(0, 7 - distinct))
    const terminals = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]
    const unique = terminals.filter((index) => counts[index]! > 0).length
    const pair = terminals.some((index) => counts[index]! > 1) ? 1 : 0
    best = Math.min(best, 13 - unique - pair)
  }
  return best
}
