import { describe, expect, it } from 'vitest'
import { fold, type TelemetryEvent } from './accounting.js'
import {
  buildDisclosurePayload,
  DISCLOSURE_OPTIONS,
  initialConsentState,
  applyDisclosureChoice,
  shouldPresentDisclosure,
  mayTransmit,
  type DisclosureMeta
} from './disclosure.js'

// Fixed metadata reused across the payload tests. installId is just a
// plausible-looking string here -- this module never generates one (no
// RNG, no I/O; see disclosure.ts's module comment) -- a real caller
// supplies whatever it generated at first run.
const meta: DisclosureMeta = {
  installId: '4c2f2f3a-1111-4444-8888-abcde1234567',
  country: 'IT',
  version: '0.1.0',
  period: '2026-09'
}

describe('buildDisclosurePayload -- the literal JSON, from real accounting samples', () => {
  it('matches the ADR-0004 payload shape exactly, for a real multi-app fold', () => {
    const t0 = Date.UTC(2026, 8, 1, 0, 0, 0) // 2026-09-01T00:00:00Z
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app: 'torrent' },
      { kind: 'session-start', atMs: t0, app: 'nostrClient' },
      { kind: 'focus', atMs: t0, app: 'torrent' },
      { kind: 'interaction', atMs: t0 },
      { kind: 'session-stop', atMs: t0 + 60_000, app: 'torrent' }, // 60s, focused + interacted
      { kind: 'session-stop', atMs: t0 + 60_000, app: 'nostrClient' } // 60s, never focused
    ]
    const state = fold(events)

    expect(buildDisclosurePayload(state, meta)).toEqual({
      installId: meta.installId,
      country: meta.country,
      version: meta.version,
      period: meta.period,
      perApp: {
        torrent: { activeSec: 60, backgroundSec: 0 },
        nostrClient: { activeSec: 0, backgroundSec: 60 }
      }
    })
  })

  it('includes only apps with a recorded entry for the requested period -- no zero-filled padding', () => {
    const aug = Date.UTC(2026, 7, 15, 0, 0, 0)
    const sep = Date.UTC(2026, 8, 1, 0, 0, 0)
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: aug, app: 'torrent' }, // background, August only
      { kind: 'session-stop', atMs: aug + 30_000, app: 'torrent' },
      { kind: 'session-start', atMs: sep, app: 'torrent' },
      { kind: 'focus', atMs: sep, app: 'torrent' },
      { kind: 'interaction', atMs: sep },
      { kind: 'session-stop', atMs: sep + 45_000, app: 'torrent' } // active, September
    ]
    const state = fold(events)

    // meta.period is '2026-09': August's 30 backgroundSec must not leak in.
    expect(buildDisclosurePayload(state, meta).perApp).toEqual({
      torrent: { activeSec: 45, backgroundSec: 0 }
    })
  })

  it('rounds fractional seconds to the nearest whole second', () => {
    const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app: 'torrent' },
      { kind: 'focus', atMs: t0, app: 'torrent' },
      { kind: 'interaction', atMs: t0 },
      { kind: 'session-stop', atMs: t0 + 2_400, app: 'torrent' } // 2.4s exactly
    ]
    const state = fold(events)

    expect(buildDisclosurePayload(state, meta).perApp).toEqual({
      torrent: { activeSec: 2, backgroundSec: 0 }
    })
  })

  it('a fresh profile with no accounting events yet produces an empty perApp, not an error', () => {
    const state = fold([])
    expect(buildDisclosurePayload(state, meta)).toEqual({
      installId: meta.installId,
      country: meta.country,
      version: meta.version,
      period: meta.period,
      perApp: {}
    })
  })
})

