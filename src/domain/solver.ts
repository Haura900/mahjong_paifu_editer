import {
  cloneLog,
  encodeMeld,
  getRoundSection,
  parseMeldString,
  readRawRef,
  refKey,
  writeRawRef,
} from './codec'
import { isTenpai } from './hand'
import { decodeMatch, replayRound, snapshotAt } from './replay'
import { exhaustiveDrawDelta } from './scoring'
import { ALL_TILE_CODES, isRed, normalizeTile, sameTileKind, tileLabel, tileSort } from './tile'
import { tenpaiSeats } from './validator'
import type {
  AutoChange,
  Diagnostic,
  EditRequest,
  MeldType,
  RawRef,
  RawTile,
  RoundState,
  Seat,
  SolverResult,
  TenhouLog,
  TileCode,
  TileTrace,
} from './types'

function diagnosticKey(diagnostic: Diagnostic): string {
  return `${diagnostic.round}:${diagnostic.code}:${diagnostic.event ?? '-'}:${diagnostic.seat ?? '-'}`
}

function isHardError(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === 'error'
}

function setReferenceCode(
  log: TenhouLog,
  ref: RawRef,
  code: TileCode,
  changes: AutoChange[],
  kind: AutoChange['kind'],
  reason: string,
): void {
  const before = readRawRef(log, ref)
  let after: RawTile = code
  if (ref.section === 'discard' && ref.token === undefined) {
    if (before === 60 || before === 'r60') return
    if (typeof before === 'string' && before.startsWith('r')) after = `r${code}`
  }
  if (before === after) return
  writeRawRef(log, ref, after)
  changes.push({
    id: `change-${changes.length + 1}`,
    kind,
    ref,
    before,
    after,
    reason,
  })
}

function updatePhysicalTile(
  log: TenhouLog,
  trace: TileTrace,
  code: TileCode,
  changes: AutoChange[],
  kind: AutoChange['kind'],
  reason: string,
): void {
  setReferenceCode(log, trace.acquisitionRef, code, changes, kind, reason)
  for (const ref of trace.references) {
    if (refKey(ref) === refKey(trace.acquisitionRef)) continue
    setReferenceCode(log, ref, code, changes, kind, `${reason}。後続の参照も同じ物理牌へ追従`)
  }
}

function candidateCost(state: RoundState, tile: TileTrace, targetSeat: Seat | undefined, winner?: Seat): number {
  const seat = tile.owner
  const reach = seat === undefined ? false : state.reach[seat]
  let group = 90
  if (seat !== undefined && seat !== targetSeat && !reach && tile.location === 'hand') group = 0
  else if (seat !== undefined && seat !== targetSeat && !reach && tile.location === 'river') group = 10
  else if (seat !== undefined && seat !== winner && reach && tile.location === 'river') group = 20
  else if (seat !== undefined && seat !== winner && reach && tile.location === 'hand') group = 30
  else if (tile.location === 'dora') group = 70
  return group + tile.acquiredAt / 10000 + Number(refKey(tile.acquisitionRef).replace(/\D/g, '')) / 1e9
}

function selectSwapCandidate(
  state: RoundState,
  requested: TileTrace,
  code: TileCode,
  locked: Set<string>,
  winner?: Seat,
): TileTrace | undefined {
  return Object.values(state.tiles)
    .filter((tile) =>
      tile.id !== requested.id
      && sameTileKind(tile.code, code)
      && !locked.has(refKey(tile.acquisitionRef))
      && tile.origin !== 'dora')
    .sort((a, b) =>
      candidateCost(state, a, requested.owner, winner) - candidateCost(state, b, requested.owner, winner)
      || refKey(a.acquisitionRef).localeCompare(refKey(b.acquisitionRef)))[0]
}

function resultWinner(log: TenhouLog, round: number): Seat | undefined {
  const result = log.log[round]![16]
  const details = result[2]
  return Array.isArray(details) && Number.isInteger(details[0]) ? Number(details[0]) as Seat : undefined
}

function repairFifthTiles(
  log: TenhouLog,
  round: number,
  requestedTrace: TileTrace,
  oldCode: TileCode,
  requestedCode: TileCode,
  changes: AutoChange[],
  locked: Set<string>,
): string | undefined {
  let replayed = replayRound(log, round)
  const final = replayed.snapshots[replayed.snapshots.length - 1]!
  const count = Object.values(final.tiles).filter((tile) => sameTileKind(tile.code, requestedCode)).length
  if (count <= 4) return undefined
  const currentRequested = Object.values(final.tiles).find((tile) => refKey(tile.acquisitionRef) === refKey(requestedTrace.acquisitionRef))
    ?? requestedTrace
  const candidate = selectSwapCandidate(final, currentRequested, requestedCode, locked, resultWinner(log, round))
  if (!candidate) return `${tileLabel(requestedCode)}はすでに4枚すべて固定されており、交換できる牌がありません`
  updatePhysicalTile(
    log,
    candidate,
    oldCode,
    changes,
    'automatic',
    `${tileLabel(requestedCode)}が5枚になるため、${candidate.owner === undefined ? '未確定領域' : final.names[candidate.owner]}の${locationLabel(candidate.location)}にある${tileLabel(candidate.code)}と元の${tileLabel(oldCode)}を交換`,
  )
  replayed = replayRound(log, round)
  if (replayed.diagnostics.some((item) => item.code === 'FIFTH_TILE' && item.severity === 'error')) {
    return '牌交換後も4枚制約を満たせません'
  }
  return undefined
}

function locationLabel(location: TileTrace['location']): string {
  return { hand: '手牌', river: '河', meld: '副露', dora: 'ドラ表示', unknown: '未確定牌山' }[location]
}

