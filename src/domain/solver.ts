import {
  cloneLog,
  encodeMeld,
  getRoundSection,
  parseMeldString,
  readRawRef,
  refKey,
  writeRawRef,
} from './codec'
import { isTenpai, shanten } from './hand'
import { evaluateWin } from './majiangAdapter'
import { decodeMatch, replayRound, snapshotAt } from './replay'
import { exhaustiveDrawDelta } from './scoring'
import {
  ALL_TILE_CODES,
  indexToTileCode,
  isRed,
  normalizeTile,
  sameTileKind,
  tileCodeLimit,
  tileLabel,
  tileSort,
} from './tile'
import { tenpaiSeats } from './validator'
import type {
  AutoChange,
  Diagnostic,
  EditRequest,
  Meld,
  MeldType,
  NormalizedEvent,
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

interface MeldTileEditResult {
  handled: boolean
  conflict?: string
  protectedRefs: string[]
}

function closestSequenceForEdit(
  meld: Meld,
  editedTileId: string,
  requestedCode: TileCode,
): { codes: TileCode[]; calledIndex: number; tileIds: string[] } | undefined {
  const requestedKind = normalizeTile(requestedCode)
  const suit = Math.floor(requestedKind / 10)
  const rank = requestedKind % 10
  if (suit > 3) return undefined

  const calledTileId = meld.tileIds[meld.calledIndex ?? 0]
  const calledOldKind = normalizeTile(meld.codes[meld.calledIndex ?? 0]!)
  const candidates: {
    codes: TileCode[]
    calledIndex: number
    tileIds: string[]
    cost: number
  }[] = []

  for (let start = Math.max(1, rank - 2); start <= Math.min(7, rank); start += 1) {
    const codes = [start, start + 1, start + 2]
      .map((value) => (suit * 10 + value) as TileCode)
    const editedIndex = rank - start
    const calledOptions = editedTileId === calledTileId
      ? [editedIndex]
      : codes
        .map((code, index) => ({ code, index }))
        .filter(({ code, index }) => index !== editedIndex && normalizeTile(code) === calledOldKind)
        .map(({ index }) => index)
    for (const calledIndex of calledOptions) {
      const remainingIds = meld.tileIds.filter((id) => id !== editedTileId && id !== calledTileId)
      const tileIds = Array<string>(3)
      tileIds[editedIndex] = editedTileId
      tileIds[calledIndex] = calledTileId!
      let remainingIndex = 0
      for (let index = 0; index < tileIds.length; index += 1) {
        if (!tileIds[index]) tileIds[index] = remainingIds[remainingIndex++]!
      }
      const oldStart = Math.min(...meld.codes.map(normalizeTile).map((code) => code % 10))
      const changedKinds = tileIds.reduce((total, id, index) => {
        const oldIndex = meld.tileIds.indexOf(id)
        return total + Number(normalizeTile(meld.codes[oldIndex]!) !== normalizeTile(codes[index]!))
      }, 0)
      candidates.push({
        codes,
        calledIndex,
        tileIds,
        cost: changedKinds * 100 + Math.abs(start - oldStart),
      })
    }
  }

  return candidates.sort((a, b) => a.cost - b.cost || a.calledIndex - b.calledIndex)[0]
}

function applyMeldAwareTileEdit(
  log: TenhouLog,
  state: RoundState,
  selectedTrace: TileTrace,
  completeTrace: TileTrace,
  requestedCode: TileCode,
  changes: AutoChange[],
  locked: Set<string>,
): MeldTileEditResult {
  const meld = state.melds
    .flat()
    .find((candidate) => candidate.tileIds.includes(completeTrace.id))
  if (!meld) return { handled: false, protectedRefs: [] }

  const editedIndex = meld.tileIds.indexOf(completeTrace.id)
  const calledTileId = meld.tileIds[meld.calledIndex ?? 0]
  let type = meld.type
  let calledIndex = meld.calledIndex ?? 0
  let tileIds = [...meld.tileIds]
  let codes: TileCode[]

  if (meld.type === 'chi') {
    const sequence = closestSequenceForEdit(meld, completeTrace.id, requestedCode)
    if (sequence) {
      tileIds = sequence.tileIds
      calledIndex = sequence.calledIndex
      codes = sequence.codes
      codes[tileIds.indexOf(completeTrace.id)] = requestedCode
    } else {
      type = 'pon'
      const target = meld.target
      if (target === undefined) {
        return {
          handled: true,
          conflict: 'チーの副露元を特定できないため、合法な形へ補正できません',
          protectedRefs: [],
        }
      }
      calledIndex = meldCalledIndex('pon', meld.actor, target)
      const otherIds = meld.tileIds.filter((id) => id !== calledTileId)
      tileIds = Array<string>(3)
      tileIds[calledIndex] = calledTileId!
      let otherIndex = 0
      for (let index = 0; index < tileIds.length; index += 1) {
        if (!tileIds[index]) tileIds[index] = otherIds[otherIndex++]!
      }
      const normal = normalCodeForKind(normalizeTile(requestedCode))!
      codes = Array<TileCode>(3).fill(normal)
      codes[tileIds.indexOf(completeTrace.id)] = requestedCode
    }
  } else {
    const normal = normalCodeForKind(normalizeTile(requestedCode))!
    codes = Array<TileCode>(meld.tileIds.length).fill(normal)
    codes[editedIndex] = requestedCode
  }

  const protectedRefs = tileIds.map((id) => refKey(state.tiles[id]!.acquisitionRef))
  for (let index = 0; index < tileIds.length; index += 1) {
    const trace = state.tiles[tileIds[index]!]!
    const code = codes[index]!
    if (
      locked.has(refKey(trace.acquisitionRef))
      && trace.code !== code
    ) {
      return {
        handled: true,
        conflict: `${tileLabel(trace.code)}の取得元が固定されているため、副露全体を${tileLabel(requestedCode)}に合わせられません`,
        protectedRefs,
      }
    }
  }

  const ordered = [
    completeTrace.id,
    ...tileIds.filter((id) => id !== completeTrace.id),
  ]
  for (const id of ordered) {
    const index = tileIds.indexOf(id)
    const trace = state.tiles[id]!
    const code = codes[index]!
    const isSelected = id === completeTrace.id
    updatePhysicalTile(
      log,
      trace,
      code,
      changes,
      isSelected ? 'manual' : 'automatic',
      isSelected
        ? `${locationLabel(selectedTrace.location)}の${tileLabel(selectedTrace.code)}を${tileLabel(requestedCode)}へ変更し、鳴きに使われた副露全体を合法な形へ再構成`
        : `${tileLabel(requestedCode)}への変更に合わせて${meldLabelJa(type)}全体を一組として補正`,
    )
  }

  const rawRef = containerRef(meld.rawRef)
  const before = readRawRef(log, rawRef)
  const after = encodeMeld(type, codes, calledIndex)
  if (before !== after) {
    writeRawRef(log, rawRef, after)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: rawRef,
      before,
      after,
      reason: meld.type === 'chi' && type === 'pon'
        ? `${tileLabel(requestedCode)}では順子を作れないため、同じ副露元からのポンへ変更`
        : `鳴きに使われた牌の変更に合わせて${meldLabelJa(type)}の並びと取得元を再構成`,
    })
  }

  return { handled: true, protectedRefs }
}

