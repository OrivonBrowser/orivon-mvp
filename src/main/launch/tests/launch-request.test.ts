import { describe, expect, it } from 'vitest'
import { readLaunchRequest, requestFromArgv } from '../launch-request.js'

const SOURCE = ['/usr/lib/electron', '/home/p/orivon']
const PACKAGED = ['/opt/Orivon/orivon']

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
    expect(requestFromArgv([...SOURCE, './a.html'], false)).toEqual({ kind: 'open', urls: [] })
    expect(requestFromArgv([...PACKAGED, 'mailto:x@y.example'], true)).toEqual({ kind: 'open', urls: [] })
    expect(requestFromArgv([...PACKAGED, 'file:///etc/passwd'], true)).toEqual({ kind: 'open', urls: [] })
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

describe('readLaunchRequest', () => {
  const argv = [...PACKAGED, 'https://from-argv.example/']

  it('is what the second start sent, when it is well formed', () => {
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'window', urls: ['https://a.example/'] }, argv)).toEqual({ kind: 'window', urls: ['https://a.example/'] })
    expect(readLaunchRequest({ orivonLaunch: 1, kind: 'private', urls: [] }, argv)).toEqual({ kind: 'private', urls: [] })
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
