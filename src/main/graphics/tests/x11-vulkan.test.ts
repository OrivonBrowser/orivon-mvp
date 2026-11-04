import { describe, expect, it } from 'vitest'
import {
  NO_GUARD_RECORD, applyX11Vulkan, guardRecordFrom, offersX11Setting, ozonePlatformOf, planStart, revertAfterEnd, revertAfterStatus, sameGuardRecord, turnedOn, windowPainted
} from '../x11-vulkan.js'
import type { GuardRecord } from '../x11-vulkan.js'

const NOW = new Date('2026-11-04T12:00:00.000Z')
const REVERT = { at: '2026-11-03T08:00:00.000Z', why: 'gpu-crash' } as const

describe('ozonePlatformOf', () => {
  const on = (ozoneSwitch: string, sessionType: string, platform = 'linux'): string => ozonePlatformOf({ platform, ozoneSwitch, sessionType })

  it('takes the switch when one is set, whatever the session says', () => {
    expect(on('x11', 'wayland')).toBe('x11')
    expect(on('wayland', 'x11')).toBe('wayland')
    expect(on('headless', '')).toBe('headless')
  })

  it('is Wayland on a Wayland session and X11 on every other session, as Chromium 152 decides with no switch', () => {
    expect(on('', 'wayland')).toBe('wayland')
    expect(on('', 'x11')).toBe('x11')
    expect(on('', 'tty')).toBe('x11')
    expect(on('', '')).toBe('x11')
  })

  it('names no platform off Linux, where there is no Ozone', () => {
    expect(on('', '', 'win32')).toBe('')
    expect(on('x11', 'x11', 'darwin')).toBe('')
  })
})

describe('where the setting applies and is offered', () => {
  const x11Session = { platform: 'linux', ozoneSwitch: 'x11', sessionType: 'x11' }
  const xwayland = { platform: 'linux', ozoneSwitch: 'x11', sessionType: 'wayland' }

  it('is an X11 session on Linux: Ozone X11 and a session that is not Wayland', () => {
    expect(offersX11Setting(x11Session)).toBe(true)
    expect(offersX11Setting({ platform: 'linux', ozoneSwitch: '', sessionType: '' })).toBe(true)
    expect(offersX11Setting({ platform: 'linux', ozoneSwitch: '', sessionType: 'tty' })).toBe(true)
  })

  it('is not Orivon on X11 inside a Wayland session (XWayland), not Wayland, not off Linux', () => {
    expect(offersX11Setting(xwayland)).toBe(false)
    expect(offersX11Setting({ platform: 'linux', ozoneSwitch: '', sessionType: 'wayland' })).toBe(false)
    expect(offersX11Setting({ platform: 'linux', ozoneSwitch: 'wayland', sessionType: 'wayland' })).toBe(false)
    expect(offersX11Setting({ platform: 'win32', ozoneSwitch: '', sessionType: '' })).toBe(false)
    expect(offersX11Setting({ platform: 'darwin', ozoneSwitch: 'x11', sessionType: '' })).toBe(false)
  })
})

describe('applyX11Vulkan', () => {
  function commandLine (initial: Record<string, string> = {}): { switches: Map<string, string>, getSwitchValue: (name: string) => string, appendSwitch: (name: string, value: string) => void } {
    const switches = new Map(Object.entries(initial))
    return { switches, getSwitchValue: (name) => switches.get(name) ?? '', appendSwitch: (name, value) => { switches.set(name, value) } }
  }

  it('sets the ANGLE backend and both features', () => {
    const line = commandLine()
    applyX11Vulkan(line)
    expect(line.switches.get('use-angle')).toBe('vulkan')
    expect(line.switches.get('enable-features')).toBe('Vulkan,VulkanFromANGLE')
  })

  it('keeps the features another part already listed, and lists none twice', () => {
    const line = commandLine({ 'enable-features': 'GlobalPrivacyControlForce,Vulkan' })
    applyX11Vulkan(line)
    expect(line.switches.get('enable-features')).toBe('GlobalPrivacyControlForce,Vulkan,VulkanFromANGLE')
    applyX11Vulkan(line)
    expect(line.switches.get('enable-features')).toBe('GlobalPrivacyControlForce,Vulkan,VulkanFromANGLE')
  })
})

