import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LOCAL_DATA_DIR } from '../../../broker/grants/local-file-lifetime.js'
import { sweepLocalData } from '../local-data-sweep.js'

describe('sweepLocalData', () => {
  it('removes every run\'s local data and leaves app-data and the rest of the profile alone', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-sweep-'))
    mkdirSync(join(userData, LOCAL_DATA_DIR, 'old-run', 'hash', 'files'), { recursive: true })
    writeFileSync(join(userData, LOCAL_DATA_DIR, 'old-run', 'hash', 'files', 'x.txt'), 'x')
    mkdirSync(join(userData, 'app-data', 'hash', 'files'), { recursive: true })
    writeFileSync(join(userData, 'app-data', 'hash', 'files', 'keep.txt'), 'keep')

    expect(sweepLocalData(userData)).toBe(true)

    expect(existsSync(join(userData, LOCAL_DATA_DIR))).toBe(false)
    expect(existsSync(join(userData, 'app-data', 'hash', 'files', 'keep.txt'))).toBe(true)
  })

  it('is a no-op when there is nothing to remove', () => {
    expect(sweepLocalData(mkdtempSync(join(tmpdir(), 'orivon-sweep-')))).toBe(true)
  })

  it('reports a failure and does not throw', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(sweepLocalData('/u', () => { throw new Error('busy') })).toBe(false)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})
