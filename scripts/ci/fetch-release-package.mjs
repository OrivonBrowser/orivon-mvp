/**
 * Downloads the package of a published release for the system this runs on, checks its SHA-256 against the digest
 * GitHub reports for the file (as the one-line installers do) and prints where it is, so a workflow can install it and
 * time its start with `scripts/first-start-probe.mjs`.
 *
 *   node scripts/ci/fetch-release-package.mjs <tag> <linux|win|mac> <folder>
 *
 * linux is the deb, win the NSIS installer, mac the dmg of this machine's architecture. The path is the only line on
 * stdout; progress and errors go to stderr. `ORIVON_REPO` names another repository, `ORIVON_GITHUB_TOKEN` (or
 * `GITHUB_TOKEN`) lifts the rate limit of the release lookup.
 */
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isInvokedDirectly } from '../cli.mjs'

export const PLATFORMS = ['linux', 'win', 'mac']
const DEFAULT_REPO = 'OrivonBrowser/orivon-mvp'
/** The name of each system's package among a release's files; a mac's depends on the architecture. */
const ASSET_NAMES = {
  linux: /^orivon_.+_amd64\.deb$/,
  win: /^Orivon-Setup-.+-x64\.exe$/,
  'mac-arm64': /^Orivon-.+-arm64\.dmg$/,
  'mac-x64': /^Orivon-.+-x64\.dmg$/
}

/** The release file a system takes, or undefined when the release carries none for it. */
export function pickAsset (platform, architecture, assets) {
  const key = platform === 'mac' ? `mac-${architecture}` : platform
  const pattern = ASSET_NAMES[key]
  if (pattern === undefined) throw new Error(`no package of ${platform} for ${architecture}: use linux, win or mac, a mac on x64 or arm64`)
  return assets.find((asset) => pattern.test(String(asset.name)))
}

/** The hex SHA-256 in an asset's `digest` ("sha256:<hex>"); throws when GitHub reports none, as a download nothing vouches for is refused. */
export function digestOf (asset) {
  const hex = String(asset.digest ?? '').replace(/^sha256:/, '')
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`GitHub reports no SHA-256 for ${asset.name}`)
  return hex
}

/**
 * Saves `url` to `file` and checks the SHA-256 of what arrived; a file that does not match is deleted and refused.
 * @param {string} url
 * @param {string} file
 * @param {string} digest the hex SHA-256 the file must have
 * @param {typeof fetch} [fetchImpl]
 */
export async function downloadVerified (url, file, digest, fetchImpl = fetch) {
  const response = await fetchImpl(url)
  if (!response.ok || response.body === null) throw new Error(`downloading ${url} answered ${response.status}`)
  const hash = createHash('sha256')
  const counted = Readable.fromWeb(response.body)
  counted.on('data', (chunk) => hash.update(chunk))
  await pipeline(counted, createWriteStream(file))
  if (hash.digest('hex') !== digest) {
    rmSync(file, { force: true })
    throw new Error(`${url} does not match the SHA-256 GitHub reports for it`)
  }
}

/**
 * Fetches the package of `tag` for `platform` into `folder` and returns its path.
 * @param {{ tag: string, platform: string, folder: string, repo?: string, token?: string, architecture?: string, fetchImpl?: typeof fetch }} options
 */
export async function fetchReleasePackage ({ tag, platform, folder, repo = DEFAULT_REPO, token, architecture = process.arch, fetchImpl = fetch }) {
  if (!/^[\w.+-]+$/.test(tag)) throw new Error(`${tag} is not a release tag`)
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'orivon-fetch-release-package', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers })
  if (!response.ok) throw new Error(`${repo} has no readable release ${tag} (GitHub answered ${response.status})`)
  const release = await response.json()
  if (release.draft) throw new Error(`release ${tag} of ${repo} is a draft`)
  const asset = pickAsset(platform, architecture, release.assets ?? [])
  if (asset === undefined) throw new Error(`release ${tag} of ${repo} has no ${platform} package for ${architecture}`)
  const digest = digestOf(asset)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, asset.name)
  console.error(`[fetch-release-package] downloading ${asset.name} (${asset.size} bytes)`)
  await downloadVerified(asset.browser_download_url, file, digest, fetchImpl)
  console.error('[fetch-release-package] checked the SHA-256')
  return file
}

if (isInvokedDirectly(import.meta.url)) {
  const [tag, platform, folder] = process.argv.slice(2)
  if (tag === undefined || !PLATFORMS.includes(platform) || folder === undefined) {
    console.error(`usage: node scripts/ci/fetch-release-package.mjs <tag> <${PLATFORMS.join('|')}> <folder>`)
    process.exit(2)
  }
  try {
    const file = await fetchReleasePackage({ tag, platform, folder, repo: process.env.ORIVON_REPO || DEFAULT_REPO, token: process.env.ORIVON_GITHUB_TOKEN || process.env.GITHUB_TOKEN })
    console.log(file)
  } catch (error) {
    console.error(`[fetch-release-package] ${error.message}`)
    process.exit(1)
  }
}
