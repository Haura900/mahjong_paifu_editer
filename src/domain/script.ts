import { getRoundSection, parseMeldString, parseTenhouLog, readRawRef, refKey, writeRawRef } from './codec'
import { isTenpai } from './hand'
import { decodeMatch, snapshotAt } from './replay'
import { solveEdit } from './solver'
import { fromMajiangTile, normalizeTile, sameTileKind, tileLabel, toMajiangTile } from './tile'
import type {
  AutoChange,
  RawRef,
  RawRound,
  RawTile,
  RoundState,
  Seat,
  TenhouLog,
  TileCode,
} from './types'

export const PAIFU_SCRIPT_SPEC = `牌譜編集スクリプト v1
- 1行に1命令。空行と # から始まるコメントは無視する。
- KEEP_ONLY                         現在局以外を削除する。使う場合は必ずスクリプトの先頭に置く。
- 牌は 1m-9m / 1p-9p / 1s-9s / 1z-7z。赤5は 0m / 0p / 0s。
- 席は SELF / SHIMO / TOIMEN / KAMI（自分・下家・対面・上家）、または EAST / SOUTH / WEST / NORTH。
- 巡目・位置番号は1始まり。
- SET <席> RIVER <巡目> <牌>       河の牌を差し替える。
- SET <席> HAND <位置> <牌>        現在表示中の手牌を差し替える。仕様として使用可能だが、AI生成では原則使用禁止。
- SET <席> DRAW <巡目> <牌>        指定席のツモ列を差し替える。
- SET DORA <位置> <牌>             ドラ表示牌を差し替える。
- SET URA <位置> <牌>              裏ドラ表示牌を差し替える。
- SWAP <場所> WITH <場所>          2つの物理牌を交換する。場所の書式はSETの牌より前と同じ。
- COPY <席> HAND FROM <巡目> TO <巡目>
                                      FROMは残したい牌姿が実在する元巡目、TOはその牌姿を成立させる先の巡目。牌姿をFROM→TOへコピーする。巡目番号の大小に制約はなく、早い巡目から遅い巡目、遅い巡目から早い巡目の両方に使える。直前巡目は字牌1枚で崩し、再現後の手牌を固定する。直後にTOと同巡目へのREACHがあれば宣言移動も固定前に一括適用する。
- MELD_ADD <席> PON <牌> FROM <捨てた席> RIVER <巡目>
                                      指定河牌を鳴いてポンを追加する。必要な対子は自動補正する。
- MELD_ADD <席> CHI <牌1> <牌2> <牌3> FROM <捨てた席> RIVER <巡目>
                                      指定河牌を鳴いてチーを追加する。チーは上家からのみ。
- MELD_REMOVE <席> <副露番号>      表示中の副露を1始まりの番号で解除する。
- REACH <席> ON BEFORE <基準席> RIVER <巡目>
                                      基準打牌より前にある指定席の最後の打牌でリーチする。打牌判断用の局面ではこちらを優先する。
- REACH <席> ON [AT <巡目>]        リーチを追加する。ATはリーチ者自身の河巡目。非聴牌ならその地点で自動聴牌補正する。
- REACH <席> OFF                   その席のリーチを解除する。
- LOCK SELF HAND ALL              実行時点のSELF手牌（ツモ牌を含み、副露を除く）をすべて固定する。
- SCENE "名前" ～ END              現在局を元に独立した案を作り、現在局の直後へ追加する。
- SCENE内で失敗した案はその案だけを破棄してエラーを表示し、後続のSCENEは続けて実行する。
- SCENE外の命令は現在局そのものへ適用する。SCENEは最大20個、命令は全体で最大200個。

例:
KEEP_ONLY
SCENE "上家の4pを10巡目へ"
LOCK SELF HAND ALL
SET KAMI RIVER 7 1z
SET KAMI RIVER 10 4p
END`

type PlayerArea = 'river' | 'hand' | 'draw'
type GlobalArea = 'dora' | 'ura'

interface PlayerLocation {
  kind: 'player'
  seat: string
  area: PlayerArea
  index: number
}

interface GlobalLocation {
  kind: 'global'
  area: GlobalArea
  index: number
}

type Location = PlayerLocation | GlobalLocation

interface SetAction {
  kind: 'set'
  location: Location
  code: TileCode
  line: number
}

interface SwapAction {
  kind: 'swap'
  first: Location
  second: Location
  line: number
}

interface MeldAddAction {
  kind: 'meld-add'
  actor: string
  meldType: 'chi' | 'pon'
  codes: TileCode[]
  source: PlayerLocation
  line: number
}

interface MeldRemoveAction {
  kind: 'meld-remove'
  actor: string
  index: number
  line: number
}

interface ReachAction {
  kind: 'reach'
  actor: string
  enabled: boolean
  turn?: number
  before?: PlayerLocation
  line: number
}

interface CopyHandAction {
  kind: 'copy-hand'
  actor: string
  fromTurn: number
  toTurn: number
  line: number
}

interface LockSelfHandAllAction {
  kind: 'lock-self-hand-all'
  line: number
}

type ScriptAction = SetAction | SwapAction | CopyHandAction | MeldAddAction | MeldRemoveAction | ReachAction | LockSelfHandAllAction