function propagateScores(
  log: TenhouLog,
  fromRound: number,
  changes: AutoChange[],
  locked: Set<string>,
): void {
  for (let round = fromRound; round < log.log.length - 1; round += 1) {
    const replayed = replayRound(log, round)
    const final = replayed.snapshots[replayed.snapshots.length - 1]!
    const next = log.log[round + 1]!
    for (let seat = 0; seat < 4; seat += 1) {
      const lockKey = `score:${round + 1}:${seat}`
      if (locked.has(lockKey)) continue
      const before = next[1][seat]!
      const after = final.scores[seat]!
      if (before === after) continue
      next[1][seat] = after
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'propagation',
        ref: { round: round + 1, section: 'deal', seat: seat as Seat, index: -1 },
        before,
        after,
        reason: `前局の点数台帳が変わったため、${next[0][0] + 1}局目の開始点へ差分を伝播`,
      })
    }
    const result = log.log[round]![16]
    const beforeSticks = next[0][2]
    const afterSticks = result[0] === '和了' ? 0 : final.riichiSticks
    if (beforeSticks !== afterSticks) {
      next[0][2] = afterSticks
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'propagation',
        ref: { round: round + 1, section: 'deal', index: -3 },
        before: beforeSticks,
        after: afterSticks,
        reason: '前局の終局種別とリーチ成立状況から供託本数を更新',
      })
    }
  }
}

function chooseChiCodes(called: TileCode, handCodes: TileCode[]): { codes: TileCode[]; calledIndex: number } | undefined {
  const normalized = normalizeTile(called)
  const suit = Math.floor(normalized / 10)
  const rank = normalized % 10
  if (suit > 3) return undefined
  const options: { codes: TileCode[]; calledIndex: number; missing: number }[] = []
  for (let start = Math.max(1, rank - 2); start <= Math.min(7, rank); start += 1) {
    const sequence = [start, start + 1, start + 2].map((number) => (suit * 10 + number) as TileCode)
    const calledIndex = rank - start
    const remaining = [...handCodes]
    let missing = 0
    sequence.forEach((code, index) => {
      if (index === calledIndex) return
      const found = remaining.findIndex((value) => sameTileKind(value, code))
      if (found >= 0) remaining.splice(found, 1)
      else missing += 1
    })
    options.push({ codes: sequence, calledIndex, missing })
  }
  return options
    .filter((option) => option.missing === 0)
    .sort((a, b) => a.calledIndex - b.calledIndex)[0]
}

function meldCalledIndex(type: MeldType, actor: Seat, target: Seat): number {
  if (type === 'chi') return 0
  const relative = (target - actor + 4) % 4
  if (type === 'daiminkan') return relative === 1 ? 3 : 3 - relative
  return 3 - relative
}

function findCallTarget(state: RoundState, actor: Seat, type: MeldType): { seat: Seat; tileId: string; code: TileCode } | undefined {
  const allowed = type === 'chi' ? [((actor + 3) % 4) as Seat] : ([1, 2, 3] as const).map((offset) => ((actor + offset) % 4) as Seat)
  const lastDiscard = state.lastDiscard
  if (!lastDiscard || !allowed.includes(lastDiscard.seat)) return undefined
  const river = state.rivers[lastDiscard.seat]![lastDiscard.riverIndex]
  if (!river || river.called) return undefined
  const candidates = [{
    seat: lastDiscard.seat,
    tileId: river.tileId,
    code: river.code,
    event: river.eventIndex,
  }]
  const handCodes = state.hands[actor]!.map((id) => state.tiles[id]!.code)
  return candidates
    .filter((candidate) => {
      if (type === 'chi') return Boolean(chooseChiCodes(candidate.code, handCodes))
      const count = handCodes.filter((code) => sameTileKind(code, candidate.code)).length
      return count >= (type === 'pon' ? 2 : 3)
    })
    .sort((a, b) => b.event - a.event)[0]
}

export function canAddMeldNaturally(state: RoundState, actor: Seat, type: MeldType): boolean {
  if (type === 'ankan') {
    const counts = new Map<number, number>()
    state.hands[actor]!.forEach((id) => {
      const kind = state.tiles[id]!.kind
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    })
    return [...counts.values()].some((count) => count >= 4)
  }
  if (type === 'kakan') {
    return state.melds[actor]!.some((meld) =>
      meld.type === 'pon'
      && state.hands[actor]!.some((id) => sameTileKind(state.tiles[id]!.code, meld.codes[0]!)))
  }
  return Boolean(findCallTarget(state, actor, type))
}

function clearReachMarkers(
  log: TenhouLog,
  round: number,
  actor: Seat,
  changes: AutoChange[],
  reason = '副露により門前条件を失うため、この局のリーチ宣言と1000点供託を解除',
): void {
  const stream = getRoundSection(log.log[round]!, 'discard', actor)
  for (let index = 0; index < stream.length; index += 1) {
    const before = stream[index]
    if (typeof before !== 'string' || !/^r(?:60|\d{2})$/.test(before)) continue
    const after = Number(before.slice(1))
    stream[index] = after
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: { round, section: 'discard', seat: actor, index },
      before,
      after,
      reason,
    })
  }
}

function forceHandCodes(
  log: TenhouLog,
  round: number,
  event: number,
  actor: Seat,
  needed: TileCode[],
  changes: AutoChange[],
  locked: Set<string>,
  reason: string,
  protectedRefs: Iterable<string> = [],
): { codes: TileCode[]; refs: string[] } | string {
  const reserved = new Set<string>()
  const protectedSet = new Set(protectedRefs)
  const codes: TileCode[] = []
  for (const desired of needed) {
    const replayed = replayRound(log, round)
    const state = snapshotAt(replayed, event)
    const hand = state.hands[actor]!
      .map((id) => state.tiles[id]!)
      .filter((tile) => !reserved.has(refKey(tile.acquisitionRef)))
    let tile = hand.find((candidate) => sameTileKind(candidate.code, desired))
    if (!tile) {
      tile = hand
        .filter((candidate) => !locked.has(refKey(candidate.acquisitionRef)))
        .sort((a, b) =>
          Number(b.origin === 'draw') - Number(a.origin === 'draw')
          || b.acquiredAt - a.acquiredAt
          || refKey(b.acquisitionRef).localeCompare(refKey(a.acquisitionRef)))[0]
      if (!tile) return `${tileLabel(desired)}へ差し替えられる未固定の手牌がありません`
      const complete = Object.values(replayed.snapshots.at(-1)!.tiles)
        .find((candidate) => refKey(candidate.acquisitionRef) === refKey(tile!.acquisitionRef))
        ?? tile
      const before = tile.code
      updatePhysicalTile(
        log,
        complete,
        desired,
        changes,
        'automatic',
        `${reason}。直近に取得した${tileLabel(before)}を${tileLabel(desired)}へ差し替え`,
      )
      const swapLocks = new Set([...locked, ...protectedSet, ...reserved])
      const conflict = repairFifthTiles(log, round, complete, before, desired, changes, swapLocks)
      if (conflict) return conflict
      const refreshed = replayRound(log, round)
      tile = Object.values(snapshotAt(refreshed, event).tiles)
        .find((candidate) => refKey(candidate.acquisitionRef) === refKey(complete.acquisitionRef))
      if (!tile || !sameTileKind(tile.code, desired)) return `${tileLabel(desired)}を手牌へ補充できません`
    }
    reserved.add(refKey(tile.acquisitionRef))
    protectedSet.add(refKey(tile.acquisitionRef))
    codes.push(tile.code)
  }
  return { codes, refs: [...reserved] }
}

