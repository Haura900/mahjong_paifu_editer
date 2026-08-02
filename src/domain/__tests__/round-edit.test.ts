import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createProject,
  deleteProjectRound,
  insertProjectRound,
  keepOnlyProjectRound,
  redoProject,
  undoProject,
} from '../project'
import type { TenhouLog } from '../types'

const sample = JSON.parse(readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8')) as TenhouLog

describe('round copy, paste and delete', () => {
  it('repeats the exact selected round and keeps it independently editable', () => {
    const source = structuredClone(sample.log[0]!)
    const project = insertProjectRound(createProject(sample), source, 1)

    expect(project.current.log).toHaveLength(sample.log.length + 1)
    expect(project.current.log[1]).toEqual(source)
    expect(project.current.log[1]).not.toBe(source)
    expect(project.current.log[0]![0]).toEqual([0, 0, 0])
    expect(project.current.log[1]![0]).toEqual([0, 0, 0])

    project.current.log[1]![4][0] = 19
    expect(project.current.log[0]![4][0]).toBe(source[4][0])
  })

  it('includes structural edits in undo and redo', () => {
    const original = createProject(sample)
    const inserted = insertProjectRound(original, original.current.log[0]!, 1)
    const deleted = deleteProjectRound(inserted, 1)

    expect(deleted.current.log).toHaveLength(sample.log.length)
    expect(undoProject(deleted).current.log).toHaveLength(sample.log.length + 1)
    expect(redoProject(undoProject(deleted)).current.log).toHaveLength(sample.log.length)
    expect(undoProject(inserted).current).toEqual(original.current)
  })

  it('does not allow deleting the final round', () => {
    const oneRound = structuredClone(sample)
    oneRound.log = [structuredClone(sample.log[0]!)]
    expect(() => deleteProjectRound(createProject(oneRound), 0)).toThrow('最後の1局')
  })

  it('keeps only the selected round and restores the full match with undo', () => {
    const original = createProject(sample)
    original.lockedRefs = ['0:deal:0:0:-', '4:deal:1:2:-', 'score:4:2']
    const selected = structuredClone(original.current.log[4]!)
    const kept = keepOnlyProjectRound(original, 4)

    expect(kept.current.log).toEqual([selected])
    expect(kept.lockedRefs).toEqual(['0:deal:1:2:-', 'score:0:2'])
    expect(undoProject(kept).current).toEqual(original.current)
    expect(undoProject(kept).lockedRefs).toEqual(original.lockedRefs)
  })
})
