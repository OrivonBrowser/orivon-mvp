import { describe, expect, it } from 'vitest'
import { carriesNoBody, documentPolicyOf, parseReport, referrerFor } from '../navigation-referrer.js'
import type { NavigationReferrer, NavigationReport, NavigationSource } from '../navigation-referrer.js'

// The rule these tests hold: a navigation the shell re-issues carries what Chromium would have sent, or less.

const SOURCE = 'https://a.eth/page/one?q=1#part'
const TARGET = 'https://b.eth/landing'

describe('documentPolicyOf', () => {
  it('is the default when neither the header nor a tag sets a policy', () => {
    expect(documentPolicyOf('', [])).toBe('default')
    expect(documentPolicyOf('', ['', ''])).toBe('default')
  })

  it('reads the header: the last name of a list wins, names are case blind', () => {
    expect(documentPolicyOf('no-referrer', [])).toBe('no-referrer')
    expect(documentPolicyOf('Same-Origin', [])).toBe('same-origin')
    expect(documentPolicyOf('no-referrer, strict-origin', [])).toBe('strict-origin')
    expect(documentPolicyOf('no-referrer,,', [])).toBe('no-referrer')
  })

  it('reads a meta tag, with the old names it still takes', () => {
    expect(documentPolicyOf('', ['strict-origin'])).toBe('strict-origin')
    expect(documentPolicyOf('', ['NEVER'])).toBe('no-referrer')
    expect(documentPolicyOf('', ['always'])).toBe('unsafe-url')
    expect(documentPolicyOf('', ['origin-when-crossorigin'])).toBe('origin-when-cross-origin')
    expect(documentPolicyOf('', ['default'])).toBe('default')
  })

  it('accepts a header and tags that agree, and any number of tags that repeat one policy', () => {
    expect(documentPolicyOf('origin', ['origin', 'Origin'])).toBe('origin')
  })

  it('is unknown when the header and the tags disagree, since the later one wins and which was later is not known', () => {
    expect(documentPolicyOf('no-referrer', ['unsafe-url'])).toBeUndefined()
    expect(documentPolicyOf('', ['no-referrer', 'unsafe-url'])).toBeUndefined()
    expect(documentPolicyOf('origin', ['default'])).toBeUndefined()
  })

  it('is unknown when the response was not seen, or a value is one Chromium might read differently', () => {
    expect(documentPolicyOf(undefined, [])).toBeUndefined()
    expect(documentPolicyOf('sometimes', [])).toBeUndefined()
    expect(documentPolicyOf('no-referrer, never', [])).toBeUndefined()
    expect(documentPolicyOf('', ['no-referrer unsafe-url'])).toBeUndefined()
    expect(documentPolicyOf('', ['?'])).toBeUndefined()
  })
})

