import { describeProtocol } from '../protocol.js'

/** `.eth` names, each its own origin: `https://<name>.eth`. */
export const ENS = describeProtocol({ id: 'ens', schemes: [], topLevelDomains: ['eth'] })
