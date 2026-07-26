import { AlertTriangle, Check, Clock3, GitBranch, LoaderCircle, X } from 'lucide-react'
import type { EditQueueEntry } from '../domain/types'

export function ChangeLogDrawer({
  entries,
  onClose,
}: {
  entries: EditQueueEntry[]
  onClose: () => void
}) {
  return (
    <aside className="change-log-drawer" role="dialog" aria-labelledby="change-log-title">
      <header>
        <div>
          <span className="eyebrow">BACKGROUND CHANGE LOG</span>
          <h2 id="change-log-title">変更ログ</h2>
        </div>
        <button type="button" aria-label="変更ログを閉じる" onClick={onClose}><X /></button>
      </header>
      <div className="change-log-summary">
        <span>{entries.filter((entry) => entry.status === 'applied').length}件 適用済み</span>
        <span>{entries.filter((entry) => entry.status === 'queued' || entry.status === 'processing').length}件 処理中</span>
      </div>
      <div className="change-log-list">
        {entries.length === 0 && (
          <p className="change-log-empty"><GitBranch size={18} /> 変更を行うと、自動補正の内容がここに記録されます。</p>
        )}
        {[...entries].reverse().map((entry) => (
          <article key={entry.id} className={`queue-entry is-${entry.status}`}>
            <div className="queue-entry-heading">
              <span className="queue-status-icon">
                {entry.status === 'processing' && <LoaderCircle className="spin" />}
                {entry.status === 'queued' && <Clock3 />}
                {entry.status === 'applied' && <Check />}
                {entry.status === 'failed' && <AlertTriangle />}
              </span>
              <div>
                <strong>{entry.label}</strong>
                <small>{entry.status === 'queued' ? '待機中' : entry.status === 'processing' ? entry.message : entry.status === 'applied' ? '適用しました' : '適用できませんでした'}</small>
              </div>
              <time>{new Date(entry.queuedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            </div>
            {(entry.status === 'queued' || entry.status === 'processing') && (
              <div className="queue-progress" aria-label={`${entry.progress}%`}>
                <span style={{ width: `${entry.progress}%` }} />
              </div>
            )}
            {entry.status === 'failed' && <p className="queue-conflict">{entry.result?.conflict}</p>}
            {entry.status === 'applied' && entry.result?.changes.map((change) => (
              <div className={`queue-change is-${change.kind}`} key={`${entry.id}-${change.id}`}>
                <span>{change.kind === 'manual' ? '手動' : change.kind === 'automatic' ? '自動' : '伝播'}</span>
                <p>{change.reason}</p>
              </div>
            ))}
          </article>
        ))}
      </div>
    </aside>
  )
}