interface Scene {
  name: string
  actions: ScriptAction[]
  errors: string[]
}

export interface ScriptSceneError {
  name: string
  message: string
}

export interface ParsedPaifuScript {
  keepOnly: boolean
  actions: ScriptAction[]
  scenes: Scene[]
}

export interface ScriptExecutionResult {
  output: TenhouLog
  changes: AutoChange[]
  sceneCount: number
  sceneErrors: ScriptSceneError[]
  commandCount: number
  keepOnly: boolean
}

function scriptError(line: number, message: string): never {
  throw new Error(`${line}行目: ${message}`)
}

function parseIndex(value: string | undefined, line: number): number {
  const index = Number(value)
  if (!Number.isInteger(index) || index < 1) scriptError(line, '位置は1以上の整数で指定してください')
  return index
}

function parseLocation(tokens: string[], line: number): { location: Location; consumed: number } {
  const first = tokens[0]?.toUpperCase()
  if (first === 'DORA' || first === 'URA') {
    return {
      location: { kind: 'global', area: first.toLowerCase() as GlobalArea, index: parseIndex(tokens[1], line) },
      consumed: 2,
    }
  }
  if (!first) scriptError(line, '場所がありません')
  const area = tokens[1]?.toLowerCase()
  if (area !== 'river' && area !== 'hand' && area !== 'draw') {
    scriptError(line, '場所は RIVER / HAND / DRAW / DORA / URA のいずれかです')
  }
  return {
    location: { kind: 'player', seat: first, area, index: parseIndex(tokens[2], line) },
    consumed: 3,
  }
}

function fromScriptTile(value: string): TileCode | undefined {
  const standard = value.toLowerCase().match(/^([0-9])([mpsz])$/)
  if (standard) return fromMajiangTile(`${standard[2]}${standard[1]}`)
  return fromMajiangTile(value.toLowerCase())
}

