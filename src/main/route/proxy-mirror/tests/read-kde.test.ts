import { describe, expect, it } from 'vitest'
import { parseKdeSettings } from '../read-kde.js'

/** What `kwriteconfig5 --file kioslaverc` (KConfig, the writer the proxy settings window uses) left after a manual proxy was set: keys sorted, a space before the port. */
const WRITTEN_BY_KDE = `[Proxy Settings]
AuthMode=0
NoProxyFor=localhost,127.0.0.0/8,.corp.test,10.0.0.0/8
Proxy Config Script=
ProxyType=1
ReversedException=false
ftpProxy=
httpProxy=http://127.0.0.1 3128
httpsProxy=http://127.0.0.1 3128
socksProxy=socks://127.0.0.1 1080
`

/** A Plasma 6 settings window's file with a proxy that skips a block of addresses and two domains. */
const PLASMA_6 = `ProxyUrlDisplayFlags=0

[Proxy Settings]
NoProxyFor=0.0.0.0/0,.mydomain.local,.mysite.es
Proxy Config Script=
ProxyType=1
ReversedException=false
ftpProxy=
httpProxy=http://10.160.0.12 3120
httpsProxy=http://10.160.0.12 3120
socksProxy=
`

const section = (...lines: string[]): string => `[Proxy Settings]\n${lines.join('\n')}\n`
const manual = (...lines: string[]): string => section('ProxyType=1', ...lines)
/** The exceptions a manual proxy at 127.0.0.1:3128 makes of `NoProxyFor=<list>`. */
const exceptionsOf = (list: string): readonly string[] => {
  const settings = parseKdeSettings([manual('httpProxy=127.0.0.1:3128', `NoProxyFor=${list}`)])
  return settings.kind === 'manual' ? settings.exceptions : []
}

describe('KDE\'s proxy settings', () => {
  it('are a manual proxy for the schemes that name a server, a SOCKS server as SOCKS5 for the rest, and each exception as a suffix match', () => {
    expect(parseKdeSettings([WRITTEN_BY_KDE])).toEqual({
      kind: 'manual',
      proxyRules: 'http=127.0.0.1:3128;https=127.0.0.1:3128;socks=socks5://127.0.0.1:1080',
      exceptions: ['*localhost', '127.0.0.0/8', '*.corp.test', '10.0.0.0/8']
    })
  })

  it('read what a Plasma 6 settings window writes: a server as a URL and a space before the port, a block of addresses kept as it is', () => {
    expect(parseKdeSettings([PLASMA_6])).toEqual({
      kind: 'manual',
      proxyRules: 'http=10.160.0.12:3120;https=10.160.0.12:3120',
      exceptions: ['0.0.0.0/0', '*.mydomain.local', '*.mysite.es']
    })
  })

  it('read a server however it is written, and drop the scheme, the credentials and a slash after it', () => {
    const rules = (...servers: string[]): unknown => (parseKdeSettings([manual(`httpProxy=${servers[0] ?? ''}`, `httpsProxy=${servers[1] ?? ''}`)]) as { proxyRules?: string }).proxyRules
    expect(rules('127.0.0.1:3128', '127.0.0.1 3129')).toBe('http=127.0.0.1:3128;https=127.0.0.1:3129')
    expect(rules('http://127.0.0.1:3128/', 'https://127.0.0.1 3129')).toBe('http=127.0.0.1:3128;https=127.0.0.1:3129')
    expect(rules('http://user:secret@127.0.0.1:3128/', 'user@127.0.0.1:3129')).toBe('http=127.0.0.1:3128;https=127.0.0.1:3129')
    expect(rules('proxy.corp.test', 'proxy.corp.test 8443')).toBe('http=proxy.corp.test;https=proxy.corp.test:8443')
    expect(rules('[::1] 3128', '[2001:db8::1]:3129')).toBe('http=[::1]:3128;https=[2001:db8::1]:3129')
  })

  it('never carry the credentials of a server', () => {
    expect(JSON.stringify(parseKdeSettings([manual('httpProxy=http://user:hunter2@127.0.0.1:3128/')]))).not.toContain('hunter2')
  })

  it('carry a SOCKS server as SOCKS5 unless it names socks4, and use it for every scheme with no server of its own', () => {
    expect(parseKdeSettings([manual('socksProxy=socks://127.0.0.1 1080')])).toMatchObject({ proxyRules: 'socks=socks5://127.0.0.1:1080' })
    expect(parseKdeSettings([manual('socksProxy=127.0.0.1:1080')])).toMatchObject({ proxyRules: 'socks=socks5://127.0.0.1:1080' })
    expect(parseKdeSettings([manual('socksProxy=socks4://127.0.0.1 1080')])).toMatchObject({ proxyRules: 'socks=socks4://127.0.0.1:1080' })
    expect(parseKdeSettings([manual('httpsProxy=127.0.0.1:3129', 'socksProxy=127.0.0.1:1080')])).toMatchObject({ proxyRules: 'https=127.0.0.1:3129;socks=socks5://127.0.0.1:1080' })
  })

  it('leave an FTP server out, and are no proxy when no other server is named', () => {
    expect(parseKdeSettings([manual('httpProxy=127.0.0.1:3128', 'ftpProxy=127.0.0.1:2121')])).toMatchObject({ proxyRules: 'http=127.0.0.1:3128' })
    expect(parseKdeSettings([manual('ftpProxy=127.0.0.1:2121')])).toEqual({ kind: 'none' })
    expect(parseKdeSettings([manual('httpProxy=//:', 'httpsProxy=')])).toEqual({ kind: 'none' })
  })
})

