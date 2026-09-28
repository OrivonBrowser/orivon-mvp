// safeStorage (ADR-0033) -- the one member of this package backed by a
// capability that did not exist until orivon.secrets. Real Electron's
// safeStorage is a MAIN-process module; a ported app's original main-
// process code reaches it the same way its renderer code reaches anything
// else here, because ADR-0005 dissolved the app backend -- all app code runs
// in the renderer under this shim.
//
// ONLY THE ASYNC TRIO IS BACKED. orivon.secrets is async-only by
// construction (capability-api.ts's design rule 2: network -- and this
// crosses the same IPC boundary -- is async, full stop), so the SYNC trio
// cannot be honestly implemented without blocking the renderer the way
// fs.readFileSync's own narrow ADR-0016 exception is -- and unlike that
// exception, nothing here forces a ported app's startup path through a
// synchronous call. `isEncryptionAvailable()` (sync) answers `false`
// unconditionally, which is exactly the signal a ported app's own
// documented fallback (Element Desktop's non-keyring path, AirGap Vault's
// mock) already checks for -- see this package's README for the recon this
// answer is based on.

import { refuse } from './errors.js'
import { notConsidered, refusingProxy } from './unimplemented.js'
import type { Orivon } from '../contracts/capability-api.js'

export interface DecryptStringAsyncReturnValue {
  readonly shouldReEncrypt: boolean
  readonly result: string
}

export interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<DecryptStringAsyncReturnValue>
}

const UTF8_ENCODER = new TextEncoder()
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

/**
 * `orivon` is `Pick<Orivon, 'secrets'>`, matching `createDialog`'s own
 * narrowed-dependency shape (this file's sibling) -- a factory takes only
 * the slice of `Orivon` it actually reads.
 */
export function createSafeStorage (orivon: Pick<Orivon, 'secrets'>): ElectronSafeStorage {
  const known: ElectronSafeStorage = {
    // Unconditionally false: this shim never blocks the renderer to answer
    // a real one, and Electron's own contract for this method is
    // synchronous. See this file's header for why that is the honest
    // answer, not a placeholder for a later fix.
    isEncryptionAvailable () {
      return false
    },
    encryptString () {
      throw refuse('safeStorage.encryptString', 'not-built',
        'safeStorage.encryptString is synchronous; orivon.secrets is async-only ' +
        '(capability-api.ts design rule 2). Use encryptStringAsync.')
    },
    decryptString () {
      throw refuse('safeStorage.decryptString', 'not-built',
        'safeStorage.decryptString is synchronous; orivon.secrets is async-only ' +
        '(capability-api.ts design rule 2). Use decryptStringAsync.')
    },
    async isAsyncEncryptionAvailable () {
      return await orivon.secrets.available()
    },
    async encryptStringAsync (plainText) {
      const ciphertext = await orivon.secrets.encrypt(UTF8_ENCODER.encode(plainText))
      return Buffer.from(ciphertext)
    },
    async decryptStringAsync (encrypted) {
      const plaintext = await orivon.secrets.decrypt(new Uint8Array(encrypted))
      let result: string
      try {
        result = UTF8_DECODER.decode(plaintext)
      } catch {
        throw refuse('safeStorage.decryptStringAsync', 'not-built',
          'the decrypted bytes are not valid UTF-8 text -- safeStorage.decryptString(Async) is ' +
          'string-only; a ciphertext that started as arbitrary bytes was never encrypted through ' +
          'this method to begin with.')
      }
      // orivon.secrets carries no key-rotation signal of its own (ADR-0033):
      // the broker re-derives the same key from the same seed every call,
      // so there is nothing here that would ever ask for a re-encrypt.
      return { shouldReEncrypt: false, result }
    }
  }
  return refusingProxy(known, (prop) => notConsidered(`safeStorage.${prop}`))
}
