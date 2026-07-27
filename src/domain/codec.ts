import { isTileCode } from './tile'
import type {
  Diagnostic,
  MeldType,
  RawRef,
  RawRound,
  RawSection,
  RawTile,
  Seat,
  TenhouLog,
  TileCode,
} from './types'

export class CodecError extends Error {
  readonly diagnostics: Diagnostic[]

  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message)
    this.name = 'CodecError'
    this.diagnostics = diagnostics
  }
}

function diagnostic(message: string, round = -1, seat?: Seat, ref?: RawRef): Diagnostic {
  return {
    code: 'INVALID_INPUT',
    severity: 'error',
    message,
    round,
    seat,
    ref,
  }
}

export function parseTenhouLog(input: string | unknown): TenhouLog {
  let value: unknown = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new CodecError(`JSONを解析できません: ${detail}`, [diagnostic(detail)])
    }
  }

  const errors: Diagnostic[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodecError('トップレベルはJSONオブジェクトである必要があります', [
      diagnostic('トップレベルがオブジェクトではありません'),
    ])
  }

  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.name) || candidate.name.length !== 4 || candidate.name.some((name) => typeof name !== 'string')) {
    errors.push(diagnostic('name は4人分の文字列配列である必要があります'))
  }
  if (!candidate.rule || typeof candidate.rule !== 'object' || Array.isArray(candidate.rule)) {
    errors.push(diagnostic('rule がありません'))
  } else {
    const rule = candidate.rule as Record<string, unknown>
    const display = String(rule.disp ?? '')
    if (display.includes('三') || rule.player === 3) {
      errors.push(diagnostic('三人麻雀の牌譜は未対応です。四人麻雀の牌譜を開いてください'))
    }
  }
  if (!Array.isArray(candidate.log)) {
    errors.push(diagnostic('log は局配列である必要があります'))
  } else {
    candidate.log.forEach((round, roundIndex) => {
      validateRawRound(round, roundIndex, errors)
    })
  }
  if (errors.length) throw new CodecError(errors[0]!.message, errors)
  return structuredClone(candidate) as TenhouLog
}

function validateRawRound(value: unknown, round: number, errors: Diagnostic[]): void {
  if (!Array.isArray(value) || value.length !== 17) {
    errors.push(diagnostic(`局${round + 1}: 17要素の配列ではありません`, round))
    return
  }
  const header = value[0]
  if (!Array.isArray(header) || header.length !== 3 || header.some((item) => !Number.isInteger(item))) {
    errors.push(diagnostic(`局${round + 1}: 局番号・本場・供託が不正です`, round))
  }
  const scores = value[1]
  if (!Array.isArray(scores) || scores.length !== 4 || scores.some((score) => !Number.isFinite(score))) {
    errors.push(diagnostic(`局${round + 1}: 開始点は4人分の数値が必要です`, round))
  }
  for (const sectionIndex of [2, 3]) {
    const values = value[sectionIndex]
    if (!Array.isArray(values) || values.some((tile) => !isTileCode(tile))) {
      errors.push(diagnostic(`局${round + 1}: ドラ配列${sectionIndex - 1}に不正な牌があります`, round))
    }
  }
  for (let seat = 0; seat < 4; seat += 1) {
    const base = 4 + seat * 3
    const hand = value[base]
    if (!Array.isArray(hand) || hand.length !== 13) {
      errors.push(diagnostic(`局${round + 1}・${seatName(seat as Seat)}: 配牌は13枚必要です`, round, seat as Seat))
    } else {
      hand.forEach((tile, index) => {
        if (!isTileCode(tile)) {
          errors.push(diagnostic(
            `局${round + 1}・${seatName(seat as Seat)}・配牌[${index}]: 不正な牌コード ${String(tile)}`,
            round,
            seat as Seat,
            { round, section: 'deal', seat: seat as Seat, index },
          ))
        }
      })
    }
    for (const [offset, section] of [[1, 'draw'], [2, 'discard']] as const) {
      const stream = value[base + offset]
      if (!Array.isArray(stream)) {
        errors.push(diagnostic(`局${round + 1}・${seatName(seat as Seat)}: ${section}配列がありません`, round, seat as Seat))
        continue
      }
      stream.forEach((item, index) => {
        if (typeof item === 'number') {
          if (section === 'discard' && item === 60) return
          if (!isTileCode(item)) {
            errors.push(diagnostic(
              `局${round + 1}・${seatName(seat as Seat)}・${section}[${index}]: 不正な牌コード ${item}`,
              round,
              seat as Seat,
              { round, section, seat: seat as Seat, index },
            ))
          }
          return
        }
        if (typeof item !== 'string') {
          errors.push(diagnostic(`局${round + 1}・${seatName(seat as Seat)}・${section}[${index}]: 数値または副露文字列ではありません`, round, seat as Seat))
          return
        }
        if (section === 'discard' && /^r(?:60|[1-5][0-9])$/.test(item)) return
        const parsed = parseMeldString(item)
        if (!parsed) {
          errors.push(diagnostic(
            `局${round + 1}・${seatName(seat as Seat)}・${section}[${index}]: 未対応の圧縮表現「${item}」`,
            round,
            seat as Seat,
            { round, section, seat: seat as Seat, index },
          ))
        }
      })
    }
  }
  const result = value[16]
  const resultLabels = new Set([
    '和了',
    '流局',
    '流し満貫',
    '九種九牌',
    '四風連打',
    '四家立直',
    '三家和了',
    '四槓散了',
  ])
  if (!Array.isArray(result) || !resultLabels.has(String(result[0]))) {
    errors.push(diagnostic(`局${round + 1}: 結果の種別が天鳳形式の終局名ではありません`, round))
  }
}

