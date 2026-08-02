import { parseTenhouLog } from './codec'
import { solveEdit } from './solver'
import type {
  EditorProject,
  EditRequest,
  EditTransaction,
  ProjectEditRequest,
  RawRound,
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
  const lockedRefs = [...project.lockedRefs]
  if (request.type === 'score') {
    const key = `score:${request.round}:${request.seat}`
    if (!lockedRefs.includes(key)) lockedRefs.push(key)
  }
  const transaction: EditTransaction = {
    id: id(),
    at: now,
    label: editRequestLabel(request),
    request,
    before: structuredClone(project.current),
    after: structuredClone(result.output),
    changes: result.changes,
    seed: project.seed,
    beforeLockedRefs: [...project.lockedRefs],
    afterLockedRefs: [...lockedRefs],
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
    lockedRefs: [...(transaction.beforeLockedRefs ?? project.lockedRefs)],
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
    lockedRefs: [...(transaction.afterLockedRefs ?? project.lockedRefs)],
    updatedAt: new Date().toISOString(),
  }
}

function shiftLockedRefs(lockedRefs: string[], fromRound: number, amount: 1 | -1): string[] {
  const shifted: string[] = []
  for (const key of lockedRefs) {
    const score = key.match(/^score:(\d+):(\d+)$/)
    if (score) {
      const round = Number(score[1])
      if (amount === -1 && round === fromRound) continue
      const nextRound = round >= fromRound ? round + amount : round
      shifted.push(`score:${nextRound}:${score[2]}`)
      continue
    }
    const rawRef = key.match(/^(\d+):(deal|draw|discard|dora|ura):(.*)$/)
    if (rawRef) {
      const round = Number(rawRef[1])
      if (amount === -1 && round === fromRound) continue
      const nextRound = round >= fromRound ? round + amount : round
      shifted.push(`${nextRound}:${rawRef[2]}:${rawRef[3]}`)
      continue
    }
    shifted.push(key)
  }
  return [...new Set(shifted)].sort()
}

function applyRoundEdit(
  project: EditorProject,
  current: TenhouLog,
  request: ProjectEditRequest,
  label: string,
  lockedRefs: string[],
): EditorProject {
  const now = new Date().toISOString()
  const transaction: EditTransaction = {
    id: id(),
    at: now,
    label,
    request,
    before: structuredClone(project.current),
    after: structuredClone(current),
    changes: [],
    seed: project.seed,
    beforeLockedRefs: [...project.lockedRefs],
    afterLockedRefs: [...lockedRefs],
  }
  return {
    ...project,
    current,
    transactions: [...project.transactions, transaction],
    redo: [],
    lockedRefs,
    updatedAt: now,
  }
}

export function insertProjectRound(project: EditorProject, round: RawRound, index: number): EditorProject {
  const insertAt = Math.max(0, Math.min(index, project.current.log.length))
  const current = structuredClone(project.current)
  current.log.splice(insertAt, 0, structuredClone(round))
  parseTenhouLog(current)
  return applyRoundEdit(
    project,
    current,
    { type: 'round-insert', index: insertAt },
    `局を${insertAt + 1}番目に貼り付け`,
    shiftLockedRefs(project.lockedRefs, insertAt, 1),
  )
}

export function deleteProjectRound(project: EditorProject, index: number): EditorProject {
  if (project.current.log.length <= 1) throw new Error('最後の1局は削除できません')
  if (index < 0 || index >= project.current.log.length) throw new Error('削除する局が見つかりません')
  const current = structuredClone(project.current)
  current.log.splice(index, 1)
  parseTenhouLog(current)
  return applyRoundEdit(
    project,
    current,
    { type: 'round-delete', index },
    `${index + 1}番目の局を削除`,
    shiftLockedRefs(project.lockedRefs, index, -1),
  )
}

function keepOnlyRoundLockedRefs(lockedRefs: string[], keptRound: number): string[] {
  const kept: string[] = []
  for (const key of lockedRefs) {
    const score = key.match(/^score:(\d+):(\d+)$/)
    if (score) {
      if (Number(score[1]) === keptRound) kept.push(`score:0:${score[2]}`)
      continue
    }
    const rawRef = key.match(/^(\d+):(deal|draw|discard|dora|ura):(.*)$/)
    if (rawRef) {
      if (Number(rawRef[1]) === keptRound) kept.push(`0:${rawRef[2]}:${rawRef[3]}`)
      continue
    }
    kept.push(key)
  }
  return [...new Set(kept)].sort()
}

export function keepOnlyProjectRound(project: EditorProject, index: number): EditorProject {
  if (index < 0 || index >= project.current.log.length) throw new Error('残す局が見つかりません')
  if (project.current.log.length === 1) return project
  const current = structuredClone(project.current)
  current.log = [structuredClone(current.log[index]!)]
  parseTenhouLog(current)
  return applyRoundEdit(
    project,
    current,
    { type: 'round-keep-only', index },
    `${index + 1}番目の局だけ残す`,
    keepOnlyRoundLockedRefs(project.lockedRefs, index),
  )
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

export function editRequestLabel(request: ProjectEditRequest): string {
  if (request.type === 'tile') return '牌を変更'
  if (request.type === 'meld-add') return '副露を追加'
  if (request.type === 'meld-remove') return '副露を削除'
  if (request.type === 'meld-change') return '副露の種類を変更'
  if (request.type === 'reach') return request.enabled ? 'リーチを設定' : 'リーチを解除'
  if (request.type === 'round-insert') return '局を貼り付け'
  if (request.type === 'round-delete') return '局を削除'
  if (request.type === 'round-keep-only') return '選択した局だけ残す'
  return '開始点を変更・固定'
}
