import { roundLabel } from './replay'
import { normalizeTile, tileSort } from './tile'
import { PAIFU_SCRIPT_SPEC, tileScriptLabel } from './script'
import type { RoundState, Seat, TileCode } from './types'

const HONORS: TileCode[] = [41, 42, 43, 44, 45, 46, 47]
const RELATIVE_NAMES = ['SELF', 'SHIMO', 'TOIMEN', 'KAMI'] as const
const JAPANESE_RELATIVE = ['自分', '下家', '対面', '上家'] as const

function code(state: RoundState, id: string): TileCode {
  return state.tiles[id]!.code
}

function tile(codeValue: TileCode): string {
  return tileScriptLabel(codeValue)
}

function tileList(codes: TileCode[]): string {
  return codes.length ? codes.map(tile).join(' ') : 'なし'
}

function seatLine(state: RoundState, self: Seat, seat: Seat): string {
  const relative = ((seat - self + 4) % 4) as 0 | 1 | 2 | 3
  return `${RELATIVE_NAMES[relative]}=${state.names[seat]}（${JAPANESE_RELATIVE[relative]}・${['東家', '南家', '西家', '北家'][seat]}）`
}

function handText(state: RoundState, seat: Seat): string {
  return tileList(state.hands[seat]!.map((id) => code(state, id)).sort(tileSort))
}

function riverText(state: RoundState, seat: Seat): string {
  const river = state.rivers[seat]!
  if (!river.length) return 'なし'
  return river.map((item, index) => {
    const flags = [item.reach ? 'リーチ' : '', item.tsumogiri ? 'ツモ切り' : '', item.called ? '鳴かれ' : '']
      .filter(Boolean)
    return `${index + 1}:${tile(item.code)}${flags.length ? `[${flags.join('・')}]` : ''}`
  }).join(' ')
}

function meldText(state: RoundState, seat: Seat): string {
  const melds = state.melds[seat]!
  if (!melds.length) return 'なし'
  return melds.map((meld) => `${meld.type}(${tileList(meld.codes)})`).join(' / ')
}

export function spareHonorTiles(state: RoundState, self: Seat): { code: TileCode; count: number }[] {
  const used = new Map<number, number>()
  const count = (codeValue: TileCode) => {
    const normalized = normalizeTile(codeValue)
    used.set(normalized, (used.get(normalized) ?? 0) + 1)
  }
  state.rivers.flat().forEach((item) => count(item.code))
  state.dora.forEach((id) => count(code(state, id)))
  state.hands[self]!.forEach((id) => count(code(state, id)))
  return HONORS
    .map((codeValue) => ({ code: codeValue, count: Math.max(0, 4 - (used.get(codeValue) ?? 0)) }))
    .filter((item) => item.count > 0)
}

export function buildAiEditPrompt({
  instruction,
  state,
  self,
  eventCount,
}: {
  instruction: string
  state: RoundState
  self: Seat
  eventCount: number
}): string {
  const seatOrder = ([0, 1, 2, 3] as Seat[]).map((offset) => ((self + offset) % 4) as Seat)
  const spare = spareHonorTiles(state, self)
    .map((item) => `${tile(item.code)} x${item.count}`)
    .join(' ')

  const board = seatOrder.map((seat) => {
    const relative = ((seat - self + 4) % 4) as 0 | 1 | 2 | 3
    return `## ${RELATIVE_NAMES[relative]} / ${JAPANESE_RELATIVE[relative]} / ${state.names[seat]} / ${['東家', '南家', '西家', '北家'][seat]}
- 手牌: ${handText(state, seat)}
- 河: ${riverText(state, seat)}
- 副露: ${meldText(state, seat)}`
  }).join('\n\n')

  return `あなたは麻雀牌譜編集スクリプトの生成担当です。以下の指示と局面だけを根拠に、実行可能なスクリプトを作ってください。

# ユーザーの指示
${instruction.trim()}

# 必ず守る既定ルール
- 最終回答はスクリプト本体だけにする。説明文やMarkdownのコードフェンスを付けない。
- 複数の局面案を求められた場合は、案ごとに SCENE ～ END を使い、各案を元の現在局から独立させる。
- 差替え用の牌が必要なら、下記の「余っている字牌」を極力優先する。
- 元の牌を別巡へ移すときは、元位置を余り字牌へSETし、移動先を元の牌へSETする形を優先する。
- 指示されていない変更は最小限にする。同じ場所へ矛盾する命令を出さない。
- 一覧にない巡目や位置は指定しない。ただしユーザーが明示した将来の巡目は、現在局に存在する前提で指定してよい。
- 不明点を文章で回答せず、与えられた情報で最も保守的なスクリプトを返す。

# 現在表示している局面
- 局: ${roundLabel(state.roundNumber)} ${state.honba}本場
- 表示イベント: ${state.eventIndex} / ${eventCount - 1}
- 自分: ${state.names[self]}（${['東家', '南家', '西家', '北家'][self]}）
- 席対応: ${seatOrder.map((seat) => seatLine(state, self, seat)).join(' / ')}
- ドラ表示牌: ${tileList(state.dora.map((id) => code(state, id)))}
- 裏ドラ表示牌: ${tileList(state.ura.map((id) => code(state, id)))}
- 残り山: ${state.wallRemaining}枚

${board}

# 余っている字牌
河・ドラ表示牌・自分の現在手牌に見えていない枚数です（他家手牌との重複は上の一覧で確認してください）。
${spare || 'なし'}

# スクリプト仕様
${PAIFU_SCRIPT_SPEC}
`
}
