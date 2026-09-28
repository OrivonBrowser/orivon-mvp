// The protocols built into this build, as the shell sees them: descriptors
// only, so nothing here loads a protocol's code into the main process. Their
// providers are wired into the verifier host in verifier-host/protocols.ts.

import { ProtocolAddresses } from './address.js'
import { ENS } from './ens/descriptor.js'
import { IPFS } from './ipfs/descriptor.js'
import type { ProtocolDescriptor } from './protocol.js'

export const BUILTIN_PROTOCOLS: readonly ProtocolDescriptor[] = [ENS, IPFS]

export const BUILTIN_ADDRESSES = new ProtocolAddresses(BUILTIN_PROTOCOLS)
