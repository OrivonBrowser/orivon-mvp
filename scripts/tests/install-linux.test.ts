import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Runs scripts/install-linux.sh in a scratch HOME against a stand-in `curl` that serves a made-up release list
// and a made-up AppImage, so nothing is downloaded and nothing starts. Linux and macOS have bash; Windows does not.
const SCRIPT = join(process.cwd(), 'scripts', 'install-linux.sh')
const onUnix = process.platform !== 'win32'

/** What a stand-in AppImage does when asked to unpack itself: a whole tree, a failure, or a tree with no AppRun. */
type Unpacking = 'tree' | 'fails' | 'no-apprun'

const STAND_IN_APPRUN = '#!/bin/sh\necho "$@" > "$ORIVON_TEST_STARTED"\n'

/** The stand-in AppImage, as a shell script. `--appimage-extract` writes squashfs-root in the working folder, as the real
 * runtime does with no FUSE: an icon, the version (the script's last line), and a stand-in AppRun that records what it was
 * started with. Run any other way it records that, so a test can tell the AppImage itself was started. */
function appImageScript (unpacking: Unpacking): string {
  const extract = unpacking === 'fails'
    ? ['  echo "FATAL: no space left on device" >&2', '  exit 1']
    : [
        '  mkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps',
        '  echo icon > squashfs-root/usr/share/icons/hicolor/512x512/apps/orivon.png',
        '  tail -n 1 "$0" > squashfs-root/version',
        ...(unpacking === 'tree'
          ? [
              `  printf '%s' '${STAND_IN_APPRUN}' > squashfs-root/AppRun`,
              "  printf '#!/bin/sh\\nexit 0\\n' > squashfs-root/orivon",
              '  chmod 755 squashfs-root/AppRun squashfs-root/orivon'
            ]
          : []),
        '  exit 0'
      ]
  return ['#!/bin/sh', 'if [ "$1" = "--appimage-extract" ]; then', ...extract, 'fi', 'echo "the AppImage was started itself: $@" > "$ORIVON_TEST_STARTED"', ''].join('\n')
}

const CURL = `#!/bin/sh
# Stands in for curl: the release list, one AppImage per file name, nothing else.
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -H) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
case "$url" in
  *"/releases?"*)
    # An empty list as many times as empty-answers says, the way GitHub now and then answers, then the real one.
    n=$(cat "$FIXTURES/empty-answers" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FIXTURES/empty-answers"; printf '[\n\n]\n'; else cat "$FIXTURES/releases.json"; fi ;;
  *.AppImage) cp "$FIXTURES/$(basename "$url")" "$out" ;;
  *) exit 22 ;;
esac
`

interface Asset { name: string, digest?: string }
interface Release { tag: string, draft?: boolean, assets?: Asset[], body?: string }

let root: string
let home: string
let fixtures: string
let toolDir: string
let started: string

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** One AppImage file per version, so a different version can be told apart on disk. */
function appImageFor (version: string, unpacking: Unpacking = 'tree'): { name: string, digest: string } {
  const body = `${appImageScript(unpacking)}# ${version}\n`
  const name = `Orivon-${version}-x86_64.AppImage`
  writeFileSync(join(fixtures, name), body)
  return { name, digest: `sha256:${sha(body)}` }
}

function publish (releases: Release[]): void {
  writeFileSync(join(fixtures, 'releases.json'), JSON.stringify(releases.map((release) => ({
    tag_name: release.tag,
    draft: release.draft === true,
    prerelease: true,
    body: release.body ?? '',
    assets: (release.assets ?? []).map((asset) => ({ name: asset.name, browser_download_url: `https://example.test/${asset.name}`, ...(asset.digest === undefined ? {} : { digest: asset.digest }) }))
  }))))
}

function withImage (tag: string, tamper?: (asset: { name: string, digest: string }) => Asset, unpacking: Unpacking = 'tree'): Release {
  const made = appImageFor(tag.replace(/^v/, ''), unpacking)
  return { tag, assets: [tamper === undefined ? made : tamper(made)] }
}

