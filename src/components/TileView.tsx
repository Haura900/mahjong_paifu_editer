import { LockKeyhole } from 'lucide-react'
import { refKey } from '../domain/codec'
import { tileImageFilename, tileLabel, tileSuit } from '../domain/tile'
import type { AutoChange, TileTrace } from '../domain/types'

interface TileViewProps {
  tile: TileTrace
  selected?: boolean
  locked?: boolean
  disabled?: boolean
  called?: boolean
  reach?: boolean
  changes?: AutoChange[]
  onClick?: () => void
  compact?: boolean
}

export function TileArtwork({ code, className = '' }: { code: number; className?: string }) {
  return (
    <img
      className={`tile-artwork ${className}`}
      src={`${import.meta.env.BASE_URL}tiles/${tileImageFilename(code)}`}
      alt=""
      draggable={false}
      aria-hidden="true"
    />
  )
}

export function TileView({
  tile,
  selected,
  locked,
  disabled,
  called,
  reach,
  changes = [],
  onClick,
  compact,
}: TileViewProps) {
  const key = refKey(tile.acquisitionRef)
  const change = [...changes].reverse().find((item) => refKey(item.ref) === key)
  const changeClass = change?.kind === 'manual' ? 'is-manual' : change ? 'is-automatic' : ''
  const className = `mahjong-tile suit-${tileSuit(tile.code)} ${tile.red ? 'is-red' : ''} ${selected ? 'is-selected' : ''} ${called ? 'is-called' : ''} ${reach ? 'is-reach' : ''} ${changeClass} ${compact ? 'is-compact' : ''}`
  const title = [
    tileLabel(tile.code),
    `物理牌: ${tile.id}`,
    `由来: ${tile.origin === 'deal' ? '配牌' : tile.origin === 'draw' ? 'ツモ' : 'ドラ表示'}`,
    change ? `変更理由: ${change.reason}` : '',
    locked ? '固定済み' : '',
  ].filter(Boolean).join('\n')
  const face = (
    <>
      <TileArtwork code={tile.code} />
      {locked && <LockKeyhole className="tile-lock" aria-hidden="true" />}
      {change && <span className="change-dot" aria-hidden="true" />}
    </>
  )

  if (disabled && !onClick) {
    return (
      <span
        className={className}
        title={title}
        aria-label={tileLabel(tile.code)}
        role="img"
        data-tile-id={tile.id}
      >
        {face}
      </span>
    )
  }

  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={`${tileLabel(tile.code)}${locked ? '、固定済み' : ''}${change ? '、変更済み' : ''}`}
      onClick={onClick}
      disabled={disabled}
      data-tile-id={tile.id}
    >
      {face}
    </button>
  )
}