function findForcedRiver(
  replayed: ReturnType<typeof replayRound>,
  request: Extract<EditRequest, { type: 'meld-add' }>,
  target?: Seat,
): { seat: Seat; event: number; tileId: string; ref: RawRef } | undefined {
  const final = replayed.snapshots.at(-1)!
  const seats = target === undefined
    ? ([0, 1, 2, 3] as Seat[]).filter((seat) => seat !== request.actor)
    : [target]
  return seats
    .flatMap((seat) => final.rivers[seat]!
      .filter((river) => !river.called)
      .map((river) => ({ seat, event: river.eventIndex, tileId: river.tileId, ref: river.rawRef })))
    .sort((a, b) => {
      const aFuture = a.event > request.event
      const bFuture = b.event > request.event
      if (aFuture !== bFuture) return Number(aFuture) - Number(bFuture)
      return aFuture ? a.event - b.event : b.event - a.event
    })[0]
}

function addKanDora(
  log: TenhouLog,
  round: number,
  state: RoundState,
  changes: AutoChange[],
  reason: string,
): void {
  const dora = log.log[round]![2]
  if (dora.length >= countKans(log.log[round]!) + 1) return
  const replacement = firstAvailableTile(state, log.rule)
  dora.push(replacement)
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'automatic',
    ref: { round, section: 'dora', index: dora.length - 1 },
    before: '',
    after: replacement,
    reason,
  })
}

function applyForcedOpenMeld(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-add' }>,
  changes: AutoChange[],
  locked: Set<string>,
  createKakan = false,
): string | undefined {
  const plan = request.forced!
  const replayed = replayRound(log, request.round)
  const target = request.meldType === 'chi'
    ? ((request.actor + 3) % 4) as Seat
    : createKakan
      ? undefined
      : plan.target
  const river = findForcedRiver(replayed, request, target)
  if (!river) return '選択地点の前後に、副露元として変更できる未使用の打牌がありません'
  const calledIndex = createKakan
    ? meldCalledIndex('pon', request.actor, river.seat)
    : request.meldType === 'chi'
      ? plan.calledIndex ?? 1
      : meldCalledIndex(request.meldType, request.actor, river.seat)
  const desiredCodes = createKakan
    ? Array<TileCode>(3).fill(plan.codes[0]!)
    : [...plan.codes]
  const calledCode = desiredCodes[calledIndex]
  if (!calledCode) return '副露する牌の指定が壊れています'
  const final = replayed.snapshots.at(-1)!
  const targetHand = forceHandCodes(
    log,
    request.round,
    Math.max(0, river.event - 1),
    river.seat,
    [calledCode],
    changes,
    locked,
    `${createKakan ? 'ポン' : meldLabelJa(request.meldType)}の副露元を作るため${final.names[river.seat]}の手牌を補正`,
  )
  if (typeof targetHand === 'string') return targetHand
  const beforeDiscard = readRawRef(log, river.ref)
  const afterDiscard: RawTile = typeof beforeDiscard === 'string' && beforeDiscard.startsWith('r')
    ? `r${calledCode}`
    : calledCode
  if (beforeDiscard !== afterDiscard) {
    writeRawRef(log, river.ref, afterDiscard)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: river.ref,
      before: beforeDiscard,
      after: afterDiscard,
      reason: `${final.names[river.seat]}の直近の未使用打牌を${tileLabel(calledCode)}へ変更して${createKakan ? 'ポン' : meldLabelJa(request.meldType)}の副露元を作成`,
    })
  }

  const needed = desiredCodes.filter((_, index) => index !== calledIndex)
  if (createKakan) needed.push(plan.codes[0]!)
  const forcedHand = forceHandCodes(
    log,
    request.round,
    river.event,
    request.actor,
    needed,
    changes,
    locked,
    `${createKakan ? '加槓の前提となるポン' : meldLabelJa(request.meldType)}を成立させるため手牌を補正`,
    targetHand.refs,
  )
  if (typeof forcedHand === 'string') return forcedHand
  const meldHandCodes = forcedHand.codes.slice(0, desiredCodes.length - 1)
  const encodedCodes: TileCode[] = []
  let handIndex = 0
  desiredCodes.forEach((code, index) => {
    encodedCodes.push(index === calledIndex ? calledCode : meldHandCodes[handIndex++] ?? code)
  })

  const refreshed = replayRound(log, request.round)
  const callState = snapshotAt(refreshed, river.event)
  const drawIndex = callState.streamCursors.draws[request.actor]!
  const drawStream = getRoundSection(log.log[request.round]!, 'draw', request.actor)
  const type = createKakan ? 'pon' : request.meldType
  const encoded = encodeMeld(type, encodedCodes, calledIndex)
  drawStream.splice(drawIndex, 0, encoded)
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: createKakan ? 'automatic' : 'manual',
    ref: { round: request.round, section: 'draw', seat: request.actor, index: drawIndex },
    before: '',
    after: encoded,
    reason: `${callState.names[request.actor]}が${callState.names[river.seat]}の${tileLabel(calledCode)}を${meldLabelJa(type)}${createKakan ? 'し、加槓の前提を作成' : ''}`,
  })
  clearReachMarkers(log, request.round, request.actor, changes)

  if (type === 'chi' || type === 'pon') {
    const replaced = drawStream[drawIndex + 1]
    if (typeof replaced === 'number') {
      drawStream.splice(drawIndex + 1, 1)
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round: request.round, section: 'draw', seat: request.actor, index: drawIndex + 1 },
        before: replaced,
        after: '',
        reason: `${meldLabelJa(type)}により通常ツモが発生しなくなったため、以後のツモを前へ再配置`,
      })
    }
    const discardIndex = callState.streamCursors.discards[request.actor]!
    const discardStream = getRoundSection(log.log[request.round]!, 'discard', request.actor)
    const immediate = discardStream[discardIndex]
    const reservedForMeld = new Set(forcedHand.refs.slice(0, desiredCodes.length - 1))
    if (createKakan) reservedForMeld.add(forcedHand.refs.at(-1)!)
    const remainingCodes = callState.hands[request.actor]!
      .map((id) => callState.tiles[id]!)
      .filter((tile) => !reservedForMeld.has(refKey(tile.acquisitionRef)))
      .map((tile) => tile.code)
      .sort(tileSort)
    const explicit = typeof immediate === 'string' ? Number(immediate.replace('r', '')) : immediate
    const reserveKind = createKakan ? normalizeTile(plan.codes[0]!) : undefined
    const validImmediate = remainingCodes.some((code) =>
      sameTileKind(code, Number(explicit))
      && (reserveKind === undefined || normalizeTile(code) !== reserveKind))
    if (explicit === 60 || !validImmediate) {
      const replacement = remainingCodes.find((code) => reserveKind === undefined || normalizeTile(code) !== reserveKind)
        ?? remainingCodes[0]
      if (!replacement) return '副露直後に打牌できる手牌がありません'
      discardStream[discardIndex] = replacement
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round: request.round, section: 'discard', seat: request.actor, index: discardIndex },
        before: immediate!,
        after: replacement,
        reason: `${meldLabelJa(type)}直後の打牌を、保持している${tileLabel(replacement)}へ変更`,
      })
    }
    if (createKakan) {
      const reserve = forcedHand.codes.at(-1)!
      const kakanCodes = [...encodedCodes, reserve]
      const kakan = encodeMeld('kakan', kakanCodes, calledIndex)
      discardStream.splice(discardIndex + 1, 0, kakan)
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'manual',
        ref: { round: request.round, section: 'discard', seat: request.actor, index: discardIndex + 1 },
        before: '',
        after: kakan,
        reason: `作成した${tileLabel(reserve)}のポンへ4枚目を加えて加槓`,
      })
      addKanDora(log, request.round, callState, changes, '加槓によりカンドラ表示牌を未確定王牌から決定')
    }
  }
  if (type === 'daiminkan') {
    addKanDora(log, request.round, callState, changes, '大明槓によりカンドラ表示牌を未確定王牌から決定')
  }
  repairActorFutureDiscards(log, request.round, request.actor, changes)
  return undefined
}

