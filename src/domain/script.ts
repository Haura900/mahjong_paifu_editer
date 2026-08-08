import { parseTenhouLog, refKey } from './codec'
import { decodeMatch, snapshotAt } from './replay'
import { solveEdit } from './solver'
import { fromMajiangTile, tileLabel, toMajiangTile } from './tile'
import type {
  AutoChange,
  RawRef,
  RawRound,
  RoundState,
  Seat,
  TenhouLog,
  TileCode,
} from './types'

export const PAIFU_SCRIPT_SPEC = `牌譜編集スクリプト v1
- 1行に1命令。空行と # から始まるコメントは無視する。
- 牌は 1m-9m / 1p-9p / 1s-9s / 1z-7z。赤5は 0m / 0p / 0s。
- 席は SELF / SHIMO / TOIMEN / KAMI（自分・下家・対面・上家）、または EAST / SOUTH / WEST / NORTH。
- 巡目・位置番号は1始まり。
- SET <席> RIVER <巡目> <牌>       河の牌を差し替える。
- SET <席> HAND <位置> <牌>        現在表示中の手牌を差し替える。
- SET <席> DRAW <巡目> <牌>        指定席のツモ列を差し替える。
- SET DORA <位置> <牌>             ドラ表示牌を差し替える。
- SET URA <位置> <牌>              裏ドラ表示牌を差し替える。
- SWAP <場所> WITH <場所>          2つの物理牌を交換する。場所の書式はSETの牌より前と同じ。
- SCENE "名前" ～ END              現在局を元に独立した案を作り、現在局の直後へ追加する。
- SCENE外の命令は現在局そのものへ適用する。SCENEは最大20個、命令は全体で最大200個。

例:
SCENE "上家の4pを10巡目へ"
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

type ScriptAction = SetAction | SwapAction

interface Scene {
  name: string
  actions: ScriptAction[]
}

export interface ParsedPaifuScript {
  actions: ScriptAction[]
  scenes: Scene[]
}

export interface ScriptExecutionResult {
  output: TenhouLog
  changes: AutoChange[]
  sceneCount: number
  commandCount: number
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
  const result: ParsedPaifuScript = { actions: [], scenes: [] }
  let current: Scene | undefined
  let commandCount = 0

  input.split(/\r?\n/).forEach((rawLine, offset) => {
    const line = offset + 1
    const source = rawLine.trim()
    if (!source || source.startsWith('#')) return
    if (/^SCENE\b/i.test(source)) {
      if (current) scriptError(line, 'SCENEの中にSCENEは作れません')
      const match = source.match(/^SCENE\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i)
      const name = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
      if (!name) scriptError(line, 'SCENE名を指定してください')
      current = { name, actions: [] }
      result.scenes.push(current)
      if (result.scenes.length > 20) scriptError(line, 'SCENEは20個までです')
      return
    }
    if (/^END$/i.test(source)) {
      if (!current) scriptError(line, '対応するSCENEがありません')
      if (!current.actions.length) scriptError(line, 'SCENEに命令がありません')
      current = undefined
      return
    }

    const tokens = source.split(/\s+/)
    const target = current?.actions ?? result.actions
    if (tokens[0]?.toUpperCase() === 'SET') {
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
    } else {
      scriptError(line, `命令「${tokens[0]}」を認識できません`)
    }
    commandCount += 1
    if (commandCount > 200) scriptError(line, '命令は全体で200個までです')
  })

  if (current) throw new Error(`SCENE「${current.name}」のENDがありません`)
  if (!result.actions.length && !result.scenes.length) throw new Error('実行する命令がありません')
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

function executeActions(
  input: TenhouLog,
  round: number,
  event: number,
  self: Seat,
  actions: ScriptAction[],
  lockedRefs: Iterable<string>,
  seed: number,
): { output: TenhouLog; changes: AutoChange[] } {
  const refs = actions.map((action) => action.kind === 'set'
    ? [locationRef(input, round, event, self, action.location)]
    : [
        locationRef(input, round, event, self, action.first),
        locationRef(input, round, event, self, action.second),
      ])
  let output = structuredClone(input)
  const changes: AutoChange[] = []

  actions.forEach((action, index) => {
    try {
      if (action.kind === 'set') {
        const result = applySet(output, round, event, refs[index]![0]!, action.code, lockedRefs, seed)
        output = result.output
        changes.push(...result.changes)
      } else {
        const [first, second] = refs[index]!
        const firstCode = codeAtRef(input, round, first!)
        const secondCode = codeAtRef(input, round, second!)
        let result = applySet(output, round, event, first!, secondCode, lockedRefs, seed)
        output = result.output
        changes.push(...result.changes)
        result = applySet(output, round, event, second!, firstCode, lockedRefs, seed)
        output = result.output
        changes.push(...result.changes)
      }
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

export function executePaifuScript(
  input: TenhouLog,
  script: string,
  options: { round: number; event: number; self: Seat; lockedRefs?: Iterable<string>; seed?: number },
): ScriptExecutionResult {
  const parsed = parsePaifuScript(script)
  const seed = options.seed ?? 20260726
  let output = structuredClone(input)
  const changes: AutoChange[] = []

  if (parsed.actions.length) {
    const applied = executeActions(
      output,
      options.round,
      options.event,
      options.self,
      parsed.actions,
      options.lockedRefs ?? [],
      seed,
    )
    output = applied.output
    changes.push(...applied.changes)
  }

  const inserted: RawRound[] = []
  parsed.scenes.forEach((scene, sceneIndex) => {
    const source = singleRoundLog(input, options.round)
    const applied = executeActions(source, 0, options.event, options.self, scene.actions, [], seed + sceneIndex)
    const insertedRound = options.round + 1 + sceneIndex
    inserted.push(structuredClone(applied.output.log[0]!))
    changes.push(...applied.changes.map((change) => moveChangeRound(change, insertedRound)))
  })
  if (inserted.length) output.log.splice(options.round + 1, 0, ...inserted)
  output = parseTenhouLog(output)

  return {
    output,
    changes,
    sceneCount: parsed.scenes.length,
    commandCount: parsed.actions.length + parsed.scenes.reduce((sum, scene) => sum + scene.actions.length, 0),
  }
}

export function tileScriptLabel(code: TileCode): string {
  const internal = toMajiangTile(code)
  return `${internal[1]}${internal[0]}(${tileLabel(code)})`
}

export function stateTileCodes(state: RoundState, ids: string[]): TileCode[] {
  return ids.map((id) => state.tiles[id]!.code)
}
