import { describe, expect, it } from 'vitest'
import { syncUnsupported } from '../unsupported.js'

describe('syncUnsupported', () => {
  it('throws a named error -- realpathSync\'s own permanent refusal (ADR-0016: no async realpath to share a core with)', () => {
    const realpathSync = syncUnsupported('fs.realpathSync')
    let caught: Error & { code?: string } | undefined
    try { realpathSync() } catch (error) { caught = error as Error & { code?: string } }
    expect(caught?.message).toMatch(/fs\.realpathSync/)
    expect(caught?.message).toMatch(/no synchronous form/)
    expect(caught?.code).toBe('ERR_ORIVON_FS_SYNC_UNSUPPORTED')
  })
})
