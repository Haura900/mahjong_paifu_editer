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
  MessageSquareCode,
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
import { CodecError, encodeTenhouLog, parseTenhouLog, seatName } from './domain/codec'
import {
  applyProjectLogChange,
  applySolvedProjectEdit,
  createProject,
  editRequestLabel,
  parseProject,
  redoProject,
  resetProject,
  serializeProject,
  toggleLock,
  undoProject,
} from './domain/project'
import { decodeMatch, roundLabel, snapshotAt } from './domain/replay'
import {
  insertRound,
  keepOnlyRound,
  lockedRefsForSingleRound,
  shiftLockedRefsForInsert,
} from './domain/rounds'
import { solveEdit } from './domain/solver'
import { buildAiEditPrompt } from './domain/aiPrompt'
import { executePaifuScript } from './domain/script'
import { buildTenhouJsonUrl, findAnalysisSeatByName } from './domain/tenhouUrl'
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
import { ScriptDialog } from './components/ScriptDialog'
import { TableView, type Selection } from './components/TableView'
import { Timeline } from './components/Timeline'
import { readFileText, saveText } from './lib/files'

const ANALYSIS_PLAYER_NAME_KEY = 'mahjong-paifu-editor:analysis-player-name'

export function App() {
  const [project, setProject] = useState<EditorProject>()
  const [round, setRound] = useState(0)
  const [event, setEvent] = useState(0)
  const [viewpoint, setViewpoint] = useState<Seat>(0)
  const [analysisSeat, setAnalysisSeat] = useState<Seat>()
  const [lastAnalysisPlayerName, setLastAnalysisPlayerName] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(ANALYSIS_PLAYER_NAME_KEY) ?? undefined
    } catch {
      return undefined
    }
  })
  const [viewpointLocked, setViewpointLocked] = useState(false)
  const [selectedSeat, setSelectedSeat] = useState<Seat>(0)
  const [selection, setSelection] = useState<Selection>()
  const [playing, setPlaying] = useState(false)
  const [autoRotate, setAutoRotate] = useState(true)
  const [editQueue, setEditQueue] = useState<EditQueueEntry[]>([])
  const [activeJobId, setActiveJobId] = useState<string>()
  const [changeLogOpen, setChangeLogOpen] = useState(false)
  const [jsonExport, setJsonExport] = useState<{ text: string; title: string; filename: string }>()
  const [meldPlanRequest, setMeldPlanRequest] = useState<Extract<EditRequest, { type: 'meld-add' }>>()
  const [justApplied, setJustApplied] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
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

  const selectAnalysisPlayer = useCallback((seat: Seat | undefined, names: string[]) => {
    setAnalysisSeat(seat)
    setViewpointLocked(seat !== undefined)
    if (seat === undefined) {
      setLastAnalysisPlayerName(undefined)
      try {
        localStorage.removeItem(ANALYSIS_PLAYER_NAME_KEY)
      } catch {
        // The current selection still works if browser storage is unavailable.
      }
      return
    }
    setViewpoint(seat)
    const name = names[seat]
    if (!name) return
    setLastAnalysisPlayerName(name)
    try {
      localStorage.setItem(ANALYSIS_PLAYER_NAME_KEY, name)
    } catch {
      // The current selection still works if browser storage is unavailable.
    }
  }, [])

  const loadLog = useCallback((log: TenhouLog, label: string) => {
    const decoded = decodeMatch(log)
    const restoredAnalysisSeat = findAnalysisSeatByName(decoded.raw.name, lastAnalysisPlayerName)
    const defaultViewpoint = restoredAnalysisSeat ?? decoded.rounds[0]?.snapshots[0]?.dealer ?? 0
    clearEditPipeline()
    setCurrentProject(createProject(decoded.raw))
    setRound(0)
    setEvent(Math.max(0, (decoded.rounds[0]?.events.length ?? 1) - 1))
    setViewpoint(defaultViewpoint)
    setAnalysisSeat(restoredAnalysisSeat)
    setViewpointLocked(restoredAnalysisSeat !== undefined)
    setRoundClipboard(undefined)
    setSelectedSeat(decoded.rounds[0]?.snapshots[0]?.dealer ?? 0)
    setSelection(undefined)
    setError(undefined)
    setNotice(`${label}を読み込みました（${decoded.rounds.length}局）`)
  }, [clearEditPipeline, lastAnalysisPlayerName, setCurrentProject])

  const loadText = useCallback((text: string, label: string, projectFile = false) => {
    try {
      if (projectFile || (text.includes('"format"') && text.includes('mahjong-paifu-editor-project'))) {
        const loaded = parseProject(text)
        const loadedMatch = decodeMatch(loaded.current)
        const restoredAnalysisSeat = findAnalysisSeatByName(loadedMatch.raw.name, lastAnalysisPlayerName)
        const defaultViewpoint = restoredAnalysisSeat ?? loadedMatch.rounds[0]?.snapshots[0]?.dealer ?? 0
        clearEditPipeline()
        setCurrentProject(loaded)
        setRound(0)
        setEvent(Math.max(0, (loadedMatch.rounds[0]?.events.length ?? 1) - 1))
        setAnalysisSeat(restoredAnalysisSeat)
        setViewpoint(defaultViewpoint)
        setViewpointLocked(restoredAnalysisSeat !== undefined)
        setRoundClipboard(undefined)
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
  }, [clearEditPipeline, lastAnalysisPlayerName, loadLog, setCurrentProject])

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
  const tenhouUrl = useMemo(
    () => analysisSeat === undefined ? undefined : buildTenhouJsonUrl(exportedJson, analysisSeat),
    [analysisSeat, exportedJson],
  )
  const analysisProfile = useMemo(() => {
    if (!decoded || analysisSeat === undefined) return undefined
    return {
      name: decoded.raw.name[analysisSeat]!,
      eastOneWind: seatName(analysisSeat),
      seat: analysisSeat,
    }
  }, [analysisSeat, decoded])

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
    if (viewpointLocked || !autoRotate || state?.turn === undefined) return
    setViewpoint(state.turn)
  }, [autoRotate, state?.turn, viewpointLocked])

  useEffect(() => {
    if (viewpointLocked && analysisSeat !== undefined) setViewpoint(analysisSeat)
  }, [analysisSeat, viewpointLocked])

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
    setEvent(Math.max(0, (decoded?.rounds[next]?.events.length ?? 1) - 1))
    setSelection(undefined)
    setPlaying(false)
    if (viewpointLocked && analysisSeat !== undefined) {
      setViewpoint(analysisSeat)
      return
    }
    const dealer = decoded?.rounds[next]?.snapshots[0]?.dealer
    if (autoRotate && dealer !== undefined) setViewpoint(dealer)
  }

  const keepSelectedRoundOnly = () => {
    if (!project || !decodedRound || project.current.log.length === 1) return
    const label = roundLabel(decodedRound.raw[0][0])
    if (!window.confirm(`${label}だけを残し、ほかの${project.current.log.length - 1}局を削除しますか？\n「元に戻す」で復元できます。`)) return
    clearEditPipeline()
    const output = keepOnlyRound(project.current, round)
    setCurrentProject(applyProjectLogChange(
      project,
      { type: 'round-keep-only', round },
      output,
      lockedRefsForSingleRound(project.lockedRefs, round),
    ))
    setRound(0)
    setEvent(Math.max(0, decodedRound.events.length - 1))
    setSelection(undefined)
    setPlaying(false)
    setNotice(`${label}だけを残しました。東1局の風情報はプレイヤー名の並びから保持しています`)
  }

  const copySelectedRound = () => {
    if (!project || !decodedRound) return
    const label = roundLabel(decodedRound.raw[0][0])
    setRoundClipboard(structuredClone(project.current.log[round]!))
    setNotice(`${label}をコピーしました。ペーストすると同じ局を直後へ追加します`)
  }

  const pasteSelectedRound = () => {
    if (!project || !roundClipboard) return
    try {
      const insertAt = round + 1
      const output = insertRound(project.current, insertAt, roundClipboard)
      decodeMatch(output)
      clearEditPipeline()
      setCurrentProject(applyProjectLogChange(project, {
        type: 'round-paste',
        round: insertAt,
        sourceRoundNumber: roundClipboard[0][0],
      }, output, shiftLockedRefsForInsert(project.lockedRefs, insertAt)))
      setRound(insertAt)
      setEvent(Math.max(0, (decodeMatch(output).rounds[insertAt]?.events.length ?? 1) - 1))
      setSelection(undefined)
      setPlaying(false)
      setNotice(`${roundLabel(roundClipboard[0][0])}をもう一度追加しました`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const executeScript = (input: string): string | undefined => {
    if (!project || !state || !decodedRound) return '局面を読み込めません'
    try {
      const script = input
        .trim()
        .replace(/^```[^\r\n]*\r?\n?/, '')
        .replace(/\s*```$/, '')
      const result = executePaifuScript(project.current, script, {
        round,
        event,
        self: analysisSeat ?? viewpoint,
        lockedRefs: project.lockedRefs,
        seed: project.seed,
      })
      let nextLocks = [...project.lockedRefs]
      if (result.keepOnly) nextLocks = lockedRefsForSingleRound(nextLocks, round)
      for (let index = 0; index < result.sceneCount; index += 1) {
        nextLocks = shiftLockedRefsForInsert(nextLocks, (result.keepOnly ? 0 : round) + 1 + index)
      }
      clearEditPipeline()
      setCurrentProject(applyProjectLogChange(
        project,
        { type: 'script', round, script, scenes: result.sceneCount },
        result.output,
        nextLocks,
        result.changes,
      ))
      setSelection(undefined)
      setPlaying(false)
      if (result.keepOnly) {
        setRound(0)
        setEvent(Math.max(0, (decodeMatch(result.output).rounds[0]?.events.length ?? 1) - 1))
      }
      setScriptOpen(false)
      const skipped = result.sceneErrors.length
      setNotice(result.sceneCount
        ? `${result.sceneCount}個の局面案を${result.keepOnly ? '残した現在局' : '現在局'}の後へ追加しました${skipped ? `（${skipped}個はスキップ）` : ''}`
        : skipped
          ? `${skipped}個の局面案をスキップしました`
          : `${result.commandCount}個のスクリプト命令を適用しました`)
      setError(skipped
        ? result.sceneErrors.map(({ name, message }) => `SCENE「${name}」: ${message}`).join(' / ')
        : undefined)
      return undefined
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught)
    }
  }

  const exportJsonFile = async (text = exportedJson, filename = 'edited-paifu.json') => {
    if (!project) return
    try {
      const method = await saveText(filename, text, '天鳳JSON牌譜')
      const action = method === 'direct' ? '編集済みJSONを保存しました' : '編集済みJSONをダウンロードしました'
      const reminder = analysisProfile
        ? `送信時は「${analysisProfile.name}視点（東1局では${analysisProfile.eastOneWind}）」を添えてください`
        : '送信前に分析ユーザーを指定してください'
      setNotice(`${action}。${reminder}`)
    } catch {
      // User cancelled the platform picker.
    }
  }

  const exportTenhouUrlFile = async () => {
    if (!tenhouUrl || !analysisProfile) return
    try {
      const method = await saveText(
        'edited-paifu-tenhou-url.txt',
        tenhouUrl,
        '視点込み天鳳牌譜URL',
        { mimeType: 'text/plain', extensions: ['.txt'] },
      )
      setNotice(method === 'direct'
        ? `${analysisProfile.name}視点の天鳳URLを保存しました`
        : `${analysisProfile.name}視点の天鳳URLをダウンロードしました`)
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
          <button type="button" onClick={() => setScriptOpen(true)}><MessageSquareCode size={16} /> AI・スクリプト</button>
          <div className="action-menu">
            <button type="button"><Save size={16} /> 保存 <ChevronDown size={13} /></button>
            <div className="action-menu-popover">
              <button
                type="button"
                onClick={() => setJsonExport({
                  text: exportedJson,
                  title: '天鳳URL・互換JSONを書き出す',
                  filename: 'edited-paifu.json',
                })}
              >
                <Braces size={15} /> 天鳳URL・互換JSON
              </button>
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
          onKeepOnlyRound={keepSelectedRoundOnly}
          onCopyRound={copySelectedRound}
          canPasteRound={Boolean(roundClipboard)}
          onPasteRound={pasteSelectedRound}
        />
        <section className="table-stage">
          <div className="stage-toolbar">
            <div>
              <span className="format-chip">天鳳 /6 JSON</span>
              <strong>{decoded.raw.rule.disp as string}</strong>
              <span>·</span>
              <span>{decoded.raw.name.join(' / ')}</span>
            </div>
            <div className="viewpoint-controls">
              <label className="analysis-user-select">
                <span>分析ユーザー</span>
                <select
                  aria-label="分析ユーザー"
                  value={analysisSeat ?? ''}
                  onChange={(change) => {
                    if (change.target.value === '') {
                      selectAnalysisPlayer(undefined, decoded.raw.name)
                      return
                    }
                    const seat = Number(change.target.value) as Seat
                    selectAnalysisPlayer(seat, decoded.raw.name)
                  }}
                >
                  <option value="">選択してください</option>
                  {decoded.raw.name.map((name, seat) => (
                    <option key={seat} value={seat}>{name}（東1局では{seatName(seat as Seat)}）</option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={viewpointLocked}
                  disabled={analysisSeat === undefined}
                  onChange={(change) => setViewpointLocked(change.target.checked)}
                />
                <span>下に固定</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={autoRotate}
                  disabled={viewpointLocked}
                  onChange={(change) => setAutoRotate(change.target.checked)}
                />
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
            onRotate={() => {
              setViewpointLocked(false)
              setViewpoint(((viewpoint + 1) % 4) as Seat)
            }}
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
      {jsonExport && (
        <JsonExportDialog
          text={jsonExport.text}
          url={tenhouUrl}
          title={jsonExport.title}
          analysis={analysisProfile}
          onClose={() => setJsonExport(undefined)}
          onSaveJson={() => void exportJsonFile(jsonExport.text, jsonExport.filename)}
          onSaveUrl={() => void exportTenhouUrlFile()}
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
      {scriptOpen && (
        <ScriptDialog
          onClose={() => setScriptOpen(false)}
          onBuildPrompt={(instruction) => buildAiEditPrompt({
            instruction,
            state,
            self: analysisSeat ?? viewpoint,
            eventCount: decodedRound.events.length,
          })}
          onExecute={executeScript}
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
