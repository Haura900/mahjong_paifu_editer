import { parseTenhouLog } from './codec'
import { solveEdit } from './solver'
import type {
  EditorProject,
  EditRequest,
  EditTransaction,
  SolverResult,
  TenhouLog,
} from './types'

export const PROJECT_FORMAT_VERSION = 1 as const
export const PRIORITY_VERSION = 1 as const

function id(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tx-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createProject(log: TenhouLog, seed = 20260726): EditorProject {
  const now = new Date().toISOString()
  return {
    format: 'mahjong-paifu-editor-project',
    version: PROJECT_FORMAT_VERSION,
    priorityVersion: PRIORITY_VERSION,
    seed,
    original: structuredClone(log),
    current: structuredClone(log),
    transactions: [],
    redo: [],
    lockedRefs: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function applyProjectEdit(
  project: EditorProject,
  request: EditRequest,
): { project: EditorProject; result: SolverResult } {
  const result = solveEdit(project.current, request, {
    lockedRefs: project.lockedRefs,
    seed: project.seed,
  })
  return applySolvedProjectEdit(project, request, result)
}

export function applySolvedProjectEdit(
  project: EditorProject,
  request: EditRequest,
  result: SolverResult,
): { project: EditorProject; result: SolverResult } {
  if (!result.ok || !result.output) return { project, result }
  const now = new Date().toISOString()
  const transaction: EditTransaction = {
    id: id(),
    at: now,
    label: editRequestLabel(request),
    request,
    before: structuredClone(project.current),
    after: structuredClone(result.output),
    changes: result.changes,
    seed: project.seed,
  }
  const lockedRefs = [...project.lockedRefs]
  if (request.type === 'score') {
    const key = `score:${request.round}:${request.seat}`
    if (!lockedRefs.includes(key)) lockedRefs.push(key)
  }
  return {
    result,
    project: {
      ...project,
      current: structuredClone(result.output),
      transactions: [...project.transactions, transaction],
      redo: [],
      lockedRefs,
      updatedAt: now,
    },
  }
}

export function undoProject(project: EditorProject): EditorProject {
  const transaction = project.transactions.at(-1)
  if (!transaction) return project
  return {
    ...project,
    current: structuredClone(transaction.before),
    transactions: project.transactions.slice(0, -1),
    redo: [transaction, ...project.redo],
    updatedAt: new Date().toISOString(),
  }
}

export function redoProject(project: EditorProject): EditorProject {
  const transaction = project.redo[0]
  if (!transaction) return project
  return {
    ...project,
    current: structuredClone(transaction.after),
    transactions: [...project.transactions, transaction],
    redo: project.redo.slice(1),
    updatedAt: new Date().toISOString(),
  }
}

export function resetProject(project: EditorProject): EditorProject {
  return {
    ...project,
    current: structuredClone(project.original),
    transactions: [],
    redo: [],
    lockedRefs: [],
    updatedAt: new Date().toISOString(),
  }
}

export function toggleLock(project: EditorProject, key: string): EditorProject {
  const locked = new Set(project.lockedRefs)
  if (locked.has(key)) locked.delete(key)
  else locked.add(key)
  return {
    ...project,
    lockedRefs: [...locked].sort(),
    updatedAt: new Date().toISOString(),
  }
}

export function serializeProject(project: EditorProject): string {
  return JSON.stringify(project, null, 2)
}

export function parseProject(input: string): EditorProject {
  const value = JSON.parse(input) as Partial<EditorProject>
  if (
    value.format !== 'mahjong-paifu-editor-project'
    || value.version !== PROJECT_FORMAT_VERSION
    || value.priorityVersion !== PRIORITY_VERSION
    || !value.original
    || !value.current
    || !Array.isArray(value.transactions)
    || !Array.isArray(value.redo)
    || !Array.isArray(value.lockedRefs)
  ) {
    throw new Error('対応していない、または壊れた編集プロジェクトです')
  }
  parseTenhouLog(value.original)
  parseTenhouLog(value.current)
  return structuredClone(value as EditorProject)
}

export function editRequestLabel(request: EditRequest): string {
  if (request.type === 'tile') return '牌を変更'
  if (request.type === 'meld-add') return '副露を追加'
  if (request.type === 'meld-remove') return '副露を削除'
  if (request.type === 'meld-change') return '副露の種類を変更'
  if (request.type === 'reach') return request.enabled ? 'リーチを設定' : 'リーチを解除'
  return '開始点を変更・固定'
}
