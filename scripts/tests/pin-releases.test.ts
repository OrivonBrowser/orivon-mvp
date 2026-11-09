import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Runs functions of scripts/pin-releases.sh. The script has no entry point for one function, so each is cut out of the
// file and run alone, with `ipfs`, `curl` and the functions it calls replaced: no Kubo, no network. Windows has no bash.
const SCRIPT = join(process.cwd(), 'scripts', 'pin-releases.sh')
const STATUS = join(process.cwd(), 'scripts', 'ipfs-status.sh')
const onUnix = process.platform !== 'win32'
const withJq = onUnix && spawnSync('jq', ['--version']).status === 0

const dirs: string[] = []
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'pin-releases-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A function of `script`: its one line, or every line from its name to the first `}` alone on a line. */
function cut (script: string, name: string): string {
  const lines = readFileSync(script, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name} () {`))
  const first = lines[start]
  if (first === undefined) throw new Error(`${name} not found in ${script}`)
  if (first.endsWith('}')) return first
  return lines.slice(start, lines.indexOf('}', start) + 1).join('\n')
}

/** Runs `body` in bash under the script's own `set -euo pipefail`, after the named functions of `script`. */
function bash (functions: string[], body: string, env: Record<string, string> = {}, script = SCRIPT): { stdout: string, stderr: string, status: number | null } {
  const code = functions.map((name) => cut(script, name)).join('\n')
  const run = spawnSync('bash', ['-c', `set -euo pipefail\n${code}\n${body}`], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', ...env } })
  return { stdout: run.stdout, stderr: run.stderr, status: run.status }
}

const FILES = [
  '1234567 orivon_0.0.11_amd64.deb',
  '2345678 Orivon-Setup-0.0.11-x64.exe',
  '3456789 Orivon-0.0.11-arm64.dmg'
]

function startPage (tag: string, lines: string[]): string {
  const source = readFileSync(SCRIPT, 'utf8')
  const fn = /^start_page \(\) \{\n[\s\S]*?^\}$/m.exec(source)
  if (fn === null) throw new Error('start_page not found in pin-releases.sh')
  const run = spawnSync('bash', ['-c', `${fn[0]}\nstart_page "$1"`, 'bash', tag], { input: lines.join('\n') + '\n', encoding: 'utf8' })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  return run.stdout
}

describe.skipIf(!onUnix)('start_page', () => {
  const page = startPage('v0.0.11', FILES)

  it('asks search engines not to index the page', () => {
    const head = /<head>([\s\S]*?)<\/head>/.exec(page)
    expect(head?.[1]).toContain('<meta name="robots" content="noindex">')
  })

  it('lists every file as a download link with its size', () => {
    for (const line of FILES) {
      const [size, name] = line.split(' ')
      expect(page).toContain(`<li><a href="./${name}" download>${name}</a> <span>${Math.round(Number(size) / 1e6)} MB</span></li>`)
    }
    expect(page.match(/<li><a /g)).toHaveLength(FILES.length)
  })

  it('titles the page with the version and keeps the script that starts the download', () => {
    expect(page).toContain('<title>Orivon 0.0.11</title>')
    expect(page).toMatch(/<script>[\s\S]*links\[i\]\.click\(\)[\s\S]*<\/script>/)
  })
})

describe.skipIf(!onUnix)('latest_name', () => {
  it.each([
    ['0.1.0', 'Orivon-Setup-0.1.0-x64.exe', 'Orivon-Setup-latest-x64.exe'],
    ['0.1.0', 'Orivon-0.1.0-arm64.dmg', 'Orivon-latest-arm64.dmg'],
    ['0.1.0', 'Orivon-0.1.0-x64.dmg', 'Orivon-latest-x64.dmg'],
    ['0.1.0', 'orivon_0.1.0_amd64.deb', 'orivon_latest_amd64.deb'],
    ['0.1.0', 'Orivon-0.1.0-x86_64.AppImage', 'Orivon-latest-x86_64.AppImage'],
    ['0.1.0', 'Orivon-Setup-0.1.0-x64.voxel.exe', 'Orivon-Setup-latest-x64.voxel.exe'],
    ['0.1.0-rc.1', 'Orivon-Setup-0.1.0-rc.1-x64.exe', 'Orivon-Setup-latest-x64.exe'],
    ['0.1.0', 'Orivon-Setup-0.1.01-x64.exe', ''],
    ['0.1.0', 'Orivon-0.1.0.dmg', ''],
    ['0.1.0', 'SHA256SUMS', '']
  ])('version %s: %s -> "%s"', (version, name, alias) => {
    const run = bash(['latest_name'], 'latest_name "$VERSION" "$NAME"', { VERSION: version, NAME: name })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toBe(alias === '' ? '' : `${alias}\n`)
  })
})

describe.skipIf(!withJq)('keep_release', () => {
  const MANIFEST = '{"cid":"bafyright","files":[{"name":"orivon_0.1.0_amd64.deb","sha256":"00"}]}'
  const RELEASE = '{"assets":[{"name":"orivon_0.1.0_amd64.deb","browser_download_url":"https://example.invalid/orivon_0.1.0_amd64.deb"}]}'

  // ADD is what the add does: fail before Kubo pins, fail after it pinned, or print a CID.
  function keep (add: string): { status: string, log: string, refused: string } {
    const work = scratch()
    const run = bash(['log', 'safe_name', 'refused', 'refuse', 'keep_release'], `
      ipfs () {
        case "$1 $2" in
          'pin ls') [ -e "$WORK/.pinned" ] ;;
          'add -r')
            case $ADD in
              fail) echo 'Error: context deadline exceeded' >&2; return 1 ;;
              late) touch "$WORK/.pinned"; echo 'Error: context deadline exceeded' >&2; return 1 ;;
              *) echo "$ADD" ;;
            esac ;;
        esac
      }
      curl () { local out; while [ $# -gt 0 ]; do [ "$1" != -o ] || out=$2; shift; done; : > "$out"; }
      sha256sum () { cat >/dev/null; }
      PIN_PREFIX=orivon-release-; ADD_FLAGS=(--cid-version=1)
      status=0; keep_release v0.1.0 bafyright "$MANIFEST" "$RELEASE" || status=$?
      echo "status=$status"`, { ADD: add, WORK: work, MANIFEST, RELEASE })
    expect(run.status, run.stderr).toBe(0)
    const refused = join(work, '.refused')
    return { status: /status=(\d+)/.exec(run.stdout)?.[1] ?? '', log: run.stdout, refused: existsSync(refused) ? readFileSync(refused, 'utf8') : '' }
  }

  it('retries a release whose add did not finish, and never refuses it', () => {
    const kept = keep('fail')
    expect(kept.status).toBe('2')
    expect(kept.log).toContain('release v0.1.0: the add did not finish; retried on the next run')
    expect(kept.refused).toBe('')
  })

  it('keeps a release Kubo pinned although the add reported an error', () => {
    const kept = keep('late')
    expect(kept.status).toBe('0')
    expect(kept.log).toContain('release v0.1.0 pinned as ipfs://bafyright, although the add reported an error')
    expect(kept.refused).toBe('')
  })

  it('refuses a release whose files add up to another CID', () => {
    const kept = keep('bafyother')
    expect(kept.status).toBe('1')
    expect(kept.refused).toBe('v0.1.0 bafyright\n')
  })

  it('keeps a release whose files add up to its CID', () => {
    const kept = keep('bafyright')
    expect(kept.status).toBe('0')
    expect(kept.log).toContain('release v0.1.0 pinned as ipfs://bafyright')
    expect(kept.refused).toBe('')
  })
})

describe.skipIf(!withJq)('sync', () => {
  it('leaves the pin of a release still being added, and points the latest key at the newest release kept', () => {
    const ipfsJson = (tag: string): object => ({ name: 'ipfs.json', browser_download_url: `https://example.invalid/${tag}/ipfs.json` })
    const releases = JSON.stringify([
      { tag_name: 'v0.0.12', draft: false, published_at: '2026-10-28T20:45:39Z', assets: [ipfsJson('v0.0.12')] },
      { tag_name: 'v0.1.0', draft: false, published_at: '2026-11-05T12:42:52Z', assets: [ipfsJson('v0.1.0')] }
    ])
    const run = bash(['log', 'safe_name', 'sync'], `
      curl () {
        case \${*: -1} in
          */releases) echo "$RELEASES" ;;
          */v0.1.0/*) echo '{"cid":"bafy010"}' ;;
          */v0.0.12/*) echo '{"cid":"bafy012"}' ;;
        esac
      }
      keep_release () { [ "$1" != v0.1.0 ] || return 2; }
      point_latest () { echo "latest $1 $2 $3"; }
      ipfs () {
        [ "$1 $2" = 'pin ls' ] || return 0
        printf '%s\\n' 'bafy010 recursive orivon-release-v0.1.0' 'bafy012 recursive orivon-release-v0.0.12' \\
          'bafy009 recursive orivon-release-v0.0.9' 'bafy777 recursive someone-else'
      }
      sync`, { RELEASES: releases, RELEASES_URL: 'https://example.invalid/releases', WORK: scratch(), KEEP: '3', PIN_PREFIX: 'orivon-release-', LATEST_KEY: 'latest-release' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('release v0.0.9 unpinned (ipfs://bafy009)')
    expect(run.stdout).not.toContain('release v0.1.0 unpinned')
    expect(run.stdout).not.toContain('someone-else')
    expect(run.stdout).toContain('latest bafy012 v0.0.12 {"cid":"bafy012"}')
  })
})

