import { describe, expect, it } from 'vitest'
import { mirroredConfig, routedBypassRules } from '../mirrored-config.js'
import { parseMacosSettings } from '../read-macos.js'
import * as printed from './scutil-output.test-helpers.js'

const DEFAULT_EXCEPTIONS = ['*.local', '169.254/16']

describe('macOS\'s proxy settings', () => {
  it('are no proxy when none is set, however the switches are printed', () => {
    expect(parseMacosSettings(printed.NO_PROXY)).toEqual({ kind: 'none' })
    expect(parseMacosSettings(printed.ALL_OFF)).toEqual({ kind: 'none' })
    expect(parseMacosSettings(printed.TURNED_OFF)).toEqual({ kind: 'none' })
  })

  it('are a manual proxy for the schemes that are on and name a host, with the exceptions as listed', () => {
    expect(parseMacosSettings(printed.HTTP_AND_HTTPS)).toEqual({ kind: 'manual', proxyRules: 'http=127.0.0.1:18082;https=127.0.0.1:18082', exceptions: DEFAULT_EXCEPTIONS })
    expect(parseMacosSettings(printed.HTTP_ONLY)).toEqual({ kind: 'manual', proxyRules: 'http=127.0.0.1:18080', exceptions: DEFAULT_EXCEPTIONS })
  })

  it('give each scheme its own server', () => {
    expect(parseMacosSettings(printed.HTTP_HTTPS_SOCKS)).toMatchObject({ proxyRules: 'http=127.0.0.1:18080;https=127.0.0.2:18443;socks=socks5://127.0.0.1:11080' })
  })

  it('carry a SOCKS server as SOCKS5, the version macOS answers with, and as the rule for every scheme with no server of its own', () => {
    expect(parseMacosSettings(printed.SOCKS_ONLY)).toEqual({ kind: 'manual', proxyRules: 'socks=socks5://127.0.0.1:11080', exceptions: DEFAULT_EXCEPTIONS })
  })

  it('read a switch the way Chromium does: a server that is off is not read, whatever is stored for it', () => {
    expect(parseMacosSettings(printed.STORE_WITH_INTERFACES)).toEqual({ kind: 'none' })
    expect(parseMacosSettings(printed.HTTP_AND_HTTPS.replace('HTTPEnable : 1', 'HTTPEnable : 0'))).toMatchObject({ proxyRules: 'https=127.0.0.1:18082' })
    expect(parseMacosSettings(printed.HTTP_AND_HTTPS.replace('HTTPEnable : 1', 'HTTPEnable : 2'))).toMatchObject({ proxyRules: 'http=127.0.0.1:18082;https=127.0.0.1:18082' })
  })

  it('read only the top level: the copy of each interface below it is not the system\'s answer', () => {
    const interfaceOn = printed.STORE_WITH_INTERFACES.replace(/(\n {6}HTTPEnable : )0/, '$11')
    expect(interfaceOn).not.toBe(printed.STORE_WITH_INTERFACES)
    expect(parseMacosSettings(interfaceOn)).toEqual({ kind: 'none' })
    const topOn = printed.STORE_WITH_INTERFACES.replace(/(\n {2}HTTPEnable : )0/, '$11')
    expect(parseMacosSettings(topOn)).toMatchObject({ kind: 'manual', proxyRules: 'http=127.0.0.1:18080' })
  })

  it('name a server by host name or by IPv6 address, bracketed as a rule spells it', () => {
    expect(parseMacosSettings(printed.NAMED_SERVER)).toMatchObject({ proxyRules: 'http=proxy.example.test:3128' })
    expect(parseMacosSettings(printed.IPV6_SERVER)).toMatchObject({ proxyRules: 'http=[2001:db8::1]:3128' })
  })

  it('leave a port that is not printed to the scheme\'s default, as Chromium does', () => {
    expect(parseMacosSettings(printed.HTTP_ONLY.replace('  HTTPPort : 18080\n', ''))).toMatchObject({ proxyRules: 'http=127.0.0.1' })
    expect(parseMacosSettings(printed.SOCKS_ONLY.replace('  SOCKSPort : 11080\n', ''))).toMatchObject({ proxyRules: 'socks=socks5://127.0.0.1' })
  })

  it('skip a server that is on and names no host, as Chromium does', () => {
    expect(parseMacosSettings(printed.HTTP_ONLY.replace('  HTTPProxy : 127.0.0.1\n', ''))).toEqual({ kind: 'none' })
    expect(parseMacosSettings(printed.HTTP_ONLY.replace('HTTPProxy : 127.0.0.1', 'HTTPProxy :'))).toEqual({ kind: 'none' })
  })

  it('are a script when one is on and names an address, even beside a manual proxy, because Chromium asks the script first', () => {
    expect(parseMacosSettings(printed.SCRIPT_ONLY)).toEqual({ kind: 'script', url: 'http://127.0.0.1:49219/p.pac' })
    expect(parseMacosSettings(printed.SCRIPT_AND_MANUAL)).toEqual({ kind: 'script', url: 'http://127.0.0.1:49219/p.pac' })
    expect(parseMacosSettings(printed.SCRIPT_OFF_MANUAL)).toMatchObject({ kind: 'manual', proxyRules: 'http=127.0.0.1:18080' })
    expect(parseMacosSettings(printed.SCRIPT_ONLY.replace(/ProxyAutoConfigURLString : .*/, 'ProxyAutoConfigURLString :'))).toEqual({ kind: 'none' })
  })

  it('are detection when discovery is on, and not a script at the address macOS gives discovery', () => {
    expect(parseMacosSettings(printed.DISCOVERY_ONLY)).toEqual({ kind: 'detect' })
    expect(parseMacosSettings(printed.DISCOVERY_ONLY.replace('http://wpad/wpad.dat', 'http://pac.example.test/proxy.pac'))).toEqual({ kind: 'script', url: 'http://pac.example.test/proxy.pac' })
    expect(parseMacosSettings(printed.DISCOVERY_ONLY.replace('ProxyAutoDiscoveryEnable : 1', 'ProxyAutoDiscoveryEnable : 0'))).toEqual({ kind: 'script', url: 'http://wpad/wpad.dat' })
  })

  it('copy the manual part when discovery is on beside it, which the check against Chromium\'s own answer then judges', () => {
    expect(parseMacosSettings(printed.DISCOVERY_AND_MANUAL)).toEqual({ kind: 'manual', proxyRules: 'http=127.0.0.1:18080;https=127.0.0.1:18080', exceptions: DEFAULT_EXCEPTIONS })
  })

  it('put <local> first, and only when the settings leave out simple host names', () => {
    expect(parseMacosSettings(printed.SIMPLE_HOSTNAMES_EXCLUDED)).toMatchObject({ exceptions: ['<local>', ...DEFAULT_EXCEPTIONS] })
    expect(parseMacosSettings(printed.HTTP_AND_HTTPS)).not.toMatchObject({ exceptions: expect.arrayContaining(['<local>']) })
    expect(parseMacosSettings(printed.SIMPLE_HOSTNAMES_EXCLUDED.replace('ExcludeSimpleHostnames : 1', 'ExcludeSimpleHostnames : 0'))).toMatchObject({ exceptions: DEFAULT_EXCEPTIONS })
  })

  it('keep the exceptions as they stand, in order, and none when the list is empty', () => {
    expect(parseMacosSettings(printed.ODD_EXCEPTIONS)).toMatchObject({
      exceptions: ['*.corp.test', '.dot.test', 'bare.test', '10.0.0.0/8', 'a.test:8080', '::1', 'fe80::/10', 'http://scheme.test', '<local>', 'two words', 'semi;colon', 'comma,sep', '*.UPPER.test', 'padded.test']
    })
    expect(parseMacosSettings(printed.MANUAL_NO_EXCEPTIONS)).toMatchObject({ kind: 'manual', exceptions: [] })
  })

  it('keep an exception that holds a separator whole, because Chromium cuts the system\'s own list at the same places', () => {
    expect(parseMacosSettings(printed.SEPARATORS)).toMatchObject({ exceptions: ['foo.test bar.test', 'semi.test;colon.test', 'comma.test,sep.test', 'ok.test'] })
  })

  it('never carry anything but the servers and exceptions, whatever else the dictionary holds', () => {
    const withSecrets = printed.HTTP_AND_HTTPS.replace('  HTTPEnable : 1', '  HTTPUser : someone\n  HTTPPassword : hunter2-secret\n  HTTPEnable : 1')
    expect(JSON.stringify(parseMacosSettings(withSecrets))).not.toMatch(/hunter2|someone/)
  })

  it('are unsupported when a server could not be written into a rule or an exception took more than one line', () => {
    expect(parseMacosSettings(printed.HTTP_ONLY.replace('127.0.0.1', 'a.test;https=evil.test'))).toEqual({ kind: 'unsupported' })
    expect(parseMacosSettings(printed.HTTP_ONLY.replace('127.0.0.1', 'prøxy.test'))).toEqual({ kind: 'unsupported' })
    expect(parseMacosSettings(printed.HTTP_ONLY.replace('HTTPPort : 18080', 'HTTPPort : 0'))).toEqual({ kind: 'unsupported' })
    expect(parseMacosSettings(printed.HTTP_ONLY.replace('HTTPPort : 18080', 'HTTPPort : 70000'))).toEqual({ kind: 'unsupported' })
    expect(parseMacosSettings(printed.HTTP_ONLY.replace('    1 : 169.254/16', '    1 : 169.254/16\nsecond line'))).toEqual({ kind: 'unsupported' })
  })

  it('are unreadable when the output is no dictionary or does not close', () => {
    expect(parseMacosSettings('')).toEqual({ kind: 'unreadable' })
    expect(parseMacosSettings('No proxy configuration\n')).toEqual({ kind: 'unreadable' })
    expect(parseMacosSettings('<dictionary> {\n}\n')).toEqual({ kind: 'unreadable' })
    expect(parseMacosSettings(printed.HTTP_AND_HTTPS.replace(/\}\n$/, ''))).toEqual({ kind: 'unreadable' })
    expect(parseMacosSettings(printed.HTTP_AND_HTTPS.slice(0, 120))).toEqual({ kind: 'unreadable' })
  })
})

describe('the config a session is set to for macOS\'s settings', () => {
  it('is the servers, the exceptions with <local> first, then the rules for the names the verifier serves', () => {
    expect(mirroredConfig(parseMacosSettings(printed.SIMPLE_HOSTNAMES_EXCLUDED))).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=127.0.0.1:18080;https=127.0.0.1:18080',
      proxyBypassRules: ['<local>', ...DEFAULT_EXCEPTIONS, ...routedBypassRules()].join(';')
    })
  })

  it('is nothing for a script, discovery alone, or settings that could not be carried', () => {
    for (const output of [printed.SCRIPT_ONLY, printed.DISCOVERY_ONLY, printed.NO_PROXY, printed.HTTP_ONLY.replace('HTTPPort : 18080', 'HTTPPort : 0')]) {
      expect(mirroredConfig(parseMacosSettings(output))).toBeUndefined()
    }
  })
})