function candidateCost(state: RoundState, tile: TileTrace, targetSeat: Seat | undefined, winner?: Seat): number {
  const seat = tile.owner
  const reach = seat === undefined ? false : state.reach[seat]
  let group = 80
  if (tile.location === 'hand') {
    if (seat === targetSeat) group = 120
    else if (seat === winner) group = 35
    else if (reach) group = 30
    else group = 0
  } else if (tile.location === 'river') {
    if (seat === targetSeat) group = 110
    else if (seat === winner) group = 25
    else if (reach) group = 20
    else group = 10
  } else if (tile.location === 'dora') {
    group = 180
  } else if (tile.location === 'meld') {
    group = 200
  }
  return group + tile.acquiredAt / 10000 + Number(refKey(tile.acquisitionRef).replace(/\D/g, '')) / 1e9
}

function visibleTiles(state: RoundState): TileTrace[] {
  return Object.values(state.tiles).filter((tile) => tile.location !== 'unknown')
}

function kindCounts(state: RoundState): Map<number, number> {
  const counts = new Map<number, number>()
  for (const tile of visibleTiles(state)) counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1)
  return counts
}

function exactCodeCounts(state: RoundState): Map<number, number> {
  const counts = new Map<number, number>()
  for (const tile of visibleTiles(state)) counts.set(tile.code, (counts.get(tile.code) ?? 0) + 1)
  return counts
}

function normalCodeForKind(kind: number): TileCode | undefined {
  return ALL_TILE_CODES.find((code) => code < 50 && normalizeTile(code) === kind)
}

