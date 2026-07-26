import { isTenpai, isWinningHand } from './hand'
import { libraryShanten } from './majiangAdapter'
import { isRed, normalizeTile, tileLabel } from './tile'
import type { Diagnostic, NormalizedEvent, RoundState, Seat, TenhouLog } from './types'

function issue(
  state: RoundState,
  code: string,
  message: string,
  severity: Diagnostic['severity'] = 'error',
  seat?: Seat,
): Diagnostic {
  return {
    code,
    severity,
    message,
    round: state.round,
    event: state.eventIndex,
    seat,
  }
}

export function validateState(
  state: RoundState,
  event?: NormalizedEvent,
  rule: Record<string, unknown> = {},
): Diagnostic[] {
  const result: Diagnostic[] = []
  const physicalLocations = new Map<string, string>()
  const counts = new Map<number, number>()
  const redCounts = [0, 0, 0]

  for (const tile of Object.values(state.tiles)) {
    if (tile.location === 'unknown') continue
    const location = `${tile.location}:${tile.owner ?? '-'}`
    const previous = physicalLocations.get(tile.id)
    if (previous && previous !== location) {
      result.push(issue(state, 'DUPLICATE_PHYSICAL_TILE', `物理牌 ${tile.id} が ${previous} と ${location} に重複しています`))
    }
    physicalLocations.set(tile.id, location)
    counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1)
    if (isRed(tile.code)) redCounts[tile.code - 51]! += 1
  }
  for (const [kind, count] of counts) {
    if (count > 4) result.push(issue(state, 'FIFTH_TILE', `${tileLabel(kind)} が${count}枚あります`))
  }
  for (let suit = 0; suit < 3; suit += 1) {
    const allowed = Number(rule[`aka5${suit + 1}`] ?? rule.aka ?? 1)
    if (redCounts[suit]! > allowed) {
      result.push(issue(state, 'RED_TILE_COUNT', `${['萬子', '筒子', '索子'][suit]}の赤5がルール設定（${allowed}枚）を超えています`))
    }
  }

  if (event?.actor !== undefined) {
    const seat = event.actor
    const meldCount = state.melds[seat]!.length
    const handSize = state.hands[seat]!.length
    if (event.type === 'draw' || event.type === 'rinshan-draw') {
      const expected = 14 - meldCount * 3
      if (handSize !== expected) {
        result.push(issue(state, 'HAND_SIZE_AFTER_DRAW', `${tileLabel(event.tile!)}のツモ後の手牌が${handSize}枚です（期待値${expected}）`, 'error', seat))
      }
    }
    if (event.type === 'discard') {
      const expected = 13 - meldCount * 3
      if (handSize !== expected) {
        result.push(issue(state, 'HAND_SIZE_AFTER_DISCARD', `打牌後の手牌が${handSize}枚です（期待値${expected}）`, 'error', seat))
      }
      if (event.tsumogiri && state.lastDraw?.tileId !== event.tileId) {
        result.push(issue(state, 'INVALID_TSUMOGIRI', 'ツモ切り牌が直前のツモ牌と一致しません', 'error', seat))
      }
    }
    if (event.type === 'reach-accepted') {
      const open = state.melds[seat]!.some((meld) => meld.type !== 'ankan')
      if (open) result.push(issue(state, 'OPEN_REACH', '副露した手牌ではリーチできません', 'error', seat))
      const codes = state.hands[seat]!.map((id) => state.tiles[id]!.code)
      const adapterShanten = libraryShanten(codes, meldCount)
      if (adapterShanten !== undefined ? adapterShanten !== 0 : !isTenpai(codes, meldCount)) {
        result.push(issue(state, 'REACH_NOT_TENPAI', 'リーチ成立時の手牌が聴牌していません', 'error', seat))
      }
    }
  }

  if (event?.type === 'ron' || event?.type === 'tsumo-win') {
    const winner = event.actor!
    const codes = state.hands[winner]!.map((id) => state.tiles[id]!.code)
    const meldCount = state.melds[winner]!.length
    const winCodes = event.type === 'ron' && event.tile ? [...codes, event.tile] : codes
    if (!isWinningHand(winCodes, meldCount)) {
      result.push(issue(state, 'INVALID_WIN_SHAPE', `${event.type === 'ron' ? 'ロン' : 'ツモ'}和了の手牌が和了形ではありません`, 'warning', winner))
    }
  }

  return result
}

export function validateScoreContinuity(log: TenhouLog): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (let index = 0; index < log.log.length - 1; index += 1) {
    const current = log.log[index]!
    const next = log.log[index + 1]!
    const scores = [...current[1]]
    const result = current[16]
    let reachCount = 0
    for (let seat = 0; seat < 4; seat += 1) {
      const discards = current[6 + seat * 3] as (number | string)[]
      if (discards.some((discard) => typeof discard === 'string' && discard.startsWith('r'))) {
        scores[seat]! -= 1000
        reachCount += 1
      }
    }
    const delta = Array.isArray(result[1]) ? result[1] as number[] : []
    if (delta.length === 4) delta.forEach((value, seat) => { scores[seat]! += value })
    if (!scores.every((score, seat) => score === next[1][seat])) {
      diagnostics.push({
        code: 'SCORE_DISCONTINUITY',
        severity: 'error',
        message: `局${index + 1}の終了点 ${scores.join('/')} と次局開始点 ${next[1].join('/')} が一致しません（リーチ${reachCount}件）`,
        round: index,
      })
    }
  }
  return diagnostics
}

export function tenpaiSeats(state: RoundState): Seat[] {
  return ([0, 1, 2, 3] as Seat[]).filter((seat) => {
    const codes = state.hands[seat]!.map((id) => normalizeTile(state.tiles[id]!.code))
    return isTenpai(codes, state.melds[seat]!.length)
  })
}