function run (args: string[] = [], env: Record<string, string> = {}, cwd?: string): { status: number | null, out: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    ...(cwd === undefined ? {} : { cwd }),
    env: { PATH: `${toolDir}:${process.env['PATH'] ?? ''}`, HOME: home, FIXTURES: fixtures, ORIVON_TEST_STARTED: started, ...env }
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

const lib = (): string => join(home, '.local', 'lib', 'orivon')
const app = (): string => join(lib(), 'app')
const installedVersion = (): string => readFileSync(join(app(), 'version'), 'utf8').trim()
/** What is in the install folder, a working folder or a leftover of the swap included. */
const libEntries = (): string[] => readdirSync(lib()).sort()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orivon-install-linux-'))
  home = join(root, 'home')
  fixtures = join(root, 'fixtures')
  toolDir = join(root, 'tools')
  started = join(root, 'started')
  for (const dir of [home, fixtures, toolDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(toolDir, 'curl'), CURL)
  chmodSync(join(toolDir, 'curl'), 0o755)
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe.skipIf(!onUnix)('scripts/install-linux.sh', () => {
  it('installs the newest version, pre-releases counted, drafts and non-version tags and a release with no AppImage skipped', () => {
    publish([
      { tag: 'pre-releases', assets: [appImageFor('9.9.9')] },
      { ...withImage('v0.0.9'), draft: true },
      { tag: 'v0.1.0', assets: [] },
      withImage('v0.0.8'),
      withImage('v0.0.10-rc.1'),
      withImage('v0.0.10-rc.2'),
      withImage('v0.0.7')
    ])
    const { status, out } = run(['--no-launch'])
    expect(out).toContain('Installed Orivon v0.0.10-rc.2')
    expect(status).toBe(0)
    expect(installedVersion()).toBe('# 0.0.10-rc.2')
  })

  it('ranks a release above its own pre-releases and 0.0.10 above 0.0.9', () => {
    publish([withImage('v0.0.10-rc.1'), withImage('v0.0.10'), withImage('v0.0.9')])
    expect(run(['--no-launch']).status).toBe(0)
    expect(installedVersion()).toBe('# 0.0.10')
  })

  it('reads a release list larger than one command-line argument can carry (Linux caps one at 128 KiB)', () => {
    const notes = 'Release notes, as long as GitHub keeps them. '.repeat(1500)
    publish([withImage('v0.0.11'), ...Array.from({ length: 29 }, (_, i) => ({ ...withImage(`v0.0.${10 - (i % 10)}-rc.${i}`), body: notes }))])
    expect(statSync(join(fixtures, 'releases.json')).size).toBeGreaterThan(1024 * 1024)
    const { status, out } = run(['--no-launch'])
    expect(out).toContain('Installed Orivon v0.0.11')
    expect(status).toBe(0)
  })

  it('unpacks the app once beside a launcher, keeps no AppImage, and writes the icon and a desktop entry that lists http and https', () => {
    publish([withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    expect((lstatSync(join(app(), 'AppRun')).mode & 0o111) !== 0).toBe(true)
    expect((lstatSync(join(lib(), 'orivon')).mode & 0o111) !== 0).toBe(true)
    expect(libEntries()).toEqual(['app', 'orivon'])
    expect(readFileSync(join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'orivon.png'), 'utf8')).toBe('icon\n')
    const entry = readFileSync(join(home, '.local', 'share', 'applications', 'orivon.desktop'), 'utf8')
    expect(entry).toContain(`Exec="${join(lib(), 'orivon')}" %U`)
    expect(entry).toMatch(/^MimeType=.*x-scheme-handler\/http;x-scheme-handler\/https;$/m)
    expect(entry).toContain('Icon=orivon')
    expect(entry).toContain('StartupWMClass=orivon')
    expect(existsSync(started)).toBe(false)
  })

  it('updates in place when run again, and leaves no temporary file or old tree behind', () => {
    publish([withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    publish([withImage('v0.0.9'), withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    expect(installedVersion()).toBe('# 0.0.9')
    expect(libEntries()).toEqual(['app', 'orivon'])
  })

  it('updates while Orivon runs: the running program keeps the files it opened, and the next start is the new version', async () => {
    publish([withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    // A stand-in for the running browser: it opens a file of the old tree, says so, and reads it after the update.
    const running = spawn('sh', ['-c', 'exec 3<"$1"; echo open; read go; cat <&3', 'sh', join(app(), 'version')], { stdio: ['pipe', 'pipe', 'inherit'] })
    let seen = ''
    running.stdout.setEncoding('utf8')
    running.stdout.on('data', (chunk: string) => { seen += chunk })
    for (let waited = 0; waited < 10_000 && !seen.includes('open'); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toContain('open')
    const finished = new Promise<void>((resolve) => { running.on('close', () => { resolve() }) })
    publish([withImage('v0.0.9'), withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    running.stdin.write('go\n')
    await finished
    expect(seen).toContain('# 0.0.8')
    expect(installedVersion()).toBe('# 0.0.9')
    expect(libEntries()).toEqual(['app', 'orivon'])
  })

  it('converts an install that kept the AppImage: the AppImage goes, the launcher and the link stay valid', () => {
    mkdirSync(lib(), { recursive: true })
    writeFileSync(join(lib(), 'Orivon.AppImage'), '#!/bin/sh\n# 0.0.7\n')
    writeFileSync(join(lib(), 'orivon'), '#!/bin/sh\nexec "$(dirname "$0")/Orivon.AppImage" "$@"\n')
    chmodSync(join(lib(), 'Orivon.AppImage'), 0o755)
    chmodSync(join(lib(), 'orivon'), 0o755)
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    symlinkSync(join(lib(), 'orivon'), join(home, '.local', 'bin', 'orivon'))
    publish([withImage('v0.0.8')])
    const { status, out } = run(['--no-launch'], { PATH: `${join(home, '.local', 'bin')}:${toolDir}:${process.env['PATH'] ?? ''}` })
    expect(status, out).toBe(0)
    expect(out).toContain('Converted the earlier install')
    expect(libEntries()).toEqual(['app', 'orivon'])
    expect(installedVersion()).toBe('# 0.0.8')
    expect(readFileSync(join(lib(), 'orivon'), 'utf8')).toContain('app/AppRun')
    expect(readlinkSync(join(home, '.local', 'bin', 'orivon'))).toBe(join(lib(), 'orivon'))
    expect(spawnSync(join(home, '.local', 'bin', 'orivon'), ['--new-window'], { env: { ORIVON_TEST_STARTED: started } }).status).toBe(0)
    expect(readFileSync(started, 'utf8').trim()).toBe('--new-window')
  })

  it('changes nothing when the AppImage cannot be unpacked, and says why', () => {
    publish([withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    publish([withImage('v0.0.9', undefined, 'fails'), withImage('v0.0.8')])
    const { status, out } = run(['--no-launch'])
    expect(status).toBe(1)
    expect(out).toContain('Unpacking Orivon failed')
    expect(out).toContain('no space left on device')
    expect(out).toContain('Nothing was changed')
    expect(installedVersion()).toBe('# 0.0.8')
    expect(libEntries()).toEqual(['app', 'orivon'])
  })

  it('refuses an AppImage that unpacks without an AppRun, and installs nothing', () => {
    publish([withImage('v0.0.8', undefined, 'no-apprun')])
    const { status, out } = run(['--no-launch'])
    expect(status).toBe(1)
    expect(out).toContain('without an AppRun')
    expect(existsSync(app())).toBe(false)
    expect(existsSync(join(lib(), 'orivon'))).toBe(false)
  })

  it('puts back the tree an interrupted update had set aside, and clears its other leftovers', () => {
    publish([withImage('v0.0.9', undefined, 'fails')])
    mkdirSync(join(lib(), 'app.old'), { recursive: true })
    writeFileSync(join(lib(), 'app.old', 'version'), '# 0.0.7\n')
    mkdirSync(join(lib(), 'app.new'))
    mkdirSync(join(lib(), '.install.abc123'))
    expect(run(['--no-launch']).status).toBe(1)
    expect(installedVersion()).toBe('# 0.0.7')
    expect(libEntries()).toEqual(['app'])
  })

  it('installs a local AppImage that is not executable, never changing the file, and one named by a relative path', () => {
    const made = appImageFor('0.0.5')
    const file = join(fixtures, made.name)
    chmodSync(file, 0o644)
    const { status, out } = run(['--no-launch'], { ORIVON_APPIMAGE: made.name }, fixtures)
    expect(status, out).toBe(0)
    expect(installedVersion()).toBe('# 0.0.5')
    expect(statSync(file).mode & 0o111).toBe(0)
    expect(libEntries()).toEqual(['app', 'orivon'])
  })

  it('refuses a download that does not match the digest GitHub reports, and installs nothing', () => {
    publish([withImage('v0.0.8', (made) => ({ ...made, digest: `sha256:${'0'.repeat(64)}` }))])
    const { status, out } = run(['--no-launch'])
    expect(status).toBe(1)
    expect(out).toContain('does not match the SHA-256')
    expect(existsSync(app())).toBe(false)
  })

  it.each([
    ['no digest', (made: { name: string }): Asset => ({ name: made.name })],
    ['a digest that is not sha256', (made: { name: string }): Asset => ({ name: made.name, digest: 'md5:abc' })]
  ])('refuses an AppImage with %s', (_label, tamper) => {
    publish([withImage('v0.0.8', tamper)])
    const { status, out } = run(['--no-launch'])
    expect(status).toBe(1)
    expect(out).toContain('reports no SHA-256')
    expect(existsSync(app())).toBe(false)
  })

  it('says so when no release has an AppImage', () => {
    publish([{ tag: 'v0.0.8', assets: [{ name: 'Orivon-0.0.8-arm64.dmg', digest: `sha256:${'a'.repeat(64)}` }] }])
    const { status, out } = run(['--no-launch'])
    expect(status).toBe(1)
    expect(out).toContain('No release')
  })

  it('asks again when GitHub answers the release list with an empty array, and installs', () => {
    publish([withImage('v0.0.9')])
    writeFileSync(join(fixtures, 'empty-answers'), '2')
    const { status, out } = run(['--no-launch'])
    expect(status, out).toBe(0)
    expect(installedVersion()).toBe('# 0.0.9')
  })

  it('says there is no release after three empty answers', () => {
    publish([withImage('v0.0.9')])
    writeFileSync(join(fixtures, 'empty-answers'), '3')
    const { status, out } = run(['--no-launch'])
    expect(status).toBe(1)
    expect(out).toContain('No release')
  })

  it('reads the release list with jq when python3 is not there', () => {
    const jq = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim()
    if (jq === '') return
    publish([withImage('v0.0.8'), withImage('v0.0.10-rc.1'), withImage('v0.0.10-rc.2'), withImage('v0.0.9')])
    // A folder holding only the commands the script uses, jq among them and python3 not.
    const lean = join(root, 'lean')
    mkdirSync(lean)
    for (const tool of ['uname', 'mktemp', 'mkdir', 'sed', 'grep', 'cut', 'sha256sum', 'cp', 'chmod', 'mv', 'ln', 'readlink', 'cat', 'find', 'sort', 'tail', 'rm', 'dirname', 'basename', 'env', 'sh', 'head']) {
      const path = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      if (path !== '') symlinkSync(path, join(lean, tool))
    }
    symlinkSync(jq, join(lean, 'jq'))
    symlinkSync(join(toolDir, 'curl'), join(lean, 'curl'))
    const bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
    const result = spawnSync(bash, [SCRIPT, '--no-launch'], {
      encoding: 'utf8',
      env: { PATH: lean, HOME: home, FIXTURES: fixtures, ORIVON_TEST_STARTED: started }
    })
    expect(result.stderr).not.toContain('python3')
    expect(result.status).toBe(0)
    expect(installedVersion()).toBe('# 0.0.10-rc.2')
  })

  describe('the app id and the options', () => {
    it.each(['A', 'a', 'has-dash', 'x'.repeat(25), 'UPPER', 'two words', '../x'])('refuses the app id %s', (id) => {
      publish([withImage('v0.0.8')])
      const { status, out } = run(['--no-launch', id])
      expect(status).toBe(1)
      expect(out).toContain('app id')
      expect(existsSync(app())).toBe(false)
    })

    it('works piped into bash, the way curl hands it over, with the id after -s', async () => {
      publish([withImage('v0.0.8')])
      const result = spawnSync('bash', ['-s', '--', 'ab12'], {
        input: readFileSync(SCRIPT, 'utf8'),
        encoding: 'utf8',
        env: { PATH: `${toolDir}:${process.env['PATH'] ?? ''}`, HOME: home, FIXTURES: fixtures, ORIVON_TEST_STARTED: started }
      })
      expect(result.status).toBe(0)
      await waitForFile(started)
      expect(readFileSync(started, 'utf8').trim()).toBe('--orivon-flavour=ab12')
    })

    it('refuses an unknown option and a second id', () => {
      expect(run(['--nope']).status).toBe(1)
      expect(run(['abc', 'def', '--no-launch']).status).toBe(1)
    })

    it('starts Orivon with --orivon-flavour=<id> on the first launch, and with nothing extra without an id', async () => {
      publish([withImage('v0.0.8')])
      expect(run(['ab12']).status).toBe(0)
      await waitForFile(started)
      expect(readFileSync(started, 'utf8').trim()).toBe('--orivon-flavour=ab12')
      rmSync(started)
      expect(run().status).toBe(0)
      await waitForFile(started)
      expect(readFileSync(started, 'utf8').trim()).toBe('')
    })

    it('does not start Orivon with --no-launch or ORIVON_NO_OPEN=1', async () => {
      publish([withImage('v0.0.8')])
      expect(run(['ab12', '--no-launch']).status).toBe(0)
      expect(run([], { ORIVON_NO_OPEN: '1' }).status).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(existsSync(started)).toBe(false)
    })
  })

  describe('the command on the path', () => {
    it('is a link to the launcher when ~/.local/bin is on the path', () => {
      publish([withImage('v0.0.8')])
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      const { status, out } = run(['--no-launch'], { PATH: `${join(home, '.local', 'bin')}:${toolDir}:${process.env['PATH'] ?? ''}` })
      expect(status).toBe(0)
      expect(readlinkSync(join(home, '.local', 'bin', 'orivon'))).toBe(join(lib(), 'orivon'))
      expect(out).toContain('Start it from a terminal with: orivon')
    })

    it('is not made when ~/.local/bin is not on the path, and the message names the launcher instead', () => {
      publish([withImage('v0.0.8')])
      const { out } = run(['--no-launch'])
      expect(existsSync(join(home, '.local', 'bin', 'orivon'))).toBe(false)
      expect(out).toContain(`Start it from a terminal with: ${join(lib(), 'orivon')}`)
    })

    it('never replaces a file that is not Orivon\'s launcher', () => {
      publish([withImage('v0.0.8')])
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      writeFileSync(join(home, '.local', 'bin', 'orivon'), 'mine')
      const { status, out } = run(['--no-launch'], { PATH: `${join(home, '.local', 'bin')}:${toolDir}:${process.env['PATH'] ?? ''}` })
      expect(status).toBe(0)
      expect(readFileSync(join(home, '.local', 'bin', 'orivon'), 'utf8')).toBe('mine')
      expect(out).toContain('left alone')
    })
  })

  describe('the launcher', () => {
    const launch = (path: string, ...args: string[]): ReturnType<typeof spawnSync> => spawnSync(path, args, { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ORIVON_TEST_STARTED: started } })
    const start = (...args: string[]): string => {
      const result = launch(join(lib(), 'orivon'), ...args)
      expect(result.status).toBe(0)
      return readFileSync(started, 'utf8').trim()
    }

    beforeEach(() => {
      publish([withImage('v0.0.8')])
      expect(run(['--no-launch']).status).toBe(0)
    })

    it('runs the unpacked app\'s AppRun with the arguments it was given, and needs neither FUSE nor the AppImage', () => {
      expect(start('https://example.test/', '--new-window')).toBe('https://example.test/ --new-window')
    })

    it('finds the app through a link to it, as ~/.local/bin/orivon is', () => {
      const link = join(root, 'link-to-orivon')
      symlinkSync(join(lib(), 'orivon'), link)
      expect(launch(link, '--new-private-window').status).toBe(0)
      expect(readFileSync(started, 'utf8').trim()).toBe('--new-private-window')
    })

    it('says to run the install command again when the app is gone', () => {
      rmSync(app(), { recursive: true })
      const result = launch(join(lib(), 'orivon'))
      expect(result.status).toBe(1)
      expect(String(result.stderr)).toContain('run the install command again')
      expect(existsSync(started)).toBe(false)
    })
  })
})

async function waitForFile (path: string): Promise<void> {
  // The launch is detached, so the file appears after the script has returned.
  for (let waited = 0; waited < 10_000 && !existsSync(path); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
  expect(existsSync(path)).toBe(true)
}