function repairRedFiveInventory(
  log: TenhouLog,
  round: number,
  changes: AutoChange[],
  locked: Set<string>,
  options: {
    protectedRefs?: Iterable<string>
    avoidSeat?: Seat
  } = {},
): string | undefined {
  const protectedRefs = new Set([...locked, ...(options.protectedRefs ?? [])])
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const final = replayRound(log, round).snapshots.at(-1)!
    const counts = exactCodeCounts(final)
    let violation:
      | { code: TileCode; replacement: TileCode; count: number; limit: number }
      | undefined

    for (let suit = 0; suit < 3 && !violation; suit += 1) {
      const normal = (15 + suit * 10) as TileCode
      const red = (51 + suit) as TileCode
      const redCount = counts.get(red) ?? 0
      const normalCount = counts.get(normal) ?? 0
      const redLimit = tileCodeLimit(red, log.rule)
      const normalLimit = tileCodeLimit(normal, log.rule)
      if (redCount > redLimit) {
        violation = { code: red, replacement: normal, count: redCount, limit: redLimit }
      } else if (normalCount > normalLimit) {
        violation = { code: normal, replacement: red, count: normalCount, limit: normalLimit }
      }
    }
    if (!violation) return undefined

    const candidate = visibleTiles(final)
      .filter((tile) =>
        tile.code === violation!.code
        && !protectedRefs.has(refKey(tile.acquisitionRef)))
      .sort((a, b) =>
        candidateCost(final, a, options.avoidSeat, resultWinner(log, round))
        - candidateCost(final, b, options.avoidSeat, resultWinner(log, round))
        || refKey(a.acquisitionRef).localeCompare(refKey(b.acquisitionRef)))[0]
    if (!candidate) {
      return `${tileLabel(violation.code)}が${violation.count}枚ありますが、交換可能な牌がなくルール設定（${violation.limit}枚）へ補正できません`
    }
    updatePhysicalTile(
      log,
      candidate,
      violation.replacement,
      changes,
      'automatic',
      `${tileLabel(violation.code)}がルール設定の${violation.limit}枚を超えるため、同じ5の${tileLabel(violation.replacement)}へ玉突きで差し替え`,
    )
  }
  return '赤5と通常5の枚数補正が収束しませんでした'
}

function selectSwapCandidate(
  state: RoundState,
  kind: number,
  protectedRefs: Set<string>,
  avoidSeat?: Seat,
  winner?: Seat,
): TileTrace | undefined {
  return visibleTiles(state)
    .filter((tile) =>
      tile.kind === kind
      && !protectedRefs.has(refKey(tile.acquisitionRef)))
    .filter((tile) => tile.location !== 'meld')
    .sort((a, b) =>
      candidateCost(state, a, avoidSeat, winner) - candidateCost(state, b, avoidSeat, winner)
      || refKey(a.acquisitionRef).localeCompare(refKey(b.acquisitionRef)))[0]
}

function resultWinner(log: TenhouLog, round: number): Seat | undefined {
  const result = log.log[round]![16]
  const details = result[2]
  return Array.isArray(details) && Number.isInteger(details[0]) ? Number(details[0]) as Seat : undefined
}

function replacementKindOrder(
  counts: Map<number, number>,
  overfullKind: number,
  preferredCodes: Iterable<TileCode> = [],
): number[] {
  const preferred = [...preferredCodes].map(normalizeTile)
  const kinds = [...new Set(ALL_TILE_CODES.filter((code) => code < 50).map(normalizeTile))]
  return kinds
    .filter((kind) => kind !== overfullKind && (counts.get(kind) ?? 0) < 4)
    .sort((a, b) => {
      const preferredA = preferred.indexOf(a)
      const preferredB = preferred.indexOf(b)
      const rankA = a < 40 && overfullKind < 40 && a % 10 === overfullKind % 10 ? 0 : 1
      const rankB = b < 40 && overfullKind < 40 && b % 10 === overfullKind % 10 ? 0 : 1
      return Number(preferredA < 0) - Number(preferredB < 0)
        || (preferredA < 0 ? 0 : preferredA) - (preferredB < 0 ? 0 : preferredB)
        || rankA - rankB
        || (counts.get(a) ?? 0) - (counts.get(b) ?? 0)
        || a - b
    })
}

function containerRef(ref: RawRef): RawRef {
  const container: RawRef = {
    round: ref.round,
    section: ref.section,
    index: ref.index,
  }
  if (ref.seat !== undefined) container.seat = ref.seat
  return container
}

function uniformMeldCandidate(
  state: RoundState,
  kind: number,
  protectedRefs: Set<string>,
): Meld | undefined {
  return state.melds
    .flat()
    .filter((meld) =>
      meld.type !== 'chi'
      && meld.codes.length >= 3
      && meld.codes.every((code) => normalizeTile(code) === kind)
      && meld.tileIds.every((id) => {
        const tile = state.tiles[id]
        return tile
          && tile.origin !== 'dora'
          && !protectedRefs.has(refKey(tile.acquisitionRef))
      }))
    .sort((a, b) =>
      Number(b.type === 'ankan') - Number(a.type === 'ankan')
      || b.codes.length - a.codes.length
      || b.eventIndex - a.eventIndex)[0]
}

