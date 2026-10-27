// Writes a GitHub release's description: what the version changed (its CHANGELOG.md section), a table of
// which file suits which computer, and where the release is on IPFS. Node built-ins only: the release
// workflow runs it in a job with a read-only token (docs/development/packaging.md section Release notes).
//
//   node scripts/release-notes.mjs --tag v0.0.9 --repo OrivonBrowser/orivon-mvp --changelog CHANGELOG.md \
//     --assets-dir packages --ipfs-json packages/ipfs.json --routes packaging/release-routes.json \
//     --prerelease true --body-file current-body.md --out notes.md
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Everything from this line on is generated, and replaced whole by the next run. */
export const MARKER = '<!-- orivon-release-notes -->'

/** The CHANGELOG subsections that list shipped changes for people using Orivon. */
const SHIPPED_HEADINGS = ['added', 'changed', 'fixed', 'security', 'removed', 'deprecated']

// A pipe inside a table cell is escaped, also inside code.
const MAC_INSTALL = 'curl -fsSL https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-macos.sh \\| bash'
const WIN_INSTALL = 'irm https://raw.githubusercontent.com/OrivonBrowser/orivon-mvp/main/scripts/install-windows.ps1 \\| iex'
const STORE_PRODUCT_ID = '9MXV3FNMFBP4'

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lf = (text) => text.replace(/\r\n?/g, '\n')

/** The body of `## [version]` up to the next `## ` heading, or null when CHANGELOG.md has no such section. */
export function changelogSection(changelog, version) {
  const lines = lf(changelog).split('\n')
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[${escapeRegex(version)}\\](\\s|$)`).test(line))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** The shipped subsections of a version's section, as markdown with their headings one level down; '' when it has none. */
export function shippedChanges(section) {
  const blocks = []
  let current = null
  for (const line of section.split('\n')) {
    const heading = /^###\s+(.*?)\s*$/.exec(line)
    if (heading) {
      current = { name: heading[1], lines: [] }
      blocks.push(current)
    } else if (current) {
      current.lines.push(line)
    }
  }
  return blocks
    .filter((block) => SHIPPED_HEADINGS.includes(block.name.toLowerCase()))
    .map((block) => ({ name: block.name, text: block.lines.join('\n').trim() }))
    .filter((block) => block.text !== '')
    .map((block) => `#### ${block.name}\n\n${block.text}`)
    .join('\n\n')
}

/** The "What changed" section, or null when CHANGELOG.md holds nothing shipped for this version. */
export function changesSection({ changelog, version, repo, tag }) {
  const section = changelogSection(changelog, version)
  if (section === null) return null
  const changes = shippedChanges(section)
  if (changes === '') return null
  const full = `https://github.com/${repo}/blob/${tag}/CHANGELOG.md`
  return `### What changed\n\n${changes}\n\nEvery release's changes, including those for app authors, are in [CHANGELOG.md](${full}).`
}

