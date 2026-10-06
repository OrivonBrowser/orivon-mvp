import { describe, expect, it } from 'vitest'
import { atStartup, readLaunchRequest, requestFromArgv } from '../launch-request.js'

const SOURCE = ['/usr/lib/electron', '/home/p/orivon']
const PACKAGED = ['/opt/Orivon/orivon']

const NOTHING_THERE = { cwd: '/work', platform: 'linux' as const, kindOf: () => undefined }

describe('requestFromArgv', () => {
  it('is a window when a source run names no operand, and when a packaged run names none', () => {
    expect(requestFromArgv([...SOURCE, '--no-sandbox', '--user-data-dir=/x'], false)).toEqual({ kind: 'window', urls: [] })
    expect(requestFromArgv([...PACKAGED, '--orivon-profile=0123456789ab'], true)).toEqual({ kind: 'window', urls: [] })
  })

  it('reads the app path of a source run as the program, never as an operand', () => {
    expect(requestFromArgv(['/usr/lib/electron', '--no-sandbox', '.', 'https://a.example/'], false)).toEqual({ kind: 'open', urls: ['https://a.example/'] })
    expect(requestFromArgv([...PACKAGED, 'https://a.example/'], true)).toEqual({ kind: 'open', urls: ['https://a.example/'] })
  })

  it('is an open with no address for an operand that is not a web address, so it only focuses', () => {
    expect(requestFromArgv([...SOURCE, './a.html'], false, NOTHING_THERE)).toEqual({ kind: 'open', urls: [] })
    expect(requestFromArgv([...PACKAGED, 'mailto:x@y.example'], true, NOTHING_THERE)).toEqual({ kind: 'open', urls: [] })
    expect(requestFromArgv([...PACKAGED, 'file://server/share/a.html'], true, NOTHING_THERE)).toEqual({ kind: 'open', urls: [] })
  })

  it('opens a file: URI and an existing path, resolved against the directory of the start', () => {
    const disk = { cwd: '/work', platform: 'linux' as const, kindOf: (path: string) => path === '/work/notes/a.html' ? 'file' as const : undefined }
    expect(requestFromArgv([...PACKAGED, 'notes/a.html', 'file:///tmp/b.html', 'missing.html'], true, disk))
      .toEqual({ kind: 'open', urls: ['file:///work/notes/a.html', 'file:///tmp/b.html'] })
    expect(requestFromArgv([...SOURCE, 'notes/a.html'], false, disk)).toEqual({ kind: 'open', urls: ['file:///work/notes/a.html'] })
  })

  it('never reads the app path of a source run as a file', () => {
    const disk = { cwd: '/work', platform: 'linux' as const, kindOf: () => 'directory' as const }
    expect(requestFromArgv(['/usr/lib/electron', '.'], false, disk)).toEqual({ kind: 'window', urls: [] })
  })

  it('is a window with its addresses for --new-window', () => {
    expect(requestFromArgv([...PACKAGED, '--new-window', 'https://a.example/'], true)).toEqual({ kind: 'window', urls: ['https://a.example/'] })
    expect(requestFromArgv([...PACKAGED, '--new-window'], true)).toEqual({ kind: 'window', urls: [] })
  })

  it('is a private window for --new-private-window, which wins over --new-window', () => {
    expect(requestFromArgv([...PACKAGED, '--new-private-window'], true)).toEqual({ kind: 'private', urls: [] })
    expect(requestFromArgv([...PACKAGED, '--new-window', '--new-private-window', 'https://a.example/'], true)).toEqual({ kind: 'private', urls: ['https://a.example/'] })
  })

  it('reads what follows -- as operands, however they start', () => {
    expect(requestFromArgv([...PACKAGED, '--', 'https://a.example/'], true)).toEqual({ kind: 'open', urls: ['https://a.example/'] })
    expect(requestFromArgv([...PACKAGED, '--', '--new-window'], true)).toEqual({ kind: 'open', urls: [] })
  })

  it('keeps at most eight addresses', () => {
    const many = Array.from({ length: 12 }, (_, index) => `https://h${String(index)}.example/`)
    expect(requestFromArgv([...PACKAGED, ...many], true).urls).toHaveLength(8)
  })
})

describe('atStartup', () => {
  it('turns a new window with no address into a bring-forward, since the first window is that window', () => {
    expect(atStartup({ kind: 'window', urls: [] })).toEqual({ kind: 'open', urls: [] })
  })

  it('leaves what has an address or is a private session as it is', () => {
    expect(atStartup({ kind: 'window', urls: ['https://a.example/'] })).toEqual({ kind: 'window', urls: ['https://a.example/'] })
    expect(atStartup({ kind: 'open', urls: ['https://a.example/'] })).toEqual({ kind: 'open', urls: ['https://a.example/'] })
    expect(atStartup({ kind: 'private', urls: [] })).toEqual({ kind: 'private', urls: [] })
  })
})

describe('readLaunchRequest', () => {
  const argv = [...PACKAGED, 'https://from-argv.example/']

  it('is what the second start sent, when it is well formed', () => {
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'window', urls: ['https://a.example/'] }, argv)).toEqual({ kind: 'window', urls: ['https://a.example/'] })
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'private', urls: [] }, argv)).toEqual({ kind: 'private', urls: [] })
  })

  it('keeps a local file the second start sent, and falls back on a list with a malformed one', () => {
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'open', urls: ['file:///tmp/a.html', 'https://a.example/'] }, argv))
      .toEqual({ kind: 'open', urls: ['file:///tmp/a.html', 'https://a.example/'] })
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'open', urls: ['file://server/share/a.html'] }, argv)).toEqual({ kind: 'open', urls: ['https://from-argv.example/'] })
  })

  it('falls back to opening the addresses on the command line for anything else', () => {
    const fallback = { kind: 'open', urls: ['https://from-argv.example/'] }
    expect(readLaunchRequest(undefined, argv)).toEqual(fallback)
    expect(readLaunchRequest(null, argv)).toEqual(fallback)
    expect(readLaunchRequest('window', argv)).toEqual(fallback)
    expect(readLaunchRequest({ orivonLaunch: 2, kind: 'window', urls: [] }, argv)).toEqual(fallback)
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'quit', urls: [] }, argv)).toEqual(fallback)
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'window', urls: 'https://a.example/' }, argv)).toEqual(fallback)
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'window', urls: ['javascript:alert(1)'] }, argv)).toEqual(fallback)
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'window', urls: [7] }, argv)).toEqual(fallback)
    const nine = Array.from({ length: 9 }, (_, index) => `https://h${String(index)}.example/`)
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'window', urls: nine }, argv)).toEqual(fallback)
  })
})
