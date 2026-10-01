// Moving passwords in and out as CSV: what an import did to the store, and the rows an export holds. Pure over
// the vault interface; the dialogs and the file are the domain's.
import { loginKey } from './passwords-file.js'
import type { CsvLogin } from './passwords-csv.js'
import type { PasswordVault } from './vault.js'

export interface ImportCounts {
  /** Logins that were not there before. */
  readonly added: number
  /** Logins that were there with another password. */
  readonly updated: number
  /** Logins that were there already, with this password. */
  readonly unchanged: number
  /** Rows the file held that could not be kept: unusable rows, and those that did not fit. */
  readonly skipped: number
}

const BATCH = 25

/** Saves each login, the later of two rows for one origin and username winning. A login that already holds this password is left alone. */
export async function importLogins (vault: PasswordVault, rows: readonly CsvLogin[], skippedByParser: number): Promise<ImportCounts> {
  const latest = new Map<string, CsvLogin>()
  for (const row of rows) latest.set(loginKey(row.origin, row.username), row)
  let added = 0
  let updated = 0
  let unchanged = 0
  let skipped = skippedByParser + (rows.length - latest.size)
  const pending = [...latest.values()]
  for (let start = 0; start < pending.length; start += BATCH) {
    await Promise.all(pending.slice(start, start + BATCH).map(async (row) => {
      const existing = vault.list(row.origin).find((login) => login.username === row.username)
      if (existing !== undefined && await vault.reveal(existing.id) === row.password) { unchanged += 1; return }
      if (await vault.save(row) === null) skipped += 1
      else if (existing === undefined) added += 1
      else updated += 1
    }))
  }
  return { added, updated, unchanged, skipped }
}

/** Every login with its password, by site then username; logins whose password cannot be read are left out. */
export async function exportLogins (vault: PasswordVault): Promise<CsvLogin[]> {
  const out: CsvLogin[] = []
  const logins = [...vault.list()].sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
  for (const login of logins) {
    const password = await vault.reveal(login.id)
    if (password !== undefined) out.push({ origin: login.origin, username: login.username, password })
  }
  return out
}
