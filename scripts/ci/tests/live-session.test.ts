import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cloudflaredAsset, desktopShotCommand, functionBody, isTokenHash, newToken, serialize, tokenHash, tokenMatches, tunnelUrl
} from '../live-host.mjs'
import { errorText, formatReply, nextShotPath, saveShots, urlArtifact } from '../live-session.mjs'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'live-session-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the token', () => {
  const token = 'a'.repeat(64)
  const hash = tokenHash(token)

  it('is accepted only as `Bearer <token>` for the hash the runner was given', () => {
    expect(tokenMatches(`Bearer ${token}`, hash)).toBe(true)
    expect(tokenMatches(`Bearer ${'b'.repeat(64)}`, hash)).toBe(false)
    expect(tokenMatches(token, hash)).toBe(false)
    expect(tokenMatches(`bearer ${token}`, hash)).toBe(false)
    expect(tokenMatches(undefined, hash)).toBe(false)
  })

  it('matches nothing when the runner was given something other than a SHA-256', () => {
    expect(tokenMatches(`Bearer ${token}`, '')).toBe(false)
    expect(tokenMatches(`Bearer ${token}`, hash.toUpperCase())).toBe(false)
    expect(isTokenHash(hash)).toBe(true)
    expect(isTokenHash(`${hash}0`)).toBe(false)
  })

  it('made for a pull request is saved for the caller, and only its hash is returned', () => {
    const file = join(scratch(), 'token')
    const printed = newToken(file)
    const saved = readFileSync(file, 'utf8')
    expect(saved).toMatch(/^[0-9a-f]{64}$/)
    expect(printed).toBe(tokenHash(saved))
    expect(tokenMatches(`Bearer ${saved}`, printed)).toBe(true)
  })
})

describe('cloudflared', () => {
  it('is pinned per system, and refuses a system it has no pin for', () => {
    expect(cloudflaredAsset('win32', 'x64').url).toMatch(/releases\/download\/[\d.]+\/cloudflared-windows-amd64\.exe$/)
    expect(cloudflaredAsset('darwin', 'arm64').sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(() => cloudflaredAsset('linux', 'arm64')).toThrow('no pinned cloudflared for linux-arm64')
  })

  it('gives its quick tunnel address once a connection to it is registered', () => {
    const created = '2026-10-08T10:00:00Z INF |  https://quiet-river-1a2b.trycloudflare.com  |\n'
    expect(tunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeUndefined()
    expect(tunnelUrl(created)).toBeUndefined()
    expect(tunnelUrl(`${created}INF Registered tunnel connection connIndex=0 protocol=quic`)).toBe('https://quiet-river-1a2b.trycloudflare.com')
  })
})

describe('functionBody', () => {
  it('returns a lone expression', () => {
    expect(functionBody('chrome.url()')).toBe('return (chrome.url())')
    expect(functionBody(' await chrome.title(); ')).toBe('return (await chrome.title())')
  })

  it('leaves statements as they are', () => {
    expect(functionBody('log(1); return 2')).toBe('log(1); return 2')
    expect(functionBody('const a = 1\nlog(a)')).toBe('const a = 1\nlog(a)')
  })
})

describe('desktopShotCommand', () => {
  it('uses what each system has for a picture of the whole screen', () => {
    expect(desktopShotCommand('darwin', '/t/a.png')).toEqual({ file: 'screencapture', args: ['-x', '/t/a.png'] })
    expect(desktopShotCommand('linux', '/t/a.png')).toEqual({ file: 'import', args: ['-window', 'root', '/t/a.png'] })
    const windows = desktopShotCommand('win32', "C:\\it's\\a.png")
    expect(windows.file).toBe('powershell')
    expect(windows.args.at(-1)).toContain("$m.Save('C:\\it''s\\a.png'")
  })
})

describe('serialize', () => {
  it('turns what code returns into JSON a terminal can read', () => {
    const loop: Record<string, unknown> = { n: 10n }
    loop.self = loop
    expect(serialize(loop)).toBe('{"n":"10","self":"[circular]"}')
    expect(serialize(undefined)).toBe('undefined')
  })

  it('cuts a long value and says how much it left out', () => {
    const text = serialize('x'.repeat(20_010))
    expect(text).toMatch(/\.\.\. \[12 more characters\]$/)
  })
})

describe('the caller side', () => {
  it('names the address artifact per system, as the workflow uploads it', () => {
    expect(urlArtifact('windows')).toBe('live-session-url-windows')
  })

  it('numbers a picture after the ones already saved, with a file-safe name', () => {
    expect(nextShotPath('d', ['001-a.png', '003-b.png', 'notes.md'], 'tab bar/open')).toBe(join('d', '004-tab-bar-open.png'))
    expect(nextShotPath('d', [], 'desktop')).toBe(join('d', '001-desktop.png'))
  })

  it('saves the pictures a reply carries, in order', () => {
    const dir = scratch()
    const png = Buffer.from('not really a png').toString('base64')
    const saved = saveShots(dir, [{ name: 'chrome', png }, { name: 'desktop', png }])
    expect(saved).toEqual([join(dir, '001-chrome.png'), join(dir, '002-desktop.png')])
    expect(readdirSync(dir)).toHaveLength(2)
    expect(saveShots(dir, undefined)).toEqual([])
  })

  it('names the network code behind "fetch failed"', () => {
    expect(errorText(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) }))).toBe('fetch failed (ENOTFOUND)')
    expect(errorText(new Error('bad token'))).toBe('bad token')
  })

  it('prints the value or the error, then what the code logged', () => {
    expect(formatReply({ ok: true, value: '"orivon-shell://x"', logs: ['Orivon'] })).toBe('value: "orivon-shell://x"\nlog: Orivon')
    expect(formatReply({ ok: false, error: 'Error: boom' })).toBe('error: Error: boom')
  })
})
