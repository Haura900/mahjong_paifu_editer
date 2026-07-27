import { AlertTriangle, ArrowLeft, Check, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { normalizeTile, tileLabel } from '../domain/tile'
import type { EditRequest, ForcedMeldPlan, MeldType, RoundState, Seat, TileCode } from '../domain/types'
import { TileArtwork } from './TileView'

const BASE_TILES: TileCode[] = [
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 23, 24, 25, 26, 27, 28, 29,
  31, 32, 33, 34, 35, 36, 37, 38, 39,
  41, 42, 43, 44, 45, 46, 47,
]

const CHI_SEQUENCES: TileCode[][] = [1, 2, 3].flatMap((suit) =>
  [1, 2, 3, 4, 5, 6, 7].map((start) =>
    [start, start + 1, start + 2].map((rank) => (suit * 10 + rank) as TileCode)))

function meldLabel(type: MeldType): string {
  return { chi: 'チー', pon: 'ポン', daiminkan: '大明槓', ankan: '暗槓', kakan: '加槓' }[type]
}

export function MeldPlanDialog({
  state,
  request,
  onApply,
  onClose,
}: {
  state: RoundState
  request: Extract<EditRequest, { type: 'meld-add' }>
  onApply: (request: Extract<EditRequest, { type: 'meld-add' }>) => void
  onClose: () => void
}) {
  const existingPonKinds = useMemo(() =>
    state.melds[request.actor]!
      .filter((meld) => meld.type === 'pon')
      .map((meld) => normalizeTile(meld.codes[0]!)), [request.actor, state.melds])
  const [stage, setStage] = useState<'confirm' | 'configure'>('confirm')
  const [tile, setTile] = useState<TileCode>(
    (request.meldType === 'kakan' && existingPonKinds[0] ? existingPonKinds[0] : 11) as TileCode,
  )
  const [chiCodes, setChiCodes] = useState<TileCode[]>([11, 12, 13])
  const [calledIndex, setCalledIndex] = useState(1)
  const otherSeats = ([0, 1, 2, 3] as Seat[]).filter((seat) => seat !== request.actor)
  const [target, setTarget] = useState<Seat>(otherSeats[0]!)
  const lastDiscard = state.lastDiscard
    ? state.rivers[state.lastDiscard.seat]![state.lastDiscard.riverIndex]
    : undefined
  const lastDiscardText = lastDiscard && state.lastDiscard
    ? `${state.names[state.lastDiscard.seat]}が切った${tileLabel(lastDiscard.code)}`
    : '直前の打牌'
  const kakanWithoutPon = request.meldType === 'kakan' && existingPonKinds.length === 0

  const apply = () => {
    let forced: ForcedMeldPlan
    if (request.meldType === 'chi') {
      forced = {
        codes: chiCodes,
        calledIndex,
        target: ((request.actor + 3) % 4) as Seat,
      }
    } else if (request.meldType === 'pon' || request.meldType === 'daiminkan') {
      const count = request.meldType === 'pon' ? 3 : 4
      forced = { codes: Array<TileCode>(count).fill(tile), target }
    } else {
      forced = { codes: Array<TileCode>(4).fill(tile) }
    }
    onApply({ ...request, forced })
  }

  return (
    <div className="dialog-backdrop">
      <section className="meld-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="meld-plan-title">
        <header>
          <div>
            <span className="eyebrow">CREATE MELD WITH CORRECTIONS</span>
            <h2 id="meld-plan-title">{meldLabel(request.meldType)}の形を作る</h2>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose}><X /></button>
        </header>

        {stage === 'confirm' ? (
          <div className="meld-plan-confirm">
            <AlertTriangle />
            <div>
              <strong>{lastDiscardText}では{meldLabel(request.meldType)}できません</strong>
              <p>選択地点より前の打牌と手牌を自動で差し替えて、指定した副露を成立させることができます。後続の打牌・リーチ・和了結果も必要に応じて補正します。</p>
            </div>
          </div>
        ) : (
          <div className="meld-plan-config">
            {request.meldType === 'chi' ? (
              <>
                <div className="meld-plan-field">
                  <strong>作りたい順子</strong>
                  <div className="chi-sequence-grid">
                    {CHI_SEQUENCES.map((codes) => (
                      <button
                        type="button"
                        key={codes.join('-')}
                        className={codes.every((code, index) => code === chiCodes[index]) ? 'is-selected' : ''}
                        aria-label={`${codes.map(tileLabel).join('・')}を選ぶ`}
                        onClick={() => { setChiCodes(codes); setCalledIndex(1) }}
                      >
                        {codes.map((code) => <TileArtwork key={code} code={code} />)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="meld-plan-field">
                  <strong>上家から鳴く牌</strong>
                  <div className="called-tile-options">
                    {chiCodes.map((code, index) => (
                      <button
                        type="button"
                        key={`${code}-${index}`}
                        className={calledIndex === index ? 'is-selected' : ''}
                        onClick={() => setCalledIndex(index)}
                      >
                        <TileArtwork code={code} />
                        {tileLabel(code)}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="meld-plan-field">
                <strong>{request.meldType === 'kakan' ? '加槓する牌' : '副露する牌'}</strong>
                <div className="meld-tile-picker">
                  {BASE_TILES.map((code) => {
                    const unavailable = request.meldType === 'kakan'
                      && existingPonKinds.length > 0
                      && !existingPonKinds.includes(normalizeTile(code))
                    return (
                      <button
                        type="button"
                        key={code}
                        className={tile === code ? 'is-selected' : ''}
                        disabled={unavailable}
                        title={unavailable ? '現在のポンと同じ牌を選んでください' : tileLabel(code)}
                        aria-label={tileLabel(code)}
                        onClick={() => setTile(code)}
                      >
                        <TileArtwork code={code} />
                      </button>
                    )
                  })}
                </div>
                {kakanWithoutPon && <p className="meld-plan-note">同種のポンも過去の打牌と手牌を補正して作成してから、次の自摸で加槓します。</p>}
              </div>
            )}

            {(request.meldType === 'pon' || request.meldType === 'daiminkan') && (
              <div className="meld-plan-field">
                <strong>誰の打牌を鳴くか</strong>
                <div className="meld-target-options">
                  {otherSeats.map((seat) => (
                    <button
                      type="button"
                      key={seat}
                      className={target === seat ? 'is-selected' : ''}
                      onClick={() => setTarget(seat)}
                    >
                      <span>{['東', '南', '西', '北'][seat]}</span>
                      {state.names[seat]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <footer>
          {stage === 'confirm' ? (
            <>
              <button type="button" onClick={onClose}>キャンセル</button>
              <button type="button" className="primary-action" onClick={() => setStage('configure')}>変更を続ける</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setStage('confirm')}><ArrowLeft size={15} /> 戻る</button>
              <button type="button" className="primary-action" onClick={apply}><Check size={15} /> この形を作る</button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
