import { describeProtocol } from '../protocol.js'

// In this build every name the verifier loads is IPFS content, so it is shown as an ipfs:// address.
/** `.eth` names, each its own origin: `https://<name>.eth`. */
export const ENS = describeProtocol({ id: 'ens', schemes: [], topLevelDomains: ['eth'], displayScheme: 'ipfs' })