function actorDiscardPoint(
  replayed: ReturnType<typeof replayRound>,
  actor: Seat,
  event: number,
): { eventBefore: number; index: number } | undefined {
  const candidates = replayed.events
    .filter((candidate) => candidate.type === 'discard' && candidate.actor === actor && candidate.rawRef)
    .map((candidate) => ({ event: candidate.index, index: candidate.rawRef!.index }))
  const picked = candidates.find((candidate) => candidate.event >= event) ?? candidates.at(-1)
  return picked ? { eventBefore: Math.max(0, picked.event - 1), index: picked.index } : undefined
}

function applyForcedAnkan(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-add' }>,
  changes: AutoChange[],
  locked: Set<string>,
): string | undefined {
  const replayed = replayRound(log, request.round)
  const point = actorDiscardPoint(replayed, request.actor, request.event)
  if (!point) return '暗槓を挿入できる打牌地点がありません'
  const code = request.forced!.codes[0]
  if (!code) return '暗槓する牌が指定されていません'
  const forced = forceHandCodes(
    log,
    request.round,
    point.eventBefore,
    request.actor,
    Array<TileCode>(4).fill(code),
    changes,
    locked,
    '暗槓を成立させるため手牌を補正',
  )
  if (typeof forced === 'string') return forced
  const encoded = encodeMeld('ankan', forced.codes, 3)
  const stream = getRoundSection(log.log[request.round]!, 'discard', request.actor)
  stream.splice(point.index, 0, encoded)
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'manual',
    ref: { round: request.round, section: 'discard', seat: request.actor, index: point.index },
    before: '',
    after: encoded,
    reason: `${tileLabel(code)}4枚の手牌を作り暗槓`,
  })
  addKanDora(log, request.round, snapshotAt(replayRound(log, request.round), point.eventBefore), changes, '暗槓によりカンドラ表示牌を未確定王牌から決定')
  repairActorFutureDiscards(log, request.round, request.actor, changes)
  return undefined
}

function applyForcedKakan(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-add' }>,
  changes: AutoChange[],
  locked: Set<string>,
): string | undefined {
  const code = request.forced!.codes[0]
  if (!code) return '加槓する牌が指定されていません'
  let replayed = replayRound(log, request.round)
  const selected = snapshotAt(replayed, request.event)
  const existing = selected.melds[request.actor]!.find((meld) =>
    meld.type === 'pon' && sameTileKind(meld.codes[0]!, code))
  if (!existing) return applyForcedOpenMeld(log, request, changes, locked, true)
  const point = actorDiscardPoint(replayed, request.actor, request.event)
  if (!point) return '加槓を挿入できる打牌地点がありません'
  const forced = forceHandCodes(
    log,
    request.round,
    point.eventBefore,
    request.actor,
    [code],
    changes,
    locked,
    '加槓の4枚目を用意するため手牌を補正',
  )
  if (typeof forced === 'string') return forced
  replayed = replayRound(log, request.round)
  const beforeState = snapshotAt(replayed, point.eventBefore)
  const pon = beforeState.melds[request.actor]!.find((meld) =>
    meld.type === 'pon' && sameTileKind(meld.codes[0]!, code))
  if (!pon) return '選択したポンが加槓地点より前にありません'
  const encoded = encodeMeld('kakan', [...pon.codes, forced.codes[0]!], pon.calledIndex ?? 0)
  const stream = getRoundSection(log.log[request.round]!, 'discard', request.actor)
  stream.splice(point.index, 0, encoded)
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'manual',
    ref: { round: request.round, section: 'discard', seat: request.actor, index: point.index },
    before: '',
    after: encoded,
    reason: `${tileLabel(code)}のポンへ補正した4枚目を加えて加槓`,
  })
  addKanDora(log, request.round, beforeState, changes, '加槓によりカンドラ表示牌を未確定王牌から決定')
  repairActorFutureDiscards(log, request.round, request.actor, changes)
  return undefined
}

