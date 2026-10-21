import { describe, expect, it } from 'vitest'
import { decideWhatsNew } from '../whats-new.js'

const base = { current: '0.2.0', lastRun: '0.1.0', welcomeSeen: true, hasNotes: true }

describe('whether a start opens What is new', () => {
  it('opens once on a newer version with notes, and records it', () => {
    expect(decideWhatsNew(base)).toEqual({ open: true, remember: '0.2.0' })
  })

  it('does not open for a profile with no history at all, and records the version', () => {
    expect(decideWhatsNew({ ...base, lastRun: undefined, welcomeSeen: false })).toEqual({ open: false, remember: '0.2.0' })
  })

  it('opens for a profile that ran before versions were remembered', () => {
    expect(decideWhatsNew({ ...base, lastRun: undefined })).toEqual({ open: true, remember: '0.2.0' })
  })

  it('does nothing on the same version', () => {
    expect(decideWhatsNew({ ...base, lastRun: '0.2.0' })).toEqual({ open: false, remember: undefined })
  })

  it('does nothing on a downgrade and leaves the newer version written', () => {
    expect(decideWhatsNew({ ...base, lastRun: '0.3.0' })).toEqual({ open: false, remember: undefined })
  })

  it('records a newer version that has no notes without opening a page', () => {
    expect(decideWhatsNew({ ...base, hasNotes: false })).toEqual({ open: false, remember: '0.2.0' })
  })

  it('orders a pre-release before its release and by number, not by text', () => {
    expect(decideWhatsNew({ ...base, current: '0.10.0', lastRun: '0.9.0' }).open).toBe(true)
    expect(decideWhatsNew({ ...base, current: '1.0.0', lastRun: '1.0.0-rc.1' }).open).toBe(true)
    expect(decideWhatsNew({ ...base, current: '1.0.0-rc.1', lastRun: '1.0.0' }).open).toBe(false)
  })

  it('reads an unreadable remembered version as older', () => {
    expect(decideWhatsNew({ ...base, lastRun: 'banana' })).toEqual({ open: true, remember: '0.2.0' })
  })

  it('does nothing when the running version is not a version at all (a build from source)', () => {
    expect(decideWhatsNew({ ...base, current: 'dev' })).toEqual({ open: false, remember: undefined })
  })
})
