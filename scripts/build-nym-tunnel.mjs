/**
 * Builds the Nym tunnel module from Nym's own source: `vendor/nym-smolmix/UPSTREAM.md` says what it is and why.
 *
 * A developer step, never part of `npm install` (Rule 8: it needs rustup). It clones the pinned tag into a cache
 * directory outside this repository, checks the commit, applies `vendor/nym-smolmix/smolmix-raw-tcp-udp.patch`,
 * fetches the pinned `wasm-bindgen`, `wasm-pack` and `cargo-about` binaries (each checked against its sha256), runs the
 * crate's own `wasm-pack build` and makes the notices of every crate in it (`THIRD_PARTY_LICENSES`). The cache is
 * `~/.cache/orivon-nym-build`; the files to publish are left in its `artifact` folder, and the `files` array for
 * `resources/nym-tunnel/nym-tunnel.json` is printed.
 *
 *   node scripts/build-nym-tunnel.mjs
 *
 * Needs `git`, `tar` and rustup's Rust 1.99.0 with the `wasm32-unknown-unknown` target:
 *   rustup toolchain install 1.99.0 --target wasm32-unknown-unknown
 *
 * Plain Node, so it runs on every system (Rule 8).
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { isInvokedDirectly } from './cli.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(here, '..', 'vendor', 'nym-smolmix')

export const NYM = {
  url: 'https://github.com/nymtech/nym',
  tag: 'nym-binaries-v2026.20-glasgow',
  commit: '28904698fd68337cc722d51ab21f29f4fd6c56ce'
}
export const RUSTC_VERSION = '1.99.0'
const CRATE = join('wasm', 'smolmix')
const PATCH = 'smolmix-raw-tcp-udp.patch'
const FILES = ['smolmix_wasm.js', 'smolmix_wasm_bg.wasm', 'smolmix_wasm.d.ts']
/** The notices of every crate compiled into the module, made by `cargo-about` from the lockfile (about.toml says which licences are accepted). */
const NOTICES = 'THIRD_PARTY_LICENSES'