/** The row of the table for each file the release carries, then the routes that are open. */
export function whichFileSection({ version, assets, routes, prerelease }) {
  const has = (name) => assets.includes(name)
  const rows = []
  const row = (suits, get, how) => rows.push(`| ${suits} | ${get} | ${how} |`)

  const exe = `Orivon-Setup-${version}-x64.exe`
  const arm = `Orivon-${version}-arm64.dmg`
  const intel = `Orivon-${version}-x64.dmg`
  const deb = `orivon_${version}_amd64.deb`
  const appImage = `Orivon-${version}-x86_64.AppImage`

  if (has(exe)) row('Windows 10 or 11, Intel or AMD (64-bit)', `\`${exe}\``, 'Installs for your user, no administrator needed. Windows asks once whether to run it: More info, then Run anyway')
  if (has(exe)) row('Windows, from PowerShell', `\`${WIN_INSTALL}\``, 'Installs the newest release for your user and opens it, with no warning from Windows')
  if (routes.store) row('Windows, from the Microsoft Store', `[Orivon Browser](https://apps.microsoft.com/detail/${STORE_PRODUCT_ID.toLowerCase()})`, 'The Store installs and updates it')
  if (routes.winget) row('Windows, from a terminal', `\`winget install ${prerelease ? 'Orivon.Browser.Preview' : 'Orivon.Browser'}\``, 'winget downloads the installer above')
  if (has(arm)) row('Mac with Apple silicon (M1 or later)', `\`${arm}\``, 'Open it and drag Orivon to Applications. Apple has signed and checked the app')
  if (has(intel)) row('Mac with an Intel processor', `\`${intel}\``, 'The same, with the Intel file')
  if (has(arm) || has(intel)) row('Mac, from Terminal', `\`${MAC_INSTALL}\``, 'Installs the newest release for your Mac and opens it, with no question from macOS')
  if (has(deb)) row('Debian, Ubuntu, Linux Mint and the like (64-bit)', `\`${deb}\``, `\`sudo apt install ./${deb}\`. The only Linux file Orivon can be made the default browser from`)
  if (has(appImage)) row('Any other Linux (64-bit)', `\`${appImage}\``, 'Make it executable (`chmod +x`) and run it, nothing is installed. If it does not start on Ubuntu, install `libfuse2`')
  if (routes.aur) row('Arch Linux and its relatives', '`orivon-bin` from the AUR', 'With an AUR helper, for example `yay -S orivon-bin`')

  if (rows.length === 0) return null
  const note = has('ipfs.json') ? '\n\n`ipfs.json` lists the SHA-256 of every file.' : ''
  return `### Which file is mine?\n\n| You use | Get | How it installs |\n|---|---|---|\n${rows.join('\n')}${note}`
}

/** The section the workflow has always written: where the same files sit on IPFS. */
export function ipfsSection(cid) {
  return `### On IPFS\n\nThe same files, as one folder: \`ipfs://${cid}\`. Open it in Orivon, or run \`ipfs get ${cid}\`. The Orivon node pins it within about 15 minutes, with the two releases before it.`
}

/** The description without what a previous run generated: from the marker on, or from "### On IPFS" in a description from before it. */
export function withoutGenerated(body) {
  const text = lf(body)
  const marker = text.indexOf(MARKER)
  if (marker !== -1) return text.slice(0, marker).trim()
  const legacy = /^### On IPFS[ \t]*$/m.exec(text)
  return (legacy ? text.slice(0, legacy.index) : text).trim()
}

/**
 * The whole description: what a person wrote above the marker stays, everything below is replaced.
 * `warnings` names what was left out, for the workflow to show.
 */
export function composeNotes({ body = '', changelog, tag, repo, assets, routes = {}, prerelease = false, cid }) {
  const version = tag.replace(/^v/, '')
  const warnings = []
  const changes = changesSection({ changelog, version, repo, tag })
  if (changes === null) warnings.push(`CHANGELOG.md has no shipped changes under [${version}], so the description lists none. Move the [Unreleased] entries under a [${version}] heading before tagging.`)
  const files = whichFileSection({ version, assets, routes, prerelease })
  if (files === null) warnings.push('The release carries none of the files the table knows, so it has no "Which file is mine?" section.')
  if (!cid) warnings.push('No IPFS CID was given, so the description has no "On IPFS" section.')

  const generated = [MARKER, changes, files, cid ? ipfsSection(cid) : null].filter((part) => part !== null).join('\n\n')
  const kept = withoutGenerated(body)
  return { notes: `${kept === '' ? '' : `${kept}\n\n`}${generated}\n`, warnings }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) throw new Error(`unexpected argument: ${argv[i]}`)
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ['tag', 'repo', 'changelog', 'out']) {
    if (!args[required]) throw new Error(`--${required} is required`)
  }
  const assets = args['assets-dir'] ? readdirSync(args['assets-dir']) : []
  const cid = args['ipfs-json'] ? JSON.parse(readFileSync(args['ipfs-json'], 'utf8')).cid : undefined
  const routes = args.routes && existsSync(args.routes) ? JSON.parse(readFileSync(args.routes, 'utf8')) : {}
  const { notes, warnings } = composeNotes({
    body: args['body-file'] ? readFileSync(args['body-file'], 'utf8') : '',
    changelog: readFileSync(args.changelog, 'utf8'),
    tag: args.tag,
    repo: args.repo,
    assets,
    routes,
    prerelease: args.prerelease === 'true',
    cid,
  })
  writeFileSync(args.out, notes)
  for (const warning of warnings) console.log(`::warning title=release notes::${warning}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
