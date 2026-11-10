import { describe, expect, it } from 'vitest'
import { parseGnomeSettings } from '../read-gnome.js'
import { gsettingsOutput } from './gsettings-output.test-helpers.js'

/** Printed on a computer whose settings window had a manual proxy for HTTP and HTTPS. */
const MANUAL = `org.gnome.system.proxy autoconfig-url ''
org.gnome.system.proxy ignore-hosts ['localhost', '127.0.0.0/8', '::1']
org.gnome.system.proxy mode 'manual'
org.gnome.system.proxy use-same-proxy true
org.gnome.system.proxy.ftp host ''
org.gnome.system.proxy.ftp port 0
org.gnome.system.proxy.http authentication-password ''
org.gnome.system.proxy.http authentication-user ''
org.gnome.system.proxy.http enabled false
org.gnome.system.proxy.http host '127.0.0.1'
org.gnome.system.proxy.http port 3128
org.gnome.system.proxy.http use-authentication false
org.gnome.system.proxy.https host '127.0.0.1'
org.gnome.system.proxy.https port 3128
org.gnome.system.proxy.socks host ''
org.gnome.system.proxy.socks port 0
`

describe('GNOME\'s proxy settings', () => {
  it('are a manual proxy for the schemes that name a host, with the exceptions as listed', () => {
    expect(parseGnomeSettings(MANUAL)).toEqual({ kind: 'manual', proxyRules: 'http=127.0.0.1:3128;https=127.0.0.1:3128', exceptions: ['localhost', '127.0.0.0/8', '::1'] })
  })

  it('read use-same-proxy and the HTTP server\'s enabled switch as Chromium does: not at all', () => {
    const only = parseGnomeSettings(gsettingsOutput({ mode: 'manual', same: true, http: { host: 'proxy.test', port: 3128 } }))
    expect(only).toMatchObject({ kind: 'manual', proxyRules: 'http=proxy.test:3128' })
    const other = parseGnomeSettings(gsettingsOutput({ mode: 'manual', same: false, http: { host: 'proxy.test', port: 3128 } }))
    expect(other).toEqual(only)
  })

  it('carry a SOCKS server as a SOCKS5 one, and as the rule for every scheme with no server of its own', () => {
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', socks: { host: '127.0.0.1', port: 1080 } }))).toMatchObject({ proxyRules: 'socks=socks5://127.0.0.1:1080' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'a.test', port: 3128 }, https: { host: 'b.test', port: 3129 }, socks: { host: 'c.test', port: 1080 } }))).toMatchObject({ proxyRules: 'http=a.test:3128;https=b.test:3129;socks=socks5://c.test:1080' })
  })

  it('leave the port to the scheme\'s default when it is 0, and bracket an IPv6 host', () => {
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', https: { host: 'proxy.test', port: 0 } }))).toMatchObject({ proxyRules: 'https=proxy.test' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: '2001:db8::1', port: 3128 } }))).toMatchObject({ proxyRules: 'http=[2001:db8::1]:3128' })
  })

  it('are no proxy when the mode is none, or manual with no server named', () => {
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'none', http: { host: 'proxy.test', port: 3128 } }))).toEqual({ kind: 'none' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual' }))).toEqual({ kind: 'none' })
  })

  it('are a script when the mode is auto and names an address, and detection when it names none', () => {
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'auto', url: 'http://127.0.0.1:8123/proxy.pac' }))).toEqual({ kind: 'script', url: 'http://127.0.0.1:8123/proxy.pac' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'auto' }))).toEqual({ kind: 'detect' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'auto', url: '  ' }))).toEqual({ kind: 'detect' })
  })

  it('carry the script\'s address as Chromium takes it: a path is a file address, anything else as written, trimmed', () => {
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'auto', url: '/home/me/proxy.pac' }))).toEqual({ kind: 'script', url: 'file:///home/me/proxy.pac' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'auto', url: ' https://pac.test/p.pac?v=2#x ' }))).toEqual({ kind: 'script', url: 'https://pac.test/p.pac?v=2#x' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'auto', url: 'wpad.dat' }))).toEqual({ kind: 'script', url: 'wpad.dat' })
  })

  it('read the exceptions however the list is typed', () => {
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 1 }, ignore: '@as []' }))).toMatchObject({ exceptions: [] })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 1 }, ignore: '[]' }))).toMatchObject({ exceptions: [] })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 1 }, ignore: "['*.corp.test', '.lan', '10.0.0.0/8', '2001:db8::/32', '::1', '[::1]', 'a.test:8080']" }))).toMatchObject({
      exceptions: ['*.corp.test', '.lan', '10.0.0.0/8', '2001:db8::/32', '::1', '[::1]', 'a.test:8080']
    })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 1 }, ignore: "['', 'x.test']" }))).toMatchObject({ exceptions: ['x.test'] })
  })

  it('hand every exception on as the system wrote it, an IPv6 address bare or in brackets, as Chromium\'s reader hands it to the bypass-rule parser', () => {
    const exceptions = (ignore: string): unknown => (parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 1 }, ignore })) as { exceptions?: string[] }).exceptions
    expect(exceptions("['::1', 'fe80::1', '2001:db8::/32']")).toEqual(['::1', 'fe80::1', '2001:db8::/32'])
    expect(exceptions("['[::1]', '[fe80::1]:8080']")).toEqual(['[::1]', '[fe80::1]:8080'])
  })

  it('never carry a password, whatever the output holds', () => {
    const settings = parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'proxy.test', port: 3128 }, password: 'hunter2-secret' }))
    expect(JSON.stringify(settings)).not.toContain('hunter2')
  })

  it('are unsupported when a host or an exception could not be written into a rule', () => {
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'a.test;https=evil.test', port: 3128 } }))).toEqual({ kind: 'unsupported' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'ünï.test', port: 3128 } }))).toEqual({ kind: 'unsupported' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 3128 }, ignore: "['a.test;b.test']" }))).toEqual({ kind: 'unsupported' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 3128 }, ignore: "['two words']" }))).toEqual({ kind: 'unsupported' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 3128 }, ignore: 'not a list' }))).toEqual({ kind: 'unsupported' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 70_000 } }))).toEqual({ kind: 'unsupported' })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'something-new' }))).toEqual({ kind: 'unsupported' })
  })

  it('are unreadable when the output holds no mode', () => {
    expect(parseGnomeSettings('')).toEqual({ kind: 'unreadable' })
    expect(parseGnomeSettings("No such schema 'org.gnome.system.proxy'\n")).toEqual({ kind: 'unreadable' })
    expect(parseGnomeSettings('org.gnome.system.proxy ignore-hosts []\n')).toEqual({ kind: 'unreadable' })
  })

  it('read a string with an escaped quote, and one in quotes of the other kind', () => {
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 1 }, ignore: "['it\\'s.test']" }))).toMatchObject({ exceptions: ["it's.test"] })
    expect(parseGnomeSettings(gsettingsOutput({ mode: 'manual', http: { host: 'p.test', port: 1 }, ignore: `["a.test", 'b.test']` }))).toMatchObject({ exceptions: ['a.test', 'b.test'] })
  })
})
