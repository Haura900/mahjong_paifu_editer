import { AlertTriangle, Check, Clipboard, Download, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function JsonExportDialog({
  text,
  url,
  title = '天鳳URL・互換JSONを書き出す',
  analysis,
  onClose,
  onSaveJson,
  onSaveUrl,
}: {
  text: string
  url?: string
  title?: string
  analysis?: { name: string; eastOneWind: string; seat: number }
  onClose: () => void
  onSaveJson: () => void
  onSaveUrl: () => void
}) {
  const urlRef = useRef<HTMLTextAreaElement>(null)
  const jsonRef = useRef<HTMLTextAreaElement>(null)
  const [copied, setCopied] = useState<'url' | 'json'>()

  useEffect(() => {
    const target = url ? urlRef.current : jsonRef.current
    target?.focus()
    target?.select()
  }, [url])

  const copy = async (value: string, target: HTMLTextAreaElement | null, kind: 'url' | 'json') => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      target?.select()
      document.execCommand('copy')
    }
    setCopied(kind)
    window.setTimeout(() => setCopied(undefined), 1800)
  }

  return (
    <div className="dialog-backdrop">
      <section className="json-export-dialog" role="dialog" aria-modal="true" aria-labelledby="json-export-title">
        <header>
          <div>
            <span className="eyebrow">TENHOU URL / COMPATIBLE JSON</span>
            <h2 id="json-export-title">{title}</h2>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose}><X /></button>
        </header>
        <div className="json-export-content">
          {analysis ? (
            <div className="analysis-reminder">
              <UserRound size={19} />
              <div>
                <strong>分析視点: {analysis.name}（東1局では{analysis.eastOneWind}）</strong>
                <span>席番号 tw={analysis.seat} をURLの # より前へ入れました。開いた時点でこの視点になります。</span>
              </div>
            </div>
          ) : (
            <div className="analysis-reminder is-missing">
              <AlertTriangle size={19} />
              <div>
                <strong>分析ユーザーが未指定です</strong>
                <span>閉じて画面上部の「分析ユーザー」から対象者を選ぶと、視点込みURLを作れます。</span>
              </div>
            </div>
          )}

          <section className="export-block">
            <h3>視点込み天鳳URL</h3>
            <p>天鳳でそのまま開けるURLです。分析席はURL内に含まれています。</p>
            <textarea
              ref={urlRef}
              className="tenhou-url-output"
              readOnly
              value={url ?? ''}
              placeholder="分析ユーザーを選ぶとURLが表示されます"
              aria-label="視点込み天鳳URL"
            />
            <div className="export-actions">
              <button type="button" disabled={!url} onClick={onSaveUrl}><Download size={16} /> URLをファイルに保存</button>
              <button
                type="button"
                className="primary-action"
                disabled={!url}
                onClick={() => url && void copy(url, urlRef.current, 'url')}
              >
                {copied === 'url' ? <Check size={16} /> : <Clipboard size={16} />}
                {copied === 'url' ? 'URLをコピーしました' : '天鳳URLをコピー'}
              </button>
            </div>
          </section>

          <section className="export-block compatible-json-block">
            <h3>互換JSON</h3>
            <p>従来どおり、JSON単体でのコピー・保存もできます。</p>
            <textarea ref={jsonRef} readOnly value={text} aria-label="編集済み牌譜JSON" />
            <div className="export-actions">
              <button type="button" onClick={onSaveJson}><Download size={16} /> JSONファイルに保存</button>
              <button type="button" onClick={() => void copy(text, jsonRef.current, 'json')}>
                {copied === 'json' ? <Check size={16} /> : <Clipboard size={16} />}
                {copied === 'json' ? 'JSONをコピーしました' : 'JSONをコピー'}
              </button>
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}
