/**
 * Signs a release's package list, so an installed Orivon may install that release's update.
 *
 *   node scripts/release/sign-update.mjs <tag> --key <private-key.pem> [--dir <packages>] [--out <folder>] [--upload]
 *   node scripts/release/sign-update.mjs <tag> --verify [--dir <packages>]
 *
 * Run by the maintainer on their own machine after the release workflow has attached the five packages. It hashes
 * every package (downloaded with `gh release download`, or read from --dir), refuses unless all five are there,
 * writes `orivon-update.json` and `orivon-update.json.sig` (an Ed25519 signature over the exact bytes), checks the
 * result against the public key embedded in the browser, and with --upload attaches both to the release. The
 * private key is never in a repository. --verify checks what is published against the embedded key, and against
 * the packages in --dir when given.
 *
 * This script imports nothing from src/: it reads the embedded public key from the source text of
 * src/main/self-update/update-signing-key.ts, and a unit test holds its package names to the browser's.
 */
import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from '../cli.mjs'

export const MANIFEST_NAME = 'orivon-update.json'
export const SIGNATURE_NAME = 'orivon-update.json.sig'
export const MANIFEST_FORMAT = 'orivon-update/1'
const PLAIN_TAG = /^v?\d+\.\d+\.\d+$/
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The five packages a release has, by the names electron-builder.yml gives them (the browser's own table is src/main/self-update/install-kind.ts). */
export function expectedPackages (version) {
  return [
    `Orivon-${version}-x86_64.AppImage`,
    `orivon_${version}_amd64.deb`,
    `Orivon-Setup-${version}-x64.exe`,
    `Orivon-${version}-arm64.dmg`,
    `Orivon-${version}-x64.dmg`
  ]
}

/** The manifest text for `files` ({ name, size, sha256 }), sorted by name, two-space JSON with a final newline. */
export function manifestText (version, files) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return `${JSON.stringify({ format: MANIFEST_FORMAT, version, files: sorted.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }, null, 2)}\n`
}

/** The public keys the browser trusts, read from the text of its key file. */
export function embeddedKeys (root = ROOT) {
  const text = readFileSync(join(root, 'src', 'main', 'self-update', 'update-signing-key.ts'), 'utf8')
  return [...text.matchAll(/-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----/g)].map((match) => `${match[0].trim()}\n`)
}

/** Whether `signatureText` signs `bytes` under one of `keys`. */
export function signedByAny (bytes, signatureText, keys) {
  const signature = Buffer.from(signatureText.trim(), 'base64')
  return keys.some((pem) => { try { return verify(null, bytes, createPublicKey(pem), signature) } catch { return false } })
}

/** Hashes the expected packages found in `dir`; throws naming every one that is missing. */
export function hashPackages (dir, version) {
  const have = new Set(readdirSync(dir))
  const missing = expectedPackages(version).filter((name) => !have.has(name))
  if (missing.length > 0) throw new Error(`refusing to sign: ${dir} lacks ${missing.join(', ')}`)
  return expectedPackages(version).map((name) => {
    const bytes = readFileSync(join(dir, name))
    return { name, size: statSync(join(dir, name)).size, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
}

/** Signs `text` with the PEM private key, refusing a key whose public half the browser does not trust. */
export function signManifest (text, privateKeyPem, keys = embeddedKeys()) {
  const privateKey = createPrivateKey(privateKeyPem)
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  if (!keys.some((pem) => pem.trim() === publicPem.trim())) throw new Error('refusing to sign: this key is not one the browser trusts (src/main/self-update/update-signing-key.ts)')
  const bytes = Buffer.from(text)
  const signature = sign(null, bytes, privateKey).toString('base64')
  if (!signedByAny(bytes, signature, keys)) throw new Error('the signature made does not verify under the embedded keys')
  return `${signature}\n`
}

function parseArgs (argv) {
  const options = { upload: false, verify: false }
  const positional = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--upload') options.upload = true
    else if (arg === '--verify') options.verify = true
    else if (arg === '--key' || arg === '--dir' || arg === '--out') options[arg.slice(2)] = argv[++index]
    else positional.push(arg)
  }
  return { options, tag: positional[0] }
}

const gh = (args) => execFileSync('gh', args, { stdio: 'inherit' })

function download (tag, dir, patterns) {
  mkdirSync(dir, { recursive: true })
  gh(['release', 'download', tag, '--dir', dir, '--clobber', ...patterns.flatMap((pattern) => ['--pattern', pattern])])
}

export function main (argv) {
  const { options, tag } = parseArgs(argv)
  if (tag === undefined || !PLAIN_TAG.test(tag)) throw new Error('usage: sign-update.mjs <tag, like v1.2.0> --key <private-key.pem> [--dir <packages>] [--out <folder>] [--upload]  |  <tag> --verify [--dir <packages>]')
  const version = tag.replace(/^v/, '')
  const keys = embeddedKeys()
  if (keys.length === 0) throw new Error('no public key found in update-signing-key.ts')

  if (options.verify) {
    const fetched = mkdtempSync(join(tmpdir(), 'orivon-verify-'))
    download(tag, fetched, [MANIFEST_NAME, SIGNATURE_NAME])
    const bytes = readFileSync(join(fetched, MANIFEST_NAME))
    if (!signedByAny(bytes, readFileSync(join(fetched, SIGNATURE_NAME), 'utf8'), keys)) throw new Error(`the published signature of ${tag} does not verify under the embedded keys`)
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (manifest.format !== MANIFEST_FORMAT || manifest.version !== version) throw new Error('the published manifest is for another format or version')
    const listed = manifest.files.map((file) => file.name).sort()
    if (JSON.stringify(listed) !== JSON.stringify([...expectedPackages(version)].sort())) throw new Error(`the published manifest lists ${listed.join(', ')}, not the five expected packages`)
    if (options.dir !== undefined) {
      for (const file of manifest.files) {
        const sha = createHash('sha256').update(readFileSync(join(options.dir, file.name))).digest('hex')
        if (sha !== file.sha256) throw new Error(`${file.name} in ${options.dir} does not match the published manifest`)
      }
    }
    console.log(`${tag}: the published manifest verifies under the embedded key${options.dir === undefined ? '' : ' and matches the packages in --dir'}.`)
    return
  }

  if (options.key === undefined) throw new Error('--key <private-key.pem> is required to sign')
  const packages = options.dir ?? mkdtempSync(join(tmpdir(), 'orivon-packages-'))
  if (options.dir === undefined) download(tag, packages, ['Orivon-*', 'orivon_*'])
  const out = options.out ?? mkdtempSync(join(tmpdir(), 'orivon-signed-'))
  mkdirSync(out, { recursive: true })

  const text = manifestText(version, hashPackages(packages, version))
  const signature = signManifest(text, readFileSync(options.key, 'utf8'), keys)
  writeFileSync(join(out, MANIFEST_NAME), text)
  writeFileSync(join(out, SIGNATURE_NAME), signature)
  console.log(`wrote ${join(out, MANIFEST_NAME)} and ${join(out, SIGNATURE_NAME)}`)
  if (options.upload) {
    gh(['release', 'upload', tag, join(out, MANIFEST_NAME), join(out, SIGNATURE_NAME), '--clobber'])
    console.log(`${tag}: attached. Run again with --verify to check what is published.`)
  }
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
