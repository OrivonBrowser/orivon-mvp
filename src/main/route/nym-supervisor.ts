// Keeps the Nym tunnel host's utility process running (verifier/process-supervisor.ts). The host only reports.

import { ProcessSupervisor } from '../verifier/process-supervisor.js'
import type { ProcessDeps, ProcessEvents } from '../verifier/process-supervisor.js'
import type { FailureStage, FromHost, NymTunnelConfig } from '../../protocols/nym-tunnel/protocol.js'
import { NYM_TUNNEL_IDENTITY } from '../../protocols/nym-tunnel/protocol.js'
import { isFromHost } from './nym-messages.js'

/** The stages after which a restart would fail the same way: the host stays down until it is asked for again. */
const UNRECOVERABLE: ReadonlySet<FailureStage> = new Set(['artifact', 'load', 'listen'])

export interface NymEvents extends ProcessEvents {
  failed?: (stage: FailureStage) => void
  listening: () => void
  instances: (connecting: number, ready: number, started: number, problem: string | undefined) => void
}

export type NymSupervisorDeps = ProcessDeps<NymTunnelConfig, NymEvents>

export class NymSupervisor extends ProcessSupervisor<NymTunnelConfig, FromHost, NymEvents> {
  constructor (deps: NymSupervisorDeps) {
    super(deps, { noun: NYM_TUNNEL_IDENTITY.noun, log: `[${NYM_TUNNEL_IDENTITY.name}]` })
  }

  protected accepts (message: unknown): message is FromHost {
    return isFromHost(message)
  }

  protected receive (message: FromHost): void {
    const { events } = this.deps
    switch (message.type) {
      case 'listening': events.listening(); break
      case 'instances': events.instances(message.connecting, message.ready, message.started, message.problem); break
      case 'failed':
        events.failed?.(message.stage)
        this.fail(`the ${NYM_TUNNEL_IDENTITY.noun} could not run (${message.stage}): ${message.message}`, !UNRECOVERABLE.has(message.stage))
        break
    }
  }
}