describe('referrerFor', () => {
  const script: NavigationSource = { kind: 'script' }
  const element = (tag: string, rel: string | null = null, referrerPolicy: string | null = null): NavigationSource => ({ kind: 'element', tag, rel, referrerPolicy })
  const report = (source: NavigationSource | undefined, metaPolicies: string[] = [], overrides: Partial<NavigationReport> = {}): NavigationReport =>
    ({ href: SOURCE, documentUrl: SOURCE, metaPolicies, destination: TARGET, source, ...overrides })
  /** The referrer for `r`, with `header` as the response's `Referrer-Policy` (empty for none). */
  const sent = (r: NavigationReport | undefined, header: string | undefined = '', target = TARGET): NavigationReferrer | undefined => referrerFor(SOURCE, target, r, header)
  const policyOf = (r: NavigationReport | undefined, header = ''): string | undefined => sent(r, header)?.policy
  const ADDRESS = 'https://a.eth/page/one?q=1'

  it('hands Chromium the document\'s address and the default policy for a link, a script, a form and an area', () => {
    for (const source of [element('a'), script, element('form'), element('area')]) expect(sent(report(source))).toEqual({ url: ADDRESS, policy: 'default' })
  })

  it('follows the document\'s policy, from its header or a tag', () => {
    expect(policyOf(report(script), 'strict-origin')).toBe('strict-origin')
    expect(policyOf(report(script), 'unsafe-url')).toBe('unsafe-url')
    expect(policyOf(report(script), 'same-origin')).toBe('same-origin')
    expect(policyOf(report(script), 'no-referrer-when-downgrade')).toBe('no-referrer-when-downgrade')
    expect(policyOf(report(script, ['origin']))).toBe('origin')
    expect(sent(report(script), 'no-referrer')).toBeUndefined()
    expect(sent(report(script, ['no-referrer']))).toBeUndefined()
    expect(sent(report(element('a')), 'No-Referrer')).toBeUndefined()
  })

  it('says origin-when-cross-origin with the two policies Electron types: the origin across origins, the whole address within one', () => {
    expect(policyOf(report(script), 'Origin-When-Cross-Origin')).toBe('origin')
    const within = { destination: 'https://a.eth/elsewhere' }
    expect(referrerFor(SOURCE, 'https://a.eth/elsewhere', report(script, [], within), 'origin-when-cross-origin')).toEqual({ url: ADDRESS, policy: 'default' })
  })

  it('sends nothing for a link or form with rel noreferrer, whatever else it says', () => {
    expect(sent(report(element('a', 'noreferrer')))).toBeUndefined()
    expect(sent(report(element('a', 'noopener NoReferrer')))).toBeUndefined()
    expect(sent(report(element('a', 'noreferrer', 'unsafe-url')), 'unsafe-url')).toBeUndefined()
    expect(sent(report(element('form', 'noreferrer')))).toBeUndefined()
    expect(policyOf(report(element('a', 'noopener')))).toBe('default')
  })

  it('lets a link\'s referrerpolicy beat the document\'s, in both directions', () => {
    expect(sent(report(element('a', null, 'no-referrer')), 'unsafe-url')).toBeUndefined()
    expect(policyOf(report(element('a', null, 'unsafe-url')), 'no-referrer')).toBe('unsafe-url')
    expect(policyOf(report(element('area', null, 'origin')))).toBe('origin')
    expect(policyOf(report(element('a', null, '')), 'same-origin')).toBe('same-origin')
  })

  it('reads no referrer policy off a form', () => {
    expect(policyOf(report(element('form', null, 'no-referrer')), 'unsafe-url')).toBe('unsafe-url')
  })

  it('sends nothing when the element\'s policy is unknown', () => {
    expect(sent(report(element('a', null, 'always')))).toBeUndefined()
    expect(sent(report(element('a', null, 'never')))).toBeUndefined()
    expect(sent(report(element('button')))).toBeUndefined()
    expect(sent(report(element('iframe')))).toBeUndefined()
  })

  it('sends nothing when the page cannot say what started the navigation, or the document\'s policy cannot be told', () => {
    expect(sent(undefined)).toBeUndefined()
    expect(sent(report(undefined))).toBeUndefined()
    expect(referrerFor(SOURCE, TARGET, report(script), undefined)).toBeUndefined()
    expect(sent(report(script), 'sometimes')).toBeUndefined()
    expect(sent(report(script, ['unsafe-url']), 'no-referrer')).toBeUndefined()
  })

  it('reads a referrerpolicy attribute and a tag\'s content as written: white space around one is a value it does not read', () => {
    expect(sent(report(element('a', null, ' origin')), 'no-referrer')).toBeUndefined()
    expect(sent(report(element('a', null, 'origin ')))).toBeUndefined()
    expect(sent(report(element('a', null, ' ')))).toBeUndefined()
    expect(sent(report(script, [' unsafe-url ']))).toBeUndefined()
    expect(sent(report(script, [' ']))).toBeUndefined()
    expect(policyOf(report(element('a', null, 'ORIGIN')))).toBe('origin')
    expect(policyOf(report(script), ' origin ')).toBe('origin')
  })

  it('sends nothing to an address that is not http(s), or that is not an address', () => {
    for (const target of ['ipfs://b.eth/landing', 'mailto:x@example.org', 'not an address']) {
      expect(sent(report(script, [], { destination: target }), '', target)).toBeUndefined()
    }
  })

  it('sends nothing when the report is about another document or another navigation', () => {
    expect(sent(report(script, [], { href: 'https://a.eth/different' }))).toBeUndefined()
    expect(sent(report(script, [], { destination: 'https://c.eth/other' }))).toBeUndefined()
  })

  it('matches the navigation by address without its fragment', () => {
    expect(sent(report(script, [], { destination: 'https://b.eth/landing#section' }))).toEqual({ url: ADDRESS, policy: 'default' })
    expect(sent(report(script), '', 'https://b.eth/landing#other')).toEqual({ url: ADDRESS, policy: 'default' })
  })

  it('sends nothing from a document that is not a web page', () => {
    const local = { href: 'file:///home/u/a.html', documentUrl: 'file:///home/u/a.html' }
    expect(referrerFor(local.href, TARGET, report(script, [], local), '')).toBeUndefined()
    const blank = { href: 'about:blank', documentUrl: 'about:blank' }
    expect(referrerFor(blank.href, TARGET, report(script, [], blank), '')).toBeUndefined()
    expect(referrerFor(SOURCE, 'not an address', report(script, [], { destination: 'not an address' }), '')).toBeUndefined()
  })

  it('never hands over the credentials or the fragment of the document\'s address', () => {
    const withSecrets = 'https://user:secret@a.eth/p?q=1#frag'
    const secret = { href: withSecrets, documentUrl: withSecrets, destination: 'https://a.eth/next' }
    expect(referrerFor(withSecrets, 'https://a.eth/next', report(script, [], secret), 'unsafe-url')).toEqual({ url: 'https://a.eth/p?q=1', policy: 'unsafe-url' })
  })
})