describe('guardRecordFrom', () => {
  it('reads a record it wrote', () => {
    const record: GuardRecord = { pendingWindow: true, revert: REVERT }
    expect(guardRecordFrom(JSON.parse(JSON.stringify(record)))).toEqual(record)
  })

  it('reads each reason a revert can have', () => {
    for (const why of ['gpu-crash', 'gpu-software', 'no-window']) expect(guardRecordFrom({ pendingWindow: false, revert: { at: REVERT.at, why } }).revert?.why).toBe(why)
  })

  it('reads anything else as no record', () => {
    for (const bad of [undefined, null, 'x', 7, [], {}]) expect(guardRecordFrom(bad)).toEqual(NO_GUARD_RECORD)
  })

  it('drops a revert that has no date or a reason it does not know, and keeps the marker', () => {
    expect(guardRecordFrom({ pendingWindow: true, revert: { at: 'yesterday', why: 'gpu-crash' } })).toEqual({ pendingWindow: true, revert: null })
    expect(guardRecordFrom({ pendingWindow: false, revert: { at: REVERT.at, why: 'because' } })).toEqual(NO_GUARD_RECORD)
    expect(guardRecordFrom({ pendingWindow: 'yes', revert: { at: 7, why: 'gpu-crash' } })).toEqual(NO_GUARD_RECORD)
  })
})

describe('planStart', () => {
  const pending: GuardRecord = { pendingWindow: true, revert: null }
  const reverted: GuardRecord = { pendingWindow: false, revert: REVERT }

  it('does nothing off an X11 session, and leaves the record as it was', () => {
    for (const record of [NO_GUARD_RECORD, pending, reverted]) {
      expect(planStart({ onX11: false, setting: true, record, now: NOW })).toEqual({ applySwitches: false, turnOff: false, record })
    }
  })

  it('sets no switches while the setting is off, and clears a marker an earlier run left', () => {
    expect(planStart({ onX11: true, setting: false, record: NO_GUARD_RECORD, now: NOW })).toEqual({ applySwitches: false, turnOff: false, record: NO_GUARD_RECORD })
    expect(planStart({ onX11: true, setting: false, record: pending, now: NOW }).record).toEqual(NO_GUARD_RECORD)
  })

  it('keeps the revert while the setting stays off', () => {
    expect(planStart({ onX11: true, setting: false, record: reverted, now: NOW }).record).toEqual(reverted)
  })

  it('sets the switches and writes the marker when the setting is on and the last run left none', () => {
    expect(planStart({ onX11: true, setting: true, record: NO_GUARD_RECORD, now: NOW })).toEqual({ applySwitches: true, turnOff: false, record: pending })
  })

  it('treats a setting that is on beside a revert as turned off, because the save of the turn-off was lost: no switches, off again, the record kept', () => {
    expect(planStart({ onX11: true, setting: true, record: reverted, now: NOW })).toEqual({ applySwitches: false, turnOff: true, record: reverted })
  })

  it('keeps the revert that explains a run when that run also left its marker, and does not add a second one', () => {
    const both: GuardRecord = { pendingWindow: true, revert: REVERT }
    expect(planStart({ onX11: true, setting: true, record: both, now: NOW })).toEqual({ applySwitches: false, turnOff: true, record: reverted })
  })

  it('reverts, with the time, when the last run set the switches and never showed its window', () => {
    expect(planStart({ onX11: true, setting: true, record: pending, now: NOW })).toEqual({
      applySwitches: false,
      turnOff: true,
      record: { pendingWindow: false, revert: { at: NOW.toISOString(), why: 'no-window' } }
    })
  })

  it('a start after that revert finds the setting off and the record kept', () => {
    const first = planStart({ onX11: true, setting: true, record: pending, now: NOW })
    expect(planStart({ onX11: true, setting: false, record: first.record, now: NOW })).toEqual({ applySwitches: false, turnOff: false, record: first.record })
  })
})