export interface ParsedMeldString {
  type: MeldType
  marker: 'c' | 'p' | 'm' | 'a' | 'k'
  codes: TileCode[]
  calledIndex?: number
}

export function parseMeldString(value: string): ParsedMeldString | undefined {
  const markerMatch = value.match(/[cpkam]/)
  if (!markerMatch || markerMatch.index === undefined) return undefined
  const marker = markerMatch[0] as ParsedMeldString['marker']
  const compact = value.replace(marker, '')
  if (compact.length % 2 !== 0) return undefined
  const codes: TileCode[] = []
  for (let index = 0; index < compact.length; index += 2) {
    const code = Number(compact.slice(index, index + 2))
    if (!isTileCode(code)) return undefined
    codes.push(code)
  }
  const expected = marker === 'p' || marker === 'c' ? 3 : 4
  if (codes.length !== expected) return undefined
  const calledIndex = Math.floor(markerMatch.index / 2)
  const type: MeldType =
    marker === 'c' ? 'chi'
      : marker === 'p' ? 'pon'
        : marker === 'm' ? 'daiminkan'
          : marker === 'a' ? 'ankan'
            : 'kakan'
  return { type, marker, codes, calledIndex: marker === 'a' ? undefined : calledIndex }
}

export function meldTarget(actor: Seat, meld: ParsedMeldString): Seat | undefined {
  if (meld.type === 'ankan' || meld.type === 'kakan') return undefined
  if (meld.type === 'chi') return ((actor + 3) % 4) as Seat
  const index = meld.calledIndex ?? 0
  let relative: number
  if (meld.type === 'daiminkan') relative = index === 3 ? 1 : 3 - index
  else relative = 3 - index
  return ((actor + relative) % 4) as Seat
}

export function encodeMeld(
  type: MeldType,
  codes: TileCode[],
  calledIndex = 0,
): string {
  const marker = type === 'chi' ? 'c' : type === 'pon' ? 'p' : type === 'daiminkan' ? 'm' : type === 'ankan' ? 'a' : 'k'
  const tokens = codes.map(String)
  const position = type === 'ankan' ? Math.min(3, tokens.length) : Math.max(0, Math.min(calledIndex, tokens.length - 1))
  tokens[position] = `${marker}${tokens[position]}`
  return tokens.join('')
}

export function encodeTenhouLog(log: TenhouLog, pretty = false): string {
  return JSON.stringify(log, null, pretty ? 2 : undefined)
}

export function cloneLog(log: TenhouLog): TenhouLog {
  return structuredClone(log)
}

export function getRoundSection(round: RawRound, section: RawSection, seat?: Seat): RawTile[] {
  if (section === 'dora') return round[2]
  if (section === 'ura') return round[3]
  if (seat === undefined) throw new Error(`${section} にはプレイヤー番号が必要です`)
  const base = 4 + seat * 3
  if (section === 'deal') return round[base] as number[]
  if (section === 'draw') return round[base + 1] as RawTile[]
  return round[base + 2] as RawTile[]
}

export function readRawRef(log: TenhouLog, ref: RawRef): RawTile {
  const item = getRoundSection(log.log[ref.round]!, ref.section, ref.seat)[ref.index]
  if (ref.token === undefined) return item!
  if (typeof item !== 'string') throw new Error('副露文字列ではない参照にtokenが指定されています')
  const parsed = parseMeldString(item)
  if (!parsed) throw new Error(`副露文字列を解析できません: ${item}`)
  return parsed.codes[ref.token]!
}

export function writeRawRef(log: TenhouLog, ref: RawRef, value: RawTile): void {
  const section = getRoundSection(log.log[ref.round]!, ref.section, ref.seat)
  if (ref.token === undefined) {
    section[ref.index] = value
    return
  }
  const item = section[ref.index]
  if (typeof item !== 'string' || typeof value !== 'number' || !isTileCode(value)) {
    throw new Error('副露内の牌参照を書き換えられません')
  }
  const parsed = parseMeldString(item)
  if (!parsed) throw new Error(`副露文字列を解析できません: ${item}`)
  parsed.codes[ref.token] = value
  section[ref.index] = encodeMeld(parsed.type, parsed.codes, parsed.calledIndex)
}

export function refKey(ref: RawRef): string {
  return [ref.round, ref.section, ref.seat ?? '-', ref.index, ref.token ?? '-'].join(':')
}

export function seatName(seat: Seat): string {
  return ['東家', '南家', '西家', '北家'][seat]!
}