function meldReplacementKinds(
  state: RoundState,
  meld: Meld,
  counts: Map<number, number>,
  protectedRefs: Set<string>,
  preferredCodes: Iterable<TileCode>,
): number[] {
  const sourceKind = normalizeTile(meld.codes[0]!)
  const preferred = [...preferredCodes].map(normalizeTile)
  const kinds = [...new Set(ALL_TILE_CODES.filter((code) => code < 50).map(normalizeTile))]
  return kinds
    .filter((kind) => kind !== sourceKind)
    .filter((kind) => {
      const excessAfterRewrite = Math.max(0, (counts.get(kind) ?? 0) + meld.codes.length - 4)
      if (excessAfterRewrite === 0) return true
      const movable = visibleTiles(state).filter((tile) =>
        tile.kind === kind
        && tile.location !== 'meld'
        && !protectedRefs.has(refKey(tile.acquisitionRef))).length
      return movable >= excessAfterRewrite
    })
    .sort((a, b) => {
      const preferredA = preferred.indexOf(a)
      const preferredB = preferred.indexOf(b)
      const sameRankA = a < 40 && sourceKind < 40 && a % 10 === sourceKind % 10 ? 0 : 1
      const sameRankB = b < 40 && sourceKind < 40 && b % 10 === sourceKind % 10 ? 0 : 1
      return Number(preferredA < 0) - Number(preferredB < 0)
        || (preferredA < 0 ? 0 : preferredA) - (preferredB < 0 ? 0 : preferredB)
        || sameRankA - sameRankB
        || (counts.get(a) ?? 0) - (counts.get(b) ?? 0)
        || a - b
    })
}

function rewriteUniformMeld(
  log: TenhouLog,
  state: RoundState,
  meld: Meld,
  replacement: TileCode,
  changes: AutoChange[],
): void {
  const sourceKind = normalizeTile(meld.codes[0]!)
  const sourceLabel = tileLabel(meld.codes[0]!)
  const replacementLabel = tileLabel(replacement)
  const meldContainers = new Map<string, RawRef>()
  const traces = meld.tileIds.map((id) => state.tiles[id]).filter(Boolean) as TileTrace[]

  for (const trace of traces) {
    const refs = new Map<string, RawRef>()
    for (const ref of [trace.acquisitionRef, ...trace.references]) refs.set(refKey(ref), ref)
    for (const ref of refs.values()) {
      const rawContainer = containerRef(ref)
      const raw = getRoundSection(log.log[rawContainer.round]!, rawContainer.section, rawContainer.seat)[rawContainer.index]
      if (typeof raw === 'string' && parseMeldString(raw)) {
        meldContainers.set(refKey(rawContainer), rawContainer)
        continue
      }
      setReferenceCode(
        log,
        ref,
        replacement,
        changes,
        'automatic',
        `${sourceLabel}の${meldLabelJa(meld.type)}を${replacementLabel}へ組単位で差し替えるため物理牌を玉突き補正`,
      )
    }
  }
  meldContainers.set(refKey(containerRef(meld.rawRef)), containerRef(meld.rawRef))

  for (const ref of meldContainers.values()) {
    const before = readRawRef(log, ref)
    if (typeof before !== 'string') continue
    const parsed = parseMeldString(before)
    if (!parsed || parsed.type === 'chi') continue
    const afterCodes = parsed.codes.map((code) =>
      normalizeTile(code) === sourceKind ? replacement : code)
    const after = encodeMeld(parsed.type, afterCodes, parsed.calledIndex)
    if (before === after) continue
    writeRawRef(log, ref, after)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref,
      before,
      after,
      reason: `${state.names[meld.actor]}の${sourceLabel}${meldLabelJa(meld.type)}を、壊さず一組まとめて${replacementLabel}へ差し替え`,
    })
  }
}

function repairAllFifthTiles(
  log: TenhouLog,
  round: number,
  changes: AutoChange[],
  locked: Set<string>,
  options: {
    protectedRefs?: Iterable<string>
    avoidSeat?: Seat
    preferredCodes?: Iterable<TileCode>
  } = {},
): string | undefined {
  const protectedRefs = new Set([...locked, ...(options.protectedRefs ?? [])])
  const preferredCodes = [...(options.preferredCodes ?? [])]
  for (let attempt = 0; attempt < 96; attempt += 1) {
    const replayed = replayRound(log, round)
    const final = replayed.snapshots.at(-1)!
    const counts = kindCounts(final)
    const overfull = [...counts.entries()]
      .filter(([, count]) => count > 4)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]
    if (!overfull) return undefined
    const [overfullKind, overfullCount] = overfull
    const overfullCode = normalCodeForKind(overfullKind)
    if (!overfullCode) return `牌種${overfullKind}の4枚制約を補正できません`
    const replacementKind = replacementKindOrder(counts, overfullKind, preferredCodes)[0]
    const replacement = replacementKind === undefined ? undefined : normalCodeForKind(replacementKind)
    const candidate = selectSwapCandidate(
      final,
      overfullKind,
      protectedRefs,
      options.avoidSeat,
      resultWinner(log, round),
    )
    if (candidate && replacement) {
      updatePhysicalTile(
        log,
        candidate,
        replacement,
        changes,
        'automatic',
        `${tileLabel(overfullCode)}が${overfullCount}枚あるため、${candidate.owner === undefined ? '未確定領域' : final.names[candidate.owner]}の${locationLabel(candidate.location)}にある${tileLabel(candidate.code)}を${tileLabel(replacement)}へ玉突きで差し替え`,
      )
      preferredCodes.unshift(candidate.code)
      continue
    }

    const meld = uniformMeldCandidate(final, overfullKind, protectedRefs)
    if (!meld) {
      return `${tileLabel(overfullCode)}の交換可能な牌がなく、固定された牌や副露を壊さず4枚制約を補正できません`
    }
    const meldReplacementKind = meldReplacementKinds(
      final,
      meld,
      counts,
      protectedRefs,
      preferredCodes,
    )[0]
    const meldReplacement = meldReplacementKind === undefined
      ? undefined
      : normalCodeForKind(meldReplacementKind)
    if (!meldReplacement) {
      return `${tileLabel(overfullCode)}の${meldLabelJa(meld.type)}を合法な別牌へ差し替えられません`
    }
    rewriteUniformMeld(log, final, meld, meldReplacement, changes)
    preferredCodes.unshift(overfullCode)
  }
  return '五枚目の玉突き補正が収束しませんでした'
}

