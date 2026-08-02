import {
  Braces,
  ChevronDown,
  Download,
  FileInput,
  FileJson,
  FolderOpen,
  Info,
  ListTree,
  LoaderCircle,
  Redo2,
  RotateCcw,
  Save,
  ShieldCheck,
  Undo2,
  Upload,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import sampleUrl from '../sample.txt?url'
import { CodecError, encodeTenhouLog, parseTenhouLog } from './domain/codec'
import {
  applySolvedProjectEdit,
  createProject,
  deleteProjectRound,
  editRequestLabel,
  insertProjectRound,
  keepOnlyProjectRound,
  parseProject,
  redoProject,
  resetProject,
  serializeProject,
  toggleLock,
  undoProject,
} from './domain/project'
import { decodeMatch, snapshotAt } from './domain/replay'
import { solveEdit } from './domain/solver'
import type {
  EditorProject,
  EditQueueEntry,
  EditRequest,
  RawRound,
  Seat,
  SolverResult,
  TenhouLog,
} from './domain/types'
import { ChangeLogDrawer } from './components/ChangeLogDrawer'
import { Inspector } from './components/Inspector'
import { JsonExportDialog } from './components/JsonExportDialog'
import { MeldPlanDialog } from './components/MeldPlanDialog'
import { TableView, type Selection } from './components/TableView'
import { Timeline } from './components/Timeline'
import { readFileText, saveText } from './lib/files'

export function App() {
  const [project, setProject] = useState<EditorProject>()
  const [round, setRound] = useState(0)
  const [event, setEvent] = useState(0)
  const [viewpoint, setViewpoint] = useState<Seat>(0)
  const [selectedSeat, setSelectedSeat] = useState<Seat>(0)
  const [selection, setSelection] = useState<Selection>()
  const [playing, setPlaying] = useState(false)
  const [autoRotate, setAutoRotate] = useState(false)
  const [editQueue, setEditQueue] = useState<EditQueueEntry[]>([])
  const [activeJobId, setActiveJobId] = useState<string>()
  const [changeLogOpen, setChangeLogOpen] = useState(false)
  const [jsonExportOpen, setJsonExportOpen] = useState(false)
  const [meldPlanRequest, setMeldPlanRequest] = useState<Extract<EditRequest, { type: 'meld-add' }>>()
  const [justApplied, setJustApplied] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  const [roundClipboard, setRoundClipboard] = useState<RawRound>()
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const projectInputRef = useRef<HTMLInputElement>(null)
  const workerRef = useRef<Worker | undefined>(undefined)
  const projectRef = useRef<EditorProject | undefined>(undefined)
  const applyFlashTimerRef = useRef<number | undefined>(undefined)
  const sampleLoaded = useRef(false)

  projectRef.current = project

  const setCurrentProject = useCallback((next: EditorProject | undefined) => {
    projectRef.current = next
    setProject(next)
  }, [])

  const clearEditPipeline = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = undefined
    setActiveJobId(undefined)
    setEditQueue([])
    setMeldPlanRequest(undefined)
  }, [])

  const loadLog = useCallback((log: TenhouLog, label: string) => {
    const decoded = decodeMatch(log)
    clearEditPipeline()
    setCurrentProject(createProject(decoded.raw))
    setRound(0)
    setEvent(0)
    setViewpoint(decoded.rounds[0]?.snapshots[0]?.dealer ?? 0)
    setSelectedSeat(decoded.rounds[0]?.snapshots[0]?.dealer ?? 0)
    setSelection(undefined)
    setError(undefined)
    setNotice(`${label}を読み込みました（${decoded.rounds.length}局）`)
  }, [clearEditPipeline, setCurrentProject])

  const loadText = useCallback((text: string, label: string, projectFile = false) => {
    try {
      if (projectFile || (text.includes('"format"') && text.includes('mahjong-paifu-editor-project'))) {
        const loaded = parseProject(text)
        decodeMatch(loaded.current)
        clearEditPipeline()
        setCurrentProject(loaded)
        setRound(0)
        setEvent(0)
        setSelection(undefined)
        setError(undefined)
        setNotice(`${label}から編集履歴を復元しました`)
      } else {
        loadLog(parseTenhouLog(text), label)
      }
    } catch (caught) {
      if (caught instanceof CodecError) {
        setError(caught.diagnostics.map((item) => item.message).slice(0, 4).join(' / '))
      } else {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }, [clearEditPipeline, loadLog, setCurrentProject])

  useEffect(() => {
    if (sampleLoaded.current) return
    sampleLoaded.current = true
    fetch(sampleUrl)
      .then((response) => {
        if (!response.ok) throw new Error('sample.txtを取得できません')
        return response.text()
      })
      .then((text) => loadText(text, 'sample.txt'))
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [loadText])

  const decoded = useMemo(() => project ? decodeMatch(project.current) : undefined, [project])
  const decodedRound = decoded?.rounds[round]
  const state = decodedRound ? snapshotAt(decodedRound, event) : undefined
  const lockedRefs = useMemo(() => new Set(project?.lockedRefs ?? []), [project?.lockedRefs])
  const recentChanges = project?.transactions.at(-1)?.changes ?? []
  const processingEntries = useMemo(
    () => editQueue.filter((entry) => entry.status === 'queued' || entry.status === 'processing'),
    [editQueue],
  )
  const processingTileIds = useMemo(
    () => new Set(processingEntries.flatMap((entry) => entry.request.type === 'tile' ? [entry.request.tileId] : [])),
    [processingEntries],
  )
  const exportedJson = useMemo(() => project ? encodeTenhouLog(project.current) : '', [project])

  useEffect(() => {
    if (!playing || !decodedRound) return
    const timer = window.setInterval(() => {
      setEvent((current) => {
        if (current >= decodedRound.events.length - 1) {
          setPlaying(false)
          return current
        }
        return current + 1
      })
    }, 650)
    return () => window.clearInterval(timer)
  }, [playing, decodedRound])

  useEffect(() => {
    if (!autoRotate || state?.turn === undefined) return
    setViewpoint(state.turn)
  }, [autoRotate, state?.turn])

  useEffect(() => {
    if (!state || !selection) return
    if (selection.type === 'tile' && !state.tiles[selection.tileId]) setSelection(undefined)
    if (selection.type === 'meld' && !state.melds[selection.seat]!.some((meld) => meld.id === selection.meldId)) setSelection(undefined)
  }, [state, selection])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(undefined), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const enqueueEdit = useCallback((request: EditRequest) => {
    if (!projectRef.current) return
    const entry: EditQueueEntry = {
      id: crypto.randomUUID(),
      request,
      label: editRequestLabel(request),
      status: 'queued',
      progress: 4,
      message: '処理待ち',
      queuedAt: new Date().toISOString(),
    }
    setEditQueue((current) => [...current, entry])
    setNotice(`${entry.label}をバックグラウンド処理へ追加しました`)
  }, [])

  useEffect(() => {
    if (!project || activeJobId) return
    const job = editQueue.find((entry) => entry.status === 'queued')
    if (!job) return

    const baseProject = projectRef.current
    if (!baseProject) return
    const baseLog = baseProject.current
    const baseLocks = baseProject.lockedRefs.join('\u0000')
    setActiveJobId(job.id)
    setEditQueue((current) => current.map((entry) => entry.id === job.id
      ? { ...entry, status: 'processing', progress: 10, message: '物理牌と手順を追跡中' }
      : entry))

    const finish = (result: SolverResult) => {
      workerRef.current?.terminate()
      workerRef.current = undefined
      const latest = projectRef.current
      if (!latest) {
        setActiveJobId(undefined)
        return
      }
      if (latest.current !== baseLog || latest.lockedRefs.join('\u0000') !== baseLocks) {
        setEditQueue((current) => current.map((entry) => entry.id === job.id
          ? { ...entry, status: 'queued', progress: 4, message: '状態が変わったため再計算待ち' }
          : entry))
        setActiveJobId(undefined)
        return
      }
      const applied = applySolvedProjectEdit(latest, job.request, result)
      if (applied.result.ok) {
        setCurrentProject(applied.project)
        setEditQueue((current) => current.map((entry) => entry.id === job.id
          ? {
              ...entry,
              status: 'applied',
              progress: 100,
              message: '適用しました',
              completedAt: new Date().toISOString(),
              result: applied.result,
            }
          : entry))
        setJustApplied(true)
        if (applyFlashTimerRef.current) window.clearTimeout(applyFlashTimerRef.current)
        applyFlashTimerRef.current = window.setTimeout(() => setJustApplied(false), 720)
        setNotice(`${applied.result.changes.length}件の連鎖変更を適用しました`)
      } else {
        setEditQueue((current) => current.map((entry) => entry.id === job.id
          ? {
              ...entry,
              status: 'failed',
              progress: 100,
              message: '適用できませんでした',
              completedAt: new Date().toISOString(),
              result: applied.result,
            }
          : entry))
        setNotice('適用できない変更があります。変更ログで理由を確認できます')
      }
      setActiveJobId(undefined)
    }

    if (typeof Worker === 'undefined') {
      window.setTimeout(() => finish(solveEdit(baseLog, job.request, {
        lockedRefs: baseProject.lockedRefs,
        seed: baseProject.seed,
      })), 10)
      return
    }

    const worker = new Worker(new URL('./domain/solver.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (message: MessageEvent<{
      id: string
      type: 'progress' | 'result'
      progress?: number
      message?: string
      result?: SolverResult
    }>) => {
      if (message.data.id !== job.id) return
      if (message.data.type === 'progress') {
        setEditQueue((current) => current.map((entry) => entry.id === job.id
          ? {
              ...entry,
              progress: message.data.progress ?? entry.progress,
              message: message.data.message ?? entry.message,
            }
          : entry))
      } else if (message.data.result) {
        finish(message.data.result)
      }
    }
    worker.onerror = () => {
      finish(solveEdit(baseLog, job.request, {
        lockedRefs: baseProject.lockedRefs,
        seed: baseProject.seed,
      }))
    }
    worker.postMessage({
      id: job.id,
      log: baseLog,
      request: job.request,
      lockedRefs: baseProject.lockedRefs,
      seed: baseProject.seed,
    })
  }, [activeJobId, editQueue, project, setCurrentProject])

  useEffect(() => () => {
    workerRef.current?.terminate()
    if (applyFlashTimerRef.current) window.clearTimeout(applyFlashTimerRef.current)
  }, [])

  const openFile = async (file: File, isProject = false) => {
    const text = await readFileText(file)
    loadText(text, file.name, isProject || file.name.endsWith('.mjpe'))
  }

  const handleRound = (next: number) => {
    setRound(next)
    setEvent(0)
    setSelection(undefined)
    setPlaying(false)
    const dealer = decoded?.rounds[next]?.snapshots[0]?.dealer
    if (autoRotate && dealer !== undefined) setViewpoint(dealer)
  }

  const copyCurrentRound = () => {
    if (!project) return
    const source = project.current.log[round]
    if (!source) return
    setRoundClipboard(structuredClone(source))
    setNotice(`${round + 1}番目の局をコピーしました`)
  }

  const pasteRoundAfterCurrent = () => {
    if (!project || !roundClipboard) return
    try {
      clearEditPipeline()
      const insertAt = round + 1
      setCurrentProject(insertProjectRound(project, roundClipboard, insertAt))
      setRound(insertAt)
      setEvent(0)
      setSelection(undefined)
      setPlaying(false)
      setNotice(`コピーした局を${insertAt + 1}番目へ貼り付けました`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const deleteCurrentRound = () => {
    if (!project) return
    try {
      clearEditPipeline()
      const next = deleteProjectRound(project, round)
      const nextRound = Math.min(round, next.current.log.length - 1)
      setCurrentProject(next)
      setRound(nextRound)
      setEvent(0)
      setSelection(undefined)
      setPlaying(false)
      setNotice(`${round + 1}番目の局を削除しました`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const keepOnlyCurrentRound = () => {
    if (!project) return
    try {
      clearEditPipeline()
      setCurrentProject(keepOnlyProjectRound(project, round))
      setRound(0)
      setEvent(0)
      setSelection(undefined)
      setPlaying(false)
      setNotice(`${round + 1}番目の局だけを残しました`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const exportJsonFile = async () => {
    if (!project) return
    try {
      const method = await saveText('edited-paifu.json', exportedJson, '天鳳JSON牌譜')
      setNotice(method === 'direct' ? '編集済みJSONを保存しました' : '編集済みJSONをダウンロードしました')
    } catch {
      // User cancelled the platform picker.
    }
  }

  const exportProject = async () => {
    if (!project) return
    try {
      const method = await saveText('paifu-edit.mjpe', serializeProject(project), '牌譜工房 編集プロジェクト')
      setNotice(method === 'direct' ? '編集プロジェクトを保存しました' : '編集プロジェクトをダウンロードしました')
    } catch {
      // User cancelled the platform picker.
    }
  }

  if (!project || !decoded || !state || !decodedRound) {
    return (
      <main className="loading-screen">
        <div className="brand-mark">牌</div>
        <h1>牌譜工房</h1>
        <p>{error ?? 'sample.txt を読み込み、全局を前向き再生しています…'}</p>
        {error && <button type="button" onClick={() => inputRef.current?.click()}>別のJSONを開く</button>}
        <input ref={inputRef} hidden type="file" accept=".json,.txt" onChange={(change) => change.target.files?.[0] && void openFile(change.target.files[0])} />
      </main>
    )
  }

  const isFixedBoundary = (diagnostic: (typeof decoded.diagnostics)[number]) =>
    diagnostic.code === 'SCORE_DISCONTINUITY'
    && ([0, 1, 2, 3] as Seat[]).some((seat) => lockedRefs.has(`score:${diagnostic.round + 1}:${seat}`))
  const currentDiagnostics = decodedRound.diagnostics
    .filter((item) => (item.event ?? 0) <= event)
    .filter((item) => !isFixedBoundary(item))
  const errors = decoded.diagnostics.filter((item) => item.severity === 'error' && !isFixedBoundary(item)).length

  return (
    <div
      className={`app ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={(dragEvent) => { dragEvent.preventDefault(); setDragging(true) }}
      onDragOver={(dragEvent) => dragEvent.preventDefault()}
      onDragLeave={(dragEvent) => {
        if (dragEvent.currentTarget === dragEvent.target) setDragging(false)
      }}
      onDrop={(dropEvent) => {
        dropEvent.preventDefault()
        setDragging(false)
        const file = dropEvent.dataTransfer.files[0]
        if (file) void openFile(file)
      }}
    >
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">牌</div>
          <div>
            <h1>牌譜工房</h1>
            <span>PAIFU WORKSHOP</span>
          </div>
        </div>
        <nav className="file-actions" aria-label="ファイル操作">
          <button type="button" onClick={() => inputRef.current?.click()}><FolderOpen size={16} /> JSONを開く</button>
          <button type="button" onClick={() => setPasteOpen(true)}><Braces size={16} /> 貼り付け</button>
          <div className="action-menu">
            <button type="button"><Save size={16} /> 保存 <ChevronDown size={13} /></button>
            <div className="action-menu-popover">
              <button type="button" onClick={() => setJsonExportOpen(true)}><Braces size={15} /> 互換JSONをコピー</button>
              <button type="button" onClick={() => void exportJsonFile()}><Download size={15} /> JSONファイルを保存</button>
              <button type="button" onClick={() => void exportProject()}><FileJson size={15} /> 編集プロジェクトを保存</button>
              <button type="button" onClick={() => projectInputRef.current?.click()}><FileInput size={15} /> 編集プロジェクトを開く</button>
            </div>
          </div>
        </nav>
        <div className="history-actions">
          <button
            type="button"
            className={`change-log-trigger ${processingEntries.length ? 'is-busy' : ''}`}
            title="変更ログ"
            onClick={() => setChangeLogOpen(true)}
          >
            {processingEntries.length ? <LoaderCircle className="spin" size={17} /> : <ListTree size={17} />}
            変更ログ
            {editQueue.length > 0 && <span>{processingEntries.length || editQueue.length}</span>}
          </button>
          <button
            type="button"
            title="Undo"
            disabled={project.transactions.length === 0}
            onClick={() => { setCurrentProject(undoProject(project)); setNotice('連鎖変更を元に戻しました') }}
          >
            <Undo2 size={17} /> 元に戻す
          </button>
          <button
            type="button"
            title="Redo"
            disabled={project.redo.length === 0}
            onClick={() => { setCurrentProject(redoProject(project)); setNotice('連鎖変更をやり直しました') }}
          >
            <Redo2 size={17} /> やり直す
          </button>
          <button type="button" title="すべて元に戻す" onClick={() => { setCurrentProject(resetProject(project)); setNotice('元の牌譜へ戻しました') }}>
            <RotateCcw size={17} />
          </button>
        </div>
        <div className={`validation-pill ${errors ? 'has-errors' : ''}`}>
          <ShieldCheck size={16} />
          <span>{errors ? `${errors}件の要確認` : '全局を検証済み'}</span>
        </div>
      </header>

      <main className="workspace">
        <Timeline
          match={decoded}
          round={round}
          event={event}
          playing={playing}
          onRound={handleRound}
          onEvent={setEvent}
          onPlaying={setPlaying}
          canPasteRound={Boolean(roundClipboard)}
          canDeleteRound={project.current.log.length > 1}
          onCopyRound={copyCurrentRound}
          onPasteRound={pasteRoundAfterCurrent}
          onDeleteRound={deleteCurrentRound}
          onKeepOnlyRound={keepOnlyCurrentRound}
        />
        <section className="table-stage">
          <div className="stage-toolbar">
            <div className="match-meta">
              <span className="format-chip">天鳳 /6 JSON</span>
              <strong>{decoded.raw.rule.disp as string}</strong>
              <span>·</span>
              <span>{decoded.raw.name.join(' / ')}</span>
            </div>
            <div className="view-controls">
              <label className="viewpoint-control">
                <span>分析視点</span>
                <select
                  aria-label="分析視点"
                  value={viewpoint}
                  onChange={(change) => {
                    const seat = Number(change.target.value) as Seat
                    setAutoRotate(false)
                    setViewpoint(seat)
                    setSelectedSeat(seat)
                    setSelection(undefined)
                  }}
                >
                  {decoded.raw.name.map((name, seat) => (
                    <option key={seat} value={seat}>{name || `${seat + 1}家`}</option>
                  ))}
                </select>
              </label>
              <label className="auto-rotate-control">
                <input type="checkbox" checked={autoRotate} onChange={(change) => setAutoRotate(change.target.checked)} />
                <span>手番へ自動回転</span>
              </label>
            </div>
          </div>
          <TableView
            state={state}
            viewpoint={viewpoint}
            selection={selection}
            selectedSeat={selectedSeat}
            lockedRefs={lockedRefs}
            changes={recentChanges}
            processingTileIds={processingTileIds}
            processingCount={processingEntries.length}
            justApplied={justApplied}
            onSelect={setSelection}
            onSelectSeat={(seat) => { setSelectedSeat(seat); setSelection(undefined) }}
            onToggleLock={(key) => setCurrentProject(toggleLock(project, key))}
            onRotate={() => setViewpoint(((viewpoint + 1) % 4) as Seat)}
          />
        </section>
        <Inspector
          state={state}
          round={round}
          event={event}
          selection={selection}
          selectedSeat={selectedSeat}
          lockedRefs={lockedRefs}
          recentChanges={recentChanges}
          diagnostics={currentDiagnostics}
          onPreview={enqueueEdit}
          onNeedMeldPlan={setMeldPlanRequest}
          onToggleLock={(key) => setCurrentProject(toggleLock(project, key))}
        />
      </main>

      {changeLogOpen && <ChangeLogDrawer entries={editQueue} onClose={() => setChangeLogOpen(false)} />}
      {jsonExportOpen && (
        <JsonExportDialog
          text={exportedJson}
          onClose={() => setJsonExportOpen(false)}
          onSave={() => void exportJsonFile()}
        />
      )}
      {meldPlanRequest && (
        <MeldPlanDialog
          state={state}
          request={meldPlanRequest}
          onClose={() => setMeldPlanRequest(undefined)}
          onApply={(request) => {
            enqueueEdit(request)
            setMeldPlanRequest(undefined)
          }}
        />
      )}

      {pasteOpen && (
        <div className="dialog-backdrop">
          <section className="paste-dialog" role="dialog" aria-modal="true" aria-labelledby="paste-title">
            <header>
              <div><span className="eyebrow">LOCAL IMPORT</span><h2 id="paste-title">JSONテキストを貼り付け</h2></div>
              <button type="button" onClick={() => setPasteOpen(false)}><X /></button>
            </header>
            <div className="privacy-note"><Info size={16} /> 内容はこの端末内でだけ解析され、サーバーへ送信されません。</div>
            <textarea
              autoFocus
              value={pasteValue}
              onChange={(change) => setPasteValue(change.target.value)}
              placeholder='{"title":...,"log":[...]}'
              aria-label="牌譜JSON"
            />
            <footer>
              <button type="button" onClick={() => setPasteOpen(false)}>キャンセル</button>
              <button
                type="button"
                className="primary-action"
                disabled={!pasteValue.trim()}
                onClick={() => {
                  loadText(pasteValue, '貼り付けたJSON')
                  setPasteOpen(false)
                  setPasteValue('')
                }}
              >
                <Upload size={16} /> 読み込む
              </button>
            </footer>
          </section>
        </div>
      )}

      {dragging && <div className="drop-overlay"><Upload /><strong>牌譜JSONをドロップ</strong><span>ファイルは外部へ送信されません</span></div>}
      {notice && <div className="toast success"><ShieldCheck size={17} /> {notice}</div>}
      {error && <div className="toast error"><X size={17} /> {error}<button type="button" onClick={() => setError(undefined)}>閉じる</button></div>}

      <input ref={inputRef} hidden type="file" accept=".json,.txt" onChange={(change) => change.target.files?.[0] && void openFile(change.target.files[0])} />
      <input ref={projectInputRef} hidden type="file" accept=".mjpe,.json" onChange={(change) => change.target.files?.[0] && void openFile(change.target.files[0], true)} />
    </div>
  )
}
