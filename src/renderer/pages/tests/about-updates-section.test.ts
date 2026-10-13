import { describe, expect, it } from 'vitest'
import { about } from '../settings/sections/about.js'
import type { AboutInfo } from '../settings/state.js'
import type { SettingsState } from '../settings/state.js'
import type { Row } from '../settings/model.js'

const row = (id: string): Row => about.rows.find((candidate) => candidate.id === id) as Row

const INFO: AboutInfo = { version: '1.0.0', electron: '44', chromium: '150', node: '24', platform: 'win32', userAgent: 'x', developerMode: false, updatesFromStore: false }

function state (over: Partial<AboutInfo>, isPrivate = false): SettingsState {
  return { about: { ...INFO, ...over }, profiles: { isPrivate }, updates: { words: () => '', available: () => null } } as unknown as SettingsState
}

describe('the update rows of About', () => {
  it('offer the switch and the check to a build that looks for itself', () => {
    expect(row('updates-check').visible?.(state({}))).toBe(true)
    expect(row('updates-now').visible?.(state({}))).toBe(true)
    expect(row('updates-store').visible?.(state({}))).toBe(false)
  })

  it('offer neither in a Store install, and say where updates come from instead', () => {
    const store = state({ updatesFromStore: true })
    expect(row('updates-check').visible?.(store)).toBe(false)
    expect(row('updates-now').visible?.(store)).toBe(false)
    expect(row('updates-store').visible?.(store)).toBe(true)
    expect((row('updates-store').control as { text: (s: SettingsState) => string }).text(store)).toContain('Microsoft Store')
  })

  it('keep the check out of a private window, as before', () => {
    expect(row('updates-now').visible?.(state({}, true))).toBe(false)
  })
})
