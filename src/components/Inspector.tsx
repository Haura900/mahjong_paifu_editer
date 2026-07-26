import { AlertTriangle, Check, GitBranch, LockKeyhole, Plus, Trash2, WandSparkles } from 'lucide-react'
import { refKey } from '../domain/codec'
import { ALL_TILE_CODES, normalizeTile, tileLabel } from '../domain/tile'
import type {
  AutoChange,
  Diagnostic,
  EditRequest,
  MeldType,
  RoundState,
  Seat,
} from '../domain/types'
import type { Selection } from './TableView'
import { TileArtwork, TileView } from './TileView'

interface InspectorProps {
  state: RoundState
  round: number
  event: number
  selection: Selection
  selectedSeat: Seat
  lockedRefs: Set<string>
  recentChanges: AutoChange[]
  diagnostics: Diagnostic[]
  onPreview: (request: EditRequest) => void
  onToggleLock: (key: string) => void
}

export function Inspector({
  state,
  round,
  event,
  selection,
  selectedSeat,
  lockedRefs,
  recentChanges,
  diagnostics,
  onPreview,
  onToggleLock,
}: InspectorProps) {
  const tile = selection?.type === 'tile' ? state.tiles[selection.tileId] : undefined
  const meld = selection?.type === 'meld'
    ? state.melds[selection.seat]!.find((item) => item.id === selection.meldId)
    : undefined
  const currentCounts = new Map<number, number>()
  for (const trace of Object.values(state.tiles)) currentCounts.set(trace.kind, (currentCounts.get(trace.kind) ?? 0) + 1)
  const allLockedForKind = (code: number) => {
    const matches = Object.values(state.tiles).filter((trace) => trace.kind === normalizeTile(code))
    return matches.length >= 4 && matches.every((trace) => lockedRefs.has(refKey(trace.acquisitionRef)))
  }

  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">EDIT INSPECTOR</span>
          <h2>{tile ? tileLabel(tile.code) : meld ? '副露を編集' : `${state.names[selectedSeat]}を編集`}</h2>
        </div>
        <span className="live-status"><span /> 検証中</span>
      </div>

      {tile ? (
        <>
          <section className="inspector-section selection-card">
            <TileView tile={tile} changes={recentChanges} disabled />
            <div>
              <strong>{tileLabel(tile.code)}</strong>
              <span>{tile.origin === 'deal' ? '配牌由来' : tile.origin === 'draw' ? `イベント ${tile.acquiredAt} のツモ由来` : '王牌の表示牌'}</span>
              <small>{tile.references.length - 1}件の後続参照</small>
            </div>
            <button
              type="button"
              className={lockedRefs.has(refKey(tile.acquisitionRef)) ? 'is-locked' : ''}
              onClick={() => onToggleLock(refKey(tile.acquisitionRef))}
            >
              <LockKeyhole size={15} />
              {lockedRefs.has(refKey(tile.acquisitionRef)) ? '固定中' : '固定'}
            </button>
          </section>
          <section className="inspector-section">
            <div className="section-title">
              <div>
                <h3>牌を交換</h3>
                <p>取得元と後続イベントまで追従します</p>
              </div>
              <WandSparkles size={17} />
            </div>
            <div className="tile-palette">
              {[
                ['萬子', ALL_TILE_CODES.filter((code) => Math.floor(code / 10) === 1 || code === 51)],
                ['筒子', ALL_TILE_CODES.filter((code) => Math.floor(code / 10) === 2 || code === 52)],
                ['索子', ALL_TILE_CODES.filter((code) => Math.floor(code / 10) === 3 || code === 53)],
                ['字牌', ALL_TILE_CODES.filter((code) => Math.floor(code / 10) === 4)],
              ].map(([label, codes]) => (
                <div className="palette-suit" key={label as string}>
                  <span>{label as string}</span>
                  <div>
                    {(codes as typeof ALL_TILE_CODES).map((code) => {
                      const unavailable = allLockedForKind(code)
                      const reason = code === tile.code
                        ? '現在と同じ牌です'
                        : unavailable
                          ? `${tileLabel(code)}4枚の取得元がすべて固定されています`
                          : `${tileLabel(code)}へ変更${(currentCounts.get(normalizeTile(code)) ?? 0) >= 4 ? '（4枚制約は交換で補正）' : ''}`
                      return (
                        <button
                          type="button"
                          key={code}
                          className={code >= 51 ? 'red-palette' : ''}
                          disabled={code === tile.code || unavailable}
                          title={reason}
                          aria-label={reason}
                          onClick={() => onPreview({ type: 'tile', round, event, tileId: tile.id, code })}
                        >
                          <TileArtwork code={code} />
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : meld ? (
        <section className="inspector-section">
          <div className="section-title">
            <div>
              <h3>{meld.type === 'chi' ? 'チー' : meld.type === 'pon' ? 'ポン' : meld.type === 'ankan' ? '暗槓' : meld.type === 'kakan' ? '加槓' : '大明槓'}</h3>
              <p>{meld.codes.map(tileLabel).join('・')}</p>
            </div>
          </div>
          {meld.type === 'pon' && (
            <button
              type="button"
              className="wide-action"
              onClick={() => onPreview({ type: 'meld-change', round, event, actor: meld.actor, meldId: meld.id, meldType: 'kakan' })}
            >
              <GitBranch size={16} /> 加槓へ変更
            </button>
          )}
          <button
            type="button"
            className="wide-action danger"
            onClick={() => onPreview({ type: 'meld-remove', round, event, actor: meld.actor, meldId: meld.id })}
          >
            <Trash2 size={16} /> この副露を削除
          </button>
        </section>
      ) : (
        <PlayerEditor
          state={state}
          round={round}
          event={event}
          seat={selectedSeat}
          onPreview={onPreview}
        />
      )}

      <section className="inspector-section">
        <div className="section-title">
          <div>
            <h3>検証レポート</h3>
            <p>この地点までのルール診断</p>
          </div>
          {diagnostics.some((item) => item.severity === 'error')
            ? <AlertTriangle className="danger-icon" size={18} />
            : <Check className="success-icon" size={18} />}
        </div>
        <div className="diagnostic-list">
          {diagnostics.length === 0 && <p className="empty-state"><Check size={14} /> 検出できる矛盾はありません</p>}
          {diagnostics.slice(-8).map((item, index) => (
            <article key={`${item.code}-${index}`} className={item.severity}>
              <strong>{item.code}</strong>
              <span>{item.message}</span>
            </article>
          ))}
        </div>
      </section>

      {recentChanges.length > 0 && (
        <section className="inspector-section reason-log">
          <div className="section-title">
            <div>
              <h3>直近の変更理由</h3>
              <p>{recentChanges.length}件の連鎖変更</p>
            </div>
            <GitBranch size={17} />
          </div>
          {recentChanges.map((change) => (
            <article key={change.id} className={change.kind}>
              <span>{change.kind === 'manual' ? '手動' : change.kind === 'automatic' ? '自動補正' : '伝播'}</span>
              <p>{change.reason}</p>
            </article>
          ))}
        </section>
      )}
    </aside>
  )
}

function PlayerEditor({
  state,
  round,
  event,
  seat,
  onPreview,
}: {
  state: RoundState
  round: number
  event: number
  seat: Seat
  onPreview: (request: EditRequest) => void
}) {
  const meldButtons: { type: MeldType; label: string }[] = [
    { type: 'chi', label: 'チー' },
    { type: 'pon', label: 'ポン' },
    { type: 'daiminkan', label: '大明槓' },
    { type: 'ankan', label: '暗槓' },
    { type: 'kakan', label: '加槓' },
  ]
  return (
    <>
      <section className="inspector-section">
        <div className="section-title">
          <div>
            <h3>副露を追加</h3>
            <p>河と手牌から合法な候補を探索</p>
          </div>
          <Plus size={17} />
        </div>
        <div className="meld-actions">
          {meldButtons.map(({ type, label }) => (
            <button type="button" key={type} onClick={() => onPreview({ type: 'meld-add', round, event, actor: seat, meldType: type })}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="inspector-section">
        <div className="section-title">
          <div>
            <h3>リーチ状態</h3>
            <p>門前・聴牌・持ち点を検証</p>
          </div>
        </div>
        <button
          type="button"
          className={`reach-toggle ${state.reach[seat] ? 'is-on' : ''}`}
          onClick={() => onPreview({ type: 'reach', round, event, actor: seat, enabled: !state.reach[seat] })}
        >
          <span />
          {state.reach[seat] ? 'リーチ成立中' : 'リーチなし'}
        </button>
      </section>
      <section className="inspector-section">
        <div className="section-title">
          <div>
            <h3>局開始点</h3>
            <p>変更すると固定境界になります</p>
          </div>
        </div>
        <ScoreEditor value={state.scores[seat]!} onApply={(score) => onPreview({ type: 'score', round, seat, score })} />
      </section>
    </>
  )
}

function ScoreEditor({ value, onApply }: { value: number; onApply: (value: number) => void }) {
  return (
    <form
      className="score-editor"
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        onApply(Number(data.get('score')))
      }}
    >
      <input type="number" name="score" min={0} step={100} defaultValue={value} key={value} aria-label="局開始点" />
      <button type="submit">変更・固定</button>
    </form>
  )
}
