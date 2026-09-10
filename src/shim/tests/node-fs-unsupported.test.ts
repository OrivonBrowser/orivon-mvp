import { describe, expect, it } from 'vitest'
import { open, syncUnsupported } from '../node-fs-unsupported.js'

describe('fs.open', () => {
  it('throws a named error citing why, rather than pretending to open a FileHandle', () => {
    expect(() => open()).toThrow(/no FileHandle capability/)
  })
})

describe('syncUnsupported', () => {
  it('throws a named error citing ADR-0016, distinguishable from fs.open\'s error', () => {
    const statSync = syncUnsupported('fs.statSync')
    let caught: Error & { code?: string } | undefined
    try { statSync() } catch (error) { caught = error as Error & { code?: string } }
    expect(caught?.message).toMatch(/fs\.statSync/)
    expect(caught?.message).toMatch(/ADR-0016/)
    expect(caught?.code).toBe('ERR_ORIVON_FS_SYNC_UNSUPPORTED')
  })
})
