import { parseTenhouLog, refKey } from './codec'
import { decodeMatch, snapshotAt } from './replay'
import { solveEdit } from './solver'
import { fromMajiangTile, sameTileKind, tileLabel, toMajiangTile } from './tile'
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
- MELD_ADD <席> PON <牌> FROM <捨てた席> RIVER <巡目>
                                      指定河牌を鳴いてポンを追加する。必要な対子は自動補正する。
- MELD_ADD <席> CHI <牌1> <牌2> <牌3> FROM <捨てた席> RIVER <巡目>
                                      指定河牌を鳴いてチーを追加する。チーは上家からのみ。
- MELD_REMOVE <席> <副露番号>      表示中の副露を1始まりの番号で解除する。
- REACH <席> ON BEFORE <基準席> RIVER <巡目>
                                      基準打牌より前にある指定席の最後の打牌でリーチする。打牌判断用の局面ではこちらを優先する。
- REACH <席> ON [AT <巡目>]        リーチを追加する。ATはリーチ者自身の河巡目。非聴牌ならその地点で自動聴牌補正する。
- REACH <席> OFF                   その席のリーチを解除する。
- SCENE "名前" ～ END              現在局を元に独立した案を作り、現在局の直後へ追加する。
- SCENE内で失敗した案はその案だけを破棄してエラーを表示し、後続のSCENEは続けて実行する。
- SCENE外の命令は現在局そのものへ適用する。SCENEは最大20個、命令は全体で最大200個。

例:
KEEP_ONLY
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

type ScriptAction = SetAction | SwapAction | MeldAddAction | MeldRemoveAction | ReachAction

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
  const refs = actions.map((action) => {
    if (action.kind === 'set') return [locationRef(input, round, event, self, action.location)]
    if (action.kind === 'swap') return [
      locationRef(input, round, event, self, action.first),
      locationRef(input, round, event, self, action.second),
    ]
    if (action.kind === 'meld-add') return [locationRef(input, round, event, self, action.source)]
    if (action.kind === 'reach' && action.turn) {
      return [locationRef(input, round, event, self, {
        kind: 'player', seat: action.actor, area: 'river', index: action.turn,
      })]
    }
    if (action.kind === 'reach' && action.before) {
      return [locationRef(input, round, event, self, action.before)]
    }
    return []
  })
  let output = structuredClone(input)
  const changes: AutoChange[] = []

  actions.forEach((action, index) => {
    try {
      if (action.kind === 'set') {
        const result = applySet(output, round, event, refs[index]![0]!, action.code, lockedRefs, seed)
        output = result.output
        changes.push(...result.changes)
      } else if (action.kind === 'swap') {
        const [first, second] = refs[index]!
        const firstCode = codeAtRef(input, round, first!)
        const secondCode = codeAtRef(input, round, second!)
        let result = applySet(output, round, event, first!, secondCode, lockedRefs, seed)
        output = result.output
        changes.push(...result.changes)
        result = applySet(output, round, event, second!, firstCode, lockedRefs, seed)
        output = result.output
        changes.push(...result.changes)
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
        }, lockedRefs, seed)
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
        }, lockedRefs, seed)
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
          const reachRef = refs[index]![0]!
          const state = decodeMatch(output).rounds[round]!.snapshots.at(-1)!
          const river = state.rivers[actor]!.find((item) =>
            refKey(state.tiles[item.tileId]!.acquisitionRef) === refKey(reachRef))
          if (!river) throw new Error('リーチ宣言牌の巡目を追跡できません')
          reachEvent = river.eventIndex
        }
        const result = solveScriptEdit(output, {
          type: 'reach', round, event: reachEvent, actor, enabled: action.enabled,
        }, lockedRefs, seed)
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
  let output = parsed.keepOnly ? singleRoundLog(input, options.round) : structuredClone(input)
  const activeRound = parsed.keepOnly ? 0 : options.round
  const activeLocks = parsed.keepOnly
    ? [...(options.lockedRefs ?? [])].flatMap((key) => {
        const score = key.match(/^score:(\d+):(\d+)$/)
        if (score) return Number(score[1]) === options.round ? [`score:0:${score[2]}`] : []
        const raw = key.match(/^(\d+):(deal|draw|discard|dora|ura):(.*)$/)
        if (raw) return Number(raw[1]) === options.round ? [`0:${raw[2]}:${raw[3]}`] : []
        return [key]
      })
    : options.lockedRefs ?? []
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
      const applied = executeActions(source, 0, options.event, options.self, scene.actions, [], seed + sceneIndex)
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