const WASM_BINDGEN = 'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.122'
const WASM_PACK = 'https://github.com/wasm-bindgen/wasm-pack/releases/download/v0.15.0'
const CARGO_ABOUT = 'https://github.com/EmbarkStudios/cargo-about/releases/download/0.9.2'
/** The prebuilt binaries by `<platform>-<arch>`: archive, its sha256, and the folder and executable inside it. */
export const TOOLS = {
  'linux-x64': [
    { name: 'wasm-bindgen', url: `${WASM_BINDGEN}/wasm-bindgen-0.2.122-x86_64-unknown-linux-musl.tar.gz`, sha256: '122a3fe2ea9c6e3e89b50e42dd1a346e499f3f65a54aae0b4eaeb658139d1e0e', folder: 'wasm-bindgen-0.2.122-x86_64-unknown-linux-musl' },
    { name: 'wasm-pack', url: `${WASM_PACK}/wasm-pack-v0.15.0-x86_64-unknown-linux-musl.tar.gz`, sha256: 'c09f971ecaed9a2efc80fdcea7a00ef6b53c7fadc8c57d1f61b53a6aa66b668a', folder: 'wasm-pack-v0.15.0-x86_64-unknown-linux-musl' },
    { name: 'cargo-about', url: `${CARGO_ABOUT}/cargo-about-0.9.2-x86_64-unknown-linux-musl.tar.gz`, sha256: '9099a59e820c38a68b9d65f300662a567d56562f9a10f6aa4c7e86c17c2566af', folder: 'cargo-about-0.9.2-x86_64-unknown-linux-musl' }
  ],
  'linux-arm64': [
    { name: 'wasm-bindgen', url: `${WASM_BINDGEN}/wasm-bindgen-0.2.122-aarch64-unknown-linux-gnu.tar.gz`, sha256: '1c0b2f0471e773f2369feb64e4ca18f2b45fabf9996d55425b34c1ba6ae7c89f', folder: 'wasm-bindgen-0.2.122-aarch64-unknown-linux-gnu' },
    { name: 'wasm-pack', url: `${WASM_PACK}/wasm-pack-v0.15.0-aarch64-unknown-linux-musl.tar.gz`, sha256: 'e17ef0806381c3a0acb9c9ddad643a49facaa5a2ecf657a421d4d8f3357a24b7', folder: 'wasm-pack-v0.15.0-aarch64-unknown-linux-musl' },
    { name: 'cargo-about', url: `${CARGO_ABOUT}/cargo-about-0.9.2-aarch64-unknown-linux-musl.tar.gz`, sha256: 'af5169282fb6f84e13471493f405437e43ac517744c9ae12fbe2cdf0a6f0e5a8', folder: 'cargo-about-0.9.2-aarch64-unknown-linux-musl' }
  ],
  'darwin-x64': [
    { name: 'wasm-bindgen', url: `${WASM_BINDGEN}/wasm-bindgen-0.2.122-x86_64-apple-darwin.tar.gz`, sha256: 'cb500a6b249c20474bbdd86d4d8d593fa65c9e5dbd56abb1ae7ee48c08390a11', folder: 'wasm-bindgen-0.2.122-x86_64-apple-darwin' },
    { name: 'wasm-pack', url: `${WASM_PACK}/wasm-pack-v0.15.0-x86_64-apple-darwin.tar.gz`, sha256: 'd3f1a4a33e95f8f0d7801b024e08624c479999ac96aa150908b2394015cd0363', folder: 'wasm-pack-v0.15.0-x86_64-apple-darwin' }
  ],
  'darwin-arm64': [
    { name: 'wasm-bindgen', url: `${WASM_BINDGEN}/wasm-bindgen-0.2.122-aarch64-apple-darwin.tar.gz`, sha256: '36beadc86c5c02c511a152e8fc2c63850646887e97dc94ae04553640f839e808', folder: 'wasm-bindgen-0.2.122-aarch64-apple-darwin' },
    { name: 'wasm-pack', url: `${WASM_PACK}/wasm-pack-v0.15.0-aarch64-apple-darwin.tar.gz`, sha256: '0abff4a03d670b6c00ea31d0e1608a72407e355f3d3765e9c30eb45cd5b7e318', folder: 'wasm-pack-v0.15.0-aarch64-apple-darwin' },
    { name: 'cargo-about', url: `${CARGO_ABOUT}/cargo-about-0.9.2-aarch64-apple-darwin.tar.gz`, sha256: 'ae72f0df0c399a1e96336f696fa55b1b28679fd725632eba8cf8e4568467cc3e', folder: 'cargo-about-0.9.2-aarch64-apple-darwin' }
  ],
  'win32-x64': [
    { name: 'wasm-bindgen', url: `${WASM_BINDGEN}/wasm-bindgen-0.2.122-x86_64-pc-windows-msvc.tar.gz`, sha256: '03ba3056eb0c2ad2d0d30a0c0edefb590656a1e237596226804abb87b71b77ad', folder: 'wasm-bindgen-0.2.122-x86_64-pc-windows-msvc' },
    { name: 'wasm-pack', url: `${WASM_PACK}/wasm-pack-v0.15.0-x86_64-pc-windows-msvc.tar.gz`, sha256: '518dc51180c7bc864699c9279b3bc99025bc109123e0249a34ba34d130a509bf', folder: 'wasm-pack-v0.15.0-x86_64-pc-windows-msvc' },
    { name: 'cargo-about', url: `${CARGO_ABOUT}/cargo-about-0.9.2-x86_64-pc-windows-msvc.tar.gz`, sha256: '1c03e5890238562497c2d89a3b75b02560af349c1fc3e713d3284f532a5cd748', folder: 'cargo-about-0.9.2-x86_64-pc-windows-msvc' }
  ]
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Runs a command to its end; a failure to start or a non-zero exit throws with the command named. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error !== undefined) throw new Error(`could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

/** A command's standard output, trimmed. */
function output(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined) throw new Error(`could not run ${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}: ${result.stderr}`)
  return result.stdout.trim()
}

/** The clone of the pinned tag in `source`, at the pinned commit, with only the patch applied. */
async function prepareSource(source) {
  if (!existsSync(join(source, '.git'))) {
    await rm(source, { recursive: true, force: true })
    await mkdir(dirname(source), { recursive: true })
    run('git', ['clone', '--depth', '1', '--branch', NYM.tag, NYM.url, source])
  } else {
    run('git', ['reset', '--hard', 'HEAD'], { cwd: source })
    run('git', ['clean', '-fdx'], { cwd: source })
  }
  const commit = output('git', ['rev-parse', 'HEAD'], { cwd: source })
  if (commit !== NYM.commit) throw new Error(`${NYM.tag} is at ${commit}, not the pinned ${NYM.commit}; remove ${source} and run again`)
  run('git', ['apply', '--check', join(VENDOR, PATCH)], { cwd: source })
  run('git', ['apply', join(VENDOR, PATCH)], { cwd: source })
}

/** The folders holding `wasm-bindgen` and `wasm-pack`, fetched into `tools` and checked against their pins. */
async function prepareTools(tools) {
  const key = `${process.platform}-${process.arch}`
  const pinned = TOOLS[key]
  if (pinned === undefined) throw new Error(`no pinned wasm-bindgen and wasm-pack for ${key}`)
  if (!pinned.some((tool) => tool.name === 'cargo-about')) throw new Error(`no pinned cargo-about for ${key}, which the notices of the crates need (cargo-about has no release for it)`)
  const folders = []
  for (const tool of pinned) {
    const folder = join(tools, tool.folder)
    folders.push(folder)
    if (existsSync(folder)) continue
    const response = await fetch(tool.url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`${tool.url}: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (sha256(bytes) !== tool.sha256) throw new Error(`${tool.url} is not the pinned archive (sha256 ${sha256(bytes)})`)
    await mkdir(tools, { recursive: true })
    run('tar', ['-xzf', '-', '-C', tools], { input: bytes, stdio: ['pipe', 'inherit', 'inherit'] })
  }
  return folders
}