export function parsePaifuScript(input: string): ParsedPaifuScript {
  const result: ParsedPaifuScript = { keepOnly: false, actions: [], scenes: [] }
  let current: Scene | undefined
  let commandCount = 0

  input.split(/\r?\n/).forEach((rawLine, offset) => {
    const line = offset + 1
    const source = rawLine.trim()
    if (!source || source.startsWith('#')) return
    if (/^KEEP_ONLY$/i.test(source)) {
      if (current) {
        current.errors.push(`${line}行目: KEEP_ONLYはSCENEの外に置いてください`)
        return
      }
      if (result.keepOnly) scriptError(line, 'KEEP_ONLYは1回だけ指定できます')
      if (commandCount || result.scenes.length) scriptError(line, 'KEEP_ONLYはスクリプトの先頭に置いてください')
      result.keepOnly = true
      commandCount += 1
      return
    }
    if (/^SCENE\b/i.test(source)) {
      if (current) scriptError(line, 'SCENEの中にSCENEは作れません')
      const match = source.match(/^SCENE\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i)
      const name = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
      if (!name) scriptError(line, 'SCENE名を指定してください')
      current = { name, actions: [], errors: [] }
      result.scenes.push(current)
      if (result.scenes.length > 20) scriptError(line, 'SCENEは20個までです')
      return
    }
    if (/^END$/i.test(source)) {
      if (!current) scriptError(line, '対応するSCENEがありません')
      if (!current.actions.length && !current.errors.length) {
        current.errors.push(`${line}行目: SCENEに命令がありません`)
      }
      current = undefined
      return
    }

    try {
      const tokens = source.split(/\s+/)
      const target = current?.actions ?? result.actions
      if (tokens[0]?.toUpperCase() === 'LOCK') {
        if (
          tokens.length !== 4
          || tokens[1]?.toUpperCase() !== 'SELF'
          || tokens[2]?.toUpperCase() !== 'HAND'
          || tokens[3]?.toUpperCase() !== 'ALL'
        ) {
          scriptError(line, 'LOCKの正式構文は「LOCK SELF HAND ALL」です')
        }
        target.push({ kind: 'lock-self-hand-all', line })
      } else if (tokens[0]?.toUpperCase() === 'SET') {
        const parsed = parseLocation(tokens.slice(1), line)
        const tile = tokens[1 + parsed.consumed]
        const code = tile ? fromScriptTile(tile) : undefined
        if (!code) scriptError(line, `牌「${tile ?? ''}」を認識できません`)
        if (tokens.length !== parsed.consumed + 2) scriptError(line, 'SET命令の末尾に余分な値があります')
        target.push({ kind: 'set', location: parsed.location, code, line })
      } else if (tokens[0]?.toUpperCase() === 'SWAP') {
        const first = parseLocation(tokens.slice(1), line)
        const withIndex = 1 + first.consumed
        if (tokens[withIndex]?.toUpperCase() !== 'WITH') scriptError(line, 'SWAPの2場所の間にはWITHが必要です')
        const second = parseLocation(tokens.slice(withIndex + 1), line)
        if (tokens.length !== withIndex + second.consumed + 1) scriptError(line, 'SWAP命令の末尾に余分な値があります')
        target.push({ kind: 'swap', first: first.location, second: second.location, line })
      } else if (tokens[0]?.toUpperCase() === 'COPY') {
        if (
          tokens.length !== 7
          || tokens[2]?.toUpperCase() !== 'HAND'
          || tokens[3]?.toUpperCase() !== 'FROM'
          || tokens[5]?.toUpperCase() !== 'TO'
          || !tokens[1]
        ) {
          scriptError(line, 'COPYの正式構文は「COPY <席> HAND FROM <巡目> TO <巡目>」です')
        }
        const fromTurn = parseIndex(tokens[4], line)
        const toTurn = parseIndex(tokens[6], line)
        if (fromTurn === toTurn) scriptError(line, 'コピー元巡目とコピー先巡目は別にしてください')
        target.push({
          kind: 'copy-hand',
          actor: tokens[1]!.toUpperCase(),
          fromTurn,
          toTurn,
          line,
        })
      } else if (tokens[0]?.toUpperCase() === 'MELD_ADD') {
        const actor = tokens[1]?.toUpperCase()
        const meldType = tokens[2]?.toLowerCase()
        if (!actor || (meldType !== 'chi' && meldType !== 'pon')) {
          scriptError(line, 'MELD_ADDは席と CHI / PON を指定してください')
        }
        const tileCount = meldType === 'chi' ? 3 : 1
        const codeTokens = tokens.slice(3, 3 + tileCount)
        const codes = codeTokens.map(fromScriptTile)
        if (codes.length !== tileCount || codes.some((code) => !code)) {
          scriptError(line, 'MELD_ADDの牌を認識できません')
        }
        const from = 3 + tileCount
        if (tokens[from]?.toUpperCase() !== 'FROM' || tokens[from + 2]?.toUpperCase() !== 'RIVER') {
          scriptError(line, 'MELD_ADDは FROM <席> RIVER <巡目> で鳴く河牌を指定してください')
        }
        if (tokens.length !== from + 4) scriptError(line, 'MELD_ADD命令の末尾に余分な値があります')
        const parsedCodes = codes as TileCode[]
        const meldCodes = meldType === 'pon'
          ? Array<TileCode>(3).fill(parsedCodes[0]!)
          : parsedCodes
        target.push({
          kind: 'meld-add',
          actor,
          meldType,
          codes: meldCodes,
          source: {
            kind: 'player',
            seat: tokens[from + 1]!.toUpperCase(),
            area: 'river',
            index: parseIndex(tokens[from + 3], line),
          },
          line,
        })
      } else if (tokens[0]?.toUpperCase() === 'MELD_REMOVE') {
        if (tokens.length !== 3 || !tokens[1]) scriptError(line, 'MELD_REMOVEは席と副露番号を指定してください')
        target.push({
          kind: 'meld-remove',
          actor: tokens[1]!.toUpperCase(),
          index: parseIndex(tokens[2], line),
          line,
        })
      } else if (tokens[0]?.toUpperCase() === 'REACH') {
        const actor = tokens[1]?.toUpperCase()
        const mode = tokens[2]?.toUpperCase()
        if (!actor || (mode !== 'ON' && mode !== 'OFF')) scriptError(line, 'REACHは席と ON / OFF を指定してください')
        if (mode === 'OFF' && tokens.length !== 3) scriptError(line, 'REACH OFFには巡目を指定しません')
        const at = mode === 'ON' && tokens.length === 5 && tokens[3]?.toUpperCase() === 'AT'
        const before = mode === 'ON'
          && tokens.length === 7
          && tokens[3]?.toUpperCase() === 'BEFORE'
          && tokens[5]?.toUpperCase() === 'RIVER'
        if (mode === 'ON' && tokens.length !== 3 && !at && !before) {
          scriptError(line, 'REACH ONは AT <巡目> または BEFORE <基準席> RIVER <巡目> で指定してください')
        }
        target.push({
          kind: 'reach',
          actor,
          enabled: mode === 'ON',
          turn: at ? parseIndex(tokens[4], line) : undefined,
          before: before ? {
            kind: 'player',
            seat: tokens[4]!.toUpperCase(),
            area: 'river',
            index: parseIndex(tokens[6], line),
          } : undefined,
          line,
        })
      } else {
        scriptError(line, `命令「${tokens[0]}」を認識できません`)
      }
      commandCount += 1
      if (commandCount > 200) scriptError(line, '命令は全体で200個までです')
    } catch (error) {
      if (!current) throw error
      current.errors.push(error instanceof Error ? error.message : String(error))
    }
  })

  if (current) throw new Error(`SCENE「${current.name}」のENDがありません`)
  if (!result.keepOnly && !result.actions.length && !result.scenes.length) throw new Error('実行する命令がありません')
  return result
}

function resolveSeat(token: string, self: Seat): Seat {
  const absolute: Record<string, Seat> = { EAST: 0, SOUTH: 1, WEST: 2, NORTH: 3 }
  if (absolute[token] !== undefined) return absolute[token]
  const relative: Record<string, number> = { SELF: 0, SHIMO: 1, TOIMEN: 2, KAMI: 3 }
  const offset = relative[token]
  if (offset === undefined) throw new Error(`席「${token}」を認識できません`)
  return ((self + offset) % 4) as Seat
}