function repairFifthTiles(
  log: TenhouLog,
  round: number,
  requestedTrace: TileTrace,
  oldCode: TileCode,
  _requestedCode: TileCode,
  changes: AutoChange[],
  locked: Set<string>,
): string | undefined {
  return repairAllFifthTiles(log, round, changes, locked, {
    protectedRefs: [refKey(requestedTrace.acquisitionRef)],
    avoidSeat: requestedTrace.owner,
    preferredCodes: [oldCode],
  })
}

function locationLabel(location: TileTrace['location']): string {
  return { hand: '手牌', river: '河', meld: '副露', dora: 'ドラ表示', unknown: '未確定牌山' }[location]
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

function findForcedMeld(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-add' }>,
): { state: RoundState; meld: Meld } | undefined {
  const final = replayRound(log, request.round).snapshots.at(-1)!
  const desired = request.forced!.codes
  const meld = final.melds[request.actor]!.find((candidate) =>
    candidate.type === request.meldType
    && candidate.codes.length === desired.length
    && candidate.codes.every((code, index) => sameTileKind(code, desired[index]!)))
  return meld ? { state: final, meld } : undefined
}

function forcedMeldExists(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-add' }>,
): boolean {
  return Boolean(findForcedMeld(log, request))
}

function applyMeldAdd(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'meld-add' }>,
  changes: AutoChange[],
  locked: Set<string>,
): string | undefined {
  if (
    ['daiminkan', 'ankan', 'kakan'].includes(request.meldType)
    && countKans(log.log[request.round]!) >= 4
  ) {
    return '5回目のカンはできません。1局で宣言できるカンは合計4回までです'
  }
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
    if (countKans(log.log[request.round]!) >= 4) {
      return '5回目のカンはできません。1局で宣言できるカンは合計4回までです'
    }
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
  const exact = new Map<number, number>()
  for (const tile of Object.values(state.tiles)) {
    counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1)
    exact.set(tile.code, (exact.get(tile.code) ?? 0) + 1)
  }
  return ALL_TILE_CODES.find((code) => {
    return (counts.get(normalizeTile(code)) ?? 0) < 4
      && (exact.get(code) ?? 0) < tileCodeLimit(code, rule)
  }) ?? 11
}

function meldLabelJa(type: MeldType): string {
  return { chi: 'チー', pon: 'ポン', daiminkan: '大明槓', ankan: '暗槓', kakan: '加槓' }[type]
}

