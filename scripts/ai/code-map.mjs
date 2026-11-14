// A map from "I need to change X" to the directory that holds X. It lists every directory under `src/`, `test/`,
// `scripts/` and `vendor/` with a one-line purpose, read from the tree on every run so it cannot go stale, and
// is never committed. `tests/`, `__tests__`, `generated`, `node_modules` and dot directories are left out, and
// `test/`, `scripts/` and `vendor/` list one level only (they hold fixtures, tools and upstream trees).
//
//   node scripts/ai/code-map.mjs                  the whole map
//   node scripts/ai/code-map.mjs wallet signing   the directories that hold every word, with their parents
//   node scripts/ai/code-map.mjs --depth 2        two levels below each root
//
// A directory's purpose is the first of: its README title (without markdown or the path it opens with; a title
// that is only a path gives the first sentence below it); the first sentence of the leading comment of its
// `index`, `main`, `page` or `<name>` source file; the row of its parent's README table that names it; then
// `(no README)`. A word matches where a word of the path, the purpose or a file name directly inside starts, in
// any case, so `protocol` finds `protocols` and `ens` finds the ENS directory but not every `extensions`; `e2e`
// also reads as `end-to-end`. A line that matched only through file names ends with the files that did.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from '../cli.mjs'

/**
 * The roots the map starts from, each with how many levels below it are listed: where a change is made, and where
 * its test, its script and the third-party code it patches live. Below `test/`, `scripts/` and `vendor/` the
 * directories are fixtures and upstream trees, not places a change is looked for.
 */
export const ROOTS = { src: Infinity, test: 1, scripts: 1, vendor: 1 }

/** Directories the map never lists: unit tests, generated output and installed packages. */
const SKIPPED = new Set(['tests', '__tests__', 'generated', 'node_modules'])

/** What a directory shows when nothing says what it is: no README, no main file with a comment, no row in its parent's. */
export const NO_README = '(no README)'

/** Words an agent types that the tree spells another way. */
const SYNONYMS = new Map([['e2e', ['end-to-end']]])

/** A purpose longer than this is cut at a word, so one line stays one line. */
export const MAX_PURPOSE = 100

const MAIN_STEMS = ['index', 'main', 'page']
const MAIN_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js']

/** A backticked path or a slashed path at the start of a title, and the separator after it. */
const LEADING_PATH = /^(?:`[^`]*\/[^`]*`|[\w.@~-]+(?:\/[\w.@~-]+)+\/?)(?:\s*[:\u2014\u2013-]+\s*|\s*$)/

/** The label many READMEs open their first paragraph with; the purpose is what follows it. */
const WHAT_LIVES_HERE = /^\*\*What lives here\.?\*\*:?\s*/i

/** A comment line that configures a tool and says nothing about the code. */
const DIRECTIVE = /^(?:@ts-|eslint|prettier|istanbul|c8\b|test:changed|<reference)/

