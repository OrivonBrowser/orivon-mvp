import { describe, expect, it } from 'vitest'
import { cleanName, desktopEntry, entryFileName, execArgument, linkArguments, linkFileName, MAX_NAME, slugFor } from '../site-shortcut.js'

/** What a desktop environment reads from an `Exec=` line, following the Desktop Entry specification: the string-type
 * escapes first, then the argument quoting (a backslash escapes `"`, backtick, `$` and backslash inside quotes). */
function readExec (line: string): string[] {
  const value = line.replace(/\\(.)/g, (_all, c: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' }[c] ?? c))
  const args: string[] = []
  let current = ''
  let inQuotes = false
  let started = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string
    if (inQuotes) {
      if (c === '\\') { current += value[++i] ?? ''; continue }
      if (c === '"') { inQuotes = false; continue }
      current += c
    } else if (c === '"') { inQuotes = true; started = true } else if (c === ' ') {
      if (started || current !== '') args.push(current)
      current = ''
      started = false
    } else current += c
  }
  if (started || current !== '') args.push(current)
  // `%%` is how a launcher is told a literal percent sign.
  return args.map((arg) => arg.replace(/%%/g, '%'))
}

const execLineOf = (text: string): string => {
  const lines = text.split('\n').filter((line) => line.startsWith('Exec='))
  expect(lines).toHaveLength(1)
  return (lines[0] as string).slice('Exec='.length)
}

/** Field codes other than %% would be replaced by the launcher: none may survive unescaped. */
const fieldCodes = (line: string): string[] => [...line.replace(/%%/g, '').matchAll(/%./g)].map((m) => m[0])

const HOSTILE = [
  'https://example.com/a b',
  'https://example.com/?q=$(touch /tmp/pwned)',
  'https://example.com/?q=`id`',
  'https://example.com/%f%U%u%F',
  'https://example.com/a;b;c',
  'https://example.com/back\\slash',
  'https://example.com/"quoted"',
  'https://example.com/\nExec=/bin/sh'
]

describe('cleanName', () => {
  it('keeps an ordinary title, trimmed and on one line', () => {
    expect(cleanName('  Example   Domain \n', 'x')).toBe('Example Domain')
  })

  it('removes control characters, separators and direction marks', () => {
    expect(cleanName('a\u0000b\u001bc\u007fd\u0085e\u2028f\u202eg\u2066h', 'x')).toBe('a b c d e f g h')
    expect(cleanName('Line one\nExec=/bin/sh', 'x')).toBe('Line one Exec=/bin/sh')
  })

  it('is cut at 60 characters, by characters', () => {
    expect(Array.from(cleanName('😀'.repeat(100), 'x'))).toHaveLength(MAX_NAME)
    expect(cleanName('a'.repeat(100), 'x')).toHaveLength(60)
  })

  it('falls back to the given name when nothing is left', () => {
    expect(cleanName(' \n\u0000 ', 'example.com')).toBe('example.com')
  })
})

describe('slugFor and entryFileName', () => {
  it('builds a slug of [a-z0-9-] from the host', () => {
    expect(slugFor('https://www.Example.co.uk/a')).toBe('www-example-co-uk')
    expect(slugFor('http://127.0.0.1:8080/')).toBe('127-0-0-1')
    expect(slugFor('https://ünïcode.example/')).toMatch(/^[a-z0-9-]+$/)
    expect(slugFor('not a url')).toBe('site')
    expect(slugFor('https://[::1]/')).toMatch(/^[a-z0-9-]+$/)
  })

  it('names the file orivon-<slug>-<8 hex>.desktop, with nothing from the page but the host', () => {
    for (const url of HOSTILE) expect(entryFileName(url), url).toMatch(/^orivon-[a-z0-9-]+-[0-9a-f]{8}\.desktop$/)
    expect(entryFileName('https://example.com/')).toBe(entryFileName('https://example.com/'))
    expect(entryFileName('https://example.com/a')).not.toBe(entryFileName('https://example.com/b'))
  })

  it('keeps one site in two profiles as two files', () => {
    expect(entryFileName('https://example.com/', '0123456789ab')).not.toBe(entryFileName('https://example.com/'))
  })
})

describe('desktopEntry', () => {
  const base = { name: 'Example', program: '/opt/Orivon/orivon', leading: [] as string[] }

  it('writes the five lines the desktop needs, and ends with a newline', () => {
    const text = desktopEntry({ ...base, address: 'https://example.com/' })
    expect(text).toBe([
      '[Desktop Entry]', 'Type=Application', 'Name=Example', 'Exec="/opt/Orivon/orivon" "https://example.com/"', 'Icon=orivon', 'Terminal=false', 'Categories=Network;WebBrowser;', ''
    ].join('\n'))
  })

  it('carries the profile flag before the address, and the app path for a run from source', () => {
    const text = desktopEntry({ ...base, program: '/src/node_modules/electron/dist/electron', leading: ['/src/orivon'], address: 'https://example.com/', profileId: '0123456789ab' })
    expect(readExec(execLineOf(text))).toEqual(['/src/node_modules/electron/dist/electron', '/src/orivon', '--orivon-profile=0123456789ab', 'https://example.com/'])
  })

  it('keeps every hostile address one argument, unchanged, with no field code left to expand', () => {
    for (const url of HOSTILE) {
      const address = new URL(url).toString()
      const text = desktopEntry({ ...base, address })
      const line = execLineOf(text)
      expect(readExec(line), url).toEqual(['/opt/Orivon/orivon', address])
      expect(fieldCodes(line), url).toEqual([])
      expect(text.split('\n').filter((l) => l.length > 0).every((l) => /^(\[Desktop Entry\]|[A-Za-z]+=)/.test(l)), url).toBe(true)
    }
  })

  it('keeps a hostile program path one argument too', () => {
    const program = '/opt/My "App" $HOME/100%/orivon'
    expect(readExec(execLineOf(desktopEntry({ ...base, program, address: 'https://example.com/' })))[0]).toBe(program)
  })

  it('never lets a name add a line or a second Exec', () => {
    const name = cleanName('Nice\nExec=/bin/sh -c evil\r\n[Desktop Action x]', 'x')
    const text = desktopEntry({ ...base, name, address: 'https://example.com/' })
    expect(text.split('\n').filter((l) => l.startsWith('Exec='))).toHaveLength(1)
    expect(text.split('\n').filter((l) => l.startsWith('[')).length).toBe(1)
    expect(text.split('\n').find((l) => l.startsWith('Name='))).toBe('Name=Nice Exec=/bin/sh -c evil [Desktop Action x]')
  })

  it('writes a backslash in a name as the string type requires', () => {
    expect(desktopEntry({ ...base, name: 'a\\nb', address: 'https://example.com/' }).split('\n').find((l) => l.startsWith('Name='))).toBe('Name=a\\\\nb')
  })

  it('refuses an argument that still holds a control character', () => {
    expect(() => desktopEntry({ ...base, address: 'https://example.com/\nx' })).toThrow()
    expect(() => desktopEntry({ ...base, program: '/bin/\nsh', address: 'https://example.com/' })).toThrow()
  })
})

describe('execArgument', () => {
  it('quotes, escapes the four characters a quoted argument reads specially, and doubles %', () => {
    expect(execArgument('a"b`c$d\\e%f')).toBe('"a\\\\"b\\\\`c\\\\$d\\\\\\\\e%%f"')
  })
})

describe('Windows shortcuts', () => {
  it('quotes each argument', () => {
    expect(linkArguments({ leading: ['C:\\app'], address: 'https://example.com/?a=1&b=2', profileId: '0123456789ab' })).toBe('"C:\\app" "--orivon-profile=0123456789ab" "https://example.com/?a=1&b=2"')
  })

  it('refuses an argument it cannot quote', () => {
    expect(() => linkArguments({ leading: [], address: 'https://example.com/"x' })).toThrow()
    expect(() => linkArguments({ leading: [], address: 'https://example.com/\n' })).toThrow()
  })

  it('names the file from the shortcut\'s name, with nothing Windows refuses', () => {
    expect(linkFileName('Docs: a/b\\c?*')).toBe('Docs a b c.lnk')
    expect(linkFileName('...')).toBe('Orivon.lnk')
    expect(linkFileName('Example Domain')).toBe('Example Domain.lnk')
  })
})