function applyReach(
  log: TenhouLog,
  request: Extract<EditRequest, { type: 'reach' }>,
  changes: AutoChange[],
  locked: Set<string>,
): string | undefined {
  const replayed = replayRound(log, request.round)
  const state = snapshotAt(replayed, request.event)
  const stream = getRoundSection(log.log[request.round]!, 'discard', request.actor)
  if (!request.enabled) {
    const reachIndex = stream.findIndex((item) => typeof item === 'string' && /^r(?:60|\d{2})$/.test(item))
    if (reachIndex < 0) return undefined
    const before = stream[reachIndex]!
    const after = Number(String(before).slice(1))
    stream[reachIndex] = after
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'manual',
      ref: { round: request.round, section: 'discard', seat: request.actor, index: reachIndex },
      before,
      after,
      reason: 'リーチ宣言を解除',
    })
    return undefined
  }
  let index = state.streamCursors.discards[request.actor]! - 1
  if (index < 0) index = 0
  while (index < stream.length && typeof stream[index] === 'string' && parseMeldString(stream[index] as string)) index += 1
  const before = stream[index]
  if (before === undefined) return 'リーチを設定できる打牌がありません'
  const discardEvent = replayed.events.find((candidate) =>
    candidate.type === 'discard'
    && candidate.actor === request.actor
    && candidate.rawRef?.section === 'discard'
    && candidate.rawRef.index === index)
  if (!discardEvent) return 'リーチ宣言牌の手順を追跡できません'
  let reachState = snapshotAt(replayed, discardEvent.index)
  const open = reachState.melds[request.actor]!.some((meld) => meld.type !== 'ankan')
  if (open) return '門前ではないためリーチを設定できません'
  if (reachState.scores[request.actor]! < 1000) return '1000点未満のためリーチ棒を支払えません'
  if (typeof before === 'string' && before.startsWith('r')) return undefined

  let handCodes = reachState.hands[request.actor]!.map((id) => reachState.tiles[id]!.code)
  if (!isTenpai(handCodes, reachState.melds[request.actor]!.length)) {
    const target = nearestTenpaiCodes(handCodes, reachState.melds[request.actor]!.length)
    if (!target) return 'リーチ地点の手牌から聴牌形を構成できません'
    const forced = forceHandCodes(
      log,
      request.round,
      discardEvent.index,
      request.actor,
      target,
      changes,
      locked,
      'リーチを成立させるため門前手牌を最小限の差替えで聴牌形へ補正',
    )
    if (typeof forced === 'string') return forced
    reachState = snapshotAt(replayRound(log, request.round), discardEvent.index)
    handCodes = reachState.hands[request.actor]!.map((id) => reachState.tiles[id]!.code)
    if (!isTenpai(handCodes, reachState.melds[request.actor]!.length)) {
      return '手牌補正後もリーチ地点で聴牌を確認できません'
    }
  }
  stream[index] = `r${before}`
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'manual',
    ref: { round: request.round, section: 'discard', seat: request.actor, index },
    before,
    after: stream[index]!,
    reason: '門前・聴牌・持ち点を確認してリーチを設定',
  })
  return undefined
}

function nearestTenpaiCodes(codes: TileCode[], openMeldCount: number): TileCode[] | undefined {
  let current = [...codes]
  const baseCodes = Array.from({ length: 34 }, (_, index) => indexToTileCode(index))
  for (let step = 0; step < 8; step += 1) {
    if (isTenpai(current, openMeldCount)) return current
    const currentShanten = shanten(current, openMeldCount)
    let best: { codes: TileCode[]; shanten: number; replacement: TileCode; index: number } | undefined
    const seenKinds = new Set<number>()
    for (let index = 0; index < current.length; index += 1) {
      const removedKind = normalizeTile(current[index]!)
      if (seenKinds.has(removedKind)) continue
      seenKinds.add(removedKind)
      for (const replacement of baseCodes) {
        if (normalizeTile(replacement) === removedKind) continue
        const candidate = [...current]
        candidate[index] = replacement
        const count = candidate.filter((code) => normalizeTile(code) === normalizeTile(replacement)).length
        if (count > 4) continue
        const candidateShanten = shanten(candidate, openMeldCount)
        if (
          !best
          || candidateShanten < best.shanten
          || (candidateShanten === best.shanten && replacement < best.replacement)
          || (candidateShanten === best.shanten && replacement === best.replacement && index < best.index)
        ) best = { codes: candidate, shanten: candidateShanten, replacement, index }
      }
    }
    if (!best || best.shanten >= currentShanten) return undefined
    current = best.codes
  }
  return isTenpai(current, openMeldCount) ? current : undefined
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

function trimRoundAfterEvent(
  log: TenhouLog,
  round: number,
  event: number,
  changes: AutoChange[],
  reason: string,
): RoundState {
  const replayed = replayRound(log, round)
  const state = snapshotAt(replayed, event)
  for (let player = 0; player < 4; player += 1) {
    const seat = player as Seat
    for (const [section, cursor] of [
      ['draw', state.streamCursors.draws[seat]!] as const,
      ['discard', state.streamCursors.discards[seat]!] as const,
    ]) {
      const stream = getRoundSection(log.log[round]!, section, seat)
      if (cursor >= stream.length) continue
      const removed = stream.splice(cursor)
      changes.push({
        id: `change-${changes.length + 1}`,
        kind: 'automatic',
        ref: { round, section, seat, index: cursor },
        before: JSON.stringify(removed),
        after: '',
        reason,
      })
    }
  }
  const dora = log.log[round]![2]
  if (state.dora.length < dora.length) {
    const removed = dora.splice(state.dora.length)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: { round, section: 'dora', index: state.dora.length },
      before: JSON.stringify(removed),
      after: '',
      reason: `${reason}。未到達のカンドラ表示牌を王牌へ戻す`,
    })
  }
  return state
}

