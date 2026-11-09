import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BUILTIN_ADDRESSES } from '../../../../protocols/builtin.js'
import { pacDataUrl, wrapPacScript } from '../pac-wrapper.js'
import type { PacRun } from './pac-vm.test-helpers.js'
import { runPac } from './pac-vm.test-helpers.js'

const PROXY = 'PROXY proxy.test:3128'
const SUFFIXES = ['eth', 'orivon']

/** A script that sends every host to the proxy. */
const SENDS_ALL = `function FindProxyForURL(url, host) { return "${PROXY}" }`

/** Runs the wrapper in a context of its own, as the PAC context would. */
function load (script: string, suffixes: readonly string[] = SUFFIXES): PacRun {
  return runPac(wrapPacScript(script, suffixes))
}

/** The ways a script can name its function; each is sent a request for `ordinary.test` and for the names Orivon serves. */
const NAMINGS: ReadonlyArray<readonly [string, string]> = [
  ['a declaration', SENDS_ALL],
  ['a var', `var FindProxyForURL = function () { return "${PROXY}" }`],
  ['an assignment', `FindProxyForURL = function () { return "${PROXY}" }`],
  ['an assignment to this', `this.FindProxyForURL = function () { return "${PROXY}" }`],
  ['an assignment to globalThis', `globalThis.FindProxyForURL = function () { return "${PROXY}" }`],
  ['an assignment in strict mode', `"use strict"; FindProxyForURL = function () { return "${PROXY}" }`],
  ['a declaration in strict mode', `"use strict"; ${SENDS_ALL}`],
  ['a setter call', `Object.getOwnPropertyDescriptor(this, "FindProxyForURL").set(function () { return "${PROXY}" })`],
  ['an assignment through eval', `(0, eval)("FindProxyForURL = function () { return '${PROXY}' }")`],
  ['an assignment through a new Function', `new Function("FindProxyForURL = function () { return '${PROXY}' }")()`],
  ['an assignment in a with block', `with ({}) { FindProxyForURL = function () { return "${PROXY}" } }`],
  ['a wrap of the function it finds', `var previous = FindProxyForURL; FindProxyForURL = function (url, host) { return previous === undefined ? "${PROXY}" : previous(url, host) }`]
]

const ROUTED_HOSTS = [
  'vitalik.eth', 'a.b.eth', 'vitalik.eth.', 'vitalik.eth..', 'vitalik.eth...', 'VITALIK.ETH', 'Vitalik.Eth.',
  'x.orivon', 'ipfs.orivon', 'label.ipfs.orivon', 'label.ipfs.orivon.', 'sub.x.orivon..'
]
const ORDINARY_HOSTS = ['ordinary.test', 'eth', 'orivon', 'x.ethical', 'xeth', 'x.eth.test', 'x.eth.evil.test.', 'x.orivon.com', 'ethx.test', 'a.b.c.d.example']

