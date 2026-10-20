import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeaturedStore } from '../../newtab/featured-store.js'
import { applyFirstRunFlavour, FLAVOUR_FILE, installFirstRunFlavour, storedFlavour } from '../first-run-flavour.js'
import { parseFlavours } from '../flavours.js'

const flavours = parseFlavours({ flavours: [
  { id: 'freetube', app: 'freetube.orivonstack.eth', name: 'FreeTube', port: 'freetube' },
  { id: 'explore', app: 'explore.orivonstack.eth', name: 'Explore', port: 'explore' }
] })

let dir: string
let featured: FeaturedStore
const openApp = vi.fn()
const NOW = new Date('2026-10-20T10:00:00.000Z')

function install (isNewDefaultProfile = true): void {
  installFirstRunFlavour({ dir, isNewDefaultProfile, flavours, featured, openApp, now: () => NOW })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-flavour-'))
  featured = new FeaturedStore(null)
  openApp.mockReset()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('applyFirstRunFlavour', () => {
  it('opens the app, pins it first under its own name, and stores the id once', () => {
    install()
    expect(applyFirstRunFlavour('freetube')).toBe(true)
    expect(openApp).toHaveBeenCalledExactlyOnceWith('ipfs://freetube.orivonstack.eth')
    expect(featured.get()).toMatchObject({ newcomerPin: 'freetube', newcomerName: 'FreeTube' })
    expect(JSON.parse(readFileSync(join(dir, FLAVOUR_FILE), 'utf8'))).toEqual({ id: 'freetube', appliedAt: NOW.toISOString() })
    expect(storedFlavour(dir)).toBe('freetube')
  })

  it('applies once: a second id, or the same one again, does nothing', () => {
    install()
    expect(applyFirstRunFlavour('freetube')).toBe(true)
    expect(applyFirstRunFlavour('explore')).toBe(false)
    expect(applyFirstRunFlavour('freetube')).toBe(false)
    expect(openApp).toHaveBeenCalledTimes(1)
  })

  it('applies once across starts: a stored id stops a later process, however the tag arrives', () => {
    writeFileSync(join(dir, FLAVOUR_FILE), JSON.stringify({ id: 'explore', appliedAt: NOW.toISOString() }))
    install()
    expect(applyFirstRunFlavour('freetube')).toBe(false)
    expect(openApp).not.toHaveBeenCalled()
    expect(featured.get().newcomerPin).toBeNull()
  })

  it('does nothing for an id that is not on the allowlist, malformed, or an address', () => {
    install()
    for (const id of ['', 'unknown', 'FreeTube', '../x', 'https://evil.example', 'ipfs://freetube.orivonstack.eth', 'free tube', 'ledgerwallet']) {
      expect(applyFirstRunFlavour(id), id).toBe(false)
    }
    expect(openApp).not.toHaveBeenCalled()
    expect(existsSync(join(dir, FLAVOUR_FILE))).toBe(false)
    expect(featured.get().given).toBe(false)
  })

  it('does nothing unless the profile is a new default profile', () => {
    install(false)
    expect(applyFirstRunFlavour('freetube')).toBe(false)
    expect(openApp).not.toHaveBeenCalled()
    expect(existsSync(join(dir, FLAVOUR_FILE))).toBe(false)
    expect(featured.get().given).toBe(false)
  })

  it('does nothing before the launch has installed it', () => {
    installFirstRunFlavour({ dir, isNewDefaultProfile: false, flavours: [], featured, openApp })
    expect(applyFirstRunFlavour('freetube')).toBe(false)
  })

  it('still applies when the id cannot be written down, and says nothing more than the log', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    installFirstRunFlavour({ dir: join(dir, 'missing', 'deeper'), isNewDefaultProfile: true, flavours, featured, openApp })
    expect(applyFirstRunFlavour('explore')).toBe(true)
    expect(openApp).toHaveBeenCalledTimes(1)
    quiet.mockRestore()
  })

  it('leaves the pin removed when the person removed it: nothing gives a second', () => {
    install()
    applyFirstRunFlavour('freetube')
    featured.hide('freetube')
    expect(featured.setNewcomerPin('ipfs://freetube.orivonstack.eth', 'FreeTube')).toBe(false)
    expect(featured.get().newcomerPin).toBeNull()
  })
})
