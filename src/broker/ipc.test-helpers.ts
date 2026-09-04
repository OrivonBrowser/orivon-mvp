// Shared fixtures for ipc.test.ts and ipc-rate-limit.test.ts -- both test
// handleControlRequest against the same Broker/ControlEvent/RequestEnvelope
// shapes (code-guidelines.md Rule 3: the reason for reuse is that both
// files exercise the same function, not a stylistic preference).

import { vi } from 'vitest'
import type { ControlEvent } from './ipc.js'
import type { Broker } from './broker-contracts.js'
import type { Grant, Manifest } from '../contracts/index.js'
import type { FailableTcpSocket } from './handle-contracts.js'
import type { RequestEnvelope } from '../contracts/ipc.js'

export const APP = 'https://app.example'
export const OTHER = 'https://other.example'

/** A ControlEvent whose senderFrame resolves to `origin` via originFromSenderFrame. */
export function frameFor (origin: string): ControlEvent {
  return { senderFrame: { url: `${origin}/index.html`, origin, postMessage: vi.fn() } }
}

export const NO_FRAME: ControlEvent = { senderFrame: null }

export function envelope (method: string, payload: unknown, timeoutMs = 1_000): RequestEnvelope<unknown> {
  return { id: 'req-1', method, payload, timeoutMs }
}

/** A promise that never settles -- models a broker call still in flight when a timeout fires. */
export function never<T> (): Promise<T> {
  return new Promise<T>(() => {})
}

export interface BrokerCall { readonly method: string, readonly origin: string, readonly args: unknown }

/**
 * A full `Broker`, every method recording its call into `calls` before
 * deferring to `overrides` (or rejecting "not stubbed" if the test never
 * asked for that method to succeed). `registerApp`/`grant`/`revoke` are
 * unused by ipc.ts -- see broker/index.ts's own doc on why they have no
 * orivon.* counterpart -- and are never expected to be called here.
 */
export function stubBroker (
  calls: BrokerCall[],
  overrides: Partial<{
    manifest: (origin: string) => Promise<Manifest>
    grants: (origin: string) => Promise<readonly Grant[]>
    connect: (origin: string, opts: { host: string, port: number }) => Promise<FailableTcpSocket>
    readFile: (origin: string, path: string) => Promise<Uint8Array>
    writeFile: (origin: string, path: string, data: Uint8Array) => Promise<void>
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
      }
    },
    net: {
      connect: async (origin, opts) => {
        calls.push({ method: 'net.connect', origin, args: opts })
        return await (overrides.connect?.(origin, opts) ?? notStubbed())
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
      }
    },
    registerApp: () => { throw new Error('registerApp is not reachable via orivon.* and should never be called here') },
    versionFloorFor: () => { throw new Error('versionFloorFor is not reachable via orivon.* and should never be called here') },
    grant: () => { throw new Error('grant is not reachable via orivon.* and should never be called here') },
    revoke: async () => { throw new Error('revoke is not reachable via orivon.* and should never be called here') }
  }
}
