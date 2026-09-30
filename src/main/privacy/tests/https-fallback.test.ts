import { describe, expect, it } from 'vitest'
import { createUpgradeTracker, FALLBACK_WINDOW_MS, LOOP_WINDOW_MS } from '../https-fallback.js'

const FROM = 'http://site.example/a'
const TO = 'https://site.example/a'

function rig (): { tracker: ReturnType<typeof createUpgradeTracker>, advance: (ms: number) => void } {
  let time = 1000
  return { tracker: createUpgradeTracker(() => time), advance: (ms) => { time += ms } }
}

describe('the upgrade tracker', () => {
  it('reports the upgrade a failed load of its target ends, once', () => {
    const { tracker } = rig()
    tracker.noteUpgrade(1, FROM, TO)
    expect(tracker.failed(1, TO, -102)).toMatchObject({ from: FROM, to: TO })
    expect(tracker.failed(1, TO, -102)).toBeNull()
  })

  it('ignores a failure in another tab or of another host', () => {
    const { tracker } = rig()
    tracker.noteUpgrade(1, FROM, TO)
    expect(tracker.failed(2, TO, -102)).toBeNull()
    expect(tracker.failed(1, 'https://elsewhere.example/', -102)).toBeNull()
    expect(tracker.failed(1, FROM, -102)).toBeNull()
    expect(tracker.failed(1, TO, -102)).not.toBeNull()
  })

  it('ignores a load that was cancelled or never reached a server', () => {
    const { tracker } = rig()
    for (const code of [-3, -21, -105, -106, -137]) {
      tracker.noteUpgrade(1, FROM, TO)
      expect(tracker.failed(1, TO, code)).toBeNull()
    }
  })

  it('counts a refused connection, a reset, a timeout and a certificate error', () => {
    for (const code of [-102, -101, -118, -7, -107, -200, -201, -202, -324]) {
      const { tracker } = rig()
      tracker.noteUpgrade(1, FROM, TO)
      expect(tracker.failed(1, TO, code)).not.toBeNull()
    }
  })

  it('forgets an upgrade after the window, so a later unrelated failure is an ordinary error', () => {
    const { tracker, advance } = rig()
    tracker.noteUpgrade(1, FROM, TO)
    advance(FALLBACK_WINDOW_MS + 1)
    expect(tracker.failed(1, TO, -102)).toBeNull()
  })

  it('closes the upgrade when the upgraded address loads', () => {
    const { tracker } = rig()
    tracker.noteUpgrade(1, FROM, TO)
    tracker.navigated(1, TO)
    expect(tracker.failed(1, TO, -102)).toBeNull()
  })

  it('keeps the upgrade when an unrelated page commits', () => {
    const { tracker } = rig()
    tracker.noteUpgrade(1, FROM, TO)
    tracker.navigated(1, 'https://elsewhere.example/')
    expect(tracker.failed(1, TO, -102)).not.toBeNull()
  })

  it('calls the same address upgraded twice within five seconds a loop', () => {
    const { tracker, advance } = rig()
    expect(tracker.noteUpgrade(1, FROM, TO)).toBe('upgrade')
    advance(LOOP_WINDOW_MS - 1)
    expect(tracker.noteUpgrade(1, FROM, TO)).toBe('loop')
  })

  it('does not call a second visit after the loop window a loop', () => {
    const { tracker, advance } = rig()
    tracker.noteUpgrade(1, FROM, TO)
    advance(LOOP_WINDOW_MS)
    expect(tracker.noteUpgrade(1, FROM, TO)).toBe('upgrade')
  })

  it('does not call two different addresses, or two tabs, a loop', () => {
    const { tracker } = rig()
    tracker.noteUpgrade(1, FROM, TO)
    expect(tracker.noteUpgrade(1, 'http://site.example/b', 'https://site.example/b')).toBe('upgrade')
    expect(tracker.noteUpgrade(2, 'http://site.example/b', 'https://site.example/b')).toBe('upgrade')
  })

  it('forgets a destroyed tab', () => {
    const { tracker } = rig()
    tracker.noteUpgrade(1, FROM, TO)
    tracker.forget(1)
    expect(tracker.failed(1, TO, -102)).toBeNull()
  })
})
