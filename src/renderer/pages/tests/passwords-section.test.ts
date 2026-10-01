import { describe, expect, it, vi } from 'vitest'
import { passwords } from '../settings/sections/passwords.js'
import { PasswordsPart } from '../settings/passwords/passwords-part.js'
import { SETTINGS_PARTS } from '../settings/settings-parts.js'
import { sectionsFor } from '../settings/sections/index.js'
import { SettingsState } from '../settings/state.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { Row } from '../settings/model.js'

function stateWith (vault: 'ready' | 'unavailable' | 'private' | null, never: string[] = []): SettingsState {
  const bridge = { request: vi.fn(async () => await Promise.resolve(undefined)), onEvent: () => () => {} } as unknown as OrivonInternal
  const state = new SettingsState(bridge)
  const part = state.part<PasswordsPart>('passwords')
  part.vault = vault
  part.never = never
  return state
}

const row = (id: string): Row => passwords.rows.find((candidate) => candidate.id === id) as Row

describe('the Passwords section', () => {
  it('is registered as a Settings part and listed as a section', () => {
    expect(SETTINGS_PARTS.map((part) => part.name)).toContain('passwords')
    expect(sectionsFor(stateWith('ready')).map((section) => section.id)).toContain('passwords')
  })

  it('has the rows in the order the page shows them, each findable by search words', () => {
    expect(passwords.rows.map((candidate) => candidate.id)).toEqual(['password-storage', 'passwords-offer-to-save', 'passwords-autofill', 'saved-passwords', 'passwords-never', 'password-generator'])
    for (const candidate of passwords.rows) expect(candidate.keywords?.length, candidate.id).toBeGreaterThan(0)
  })

  it('shows the two toggles for the two keys the prelude declared', () => {
    expect(row('passwords-offer-to-save').control).toMatchObject({ type: 'toggle', key: 'passwords.offerToSave' })
    expect(row('passwords-autofill').control).toMatchObject({ type: 'toggle', key: 'passwords.autofill' })
    expect(row('passwords-offer-to-save').label).toBe('Offer to save passwords')
    expect(row('passwords-autofill').label).toBe('Offer saved passwords when signing in')
  })

  it('disables the toggles and shows the status row when nothing can be kept', () => {
    for (const vault of ['unavailable', 'private'] as const) {
      const state = stateWith(vault)
      expect(row('password-storage').visible?.(state)).toBe(true)
      for (const id of ['passwords-offer-to-save', 'passwords-autofill']) {
        const control = row(id).control
        expect(control.type === 'toggle' && control.disabled?.(state), `${vault} ${id}`).toBe(true)
      }
    }
  })

  it('leaves the toggles on, and the status row out, while passwords can be kept or are still loading', () => {
    for (const vault of ['ready', null] as const) {
      const state = stateWith(vault)
      expect(row('password-storage').visible?.(state)).toBe(false)
      const control = row('passwords-autofill').control
      expect(control.type === 'toggle' && control.disabled?.(state)).toBe(false)
    }
  })

  it('shows the never-saved row only when there is a site in it', () => {
    expect(row('passwords-never').visible?.(stateWith('ready'))).toBe(false)
    expect(row('passwords-never').visible?.(stateWith('ready', ['https://never.example']))).toBe(true)
  })
})
