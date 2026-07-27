export type Seat = 0 | 1 | 2 | 3
export type TileCode =
  | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19
  | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29
  | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39
  | 41 | 42 | 43 | 44 | 45 | 46 | 47
  | 51 | 52 | 53

export type RawTile = number | string
export type RawRound = [
  [number, number, number],
  number[],
  number[],
  number[],
  number[], RawTile[], RawTile[],
  number[], RawTile[], RawTile[],
  number[], RawTile[], RawTile[],
  number[], RawTile[], RawTile[],
  unknown[],
]

export interface TenhouLog {
  title: unknown
  name: string[]
  rule: Record<string, unknown>
  log: RawRound[]
  [key: string]: unknown
}

export type RawSection = 'deal' | 'draw' | 'discard' | 'dora' | 'ura'

export interface RawRef {
  round: number
  section: RawSection
  seat?: Seat
  index: number
  /** Index of the two-digit tile inside a meld string. */
  token?: number
}

export type EventType =
  | 'start'
  | 'draw'
  | 'discard'
  | 'reach-declare'
  | 'reach-accepted'
  | 'chi'
  | 'pon'
  | 'daiminkan'
  | 'ankan'
  | 'kakan'
  | 'rinshan-draw'
  | 'dora'
  | 'ron'
  | 'tsumo-win'
  | 'draw-game'
  | 'score'

export interface NormalizedEvent {
  id: string
  round: number
  index: number
  type: EventType
  actor?: Seat
  target?: Seat
  tile?: TileCode
  tileId?: string
  tsumogiri?: boolean
  reach?: boolean
  meld?: Meld
  rawRef?: RawRef
  label: string
  scoreDelta?: number[]
}

export interface TileTrace {
  id: string
  code: TileCode
  kind: number
  red: boolean
  origin: 'deal' | 'draw' | 'dora' | 'unknown'
  acquiredAt: number
  departedAt?: number
  location: 'hand' | 'river' | 'meld' | 'dora' | 'unknown'
  owner?: Seat
  acquisitionRef: RawRef
  references: RawRef[]
  manual?: boolean
  automatic?: boolean
  locked?: boolean
}

export interface RiverTile {
  tileId: string
  code: TileCode
  called: boolean
  reach: boolean
  tsumogiri: boolean
  rawRef: RawRef
  eventIndex: number
}

export type MeldType = 'chi' | 'pon' | 'daiminkan' | 'ankan' | 'kakan'

export interface Meld {
  id: string
  type: MeldType
  actor: Seat
  target?: Seat
  tileIds: string[]
  codes: TileCode[]
  calledIndex?: number
  raw: string
  rawRef: RawRef
  eventIndex: number
}

export interface Diagnostic {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  round: number
  event?: number
  seat?: Seat
  ref?: RawRef
}

export interface RoundState {
  round: number
  eventIndex: number
  roundNumber: number
  honba: number
  riichiSticks: number
  dealer: Seat
  scores: number[]
  names: string[]
  hands: string[][]
  rivers: RiverTile[][]
  melds: Meld[][]
  reach: boolean[]
  /** Number of completed kans by each player. A kakan counts once, not once per source pon. */
  kanCounts: number[]
  /** A passed winning shape blocks ron until the player's next non-reach discard. */
  temporaryFuriten: boolean[]
  /** Winning shapes offered by the latest discard; committed when play continues past it. */
  pendingRonPasses: boolean[]
  dora: string[]
  ura: string[]
  tiles: Record<string, TileTrace>
  wallRemaining: number
  turn?: Seat
  lastDraw?: { seat: Seat; tileId: string }
  lastDiscard?: { seat: Seat; riverIndex: number; tileId: string }
  diagnostics: Diagnostic[]
  streamCursors: {
    draws: number[]
    discards: number[]
  }
  ended: boolean
  result?: unknown[]
}

export interface DecodedRound {
  raw: RawRound
  events: NormalizedEvent[]
  snapshots: RoundState[]
  diagnostics: Diagnostic[]
}

export interface DecodedMatch {
  raw: TenhouLog
  rounds: DecodedRound[]
  diagnostics: Diagnostic[]
}

export interface AutoChange {
  id: string
  kind: 'manual' | 'automatic' | 'propagation'
  ref: RawRef
  before: RawTile
  after: RawTile
  reason: string
  related?: RawRef[]
}

export interface EditTransaction {
  id: string
  at: string
  label: string
  request: EditRequest
  before: TenhouLog
  after: TenhouLog
  changes: AutoChange[]
  seed: number
}

export interface ForcedMeldPlan {
  codes: TileCode[]
  calledIndex?: number
  target?: Seat
}

export type EditRequest =
  | { type: 'tile'; round: number; event: number; tileId: string; code: TileCode }
  | { type: 'meld-add'; round: number; event: number; actor: Seat; meldType: MeldType; forced?: ForcedMeldPlan }
  | { type: 'meld-remove'; round: number; event: number; actor: Seat; meldId: string }
  | { type: 'meld-change'; round: number; event: number; actor: Seat; meldId: string; meldType: MeldType }
  | { type: 'reach'; round: number; event: number; actor: Seat; enabled: boolean }
  | { type: 'score'; round: number; seat: Seat; score: number }

export interface SolverResult {
  ok: boolean
  output?: TenhouLog
  changes: AutoChange[]
  diagnostics: Diagnostic[]
  conflict?: string
}

export interface EditQueueEntry {
  id: string
  request: EditRequest
  label: string
  status: 'queued' | 'processing' | 'applied' | 'failed'
  progress: number
  message: string
  queuedAt: string
  completedAt?: string
  result?: SolverResult
}

export interface EditorProject {
  format: 'mahjong-paifu-editor-project'
  version: 1
  priorityVersion: 1
  seed: number
  original: TenhouLog
  current: TenhouLog
  transactions: EditTransaction[]
  redo: EditTransaction[]
  lockedRefs: string[]
  createdAt: string
  updatedAt: string
}
