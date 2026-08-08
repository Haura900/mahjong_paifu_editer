import { Bot, Check, Clipboard, Play, Sparkles, X } from 'lucide-react'
import { useRef, useState } from 'react'

const EXAMPLE = '上家の7巡目、打4pを10巡目、14巡目にそれぞれずらした場合の局面を作って。'

async function copyText(text: string, textarea?: HTMLTextAreaElement | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    textarea?.focus()
    textarea?.select()
    document.execCommand('copy')
  }
}

export function ScriptDialog({
  onClose,
  onBuildPrompt,
  onExecute,
}: {
  onClose: () => void
  onBuildPrompt: (instruction: string) => string
  onExecute: (script: string) => string | undefined
}) {
  const [instruction, setInstruction] = useState('')
  const [prompt, setPrompt] = useState('')
  const [script, setScript] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const build = () => {
    if (!instruction.trim()) return
    setPrompt(onBuildPrompt(instruction))
    setCopied(false)
  }

  const execute = () => {
    setError(undefined)
    const message = onExecute(script)
    if (message) setError(message)
  }

  return (
    <div className="dialog-backdrop">
      <section className="script-dialog" role="dialog" aria-modal="true" aria-labelledby="script-dialog-title">
        <header>
          <div>
            <span className="eyebrow">AI PROMPT &amp; PAIFU SCRIPT</span>
            <h2 id="script-dialog-title">AI・テキスト編集</h2>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose}><X /></button>
        </header>

        <div className="script-dialog-grid">
          <section className="prompt-builder-pane">
            <div className="script-section-title"><Bot size={17} /><div><strong>1. AIに渡すテキストを作る</strong><span>盤面・余り字牌・仕様を自動で付け足します</span></div></div>
            <label htmlFor="ai-instruction">加工したい内容</label>
            <textarea
              id="ai-instruction"
              className="instruction-input"
              value={instruction}
              onChange={(change) => setInstruction(change.target.value)}
              placeholder={EXAMPLE}
            />
            <button type="button" className="primary-action build-prompt-button" disabled={!instruction.trim()} onClick={build}>
              <Sparkles size={16} /> AI用テキストを生成
            </button>
            {prompt && (
              <div className="generated-prompt">
                <div><strong>生成したテキスト</strong><span>ChatGPT等へそのまま貼り付け</span></div>
                <textarea ref={promptRef} readOnly value={prompt} aria-label="AIに渡すテキスト" />
                <button
                  type="button"
                  onClick={() => void copyText(prompt, promptRef.current).then(() => {
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1800)
                  })}
                >
                  {copied ? <Check size={15} /> : <Clipboard size={15} />}
                  {copied ? 'コピー済み' : 'テキストをコピー'}
                </button>
              </div>
            )}
          </section>

          <section className="script-runner-pane">
            <div className="script-section-title"><Play size={17} /><div><strong>2. 返ってきたスクリプトを実行</strong><span>コードフェンスが付いていても除去して実行できます</span></div></div>
            <label htmlFor="paifu-script">牌譜編集スクリプト</label>
            <textarea
              id="paifu-script"
              className="script-input"
              value={script}
              onChange={(change) => setScript(change.target.value)}
              placeholder={'KEEP_ONLY\nSCENE "上家の4pを10巡目へ"\nSET KAMI RIVER 7 1z\nSET KAMI RIVER 10 4p\nEND'}
            />
            {error && <p className="script-error" role="alert">{error}</p>}
            <div className="script-safety-note">実行結果は1回の変更として記録され、「元に戻す」でまとめて取り消せます。</div>
            <button type="button" className="primary-action run-script-button" disabled={!script.trim()} onClick={execute}>
              <Play size={16} /> スクリプトを実行
            </button>
          </section>
        </div>
      </section>
    </div>
  )
}