function repairActorFutureDiscards(
  log: TenhouLog,
  round: number,
  actor: Seat,
  changes: AutoChange[],
): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const replayed = replayRound(log, round)
    const issue = replayed.diagnostics.find((diagnostic) =>
      diagnostic.code === 'TILE_NOT_IN_HAND'
      && diagnostic.seat === actor
      && diagnostic.ref?.section === 'discard')
    if (!issue?.ref) return
    const event = replayed.events.find((candidate) =>
      candidate.type === 'discard'
      && candidate.rawRef
      && refKey(candidate.rawRef) === refKey(issue.ref!))
    if (event?.tile === undefined) return
    const before = readRawRef(log, issue.ref)
    const after = event.tile
    if (before === after) return
    writeRawRef(log, issue.ref, after)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: issue.ref,
      before,
      after,
      reason: `副露で手牌構成が変わったため、後続の不可能な打牌を保持している${tileLabel(after)}へ差し替え`,
    })
  }
}

function repairBrokenFutureMelds(
  log: TenhouLog,
  round: number,
  changes: AutoChange[],
  requested?: Extract<EditRequest, { type: 'meld-add' }>,
): void {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const replayed = replayRound(log, round)
    const issue = replayed.diagnostics.find((diagnostic) =>
      (diagnostic.code === 'MELD_TILE_MISSING' || diagnostic.code === 'INVALID_KAKAN')
      && diagnostic.ref
      && diagnostic.ref.index >= 0)
    if (!issue?.ref) return
    const stream = getRoundSection(log.log[round]!, issue.ref.section, issue.ref.seat)
    const before = stream[issue.ref.index]
    if (typeof before !== 'string') return
    const parsed = parseMeldString(before)
    if (!parsed) return
    if (
      requested?.forced
      && parsed.type === requested.meldType
      && parsed.codes.length === requested.forced.codes.length
      && parsed.codes.every((code, index) => sameTileKind(code, requested.forced!.codes[index]!))
    ) return
    stream.splice(issue.ref.index, 1)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: issue.ref,
      before,
      after: '',
      reason: `新しい副露で手順が変わり成立しなくなった将来の${meldLabelJa(parsed.type)}を解除し、通常手番へ復元`,
    })
    if (['daiminkan', 'ankan', 'kakan'].includes(parsed.type) && log.log[round]![2].length > 1) {
      const dora = log.log[round]![2]
      const removed = dora.pop()!
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round, section: 'dora', index: dora.length },
        before: removed,
        after: '',
        reason: '成立しなくなった槓の解除に合わせてカンドラ表示牌を王牌へ戻す',
      })
    }
  }
}

function forcedMeldExists(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-add' }>,
): boolean {
  const final = replayRound(log, request.round).snapshots.at(-1)!
  const desired = request.forced!.codes
  return final.melds[request.actor]!.some((meld) =>
    meld.type === request.meldType
    && meld.codes.length === desired.length
    && meld.codes.every((code, index) => sameTileKind(code, desired[index]!)))
}