describe('the record through a run', () => {
  it('is cleared of its marker when the first window has painted, and only then', () => {
    expect(windowPainted({ pendingWindow: true, revert: null })).toEqual(NO_GUARD_RECORD)
    const record: GuardRecord = { pendingWindow: false, revert: REVERT }
    expect(windowPainted(record)).toBe(record)
  })

  it('forgets the revert when the setting is turned on again', () => {
    expect(turnedOn({ pendingWindow: true, revert: REVERT })).toEqual({ pendingWindow: true, revert: null })
    expect(sameGuardRecord(turnedOn(NO_GUARD_RECORD), NO_GUARD_RECORD)).toBe(true)
  })

  it('tells two records apart', () => {
    expect(sameGuardRecord({ pendingWindow: true, revert: REVERT }, { pendingWindow: true, revert: { ...REVERT } })).toBe(true)
    expect(sameGuardRecord({ pendingWindow: true, revert: REVERT }, { pendingWindow: false, revert: REVERT })).toBe(false)
    expect(sameGuardRecord({ pendingWindow: false, revert: REVERT }, NO_GUARD_RECORD)).toBe(false)
    expect(sameGuardRecord({ pendingWindow: false, revert: REVERT }, { pendingWindow: false, revert: { ...REVERT, why: 'no-window' } })).toBe(false)
  })
})

describe('revertAfterStatus', () => {
  const settled = { applied: true, compositing: 'disabled_software', now: NOW }

  it('reverts when the switches are set and Chromium draws pages on the processor anyway', () => {
    for (const compositing of ['disabled_software', 'disabled_off', 'unavailable_off']) {
      expect(revertAfterStatus({ ...settled, compositing }), compositing).toEqual({ at: NOW.toISOString(), why: 'gpu-software' })
    }
  })

  it('does not revert while the graphics process draws, when no status is known, or in a run that set no switches', () => {
    expect(revertAfterStatus({ ...settled, compositing: 'enabled' })).toBeUndefined()
    expect(revertAfterStatus({ ...settled, compositing: 'enabled_on' })).toBeUndefined()
    expect(revertAfterStatus({ ...settled, compositing: undefined })).toBeUndefined()
    expect(revertAfterStatus({ ...settled, applied: false })).toBeUndefined()
  })
})

describe('revertAfterEnd', () => {
  const end = { applied: true, processType: 'GPU', reason: 'crashed', quitting: false, now: NOW }

  it('reverts when the graphics process ended badly in a run that set the switches', () => {
    for (const reason of ['crashed', 'abnormal-exit', 'launch-failed', 'oom', 'integrity-failure']) {
      expect(revertAfterEnd({ ...end, reason })).toEqual({ at: NOW.toISOString(), why: 'gpu-crash' })
    }
  })

  it('does not revert for an ordinary end, another kind of process, or a run that set no switches', () => {
    expect(revertAfterEnd({ ...end, reason: 'clean-exit' })).toBeUndefined()
    expect(revertAfterEnd({ ...end, reason: 'killed' })).toBeUndefined()
    expect(revertAfterEnd({ ...end, reason: 'memory-eviction' })).toBeUndefined()
    expect(revertAfterEnd({ ...end, processType: 'Utility' })).toBeUndefined()
    expect(revertAfterEnd({ ...end, processType: 'Tab' })).toBeUndefined()
    expect(revertAfterEnd({ ...end, applied: false })).toBeUndefined()
  })

  it('does not revert for any end while Orivon quits or starts again, however the system reports it', () => {
    for (const reason of ['crashed', 'abnormal-exit', 'launch-failed', 'oom', 'integrity-failure', 'killed']) {
      expect(revertAfterEnd({ ...end, reason, quitting: true }), reason).toBeUndefined()
    }
  })
})
