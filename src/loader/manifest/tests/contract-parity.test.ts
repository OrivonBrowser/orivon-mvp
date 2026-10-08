import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest.js'
import type {
  Capabilities,
  EmbedCapability,
  FsCapability,
  HttpsCapability,
  IdCapability,
  Manifest,
  MediaCapability,
  NetCapability,
  TcpCapability,
  UdpCapability,
  TrustCapability,
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
  // 'clipboard' (ADR-0032) has no app door and 'secrets' (ADR-0033) has no
  // fields, so a kitchen-sink manifest naming them would fail the round-trip
  // or prove nothing. 'devices' (ADR-0068) has no loader parser yet.
  readonly capabilities: Omit<Full<Capabilities>, 'net' | 'fs' | 'id' | 'web' | 'media' | 'clipboard' | 'secrets' | 'trust' | 'devices'> & {
    readonly media: Full<MediaCapability>
    readonly trust: Full<TrustCapability>
    readonly net: Omit<Full<NetCapability>, 'tcp' | 'udp' | 'https'> & {
      readonly tcp: Full<TcpCapability>
      readonly udp: Full<UdpCapability>
      readonly https: Full<HttpsCapability>
    }
    readonly fs: Full<FsCapability>
    readonly id: Full<IdCapability>
    readonly web: Omit<Full<WebCapability>, 'embed'> & { readonly embed: Full<EmbedCapability> }
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
  crossOriginIsolated: true,
  domain: 'kitchen-sink.example.com',
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
    web: { contexts: ['https://kitchen-sink.example'], embed: { origins: ['*'] } },
    media: { camera: true, microphone: true, screen: true },
    trust: { score: true }
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
