// d-0025's install-time consent (src/main/install-consent.ts), proven
// against a REAL Broker (createBroker) and the real, unmodified
// requestInstallConsent -- never a stub of either. Runs entirely in this
// test process; no Electron launch, unlike its sibling file.
//
// WHAT THIS DOES NOT PROVE, NAMED RATHER THAN LEFT IMPLICIT.
// installFromHint (src/main/app-install.ts) is the ONLY production caller
// of requestInstallConsent, and it reaches the 'installed' branch that
// calls it only after Loader.load() succeeds -- which src/loader/
// install-origin.ts's A46 (no loopback/non-https carve-out, by design) makes
// structurally impossible for any hermetic fixture. See
// e2e-app-loader-journey.test.ts's header for the identical constraint hit
// from the fetch side, and e2e-serve-from-cache.test.ts for the established
// precedent of calling a lower-level function directly for the same reason
// rather than pretending a hermetic install can go through Loader.load().
// This file calls requestInstallConsent directly, one layer below that
// same wall. It proves d-0025's own decision logic for real, against a
// real broker, with a real capability check before and after -- it does
// NOT prove that a real page's own discovery hint reaches this exact
// function over the real IPC pipe end to end; nothing in this repository
// exercises that binding today, because doing so needs a real, public
// HTTPS install origin.
//
// baseDeps()'s `dial` is a stub (okSocket(), src/broker/tests/
// index.test-helpers.ts) -- the SAME broker test harness src/main/tests/
// install-consent.test.ts already uses for its own real-broker proof of
// "once per origin, ever". So "granted, it works" below means the POLICY
// check (checkConnect, inside broker.net.connect) allows the call and a
// dial would be attempted -- not that real bytes moved over a real socket.
// That half is e2e-app-loader-journey.test.ts's assertion 2, through a
// real dial and a real echo server.
import { describe, expect, it } from 'vitest'
import { createBroker } from '../src/broker/index.js'
import { baseDeps, manifestWith } from '../src/broker/tests/index.test-helpers.js'
import { requestInstallConsent } from '../src/main/consent/install-consent.js'
import type { InstallConsentPrompt } from '../src/main/consent/install-consent.js'

const ORIGIN = 'https://install-consent-journey-e2e.orivon.test'
/** An address literal, matching test/apps/fixture's own manifest convention (its README:
 * "127.0.0.1, never localhost... as an address literal") -- unreachable from this
 * process (nothing listens there), and it never needs to be reachable: checkConnect
 * denies or allows on the pattern match alone, before deps.dial (a stub here) is ever
 * called. TEST-NET-1 (RFC 5737), never routed on a real network either way. */
const GRANTED_PATTERN = '203.0.113.10:443'
const GRANTED_TARGET = { host: '203.0.113.10', port: 443 }
/** A second TEST-NET-1 address, named nowhere in the manifest. */
const UNGRANTED_TARGET = { host: '203.0.113.11', port: 443 }

/** The exact `{code}` shape a denied broker.net.connect() rejects with (src/broker/net-capability.ts's `fail('denied', ...)`), read off the rejection rather than assumed. */
async function connectDenialCode (broker: ReturnType<typeof createBroker>, target: { host: string, port: number }): Promise<string | 'resolved'> {
  return await broker.net.connect(ORIGIN, target).then(
    () => 'resolved' as const,
    (error: unknown) => (error as { code?: unknown }).code as string
  )
}

describe('d-0025: install-time consent gates the grant, against a real Broker', () => {
  it('denied before any consent decision, still denied after a decline, granted after acceptance -- an out-of-manifest target stays denied throughout', async () => {
    const broker = createBroker(baseDeps())
    const manifest = manifestWith({ net: { tcp: { connect: [GRANTED_PATTERN] } } })
    await broker.registerApp(ORIGIN, manifest)

    expect(await connectDenialCode(broker, GRANTED_TARGET)).toBe('denied')
    expect(await broker.app.grants(ORIGIN)).toEqual([])

    const decline: InstallConsentPrompt = async () => false
    await requestInstallConsent(broker, decline, ORIGIN, manifest)
    expect(await connectDenialCode(broker, GRANTED_TARGET)).toBe('denied')
    expect(await broker.app.grants(ORIGIN)).toEqual([])

    // A145, against a real Broker: the decline just given is now REMEMBERED,
    // not just reflected in the (still-empty) grant ledger -- re-running the
    // identical, un-widened manifest must not reach the prompt a second
    // time. `wouldAccept` is wired to accept if it is ever called, so a
    // regression that stopped suppressing would show up here as a live
    // grant, not just as an extra prompt call.
    const wouldAccept: InstallConsentPrompt = async () => true
    const wouldAcceptCalls: unknown[] = []
    await requestInstallConsent(broker, async (...args) => { wouldAcceptCalls.push(args); return await wouldAccept(...args) }, ORIGIN, manifest)
    expect(wouldAcceptCalls).toHaveLength(0)
    expect(await broker.app.grants(ORIGIN)).toEqual([])

    // The person changes their mind through a real Broker seam (the same
    // one `requestInstallConsent`'s own accept branch calls internally) --
    // this test's own scope is the decision logic in front of a grant, not
    // the not-yet-built UI a real settings page would offer for this; see
    // docs/open-questions.md A145 for what that UI gap still is.
    await broker.clearDeclinedConsent(ORIGIN)

    const accept: InstallConsentPrompt = async () => true
    await requestInstallConsent(broker, accept, ORIGIN, manifest)
    const grants = await broker.app.grants(ORIGIN)
    expect(grants).toHaveLength(1)
    expect(grants[0]?.patterns).toEqual([GRANTED_PATTERN])

    // "It works": the real policy check (checkConnect, inside broker.net.
    // connect) now allows this exact granted target -- the promise resolves
    // rather than rejecting. See this file's header for what this does and
    // does not prove about the dial itself.
    const afterAccept = await broker.net.connect(ORIGIN, GRANTED_TARGET)
    expect(afterAccept.remoteAddress).toBeDefined()

    expect(await connectDenialCode(broker, UNGRANTED_TARGET)).toBe('denied')
  })
})