function applyMeldAdd(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-add' }>,
  changes: AutoChange[],
  locked: Set<string>,
): string | undefined {
  if (request.forced) {
    if (request.meldType === 'ankan') return applyForcedAnkan(log, request, changes, locked)
    if (request.meldType === 'kakan') return applyForcedKakan(log, request, changes, locked)
    return applyForcedOpenMeld(log, request, changes, locked)
  }
  const replayed = replayRound(log, request.round)
  const state = snapshotAt(replayed, request.event)
  if (request.meldType === 'kakan') {
    const pon = state.melds[request.actor]!.find((meld) =>
      meld.type === 'pon' && state.hands[request.actor]!.some((id) => sameTileKind(state.tiles[id]!.code, meld.codes[0]!)))
    if (!pon) return '加槓できるポンと4枚目の手牌がありません'
    return applyMeldChange(log, {
      type: 'meld-change',
      round: request.round,
      event: request.event,
      actor: request.actor,
      meldId: pon.id,
      meldType: 'kakan',
    }, changes)
  }
  if (request.meldType === 'ankan') {
    const groups = new Map<number, string[]>()
    for (const id of state.hands[request.actor]!) {
      const kind = state.tiles[id]!.kind
      groups.set(kind, [...(groups.get(kind) ?? []), id])
    }
    const ids = [...groups.values()]
      .filter((items) => items.length >= 4)
      .sort((a, b) => state.tiles[a[0]!]!.code - state.tiles[b[0]!]!.code)[0]
    if (!ids) return '暗槓できる同種牌4枚が手牌にありません'
    const codes = ids.slice(0, 4).map((id) => state.tiles[id]!.code)
    const encoded = encodeMeld('ankan', codes, 3)
    const discardIndex = state.streamCursors.discards[request.actor]!
    const stream = getRoundSection(log.log[request.round]!, 'discard', request.actor)
    stream.splice(discardIndex, 0, encoded)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'manual',
      ref: { round: request.round, section: 'discard', seat: request.actor, index: discardIndex },
      before: '',
      after: encoded,
      reason: `${state.names[request.actor]}の${tileLabel(codes[0]!)}4枚を暗槓`,
    })
    const dora = log.log[request.round]![2]
    if (dora.length < countKans(log.log[request.round]!) + 1) {
      const replacement = firstAvailableTile(state, log.rule)
      dora.push(replacement)
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round: request.round, section: 'dora', index: dora.length - 1 },
        before: '',
        after: replacement,
        reason: '暗槓によりカンドラ表示牌を未確定王牌から決定',
      })
    }
    return undefined
  }
  const target = findCallTarget(state, request.actor, request.meldType)
  if (!target) return `${request.meldType === 'chi' ? '上家の河と手牌で作れる順子' : '河牌と必要な同種牌'}がありません`
  const handIds = [...state.hands[request.actor]!]
  const handCodes = handIds.map((id) => state.tiles[id]!.code)
  let codes: TileCode[]
  let calledIndex: number
  if (request.meldType === 'chi') {
    const choice = chooseChiCodes(target.code, handCodes)!
    codes = choice.codes
    calledIndex = choice.calledIndex
  } else {
    const total = request.meldType === 'pon' ? 3 : 4
    calledIndex = meldCalledIndex(request.meldType, request.actor, target.seat)
    codes = Array<TileCode>(total).fill(normalizeTile(target.code) as TileCode)
    codes[calledIndex] = target.code
  }
  const needed = codes.filter((_, index) => index !== calledIndex)
  const remainingIds = [...handIds]
  for (const code of needed) {
    const found = remainingIds.findIndex((id) => sameTileKind(state.tiles[id]!.code, code))
    if (found < 0) return `${tileLabel(code)}が手牌にないため${meldLabelJa(request.meldType)}を構成できません`
    const [id] = remainingIds.splice(found, 1)
    const actual = state.tiles[id!]!.code
    const codeIndex = codes.findIndex((value, index) => index !== calledIndex && sameTileKind(value, code) && value !== actual)
    if (codeIndex >= 0 && isRed(actual)) codes[codeIndex] = actual
  }
  const drawIndex = state.streamCursors.draws[request.actor]!
  const drawStream = getRoundSection(log.log[request.round]!, 'draw', request.actor)
  const encoded = encodeMeld(request.meldType, codes, calledIndex)
  drawStream.splice(drawIndex, 0, encoded)
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'manual',
    ref: { round: request.round, section: 'draw', seat: request.actor, index: drawIndex },
    before: '',
    after: encoded,
    reason: `${state.names[request.actor]}が${state.names[target.seat]}の${tileLabel(target.code)}を${meldLabelJa(request.meldType)}`,
  })
  clearReachMarkers(log, request.round, request.actor, changes)
  if (request.meldType === 'chi' || request.meldType === 'pon') {
    const replaced = drawStream[drawIndex + 1]
    if (typeof replaced === 'number') {
      drawStream.splice(drawIndex + 1, 1)
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round: request.round, section: 'draw', seat: request.actor, index: drawIndex + 1 },
        before: replaced,
        after: '',
        reason: `${meldLabelJa(request.meldType)}により通常ツモが発生しなくなったため、以後のツモを前へ再配置`,
      })
    }
    const discardIndex = state.streamCursors.discards[request.actor]!
    const discardStream = getRoundSection(log.log[request.round]!, 'discard', request.actor)
    const immediate = discardStream[discardIndex]
    const remainingCodes = remainingIds.map((id) => state.tiles[id]!.code).sort(tileSort)
    const explicit = typeof immediate === 'string' ? Number(immediate.replace('r', '')) : immediate
    if (explicit === 60 || !remainingCodes.some((code) => sameTileKind(code, Number(explicit)))) {
      const replacement = remainingCodes[0]
      if (!replacement) return '副露直後に打牌できる手牌がありません'
      discardStream[discardIndex] = replacement
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round: request.round, section: 'discard', seat: request.actor, index: discardIndex },
        before: immediate!,
        after: replacement,
        reason: `${meldLabelJa(request.meldType)}直後は通常ツモがないため、保持している${tileLabel(replacement)}を手出しに変更`,
      })
    }
  }
  if (request.meldType === 'daiminkan') {
    const dora = log.log[request.round]![2]
    if (dora.length < countKans(log.log[request.round]!) + 1) {
      const replacement = firstAvailableTile(replayed.snapshots.at(-1)!, log.rule)
      dora.push(replacement)
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round: request.round, section: 'dora', index: dora.length - 1 },
        before: '',
        after: replacement,
        reason: '槓の追加によりカンドラ表示牌を未確定王牌から決定',
      })
    }
  }
  repairActorFutureDiscards(log, request.round, request.actor, changes)
  return undefined
}

function applyMeldRemove(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-remove' }>,
  changes: AutoChange[],
): string | undefined {
  const replayed = replayRound(log, request.round)
  const state = snapshotAt(replayed, request.event)
  const meld = state.melds[request.actor]!.find((value) => value.id === request.meldId)
  if (!meld) return '指定された副露が現在の巡目にありません'
  const stream = getRoundSection(log.log[request.round]!, meld.rawRef.section, meld.rawRef.seat)
  const before = stream[meld.rawRef.index]
  stream.splice(meld.rawRef.index, 1)
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'manual',
    ref: meld.rawRef,
    before: before!,
    after: '',
    reason: `${state.names[request.actor]}の${meldLabelJa(meld.type)}を削除し、通常手番へ復元`,
  })
  if (['daiminkan', 'ankan', 'kakan'].includes(meld.type) && log.log[request.round]![2].length > 1) {
    const dora = log.log[request.round]![2]
    const removed = dora.pop()!
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: { round: request.round, section: 'dora', index: dora.length },
      before: removed,
      after: '',
      reason: '槓の削除により対応するカンドラ表示を王牌へ戻す',
    })
  }
  return undefined
}

function applyMeldChange(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-change' }>,
  changes: AutoChange[],
): string | undefined {
  const replayed = replayRound(log, request.round)
  const state = snapshotAt(replayed, request.event)
  const meld = state.melds[request.actor]!.find((value) => value.id === request.meldId)
  if (!meld) return '変更する副露がありません'
  if (meld.type === request.meldType) return undefined
  if (meld.type === 'pon' && request.meldType === 'kakan') {
    const handId = state.hands[request.actor]!.find((id) => sameTileKind(state.tiles[id]!.code, meld.codes[0]!))
    if (!handId) return '加槓に必要な4枚目を手牌に持っていません'
    const added = state.tiles[handId]!.code
    const codes = [...meld.codes, added]
    const encoded = encodeMeld('kakan', codes, meld.calledIndex ?? 0)
    const discardIndex = state.streamCursors.discards[request.actor]!
    const stream = getRoundSection(log.log[request.round]!, 'discard', request.actor)
    stream.splice(discardIndex, 0, encoded)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'manual',
      ref: { round: request.round, section: 'discard', seat: request.actor, index: discardIndex },
      before: '',
      after: encoded,
      reason: `${state.names[request.actor]}のポンを4枚目の${tileLabel(added)}で加槓`,
    })
    const dora = log.log[request.round]![2]
    if (dora.length < countKans(log.log[request.round]!) + 1) {
      const replacement = firstAvailableTile(state, log.rule)
      dora.push(replacement)
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round: request.round, section: 'dora', index: dora.length - 1 },
        before: '',
        after: replacement,
        reason: '加槓によりカンドラ表示牌を未確定王牌から決定',
      })
    }
    return undefined
  }
  return 'この種類変更は手順を合法に保てません。ポンから加槓、または削除後の再追加を利用してください'
}

