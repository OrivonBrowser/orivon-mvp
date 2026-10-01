// What the Settings page may ask of the saved logins: the list (never with a password), showing or copying one
// password, removing a login or a never-saved site, a generated password, and moving passwords in or out as CSV.
// A request is data from a document, so every field is checked. A password crosses to the page only for
// `reveal`; `copy` puts it on the clipboard from here. Pure over the services it is handed; ./passwords-runner.ts
// builds them from Electron.
import type { InternalCaller, InternalDomain } from '../pages/internal-ipc.js'
import { generatePassword } from './generate-password.js'
import { MAX_CSV_BYTES, parsePasswordsCsv, printPasswordsCsv } from './passwords-csv.js'
import { isStorableOrigin } from './passwords-file.js'
import { exportLogins, importLogins } from './passwords-transfer.js'
import type { ImportCounts } from './passwords-transfer.js'
import type { SecretClipboard } from './secret-clipboard.js'
import type { Login, PasswordVault, VaultState } from './vault.js'

export const GENERATED_LENGTH = 20
export const REVEAL_HIDE_MS = 30_000
export const EXPORT_NAME = 'orivon-passwords.csv'
const MAX_ID = 64

export type ReadResult = { readonly ok: true, readonly text: string } | { readonly ok: false, readonly reason: 'too-large' | 'unreadable' }

export interface PasswordsHost {
  readonly vault: PasswordVault
  readonly clipboard: SecretClipboard
  /** How long a shown password stays up before the page hides it again. */
  readonly revealHideMs: number
  /** The CSV the person picks, or undefined on cancel. */
  pickImport: (caller: InternalCaller) => Promise<string | undefined>
  /** Where the person wants the export, or undefined on cancel. */
  pickExport: (caller: InternalCaller, defaultName: string) => Promise<string | undefined>
  readFile: (path: string, maxBytes: number) => Promise<ReadResult>
  /** Writes the file readable by its owner alone; false when it could not. */
  writeFile: (path: string, text: string) => Promise<boolean>
}

export interface PasswordsList {
  readonly state: VaultState
  readonly logins: readonly Login[]
  readonly never: readonly string[]
  readonly hideMs: number
}

export type TransferOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed', readonly reason: 'unavailable' | 'too-large' | 'unreadable' | 'not-passwords' | 'not-written' }
  | ({ readonly kind: 'imported' } & ImportCounts)
  | { readonly kind: 'exported', readonly count: number }

interface Request {
  readonly type?: unknown
  readonly id?: unknown
  readonly origin?: unknown
  readonly confirm?: unknown
}

const validId = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= MAX_ID

export function passwordsDomain (host: PasswordsHost): InternalDomain {
  const { vault } = host
  const ready = async (): Promise<void> => { await vault.ready?.() }
  /** The last password made for the page, so it can be copied without the page ever sending one back. */
  let generated: string | undefined

  async function importFile (caller: InternalCaller): Promise<TransferOutcome> {
    if (vault.state() !== 'ready') return { kind: 'failed', reason: 'unavailable' }
    const path = await host.pickImport(caller)
    if (path === undefined) return { kind: 'cancelled' }
    const read = await host.readFile(path, MAX_CSV_BYTES)
    if (!read.ok) return { kind: 'failed', reason: read.reason }
    const parsed = parsePasswordsCsv(read.text)
    if (!parsed.ok) return { kind: 'failed', reason: parsed.reason }
    return { kind: 'imported', ...await importLogins(vault, parsed.logins, parsed.skipped) }
  }

  async function exportFile (caller: InternalCaller): Promise<TransferOutcome> {
    if (vault.state() !== 'ready') return { kind: 'failed', reason: 'unavailable' }
    const path = await host.pickExport(caller, EXPORT_NAME)
    if (path === undefined) return { kind: 'cancelled' }
    const rows = await exportLogins(vault)
    return await host.writeFile(path, printPasswordsCsv(rows)) ? { kind: 'exported', count: rows.length } : { kind: 'failed', reason: 'not-written' }
  }

  return {
    pages: ['settings'],
    handle: async (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as Request
      await ready()
      switch (request.type) {
        case 'list': {
          const list: PasswordsList = { state: vault.state(), logins: vault.list(), never: vault.never.list(), hideMs: host.revealHideMs }
          return list
        }
        case 'reveal': {
          if (!validId(request.id)) return undefined
          const password = await vault.reveal(request.id)
          return password === undefined ? undefined : { password }
        }
        case 'copy': {
          if (!validId(request.id)) return undefined
          const password = await vault.reveal(request.id)
          if (password === undefined) return { ok: false }
          return { ok: await host.clipboard.copy(password) }
        }
        case 'remove':
          return validId(request.id) ? { ok: await vault.remove(request.id) } : undefined
        case 'neverRemove':
          if (!isStorableOrigin(request.origin)) return undefined
          vault.never.remove(request.origin)
          return { ok: true }
        case 'generate':
          generated = generatePassword(GENERATED_LENGTH)
          return { password: generated }
        case 'copyGenerated':
          if (generated === undefined) return { ok: false }
          return { ok: await host.clipboard.copy(generated) }
        case 'import':
          return await importFile(caller)
        case 'export':
          // The page asks the person first; a request that does not say they did is refused.
          return request.confirm === true ? await exportFile(caller) : undefined
        default:
          return undefined
      }
    }
  }
}