describe('the exceptions of KDE\'s proxy settings', () => {
  it('put a * before every hostname, as Chromium turns them into suffix matches, and leave a rule for an address alone', () => {
    expect(exceptionsOf('corp.test')).toEqual(['*corp.test'])
    expect(exceptionsOf('.corp.test,*.lan.test,CORP.TEST')).toEqual(['*.corp.test', '*.lan.test', '*CORP.TEST'])
    expect(exceptionsOf('10.1.2.3,192.168.1.5:443,10.0.0.0/8,2001:db8::/32,[::1],[2001:db8::1]:8443,<local>')).toEqual(['10.1.2.3', '192.168.1.5:443', '10.0.0.0/8', '2001:db8::/32', '[::1]', '[2001:db8::1]:8443', '<local>'])
  })

  it('keep a scheme and a port in front of and after the pattern', () => {
    expect(exceptionsOf('example.com:8080,http://svc.test,https://example.com:443')).toEqual(['*example.com:8080', 'http://*svc.test', 'https://*example.com:443'])
  })

  it('treat a bare IPv6 address as Chromium does, as a hostname with a port', () => {
    expect(exceptionsOf('::1,2001:db8::1')).toEqual(['*::1', '*2001:db8::1'])
  })

  it('split the list at commas and spaces, whichever is used', () => {
    expect(exceptionsOf('a.test b.test,c.test,, d.test')).toEqual(['*a.test', '*b.test', '*c.test', '*d.test'])
    expect(exceptionsOf('')).toEqual([])
  })

  it('are unsupported when an entry could not be written into a list of rules', () => {
    expect(parseKdeSettings([manual('httpProxy=127.0.0.1:3128', 'NoProxyFor=a.test;b.test')])).toEqual({ kind: 'unsupported' })
    expect(parseKdeSettings([manual('httpProxy=127.0.0.1:3128', 'NoProxyFor=a.test\tb.test')])).toEqual({ kind: 'unsupported' })
  })

  it('are unsupported when they are reversed, whichever way the value says so', () => {
    for (const value of ['true', '1', '2']) expect(parseKdeSettings([manual('httpProxy=127.0.0.1:3128', 'NoProxyFor=.corp.test', `ReversedException=${value}`)])).toEqual({ kind: 'unsupported' })
    for (const value of ['false', '0', 'True', 'yes', '']) expect(parseKdeSettings([manual('httpProxy=127.0.0.1:3128', 'NoProxyFor=.corp.test', `ReversedException=${value}`)])).toMatchObject({ kind: 'manual' })
  })
})

describe('the kind of KDE\'s proxy settings', () => {
  it('is no proxy for type 0, a type nobody defined, a type that is no number, a missing type and a missing section', () => {
    for (const type of ['0', '5', '-1', 'one', '', '99999999999']) expect(parseKdeSettings([section(`ProxyType=${type}`, 'httpProxy=127.0.0.1:3128')]), `ProxyType=${type}`).toEqual({ kind: 'none' })
    expect(parseKdeSettings([section('httpProxy=127.0.0.1:3128')])).toEqual({ kind: 'none' })
    expect(parseKdeSettings(['ProxyType=1\nhttpProxy=127.0.0.1:3128\n'])).toEqual({ kind: 'none' })
    expect(parseKdeSettings([])).toEqual({ kind: 'none' })
  })

  it('is a script for type 2 with an address, and detection for type 2 with none and for type 3', () => {
    expect(parseKdeSettings([section('ProxyType=2', 'Proxy Config Script=file:///home/me/proxy.pac')])).toEqual({ kind: 'script', url: 'file:///home/me/proxy.pac' })
    expect(parseKdeSettings([section('ProxyType=2', 'Proxy Config Script=/home/me/proxy.pac')])).toEqual({ kind: 'script', url: 'file:///home/me/proxy.pac' })
    expect(parseKdeSettings([section('ProxyType=2', 'Proxy Config Script=http://127.0.0.1:8123/proxy.pac')])).toEqual({ kind: 'script', url: 'http://127.0.0.1:8123/proxy.pac' })
    expect(parseKdeSettings(['[Proxy Settings]\nProxyType=2\nProxy Config Script=http://one.test/a.pac\n', '[Proxy Settings]\nProxy Config Script=http://two.test/b.pac\n'])).toEqual({ kind: 'script', url: 'http://two.test/b.pac' })
    expect(parseKdeSettings([section('ProxyType=2', 'Proxy Config Script=')])).toEqual({ kind: 'detect' })
    expect(parseKdeSettings([section('ProxyType=3', 'Proxy Config Script=http://127.0.0.1/proxy.pac')])).toEqual({ kind: 'detect' })
  })

  it('is unsupported for type 4, whose servers are the names of environment variables', () => {
    expect(parseKdeSettings([section('ProxyType=4', 'httpProxy=http_proxy', 'httpsProxy=https_proxy', 'NoProxyFor=NO_PROXY')])).toEqual({ kind: 'unsupported' })
  })

  it('is unsupported when a server could not be written into a rule', () => {
    for (const server of ['127.0.0.1:0', '127.0.0.1:70000', '127.0.0.1:', 'a.test;b.test:3128', 'ünï.test:3128', '::1:3128', '[not-an-address]:3128', 'a b c']) {
      expect(parseKdeSettings([manual(`httpProxy=${server}`, 'httpsProxy=127.0.0.1:3129')]), server).toEqual({ kind: 'unsupported' })
    }
  })
})

