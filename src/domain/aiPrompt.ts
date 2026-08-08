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

function decisionTimeline(state: RoundState, self: Seat): string {
  const ownRiver = state.rivers[self]!
  if (!ownRiver.length) return '自分の河がないため、基準にできる打牌はありません。'
  return ownRiver.map((discard, index) => {
    const limits = ([1, 2, 3] as const).map((offset) => {
      const seat = ((self + offset) % 4) as Seat
      const completed = state.rivers[seat]!.filter((item) => item.eventIndex < discard.eventIndex).length
      return `${RELATIVE_NAMES[offset]}=${completed || 'なし'}`
    }).join(' / ')
    return `- SELF RIVER ${index + 1} ${tile(discard.code)}: この打牌直前の相手河 ${limits}。危険度を変えるリーチは REACH <相手席> ON BEFORE SELF RIVER ${index + 1} を使う。`
  }).join('\n')
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
- SET <席> HAND は仕様として残しているが、AI生成では原則使用禁止。ユーザーが手牌そのものの変更を明示した場合だけ使用してよい。危険度、聴牌、待ち、受入れを作る目的は例外にしない。
- 相手手牌を丸ごと組み直すHAND命令列を出さない。REACHとMELD_ADDは必要な聴牌形・手牌を実行時に自動補正するため、その自動補正へ任せる。
- 一覧にない巡目や位置は指定しない。ただしユーザーが明示した将来の巡目は、現在局に存在する前提で指定してよい。
- 不明点を文章で回答せず、与えられた情報で最も保守的なスクリプトを返す。

# 「危険に見える局面」を作る共通基準
- 危険度は「相手の聴牌確率 × その牌が当たり牌である確率 × 放銃時の打点」で評価する。単に相手手牌へ対象牌や隣接牌を入れただけでは危険局面とみなさない。
- 下流の局面評価AIは相手の隠し手牌を評価材料にしない場合がある。危険度を変えるシーンではHANDを使わず、リーチ、副露、河、巡目、ドラ・役牌など自分から見える情報を変える。
- 相手の厳密な待ち形を隠し手牌で捏造しない。シーン名にも、HANDを使わなければ保証できない「3s嵌張待ち」などを断定して書かない。見える情報から「3sが危険に見える」状態を作る。
- リーチは最も明確な「見える危険信号」。REACHは非聴牌なら実行時に門前手を自動で聴牌へ補正するため、HANDによる事前調整は不要。副露済みの席にはリーチを付けない。
- 打牌判断を比較する局面では、リーチ・副露・河の変更が評価対象打牌より前に見えていなければ意味がない。リーチは原則 REACH <席> ON BEFORE SELF RIVER <対象巡目> を使う。ATはリーチ者自身の河の巡目であり、対象打牌以後のATを指定しない。
- 副露手は副露数だけで聴牌扱いにしない。巡目、2副露以上、最終副露後の手出し、役牌ポン、染め手、対々和などの役と打点を組み合わせる。必要なら MELD_ADD / MELD_REMOVE で見える脅威を変える。MELD_ADDに必要な手牌は実行時に自動補正される。下家の危険度を変える依頼では、下家のチー・ポン有無を優先的な比較軸にする。
- 対象牌の安全度は相手ごとに判定する。相手の現物はフリテンによりロンされない。スジは両面待ちだけを否定し、単騎・双碰・嵌張には当たり得る。4枚壁（ノーチャンス）は関連する両面を物理的に否定し、3枚壁（ワンチャンス）はそれより弱い根拠とする。
- 対象牌と比較牌の双方を評価する。字牌は常に安全ではない。相手の現物、3～4枚見えなら安全寄りだが、初牌・生牌で相手の役牌、ドラ、単騎・双碰候補なら危険になり得る。3s対發のような比較では、各相手に対する3sの現物・スジ・壁・リーチ/副露状況と、發の見え枚数・現物・役牌価値を別々に作り、実待ちをHANDで捏造しない。
- 打点の危険度も変える場合は、親、ドラ・赤、役牌ポン、混一色・清一色、対々和などを用い、シーン名に「誰が危険」「見える副露/リーチ」「比較牌の安全度」を短く含める。
- 複数案は、少なくとも「特定の一人だけが見える脅威」「下家だけが副露で危険」「複数人が危険」「対象牌は全員に安全で比較牌が危険」を分ける。指示対象と関係ない手牌の変更は避ける。

# 自分の打牌判断時点
以下は各SELF河牌を切る直前に、相手が何枚目まで河へ切っていたかを示す。危険度変更は必ず対象行より前に成立させる。
${decisionTimeline(state, self)}

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