function replaceRoundResult(
  log: TenhouLog,
  round: number,
  result: unknown[],
  changes: AutoChange[],
  reason: string,
): void {
  const before = log.log[round]![16]
  if (JSON.stringify(before) === JSON.stringify(result)) return
  log.log[round]![16] = result
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'automatic',
    ref: { round, section: 'discard', index: -1 },
    before: JSON.stringify(before),
    after: JSON.stringify(result),
    reason,
  })
}

function editedDrawEvaluation(
  log: TenhouLog,
  round: number,
  ref: RawRef,
): { event: number; actor: Seat; state: RoundState; delta: [number, number, number, number]; yaku: string[] } | undefined {
  const replayed = replayRound(log, round)
  const event = replayed.events.find((candidate) =>
    (candidate.type === 'draw' || candidate.type === 'rinshan-draw')
    && candidate.rawRef
    && refKey(candidate.rawRef) === refKey(ref))
  if (!event || event.actor === undefined) return undefined
  const state = snapshotAt(replayed, event.index)
  const evaluated = evaluateWin(state, event.actor, {
    selfDraw: true,
    tile: event.tile,
    event,
  })
  if (!evaluated.legal || !evaluated.delta) return undefined
  return {
    event: event.index,
    actor: event.actor,
    state,
    delta: evaluated.delta,
    yaku: evaluated.yaku ?? [],
  }
}

function convertEditedDrawToTsumo(
  log: TenhouLog,
  round: number,
  win: ReturnType<typeof editedDrawEvaluation> & {},
  changes: AutoChange[],
): void {
  if (!win) return
  const reason = `${win.state.names[win.actor]}の編集したツモが役あり和了形になったため、その時点でツモ和了へ変更`
  trimRoundAfterEvent(log, round, win.event, changes, reason)
  replaceRoundResult(
    log,
    round,
    ['和了', win.delta, [win.actor, win.actor]],
    changes,
    `${reason}${win.yaku.length ? `（${win.yaku.join('・')}）` : ''}`,
  )
}

interface AbortiveDrawPoint {
  label: '四風連打' | '四槓散了'
  event: number
  actor?: Seat
}

function abortiveDrawPoint(log: TenhouLog, round: number): AbortiveDrawPoint | undefined {
  const replayed = replayRound(log, round)
  const points: AbortiveDrawPoint[] = []
  const hasLegalRon = (discard: NormalizedEvent): boolean => {
    const rons = replayed.events.filter((event) =>
      event.type === 'ron' && event.tileId === discard.tileId)
    return rons.some((ron) =>
      !replayed.diagnostics.some((diagnostic) =>
        diagnostic.event === ron.index
        && diagnostic.seat === ron.actor
        && ['INVALID_WIN_SHAPE', 'INVALID_WIN_YAKU', 'FURITEN_RON'].includes(diagnostic.code)))
  }
  const firstDiscards = replayed.events.filter((event) => event.type === 'discard').slice(0, 4)
  if (firstDiscards.length === 4) {
    const fourth = firstDiscards[3]!
    const actors = new Set(firstDiscards.map((event) => event.actor))
    const sameWind = fourth.tile !== undefined
      && fourth.tile >= 41
      && fourth.tile <= 44
      && firstDiscards.every((event) => event.tile === fourth.tile)
    const interrupted = replayed.events.some((event) =>
      event.index < fourth.index
      && ['chi', 'pon', 'daiminkan', 'ankan', 'kakan'].includes(event.type))
    if (actors.size === 4 && sameWind && !interrupted && !hasLegalRon(fourth)) {
      points.push({ label: '四風連打', event: fourth.index, actor: fourth.actor })
    }
  }

  let kans = 0
  const kanActors = new Set<Seat>()
  let fourthKan = -1
  for (const event of replayed.events) {
    if (!['daiminkan', 'ankan', 'kakan'].includes(event.type) || event.actor === undefined) continue
    kans += 1
    kanActors.add(event.actor)
    if (kans === 4 && kanActors.size >= 2) {
      fourthKan = event.index
      break
    }
  }
  if (fourthKan >= 0) {
    const discard = replayed.events.find((event) =>
      event.type === 'discard' && event.index > fourthKan)
    if (discard && !hasLegalRon(discard)) {
      points.push({ label: '四槓散了', event: discard.index, actor: discard.actor })
    }
  }
  return points.sort((a, b) => a.event - b.event)[0]
}

function reconcileAbortiveDraw(
  log: TenhouLog,
  round: number,
  changes: AutoChange[],
): boolean {
  const point = abortiveDrawPoint(log, round)
  if (!point) return false
  const state = trimRoundAfterEvent(
    log,
    round,
    point.event,
    changes,
    `${point.label}が成立したため、それ以降の手順を牌山へ戻す`,
  )
  const ura = log.log[round]![3]
  if (ura.length) {
    const removed = ura.splice(0)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: { round, section: 'ura', index: 0 },
      before: JSON.stringify(removed),
      after: '',
      reason: `${point.label}では裏ドラを開かないため王牌へ戻す`,
    })
  }
  replaceRoundResult(
    log,
    round,
    [point.label],
    changes,
    point.label === '四風連打'
      ? `4人の最初の打牌が${point.actor === undefined ? '同じ風牌' : tileLabel(state.lastDiscard ? state.tiles[state.lastDiscard.tileId]!.code : 41)}で揃ったため四風連打`
      : '2人以上が合計4回カンし、その後の打牌が通ったため四槓散了',
  )
  return true
}

