import { describe, expect, it } from 'vitest'
import { originFromSenderFrame, originFromUrl, type SenderFrameLike } from './origin.js'

// Origin derivation is the first of the six security-critical areas in
// docs/development/testing.md, and it has the property that qualifies an area
// for tests at all: EVERY failure mode here is silent.
//
// Two origins that should be one -- the app gets a second empty storage
// directory, a second grant ledger entry and a second identity key, and simply
// re-prompts. Two origins that should be two -- they share a directory, share
// grants, and one app reads the other's files. Neither throws. Neither is
// visible from using the product. And ADR-0003 makes both unfixable after the
// first grant is persisted: changing the definition orphans every app's data.
//
// Non-ASCII test inputs are written as \u escapes on purpose. The homograph
// cases below differ from their ASCII twins by codepoints that are INVISIBLE
// in a source file, and a test whose point is which character was used cannot
// be written in a form that hides it.

describe('originFromUrl', () => {
  describe('scheme + host + port, everything else discarded', () => {
    it.each<[string, string]>([
      ['https://x.example', 'https://x.example'],
      ['https://x.example/', 'https://x.example'],
      ['https://x.example/PATH/Deep?Q=1#Frag', 'https://x.example'],
      ['http://x.example', 'http://x.example']
    ])('%s -> %s', (input, expected) => {
      expect(originFromUrl(input)).toBe(expected)
    })
  })

  describe('default ports are the same origin as no port', () => {
    it.each<[string, string]>([
      ['https://x.example:443', 'https://x.example'],
      ['http://x.example:80', 'http://x.example'],
      // The converse: a non-default port is part of the origin and must stay.
      ['https://x.example:8443', 'https://x.example:8443'],
      ['http://localhost:3000', 'http://localhost:3000'],
      // Cross-scheme: the OTHER scheme's default port is not default here.
      ['https://x.example:80', 'https://x.example:80'],
      ['http://x.example:443', 'http://x.example:443']
    ])('%s -> %s', (input, expected) => {
      expect(originFromUrl(input)).toBe(expected)
    })
  })

  describe('case is normalised in the host, and the path is not part of the origin at all', () => {
    it.each<[string, string]>([
      ['HTTPS://X.Example.COM', 'https://x.example.com'],
      ['https://X.EXAMPLE', 'https://x.example'],
      // Same origin despite differing path case -- the path is dropped, so
      // path case can never split one app across two storage domains.
      ['https://x.example/Path', 'https://x.example'],
      ['https://x.example/path', 'https://x.example']
    ])('%s -> %s', (input, expected) => {
      expect(originFromUrl(input)).toBe(expected)
    })
  })

  describe('userinfo is stripped', () => {
    // Credentials in a URL are not part of the origin. If they leaked in, the
    // grant key would contain a password, and an attacker could mint unlimited
    // fresh origins for a host they do not control by varying the username.
    it.each<[string, string]>([
      ['https://user:pw@x.example', 'https://x.example'],
      ['https://user@x.example/path', 'https://x.example'],
      ['https://admin:hunter2@x.example:8443/p', 'https://x.example:8443']
    ])('%s -> %s', (input, expected) => {
      expect(originFromUrl(input)).toBe(expected)
    })
  })

  describe('the trailing root label is stripped -- x.example. and x.example are ONE origin', () => {
    it.each<[string, string]>([
      ['https://x.example.', 'https://x.example'],
      ['https://x.example./deep/path', 'https://x.example'],
      ['https://x.example.:8443', 'https://x.example:8443'],
      ['https://X.EXAMPLE.', 'https://x.example'],
      // Percent-encoding is a second spelling of the same dot: the URL parser
      // decodes %2e into the host before we ever see it.
      ['https://x.example%2e', 'https://x.example'],
      ['https://x.example%2E', 'https://x.example'],
      ['http://localhost.', 'http://localhost'],
      // punycode + trailing dot, the two normalisations stacked
      ['https://xn--exmple-cua.com.', 'https://xn--exmple-cua.com']
    ])('%s -> %s', (input, expected) => {
      expect(originFromUrl(input)).toBe(expected)
    })

    it('is a deliberate deviation from URL.origin, which keeps them apart', () => {
      // Documenting the divergence, so that a future reader who "fixes" this
      // function to just return URL.origin sees what they are giving up.
      expect(new URL('https://x.example.').origin).toBe('https://x.example.')
      expect(originFromUrl('https://x.example.')).toBe(originFromUrl('https://x.example'))
    })
  })

  describe('IDN is keyed in its punycode form, never the decoded Unicode', () => {
    it.each<[string, string]>([
      // ex(a-umlaut)mple.com
      ['https://ex\u00e4mple.com', 'https://xn--exmple-cua.com'],
      // The same name already in punycode: normalisation is idempotent, so the
      // two spellings cannot become two storage domains.
      ['https://xn--exmple-cua.com', 'https://xn--exmple-cua.com'],
      // Uppercase Unicode still lands on the same key.
      ['https://EX\u00c4MPLE.com', 'https://xn--exmple-cua.com']
    ])('%s -> %s', (input, expected) => {
      expect(originFromUrl(input)).toBe(expected)
    })

    it('a Cyrillic homograph gets a DIFFERENT key from its Latin twin', () => {
      // U+0430 CYRILLIC SMALL LETTER A, which renders identically to 'a'.
      // These two must NOT collapse: they are different hosts, run by
      // different people, and sharing a storage domain between them would hand
      // a phishing domain the real site's grants and identity key. This is the
      // keying half of security-model.md T25; the display half is the shell's.
      const homograph = originFromUrl('https://\u0430pple.com')
      const latin = originFromUrl('https://apple.com')

      expect(homograph).toBe('https://xn--pple-43d.com')
      expect(latin).toBe('https://apple.com')
      expect(homograph).not.toBe(latin)
    })
  })

  describe('IP literals collapse to one spelling per address', () => {
    it.each<[string, string]>([
      // Octal and integer IPv4 forms are the same host as the dotted-quad and
      // must not open a second storage domain for it.
      ['https://0177.0.0.1', 'https://127.0.0.1'],
      ['https://2130706433', 'https://127.0.0.1'],
      ['https://127.0.0.1', 'https://127.0.0.1'],
      ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
      // IPv6 keeps its brackets -- they are part of the host in an origin --
      // and the expanded form compresses to the same key as ::1.
      ['http://[0:0:0:0:0:0:0:1]', 'http://[::1]'],
      ['http://[::1]', 'http://[::1]'],
      ['http://[::1]:8080', 'http://[::1]:8080']
    ])('%s -> %s', (input, expected) => {
      expect(originFromUrl(input)).toBe(expected)
    })
  })

  // The rejections below are the whole reason this function is not one line.
  describe('schemes whose URL.origin is the STRING "null" are rejected', () => {
    it.each([
      'file:///etc/passwd',
      'file://C:/Windows/System32',
      'data:text/html,<script>alert(1)</script>',
      'about:blank',
      'about:srcdoc',
      'javascript:alert(1)',
      'magnet:?xt=urn:btih:0123456789abcdef',
      'chrome://settings',
      'orivon://app'
    ])('%s -> null', (input) => {
      // The bug being closed: URL.origin returns the four-character string
      // "null" for all of these. It is falsy-looking and is not falsy, it is a
      // valid object key and a valid directory name, and returning it unchecked
      // would give every opaque URL in the browser ONE shared storage domain
      // and ONE grant ledger entry.
      expect(new URL(input).origin).toBe('null')
      expect(originFromUrl(input)).toBeNull()
      expect(originFromUrl(input)).not.toBe('null')
    })
  })

  describe('schemes whose URL.origin looks entirely legitimate are still rejected', () => {
    it.each([
      // security-model.md T13b requires blob: be rejected outright -- but its
      // origin is inherited and real, so a denylist naming file: and data:
      // reads as complete and lets this straight through.
      'blob:https://x.example/6b7f9e1c-0000-4000-8000-000000000000',
      'ws://x.example',
      'wss://x.example/socket',
      'ftp://x.example/pub'
    ])('%s -> null', (input) => {
      expect(new URL(input).origin).not.toBe('null')
      expect(originFromUrl(input)).toBeNull()
    })
  })

  describe('hosts with an empty DNS label are rejected rather than repaired', () => {
    // Stripping more than the single root label would map an unresolvable name
    // onto a resolvable one -- which is the origin collapse this whole file
    // exists to prevent, performed by the code meant to prevent it.
    it.each(['https://.', 'https://.x.example', 'https://a..b.example', 'https://x.example..'])(
      '%s -> null',
      (input) => {
        expect(originFromUrl(input)).toBeNull()
      }
    )
  })

  describe('unparseable input is rejected', () => {
    it.each(['', '   ', 'not a url', 'x.example', '//x.example', 'https://', 'https://x.example:99999'])(
      '%s -> null',
      (input) => {
        expect(originFromUrl(input)).toBeNull()
      }
    )
  })
})

