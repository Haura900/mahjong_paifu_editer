import { Lock, RotateCcw, Unlock } from 'lucide-react'
import { refKey } from '../domain/codec'
import { roundLabel } from '../domain/replay'
import type { AutoChange, Meld, RoundState, Seat } from '../domain/types'
import { TileView } from './TileView'

export type Selection =
  | { type: 'tile'; tileId: string }
  | { type: 'meld'; seat: Seat; meldId: string }
  | undefined

interface TableViewProps {
  state: RoundState
  viewpoint: Seat
  selection: Selection
  selectedSeat: Seat
  lockedRefs: Set<string>
  changes: AutoChange[]
  onSelect: (selection: Selection) => void
  onSelectSeat: (seat: Seat) => void
  onToggleLock: (key: string) => void
  onRotate: () => void
}

const POSITIONS = ['bottom', 'right', 'top', 'left'] as const

export function TableView({
  state,
  viewpoint,
  selection,
  selectedSeat,
  lockedRefs,
  changes,
  onSelect,
  onSelectSeat,
  onToggleLock,
  onRotate,
}: TableViewProps) {
  return (
    <section className="table-shell" aria-label="麻雀卓">
      <div className="table-felt">
        {([0, 1, 2, 3] as Seat[]).map((seat) => {
          const relative = (seat - viewpoint + 4) % 4
          const position = POSITIONS[relative]!
          return (
            <PlayerEdge
              key={seat}
              seat={seat}
              position={position}
              state={state}
              selected={selectedSeat === seat}
              selection={selection}
              lockedRefs={lockedRefs}
              changes={changes}
              onSelect={onSelect}
              onSelectSeat={onSelectSeat}
              onToggleLock={onToggleLock}
            />
          )
        })}
        <div className="table-center">
          <div className="center-wind">{roundLabel(state.roundNumber)}</div>
          <div className="center-meta">
            <span>{state.honba}本場</span>
            <span>供託 {state.riichiSticks}</span>
          </div>
          <div className="remaining">
            <span className="remaining-number">{state.wallRemaining}</span>
            <span>残り</span>
          </div>
          <div className="dora-row" aria-label="ドラ表示牌">
            <span>ドラ</span>
            {state.dora.map((id) => (
              <TileView
                key={id}
                tile={state.tiles[id]!}
                compact
                selected={selection?.type === 'tile' && selection.tileId === id}
                locked={lockedRefs.has(refKey(state.tiles[id]!.acquisitionRef))}
                changes={changes}
                onClick={() => onSelect({ type: 'tile', tileId: id })}
              />
            ))}
          </div>
          <button type="button" className="rotate-table-button" onClick={onRotate}>
            <RotateCcw size={14} /> 視点を回転
          </button>
        </div>
      </div>
    </section>
  )
}

interface PlayerEdgeProps {
  seat: Seat
  position: 'bottom' | 'right' | 'top' | 'left'
  state: RoundState
  selected: boolean
  selection: Selection
  lockedRefs: Set<string>
  changes: AutoChange[]
  onSelect: (selection: Selection) => void
  onSelectSeat: (seat: Seat) => void
  onToggleLock: (key: string) => void
}

function PlayerEdge({
  seat,
  position,
  state,
  selected,
  selection,
  lockedRefs,
  changes,
  onSelect,
  onSelectSeat,
  onToggleLock,
}: PlayerEdgeProps) {
  const direction = ['東', '南', '西', '北'][seat]
  return (
    <div className={`player-edge player-${position} ${selected ? 'is-active' : ''}`} data-seat={seat}>
      <button type="button" className="player-nameplate" onClick={() => onSelectSeat(seat)}>
        <span className="seat-wind">{direction}</span>
        <span className="player-name">{state.names[seat]}</span>
        <strong>{state.scores[seat]?.toLocaleString()}<small>点</small></strong>
        {state.reach[seat] && <span className="reach-badge">立直</span>}
      </button>
      <div className="hand-row" aria-label={`${state.names[seat]}の手牌`}>
        {state.hands[seat]!.map((id) => {
          const tile = state.tiles[id]!
          const key = refKey(tile.acquisitionRef)
          const locked = lockedRefs.has(key)
          return (
            <span className="tile-with-lock" key={id}>
              <TileView
                tile={tile}
                selected={selection?.type === 'tile' && selection.tileId === id}
                locked={locked}
                changes={changes}
                onClick={() => onSelect({ type: 'tile', tileId: id })}
              />
              {selection?.type === 'tile' && selection.tileId === id && (
                <button
                  type="button"
                  className="inline-lock"
                  title={locked ? '固定を解除' : 'この牌の取得元を固定'}
                  onClick={() => onToggleLock(key)}
                >
                  {locked ? <Unlock size={12} /> : <Lock size={12} />}
                </button>
              )}
            </span>
          )
        })}
      </div>
      <div className="meld-row" aria-label={`${state.names[seat]}の副露`}>
        {state.melds[seat]!.map((meld) => (
          <MeldGroup
            key={meld.id}
            meld={meld}
            state={state}
            selected={selection?.type === 'meld' && selection.meldId === meld.id}
            onClick={() => onSelect({ type: 'meld', seat, meldId: meld.id })}
          />
        ))}
      </div>
      <div className="river-grid" aria-label={`${state.names[seat]}の河`}>
        {state.rivers[seat]!.map((river, index) => (
          <TileView
            key={`${river.tileId}-${index}`}
            tile={state.tiles[river.tileId]!}
            compact
            called={river.called}
            reach={river.reach}
            selected={selection?.type === 'tile' && selection.tileId === river.tileId}
            locked={lockedRefs.has(refKey(state.tiles[river.tileId]!.acquisitionRef))}
            changes={changes}
            onClick={() => onSelect({ type: 'tile', tileId: river.tileId })}
          />
        ))}
      </div>
    </div>
  )
}

function MeldGroup({
  meld,
  state,
  selected,
  onClick,
}: {
  meld: Meld
  state: RoundState
  selected: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`meld-group ${selected ? 'is-selected' : ''}`} onClick={onClick}>
      {meld.tileIds.map((id, index) => (
        <span key={`${id}-${index}`} className={index === meld.calledIndex ? 'called-tile' : ''}>
          <TileView tile={state.tiles[id]!} compact disabled />
        </span>
      ))}
      <span className="meld-kind">{meld.type === 'chi' ? 'チー' : meld.type === 'pon' ? 'ポン' : meld.type === 'ankan' ? '暗槓' : meld.type === 'kakan' ? '加槓' : '大明槓'}</span>
    </button>
  )
}