function locationRef(log: TenhouLog, round: number, event: number, self: Seat, location: Location): RawRef {
  const decodedRound = decodeMatch(log).rounds[round]
  if (!decodedRound) throw new Error('指定された局がありません')
  const finalState = decodedRound.snapshots.at(-1)!
  const currentState = snapshotAt(decodedRound, Math.min(event, decodedRound.events.length - 1))
  let tileId: string | undefined

  if (location.kind === 'global') {
    const ids = location.area === 'dora' ? currentState.dora : currentState.ura
    tileId = ids[location.index - 1]
  } else {
    const seat = resolveSeat(location.seat, self)
    if (location.area === 'river') tileId = finalState.rivers[seat]![location.index - 1]?.tileId
    else if (location.area === 'hand') tileId = currentState.hands[seat]![location.index - 1]
    else {
      const ref: RawRef = { round, section: 'draw', seat, index: location.index - 1 }
      const trace = Object.values(finalState.tiles).find((tile) => refKey(tile.acquisitionRef) === refKey(ref))
      tileId = trace?.id
    }
  }

  const trace = tileId ? (finalState.tiles[tileId] ?? currentState.tiles[tileId]) : undefined
  if (!trace) throw new Error(`${formatLocation(location)} が現在の局にありません`)
  return trace.acquisitionRef
}

function formatLocation(location: Location): string {
  return location.kind === 'global'
    ? `${location.area.toUpperCase()} ${location.index}`
    : `${location.seat} ${location.area.toUpperCase()} ${location.index}`
}

function codeAtRef(log: TenhouLog, round: number, ref: RawRef): TileCode {
  const state = decodeMatch(log).rounds[round]!.snapshots.at(-1)!
  const trace = Object.values(state.tiles).find((tile) => refKey(tile.acquisitionRef) === refKey(ref))
  if (!trace) throw new Error('交換対象の物理牌を追跡できません')
  return trace.code
}

interface SelfHandSnapshot {
  refs: string[]
  signature: string[]
}

function selfHandSnapshot(log: TenhouLog, round: number, event: number, self: Seat): SelfHandSnapshot {
  const decodedRound = decodeMatch(log).rounds[round]
  if (!decodedRound) throw new Error('指定された局がありません')
  const state = snapshotAt(decodedRound, Math.min(event, decodedRound.events.length - 1))
  const ids = [...state.hands[self]!]
  if (state.lastDraw?.seat === self && !ids.includes(state.lastDraw.tileId)) ids.push(state.lastDraw.tileId)
  const entries = ids.map((id) => state.tiles[id]!)
  return {
    refs: entries.map((tile) => refKey(tile.acquisitionRef)).sort(),
    signature: entries
      .map((tile) => `${refKey(tile.acquisitionRef)}=${tile.code}:${tile.red ? 'red' : 'normal'}`)
      .sort(),
  }
}

function assertSelfHandInvariant(
  log: TenhouLog,
  round: number,
  event: number,
  self: Seat,
  expected: string[] | undefined,
): void {
  if (!expected) return
  const actual = selfHandSnapshot(log, round, event, self).signature
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('LOCK SELF HAND ALLと競合し、SELF手牌の牌集合・赤牌区分・占有位置を維持できません')
  }
}

function assertTurnHandInvariant(
  log: TenhouLog,
  round: number,
  seat: Seat,
  turn: number,
  expected: string[],
): void {
  const actual = handAfterDiscard(log, round, seat, turn).entries
    .map((entry) => `${entry.key}=${entry.code}`)
    .sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`COPY HANDで固定した${turn}巡目の手牌を維持できません`)
  }
}

function solveScriptEdit(
  log: TenhouLog,
  request: Parameters<typeof solveEdit>[1],
  lockedRefs: Iterable<string>,
  seed: number,
): { output: TenhouLog; changes: AutoChange[] } {
  const result = solveEdit(log, request, { lockedRefs, seed })
  if (!result.ok || !result.output) throw new Error(result.conflict ?? '牌譜編集を適用できません')
  return { output: result.output, changes: result.changes }
}

function applySet(
  log: TenhouLog,
  round: number,
  event: number,
  ref: RawRef,
  code: TileCode,
  lockedRefs: Iterable<string>,
  seed: number,
): { output: TenhouLog; changes: AutoChange[] } {
  const decodedRound = decodeMatch(log).rounds[round]!
  const finalState = decodedRound.snapshots.at(-1)!
  const trace = Object.values(finalState.tiles).find((tile) => refKey(tile.acquisitionRef) === refKey(ref))
  if (!trace) throw new Error('差替え対象の物理牌を追跡できません')
  if (new Set(lockedRefs).has(refKey(ref))) throw new Error('この牌の取得元は固定されています')
  if (trace.code === code) return { output: log, changes: [] }
  const result = solveEdit(log, {
    type: 'tile',
    round,
    event: Math.max(event, trace.acquiredAt),
    tileId: trace.id,
    code,
  }, { lockedRefs, seed })
  if (!result.ok || !result.output) throw new Error(result.conflict ?? `${tileLabel(code)}への差替えに失敗しました`)
  return { output: result.output, changes: result.changes }
}