/** A sentence ends at a full stop before a capital or the end, so "e.g. the" and "v1.2" do not end one. */
const FIRST_SENTENCE = /^[\s\S]*?[.!?](?=\s+[A-Z"'`(]|\s*$)/

/** Markdown reduced to the words it shows: links, code spans and emphasis lose their marks. */
function plainText (text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(`[^`]*`)/)
    .map((part, index) => index % 2 === 1
      ? part.slice(1, -1)
      : part.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1'))
    .join('')
}

/** Typographic marks as their plain spellings and accents dropped, so the map stays ASCII whatever a title holds. */
const asciiOnly = (text) => text
  .replace(/[\u2014\u2013]/g, '-')
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201C\u201D]/g, '"')
  .replace(/\u2026/g, '...')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\x20-\x7e]/g, '?')

/** One tidy line no longer than MAX_PURPOSE, or null for nothing. */
function oneLine (text) {
  const line = asciiOnly(text).replace(/\s+/g, ' ').trim()
  if (line === '') return null
  if (line.length <= MAX_PURPOSE) return line
  const cut = line.slice(0, MAX_PURPOSE - 3)
  const space = cut.lastIndexOf(' ')
  return `${(space > MAX_PURPOSE / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}...`
}

/** The first sentence of a text, markdown removed. */
function firstSentence (text) {
  const plain = plainText(text).replace(/\s+/g, ' ').trim()
  return oneLine(FIRST_SENTENCE.exec(plain)?.[0] ?? plain)
}

/**
 * The purpose a README gives: its first heading outside a code fence, without its markdown and without the path it
 * opens with. A heading that is only a path (`# \`scripts/ci/\``) gives way to the first sentence of the first
 * paragraph below it. Null when the README has neither.
 * @param {string} markdown
 * @returns {string | null}
 */
export function readmePurpose (markdown) {
  let fenced = false
  let titled = false
  const paragraph = []
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (fenced) continue
    if (/^#{1,6}\s/.test(line)) {
      if (titled) break
      titled = true
      const title = oneLine(plainText(line.replace(/^#{1,6}\s+/, '').trim().replace(LEADING_PATH, '')))
      if (title !== null) return title
    } else if (titled && /^[A-Za-z*`[]/.test(line.trim())) {
      paragraph.push(line.trim())
    } else if (paragraph.length > 0) {
      break
    }
  }
  return paragraph.length > 0 ? firstSentence(paragraph.join(' ').replace(WHAT_LIVES_HERE, '')) : null
}

/**
 * The first sentence of the comment a source file opens with, `//` lines or a block, past a shebang and tool
 * directives. Null when the file opens with code, or with a licence.
 * @param {string} source
 * @returns {string | null}
 */
export function commentPurpose (source) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.startsWith('#!') === true) lines.shift()
  const rest = lines.join('\n').trimStart()
  let body
  if (rest.startsWith('/*')) {
    const block = /^\/\*+([\s\S]*?)\*\//.exec(rest)
    if (block === null) return null
    body = block[1].split('\n').map((line) => line.replace(/^\s*\*+ ?/, ''))
  } else if (rest.startsWith('//')) {
    body = []
    for (const line of rest.split('\n')) {
      if (!line.trimStart().startsWith('//')) break
      body.push(line.trimStart().replace(/^\/+ ?/, ''))
    }
  } else {
    return null
  }
  const paragraph = []
  for (const line of body.map((text) => text.trim()).filter((text) => !DIRECTIVE.test(text))) {
    if (line === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (line.startsWith('@') && paragraph.length === 0) break
    paragraph.push(line)
  }
  const text = paragraph.join(' ')
  return /^(?:copyright|licen[cs]e|spdx)/i.test(text) ? null : firstSentence(text)
}

/**
 * What a table in a README says about a directory it lists: the second cell of the row whose first cell is the
 * directory's name, with or without a link, backticks or a trailing slash. Null when no row names it.
 * @param {string} markdown
 * @param {string} name
 * @returns {string | null}
 */
export function tableRowPurpose (markdown, name) {
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => plainText(cell.trim()))
    if (cells.length >= 2 && cells[0].replace(/\/$/, '') === name) return firstSentence(cells[1])
  }
  return null
}

/**
 * What a directory is for: its README, else the comment its main file opens with, else the row its parent's README
 * gives it. Null when none says.
 */
function purposeOf (root, path, files) {
  const dir = join(root, path)
  const read = (name) => files.has(name) ? readFileSync(join(dir, name), 'utf8') : null
  const base = path.slice(path.lastIndexOf('/') + 1)
  const readme = read('README.md')
  const fromReadme = readme === null ? null : readmePurpose(readme)
  if (fromReadme !== null) return fromReadme
  for (const stem of new Set([...MAIN_STEMS, base])) {
    for (const extension of MAIN_EXTENSIONS) {
      const source = read(`${stem}${extension}`)
      const fromSource = source === null ? null : commentPurpose(source)
      if (fromSource !== null) return fromSource
    }
  }
  const slash = path.lastIndexOf('/')
  if (slash === -1) return null
  try {
    return tableRowPurpose(readFileSync(join(root, path.slice(0, slash), 'README.md'), 'utf8'), base)
  } catch {
    return null
  }
}

/**
 * Every directory under each root, parents before children, siblings in name order.
 * @param {string} root The repository root.
 * @param {{ roots?: Record<string, number>, depth?: number }} [options] `roots` maps each root to the levels listed
 *   below it; `depth` caps all of them. A root is level 0.
 * @returns {Array<{ path: string, depth: number, purpose: string | null, files: string[] }>} `path` is root-relative,
 *   forward-slashed; `files` are the names directly inside it, except its README.
 */
export function buildMap (root, { roots = ROOTS, depth = Infinity } = {}) {
  const entries = []
  const visit = (path, level, limit) => {
    let listing
    try {
      listing = readdirSync(join(root, path), { withFileTypes: true })
    } catch {
      return
    }
    const files = new Set(listing.filter((entry) => entry.isFile()).map((entry) => entry.name))
    const names = [...files].filter((name) => name !== 'README.md').sort()
    entries.push({ path, depth: level, purpose: purposeOf(root, path, files), files: names })
    if (level >= limit) return
    const children = listing
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    for (const child of children) visit(`${path}/${child}`, level + 1, limit)
  }
  for (const [top, levels] of Object.entries(roots)) visit(top, 0, Math.min(levels, depth))
  return entries
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Files shown beside a line a file name made match, then a count of the rest. */
const SHOWN_FILES = 2

/**
 * The entries that hold every word, and their parent directories. A word is held when it starts a word of the
 * directory's path or purpose, or of the name of a file directly inside it, case-insensitively: `ens` finds the ENS
 * directory and not every `extensions`, `protocol` finds `protocols`, and `e2e` finds the folders of `e2e-*` specs.
 * A line one or more words matched only through file names carries those files, so the line says why it is there.
 * No words keeps everything.
 * @param {ReturnType<typeof buildMap>} entries
 * @param {string[]} words
 * @returns {Array<ReturnType<typeof buildMap>[number] & { matchedFiles?: string[] }>}
 */
export function filterMap (entries, words) {
  const needles = words.filter((word) => word !== '').map((word) => {
    const spellings = [word.toLowerCase(), ...(SYNONYMS.get(word.toLowerCase()) ?? [])]
    return new RegExp(`(?:^|[^a-z0-9])(?:${spellings.map(escapeRegExp).join('|')})`)
  })
  if (needles.length === 0) return entries
  const matches = new Map()
  for (const { path, purpose, files } of entries) {
    const text = `${path} ${purpose ?? ''}`.toLowerCase()
    const lower = files.map((file) => file.toLowerCase())
    const open = needles.filter((needle) => !needle.test(text))
    if (!open.every((needle) => lower.some((file) => needle.test(file)))) continue
    matches.set(path, open.length === 0 ? [] : files.filter((_, at) => open.some((needle) => needle.test(lower[at]))))
  }
  const keep = new Set()
  for (const path of matches.keys()) {
    for (let at = path; at !== ''; at = at.slice(0, Math.max(at.lastIndexOf('/'), 0))) keep.add(at)
  }
  return entries
    .filter((entry) => keep.has(entry.path))
    .map((entry) => matches.has(entry.path) ? { ...entry, matchedFiles: matches.get(entry.path) } : entry)
}

/** One line per entry: indented by depth, the path, the purpose, and any files a word matched. */
export function renderMap (entries) {
  return entries
    .map(({ path, depth, purpose, matchedFiles = [] }) => {
      const more = matchedFiles.length - SHOWN_FILES
      const files = matchedFiles.length === 0
        ? ''
        : ` [files: ${matchedFiles.slice(0, SHOWN_FILES).join(', ')}${more > 0 ? `, +${String(more)} more` : ''}]`
      return `${'  '.repeat(depth)}${path}/ - ${purpose ?? NO_README}${files}`
    })
    .join('\n')
}

export const USAGE = 'usage: node scripts/ai/code-map.mjs [--depth N] [word ...]\n' +
  '  Prints each directory under src/, test/, scripts/ and vendor/ with a one-line purpose.\n' +
  '  Words keep only the directories whose path, purpose or file names hold every word (case-insensitive,\n' +
  '  matched at the start of a word), with their parents.\n' +
  '  --depth N shows N levels below each root.'

/**
 * @param {string[]} argv
 * @returns {{ words: string[], depth: number, help: boolean, error?: string }}
 */
export function parseArguments (argv) {
  const result = { words: [], depth: Infinity, help: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      result.help = true
    } else if (argument === '--depth' || argument.startsWith('--depth=')) {
      const value = argument === '--depth' ? argv[++index] : argument.slice('--depth='.length)
      if (!/^\d+$/.test(value ?? '')) return { ...result, error: '--depth needs a whole number' }
      result.depth = Number(value)
    } else if (argument.startsWith('--')) {
      return { ...result, error: `unknown option ${argument}` }
    } else {
      result.words.push(argument)
    }
  }
  return result
}

if (isInvokedDirectly(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  if (options.error !== undefined) {
    console.error(`${options.error}\n${USAGE}`)
    process.exit(2)
  }
  if (options.help) {
    console.log(USAGE)
  } else {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const shown = filterMap(buildMap(root, { depth: options.depth }), options.words)
    console.log(shown.length > 0
      ? renderMap(shown)
      : `No directory matches "${options.words.join(' ')}". Fewer or different words widen it; no words prints the whole map.`)
  }
}
