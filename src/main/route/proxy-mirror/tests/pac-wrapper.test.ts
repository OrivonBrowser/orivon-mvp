import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BUILTIN_ADDRESSES } from '../../../../protocols/builtin.js'
import { routedBypassRules } from '../../verifier-name-guard.js'
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

    const NOT_ASCII_STRINGS = [
      ['an object', 'function FindProxyForURL() { return { toString: function () { return "PROXY x.test:1" } } }'],
      ['a string object', 'function FindProxyForURL() { return new String("PROXY x.test:1") }'],
      ['a number', 'function FindProxyForURL() { return 1 }'],
      ['nothing', 'function FindProxyForURL() { }'],
      ['null', 'function FindProxyForURL() { return null }'],
      ['a string beyond ASCII', 'function FindProxyForURL() { return "PROXY \u00e9.test:1" }'],
      ['a string with a character beyond ASCII at its end', 'function FindProxyForURL() { return "PROXY x.test:1;\u2028" }']
    ] as const

    it.each(NOT_ASCII_STRINGS)('which returns %s answers DIRECT for every name, as Chromium\'s own session does for a script that fails, where a mandatory script fails the request', (_name, script) => {
      const { answer } = load(script)
      for (const host of [...ROUTED_HOSTS, ...ORDINARY_HOSTS]) expect(answer(`https://${host}/`, host)).toBe('DIRECT')
    })

    it('which returns a string of ASCII is passed on as it is for a name Orivon does not serve', () => {
      const { answer } = load('function FindProxyForURL() { return "PROXY a.test:1; SOCKS5 b.test:2; DIRECT" }')
      expect(answer('https://ordinary.test/')).toBe('PROXY a.test:1; SOCKS5 b.test:2; DIRECT')
      expect(answer('https://vitalik.eth/')).toBe('DIRECT')
    })
  })

  describe('a script that goes after what the wrapper keeps for itself', () => {
    const STORE = 'this.kept = '
    const ATTACKS: ReadonlyArray<readonly [string, string]> = [
      ['the caller of the code that loads it', `${STORE}String(arguments.callee.caller); ${SENDS_ALL}`],
      ['the caller of the function it names', `function FindProxyForURL(u, h) { var c = FindProxyForURL.caller; ${STORE}String(c); return "${PROXY}" }`],
      ['the functions of the stack, through prepareStackTrace', `var seen = []; Error.prepareStackTrace = function (e, frames) { return frames }; function grab () { var frames = new Error().stack; for (var i = 0; i < frames.length; i++) { seen.push(String(frames[i].getFunction()), String(frames[i].getThis())) } } grab(); function FindProxyForURL(u, h) { grab(); ${STORE}seen.join(); return "${PROXY}" } ${STORE}seen.join()`],
      ['the frames captureStackTrace gives', `Error.prepareStackTrace = function (e, f) { return f.map(function (x) { return String(x.getFunction()) + String(x.getThis()) }).join() }; var o = {}; Error.captureStackTrace(o); ${STORE}o.stack; ${SENDS_ALL}`],
      ['the function Chromium reads, changed while it is called', `function FindProxyForURL(u, h) { var w = globalThis.FindProxyForURL; try { w.call = function () { return "${PROXY}" } } catch (e) {} try { w.apply = w.call } catch (e) {} try { Object.setPrototypeOf(w, function () { return "${PROXY}" }) } catch (e) {} try { Object.freeze(w) } catch (e) {} try { ${STORE}String(w.caller) + String(w.arguments) + String(Object.getOwnPropertyDescriptor(globalThis, "FindProxyForURL").get.caller) } catch (e) {} return "${PROXY}" }`],
      ['the names of the closure, assigned bare', `system = function () { return "${PROXY}" }; loading = true; assigned = false; wrapped = system; routed = function () { return false }; SUFFIXES = []; TEXT = ""; g = {}; found = system; ${SENDS_ALL}`],
      ['the names of the closure, declared in a direct eval', `eval("var system = function () { return '${PROXY}' }; var loading = true; var wrapped = system; var routed = function () { return false }; var SUFFIXES = [];"); ${SENDS_ALL}`],
      ['the names of the closure, declared in an indirect eval', `(0, eval)("var system = function () { return '${PROXY}' }; var loading = true; var wrapped = system; var routed = function () { return false }; var SUFFIXES = []; function FindProxyForURL() { return '${PROXY}' }"); ${SENDS_ALL}`],
      ['a with block over a Proxy that has every name', `with (new Proxy({}, { has: function () { return true }, get: function (t, k) { return k === Symbol.unscopables ? undefined : function () { return "${PROXY}" } } })) { FindProxyForURL = function () { return "${PROXY}" } } ${SENDS_ALL}`],
      ['a getter on Object.prototype', `Object.defineProperty(Object.prototype, "FindProxyForURL", { get: function () { return function () { return "${PROXY}" } }, configurable: true }); ${SENDS_ALL}`],
      ['a Proxy as the prototype of the global', `try { Object.setPrototypeOf(this, new Proxy({}, { get: function () { return function () { return "${PROXY}" } } })) } catch (e) {} ${SENDS_ALL}`],
      ['FindProxyForURLEx', `function FindProxyForURLEx(u, h) { return "${PROXY}" } this.FindProxyForURLEx = FindProxyForURLEx; ${SENDS_ALL}`],
      ['a callable Proxy as the function', `FindProxyForURL = new Proxy(function () {}, { apply: function () { return "${PROXY}" }, get: function () { return function () { return "${PROXY}" } } })`],
      ['a bound function', `FindProxyForURL = function () { return "${PROXY}" }.bind(null)`],
      ['a class', `FindProxyForURL = class { constructor () { return "${PROXY}" } }`],
      ['an async function', `async function FindProxyForURL () { return "${PROXY}" }`],
      ['a string object', `function FindProxyForURL () { return new String("${PROXY}") }`],
      ['a string that ends on a line continuation', `${SENDS_ALL}; var s = "\\`],
      ['a return', `this.FindProxyForURL = function () { return "${PROXY}" }; return`],
      ['an if with nothing after it', `${SENDS_ALL}; if (0)`],
      ['a comment that is never closed', `${SENDS_ALL} /*`],
      ['a template that is never closed', `${SENDS_ALL} \``],
      ['a character class that is never closed', `${SENDS_ALL}; var r = /[`],
      ['a parenthesis that is never closed', `${SENDS_ALL}; (`],
      ['a brace that is never closed', `${SENDS_ALL}; {`],
      ['an HTML comment that is never closed', `${SENDS_ALL} <!--`],
      ['an HTML comment close at the start of a line', `-->\n${SENDS_ALL}\n--> return function () { return "${PROXY}" }`],
      ['an HTML comment close after a comment', `/*\n*/ --> anything\n${SENDS_ALL}`],
      ['a function returned at the top', `return function () { return "${PROXY}" }`],
      ['a closing brace and an opening comment', '}/*'],
      ['a closing brace, an HTML comment and a function', '}\n-->\n(function(){'],
      ['a line separator that ends a comment', `// x ${SENDS_ALL}`],
      ['a byte-order mark at the start', `﻿${SENDS_ALL}`],
      ['an unpaired surrogate before the code', `\ud800${SENDS_ALL}`],
      ['a NUL before the code', `\u0000${SENDS_ALL}`],
      ['an escaped name for the function', `\\u0046indProxyForURL = function () { return "${PROXY}" }`],
      ['carriage returns for line ends', `var a = 1\r${SENDS_ALL}\r`],
      ['an assignment that fails with its function already set', `FindProxyForURL = function () { return "${PROXY}" }; throw 1`],
      ['a thrown object whose getters assign the function', `throw { get message () { FindProxyForURL = function () { return "${PROXY}" }; return "m" }, toString: function () { FindProxyForURL = function () { return "${PROXY}" }; return "s" }, [Symbol.toPrimitive]: function () { FindProxyForURL = function () { return "${PROXY}" }; return "p" } }`],
      ['a thrown object whose getters answer, in the call', `function FindProxyForURL () { throw { get message () { return "m" }, toString: function () { return "${PROXY}" } } }`],
      ['a stack it fills in the call', 'function FindProxyForURL () { function again () { again() } again() }'],
      ['an answer in characters beyond ASCII', 'function FindProxyForURL () { return "PROXY é.test:1" }']
    ]

    it.each(ATTACKS)('%s never sends a name Orivon serves to the proxy, and never shows the wrapper to the script', (_name, script) => {
      const context = createContext({})
      runInContext(wrapPacScript(script, SUFFIXES), context)
      const ask = runInContext('(function (url, host) { return FindProxyForURL(url, host) })', context) as (url: string, host: string) => unknown
      for (const host of ROUTED_HOSTS) expect(ask(`https://${host}/`, host)).toBe('DIRECT')
      expect(() => ask('https://ordinary.test/', 'ordinary.test')).not.toThrow()
      const shown = runInContext('Object.getOwnPropertyNames(globalThis).filter(function (name) { return name !== "FindProxyForURL" }).map(function (name) { try { return String(globalThis[name]) } catch (e) { return "" } }).join("\\n")', context) as string
      expect(shown).not.toMatch(/SUFFIXES|loading|assigned|routed/)
    })

    it('does not give the function to a script that assigns it from a microtask after the script failed to load', async () => {
      const { answer } = load(`Promise.resolve().then(function () { FindProxyForURL = function () { return "${PROXY}" } }); throw new Error("x")`)
      await new Promise((resolve) => { setImmediate(resolve) })
      for (const host of [...ROUTED_HOSTS, ...ORDINARY_HOSTS]) expect(answer(`https://${host}/`, host)).toBe('DIRECT')
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

  describe('reads a name as the rest of Orivon does', () => {
    const HOSTS = [
      'vitalik.eth', 'Vitalik.ETH', 'a..eth', '.eth', '..eth', 'ipfs.orivon', 'bafy.ipfs.orivon', 'eth', 'orivon', 'example.com',
      'vitalik.eth.example.com', 'orivon.example', '', 'xeth', 'ethx.test', 'x.ethereum', 'x.eth.test', 'x-eth', 'a.b.c.orivon'
    ]

    it.each(HOSTS)('%j, with no root dot and with one, two and three', (host) => {
      const { answer } = load(SENDS_ALL, BUILTIN_ADDRESSES.routedSuffixes())
      for (const dots of ['', '.', '..', '...']) {
        const spelled = `${host}${dots}`
        expect(answer('https://name/', spelled), JSON.stringify(spelled)).toBe(BUILTIN_ADDRESSES.namesServedHost(spelled) ? 'DIRECT' : PROXY)
      }
    })

    it('gives DIRECT for the host of every exception the mirrored settings carry for a name', () => {
      const { answer } = load(SENDS_ALL, BUILTIN_ADDRESSES.routedSuffixes())
      const rules = routedBypassRules()
      expect(rules.length).toBeGreaterThan(0)
      for (const rule of rules) expect(answer('https://name/', rule.replace('*', 'name')), rule).toBe('DIRECT')
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

    it('is refused as a data: URL when it holds anything but ASCII, where base64 of Latin-1 would change what it says', () => {
      expect(() => pacDataUrl('var a = "\u00e9"')).toThrow('ASCII')
      expect(() => pacDataUrl('var a = "\u0100"')).toThrow('ASCII')
      expect(() => pacDataUrl('var a = "\u0000"')).toThrow('ASCII')
      expect(() => pacDataUrl('var a = 1;\n')).not.toThrow()
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