function countKans(round: TenhouLog['log'][number]): number {
  let count = 0
  for (let seat = 0; seat < 4; seat += 1) {
    for (const section of [5 + seat * 3, 6 + seat * 3]) {
      for (const item of round[section] as RawTile[]) {
        if (typeof item !== 'string') continue
        const parsed = parseMeldString(item)
        if (parsed && ['daiminkan', 'ankan', 'kakan'].includes(parsed.type)) count += 1
      }
    }
  }
  return count
}

function firstAvailableTile(state: RoundState, rule: Record<string, unknown>): TileCode {
  const counts = new Map<number, number>()
  for (const tile of Object.values(state.tiles)) counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1)
  const aka = Number(rule.aka ?? 1)
  return ALL_TILE_CODES.find((code) => {
    if (isRed(code) && !aka) return false
    return (counts.get(normalizeTile(code)) ?? 0) < 4
  }) ?? 11
}

function meldLabelJa(type: MeldType): string {
  return { chi: 'チー', pon: 'ポン', daiminkan: '大明槓', ankan: '暗槓', kakan: '加槓' }[type]
}

function applyReach(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'reach' }>,
  changes: AutoChange[],
): string | undefined {
  const replayed = replayRound(log, request.round)
  const state = snapshotAt(replayed, request.event)
  const stream = getRoundSection(log.log[request.round]!, 'discard', request.actor)
  let index = state.streamCursors.discards[request.actor]! - 1
  if (index < 0) index = 0
  while (index < stream.length && typeof stream[index] === 'string' && parseMeldString(stream[index] as string)) index += 1
  const before = stream[index]
  if (before === undefined) return 'リーチを設定できる打牌がありません'
  if (request.enabled) {
    const open = state.melds[request.actor]!.some((meld) => meld.type !== 'ankan')
    if (open) return '門前ではないためリーチを設定できません'
    const handCodes = state.hands[request.actor]!.map((id) => state.tiles[id]!.code)
    if (!isTenpai(handCodes, state.melds[request.actor]!.length)) return '現在の手牌が聴牌していないためリーチを設定できません'
    if (state.scores[request.actor]! < 1000) return '1000点未満のためリーチ棒を支払えません'
    if (typeof before === 'string' && before.startsWith('r')) return undefined
    stream[index] = `r${before}`
  } else {
    if (typeof before !== 'string' || !before.startsWith('r')) return undefined
    stream[index] = Number(before.slice(1))
  }
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'manual',
    ref: { round: request.round, section: 'discard', seat: request.actor, index },
    before,
    after: stream[index]!,
    reason: request.enabled ? '門前・聴牌・持ち点を確認してリーチを設定' : 'リーチ宣言を解除',
  })
  return undefined
}

function applyScore(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'score' }>,
  changes: AutoChange[],
): string | undefined {
  if (!Number.isInteger(request.score) || request.score < 0 || request.score > 999_000) return '開始点は0〜999000の整数で入力してください'
  const before = log.log[request.round]![1][request.seat]!
  log.log[request.round]![1][request.seat] = request.score
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'manual',
    ref: { round: request.round, section: 'deal', seat: request.seat, index: -1 },
    before,
    after: request.score,
    reason: `局開始点を${request.score}点に固定`,
  })
  return undefined
}

function xorshift(seed: number): () => number {
  let value = seed || 0x9e3779b9
  return () => {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    return (value >>> 0) / 0x1_0000_0000
  }
}

function convertBrokenWinToDraw(
  log: TenhouLog,
  round: number,
  seed: number,
  changes: AutoChange[],
): void {
  const replayed = replayRound(log, round)
  const winEvent = replayed.events.findIndex((event) => event.type === 'ron' || event.type === 'tsumo-win')
  const state = winEvent > 0 ? replayed.snapshots[winEvent - 1]! : replayed.snapshots.at(-1)!
  for (let player = 0; player < 4; player += 1) {
    const seat = player as Seat
    const sections = [
      ['draw', state.streamCursors.draws[seat]!] as const,
      ['discard', state.streamCursors.discards[seat]!] as const,
    ]
    for (const [section, cursor] of sections) {
      const stream = getRoundSection(log.log[round]!, section, seat)
      if (cursor >= stream.length) continue
      const removed = stream.splice(cursor)
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round, section, seat, index: cursor },
        before: JSON.stringify(removed),
        after: '',
        reason: '手順変更で到達不能になった終局後のイベントを牌山へ戻してから流局手順を再構成',
      })
    }
  }
  const pool: TileCode[] = []
  const exactCounts = new Map<number, number>()
  for (const tile of Object.values(state.tiles)) exactCounts.set(tile.code, (exactCounts.get(tile.code) ?? 0) + 1)
  for (let kind = 0; kind < 34; kind += 1) {
    const base = kind < 27
      ? (Math.floor(kind / 9) * 10 + 11 + kind % 9) as TileCode
      : (41 + kind - 27) as TileCode
    const red = (kind === 4 ? 51 : kind === 13 ? 52 : kind === 22 ? 53 : undefined) as TileCode | undefined
    const redAllowed = red ? Number(log.rule[`aka${red}`] ?? log.rule.aka ?? 1) : 0
    const observedRed = red ? (exactCounts.get(red) ?? 0) : 0
    for (let index = observedRed; index < redAllowed; index += 1) pool.push(red!)
    const observedNormal = exactCounts.get(base) ?? 0
    for (let index = observedNormal + Math.max(observedRed, redAllowed); index < 4; index += 1) pool.push(base)
  }
  const random = xorshift(seed + round * 7919)
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[pool[index], pool[target]] = [pool[target]!, pool[index]!]
  }
  let seat = state.lastDiscard ? ((state.lastDiscard.seat + 1) % 4) as Seat : state.dealer
  let generated = 0
  while (generated < state.wallRemaining && pool.length) {
    const code = pool.pop()!
    const draws = getRoundSection(log.log[round]!, 'draw', seat)
    const discards = getRoundSection(log.log[round]!, 'discard', seat)
    draws.push(code)
    discards.push(60)
    generated += 1
    seat = ((seat + 1) % 4) as Seat
  }
  const extended = replayRound(log, round)
  const final = extended.snapshots.at(-1)!
  const ready = tenpaiSeats(final)
  const delta = exhaustiveDrawDelta(ready)
  const before = log.log[round]![16]
  log.log[round]![16] = ['流局', delta]
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'automatic',
    ref: { round, section: 'discard', index: -1 },
    before: JSON.stringify(before),
    after: JSON.stringify(log.log[round]![16]),
    reason: `和了形が成立しなくなったため、乱数シード${seed}で残り${generated}巡の牌山を補完し、${ready.length}人聴牌の流局へ変更`,
  })
}