describe('parseReport', () => {
  const good = { href: SOURCE, documentUrl: SOURCE, metaPolicies: ['strict-origin'], destination: TARGET, source: { kind: 'element', tag: 'a', rel: 'noopener', referrerPolicy: null } }

  it('accepts the shape the page keeps', () => {
    expect(parseReport(good)).toEqual(good)
    expect(parseReport({ ...good, source: { kind: 'script' } })?.source).toEqual({ kind: 'script' })
    expect(parseReport({ ...good, source: undefined })?.source).toBeUndefined()
  })

  it('keeps whether the navigation submits a form, and drops anything but a boolean', () => {
    expect(parseReport({ ...good, post: true })?.post).toBe(true)
    expect(parseReport({ ...good, post: false })?.post).toBe(false)
    expect(parseReport({ ...good, post: 'yes' })).not.toHaveProperty('post')
    expect(parseReport(good)).not.toHaveProperty('post')
  })

  it.each([undefined, null, 'x', 4, [], { href: 1 }, { href: 'x', documentUrl: 'x', destination: 1 }])('rejects %j', (value) => {
    expect(parseReport(value)).toBeUndefined()
  })

  it('rejects policies that are not a list of strings', () => {
    expect(parseReport({ ...good, metaPolicies: 'strict-origin' })).toBeUndefined()
    expect(parseReport({ ...good, metaPolicies: [1] })).toBeUndefined()
    expect(parseReport({ ...good, metaPolicies: undefined })).toBeUndefined()
  })

  it('rejects an element note with a missing or mistyped field', () => {
    expect(parseReport({ ...good, source: { kind: 'element', tag: 'a', rel: 3, referrerPolicy: null } })).toBeUndefined()
    expect(parseReport({ ...good, source: { kind: 'element', rel: null, referrerPolicy: null } })).toBeUndefined()
    expect(parseReport({ ...good, source: { kind: 'other' } })).toBeUndefined()
    expect(parseReport({ ...good, source: 'a' })).toBeUndefined()
  })
})

describe('carriesNoBody', () => {
  const noteFor = (extra: object = {}): NonNullable<ReturnType<typeof parseReport>> => parseReport({ href: SOURCE, documentUrl: SOURCE, metaPolicies: [], destination: TARGET, source: { kind: 'script' }, post: false, ...extra })!

  it('is true only when the page said this navigation submits no form', () => {
    expect(carriesNoBody(SOURCE, TARGET, noteFor())).toBe(true)
    expect(carriesNoBody(SOURCE, TARGET, noteFor({ post: true }))).toBe(false)
    expect(carriesNoBody(SOURCE, TARGET, parseReport({ href: SOURCE, documentUrl: SOURCE, metaPolicies: [], destination: TARGET, source: { kind: 'script' } }))).toBe(false)
    expect(carriesNoBody(SOURCE, TARGET, undefined)).toBe(false)
  })

  it('is false when the note is about another navigation or another document', () => {
    expect(carriesNoBody(SOURCE, TARGET, noteFor({ destination: 'https://c.eth/' }))).toBe(false)
    expect(carriesNoBody('https://a.eth/other', TARGET, noteFor())).toBe(false)
  })

  it('does not tell a hash edit from the same navigation', () => {
    expect(carriesNoBody(SOURCE, TARGET, noteFor({ destination: `${TARGET}#top` }))).toBe(true)
  })
})