describe('originFromSenderFrame', () => {
  // security-model.md T3. The broker's only source of caller identity. If this
  // can be influenced by the renderer, every other control in the project is
  // decoration: a compromised renderer names any origin it likes and inherits
  // that app's grants, files and identity key.
  describe('renderer-supplied identity is never trusted', () => {
    it('derives from url and IGNORES a conflicting origin field', () => {
      // The single most important assertion in this file. If the
      // implementation ever reads frame.origin, this returns the attacker's
      // origin and the test fails.
      expect(
        originFromSenderFrame({
          url: 'https://real.example/app/index.html',
          origin: 'https://attacker.example'
        })
      ).toBe('https://real.example')
    })

    it('a frame claiming a privileged origin gets its real one', () => {
      expect(
        originFromSenderFrame({
          url: 'https://ad-iframe.example/tracker.html',
          origin: 'https://torrent.orivon.app'
        })
      ).toBe('https://ad-iframe.example')
    })

    it('an origin field agreeing with url changes nothing -- it is still unread', () => {
      expect(
        originFromSenderFrame({ url: 'https://x.example:8443/p', origin: 'https://x.example:8443' })
      ).toBe('https://x.example:8443')
    })

    it('works with no origin field at all, proving url is the sole source', () => {
      expect(originFromSenderFrame({ url: 'https://x.example/p' })).toBe('https://x.example')
    })

    it('normalises exactly as originFromUrl does -- one definition, not two', () => {
      // A second normalisation path here would be a second origin definition,
      // and the two would drift.
      expect(originFromSenderFrame({ url: 'https://USER:pw@X.Example.:443/P' })).toBe(
        originFromUrl('https://x.example')
      )
    })
  })

  describe('unbound frames are rejected', () => {
    it.each<[string, SenderFrameLike | null | undefined]>([
      ['null (event.senderFrame can be null)', null],
      ['undefined', undefined],
      ['no url property', {}],
      ['never navigated -- url is empty', { url: '' }],
      // about:blank and about:srcdoc INHERIT an origin on the web platform.
      // Inheriting a document origin is fine; inheriting a capability grant is
      // not, so they get no origin here (security-model.md T13b).
      ['about:blank', { url: 'about:blank' }],
      ['about:srcdoc', { url: 'about:srcdoc' }],
      ['a data: frame', { url: 'data:text/html,<script>1</script>' }],
      ['a file: frame', { url: 'file:///home/user/evil.html' }]
    ])('%s -> null', (_label, frame) => {
      expect(originFromSenderFrame(frame)).toBeNull()
    })

    it('a disposed frame denies instead of crashing the broker', () => {
      // Electron throws on property access once the render frame is gone, and
      // T3's own correction notes an async handler can resolve after the frame
      // is detached. Denial is the answer; an exception out of the origin
      // check takes the IPC handler with it.
      const disposed: SenderFrameLike = {
        get url (): string {
          throw new Error('Render frame was disposed before WebFrameMain could be accessed')
        }
      }

      expect(originFromSenderFrame(disposed)).toBeNull()
    })

    it('a non-string url denies instead of throwing', () => {
      // The type is a claim about a value that crosses from Electron at
      // runtime, not a guarantee about it.
      expect(originFromSenderFrame({ url: 42 } as unknown as SenderFrameLike)).toBeNull()
      expect(originFromSenderFrame({ url: null } as unknown as SenderFrameLike)).toBeNull()
    })
  })
})
