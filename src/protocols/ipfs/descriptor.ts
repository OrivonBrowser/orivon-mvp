import { describeProtocol } from '../protocol.js'

/** `ipfs://<cid>` and `ipns://<key or DNSLink name>`. */
export const IPFS = describeProtocol({
  id: 'ipfs',
  schemes: ['ipfs', 'ipns'],
  topLevelDomains: [],
  loadingScreen: { title: 'Loading from IPFS', detail: 'Every block is checked against its content address before it is shown.' }
})
