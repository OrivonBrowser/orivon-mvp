import { describe, expect, it } from 'vitest'
import { OrivonShimError } from '../../errors.js'
import { OrivonFsUnsupportedError } from '../unsupported.js'

// sync-orivon.ts's syncFs() is the one place that actually throws this
// (every fs *Sync export routes through it, ADR-0016's amendment) -- this
// file's own job is just the error shape itself: named, matching
// A177's fourth OrivonShimError instance, and carrying the code a caller
// branches on.
describe('OrivonFsUnsupportedError', () => {
  it('is an OrivonShimError, so a caller\'s single `instanceof OrivonShimError` check catches it too', () => {
    const error = new OrivonFsUnsupportedError('fs.statSync', 'this call works in a Worker')
    expect(error).toBeInstanceOf(OrivonShimError)
    expect(error.name).toBe('OrivonFsUnsupportedError')
    expect(error.api).toBe('fs.statSync')
    expect(error.message).toMatch(/fs\.statSync is not supported -- this call works in a Worker/)
  })

  it('defaults to ERR_ORIVON_FS_UNSUPPORTED, or takes a caller-given code (ERR_ORIVON_FS_SYNC_UNSUPPORTED, the one every *Sync refusal actually uses)', () => {
    expect(new OrivonFsUnsupportedError('fs.watch', 'unimplemented').code).toBe('ERR_ORIVON_FS_UNSUPPORTED')
    expect(new OrivonFsUnsupportedError('fs.statSync', 'reason', 'ERR_ORIVON_FS_SYNC_UNSUPPORTED').code).toBe('ERR_ORIVON_FS_SYNC_UNSUPPORTED')
  })
})
