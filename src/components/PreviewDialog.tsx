import { AlertTriangle, Check, GitBranch, LoaderCircle, X } from 'lucide-react'
import type { EditRequest, SolverResult } from '../domain/types'

interface PreviewDialogProps {
  request: EditRequest
  result?: SolverResult
  progress: number
  progressMessage: string
  onApply: () => void
  onClose: () => void
  onCancel: () => void
}

export function PreviewDialog({
  request,
  result,
  progress,
  progressMessage,
  onApply,
  onClose,
  onCancel,
}: PreviewDialogProps) {
  const running = !result
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="preview-title">
        <header>
          <div>
            <span className="eyebrow">CHANGESET PREVIEW</span>
            <h2 id="preview-title">連鎖する変更を確認</h2>
          </div>
          <button type="button" aria-label="閉じる" onClick={running ? onCancel : onClose}><X /></button>
        </header>
        {running ? (
          <div className="solver-progress">
            <LoaderCircle className="spin" />
            <strong>{progressMessage}</strong>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            <p>ユーザー指定と固定値を維持したまま、変更コストが最小の合法解を探索しています。</p>
            <button type="button" onClick={onCancel}>探索をキャンセル</button>
          </div>
        ) : result.ok ? (
          <>
            <div className="preview-success">
              <Check />
              <div><strong>適用可能です</strong><span>{result.changes.length}件を1トランザクションとして変更します</span></div>
            </div>
            <div className="change-chain">
              {result.changes.map((change, index) => (
                <article key={change.id} className={change.kind}>
                  <div className="chain-index">{String(index + 1).padStart(2, '0')}</div>
                  <div>
                    <span>{change.kind === 'manual' ? '手動指定' : change.kind === 'automatic' ? '自動補正' : '後続局へ伝播'}</span>
                    <strong>{String(change.before) || '（なし）'} <GitBranch size={13} /> {String(change.after) || '（削除）'}</strong>
                    <p>{change.reason}</p>
                  </div>
                </article>
              ))}
            </div>
            <footer>
              <button type="button" onClick={onClose}>取り消す</button>
              <button type="button" className="primary-action" onClick={onApply}>この連鎖を適用</button>
            </footer>
          </>
        ) : (
          <>
            <div className="preview-error">
              <AlertTriangle />
              <div>
                <strong>この変更は適用できません</strong>
                <span>{result.conflict}</span>
              </div>
            </div>
            {result.diagnostics.length > 0 && (
              <div className="conflict-list">
                {result.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic.message}</p>)}
              </div>
            )}
            <footer><button type="button" className="primary-action" onClick={onClose}>戻る</button></footer>
          </>
        )}
        <span className="sr-only">{request.type}</span>
      </section>
    </div>
  )
}
