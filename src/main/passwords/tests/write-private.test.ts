import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writePrivate } from '../write-private.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-write-private-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('writePrivate', () => {
  it('writes a new file owner-only', async () => {
    const path = join(dir, 'new.csv')
    expect(await writePrivate(path, 'secret')).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('secret')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('narrows a file that was already there and was readable by others, and replaces its content', async () => {
    const path = join(dir, 'old.csv')
    writeFileSync(path, 'old content that is longer than the new one')
    chmodSync(path, 0o644)
    expect(await writePrivate(path, 'new')).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('reports a file it could not write', async () => {
    expect(await writePrivate(join(dir, 'missing', 'x.csv'), 'secret')).toBe(false)
  })
})