interface TurnHandSnapshot {
  event: number
  entries: Array<{ ref: RawRef; key: string; code: TileCode }>
  discardedRef: RawRef
  rawDiscardRef: RawRef
  incomingRef?: RawRef
  tsumogiri: boolean
  reach: boolean
  meldCount: number
}

function handAfterDiscard(log: TenhouLog, round: number, seat: Seat, turn: number): TurnHandSnapshot {
  const decodedRound = decodeMatch(log).rounds[round]
  if (!decodedRound) throw new Error('指定された局がありません')
  const finalState = decodedRound.snapshots.at(-1)!
  const river = finalState.rivers[seat]![turn - 1]
  if (!river) throw new Error(`${finalState.names[seat]}の${turn}巡目の打牌がありません`)
  const state = snapshotAt(decodedRound, river.eventIndex)
  const discarded = finalState.tiles[river.tileId]
  if (!discarded) throw new Error(`${turn}巡目の打牌を物理牌まで追跡できません`)
  const priorDiscardEvent = turn > 1 ? finalState.rivers[seat]![turn - 2]?.eventIndex ?? -1 : -1
  const incoming = decodedRound.events
    .filter((candidate) =>
      (candidate.type === 'draw' || candidate.type === 'rinshan-draw')
      && candidate.actor === seat
      && candidate.index > priorDiscardEvent
      && candidate.index < river.eventIndex
      && candidate.tileId)
    .at(-1)
  return {
    event: river.eventIndex,
    entries: state.hands[seat]!.map((id) => {
      const tile = state.tiles[id]!
      return { ref: tile.acquisitionRef, key: refKey(tile.acquisitionRef), code: tile.code }
    }),
    discardedRef: discarded.acquisitionRef,
    rawDiscardRef: river.rawRef,
    incomingRef: incoming?.tileId ? state.tiles[incoming.tileId]?.acquisitionRef : undefined,
    tsumogiri: river.tsumogiri,
    reach: river.reach,
    meldCount: state.melds[seat]!.length,
  }
}

function removeOneCode(codes: TileCode[], code: TileCode): boolean {
  const index = codes.indexOf(code)
  if (index < 0) return false
  codes.splice(index, 1)
  return true
}

function chooseBreakHonor(log: TenhouLog, round: number, desired: TileCode[], incoming: TileCode): TileCode {
  const finalState = decodeMatch(log).rounds[round]!.snapshots.at(-1)!
  const counts = new Map<number, number>()
  Object.values(finalState.tiles).forEach((tile) => {
    const kind = normalizeTile(tile.code)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  })
  const honors = [41, 42, 43, 44, 45, 46, 47] as TileCode[]
  const available = honors.filter((code) => code !== incoming && (counts.get(normalizeTile(code)) ?? 0) < 4)
  return available.find((code) => !desired.includes(code)) ?? available[0]
    ?? (() => { throw new Error('直前巡目を崩すための未使用字牌がありません') })()
}

function carryCopiedReach(
  log: TenhouLog,
  round: number,
  seat: Seat,
  source: TurnHandSnapshot,
  target: TurnHandSnapshot,
  desired: TileCode[],
  changes: AutoChange[],
): void {
  if (!isTenpai(desired, source.meldCount)) {
    throw new Error('コピー元のリーチ手牌を聴牌として確認できません')
  }
  const stream = getRoundSection(log.log[round]!, 'discard', seat)
  const targetIndex = target.rawDiscardRef.index
  stream.forEach((item, index) => {
    if (index === targetIndex || typeof item !== 'string' || !/^r(?:60|\d{2})$/.test(item)) return
    const after = Number(item.slice(1))
    stream[index] = after
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: { round, section: 'discard', seat, index },
      before: item,
      after,
      reason: 'COPY HANDでコピー元のリーチをコピー先へ移すため、元の宣言を解除',
    })
  })
  const before = stream[targetIndex]
  if (before === undefined || (typeof before === 'string' && parseMeldString(before))) {
    throw new Error('コピー先のリーチ宣言牌を設定できません')
  }
  const rawCode = typeof before === 'string' && before.startsWith('r') ? Number(before.slice(1)) : before
  if (typeof rawCode !== 'number') throw new Error('コピー先のリーチ宣言牌を認識できません')
  const after = `r${rawCode}`
  stream[targetIndex] = after
  changes.push({
    id: `change-${changes.length + 1}`,
    kind: 'automatic',
    ref: { round, section: 'discard', seat, index: targetIndex },
    before,
    after,
    reason: 'COPY HANDで再現した同一聴牌手を固定したまま、コピー元のリーチをコピー先へ移動',
  })
  for (let index = targetIndex + 1; index < stream.length; index += 1) {
    const item = stream[index]!
    if (typeof item === 'string') {
      const meld = parseMeldString(item)
      if (meld && meld.type !== 'ankan') throw new Error(`リーチ後の${meld.type}は維持できません`)
      continue
    }
    if (item === 60) continue
    stream[index] = 60
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: { round, section: 'discard', seat, index },
      before: item,
      after: 60,
      reason: 'COPY HANDで移したリーチ後の手牌交換を防ぐため、後続打牌をツモ切りへ補正',
    })
  }
}

