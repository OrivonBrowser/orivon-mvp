import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openHistory } from '../open-history.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-open-history-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('openHistory', () => {
  it('opens a file that is not there yet, in a directory that is not there yet', () => {
    const { store, problem } = openHistory(join(dir, 'profile', 'history.db'))
    expect(problem).toBeNull()
    expect(store.kind).toBe('sqlite')
    store.close()
  })

  it('keeps nothing for the run, says why, and leaves the file as it was, when it cannot be used', async () => {
    const file = join(dir, 'history.db')
    const bytes = 'not a database'.repeat(100)
    await writeFile(file, bytes)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { store, problem } = openHistory(file)

    warn.mockRestore()
    expect(store.kind).toBe('null')
    expect(problem).not.toBeNull()
    store.record('https://a.example/', 'A', 1)
    expect(store.count()).toBe(0)
    expect(await readFile(file, 'utf8')).toBe(bytes)
  })
})
