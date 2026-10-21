import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Runs scripts/install-linux.sh in a scratch HOME against a stand-in `curl` that serves a made-up release list
// and a made-up AppImage, so nothing is downloaded and nothing starts. Linux and macOS have bash; Windows does not.
const SCRIPT = join(process.cwd(), 'scripts', 'install-linux.sh')
const onUnix = process.platform !== 'win32'

const APPIMAGE = `#!/bin/sh
# Stands in for the AppImage: unpacks an icon on --appimage-extract, otherwise records what it was started with.
if [ "$1" = "--appimage-extract" ]; then
  mkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps
  echo icon > squashfs-root/usr/share/icons/hicolor/512x512/apps/orivon.png
  exit 0
fi
echo "$@" > "$ORIVON_TEST_STARTED"
`

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
  *"/releases?"*) cat "$FIXTURES/releases.json" ;;
  *.AppImage) cp "$FIXTURES/$(basename "$url")" "$out" ;;
  *) exit 22 ;;
esac
`

/** The three things the launcher needs before it lets the AppImage mount itself, made by stand-ins so no machine decides. */
const FAKE_FUSERMOUNT = '#!/bin/sh\nexit 0\n'
const FAKE_LDCONFIG = '#!/bin/sh\necho "\tlibfuse.so.2 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libfuse.so.2"\n'

interface Asset { name: string, digest?: string }
interface Release { tag: string, draft?: boolean, assets?: Asset[] }

let root: string
let home: string
let fixtures: string
let toolDir: string
let started: string
let fuseUsable: Record<string, string>
let fuseUnusable: Record<string, string>

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** One AppImage file per version, so a different version can be told apart on disk. */
function appImageFor (version: string): { name: string, digest: string } {
  const body = `${APPIMAGE}# ${version}\n`
  const name = `Orivon-${version}-x86_64.AppImage`
  writeFileSync(join(fixtures, name), body)
  return { name, digest: `sha256:${sha(body)}` }
}

function publish (releases: Release[]): void {
  writeFileSync(join(fixtures, 'releases.json'), JSON.stringify(releases.map((release) => ({
    tag_name: release.tag,
    draft: release.draft === true,
    prerelease: true,
    assets: (release.assets ?? []).map((asset) => ({ name: asset.name, browser_download_url: `https://example.test/${asset.name}`, ...(asset.digest === undefined ? {} : { digest: asset.digest }) }))
  }))))
}

function withImage (tag: string, tamper?: (asset: { name: string, digest: string }) => Asset): Release {
  const made = appImageFor(tag.replace(/^v/, ''))
  return { tag, assets: [tamper === undefined ? made : tamper(made)] }
}

