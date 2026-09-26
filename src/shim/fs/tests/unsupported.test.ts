import { describe, expect, it } from 'vitest'
import { syncUnsupported } from '../unsupported.js'

describe('syncUnsupported', () => {
  it('throws a named error citing ADR-0016', () => {
    const statSync = syncUnsupported('fs.statSync')
    let caught: Error & { code?: string } | undefined
    try { statSync() } catch (error) { caught = error as Error & { code?: string } }
    expect(caught?.message).toMatch(/fs\.statSync/)
    expect(caught?.message).toMatch(/ADR-0016/)
    expect(caught?.code).toBe('ERR_ORIVON_FS_SYNC_UNSUPPORTED')
  })
})