describe('the wrapped script', () => {
  describe('answers DIRECT for a name Orivon serves, whatever the script says', () => {
    it.each(ROUTED_HOSTS)('%s', (host) => {
      const { answer } = load(SENDS_ALL)
      expect(answer(`https://${host}/`, host)).toBe('DIRECT')
      expect(answer(`http://${host}/path?query`, host)).toBe('DIRECT')
    })

    it('with or without the root dot, for every suffix Orivon serves', () => {
      const { answer } = load(SENDS_ALL, BUILTIN_ADDRESSES.routedSuffixes())
      for (const suffix of BUILTIN_ADDRESSES.routedSuffixes()) {
        for (const dots of ['', '.', '..']) expect(answer(`https://name.${suffix}${dots}/`)).toBe('DIRECT')
      }
    })

    it('for a host the wrapper is told is not a string', () => {
      const { answer } = load(SENDS_ALL)
      expect(answer('https://vitalik.eth/', undefined as unknown as string)).toBe('DIRECT')
      expect(answer('https://vitalik.eth/', { toString: () => 'ordinary.test' } as unknown as string)).toBe('DIRECT')
    })
  })

  describe('hands every other host to the system\'s script', () => {
    it.each(ORDINARY_HOSTS)('%s', (host) => {
      expect(load(SENDS_ALL).answer(`https://${host}/`, host)).toBe(PROXY)
    })

    it('with the url and the host as it was asked', () => {
      const { answer } = load('function FindProxyForURL(url, host) { return url + " " + host }')
      expect(answer('http://ordinary.test/a?b=c', 'ordinary.test')).toBe('http://ordinary.test/a?b=c ordinary.test')
    })

    it('with the helpers of the PAC context in reach', () => {
      const { answer } = load('function FindProxyForURL(url, host) { return isPlainHostName(host) ? "DIRECT" : dnsDomainIs(host, ".corp.test") ? "PROXY corp.test:1" : "PROXY other.test:2" }')
      expect(answer('http://intranet/')).toBe('DIRECT')
      expect(answer('http://a.corp.test/')).toBe('PROXY corp.test:1')
      expect(answer('http://a.other.test/')).toBe('PROXY other.test:2')
    })

    it('keeping the system\'s split between two proxies', () => {
      const { answer } = load('function FindProxyForURL(url, host) { return /\\.two\\.test$/.test(host) ? "PROXY two.test:2" : "PROXY one.test:1" }')
      expect(answer('http://a.two.test/')).toBe('PROXY two.test:2')
      expect(answer('http://a.test/')).toBe('PROXY one.test:1')
      expect(answer('https://vitalik.eth/')).toBe('DIRECT')
    })
  })

  describe.each(NAMINGS)('a script that names its function with %s', (_name, script) => {
    it('is answered for an ordinary name and never for a name Orivon serves', () => {
      const { answer } = load(script)
      expect(answer('https://ordinary.test/')).toBe(PROXY)
      for (const host of ROUTED_HOSTS) expect(answer(`https://${host}/`, host)).toBe('DIRECT')
    })
  })

  describe('a script that names its function twice', () => {
    it('is taken as the function it assigned last, as Chromium takes a script that does so in the global scope', () => {
      const { answer } = load(`this.FindProxyForURL = function () { return "PROXY assigned.test:1" }; function FindProxyForURL() { return "PROXY declared.test:2" }`)
      expect(answer('https://ordinary.test/')).toBe('PROXY assigned.test:1')
    })

    it('is taken as the function it declared when it assigned nothing', () => {
      expect(load('function FindProxyForURL() { return "PROXY declared.test:2" }').answer('https://ordinary.test/')).toBe('PROXY declared.test:2')
    })
  })

  describe('a script that tries to take the function Chromium reads', () => {
    const TAKES = [
      ['Object.defineProperty with a value', `Object.defineProperty(this, "FindProxyForURL", { value: function () { return "${PROXY}" } })`],
      ['Object.defineProperty with a getter', `Object.defineProperty(this, "FindProxyForURL", { get: function () { return function () { return "${PROXY}" } } })`],
      ['Object.defineProperties', `Object.defineProperties(this, { FindProxyForURL: { value: function () { return "${PROXY}" } } })`],
      ['Reflect.defineProperty', `Reflect.defineProperty(this, "FindProxyForURL", { value: function () { return "${PROXY}" } }); ${SENDS_ALL.replace(PROXY, 'DIRECT')}`],
      ['delete', `delete this.FindProxyForURL; delete globalThis.FindProxyForURL; ${SENDS_ALL.replace(PROXY, 'DIRECT')}`],
      ['a replaced prototype of the global', `try { Object.setPrototypeOf(this, { get FindProxyForURL () { return function () { return "${PROXY}" } } }) } catch (error) {} ${SENDS_ALL.replace(PROXY, 'DIRECT')}`],
      ['Object.freeze, seal and preventExtensions of the global', `Object.freeze(this); ${SENDS_ALL}`]
    ] as const

    it.each(TAKES)('%s never sends a name Orivon serves to the proxy', (_name, script) => {
      const { answer } = load(script)
      for (const host of ROUTED_HOSTS) expect(answer(`https://${host}/`, host)).toBe('DIRECT')
    })

    it('leaves the accessor in place for the whole life of the context', () => {
      const context = createContext({})
      runInContext(wrapPacScript(SENDS_ALL, SUFFIXES), context)
      const descriptor = runInContext('Object.getOwnPropertyDescriptor(globalThis, "FindProxyForURL")', context) as PropertyDescriptor
      expect(descriptor.configurable).toBe(false)
      expect(typeof descriptor.get).toBe('function')
      expect(() => runInContext('Object.defineProperty(globalThis, "FindProxyForURL", { value: 1 })', context)).toThrow('Cannot redefine property')
      expect(runInContext('delete globalThis.FindProxyForURL', context)).toBe(false)
    })

    it('does not let a script that replaces the function while a call is under way change the next answer for a name Orivon serves', () => {
      const { answer } = load(`var calls = 0; function FindProxyForURL(url, host) { calls += 1; FindProxyForURL = function () { return "${PROXY}" }; globalThis.FindProxyForURL = function () { return "${PROXY}" }; return "${PROXY}" }`)
      expect(answer('https://ordinary.test/')).toBe(PROXY)
      expect(answer('https://vitalik.eth/')).toBe('DIRECT')
      expect(answer('https://vitalik.eth./')).toBe('DIRECT')
    })
  })

  describe('a script that changes what the language does', () => {
    const MEDDLES = [
      ['String.prototype.endsWith, charAt, charCodeAt, indexOf, includes, slice, substring, toLowerCase and the rest', `${['endsWith', 'startsWith', 'charAt', 'charCodeAt', 'codePointAt', 'indexOf', 'lastIndexOf', 'includes', 'slice', 'substring', 'substr', 'toLowerCase', 'toUpperCase', 'split', 'replace', 'match', 'search', 'at', 'normalize', 'trim', 'concat', 'localeCompare', 'padEnd', 'repeat', 'valueOf', 'toString'].map((name) => `String.prototype.${name} = function () { return ${JSON.stringify(name === 'endsWith' || name === 'includes' || name === 'startsWith' ? false : '')} };`).join(' ')} ${SENDS_ALL}`],
      ['String.prototype indices, which a read past a string\'s end would find', `for (var i = 0; i < 400; i += 1) { Object.defineProperty(String.prototype, i, { get: function () { return "x" }, set: function () {}, configurable: true }); Object.defineProperty(Array.prototype, i, { get: function () { return ["x", "x"] }, set: function () {}, configurable: true }) } ${SENDS_ALL}`],
      ['Array.prototype and Object.prototype', `Array.prototype.indexOf = function () { return -1 }; Array.prototype.push = function () {}; Array.prototype.length = 0; Array.prototype.every = function () { return false }; Array.prototype.some = function () { return false }; Array.prototype[Symbol.iterator] = function () { return { next: function () { return { done: true } } } }; Object.prototype.length = 0; Object.prototype[0] = "x"; Object.prototype.toString = function () { return "x" }; ${SENDS_ALL}`],
      ['Function.prototype.call, apply and bind', `Function.prototype.call = function () { return "${PROXY}" }; Function.prototype.apply = Function.prototype.call; Function.prototype.bind = Function.prototype.call; ${SENDS_ALL}`],
      ['Function, eval, Object, Reflect, JSON, Math and Symbol', `Function = function () { return function () { return "${PROXY}" } }; eval = function () {}; Object = {}; Reflect = {}; JSON = {}; Math = {}; Symbol = {}; String = function () {}; Array = function () {}; ${SENDS_ALL}`],
      ['Object.defineProperty, getOwnPropertyDescriptor and Function.prototype.constructor', `Object.defineProperty = function () {}; Object.getOwnPropertyDescriptor = function () {}; Function.prototype.constructor = function () { return function () { return "${PROXY}" } }; ${SENDS_ALL}`],
      ['the global object\'s own properties that a bare name could reach', `this.undefined = "x"; this.NaN = 0; this.Infinity = 0; this.globalThis = {}; this.TEXT = "x"; this.SUFFIXES = []; this.system = function () {}; this.wrapped = function () { return "${PROXY}" }; this.routed = function () { return false }; this.loading = true; this.assigned = true; this.g = {}; ${SENDS_ALL}`]
    ] as const

    it.each(MEDDLES)('%s: a name Orivon serves still goes DIRECT and an ordinary name still reaches the script', (_name, script) => {
      const { answer } = load(script)
      expect(answer('https://ordinary.test/')).toBe(PROXY)
      for (const host of ROUTED_HOSTS) expect(answer(`https://${host}/`, host)).toBe('DIRECT')
    })
  })

  it('does not read before the start of a host shorter than a suffix, where a script can put characters of its own ("h" would read as ".eth")', () => {
    const put = ['-3', '-2', '-1'].map((index, at) => `Object.defineProperty(String.prototype, "${index}", { value: ${JSON.stringify('.et'[at])}, configurable: true })`).join('; ')
    expect(load(`${put}; ${SENDS_ALL}`).answer('http://h/', 'h')).toBe(PROXY)
  })

  describe('a script that fails', () => {
    const BROKEN = [
      ['throws while it loads', `throw new Error("x"); ${SENDS_ALL}`],
      ['throws in the call', 'function FindProxyForURL() { throw new Error("boom") }'],
      ['throws a non-error in the call', 'function FindProxyForURL() { throw null }'],
      ['does not compile', 'function FindProxyForURL( {'],
      ['is not a function', 'FindProxyForURL = 5'],
      ['defines nothing', 'var unrelated = 1'],
      ['is empty', ''],
      ['recurses without end', 'function FindProxyForURL(url, host) { return FindProxyForURL(url, host) }']
    ] as const

    it.each(BROKEN)('which %s answers DIRECT for every name', (_name, script) => {
      const { answer } = load(script)
      for (const host of [...ROUTED_HOSTS, ...ORDINARY_HOSTS]) expect(answer(`https://${host}/`, host)).toBe('DIRECT')
    })

    it('which ends in a line comment still loads', () => {
      expect(load(`${SENDS_ALL} // the end`).answer('https://ordinary.test/')).toBe(PROXY)
    })

    it('which returns an object is passed on as it is for a name Orivon does not serve, and never for one it does', () => {
      const { answer } = load('function FindProxyForURL() { return { toString: function () { return "PROXY x.test:1" } } }')
      expect(typeof answer('https://ordinary.test/')).toBe('object')
      expect(answer('https://vitalik.eth/')).toBe('DIRECT')
    })
  })

  describe('a script text that tries to leave the place it was put in', () => {
    const ESCAPES = [
      'closing the closure',
      'closing a string',
      'a template',
      'a comment'
    ] as const
    const TEXTS: Readonly<Record<typeof ESCAPES[number], string>> = {
      'closing the closure': `var a = "}); })(); (function () {"; var b = '})();'; // })();\n/* })(); */ ${SENDS_ALL}`,
      'closing a string': `var a = "\\\\"; var b = '\\''; var c = "\\\\\\\\"; ${SENDS_ALL}`,
      'a template': `var a = \`\${1}\`; var b = "\${TEXT}"; ${SENDS_ALL}`,
      'a comment': `/* */ // \n /* " ' \` \\ */ ${SENDS_ALL}`
    }

    it.each(ESCAPES)('%s changes nothing', (name) => {
      const { answer, globals } = load(TEXTS[name])
      expect(answer('https://ordinary.test/')).toBe(PROXY)
      expect(answer('https://vitalik.eth/')).toBe('DIRECT')
      expect(globals()).not.toContain('TEXT')
    })

    it('a line separator and a paragraph separator inside a string, and characters beyond Latin-1', () => {
      const { answer } = load(`var a = "  "; var b = "é€😀"; function FindProxyForURL() { return a.length === 2 && b.length === 4 ? "${PROXY}" : "DIRECT" }`)
      expect(answer('https://ordinary.test/')).toBe(PROXY)
    })

    it('a NUL, other control characters and an unpaired surrogate', () => {
      const { answer } = load(`var a = "\u0000\u0001\u007f\ud800"; function FindProxyForURL() { return a.length === 4 ? "${PROXY}" : "DIRECT" }`)
      expect(answer('https://ordinary.test/')).toBe(PROXY)
    })

    it('a script text that closes the wrapper\'s closure does not run what follows it in the wrapper', () => {
      const { answer } = load(`}); this.FindProxyForURL = function () { return "${PROXY}" }; (function () {`)
      for (const host of [...ROUTED_HOSTS, ...ORDINARY_HOSTS]) expect(answer(`https://${host}/`, host)).toBe('DIRECT')
    })

    it('adds nothing to the global object but the function Chromium reads', () => {
      const names = (): string[] => runInContext('Object.getOwnPropertyNames(globalThis)', context) as string[]
      const context = createContext({})
      const before = new Set(names())
      runInContext(wrapPacScript(`var leak = 1; ${SENDS_ALL}`, SUFFIXES), context)
      expect(names().filter((name) => !before.has(name))).toEqual(['FindProxyForURL'])
    })
  })

  describe('the source it makes', () => {
    it('is plain ASCII whatever the script holds, so no charset changes what it says', () => {
      const source = wrapPacScript(`// é€😀 \u0000\n${SENDS_ALL}`, SUFFIXES)
      expect(/^[\x20-\x7e\n]*$/.test(source)).toBe(true)
    })

    it('does not carry the script text outside a string literal', () => {
      const text = 'function FindProxyForURL() { return "DIRECT" } /* marker-in-a-comment */'
      const source = wrapPacScript(text, SUFFIXES)
      expect(source.split('marker-in-a-comment').length).toBe(2)
      expect(source).not.toContain('function FindProxyForURL() { return "DIRECT" } /* marker')
    })

    it('is a data: URL that decodes to the source', () => {
      const source = wrapPacScript(SENDS_ALL, SUFFIXES)
      const url = pacDataUrl(source)
      expect(url.startsWith('data:application/x-ns-proxy-autoconfig;base64,')).toBe(true)
      expect(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('latin1')).toBe(source)
    })

    it('depends on the suffixes it is given and no others', () => {
      const { answer } = load(SENDS_ALL, ['crypto'])
      expect(answer('https://x.crypto/')).toBe('DIRECT')
      expect(answer('https://x.eth/')).toBe(PROXY)
    })

    it('names no host when it is given no suffix', () => {
      expect(load(SENDS_ALL, []).answer('https://x.eth/')).toBe(PROXY)
    })

    it('refuses a suffix that is not a name: one with a quote, a backslash, a dot at either end or nothing', () => {
      expect(() => wrapPacScript(SENDS_ALL, ['e"th'])).toThrow()
      expect(() => wrapPacScript(SENDS_ALL, ['eth.'])).toThrow()
      expect(() => wrapPacScript(SENDS_ALL, ['.eth'])).toThrow()
      expect(() => wrapPacScript(SENDS_ALL, [''])).toThrow()
      expect(() => wrapPacScript(SENDS_ALL, ['e\\th'])).toThrow()
    })
  })
})
