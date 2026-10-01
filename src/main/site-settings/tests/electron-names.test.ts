import { describe, expect, it } from 'vitest'
import { checkOf, requestOf, SITE_ASKED_PERMISSIONS } from '../electron-names.js'

describe('requestOf', () => {
  it('maps a media request to the devices it names, camera and microphone together', () => {
    expect(requestOf('media', { mediaTypes: ['video'] })).toEqual({ kinds: ['camera'], sysex: false })
    expect(requestOf('media', { mediaTypes: ['audio'] })).toEqual({ kinds: ['microphone'], sysex: false })
    expect(requestOf('media', { mediaTypes: ['audio', 'video'] })).toEqual({ kinds: ['microphone', 'camera'], sysex: false })
    expect(requestOf('media', { mediaTypes: ['video', 'video'] })).toEqual({ kinds: ['camera'], sysex: false })
  })

  it('leaves a media request with no device type to the gate: it is a tab capture', () => {
    expect(requestOf('media', { mediaTypes: [] })).toBeUndefined()
    expect(requestOf('media', {})).toBeUndefined()
    expect(requestOf('media', null)).toBeUndefined()
    expect(requestOf('media', { mediaTypes: ['video', 'screen'] })).toBeUndefined()
    expect(requestOf('media', { mediaTypes: 'video' })).toBeUndefined()
  })

  it.each([
    ['clipboard-read', 'clipboardRead'],
    ['deprecated-sync-clipboard-read', 'clipboardRead'],
    ['geolocation', 'location'],
    ['midi', 'midi'],
    ['midiSysex', 'midi'],
    ['idle-detection', 'idle'],
    ['window-management', 'windowManagement']
  ])('maps %s to %s', (permission, kind) => {
    expect(requestOf(permission, {})?.kinds).toEqual([kind])
  })

  it('carries the stronger MIDI wording for every MIDI request, since one allow covers both', () => {
    expect(requestOf('midiSysex', {})?.sysex).toBe(true)
    expect(requestOf('midi', {})?.sysex).toBe(true)
    expect(requestOf('geolocation', {})?.sysex).toBe(false)
  })

  it('does not own any other name', () => {
    for (const name of ['notifications', 'fullscreen', 'openExternal', 'clipboard-sanitized-write', 'fileSystem', 'persistent-storage', 'unknown', '__proto__', 'toString']) {
      expect(requestOf(name, {})).toBeUndefined()
    }
  })
})

describe('checkOf', () => {
  it('maps a media check by its one device type, and refuses an unknown one', () => {
    expect(checkOf('media', { mediaType: 'video' })).toBe('camera')
    expect(checkOf('media', { mediaType: 'audio' })).toBe('microphone')
    expect(checkOf('media', { mediaType: 'unknown' })).toBe('unknown')
    expect(checkOf('media', {})).toBe('unknown')
  })

  it('maps the other names as a request does', () => {
    expect(checkOf('geolocation', {})).toBe('location')
    expect(checkOf('midiSysex', {})).toBe('midi')
    expect(checkOf('fullscreen', {})).toBeUndefined()
    expect(checkOf('notifications', {})).toBeUndefined()
  })
})

describe('SITE_ASKED_PERMISSIONS', () => {
  it('lists each name the asker answers, and only those', () => {
    expect([...SITE_ASKED_PERMISSIONS].sort()).toEqual(['clipboard-read', 'deprecated-sync-clipboard-read', 'geolocation', 'idle-detection', 'media', 'midi', 'midiSysex', 'window-management'])
    for (const name of SITE_ASKED_PERMISSIONS) {
      expect(requestOf(name, { mediaTypes: ['video'] }) ?? checkOf(name, {})).toBeDefined()
    }
  })
})
