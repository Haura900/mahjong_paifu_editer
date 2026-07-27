import Majiang from '@kobalab/majiang-core'
import { isRed, normalizeTile, tileSuit } from './tile'
import type { Meld, NormalizedEvent, RoundState, Seat, TileCode } from './types'

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

function tileString(code: number): string {
  return `${tileSuit(code)}${isRed(code) ? 0 : normalizeTile(code) % 10}`
}

function meldDirection(meld: Meld): '+' | '=' | '-' {
  const relative = meld.target === undefined ? 3 : (meld.target - meld.actor + 4) % 4
  return relative === 1 ? '+' : relative === 2 ? '=' : '-'
}

function meldString(meld: Meld): string {
  const suit = tileSuit(meld.codes[0]!)
  const digits = meld.codes.map((code) => isRed(code) ? '0' : String(normalizeTile(code) % 10))
  if (meld.type === 'ankan') return `${suit}${digits.join('')}`
  const direction = meldDirection(meld)
  if (meld.type === 'daiminkan') return `${suit}${digits.join('')}${direction}`
  if (meld.type === 'kakan') {
    const ponDigits = digits.slice(0, 3)
    return `${suit}${ponDigits.join('')}${direction}${digits[3]}`
  }
  if (meld.type === 'pon') return `${suit}${digits.join('')}${direction}`
  const calledIndex = Math.max(0, Math.min(meld.calledIndex ?? 0, digits.length - 1))
  return `${suit}${digits.map((digit, index) => index === calledIndex ? `${digit}${direction}` : digit).join('')}`
}

function stateHand(
  state: RoundState,
  seat: Seat,
  selfDraw: boolean,
): ReturnType<typeof Majiang.Shoupai.fromString> {
  const ids = [...state.hands[seat]!]
  let winningCode: TileCode | undefined
  if (selfDraw && state.lastDraw?.seat === seat) {
    const index = ids.indexOf(state.lastDraw.tileId)
    if (index >= 0) {
      winningCode = state.tiles[ids[index]!]!.code
      ids.splice(index, 1)
    }
  }
  let concealed = handString(ids.map((id) => state.tiles[id]!.code))
  if (winningCode !== undefined) concealed += tileString(winningCode)
  if (state.reach[seat]) concealed += '*'
  const melds = state.melds[seat]!.map(meldString)
  return Majiang.Shoupai.fromString([concealed, ...melds].join(','))
}

function indicatorStrings(state: RoundState, ids: string[]): string[] {
  return ids
    .map((id) => state.tiles[id]?.code)
    .filter((code): code is TileCode => code !== undefined)
    .map(tileString)
}

export interface WinEvaluation {
  legal: boolean
  delta?: [number, number, number, number]
  yaku?: string[]
}

/**
 * Evaluates an edited win through majiang-core, including open-hand yaku,
 * contextual yaku, honba and riichi deposits. Player-indexed score deltas are
 * returned even though majiang-core internally uses wind-relative seats.
 */
export function evaluateWin(
  state: RoundState,
  seat: Seat,
  options: {
    selfDraw: boolean
    tile?: TileCode
    target?: Seat
    event?: NormalizedEvent
  },
): WinEvaluation {
  try {
    const shoupai = stateHand(state, seat, options.selfDraw)
    const menfeng = (seat - state.dealer + 4) % 4
    const targetWind = options.target === undefined
      ? undefined
      : (options.target - state.dealer + 4) % 4
    const direction = targetWind === undefined
      ? undefined
      : targetWind - menfeng === 1 || targetWind - menfeng === -3
        ? '+'
        : Math.abs(targetWind - menfeng) === 2
          ? '='
          : '-'
    const rongpai = options.selfDraw || options.tile === undefined
      ? null
      : `${tileString(options.tile)}${direction}`
    const param = Majiang.Util.hule_param({
      rule: Majiang.rule(),
      zhuangfeng: Math.floor(state.roundNumber / 4),
      menfeng,
      lizhi: state.reach[seat] ? 1 : 0,
      lingshang: options.event?.type === 'rinshan-draw',
      haidi: state.wallRemaining === 0 ? (options.selfDraw ? 1 : 2) : 0,
      baopai: indicatorStrings(state, state.dora),
      fubaopai: state.reach[seat] ? indicatorStrings(state, state.ura) : null,
      changbang: state.honba,
      lizhibang: state.riichiSticks,
    })
    const result = Majiang.Util.hule(shoupai, rongpai, param)
    if (!result?.hupai) return { legal: false }
    const relative = result.fenpei as number[]
    const delta: [number, number, number, number] = [0, 0, 0, 0]
    for (let wind = 0; wind < 4; wind += 1) {
      delta[(state.dealer + wind) % 4] = relative[wind] ?? 0
    }
    return {
      legal: true,
      delta,
      yaku: result.hupai.map((item: { name: string }) => item.name),
    }
  } catch {
    return { legal: false }
  }
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
