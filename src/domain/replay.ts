import { meldTarget, parseMeldString, parseTenhouLog, refKey } from './codec'
import type { ParsedMeldString } from './codec'
import { isWinningHand } from './hand'
import { applyLedger, deltaEntry } from './scoring'
import { isRed, normalizeTile, sameTileKind, tileLabel, tileSort } from './tile'
import { validateScoreContinuity, validateState } from './validator'
import type {
  DecodedMatch,
  DecodedRound,
  Diagnostic,
  Meld,
  NormalizedEvent,
  RawRef,
  RawRound,
  RawTile,
  RoundState,
  Seat,
  TenhouLog,
  TileCode,
  TileTrace,
} from './types'

function seatArray<T>(factory: (seat: Seat) => T): [T, T, T, T] {
  return [factory(0), factory(1), factory(2), factory(3)]
}

function addDiagnostic(
  state: RoundState,
  code: string,
  message: string,
  severity: Diagnostic['severity'] = 'error',
  seat?: Seat,
  ref?: RawRef,
): void {
  state.diagnostics.push({
    code,
    severity,
    message,
    round: state.round,
    event: state.eventIndex,
    seat,
    ref,
  })
}

function makeInitialState(log: TenhouLog, raw: RawRound, round: number): RoundState {
  const roundNumber = raw[0][0]
  return {
    round,
    eventIndex: 0,
    roundNumber,
    honba: raw[0][1],
    riichiSticks: raw[0][2],
    dealer: (roundNumber % 4) as Seat,
    scores: [...raw[1]],
    names: [...log.name],
    hands: seatArray(() => []),
    rivers: seatArray(() => []),
    melds: seatArray(() => []),
    reach: [false, false, false, false],
    kanCounts: [0, 0, 0, 0],
    temporaryFuriten: [false, false, false, false],
    pendingRonPasses: [false, false, false, false],
    dora: [],
    ura: [],
    tiles: {},
    wallRemaining: 70,
    diagnostics: [],
    streamCursors: { draws: [0, 0, 0, 0], discards: [0, 0, 0, 0] },
    ended: false,
  }
}

function uniqueTileId(state: RoundState, ref: RawRef): string {
  const base = `r${state.round}-${refKey(ref).replaceAll(':', '-')}`
  let id = base
  let copy = 1
  while (state.tiles[id]) id = `${base}-${copy++}`
  return id
}

function allocateTile(
  state: RoundState,
  code: TileCode,
  origin: TileTrace['origin'],
  ref: RawRef,
  eventIndex: number,
  owner?: Seat,
): string {
  const id = uniqueTileId(state, ref)
  const trace: TileTrace = {
    id,
    code,
    kind: normalizeTile(code),
    red: isRed(code),
    origin,
    acquiredAt: eventIndex,
    location: origin === 'dora' ? 'dora' : 'hand',
    owner,
    acquisitionRef: ref,
    references: [ref],
  }
  state.tiles[id] = trace
  if (owner !== undefined && origin !== 'dora') state.hands[owner]!.push(id)
  if (origin === 'dora') state.dora.push(id)
  return id
}

function findHandTile(state: RoundState, seat: Seat, code: TileCode): string | undefined {
  const hand = state.hands[seat]!
  return hand.find((id) => state.tiles[id]!.code === code)
    ?? hand.find((id) => sameTileKind(state.tiles[id]!.code, code))
}

function removeFromHand(state: RoundState, seat: Seat, id: string): void {
  const index = state.hands[seat]!.indexOf(id)
  if (index >= 0) state.hands[seat]!.splice(index, 1)
}

function cloneSnapshot(state: RoundState): RoundState {
  for (const hand of state.hands) {
    hand.sort((a, b) => tileSort(state.tiles[a]!.code, state.tiles[b]!.code))
  }
  return structuredClone(state)
}

interface RoundPlayerStreams {
  deals: number[][]
  draws: RawTile[][]
  discards: RawTile[][]
}

function roundStreams(raw: RawRound): RoundPlayerStreams {
  return {
    deals: seatArray((seat) => raw[4 + seat * 3] as number[]),
    draws: seatArray((seat) => raw[5 + seat * 3] as RawTile[]),
    discards: seatArray((seat) => raw[6 + seat * 3] as RawTile[]),
  }
}

