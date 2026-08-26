import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireLock, appendJsonl, ensureState, loadBoard, loadControl, markAnswersConsumed,
  pendingAnswers, pruneRuns, readJsonl, releaseLock, saveBoard, saveControl, statePaths
} from './board.mjs'

const dir = (): string => mkdtempSync(join(tmpdir(), 'orivon-board-'))

describe('ensureState', () => {
  it('creates the files a first run needs', () => {
    const d = dir()
    const p = ensureState(d)
    for (const f of [p.board, p.control, p.questions, p.answers]) expect(existsSync(f)).toBe(true)
  })

  it('does not clobber an existing board', () => {
    const d = dir()
    ensureState(d)
    saveBoard(d, { tasks: [{ id: 'keep' }], questions: [], cycle: 5 })
    ensureState(d)
    expect(loadBoard(d).tasks).toEqual([{ id: 'keep' }])
  })
})

describe('board persistence', () => {
  it('round-trips', () => {
    const d = dir()
    ensureState(d)
    saveBoard(d, { tasks: [{ id: 'a', status: 'todo' }], questions: [], cycle: 3 })
    const back = loadBoard(d)
    expect(back.tasks).toEqual([{ id: 'a', status: 'todo' }])
    expect(back.cycle).toBe(3)
  })

  it('stamps an update time', () => {
    const d = dir()
    ensureState(d)
    saveBoard(d, { tasks: [], questions: [], cycle: 1 })
    expect(loadBoard(d).updated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  // A corrupt board that throws would wedge every future cycle; a corrupt board
  // that silently reads as empty would redo finished work. Returning the empty
  // shape is the lesser evil, and the loop logs the discrepancy.
  it('returns an empty board rather than throwing on corruption', () => {
    const d = dir()
    ensureState(d)
    writeFileSync(statePaths(d).board, '{ not json')
    expect(loadBoard(d).tasks).toEqual([])
  })

  it('control round-trips', () => {
    const d = dir()
    ensureState(d)
    saveControl(d, { globalStop: true, pausedCategories: ['browser-ui'] })
    expect(loadControl(d)).toEqual({ globalStop: true, pausedCategories: ['browser-ui'] })
  })
})

describe('jsonl', () => {
  it('appends and reads back', () => {
    const d = dir()
    const p = ensureState(d)
    appendJsonl(p.questions, { id: 'q-1' })
    appendJsonl(p.questions, { id: 'q-2' })
    expect(readJsonl(p.questions).map((q: { id: string }) => q.id)).toEqual(['q-1', 'q-2'])
  })

  // Expected whenever a process dies mid-append. Losing the partial record is
  // correct; failing the whole cycle over it is not.
  it('skips a half-written trailing line rather than throwing', () => {
    const d = dir()
    const p = ensureState(d)
    appendJsonl(p.answers, { id: 'q-1', answer: 'yes' })
    writeFileSync(p.answers, `${readFileSync(p.answers, 'utf8')}{"id":"q-2","ans`)
    expect(readJsonl(p.answers)).toHaveLength(1)
  })

  it('returns nothing for a missing file', () => {
    expect(readJsonl(join(dir(), 'nope.jsonl'))).toEqual([])
  })
})

describe('answer consumption', () => {
  it('returns only answers not yet applied', () => {
    const d = dir()
    const p = ensureState(d)
    appendJsonl(p.answers, { id: 'q-1' })
    appendJsonl(p.answers, { id: 'q-2' })

    let board = loadBoard(d)
    expect(pendingAnswers(d, board)).toHaveLength(2)

    board = markAnswersConsumed(board, 2)
    expect(pendingAnswers(d, board)).toHaveLength(0)

    appendJsonl(p.answers, { id: 'q-3' })
    expect(pendingAnswers(d, board).map((a: { id: string }) => a.id)).toEqual(['q-3'])
  })
})

describe('the run lock', () => {
  it('is acquired when free', () => {
    expect(acquireLock(dir()).acquired).toBe(true)
  })

  it('is not re-acquired while a live process holds it', () => {
    const d = dir()
    acquireLock(d)                      // held by this process, which is alive
    expect(acquireLock(d).acquired).toBe(false)
  })

  // Otherwise a machine that lost power mid-cycle leaves a lock file that
  // wedges the loop forever -- and it fails silently, looking like "it stopped".
  it('takes over a lock held by a dead process', () => {
    const d = dir()
    writeFileSync(statePaths(d).lock, JSON.stringify({ pid: 999999, at: new Date().toISOString() }))
    expect(acquireLock(d).acquired).toBe(true)
  })

  it('takes over a lock that is older than any real cycle', () => {
    const d = dir()
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    writeFileSync(statePaths(d).lock, JSON.stringify({ pid: process.pid, at: old }))
    expect(acquireLock(d).acquired).toBe(true)
  })

  it('releases only its own lock', () => {
    const d = dir()
    writeFileSync(statePaths(d).lock, JSON.stringify({ pid: 999999, at: new Date().toISOString() }))
    releaseLock(d)
    expect(existsSync(statePaths(d).lock)).toBe(true)
  })

  it('releases a lock it owns', () => {
    const d = dir()
    acquireLock(d)
    releaseLock(d)
    expect(existsSync(statePaths(d).lock)).toBe(false)
  })
})

describe('pruneRuns', () => {
  it('keeps the newest and removes the rest', () => {
    const d = dir()
    const p = ensureState(d)
    for (const n of ['2026-01-01.log', '2026-01-02.log', '2026-01-03.log']) {
      writeFileSync(join(p.runs, n), 'x')
    }
    expect(pruneRuns(d, 2)).toBe(1)
    expect(existsSync(join(p.runs, '2026-01-01.log'))).toBe(false)
    expect(existsSync(join(p.runs, '2026-01-03.log'))).toBe(true)
  })

  it('is a no-op when there is nothing to prune', () => {
    const d = dir()
    ensureState(d)
    expect(pruneRuns(d, 10)).toBe(0)
  })
})