describe('reading kioslaverc as Chromium does', () => {
  const PROXY = ['httpProxy=127.0.0.1:3128', 'httpsProxy=127.0.0.1:3129']

  it('merges the files key by key, the later one winning, and an empty server does not clear an earlier one', () => {
    const earlier = section('ProxyType=1', 'httpProxy=127.0.0.1:1111', 'httpsProxy=127.0.0.1:3129', 'NoProxyFor=.old.test')
    const later = section('httpProxy=127.0.0.1:3128', 'httpsProxy=', 'NoProxyFor=.new.test')
    expect(parseKdeSettings([earlier, later])).toEqual({ kind: 'manual', proxyRules: 'http=127.0.0.1:3128;https=127.0.0.1:3129', exceptions: ['*.new.test'] })
    expect(parseKdeSettings([section('ProxyType=1', 'httpProxy=127.0.0.1:3128'), section('ProxyType=0')])).toEqual({ kind: 'none' })
  })

  it('takes the last of a key set twice in a file', () => {
    expect(parseKdeSettings([manual('httpProxy=127.0.0.1:1111', 'httpProxy=127.0.0.1:3128')])).toMatchObject({ proxyRules: 'http=127.0.0.1:3128' })
  })

  it('reads only the Proxy Settings section, wherever it is in the file', () => {
    const text = `[Other]\nProxyType=0\nhttpProxy=127.0.0.1:1\n[Proxy Settings]\nProxyType=1\n${PROXY.join('\n')}\n[More]\nhttpProxy=127.0.0.1:2\n`
    expect(parseKdeSettings([text])).toMatchObject({ proxyRules: 'http=127.0.0.1:3128;https=127.0.0.1:3129' })
  })

  it('ignores spaces around keys and values, a CRLF line ending, and the mark of an expanded or localised key', () => {
    expect(parseKdeSettings([`[Proxy Settings]\r\n  ProxyType = 1  \r\n httpProxy = http://127.0.0.1 3128 \r\nhttpsProxy\t=\t127.0.0.1:3129\r\n`])).toMatchObject({ proxyRules: 'http=127.0.0.1:3128;https=127.0.0.1:3129' })
    expect(parseKdeSettings([manual('httpProxy[$e]=127.0.0.1:3128', 'httpsProxy [de]=127.0.0.1:3129')])).toMatchObject({ proxyRules: 'http=127.0.0.1:3128;https=127.0.0.1:3129' })
    expect(parseKdeSettings([manual('http]Proxy=127.0.0.1:1111', ...PROXY)])).toMatchObject({ proxyRules: 'http=127.0.0.1:3128;https=127.0.0.1:3129' })
  })

  it('skips a line of 511 bytes or more and the last line when it has no newline, which Chromium never finishes reading', () => {
    const exceptions = (text: string): unknown => (parseKdeSettings([text]) as { exceptions?: string[] }).exceptions
    const edge = (length: number): string => manual(...PROXY, `NoProxyFor=${'x'.repeat(length - 'NoProxyFor='.length - '.test'.length)}.test`)
    expect(exceptions(edge(510))).toHaveLength(1)
    expect(exceptions(edge(511))).toEqual([])
    expect(exceptions(manual(...PROXY, `NoProxyFor=${'é'.repeat(256)}`))).toEqual([])
    expect(parseKdeSettings([`[Proxy Settings]\nProxyType=1\nhttpProxy=127.0.0.1:3128\nhttpsProxy=127.0.0.1:3129`])).toMatchObject({ proxyRules: 'http=127.0.0.1:3128' })
  })
})
