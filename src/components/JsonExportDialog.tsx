import { AlertTriangle, Check, Clipboard, Download, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function JsonExportDialog({
  text,
  title = '編集済みJSONをコピー',
  analysis,
  onClose,
  onSave,
}: {
  text: string
  title?: string
  analysis?: { name: string; eastOneWind: string }
  onClose: () => void
  onSave: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      textareaRef.current?.select()
      document.execCommand('copy')
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="dialog-backdrop">
      <section className="json-export-dialog" role="dialog" aria-modal="true" aria-labelledby="json-export-title">
        <header>
          <div>
            <span className="eyebrow">COPY COMPATIBLE JSON</span>
            <h2 id="json-export-title">{title}</h2>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose}><X /></button>
        </header>
        {analysis ? (
          <div className="analysis-reminder">
            <UserRound size={19} />
            <div>
              <strong>分析視点: {analysis.name}（東1局では{analysis.eastOneWind}）</strong>
              <span>東1局がこのJSONから削除されていても、名前順から復元したこの風を使います。</span>
            </div>
          </div>
        ) : (
          <div className="analysis-reminder is-missing">
            <AlertTriangle size={19} />
            <div>
              <strong>分析ユーザーが未指定です</strong>
              <span>閉じて画面上部の「分析ユーザー」から対象者を選んでください。</span>
            </div>
          </div>
        )}
        <p className="send-reminder">
          <AlertTriangle size={15} />
          牌譜を送信するときは、分析対象のユーザー名と「東1局では何家か」を必ず入力してください。
        </p>
        <p>下のJSONはすでに選択されています。そのままコピーして、任意の場所へ貼り付けてください。</p>
        <textarea ref={textareaRef} readOnly value={text} aria-label="編集済み牌譜JSON" />
        <footer>
          <button type="button" onClick={onSave}><Download size={16} /> ファイルにも保存</button>
          <button type="button" className="primary-action" onClick={() => void copy()}>
            {copied ? <Check size={16} /> : <Clipboard size={16} />}
            {copied ? 'コピー済み・視点も忘れずに' : 'クリップボードへコピー'}
          </button>
        </footer>
      </section>
    </div>
  )
}
