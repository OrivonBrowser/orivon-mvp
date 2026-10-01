import { describe, expect, it } from 'vitest'
import { candidateRoots } from '../browser-roots.js'

const roots = (platform: NodeJS.Platform, home: string, env: Record<string, string> = {}) => candidateRoots(platform, home, env).map(({ browser, root }) => `${browser} ${root}`)

describe('candidateRoots', () => {
  it('lists the Linux places, including snap and flatpak installs', () => {
    const list = roots('linux', '/home/a')
    expect(list).toContain('chrome /home/a/.config/google-chrome')
    expect(list).toContain('edge /home/a/.config/microsoft-edge')
    expect(list).toContain('brave /home/a/.config/BraveSoftware/Brave-Browser')
    expect(list).toContain('chromium /home/a/snap/chromium/common/chromium')
    expect(list).toContain('chromium /home/a/.var/app/org.chromium.Chromium/config/chromium')
    expect(list).toContain('firefox /home/a/.mozilla/firefox')
    expect(list).toContain('firefox /home/a/snap/firefox/common/.mozilla/firefox')
    expect(list).toContain('firefox /home/a/.var/app/org.mozilla.firefox/.mozilla/firefox')
  })

  it('follows XDG_CONFIG_HOME where it is set', () => {
    expect(roots('linux', '/home/a', { XDG_CONFIG_HOME: '/cfg' })).toContain('chrome /cfg/google-chrome')
  })

  it('lists the macOS places', () => {
    const list = roots('darwin', '/Users/a')
    expect(list).toContain('chrome /Users/a/Library/Application Support/Google/Chrome')
    expect(list).toContain('firefox /Users/a/Library/Application Support/Firefox')
    expect(list.some((entry) => entry.includes('.config'))).toBe(false)
  })

  it('lists the Windows places from the environment, and from the home when it is empty', () => {
    const list = roots('win32', 'C:\\Users\\a', { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' })
    expect(list).toContain('chrome C:\\L\\Google\\Chrome\\User Data')
    expect(list).toContain('edge C:\\L\\Microsoft\\Edge\\User Data')
    expect(list).toContain('firefox C:\\R\\Mozilla\\Firefox')
    expect(roots('win32', 'C:\\Users\\a')).toContain('chrome C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data')
  })

  it('names every browser family once per place', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const all = candidateRoots(platform, '/h', {})
      expect(new Set(all.map((entry) => entry.root)).size).toBe(all.length)
      expect(all.filter((entry) => entry.family === 'firefox').every((entry) => entry.browser === 'firefox')).toBe(true)
    }
  })
})
