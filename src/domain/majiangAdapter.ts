import Majiang from '@kobalab/majiang-core'
import { isRed, normalizeTile, tileSuit } from './tile'

function handString(codes: number[]): string {
  const groups: Record<'m' | 'p' | 's' | 'z', string[]> = { m: [], p: [], s: [], z: [] }
  for (const code of codes) {
    const suit = tileSuit(code)
    groups[suit].push(isRed(code) ? '0' : String(normalizeTile(code) % 10))
  }
  return (['m', 'p', 's', 'z'] as const)
    .filter((suit) => groups[suit].length)
    .map((suit) => `${suit}${groups[suit].sort().join('')}`)
    .join('')
}

/**
 * Stable adapter boundary around majiang-core. Partially reconstructed open hands
 * use the editor's own algorithm because the source JSON can be between call phases.
 */
export function libraryShanten(codes: number[], openMeldCount = 0): number | undefined {
  if (openMeldCount > 0) return undefined
  try {
    return Majiang.Util.xiangting(Majiang.Shoupai.fromString(handString(codes)))
  } catch {
    return undefined
  }
}
