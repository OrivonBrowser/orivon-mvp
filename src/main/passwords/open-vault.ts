// Chooses the saved-login store for this run. A private window keeps nothing at all, so it never opens the file;
// any other run gets the encrypted store, which decides for itself whether the system keyring is real.
import type { SafeStorageLike } from '../keyring/seed-store.js'
import { EncryptedVault } from './encrypted-vault.js'
import { memoryVault } from './vault.js'
import type { PasswordVault } from './vault.js'

export interface OpenVaultInput {
  readonly path: string
  readonly isPrivate: boolean
  readonly storage: SafeStorageLike
}

export function openVault (input: OpenVaultInput): PasswordVault {
  if (input.isPrivate) return { ...memoryVault('private'), ready: async () => { await Promise.resolve() } }
  const vault = new EncryptedVault({ path: input.path, storage: input.storage })
  // The system is asked at once, so `state()` is final by the time a page or a prompt looks at it.
  void vault.ready()
  return vault
}