/** Fails unless the Rust on the path is the pinned release and can target WebAssembly. */
function checkRust() {
  const version = output('rustc', ['--version'])
  if (!version.startsWith(`rustc ${RUSTC_VERSION} `)) {
    throw new Error(`the build needs rustc ${RUSTC_VERSION}, found "${version}". Install it with: rustup toolchain install ${RUSTC_VERSION} --target wasm32-unknown-unknown, then run again with RUSTUP_TOOLCHAIN=${RUSTC_VERSION}`)
  }
  const targets = output('rustc', ['--print', 'target-list'])
  const installed = output('rustc', ['--print', 'sysroot'])
  if (!targets.includes('wasm32-unknown-unknown') || !existsSync(join(installed, 'lib', 'rustlib', 'wasm32-unknown-unknown'))) {
    throw new Error('the wasm32-unknown-unknown target is missing: rustup target add wasm32-unknown-unknown')
  }
  return installed
}

/** Builds in `cache` and copies the published files to `out`. Resolves to the `files` entries of the manifest. */
export async function build({ cache, out }) {
  const sysroot = checkRust()
  const source = join(cache, 'nym')
  await prepareSource(source)
  const folders = await prepareTools(join(cache, 'tools'))
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo')
  // The paths on this computer are rewritten to fixed ones, so the same source gives the same bytes anywhere. The
  // flags replace the crate's own `build.rustflags`, so its getrandom setting is repeated here.
  const rustflags = [
    '--cfg=getrandom_backend="wasm_js"',
    `--remap-path-prefix=${source}=/nym`,
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${sysroot}=/rust`
  ].join('\x1f')
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const env = {
    ...process.env,
    [pathKey]: [...folders, join(cargoHome, 'bin'), process.env[pathKey]].join(delimiter),
    CARGO_TARGET_DIR: join(cache, 'target'),
    // Nym stamps its build time into the module; the commit's own time makes the stamp the same on every build.
    SOURCE_DATE_EPOCH: output('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: source }),
    CARGO_ENCODED_RUSTFLAGS: rustflags
  }
  const crate = join(source, CRATE)
  await rm(join(crate, 'pkg'), { recursive: true, force: true })
  run('wasm-pack', ['build', '--scope', 'nymproject', '--target', 'web', '--out-name', 'smolmix_wasm'], { cwd: crate, env })
  if (output('git', ['status', '--porcelain', '--', 'Cargo.lock'], { cwd: source }) !== '') throw new Error('the build changed Cargo.lock: it must build from the lockfile as published')

  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  for (const name of FILES) await copyFile(join(crate, 'pkg', name), join(out, name))
  await copyFile(join(source, 'LICENSES', 'Apache-2.0.txt'), join(out, 'LICENSE'))
  // For the wasm target alone, so a crate that is only built for another is not listed; a crate whose licence is not in about.toml fails the build.
  run('cargo-about', ['generate', '--config', join(VENDOR, 'about.toml'), '--manifest-path', join(crate, 'Cargo.toml'), '--target', 'wasm32-unknown-unknown', '--locked', '--output-file', join(out, NOTICES), join(VENDOR, 'third-party-licenses.hbs')], { cwd: source, env })
  await copyFile(join(VENDOR, 'README.md'), join(out, 'README.md'))
  const files = []
  for (const name of [...FILES, 'LICENSE', NOTICES, 'README.md']) {
    const bytes = await readFile(join(out, name))
    files.push({ name, bytes: bytes.length, sha256: sha256(bytes) })
  }
  return files
}

if (isInvokedDirectly(import.meta.url)) {
  const cache = join(homedir(), '.cache', 'orivon-nym-build')
  const out = join(cache, 'artifact')
  try {
    const files = await build({ cache, out })
    console.log(`\nbuilt into ${out}; the files for resources/nym-tunnel/nym-tunnel.json:`)
    console.log(files.map((file) => `    ${JSON.stringify(file)}`).join(',\n'))
  } catch (error) {
    console.error(`[build-nym-tunnel] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
