import { Check, Clipboard, Download, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function JsonExportDialog({
  text,
  onClose,
  onSave,
}: {
  text: string
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
            <h2 id="json-export-title">編集済みJSONをコピー</h2>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose}><X /></button>
        </header>
        <p>下のJSONはすでに選択されています。そのままコピーして、任意の場所へ貼り付けてください。</p>
        <textarea ref={textareaRef} readOnly value={text} aria-label="編集済み牌譜JSON" />
        <footer>
          <button type="button" onClick={onSave}><Download size={16} /> ファイルにも保存</button>
          <button type="button" className="primary-action" onClick={() => void copy()}>
            {copied ? <Check size={16} /> : <Clipboard size={16} />}
            {copied ? 'コピーしました' : 'クリップボードへコピー'}
          </button>
        </footer>
      </section>
    </div>
  )
}
