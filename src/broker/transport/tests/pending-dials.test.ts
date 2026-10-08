import { describe, expect, it } from 'vitest'
import { createPendingDials } from '../pending-dials.js'

const APP = 'https://app.example'
const OTHER = 'https://other.example'

describe('a cancel reaches only the call its own frame began', () => {
  it('aborts the signal of the call it names', () => {
    const dials = createPendingDials()
    const frame = {}
    const call = dials.begin(frame, APP, 'r1')

    dials.cancel(frame, APP, 'r1')

    expect(call.signal.aborted).toBe(true)
  })

  it('leaves another call of the same frame alone', () => {
    const dials = createPendingDials()
    const frame = {}
    const first = dials.begin(frame, APP, 'r1')
    const second = dials.begin(frame, APP, 'r2')

    dials.cancel(frame, APP, 'r2')

    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(true)
  })

  it('cannot cancel a call another frame began, even with the same request id and origin', () => {
    const dials = createPendingDials()
    const call = dials.begin({}, APP, 'r1')

    dials.cancel({}, APP, 'r1')

    expect(call.signal.aborted).toBe(false)
  })

  it('cannot cancel a call another origin began', () => {
    const dials = createPendingDials()
    const frame = {}
    const call = dials.begin(frame, APP, 'r1')

    dials.cancel(frame, OTHER, 'r1')

    expect(call.signal.aborted).toBe(false)
  })

  it('ignores a request id nothing began, and one already ended', () => {
    const dials = createPendingDials()
    const frame = {}
    const call = dials.begin(frame, APP, 'r1')
    call.end()

    dials.cancel(frame, APP, 'r1')
    dials.cancel(frame, APP, 'never')

    expect(call.signal.aborted).toBe(false)
  })

  it('keeps a reused request id pointing at the newest call when the older one ends', () => {
    const dials = createPendingDials()
    const frame = {}
    const older = dials.begin(frame, APP, 'r1')
    const newer = dials.begin(frame, APP, 'r1')

    older.end()
    dials.cancel(frame, APP, 'r1')

    expect(newer.signal.aborted).toBe(true)
  })
})