function copyHandAtTurn(
  log: TenhouLog,
  round: number,
  seat: Seat,
  fromTurn: number,
  toTurn: number,
  activeLocks: Set<string>,
  seed: number,
  carryReach: boolean,
): { output: TenhouLog; changes: AutoChange[]; signature: string[] } {
  if (toTurn < 2) throw new Error('コピー先は、直前巡目を作れる2巡目以降を指定してください')
  let source = handAfterDiscard(log, round, seat, fromTurn)
  let desired = source.entries.map((entry) => entry.code).sort((a, b) => a - b)
  if (carryReach && !isTenpai(desired, source.meldCount)) {
    const state = decodeMatch(log).rounds[round]!.snapshots.at(-1)!
    const reachTurns = state.rivers[seat]!
      .map((river, index) => river.reach ? index + 1 : undefined)
      .filter((turn): turn is number => turn !== undefined)
    if (reachTurns.length !== 1) {
      throw new Error(`${fromTurn}巡目のコピー元手牌は非聴牌で、代わりに使える元リーチ巡目を一意に特定できません`)
    }
    source = handAfterDiscard(log, round, seat, reachTurns[0]!)
    desired = source.entries.map((entry) => entry.code).sort((a, b) => a - b)
    if (!isTenpai(desired, source.meldCount)) {
      throw new Error(`${reachTurns[0]}巡目の元リーチ手牌を聴牌として確認できません`)
    }
  }
  let target = handAfterDiscard(log, round, seat, toTurn)
  if (source.entries.length !== target.entries.length) {
    throw new Error('副露数が異なる巡目間では手牌をコピーできません')
  }
  if (!target.incomingRef) throw new Error(`${toTurn}巡目に通常のツモがないため、直前巡目と異なる手牌を作れません`)
  const incomingKey = refKey(target.incomingRef)
  const wasTsumogiri = target.tsumogiri && incomingKey === refKey(target.discardedRef)
  const outgoing = wasTsumogiri
    ? target.entries.find((entry) => !activeLocks.has(entry.key) && desired.includes(entry.code))
      ?? target.entries.find((entry) => !activeLocks.has(entry.key))
    : undefined
  if (wasTsumogiri && !outgoing) {
    throw new Error(`${toTurn}巡目を手出しへ変換できる未固定の手牌がありません`)
  }
  const incomingCurrent = target.entries.find((entry) => entry.key === incomingKey)?.code
  if (!wasTsumogiri && !incomingCurrent) throw new Error(`${toTurn}巡目のツモ牌が打牌後の手牌にありません`)
  const incomingDesired = outgoing && desired.includes(outgoing.code)
    ? outgoing.code
    : incomingCurrent && desired.includes(incomingCurrent) ? incomingCurrent : desired[0]!
  const breakHonor = chooseBreakHonor(log, round, desired, incomingDesired)
  let output = log
  const changes: AutoChange[] = []

  let applied = applySet(
    output,
    round,
    target.event,
    outgoing?.ref ?? target.discardedRef,
    breakHonor,
    activeLocks,
    seed,
  )
  output = applied.output
  changes.push(...applied.changes)

  target = handAfterDiscard(output, round, seat, toTurn)
  const incomingRef = target.incomingRef
  if (!incomingRef) throw new Error('コピー先巡目のツモ牌を差替え後に追跡できません')
  applied = applySet(output, round, target.event, incomingRef, incomingDesired, activeLocks, seed)
  output = applied.output
  changes.push(...applied.changes)

  if (wasTsumogiri) {
    const before = readRawRef(output, target.rawDiscardRef)
    const after: RawTile = typeof before === 'string' && before.startsWith('r')
      ? `r${breakHonor}`
      : breakHonor
    writeRawRef(output, target.rawDiscardRef, after)
    changes.push({
      id: `change-${changes.length + 1}`,
      kind: 'automatic',
      ref: target.rawDiscardRef,
      before,
      after,
      reason: `${toTurn}巡目のツモ切りを手出しへ変え、直前巡目だけを${tileLabel(breakHonor)}で崩すため補正`,
    })
  }
  activeLocks.add(incomingKey)

  for (let step = 0; step <= desired.length; step += 1) {
    target = handAfterDiscard(output, round, seat, toTurn)
    const remaining = [...desired]
    const unlocked: typeof target.entries = []
    for (const entry of target.entries) {
      if (!activeLocks.has(entry.key)) {
        unlocked.push(entry)
        continue
      }
      if (!removeOneCode(remaining, entry.code)) {
        throw new Error('固定済みのコピー先手牌がコピー元の牌姿と競合しています')
      }
    }
    const surplus: typeof target.entries = []
    for (const entry of unlocked) {
      if (removeOneCode(remaining, entry.code)) activeLocks.add(entry.key)
      else surplus.push(entry)
    }
    if (!remaining.length) {
      if (surplus.length) throw new Error('コピー先手牌の枚数が一致しません')
      if (carryReach) carryCopiedReach(output, round, seat, source, target, desired, changes)
      const signature = target.entries
        .map((entry) => `${entry.key}=${entry.code}`)
        .sort()
      return { output, changes, signature }
    }
    const entry = surplus[0]
    const code = remaining[0]
    if (!entry || !code) throw new Error('コピー元の手牌をコピー先へ割り当てられません')
    applied = applySet(output, round, target.event, entry.ref, code, activeLocks, seed + step + 1)
    output = applied.output
    changes.push(...applied.changes)
    activeLocks.add(entry.key)
  }
  throw new Error('手牌コピーの差替え回数が上限を超えました')
}

