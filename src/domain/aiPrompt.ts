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
- ユーザーが「他の局も残す」「全局を維持する」などと明示しない限り、スクリプトの先頭行を必ず KEEP_ONLY にする。
- KEEP_ONLYを省略してよいのは、他の局を残す指示が明示されている場合だけとする。
- 複数の局面案を求められた場合は、案ごとに SCENE ～ END を使い、各案を元の現在局から独立させる。
- 差替え用の牌が必要なら、下記の「余っている字牌」を極力優先する。
- 元の牌を別巡へ移すときは、元位置を余り字牌へSETし、移動先を元の牌へSETする形を優先する。
- 指示されていない変更は最小限にする。同じ場所へ矛盾する命令を出さない。
- 一覧にない巡目や位置は指定しない。ただしユーザーが明示した将来の巡目は、現在局に存在する前提で指定してよい。
- 不明点を文章で回答せず、与えられた情報で最も保守的なスクリプトを返す。

# 「危険に見える局面」を作る共通基準
- 危険度は「相手の聴牌確率 × その牌が当たり牌である確率 × 放銃時の打点」で評価する。単に相手手牌へ対象牌や隣接牌を入れただけでは危険局面とみなさない。
- 下流の局面評価AIは相手の隠し手牌を評価材料にしない場合がある。危険度を変えるシーンでは、相手手牌のSETだけに頼らず、リーチ、副露、河、巡目、ドラ・役牌など自分から見える情報を必ず変える。隠し手牌の変更は、その見える脅威の裏で合法な聴牌と実待ちを成立させるためにだけ使う。
- このプロンプトには全員の手牌があるため、推測より先に厳密な形を使う。最も危険なパターンは、相手を合法な聴牌にして、評価対象牌を実際のロン和了牌にする。必ず待ち形（両面・嵌張・辺張・双碰・単騎）を成立させ、相手自身の河による振聴も確認する。
- 次点の危険パターンとして一向聴を使う場合は、対象牌が有効牌になる根拠と受入れを手牌構成で作る。牌の近さだけを根拠にしない。
- リーチは門前聴牌が確定した最も明確な「見える危険信号」として REACH <席> ON を使う。副露済みの席にはリーチを付けない。
- 副露手は副露数だけで聴牌扱いにしない。巡目、2副露以上、最終副露後の手出し、役牌ポン、染め手、対々和などの役と打点を組み合わせる。必要なら MELD_ADD / MELD_REMOVE で見える脅威を変える。下家の危険度を変える依頼では、下家のチー・ポン有無を優先的な比較軸にする。
- 対象牌の安全度は相手ごとに判定する。相手の現物はフリテンによりロンされない。スジは両面待ちだけを否定し、単騎・双碰・嵌張には当たり得る。4枚壁（ノーチャンス）は関連する両面を物理的に否定し、3枚壁（ワンチャンス）はそれより弱い根拠とする。
- 対象牌と比較牌の双方を評価する。字牌は常に安全ではない。相手の現物、3～4枚見えなら安全寄りだが、初牌・生牌で相手の役牌、ドラ、単騎・双碰候補なら危険になり得る。今回のような3s対發では、各相手に対する3sの実待ちと、發の見え枚数・現物・役牌価値を別々に作る。
- 打点の危険度も変える場合は、親、ドラ・赤、役牌ポン、混一色・清一色、対々和などを用い、シーン名に「誰が聴牌」「対象牌の待ち」「見える副露/リーチ」「比較牌の安全度」を短く含める。
- 複数案は、少なくとも「特定の一人だけが対象牌待ち」「下家だけが副露聴牌」「複数人が対象牌待ち」「対象牌は全員に安全で比較牌が危険」を分ける。指示対象と関係ない手牌の変更は避ける。

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
