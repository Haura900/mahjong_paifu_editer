/// <reference lib="webworker" />
import { solveEdit } from './solver'
import type { EditRequest, TenhouLog } from './types'

interface WorkerRequest {
  id: string
  log: TenhouLog
  request: EditRequest
  lockedRefs: string[]
  seed: number
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, log, request, lockedRefs, seed } = event.data
  self.postMessage({ id, type: 'progress', progress: 15, message: '物理牌の参照関係を追跡中' })
  const result = solveEdit(log, request, { lockedRefs, seed })
  self.postMessage({ id, type: 'result', result })
}

export {}
