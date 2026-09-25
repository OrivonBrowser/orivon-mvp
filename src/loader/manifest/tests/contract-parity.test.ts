import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest.js'
import type {
  Capabilities,
  FsCapability,
  HttpsCapability,
  IdCapability,
  Manifest,
  NetCapability,
  TcpCapability,
  UdpCapability,
  WebCapability
} from '../../../contracts/index.js'

// docs/open-questions.md A164: a manifest field the contract allows and the
// loader's own hand-maintained allowlist silently refuses. A field-by-field
// regression test (manifest/tests/consent-granularity.test.ts, the A164 suite in
// manifest/tests/capabilities.test.ts) only proves the field known when it was
// written stays accepted -- it says nothing about the NEXT one. This file
// instead types ONE manifest to require every field every relevant contract
// interface has, at every level, via `Required<T>`: adding a field to any
// of them without updating KITCHEN_SINK below is a TYPE ERROR under
// `npm run typecheck`, not a silent gap. That manifest is then run through
// the real parser -- the same one fetch/bundle.ts and serve.ts call -- so a
// rejection here is the actual failure mode, not a description of it.
// scripts/check-manifest-parity.mjs is the complementary, always-on CI
// guard; this file is the belt to that check's suspenders (or the reverse).

type Full<T> = Required<T>

type FullManifest = Omit<Full<Manifest>, 'capabilities'> & {
  // ADR-0032/ADR-0033: 'media', 'clipboard' and 'secrets' excluded with the
  // same deferred reasoning 'web' carried in the contracts-only PR that
  // added it -- the real parser does not accept any of the three yet
  // either (their PARITY_MAP loader arrays do not exist until the stacked
  // implementation PR), so a kitchen-sink manifest naming them would fail
  // the round-trip this file exists to prove.
  readonly capabilities: Omit<Full<Capabilities>, 'net' | 'fs' | 'id' | 'web' | 'media' | 'clipboard' | 'secrets'> & {
    readonly net: Omit<Full<NetCapability>, 'tcp' | 'udp' | 'https'> & {
      readonly tcp: Full<TcpCapability>
      readonly udp: Full<UdpCapability>
      readonly https: Full<HttpsCapability>
    }
    readonly fs: Full<FsCapability>
    readonly id: Full<IdCapability>
    readonly web: Full<WebCapability>
  }
}

/**
 * Every field every relevant contract interface currently declares, filled
 * with a value the real parser accepts -- chosen to match this codebase's
 * own conventions elsewhere (`"*:*"`, a >=1024 port range, `secp256k1`),
 * never a value invented just to satisfy the type.
 */
const KITCHEN_SINK: FullManifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.kitchen-sink',
  name: 'Kitchen Sink Test App',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['style.css', 'script.js'],
  consentGranularity: 'per-capability',
  capabilities: {
    protocols: ['magnet'],
    net: {
      concurrentSockets: 64,
      tcp: { connect: ['*:*'], listen: { network: ['1024-65535'] } },
      udp: { bind: { network: ['1024-65535'] }, send: ['*:*'] },
      https: { connect: ['*:*'] }
    },
    fs: { quotaBytes: 104857600 },
    id: { curves: ['secp256k1'] },
    web: { contexts: ['https://kitchen-sink.example'] }
  }
}

describe('a manifest declaring every field the contract currently allows (A164, contract/loader parity)', () => {
  it('is accepted by the real parser, with no field rejected or ignored as unrecognised', () => {
    const result = parseManifest(JSON.stringify(KITCHEN_SINK))
    if (!result.ok) throw new Error(`expected every declared field to be accepted, got: ${result.reason}`)
    expect(result.ignoredFields).toEqual([])
  })

  it('round-trips every declared field back unchanged', () => {
    const result = parseManifest(JSON.stringify(KITCHEN_SINK))
    if (!result.ok) throw new Error(result.reason)
    expect(result.manifest).toEqual(KITCHEN_SINK)
  })
})
