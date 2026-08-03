import { ChevronLeft, ChevronRight, ClipboardPaste, Copy, ListX, Pause, Play } from 'lucide-react'
import { roundLabel } from '../domain/replay'
import type { DecodedMatch } from '../domain/types'

interface TimelineProps {
  match: DecodedMatch
  round: number
  event: number
  playing: boolean
  onRound: (round: number) => void
  onEvent: (event: number) => void
  onPlaying: (playing: boolean) => void
  onKeepOnlyRound: () => void
  onCopyRound: () => void
  onPasteRound: () => void
}

export function Timeline({
  match,
  round,
  event,
  playing,
  onRound,
  onEvent,
  onPlaying,
  onKeepOnlyRound,
  onCopyRound,
  onPasteRound,
}: TimelineProps) {
  const decodedRound = match.rounds[round]!
  const currentEvent = decodedRound.events[event]
  return (
    <>
      <aside className="round-nav" aria-label="局選択">
        <div className="panel-heading">
          <span className="eyebrow">ROUND INDEX</span>
          <h2>全 {match.rounds.length} 局</h2>
        </div>
        <div className="round-actions" aria-label="選択局の操作">
          <button type="button" onClick={onCopyRound}><Copy size={14} /> この局をコピー</button>
          <button type="button" onClick={onPasteRound}><ClipboardPaste size={14} /> この局へペースト</button>
          <button type="button" className="danger" onClick={onKeepOnlyRound} disabled={match.rounds.length === 1}>
            <ListX size={14} /> この局だけ残す
          </button>
        </div>
        <div className="round-list">
          {match.rounds.map((item, index) => {
            const info = item.raw[0]
            const result = String(item.raw[16][0])
            const errors = item.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
            return (
              <button
                type="button"
                key={index}
                className={index === round ? 'is-current' : ''}
                onClick={() => onRound(index)}
              >
                <span className="round-index">{String(index + 1).padStart(2, '0')}</span>
                <span>
                  <strong>{roundLabel(info[0])}</strong>
                  <small>{info[1]}本場 · {result}</small>
                </span>
                {errors > 0 && <span className="error-count">{errors}</span>}
              </button>
            )
          })}
        </div>
      </aside>
      <div className="timeline-bar">
        <div className="event-summary">
          <span className="event-number">{String(event).padStart(3, '0')}</span>
          <span>
            <small>{currentEvent?.type ?? 'start'}</small>
            <strong>{currentEvent?.label ?? '局開始'}</strong>
          </span>
        </div>
        <div className="timeline-controls">
          <button type="button" aria-label="1イベント戻る" onClick={() => onEvent(Math.max(0, event - 1))} disabled={event === 0}>
            <ChevronLeft />
          </button>
          <button type="button" className="play-button" aria-label={playing ? '停止' : '自動再生'} onClick={() => onPlaying(!playing)}>
            {playing ? <Pause /> : <Play />}
          </button>
          <button type="button" aria-label="1イベント進む" onClick={() => onEvent(Math.min(decodedRound.events.length - 1, event + 1))} disabled={event >= decodedRound.events.length - 1}>
            <ChevronRight />
          </button>
        </div>
        <label className="timeline-slider">
          <span className="sr-only">巡目</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, decodedRound.events.length - 1)}
            value={event}
            onChange={(change) => onEvent(Number(change.target.value))}
          />
          <span>{event} / {decodedRound.events.length - 1}</span>
        </label>
      </div>
    </>
  )
}