describe.skipIf(!onUnix)('point_latest', () => {
  const MANIFEST = '{"cid":"bafyrelease","add":"ipfs add -r --cid-version=1","kubo":"0.43.1","files":[]}'

  // Kubo's MFS is a folder: each file the release folder brings holds its own name, so a copy shows where it came from.
  // The draft is kept as `folder` when point_latest asks for its CID.
  function compose (listing: string[]): { folder: string, stdout: string, stderr: string } {
    const state = scratch()
    const run = bash(['log', 'safe_name', 'latest_name', 'start_page', 'point_latest'], `
      MFS=$STATE/mfs
      ipfs () {
        case "$1 $2" in
          'key list') echo 'k51latest latest-release' ;;
          'ls --resolve-type=false') echo "$LISTING" ;;
          'files rm') rm -rf "$MFS\${*: -1}" ;;
          'files cp')
            if [[ $3 == /ipfs/* ]]; then
              mkdir -p "$MFS$4"
              while read -r _ _ name; do echo "$name" > "$MFS$4/$name"; done <<<"$LISTING"
            else
              [ ! -e "$MFS$4" ] && cp "$MFS$3" "$MFS$4"
            fi ;;
          'files write') cat > "$MFS\${*: -1}" ;;
          'files stat')
            if [ "$3" != --hash ]; then [ -e "$MFS$3" ]; return; fi
            cp -r "$MFS$4" "$STATE/folder"; echo bafyfolder ;;
          'name resolve') echo /ipfs/bafyfolder ;;
        esac
      }
      point_latest bafyrelease v0.1.0 "$MANIFEST"`, {
      STATE: state, LISTING: listing.join('\n'), MANIFEST, LATEST_KEY: 'latest-release', LATEST_PIN: 'orivon-latest-release', LATEST_DRAFT: '/draft'
    })
    expect(run.status, run.stderr).toBe(0)
    return { folder: join(state, 'folder'), stdout: run.stdout, stderr: run.stderr }
  }
  const read = (folder: string, name: string): string => readFileSync(join(folder, name), 'utf8')

  it('adds each file under its version-free name, the start page and the release\'s ipfs.json', () => {
    const real = ['Orivon-Setup-0.1.0-x64.exe', 'orivon_0.1.0_amd64.deb', 'Orivon-0.1.0-arm64.dmg', 'Orivon-0.1.0-x64.dmg',
      'Orivon-0.1.0-x86_64.AppImage', 'Orivon-Setup-0.1.0-x64.voxel.exe', 'SHA256SUMS']
    const { folder } = compose(real.map((name, i) => `bafy${i} ${1e6 * (i + 1)} ${name}`))
    const aliases = {
      'Orivon-Setup-latest-x64.exe': 'Orivon-Setup-0.1.0-x64.exe',
      'orivon_latest_amd64.deb': 'orivon_0.1.0_amd64.deb',
      'Orivon-latest-arm64.dmg': 'Orivon-0.1.0-arm64.dmg',
      'Orivon-latest-x64.dmg': 'Orivon-0.1.0-x64.dmg',
      'Orivon-latest-x86_64.AppImage': 'Orivon-0.1.0-x86_64.AppImage',
      'Orivon-Setup-latest-x64.voxel.exe': 'Orivon-Setup-0.1.0-x64.voxel.exe'
    }
    expect(readdirSync(folder).sort()).toEqual([...real, ...Object.keys(aliases), 'index.html', 'ipfs.json'].sort())
    for (const [alias, name] of Object.entries(aliases)) expect(read(folder, alias)).toBe(`${name}\n`)
    expect(read(folder, 'ipfs.json')).toBe(`${MANIFEST}\n`)
    const page = read(folder, 'index.html')
    expect(page).toContain('<title>Orivon 0.1.0</title>')
    for (const name of real) expect(page).toContain(`<a href="./${name}" download>${name}</a>`)
    expect(page.match(/<li><a /g)).toHaveLength(real.length)
    expect(page).not.toContain('latest')
  })

  it('leaves a file alone when the release has one under the version-free name already', () => {
    const { folder, stderr } = compose(['bafy1 1000000 Orivon-0.1.0-x64.dmg', 'bafy2 2000000 Orivon-latest-x64.dmg'])
    expect(read(folder, 'Orivon-latest-x64.dmg')).toBe('Orivon-latest-x64.dmg\n')
    expect(stderr).toContain('Orivon-0.1.0-x64.dmg gets no version-free name, Orivon-latest-x64.dmg is refused or taken')
  })

  it('does not move the key for a release holding its own ipfs.json', () => {
    const { folder, stdout } = compose(['bafy1 1000000 Orivon-0.1.0-x64.dmg', 'bafy2 1000 ipfs.json'])
    expect(existsSync(folder)).toBe(false)
    expect(stdout).toContain("release v0.1.0: file name 'ipfs.json' refused for the start page")
  })
})

describe.skipIf(!onUnix)('the newest-release folder as ipfs-status.sh reads it', () => {
  it('holds the same files as the release it was made from', () => {
    const run = bash(['files_of'], `
      ipfs () {
        case \${*: -1} in
          bafyrelease) printf '%s\\n' 'bafyA Orivon-Setup-0.1.0-x64.exe' 'bafyB orivon_0.1.0_amd64.deb' ;;
          bafyfolder) printf '%s\\n' 'bafyB orivon_0.1.0_amd64.deb' 'bafyI index.html' 'bafyA Orivon-Setup-latest-x64.exe' \\
            'bafyJ ipfs.json' 'bafyB orivon_latest_amd64.deb' 'bafyA Orivon-Setup-0.1.0-x64.exe' ;;
        esac
      }
      TIMEOUT=5
      [ "$(files_of bafyrelease)" = "$(files_of bafyfolder)" ]
      files_of bafyfolder`, {}, STATUS)
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toBe('bafyA Orivon-Setup-0.1.0-x64.exe\nbafyB orivon_0.1.0_amd64.deb\n')
  })
})
