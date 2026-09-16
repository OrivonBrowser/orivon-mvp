// The full fake `Broker` double every ipc.ts-facing test suite shares --
// split out of ./ipc.test-helpers.ts once that file reached the Rule 2
// ceiling (code-guidelines.md; measured 499/500 before this split, A195's
// own brief: "measure before you add"). One concern per file now: this is
// "how to fake `Broker` itself"; ./ipc.test-helpers.ts keeps the
// PortTransport/socket/server fakes, a different concern that never touches
// this one. Re-exported from there so no existing import site needed to
// change.

import type { Broker, RawFileStat } from '../../broker-contracts.js'
import type { Grant, LookupAddress, Manifest } from '../../../contracts/index.js'
import type { FailableDirectoryHandle, FailableFileHandle, FailableTcpServer, FailableTcpSocket, FailableUdpSocket } from '../../handles/handle-contracts.js'

export interface BrokerCall { readonly method: string, readonly origin: string, readonly args: unknown }

/**
 * A full `Broker`, every method recording its call into `calls` before
 * deferring to `overrides` (or rejecting "not stubbed" if the test never
 * asked for that method to succeed). `grant`/`revoke` are unused by ipc.ts
 * -- see broker/index.ts's own doc on why they have no orivon.*
 * counterpart -- and are never expected to be called by anything ipc.ts
 * itself drives.
 *
 * `registerApp`/`versionFloorFor`/`rollbackAcknowledgedVersionFor`/
 * `acknowledgeRollback` are ALSO unreachable via orivon.* (same reason), but
 * app-install.test.ts's `installFromHint` calls all four directly as the
 * app loader's own seam into the broker -- stubbable here rather than a
 * second full fake Broker (code-guidelines.md Rule 3). `grant`/`revoke`
 * default to throwing (unchanged), but are now ALSO overridable: request-
 * grant.test.ts's `requestGrant` (../../../main/request-grant.ts) is the
 * app loader's own seam's sibling -- item 4.1's "the app loader and the
 * permission-prompt UI" this file's own doc on `Broker.grant` names as its
 * only legitimate callers.
 */
