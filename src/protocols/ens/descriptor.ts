import { describeProtocol } from '../protocol.js'

// A name is shown as an ipfs:// address whatever network its content is on. Its loading screen names no network,
// because it shows before the name has been looked up.
/** `.eth` names, each its own origin: `https://<name>.eth`. */
export const ENS = describeProtocol({
  id: 'ens',
  schemes: [],
  topLevelDomains: ['eth'],
  displayScheme: 'ipfs',
  loadingScreen: { title: 'Loading', detail: 'Every answer is checked against what it is named by before it is shown.' }
})
