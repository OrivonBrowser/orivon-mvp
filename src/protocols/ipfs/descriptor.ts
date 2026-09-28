import { describeProtocol } from '../protocol.js'

/** `ipfs://<cid>` and `ipns://<key or DNSLink name>`. */
export const IPFS = describeProtocol({ id: 'ipfs', schemes: ['ipfs', 'ipns'], topLevelDomains: [] })