function convertBrokenWinToDraw(
  log: TenhouLog,
  round: number,
  seed: number,
  changes: AutoChange[],
  cause = '和了条件',
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
    reason: `${cause}が成立しなくなったため、乱数シード${seed}で残り${generated}巡の牌山を補完し、${ready.length}人聴牌の流局へ変更`,
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
  const fifthProtected = new Set<string>()
  const fifthPreferred: TileCode[] = []
  let fifthAvoidSeat: Seat | undefined = 'actor' in request ? request.actor : undefined
  let editedDrawRef: RawRef | undefined
  let baselineEditedDrawLegal = false
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
          if (trace.origin === 'draw') {
            editedDrawRef = trace.acquisitionRef
            baselineEditedDrawLegal = Boolean(
              editedDrawEvaluation(input, request.round, trace.acquisitionRef),
            )
          }
          fifthProtected.add(refKey(trace.acquisitionRef))
          fifthAvoidSeat = trace.owner
          const completeTrace = Object.values(sourceRound.snapshots.at(-1)!.tiles)
            .find((candidate) => refKey(candidate.acquisitionRef) === refKey(trace.acquisitionRef))
            ?? trace
          const oldCode = trace.code
          fifthPreferred.push(oldCode)
          const meldEdit = applyMeldAwareTileEdit(
            output,
            sourceRound.snapshots.at(-1)!,
            trace,
            completeTrace,
            request.code,
            changes,
            locked,
          )
          meldEdit.protectedRefs.forEach((key) => fifthProtected.add(key))
          conflict = meldEdit.conflict
          if (!meldEdit.handled) {
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
      }
    } else if (request.type === 'meld-add') {
      conflict = applyMeldAdd(output, request, changes, locked)
    } else if (request.type === 'meld-remove') {
      conflict = applyMeldRemove(output, request, changes)
    } else if (request.type === 'meld-change') {
      conflict = applyMeldChange(output, request, changes)
    } else if (request.type === 'reach') {
      conflict = applyReach(output, request, changes, locked)
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
      const forced = findForcedMeld(output, request)
      if (forced) {
        for (const id of forced.meld.tileIds) {
          const tile = forced.state.tiles[id]
          if (tile) fifthProtected.add(refKey(tile.acquisitionRef))
        }
      }
    }

    conflict = repairAllFifthTiles(output, request.round, changes, locked, {
      protectedRefs: fifthProtected,
      avoidSeat: fifthAvoidSeat,
      preferredCodes: fifthPreferred,
    })
    if (conflict) return { ok: false, changes: [], diagnostics: [], conflict }
    conflict = repairRedFiveInventory(output, request.round, changes, locked, {
      protectedRefs: fifthProtected,
      avoidSeat: fifthAvoidSeat,
    })
    if (conflict) return { ok: false, changes: [], diagnostics: [], conflict }

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

    if (editedDrawRef && !baselineEditedDrawLegal) {
      const newTsumo = editedDrawEvaluation(output, request.round, editedDrawRef)
      if (newTsumo) {
        convertEditedDrawToTsumo(output, request.round, newTsumo, changes)
        candidate = decodeMatch(output)
      }
    }

    const abortiveDraw = reconcileAbortiveDraw(output, request.round, changes)
    if (abortiveDraw) candidate = decodeMatch(output)

    const invalidWin = candidate.diagnostics.find((diagnostic) =>
      diagnostic.round === request.round
      && ['INVALID_WIN_SHAPE', 'INVALID_WIN_YAKU', 'FURITEN_RON'].includes(diagnostic.code)
      && !baseline.diagnostics.some((base) => diagnosticKey(base) === diagnosticKey(diagnostic)))
    if (invalidWin) {
      convertBrokenWinToDraw(output, request.round, seed, changes, invalidWin.message)
      conflict = repairAllFifthTiles(output, request.round, changes, locked, {
        protectedRefs: fifthProtected,
        avoidSeat: fifthAvoidSeat,
        preferredCodes: fifthPreferred,
      })
      if (conflict) return { ok: false, changes: [], diagnostics: [], conflict }
      conflict = repairRedFiveInventory(output, request.round, changes, locked, {
        protectedRefs: fifthProtected,
        avoidSeat: fifthAvoidSeat,
      })
      if (conflict) return { ok: false, changes: [], diagnostics: [], conflict }
      candidate = decodeMatch(output)
    }
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
