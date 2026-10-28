// The light client's part of the host's config, built each time the host starts: the servers it asks (Orivon's or the
// person's), the checkpoint it starts from, and why there is no light client when there can not be. No `electron` import.

import type { HostConfig } from '../../protocols/verifier-host/protocol.js'
import type { CheckpointChoice } from './checkpoint.js'
import type { FetchProblem } from './checkpoint-fetch.js'
import { ethServersLine } from './eth-servers.js'
import type { EthServers } from './eth-servers.js'
import { checkpointProblem } from './status-view.js'

export interface LightClientConfigDeps {
  readonly switchedOff: boolean
  /** The renewal of the checkpoint under way, if one: the choice is made after it ends. */
  readonly renewing: Promise<void> | undefined
  readonly renewal: { readonly chooseForStart: () => CheckpointChoice, readonly problem: () => FetchProblem | undefined }
  readonly servers: EthServers
}

export async function lightClientConfig (deps: LightClientConfigDeps): Promise<Pick<HostConfig, 'lightClient' | 'lightClientOff'>> {
  if (deps.switchedOff) return { lightClient: undefined, lightClientOff: 'the Ethereum light client is switched off, so no .eth name can be verified' }
  const { servers } = deps
  // The one line the log gets about the person's servers each time the host starts; the address is masked.
  const line = ethServersLine(servers)
  if (line !== undefined) console.log(`[verifier] ${line}`)
  await deps.renewing
  const choice = deps.renewal.chooseForStart()
  if (!choice.ok) return { lightClient: undefined, lightClientOff: `the Ethereum light client cannot start: ${checkpointProblem(choice, deps.renewal.problem(), servers.own.consensus)}` }
  return {
    lightClient: {
      executionRpcs: servers.executionRpcs,
      consensusRpc: servers.consensusRpc,
      checkpoint: choice.checkpoint.root,
      ...(servers.localEndpoints.length > 0 && { localEndpoints: servers.localEndpoints }),
      ...(servers.own.execution || servers.own.consensus ? { ownServers: servers.own } : {})
    }
  }
}
