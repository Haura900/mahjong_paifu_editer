import type { TileCode } from './types'

const SUITS = ['萬', '筒', '索'] as const
const HONORS = ['東', '南', '西', '北', '白', '發', '中'] as const

export const ALL_TILE_CODES: TileCode[] = [
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 23, 24, 25, 26, 27, 28, 29,
  31, 32, 33, 34, 35, 36, 37, 38, 39,
  41, 42, 43, 44, 45, 46, 47,
  51, 52, 53,
]

export function isTileCode(value: unknown): value is TileCode {
  return typeof value === 'number' && ALL_TILE_CODES.includes(value as TileCode)
}

export function normalizeTile(code: number): number {
  if (code >= 51 && code <= 53) return (code - 50) * 10 + 5
  return code
}

export function isRed(code: number): boolean {
  return code === 51 || code === 52 || code === 53
}

export function tileLabel(code: number): string {
  if (isRed(code)) return `赤5${SUITS[code - 51]}`
  const suit = Math.floor(code / 10)
  const rank = code % 10
  if (suit >= 1 && suit <= 3) return `${rank}${SUITS[suit - 1]}`
  return HONORS[rank - 1] ?? `不明(${code})`
}

export function tileShortLabel(code: number): string {
  if (isRed(code)) return `赤${SUITS[code - 51]}`
  const suit = Math.floor(code / 10)
  const rank = code % 10
  if (suit >= 1 && suit <= 3) return `${rank}${SUITS[suit - 1]}`
  return HONORS[rank - 1] ?? '?'
}

export function tileImageFilename(code: number): string {
  if (code === 51) return 'Man5-Dora.png'
  if (code === 52) return 'Pin5-Dora.png'
  if (code === 53) return 'Sou5-Dora.png'
  const normalized = normalizeTile(code)
  const suit = Math.floor(normalized / 10)
  const rank = normalized % 10
  if (suit === 1) return `Man${rank}.png`
  if (suit === 2) return `Pin${rank}.png`
  if (suit === 3) return `Sou${rank}.png`
  return ['Ton.png', 'Nan.png', 'Shaa.png', 'Pei.png', 'Haku.png', 'Hatsu.png', 'Chun.png'][rank - 1] ?? 'Blank.png'
}

export function tileSuit(code: number): 'm' | 'p' | 's' | 'z' {
  const normalized = normalizeTile(code)
  const suit = Math.floor(normalized / 10)
  return suit === 1 ? 'm' : suit === 2 ? 'p' : suit === 3 ? 's' : 'z'
}

export function tileSort(a: number, b: number): number {
  const normal = normalizeTile(a) - normalizeTile(b)
  return normal || Number(isRed(b)) - Number(isRed(a))
}

export function sameTileKind(a: number, b: number): boolean {
  return normalizeTile(a) === normalizeTile(b)
}

export function toMajiangTile(code: number): string {
  const normalized = normalizeTile(code)
  const suit = tileSuit(normalized)
  const rank = normalized % 10
  if (isRed(code)) return `${suit}0`
  return `${suit}${rank}`
}

export function fromMajiangTile(value: string): TileCode | undefined {
  if (!/^[mpsz][0-9]$/.test(value)) return undefined
  const suit = 'mpsz'.indexOf(value[0]!)
  const rank = Number(value[1])
  if (rank === 0 && suit < 3) return (51 + suit) as TileCode
  const code = (suit + 1) * 10 + rank
  return isTileCode(code) ? code : undefined
}

export function tileKindIndex(code: number): number {
  const n = normalizeTile(code)
  const suit = Math.floor(n / 10)
  const rank = n % 10
  return suit < 4 ? (suit - 1) * 9 + rank - 1 : 27 + rank - 1
}

export function indexToTileCode(index: number): TileCode {
  if (index < 27) return (Math.floor(index / 9) * 10 + 11 + (index % 9)) as TileCode
  return (41 + index - 27) as TileCode
}