describe('DISCLOSURE_OPTIONS -- exactly two, of equal weight', () => {
  it('has exactly two options', () => {
    expect(DISCLOSURE_OPTIONS).toHaveLength(2)
  })

  it('uses the ADR-0004 button copy verbatim', () => {
    expect(DISCLOSURE_OPTIONS[0].label).toBe('Keep on')
    expect(DISCLOSURE_OPTIONS[1].label).toBe('Turn off')
  })

  it('gives both options the identical field set -- no extra property (e.g. "primary") on either', () => {
    const expectedFields = ['id', 'label', 'resultingState'].sort()
    expect(Object.keys(DISCLOSURE_OPTIONS[0]).sort()).toEqual(expectedFields)
    expect(Object.keys(DISCLOSURE_OPTIONS[1]).sort()).toEqual(expectedFields)
  })

  it('leads to two different, non-overlapping outcomes', () => {
    const [a, b] = DISCLOSURE_OPTIONS
    expect(a.resultingState).not.toBe(b.resultingState)
    expect(new Set(DISCLOSURE_OPTIONS.map((option) => option.resultingState)).size).toBe(2)
  })
})

describe('undecided is a real third state, distinct from both choices', () => {
  it('is what a fresh profile starts in', () => {
    expect(initialConsentState).toBe('undecided')
  })

  it('is neither of the two decided states', () => {
    expect(initialConsentState).not.toBe('accepted')
    expect(initialConsentState).not.toBe('declined')
  })

  it('is not the resultingState of either option', () => {
    expect(DISCLOSURE_OPTIONS.some((option) => option.resultingState === initialConsentState)).toBe(false)
  })

  it('is the only state in which the disclosure screen may be shown', () => {
    expect(shouldPresentDisclosure('undecided')).toBe(true)
    expect(shouldPresentDisclosure('accepted')).toBe(false)
    expect(shouldPresentDisclosure('declined')).toBe(false)
  })
})

describe('mayTransmit -- nothing before the choice', () => {
  it('is false in the undecided state', () => {
    expect(mayTransmit('undecided')).toBe(false)
    expect(mayTransmit(initialConsentState)).toBe(false)
  })

  it('is false when the user declined', () => {
    expect(mayTransmit('declined')).toBe(false)
  })

  it('is true only once the user explicitly accepted', () => {
    expect(mayTransmit('accepted')).toBe(true)
  })
})

describe('the choice is durable and revisitable', () => {
  it('once decided, the disclosure screen never reappears -- for either outcome', () => {
    const declined = applyDisclosureChoice(DISCLOSURE_OPTIONS[1]) // 'Turn off'
    expect(shouldPresentDisclosure(declined)).toBe(false)

    const accepted = applyDisclosureChoice(DISCLOSURE_OPTIONS[0]) // 'Keep on'
    expect(shouldPresentDisclosure(accepted)).toBe(false)
  })

  it('a user who opted out can opt back in', () => {
    const declined = applyDisclosureChoice(DISCLOSURE_OPTIONS[1])
    expect(mayTransmit(declined)).toBe(false)

    const acceptedAgain = applyDisclosureChoice(DISCLOSURE_OPTIONS[0])
    expect(acceptedAgain).toBe('accepted')
    expect(mayTransmit(acceptedAgain)).toBe(true)
    expect(shouldPresentDisclosure(acceptedAgain)).toBe(false) // still no first-run screen
  })

  it('a user who opted in can opt back out, symmetrically', () => {
    const accepted = applyDisclosureChoice(DISCLOSURE_OPTIONS[0])
    expect(mayTransmit(accepted)).toBe(true)

    const declinedAgain = applyDisclosureChoice(DISCLOSURE_OPTIONS[1])
    expect(declinedAgain).toBe('declined')
    expect(mayTransmit(declinedAgain)).toBe(false)
    expect(shouldPresentDisclosure(declinedAgain)).toBe(false)
  })

  it('applyDisclosureChoice can never produce the undecided state', () => {
    for (const option of DISCLOSURE_OPTIONS) {
      expect(applyDisclosureChoice(option)).not.toBe('undecided')
    }
  })
})