function calledTileCode(parsed: ParsedMeldString): TileCode {
  return parsed.codes[parsed.calledIndex ?? 0]!
}

export function replayRound(log: TenhouLog, roundIndex: number): DecodedRound {
  const raw = log.log[roundIndex]
  if (!raw) throw new Error(`局${roundIndex + 1}がありません`)
  const streams = roundStreams(raw)
  const state = makeInitialState(log, raw, roundIndex)
  const events: NormalizedEvent[] = []
  const snapshots: RoundState[] = []
  let nextDora = 0
  let eventCounter = 0
  let rinshan = false

  const emit = (event: Omit<NormalizedEvent, 'id' | 'round' | 'index'>): NormalizedEvent => {
    eventCounter += 1
    state.eventIndex = eventCounter
    const normalized: NormalizedEvent = {
      ...event,
      id: `r${roundIndex}-e${eventCounter}`,
      round: roundIndex,
      index: eventCounter,
    }
    const issues = validateState(state, normalized, log.rule)
    state.diagnostics.push(...issues)
    events.push(normalized)
    snapshots.push(cloneSnapshot(state))
    return normalized
  }

  for (let seat = 0; seat < 4; seat += 1) {
    streams.deals[seat]!.forEach((code, index) => {
      allocateTile(
        state,
        code as TileCode,
        'deal',
        { round: roundIndex, section: 'deal', seat: seat as Seat, index },
        0,
        seat as Seat,
      )
    })
  }
  if (raw[2][0] !== undefined) {
    allocateTile(state, raw[2][0] as TileCode, 'dora', { round: roundIndex, section: 'dora', index: 0 }, 0)
    nextDora = 1
  }
  const startEvent: NormalizedEvent = {
    id: `r${roundIndex}-e0`,
    round: roundIndex,
    index: 0,
    type: 'start',
    actor: state.dealer,
    label: `${roundLabel(raw[0][0])} ${raw[0][1]}本場`,
  }
  events.push(startEvent)
  state.diagnostics.push(...validateState(state, startEvent, log.rule))
  snapshots.push(cloneSnapshot(state))

  const drawTile = (seat: Seat, item: number, index: number): void => {
    state.pendingRonPasses.forEach((passed, player) => {
      if (passed) state.temporaryFuriten[player] = true
    })
    state.pendingRonPasses.fill(false)
    const ref: RawRef = { round: roundIndex, section: 'draw', seat, index }
    const tileId = allocateTile(state, item as TileCode, 'draw', ref, eventCounter + 1, seat)
    state.lastDraw = { seat, tileId }
    state.turn = seat
    state.wallRemaining = Math.max(0, state.wallRemaining - 1)
    emit({
      type: rinshan ? 'rinshan-draw' : 'draw',
      actor: seat,
      tile: item as TileCode,
      tileId,
      rawRef: ref,
      label: `${state.names[seat]} ${rinshan ? '嶺上' : ''}ツモ ${tileLabel(item)}`,
    })
    rinshan = false
  }

  const discardTile = (seat: Seat, item: number | string, index: number): void => {
    if (!state.reach[seat]) state.temporaryFuriten[seat] = false
    const ref: RawRef = { round: roundIndex, section: 'discard', seat, index }
    const reach = typeof item === 'string' && item.startsWith('r')
    const rawCode = typeof item === 'string' ? Number(item.slice(1)) : item
    const tsumogiri = rawCode === 60
    if (reach) {
      emit({
        type: 'reach-declare',
        actor: seat,
        rawRef: ref,
        label: `${state.names[seat]} リーチ宣言`,
      })
    }
    let tileId: string | undefined
    if (tsumogiri && state.lastDraw?.seat === seat && state.hands[seat]!.includes(state.lastDraw.tileId)) {
      tileId = state.lastDraw.tileId
    } else if (!tsumogiri) {
      tileId = findHandTile(state, seat, rawCode as TileCode)
    }
    if (!tileId) {
      addDiagnostic(state, 'TILE_NOT_IN_HAND', `${state.names[seat]}の手牌に${tsumogiri ? '直前ツモ牌' : tileLabel(rawCode)}がありません`, 'error', seat, ref)
      tileId = state.hands[seat]![state.hands[seat]!.length - 1]
    }
    if (!tileId) return
    const trace = state.tiles[tileId]!
    removeFromHand(state, seat, tileId)
    trace.location = 'river'
    trace.owner = seat
    trace.departedAt = eventCounter + 1
    trace.references.push(ref)
    const riverIndex = state.rivers[seat]!.length
    state.rivers[seat]!.push({
      tileId,
      code: trace.code,
      called: false,
      reach,
      tsumogiri,
      rawRef: ref,
      eventIndex: eventCounter + 1,
    })
    state.lastDiscard = { seat, riverIndex, tileId }
    state.turn = seat
    emit({
      type: 'discard',
      actor: seat,
      tile: trace.code,
      tileId,
      rawRef: ref,
      tsumogiri,
      reach,
      label: `${state.names[seat]} ${reach ? 'リーチ・' : ''}${tsumogiri ? 'ツモ切り' : '手出し'} ${tileLabel(trace.code)}`,
    })
    state.pendingRonPasses.fill(false)
    for (let player = 0; player < 4; player += 1) {
      if (player === seat) continue
      const target = player as Seat
      const codes = state.hands[target]!.map((id) => state.tiles[id]!.code)
      state.pendingRonPasses[target] = isWinningHand(
        [...codes, trace.code],
        state.melds[target]!.length,
      )
    }
    if (reach) {
      if (state.scores[seat]! < 1000) {
        addDiagnostic(state, 'INSUFFICIENT_REACH_SCORE', `${state.names[seat]}はリーチ棒を支払えません`, 'error', seat, ref)
      } else {
        state.scores[seat]! -= 1000
        state.riichiSticks += 1
        state.reach[seat] = true
      }
      emit({
        type: 'reach-accepted',
        actor: seat,
        rawRef: ref,
        label: `${state.names[seat]} リーチ成立（1000点供託）`,
      })
    }
  }

  const consumeForMeld = (
    actor: Seat,
    parsed: ParsedMeldString,
    rawRef: RawRef,
    target?: Seat,
  ): { ids: string[]; calledId?: string } => {
    const ids: string[] = []
    let calledId: string | undefined
    for (let token = 0; token < parsed.codes.length; token += 1) {
      const code = parsed.codes[token]!
      const tokenRef: RawRef = { ...rawRef, token }
      if (target !== undefined && token === parsed.calledIndex && state.lastDiscard) {
        const river = state.rivers[state.lastDiscard.seat]![state.lastDiscard.riverIndex]!
        if (sameTileKind(river.code, code)) {
          calledId = river.tileId
          river.called = true
          const trace = state.tiles[calledId]!
          trace.references.push(tokenRef)
          ids.push(calledId)
          continue
        }
      }
      const id = findHandTile(state, actor, code)
      if (!id) {
        addDiagnostic(state, 'MELD_TILE_MISSING', `${state.names[actor]}の手牌に副露用の${tileLabel(code)}がありません`, 'error', actor, rawRef)
        continue
      }
      removeFromHand(state, actor, id)
      state.tiles[id]!.references.push(tokenRef)
      ids.push(id)
    }
    return { ids, calledId }
  }

  const revealKanDora = (): void => {
    const code = raw[2][nextDora]
    if (code === undefined) return
    const ref: RawRef = { round: roundIndex, section: 'dora', index: nextDora }
    const tileId = allocateTile(state, code as TileCode, 'dora', ref, eventCounter + 1)
    nextDora += 1
    emit({ type: 'dora', tile: code as TileCode, tileId, rawRef: ref, label: `カンドラ表示 ${tileLabel(code)}` })
  }

  const processMeld = (actor: Seat, rawString: string, rawRef: RawRef): ParsedMeldString | undefined => {
    state.pendingRonPasses.forEach((passed, player) => {
      if (passed) state.temporaryFuriten[player] = true
    })
    state.pendingRonPasses.fill(false)
    const parsed = parseMeldString(rawString)
    if (!parsed) {
      addDiagnostic(state, 'UNKNOWN_MELD', `副露表現「${rawString}」を解析できません`, 'error', actor, rawRef)
      return undefined
    }
    const target = meldTarget(actor, parsed)
    let tileIds: string[] = []
    if (parsed.type === 'kakan') {
      const existing = state.melds[actor]!.find((meld) =>
        meld.type === 'pon' && sameTileKind(meld.codes[0]!, parsed.codes[0]!))
      const added = findHandTile(state, actor, parsed.codes[0]!)
      if (!existing || !added) {
        addDiagnostic(state, 'INVALID_KAKAN', `${state.names[actor]}の加槓元となる刻子または加槓牌がありません`, 'error', actor, rawRef)
      } else {
        removeFromHand(state, actor, added)
        existing.tileIds.forEach((id, token) => {
          state.tiles[id]!.references.push({ ...rawRef, token })
        })
        state.tiles[added]!.references.push({ ...rawRef, token: existing.tileIds.length })
        existing.type = 'kakan'
        existing.raw = rawString
        existing.rawRef = rawRef
        existing.codes.push(state.tiles[added]!.code)
        existing.tileIds.push(added)
        tileIds = [...existing.tileIds]
      }
    } else {
      tileIds = consumeForMeld(actor, parsed, rawRef, target).ids
      const meld: Meld = {
        id: `r${roundIndex}-m${eventCounter + 1}`,
        type: parsed.type,
        actor,
        target,
        tileIds,
        codes: tileIds.map((id) => state.tiles[id]!.code),
        calledIndex: parsed.calledIndex,
        raw: rawString,
        rawRef,
        eventIndex: eventCounter + 1,
      }
      state.melds[actor]!.push(meld)
    }
    for (const id of tileIds) {
      const tile = state.tiles[id]
      if (!tile) continue
      tile.location = 'meld'
      tile.owner = actor
      tile.departedAt = eventCounter + 1
    }
    const eventType = parsed.type
    emit({
      type: eventType,
      actor,
      target,
      tile: calledTileCode(parsed),
      meld: state.melds[actor]![state.melds[actor]!.length - 1],
      rawRef,
      label: `${state.names[actor]} ${meldLabel(parsed.type)} ${parsed.codes.map(tileLabel).join('・')}`,
    })
    if (parsed.type === 'ankan' || parsed.type === 'kakan' || parsed.type === 'daiminkan') {
      const totalKans = state.kanCounts.reduce((sum, count) => sum + count, 0)
      if (totalKans >= 4) {
        addDiagnostic(
          state,
          'FIFTH_KAN',
          '5回目のカンはできません',
          'error',
          actor,
          rawRef,
        )
      }
      state.kanCounts[actor]! += 1
      revealKanDora()
      rinshan = true
    }
    return parsed
  }

  const findPendingCall = (): { seat: Seat; value: string; index: number; parsed: ParsedMeldString } | undefined => {
    if (!state.lastDiscard) return undefined
    const discarded = state.tiles[state.lastDiscard.tileId]!.code
    for (let offset = 1; offset <= 3; offset += 1) {
      const seat = ((state.lastDiscard.seat + offset) % 4) as Seat
      const index = state.streamCursors.draws[seat]!
      const value = streams.draws[seat]![index]
      if (typeof value !== 'string') continue
      const parsed = parseMeldString(value)
      if (!parsed || (parsed.type !== 'chi' && parsed.type !== 'pon' && parsed.type !== 'daiminkan')) continue
      const target = meldTarget(seat, parsed)
      if (target !== state.lastDiscard.seat || !sameTileKind(calledTileCode(parsed), discarded)) continue
      return { seat, value, index, parsed }
    }
    return undefined
  }

  let current = state.dealer
  let phase: 'draw' | 'discard' = 'draw'
  let guard = 0
  while (guard++ < 500) {
    if (phase === 'draw') {
      const drawIndex = state.streamCursors.draws[current]!
      const item = streams.draws[current]![drawIndex]
      if (item === undefined) break
      if (typeof item === 'string') {
        const ref: RawRef = { round: roundIndex, section: 'draw', seat: current, index: drawIndex }
        state.streamCursors.draws[current]! += 1
        const parsed = processMeld(current, item, ref)
        phase = parsed?.type === 'daiminkan' ? 'draw' : 'discard'
        continue
      }
      state.streamCursors.draws[current]! += 1
      drawTile(current, item, drawIndex)
      phase = 'discard'
      continue
    }

    const discardIndex = state.streamCursors.discards[current]!
    const item = streams.discards[current]![discardIndex]
    if (item === undefined) break
    if (typeof item === 'string' && !item.startsWith('r')) {
      const ref: RawRef = { round: roundIndex, section: 'discard', seat: current, index: discardIndex }
      state.streamCursors.discards[current]! += 1
      processMeld(current, item, ref)
      phase = 'draw'
      continue
    }
    state.streamCursors.discards[current]! += 1
    discardTile(current, item, discardIndex)
    const pending = findPendingCall()
    if (pending) {
      state.streamCursors.draws[pending.seat]! += 1
      const ref: RawRef = { round: roundIndex, section: 'draw', seat: pending.seat, index: pending.index }
      processMeld(pending.seat, pending.value, ref)
      current = pending.seat
      phase = pending.parsed.type === 'daiminkan' ? 'draw' : 'discard'
    } else {
      current = ((current + 1) % 4) as Seat
      phase = 'draw'
    }
  }
  if (guard >= 500) addDiagnostic(state, 'REPLAY_GUARD', 'イベント数が上限を超えたため再生を停止しました')

  raw[3].forEach((code, index) => {
    const ref: RawRef = { round: roundIndex, section: 'ura', index }
    const id = allocateTile(state, code as TileCode, 'dora', ref, eventCounter + 1)
    state.dora.pop()
    state.ura.push(id)
  })

  const result = raw[16]
  state.result = structuredClone(result)
  const resultLabel = String(result[0])
  if (resultLabel === '和了') {
    for (let index = 1; index < result.length; index += 2) {
      const delta = result[index]
      const details = result[index + 1]
      if (!Array.isArray(delta) || delta.length !== 4 || !Array.isArray(details)) continue
      const winner = Number(details[0]) as Seat
      const loser = Number(details[1]) as Seat
      const selfDraw = winner === loser
      const winTileId = selfDraw
        ? state.lastDraw?.seat === winner ? state.lastDraw.tileId : undefined
        : state.lastDiscard?.seat === loser ? state.lastDiscard.tileId : undefined
      emit({
        type: selfDraw ? 'tsumo-win' : 'ron',
        actor: winner,
        target: loser,
        tileId: winTileId,
        tile: winTileId ? state.tiles[winTileId]!.code : undefined,
        scoreDelta: delta as number[],
        label: `${state.names[winner]} ${selfDraw ? 'ツモ和了' : `${state.names[loser]}からロン和了`}`,
      })
      state.scores = applyLedger(state.scores, [deltaEntry('win', '和了点・本場・供託', delta as number[])])
    }
    state.riichiSticks = 0
  } else {
    const delta = Array.isArray(result[1]) ? result[1] as number[] : [0, 0, 0, 0]
    state.scores = applyLedger(state.scores, [deltaEntry('draw-penalty', `${resultLabel}の局収支`, delta)])
    const hasDelta = delta.some((value) => value !== 0)
    emit({
      type: 'draw-game',
      scoreDelta: delta,
      label: hasDelta
        ? `${resultLabel}（${delta.map((value) => value >= 0 ? `+${value}` : value).join(' / ')}）`
        : resultLabel,
    })
  }
  state.ended = true
  if (snapshots.length) {
    snapshots[snapshots.length - 1] = cloneSnapshot(state)
  }

  const allDiagnostics = snapshots.flatMap((snapshot) => snapshot.diagnostics)
  const unique = [...new Map(allDiagnostics.map((item) => [
    `${item.code}:${item.event}:${item.seat ?? '-'}:${item.message}`,
    item,
  ])).values()]
  return { raw, events, snapshots, diagnostics: unique }
}

export function decodeMatch(input: string | unknown): DecodedMatch {
  const raw = parseTenhouLog(input)
  const rounds = raw.log.map((_, index) => replayRound(raw, index))
  return {
    raw,
    rounds,
    diagnostics: [
      ...rounds.flatMap((round) => round.diagnostics),
      ...validateScoreContinuity(raw),
    ],
  }
}

export function snapshotAt(round: DecodedRound, event: number): RoundState {
  return round.snapshots[Math.max(0, Math.min(event, round.snapshots.length - 1))]!
}

export function roundLabel(index: number): string {
  const winds = ['東', '南', '西', '北']
  return `${winds[Math.floor(index / 4)] ?? '?'}${(index % 4) + 1}局`
}

export function meldLabel(type: Meld['type']): string {
  return {
    chi: 'チー',
    pon: 'ポン',
    daiminkan: '大明槓',
    ankan: '暗槓',
    kakan: '加槓',
  }[type]
}