function run (args: string[] = [], env: Record<string, string> = {}): { status: number | null, out: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${toolDir}:${process.env['PATH'] ?? ''}`, HOME: home, TMPDIR: root, FIXTURES: fixtures, ORIVON_TEST_STARTED: started, ...fuseUsable, ...env }
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

const lib = (): string => join(home, '.local', 'lib', 'orivon')
const installedVersion = (): string => readFileSync(join(lib(), 'Orivon.AppImage'), 'utf8').trim().split('\n').at(-1) ?? ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orivon-install-linux-'))
  home = join(root, 'home')
  fixtures = join(root, 'fixtures')
  toolDir = join(root, 'tools')
  started = join(root, 'started')
  for (const dir of [home, fixtures, toolDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(toolDir, 'curl'), CURL)
  writeFileSync(join(toolDir, 'fusermount'), FAKE_FUSERMOUNT)
  writeFileSync(join(toolDir, 'ldconfig'), FAKE_LDCONFIG)
  for (const tool of ['curl', 'fusermount', 'ldconfig']) chmodSync(join(toolDir, tool), 0o755)
  writeFileSync(join(root, 'fuse-device'), '')
  // Every launch starts from "FUSE works", and a test that wants it not to say so; neither depends on this machine's /dev/fuse.
  fuseUsable = { ORIVON_FUSE_DEVICE: join(root, 'fuse-device') }
  fuseUnusable = { ORIVON_FUSE_DEVICE: join(root, 'no-such-device') }
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

  it('writes the AppImage, the launcher, the icon and a desktop entry that lists http and https', () => {
    publish([withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    expect((lstatSync(join(lib(), 'Orivon.AppImage')).mode & 0o111) !== 0).toBe(true)
    expect((lstatSync(join(lib(), 'orivon')).mode & 0o111) !== 0).toBe(true)
    expect(readFileSync(join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps', 'orivon.png'), 'utf8')).toBe('icon\n')
    const entry = readFileSync(join(home, '.local', 'share', 'applications', 'orivon.desktop'), 'utf8')
    expect(entry).toContain(`Exec="${join(lib(), 'orivon')}" %U`)
    expect(entry).toMatch(/^MimeType=.*x-scheme-handler\/http;x-scheme-handler\/https;$/m)
    expect(entry).toContain('Icon=orivon')
    expect(entry).toContain('StartupWMClass=orivon')
    expect(existsSync(started)).toBe(false)
  })

  it('updates in place when run again, and leaves no temporary file behind', () => {
    publish([withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    publish([withImage('v0.0.9'), withImage('v0.0.8')])
    expect(run(['--no-launch']).status).toBe(0)
    expect(installedVersion()).toBe('# 0.0.9')
    expect(existsSync(join(lib(), 'Orivon.AppImage.new'))).toBe(false)
    expect(existsSync(join(lib(), 'orivon.new'))).toBe(false)
  })

  it('refuses a download that does not match the digest GitHub reports, and installs nothing', () => {
    publish([withImage('v0.0.8', (made) => ({ ...made, digest: `sha256:${'0'.repeat(64)}` }))])
    const { status, out } = run(['--no-launch'])
    expect(status).toBe(1)
    expect(out).toContain('does not match the SHA-256')
    expect(existsSync(join(lib(), 'Orivon.AppImage'))).toBe(false)
  })

  it.each([
    ['no digest', (made: { name: string }): Asset => ({ name: made.name })],
    ['a digest that is not sha256', (made: { name: string }): Asset => ({ name: made.name, digest: 'md5:abc' })]
  ])('refuses an AppImage with %s', (_label, tamper) => {
    publish([withImage('v0.0.8', tamper)])
    const { status, out } = run(['--no-launch'])
    expect(status).toBe(1)
    expect(out).toContain('reports no SHA-256')
    expect(existsSync(join(lib(), 'Orivon.AppImage'))).toBe(false)
  })

  it('says so when no release has an AppImage', () => {
    publish([{ tag: 'v0.0.8', assets: [{ name: 'Orivon-0.0.8-arm64.dmg', digest: `sha256:${'a'.repeat(64)}` }] }])
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
      env: { PATH: lean, HOME: home, TMPDIR: root, FIXTURES: fixtures, ORIVON_TEST_STARTED: started }
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
      expect(existsSync(join(lib(), 'Orivon.AppImage'))).toBe(false)
    })

    it('works piped into bash, the way curl hands it over, with the id after -s', async () => {
      publish([withImage('v0.0.8')])
      const result = spawnSync('bash', ['-s', '--', 'ab12'], {
        input: readFileSync(SCRIPT, 'utf8'),
        encoding: 'utf8',
        env: { PATH: `${toolDir}:${process.env['PATH'] ?? ''}`, HOME: home, TMPDIR: root, FIXTURES: fixtures, ORIVON_TEST_STARTED: started, ...fuseUsable }
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

    it('hands the id on after the unpacking switch when the AppImage cannot mount itself', async () => {
      publish([withImage('v0.0.8')])
      expect(run(['ab12'], fuseUnusable).status).toBe(0)
      await waitForFile(started)
      expect(readFileSync(started, 'utf8').trim()).toBe('--appimage-extract-and-run --orivon-flavour=ab12')
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
    function start (...args: string[]): string {
      const result = spawnSync(join(lib(), 'orivon'), args, { encoding: 'utf8', env: { PATH: `${toolDir}:${process.env['PATH'] ?? ''}`, ORIVON_TEST_STARTED: started, ...fuseEnv } })
      expect(result.status).toBe(0)
      return readFileSync(started, 'utf8').trim()
    }
    let fuseEnv: Record<string, string> = {}

    beforeEach(() => {
      fuseEnv = fuseUsable
      publish([withImage('v0.0.8')])
      expect(run(['--no-launch']).status).toBe(0)
    })

    it('unpacks and runs when the FUSE device cannot be used', () => {
      fuseEnv = fuseUnusable
      expect(start('https://example.test/')).toBe('--appimage-extract-and-run https://example.test/')
    })

    it('runs the AppImage itself when the device, fusermount and libfuse.so.2 are all there', () => {
      expect(start('--new-window')).toBe('--new-window')
    })
  })
})

async function waitForFile (path: string): Promise<void> {
  // The launch is detached, so the file appears after the script has returned.
  for (let waited = 0; waited < 10_000 && !existsSync(path); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
  expect(existsSync(path)).toBe(true)
}
