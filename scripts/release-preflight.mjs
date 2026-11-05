// Refuses a release that could not ship, before any package is built, naming every reason at once: a tag that is
// not v<semver>, and a light-client checkpoint too old to bundle. The Release workflow's first job runs it; run it
// before publishing a release to hear the same (docs/development/packaging.md section Releases). Node built-ins only.
//
//   node scripts/release-preflight.mjs --tag v0.1.0 [--max-age-days 7]
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { changelogSection } from './release-notes.mjs'

const CHECKPOINT = 'src/main/verifier/mainnet-checkpoint.json'
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

/** Why the tag cannot name a release, or null. Every package, winget and the Store take their version from it. */
export function tagProblem(tag) {
  if (SEMVER_TAG.test(tag)) return null
  const twoParts = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
  return (
    `The tag ${tag} is not v<major>.<minor>.<patch> (v0.1.0, v0.2.0-beta.1), and every package, winget and the Store ` +
    `take their version from it.${twoParts ? ` Use ${tag}.0.` : ''}`
  )
}

/** Why the bundled checkpoint is too old to ship, or null. The app refuses one over 14 days old. */
export function checkpointProblem(checkpoint, nowSeconds, maxDays) {
  const days = (nowSeconds - checkpoint?.timestamp) / 86400
  if (days <= maxDays) return null
  const age = Number.isFinite(days) ? `is ${days.toFixed(1)} days old` : 'has no timestamp'
  return (
    `The bundled .eth checkpoint (${CHECKPOINT}) ${age}, and a release ships one ${maxDays} days old at most. Merge the ` +
    'open pull request "Refresh the bundled .eth light-client checkpoint" (gh workflow run refresh-eth-checkpoint.yml ' +
    'makes one), so the tag can point at a main that carries it.'
  )
}

/** What would block the release, and what would leave it poorer: a description with no changes. */
export function preflight({ tag, checkpoint, changelog, nowSeconds, maxDays }) {
  const tagError = tagProblem(tag)
  const errors = [tagError, checkpointProblem(checkpoint, nowSeconds, maxDays)].filter((e) => e !== null)
  const warnings = []
  const version = tag.replace(/^v/, '')
  if (tagError === null && changelogSection(changelog, version) === null) {
    warnings.push(
      `CHANGELOG.md has no [${version}] section, so the release's description will list no changes. Move the ` +
        `[Unreleased] entries under a [${version}] heading.`,
    )
  }
  return { errors, warnings }
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
  if (!args.tag) throw new Error('--tag is required')
  const { errors, warnings } = preflight({
    tag: args.tag,
    checkpoint: JSON.parse(readFileSync(CHECKPOINT, 'utf8')),
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    nowSeconds: Date.now() / 1000,
    maxDays: Number(args['max-age-days'] ?? 7),
  })
  for (const warning of warnings) console.log(`::warning title=release::${warning}`)
  for (const error of errors) console.log(`::error title=release::${error}`)
  if (errors.length === 0) return
  console.log(
    'Nothing is built. Once fixed, publish it again: gh release edit <tag> --draft, then ' +
      'gh release edit <tag> --tag <the right tag> --target main --draft=false (packaging.md section Releases).',
  )
  process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