function executeActions(
  input: TenhouLog,
  round: number,
  event: number,
  self: Seat,
  actions: ScriptAction[],
  lockedRefs: Iterable<string>,
  seed: number,
): { output: TenhouLog; changes: AutoChange[] } {
  const refs = actions.map((action) => {
    if (action.kind === 'lock-self-hand-all') return []
    if (action.kind === 'set') return [locationRef(input, round, event, self, action.location)]
    if (action.kind === 'swap') return [
      locationRef(input, round, event, self, action.first),
      locationRef(input, round, event, self, action.second),
    ]
    if (action.kind === 'meld-add') return [locationRef(input, round, event, self, action.source)]
    if (action.kind === 'reach' && action.turn) return []
    if (action.kind === 'reach' && action.before) {
      return [locationRef(input, round, event, self, action.before)]
    }
    return []
  })
  let output = structuredClone(input)
  const changes: AutoChange[] = []
  const activeLocks = new Set(lockedRefs)
  let handInvariant: string[] | undefined
  const turnHandInvariants: Array<{ seat: Seat; turn: number; signature: string[] }> = []

  actions.forEach((action, index) => {
    try {
      if (action.kind === 'lock-self-hand-all') {
        const snapshot = selfHandSnapshot(output, round, event, self)
        snapshot.refs.forEach((key) => activeLocks.add(key))
        handInvariant ??= snapshot.signature
      } else if (action.kind === 'set') {
        const result = applySet(output, round, event, refs[index]![0]!, action.code, activeLocks, seed)
        output = result.output
        changes.push(...result.changes)
      } else if (action.kind === 'swap') {
        const [first, second] = refs[index]!
        if (activeLocks.has(refKey(first!))) throw new Error('SWAPの交換元は固定されています')
        if (activeLocks.has(refKey(second!))) throw new Error('SWAPの交換先は固定されています')
        const firstCode = codeAtRef(input, round, first!)
        const secondCode = codeAtRef(input, round, second!)
        let result = applySet(output, round, event, first!, secondCode, activeLocks, seed)
        output = result.output
        changes.push(...result.changes)
        result = applySet(output, round, event, second!, firstCode, activeLocks, seed)
        output = result.output
        changes.push(...result.changes)
      } else if (action.kind === 'copy-hand') {
        const actor = resolveSeat(action.actor, self)
        const next = actions[index + 1]
        const carryReach = next?.kind === 'reach'
          && next.enabled
          && next.turn === action.toTurn
          && resolveSeat(next.actor, self) === actor
        const result = copyHandAtTurn(
          output,
          round,
          actor,
          action.fromTurn,
          action.toTurn,
          activeLocks,
          seed,
          carryReach,
        )
        output = result.output
        changes.push(...result.changes)
        turnHandInvariants.push({ seat: actor, turn: action.toTurn, signature: result.signature })
      } else if (action.kind === 'meld-add') {
        const actor = resolveSeat(action.actor, self)
        const target = resolveSeat(action.source.seat, self)
        if (actor === target) throw new Error('自分の河牌を鳴くことはできません')
        if (action.meldType === 'chi' && target !== ((actor + 3) % 4)) {
          throw new Error('チーできるのは上家の河牌だけです')
        }
        const sourceRef = refs[index]![0]!
        const state = decodeMatch(output).rounds[round]!.snapshots.at(-1)!
        const sourceRiver = state.rivers[target]!.find((river) => {
          const trace = state.tiles[river.tileId]!
          return refKey(trace.acquisitionRef) === refKey(sourceRef)
        })
        if (!sourceRiver) throw new Error('鳴く河牌を追跡できません')
        const calledIndex = action.codes.findIndex((code) => sameTileKind(code, sourceRiver.code))
        if (calledIndex < 0) throw new Error('指定した副露形に、鳴く河牌と同じ牌が含まれていません')
        const result = solveScriptEdit(output, {
          type: 'meld-add',
          round,
          event: sourceRiver.eventIndex,
          actor,
          meldType: action.meldType,
          forced: { codes: action.codes, calledIndex, target },
        }, activeLocks, seed)
        output = result.output
        changes.push(...result.changes)
      } else if (action.kind === 'meld-remove') {
        const actor = resolveSeat(action.actor, self)
        const decodedRound = decodeMatch(output).rounds[round]!
        const state = decodedRound.snapshots.at(-1)!
        const meld = state.melds[actor]![action.index - 1]
        if (!meld) throw new Error(`${action.actor}の副露${action.index}がありません`)
        const result = solveScriptEdit(output, {
          type: 'meld-remove',
          round,
          event: decodedRound.events.length - 1,
          actor,
          meldId: meld.id,
        }, activeLocks, seed)
        output = result.output
        changes.push(...result.changes)
      } else {
        const actor = resolveSeat(action.actor, self)
        let reachEvent = Math.min(event, decodeMatch(output).rounds[round]!.events.length - 1)
        if (action.before) {
          const decisionSeat = resolveSeat(action.before.seat, self)
          const decisionRef = refs[index]![0]!
          const state = decodeMatch(output).rounds[round]!.snapshots.at(-1)!
          const decision = state.rivers[decisionSeat]!.find((item) =>
            refKey(state.tiles[item.tileId]!.acquisitionRef) === refKey(decisionRef))
          if (!decision) throw new Error('基準打牌の巡目を追跡できません')
          const priorDiscard = state.rivers[actor]!
            .filter((item) => item.eventIndex < decision.eventIndex)
            .at(-1)
          if (!priorDiscard) throw new Error(`${action.actor}には基準打牌より前のリーチ宣言牌がありません`)
          reachEvent = priorDiscard.eventIndex
        } else if (action.turn) {
          const state = decodeMatch(output).rounds[round]!.snapshots.at(-1)!
          const river = state.rivers[actor]![action.turn - 1]
          if (!river) throw new Error('リーチ宣言牌の巡目を追跡できません')
          reachEvent = river.eventIndex
        }
        const result = solveScriptEdit(output, {
          type: 'reach', round, event: reachEvent, actor, enabled: action.enabled,
        }, activeLocks, seed)
        output = result.output
        changes.push(...result.changes)
      }
      assertSelfHandInvariant(output, round, event, self, handInvariant)
      turnHandInvariants.forEach((invariant) => {
        assertTurnHandInvariant(output, round, invariant.seat, invariant.turn, invariant.signature)
      })
    } catch (error) {
      throw new Error(`${action.line}行目: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return { output, changes }
}

function singleRoundLog(log: TenhouLog, round: number): TenhouLog {
  return parseTenhouLog({ ...structuredClone(log), log: [structuredClone(log.log[round]!)] })
}

function moveChangeRound(change: AutoChange, round: number): AutoChange {
  const move = (ref: RawRef): RawRef => ({ ...ref, round })
  return {
    ...change,
    ref: move(change.ref),
    related: change.related?.map(move),
  }
}

function locksForSingleRound(lockedRefs: Iterable<string>, round: number): string[] {
  return [...lockedRefs].flatMap((key) => {
    const score = key.match(/^score:(\d+):(\d+)$/)
    if (score) return Number(score[1]) === round ? [`score:0:${score[2]}`] : []
    const raw = key.match(/^(\d+):(deal|draw|discard|dora|ura):(.*)$/)
    if (raw) return Number(raw[1]) === round ? [`0:${raw[2]}:${raw[3]}`] : []
    return [key]
  })
}

export function executePaifuScript(
  input: TenhouLog,
  script: string,
  options: { round: number; event: number; self: Seat; lockedRefs?: Iterable<string>; seed?: number },
): ScriptExecutionResult {
  const parsed = parsePaifuScript(script)
  const seed = options.seed ?? 20260726
  let output = parsed.keepOnly ? singleRoundLog(input, options.round) : structuredClone(input)
  const activeRound = parsed.keepOnly ? 0 : options.round
  const activeLocks = parsed.keepOnly
    ? locksForSingleRound(options.lockedRefs ?? [], options.round)
    : [...(options.lockedRefs ?? [])]
  const changes: AutoChange[] = []
  const sceneErrors: ScriptSceneError[] = []

  if (parsed.actions.length) {
    const applied = executeActions(
      output,
      activeRound,
      options.event,
      options.self,
      parsed.actions,
      activeLocks,
      seed,
    )
    output = applied.output
    changes.push(...applied.changes)
  }

  const inserted: RawRound[] = []
  parsed.scenes.forEach((scene, sceneIndex) => {
    if (scene.errors.length) {
      sceneErrors.push({ name: scene.name, message: scene.errors.join(' / ') })
      return
    }
    try {
      const source = singleRoundLog(input, options.round)
      const applied = executeActions(
        source,
        0,
        options.event,
        options.self,
        scene.actions,
        locksForSingleRound(options.lockedRefs ?? [], options.round),
        seed + sceneIndex,
      )
      const insertedRound = activeRound + 1 + inserted.length
      inserted.push(structuredClone(applied.output.log[0]!))
      changes.push(...applied.changes.map((change) => moveChangeRound(change, insertedRound)))
    } catch (error) {
      sceneErrors.push({
        name: scene.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
  if (inserted.length) output.log.splice(activeRound + 1, 0, ...inserted)
  output = parseTenhouLog(output)

  return {
    output,
    changes,
    sceneCount: inserted.length,
    sceneErrors,
    commandCount: Number(parsed.keepOnly) + parsed.actions.length + parsed.scenes.reduce((sum, scene) => sum + scene.actions.length, 0),
    keepOnly: parsed.keepOnly,
  }
}

export function tileScriptLabel(code: TileCode): string {
  const internal = toMajiangTile(code)
  return `${internal[1]}${internal[0]}(${tileLabel(code)})`
}

export function stateTileCodes(state: RoundState, ids: string[]): TileCode[] {
  return ids.map((id) => state.tiles[id]!.code)
}