export function stubBroker (
  calls: BrokerCall[],
  overrides: Partial<{
    manifest: (origin: string) => Promise<Manifest>
    grants: (origin: string) => Promise<readonly Grant[]>
    /** SYNCHRONOUS, same reasoning as `confineSync` below -- Broker.app.isRegisteredSync has no CONTROL_CHANNEL method (it's an in-process, main-only call from tab construction), but the stub still needs to satisfy Broker's shape. */
    isRegisteredSync: (origin: string) => boolean
    connect: (origin: string, opts: { host: string, port: number }) => Promise<FailableTcpSocket>
    connectSecure: (origin: string, opts: { host: string, port: number }) => Promise<FailableTcpSocket>
    udpBind: (origin: string, opts: { port: number }) => Promise<FailableUdpSocket>
    listen: (origin: string, opts: { port: number }) => Promise<FailableTcpServer>
    lookup: (origin: string, opts: { hostname: string }) => Promise<readonly LookupAddress[]>
    readFile: (origin: string, path: string) => Promise<Uint8Array>
    writeFile: (origin: string, path: string, data: Uint8Array) => Promise<void>
    /** SYNCHRONOUS, unlike every other override here (ADR-0016's Broker.fs.confineSync) -- no test in this suite calls it via handleControlRequest, since it has no CONTROL_CHANNEL method of its own (sync-fs.ts's own channel), but the stub still needs to satisfy Broker's shape. */
    confineSync: (origin: string, path: string) => string
    mkdir: (origin: string, path: string, opts?: { recursive?: boolean }) => Promise<void>
    readdir: (origin: string, path: string) => Promise<readonly string[]>
    stat: (origin: string, path: string) => Promise<RawFileStat>
    rm: (origin: string, path: string, opts?: { recursive?: boolean }) => Promise<void>
    rename: (origin: string, from: string, to: string) => Promise<void>
    open: (origin: string, path: string, flags: string) => Promise<FailableFileHandle>
    /**
     * BOTH shapes -- the FILE-returning overload (`opts?.directory` absent
     * or false) AND the FOLDER-returning one (`{ directory: true }`,
     * A195). One override field for both, matching `Broker['fs']
     * .userSelected`'s own overloaded signature (fs-contracts.ts):
     * ./dispatch-fs.ts's directory case is no longer a before-the-broker
     * refusal, so a test exercising it needs this stub able to resolve
     * either return shape.
     */
    userSelected: (origin: string, opts?: { directory?: boolean, multiple?: boolean }) => Promise<FailableDirectoryHandle | null | readonly FailableFileHandle[]>
    idPublicKey: (origin: string, opts: { curve: string }) => Promise<Uint8Array>
    idSign: (origin: string, opts: { curve: string, payload: Uint8Array }) => Promise<Uint8Array>
    registerApp: (origin: string, manifest: Manifest) => Promise<void>
    versionFloorFor: (origin: string) => Promise<string>
    rollbackAcknowledgedVersionFor: (origin: string) => Promise<string | undefined>
    acknowledgeRollback: (origin: string, version: string) => Promise<void>
    declinedCapabilitiesFor: Broker['declinedCapabilitiesFor']
    recordDeclinedConsent: Broker['recordDeclinedConsent']
    clearDeclinedConsent: Broker['clearDeclinedConsent']
    grant: Broker['grant']
    revoke: Broker['revoke']
  }> = {}
): Broker {
  const notStubbed = async (): Promise<never> => { throw new Error('this stub method was not configured for this test') }
  return {
    app: {
      manifest: async (origin) => {
        calls.push({ method: 'app.manifest', origin, args: undefined })
        return await (overrides.manifest?.(origin) ?? notStubbed())
      },
      grants: async (origin) => {
        calls.push({ method: 'app.grants', origin, args: undefined })
        return await (overrides.grants?.(origin) ?? notStubbed())
      },
      isRegisteredSync: (origin) => {
        calls.push({ method: 'app.isRegisteredSync', origin, args: undefined })
        return overrides.isRegisteredSync?.(origin) ?? false
      },
      registeredOriginsSync: () => [],
      persistedAppsSync: () => [],
      // Present so this stub still satisfies `Broker`; no test here drives
      // it -- A158's early-hydration seam is a loader-side caller
      // (electron-serve.ts's registerServingFor), never reached via ipc.ts.
      hydrateFromPinnedManifest: async () => {},
      // Satisfies `Broker`; unused here -- `app.pickedPaths` is a
      // settings-surface call (PermissionsController), never CONTROL_CHANNEL.
      pickedPaths: async () => []
    },
    net: {
      connect: async (origin, opts) => {
        calls.push({ method: 'net.connect', origin, args: opts })
        return await (overrides.connect?.(origin, opts) ?? notStubbed())
      },
      connectSecure: async (origin, opts) => {
        calls.push({ method: 'net.connectSecure', origin, args: opts })
        return await (overrides.connectSecure?.(origin, opts) ?? notStubbed())
      },
      // Present so this stub still satisfies `Broker`; no test here drives it.
      // The udp control method is a separate change (see the PR stack).
      udpBind: async (origin, opts) => {
        calls.push({ method: 'net.udpBind', origin, args: opts })
        return await (overrides.udpBind?.(origin, opts) ?? notStubbed())
      },
      // Same story as `udpBind` above: satisfies `Broker`, unused by any IPC
      // test here -- net.listen has no control-channel wiring yet (see this
      // lane's own PR body for why that is out of scope).
      listen: async (origin, opts) => {
        calls.push({ method: 'net.listen', origin, args: opts })
        return await (overrides.listen?.(origin, opts) ?? notStubbed())
      },
      // Satisfies `Broker`; exercised by whichever suite drives net.lookup
      // through `overrides.lookup` -- unused elsewhere the same way udpBind
      // and listen were before their own control methods landed.
      lookup: async (origin, opts) => {
        calls.push({ method: 'net.lookup', origin, args: opts })
        return await (overrides.lookup?.(origin, opts) ?? notStubbed())
      }
    },
    fs: {
      readFile: async (origin, path) => {
        calls.push({ method: 'fs.readFile', origin, args: path })
        return await (overrides.readFile?.(origin, path) ?? notStubbed())
      },
      writeFile: async (origin, path, data) => {
        calls.push({ method: 'fs.writeFile', origin, args: { path, data } })
        await (overrides.writeFile?.(origin, path, data) ?? notStubbed())
      },
      confineSync: (origin, path) => {
        calls.push({ method: 'fs.confineSync', origin, args: path })
        if (overrides.confineSync !== undefined) return overrides.confineSync(origin, path)
        throw new Error('this stub method was not configured for this test')
      },
      mkdir: async (origin, path, opts) => {
        calls.push({ method: 'fs.mkdir', origin, args: { path, opts } })
        await (overrides.mkdir?.(origin, path, opts) ?? notStubbed())
      },
      readdir: async (origin, path) => {
        calls.push({ method: 'fs.readdir', origin, args: path })
        return await (overrides.readdir?.(origin, path) ?? notStubbed())
      },
      stat: async (origin, path) => {
        calls.push({ method: 'fs.stat', origin, args: path })
        return await (overrides.stat?.(origin, path) ?? notStubbed())
      },
      rm: async (origin, path, opts) => {
        calls.push({ method: 'fs.rm', origin, args: { path, opts } })
        await (overrides.rm?.(origin, path, opts) ?? notStubbed())
      },
      rename: async (origin, from, to) => {
        calls.push({ method: 'fs.rename', origin, args: { from, to } })
        await (overrides.rename?.(origin, from, to) ?? notStubbed())
      },
      open: async (origin, path, flags) => {
        calls.push({ method: 'fs.open', origin, args: { path, flags } })
        return await (overrides.open?.(origin, path, flags) ?? notStubbed())
      },
      // Cast the same way the other narrower-than-`Broker` overrides here
      // already do (see `overrides.userSelected`'s own doc above for why).
      userSelected: (async (origin: string, opts?: { directory?: boolean, multiple?: boolean }) => {
        calls.push({ method: 'fs.userSelected', origin, args: opts })
        return await (overrides.userSelected?.(origin, opts) ?? notStubbed())
      }) as Broker['fs']['userSelected']
    },
    id: {
      publicKey: async (origin, opts) => {
        calls.push({ method: 'id.publicKey', origin, args: opts })
        return await (overrides.idPublicKey?.(origin, opts) ?? notStubbed())
      },
      sign: async (origin, opts) => {
        calls.push({ method: 'id.sign', origin, args: opts })
        return await (overrides.idSign?.(origin, opts) ?? notStubbed())
      }
    },
    registerApp: async (origin, manifest) => {
      calls.push({ method: 'registerApp', origin, args: manifest })
      await (overrides.registerApp?.(origin, manifest) ?? notStubbed())
    },
    versionFloorFor: async (origin) => {
      calls.push({ method: 'versionFloorFor', origin, args: undefined })
      return await (overrides.versionFloorFor?.(origin) ?? notStubbed())
    },
    rollbackAcknowledgedVersionFor: async (origin) => {
      calls.push({ method: 'rollbackAcknowledgedVersionFor', origin, args: undefined })
      return await (overrides.rollbackAcknowledgedVersionFor?.(origin) ?? notStubbed())
    },
    acknowledgeRollback: async (origin, version) => {
      calls.push({ method: 'acknowledgeRollback', origin, args: version })
      await (overrides.acknowledgeRollback?.(origin, version) ?? notStubbed())
    },
    declinedCapabilitiesFor: async (origin) => {
      calls.push({ method: 'declinedCapabilitiesFor', origin, args: undefined })
      return await (overrides.declinedCapabilitiesFor?.(origin) ?? notStubbed())
    },
    recordDeclinedConsent: async (origin, capabilities) => {
      calls.push({ method: 'recordDeclinedConsent', origin, args: capabilities })
      await (overrides.recordDeclinedConsent?.(origin, capabilities) ?? notStubbed())
    },
    clearDeclinedConsent: async (origin) => {
      calls.push({ method: 'clearDeclinedConsent', origin, args: undefined })
      await (overrides.clearDeclinedConsent?.(origin) ?? notStubbed())
    },
    grant: async (origin, capability, patterns) => {
      calls.push({ method: 'grant', origin, args: { capability, patterns } })
      if (overrides.grant !== undefined) return await overrides.grant(origin, capability, patterns)
      throw new Error('grant is not reachable via orivon.* and this stub was not configured for a test that calls it directly')
    },
    revoke: async (origin, grantId) => {
      calls.push({ method: 'revoke', origin, args: grantId })
      if (overrides.revoke !== undefined) { await overrides.revoke(origin, grantId); return }
      throw new Error('revoke is not reachable via orivon.* and this stub was not configured for a test that calls it directly')
    },
    revokePersisted: async () => {
      throw new Error('revokePersisted is not reachable via orivon.* and this stub was not configured for a test that calls it directly')
    },
    revokeUserSelectedPath: async () => {
      throw new Error('revokeUserSelectedPath is not reachable via orivon.* and this stub was not configured for a test that calls it directly')
    }
  }
}
