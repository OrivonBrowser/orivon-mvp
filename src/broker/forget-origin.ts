// Taking an app away as if the broker had never been asked about it (`Broker.forgetOrigin`): the grants first, through
// the revoke that closes what each authorised, then the registration and the version floor. Split out of index.ts,
// which wires it.

import type { CapabilityKind, Grant } from '../contracts/index.js'
import type { GrantLedger } from './grants/grant-ledger.js'
import type { HandleTable } from './handles/handles.js'

export interface ForgetOriginDeps {
  readonly canonical: (origin: string) => string
  readonly grants: (origin: string) => Promise<readonly Grant[]>
  readonly revokePersisted: (origin: string, capability: CapabilityKind) => Promise<boolean>
  readonly handleTable: Pick<HandleTable, 'dropOrigin'>
  readonly ledger: Pick<GrantLedger, 'forgetOrigin'>
  readonly grantsChanged: { readonly emit: (origin: string) => void }
}

export function createForgetOrigin (deps: ForgetOriginDeps): (origin: string) => Promise<void> {
  return async (origin) => {
    const key = deps.canonical(origin)
    // One capability at a time: a failure stops here, before anything is forgotten.
    for (const { capability } of await deps.grants(key)) await deps.revokePersisted(key, capability)
    await deps.handleTable.dropOrigin(key)
    deps.ledger.forgetOrigin(key)
    deps.grantsChanged.emit(key)
  }
}
