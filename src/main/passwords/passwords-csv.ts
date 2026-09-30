// Passwords as CSV, the format other browsers and password managers export and import: RFC 4180 with a header
// row. A file is data from outside, so it is bounded, read without any interpretation of its cells, and every
// address is reduced to an `http(s)` origin before anything is kept. Pure.
import { originFromUrl } from '../../broker/policy/origin.js'
import { isStorableOrigin, MAX_PASSWORD, MAX_USERNAME } from './passwords-file.js'

export const MAX_CSV_ROWS = 5000
export const MAX_CSV_BYTES = 5 * 1024 * 1024

export interface CsvLogin {
  readonly origin: string
  readonly username: string
  readonly password: string
}

export type ParsedCsv =
  | { readonly ok: true, readonly logins: readonly CsvLogin[], readonly skipped: number }
  | { readonly ok: false, readonly reason: 'too-large' | 'not-passwords' }

const URL_COLUMNS = ['url', 'login_uri', 'origin', 'website', 'site', 'address']
const USERNAME_COLUMNS = ['username', 'login_username', 'login', 'user', 'user name', 'email']
const PASSWORD_COLUMNS = ['password', 'login_password']

/** Splits RFC 4180 text into rows of cells: quoted cells keep commas, line breaks and doubled quotes. */
export function parseCsvRows (text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let cellStarted = false
  const endCell = (): void => { row.push(cell); cell = ''; cellStarted = false }
  const endRow = (): void => {
    endCell()
    // A line with nothing on it is not a row.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index)
    if (quoted) {
      if (char !== '"') cell += char
      else if (source.charAt(index + 1) === '"') { cell += '"'; index += 1 } else quoted = false
    } else if (char === '"' && !cellStarted) {
      quoted = true
      cellStarted = true
    } else if (char === ',') {
      endCell()
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source.charAt(index + 1) === '\n') index += 1
      endRow()
    } else {
      cell += char
      cellStarted = true
    }
  }
  if (cell !== '' || cellStarted || row.length > 0) endRow()
  return rows
}

const columnOf = (header: readonly string[], names: readonly string[]): number => header.findIndex((cell) => names.includes(cell.trim().toLowerCase()))

/** The origin a cell's address belongs to, or null when it is not an `http(s)` address. */
export function originOfCell (cell: string): string | null {
  const origin = originFromUrl(cell.trim())
  return origin !== null && isStorableOrigin(origin) ? origin : null
}

/** Reads an export with a header naming an address, a username and a password column, in any order. A row that cannot be kept is counted as skipped. */
export function parsePasswordsCsv (text: string): ParsedCsv {
  if (text.length > MAX_CSV_BYTES) return { ok: false, reason: 'too-large' }
  const rows = parseCsvRows(text)
  const header = rows[0] ?? []
  const url = columnOf(header, URL_COLUMNS)
  const password = columnOf(header, PASSWORD_COLUMNS)
  const username = columnOf(header, USERNAME_COLUMNS)
  if (url < 0 || password < 0) return { ok: false, reason: 'not-passwords' }

  const logins: CsvLogin[] = []
  let skipped = 0
  for (const [offset, row] of rows.slice(1).entries()) {
    if (offset >= MAX_CSV_ROWS) { skipped += 1; continue }
    const origin = originOfCell(row[url] ?? '')
    const secret = row[password] ?? ''
    const name = username < 0 ? '' : row[username] ?? ''
    if (origin === null || secret === '' || secret.length > MAX_PASSWORD || name.length > MAX_USERNAME) { skipped += 1; continue }
    logins.push({ origin, username: name, password: secret })
  }
  return { ok: true, logins, skipped }
}

function quoteCell (cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
}

/** The export: `name,url,username,password,note`, the shape the other browsers read back. */
export function printPasswordsCsv (logins: readonly CsvLogin[]): string {
  const lines = ['name,url,username,password,note']
  for (const login of logins) lines.push([new URL(login.origin).hostname, login.origin, login.username, login.password, ''].map(quoteCell).join(','))
  return `${lines.join('\r\n')}\r\n`
}