export function solveEdit(
  input: TenhouLog,
  request: EditRequest,
  options: { lockedRefs?: Iterable<string>; seed?: number } = {},
): SolverResult {
  const locked = new Set(options.lockedRefs)
  const seed = options.seed ?? 20260726
  const baseline = decodeMatch(input)
  const baselineErrors = new Set(baseline.diagnostics.filter(isHardError).map(diagnosticKey))
  const output = cloneLog(input)
  const changes: AutoChange[] = []
  let conflict: string | undefined

  try {
    if (request.type === 'tile') {
      const sourceRound = baseline.rounds[request.round]
      if (!sourceRound) conflict = '指定された局がありません'
      else {
        const state = snapshotAt(sourceRound, request.event)
        const trace = state.tiles[request.tileId]
        if (!trace) conflict = '指定された物理牌が現在の盤面にありません'
        else if (locked.has(refKey(trace.acquisitionRef))) conflict = 'この牌の取得元は固定されています'
        else {
          const completeTrace = Object.values(sourceRound.snapshots.at(-1)!.tiles)
            .find((candidate) => refKey(candidate.acquisitionRef) === refKey(trace.acquisitionRef))
            ?? trace
          const oldCode = trace.code
          updatePhysicalTile(
            output,
            completeTrace,
            request.code,
            changes,
            'manual',
            `${locationLabel(trace.location)}の${tileLabel(oldCode)}を${tileLabel(request.code)}へ変更。表示だけでなく${trace.origin === 'deal' ? '配牌' : trace.origin === 'draw' ? '取得ツモ' : '表示牌'}まで遡及`,
          )
          conflict = repairFifthTiles(output, request.round, completeTrace, oldCode, request.code, changes, locked)
        }
      }
    } else if (request.type === 'meld-add') {
      conflict = applyMeldAdd(output, request, changes, locked)
    } else if (request.type === 'meld-remove') {
      conflict = applyMeldRemove(output, request, changes)
    } else if (request.type === 'meld-change') {
      conflict = applyMeldChange(output, request, changes)
    } else if (request.type === 'reach') {
      conflict = applyReach(output, request, changes)
    } else {
      conflict = applyScore(output, request, changes)
    }
    if (conflict) return { ok: false, changes: [], diagnostics: [], conflict }
    if (request.type === 'meld-add' && request.forced) {
      repairBrokenFutureMelds(output, request.round, changes, request)
      ;([0, 1, 2, 3] as Seat[]).forEach((seat) =>
        repairActorFutureDiscards(output, request.round, seat, changes))
      if (!forcedMeldExists(output, request)) {
        return {
          ok: false,
          changes: [],
          diagnostics: [],
          conflict: '後続手順を補正しても、指定した副露を維持できません',
        }
      }
    }

    let candidate = decodeMatch(output)
    const invalidatedReachSeats = new Set(candidate.diagnostics
      .filter((diagnostic) =>
        diagnostic.round === request.round
        && (diagnostic.code === 'REACH_NOT_TENPAI' || diagnostic.code === 'OPEN_REACH')
        && !baselineErrors.has(diagnosticKey(diagnostic))
        && diagnostic.seat !== undefined)
      .map((diagnostic) => diagnostic.seat!))
    for (const seat of invalidatedReachSeats) {
      clearReachMarkers(
        output,
        request.round,
        seat,
        changes,
        '編集によりリーチ成立時の門前・聴牌条件を失ったため、リーチ宣言と1000点供託を解除',
      )
    }
    if (invalidatedReachSeats.size) candidate = decodeMatch(output)
    const introducedInvalidWin = candidate.diagnostics.some((diagnostic) =>
      diagnostic.round === request.round
      && diagnostic.code === 'INVALID_WIN_SHAPE'
      && !baseline.diagnostics.some((base) => diagnosticKey(base) === diagnosticKey(diagnostic)))
    if (introducedInvalidWin) {
      convertBrokenWinToDraw(output, request.round, seed, changes)
      candidate = decodeMatch(output)
    }
    propagateScores(output, request.round, changes, locked)
    candidate = decodeMatch(output)
    const newErrors = candidate.diagnostics.filter((diagnostic) =>
      isHardError(diagnostic)
      && !baselineErrors.has(diagnosticKey(diagnostic))
      && !(
        request.type === 'score'
        && diagnostic.code === 'SCORE_DISCONTINUITY'
        && diagnostic.round === request.round - 1
      ))
    if (newErrors.length) {
      return {
        ok: false,
        changes: [],
        diagnostics: newErrors,
        conflict: `自動補正後も矛盾が残るため適用しません: ${newErrors[0]!.message}`,
      }
    }
    return { ok: true, output, changes, diagnostics: candidate.diagnostics }
  } catch (error) {
    return {
      ok: false,
      changes: [],
      diagnostics: [],
      conflict: error instanceof Error ? error.message : String(error),
    }
  }
}
