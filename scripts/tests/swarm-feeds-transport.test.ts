import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { clearWork, kuboClient, packSite } from '../swarm-feeds/kubo.mjs'
import { parseSshUrl, readRemoteFile, shellQuote, sshArgv } from '../swarm-feeds/ssh.mjs'
import type { SpawnFn } from '../swarm-feeds/ssh.mjs'
import { cid, makeRun } from './swarm-feeds.test-helpers.js'

interface Answer { stdout?: string | Buffer | Buffer[], code?: number, stderr?: string }

/** `ssh` as a function: each call is recorded, and answered from `answer(argv)`. Like a real child, it closes after its output ends. */
function fakeSpawn (answer: (argv: string[]) => Answer) {
  const calls: { command: string, argv: string[], options: unknown }[] = []
  const killed: string[] = []
  const spawnFn = ((command: string, argv: string[], options: unknown) => {
    calls.push({ command, argv, options })
    const { stdout = '', code = 0, stderr = '' } = answer(argv)
    const child = new EventEmitter() as EventEmitter & { stdout: Readable, stderr: Readable, exitCode: number | null, kill: () => boolean }
    child.exitCode = null
    child.kill = () => { killed.push(argv.at(-1)!); return true }
    const parts = Array.isArray(stdout) ? stdout : [Buffer.from(stdout)]
    child.stdout = Readable.from(parts, { objectMode: false })
    child.stderr = Readable.from([Buffer.from(stderr)], { objectMode: false })
    let open = 2
    const done = (): void => { if (--open === 0) setImmediate(() => { child.exitCode = code; child.emit('close', code, null) }) }
    child.stdout.on('end', done)
    child.stderr.on('end', done)
    return child
  }) as unknown as SpawnFn
  return { calls, killed, spawnFn }
}

const CURL = (url: string): string => `curl -sS --fail -X POST '${url}'`

describe('ssh addresses', () => {
  it('reads user, host, port and path, and refuses anything that could be taken for an option', () => {
    expect(parseSshUrl('ssh://ubuntu@vps.example', { path: false })).toEqual({ user: 'ubuntu', host: 'vps.example', port: undefined, path: undefined })
    expect(parseSshUrl('ssh://me@10.0.0.2:2222/home/me/names.conf', { path: true })).toEqual({ user: 'me', host: '10.0.0.2', port: '2222', path: '/home/me/names.conf' })
    expect(parseSshUrl('http://127.0.0.1:5001', { path: false })).toBeNull()
    for (const bad of ['ssh://-oProxyCommand=x@host', 'ssh://me@-host', 'ssh://me@host:99999', 'ssh://host', 'ssh://me@host/path', 'ssh://me@ho st']) {
      expect(() => parseSshUrl(bad, { path: false })).toThrow()
    }
    expect(() => parseSshUrl('ssh://me@host', { path: true })).toThrow(/absolute path/)
  })
  it('quotes a value as one shell word, whatever it holds', () => {
    expect(shellQuote('plain')).toBe("'plain'")
    expect(shellQuote("it's; rm -rf ~")).toBe("'it'\\''s; rm -rf ~'")
    expect(sshArgv({ user: 'u', host: 'h', port: '22' }, 'true')).toEqual(['-o', 'BatchMode=yes', '-p', '22', 'u@h', 'true'])
    expect(sshArgv({ user: 'u', host: 'h', port: undefined }, 'true')).toEqual(['-o', 'BatchMode=yes', 'u@h', 'true'])
  })
})

describe('Kubo over ssh', () => {
  it('runs each RPC call as curl against the remote loopback address, and reads the JSON it prints', async () => {
    const { calls, spawnFn } = fakeSpawn((argv) => {
      const command = argv.at(-1)!
      if (command.includes('key/list')) return { stdout: JSON.stringify({ Keys: [{ Name: 'self', Id: 'k51self' }, { Name: 'explore', Id: 'k51explore' }] }) }
      return { stdout: JSON.stringify({ Path: `/ipfs/${cid('a')}` }) }
    })
    const kubo = kuboClient({ api: 'ssh://ubuntu@vps.example:2200', spawnFn })
    expect(await kubo.keys()).toEqual([{ name: 'explore', id: 'k51explore' }])
    expect(await kubo.resolve('k51explore')).toBe(cid('a'))
    expect(calls.map((c) => [c.command, ...c.argv])).toEqual([
      ['ssh', '-o', 'BatchMode=yes', '-p', '2200', 'ubuntu@vps.example', CURL('http://127.0.0.1:5001/api/v0/key/list?l=true&ipns-base=base36')],
      ['ssh', '-o', 'BatchMode=yes', '-p', '2200', 'ubuntu@vps.example', CURL('http://127.0.0.1:5001/api/v0/name/resolve?arg=%2Fipns%2Fk51explore&offline=true')]
    ])
  })
  it('uses the RPC address it is given, and quotes an id that holds a quote', async () => {
    const { calls, spawnFn } = fakeSpawn(() => ({ stdout: JSON.stringify({ Path: `/ipfs/${cid('a')}` }) }))
    const kubo = kuboClient({ api: 'ssh://u@h', rpc: 'http://127.0.0.1:15001', spawnFn })
    await kubo.resolve("x'$(id)")
    expect(calls[0]!.argv.at(-1)).toBe(CURL("http://127.0.0.1:15001/api/v0/name/resolve?arg=%2Fipns%2Fx'\\''%24(id)&offline=true"))
    expect(() => kuboClient({ api: 'ssh://u@h', rpc: "http://x'; id", spawnFn })).toThrow(/IPFS_SSH_RPC/)
    await expect(kubo.archive("not a cid'")).rejects.toThrow(/not a CID/)
  })
  it('turns a non-zero exit into a failed request that carries what ssh or curl said', async () => {
    const { spawnFn } = fakeSpawn(() => ({ code: 255, stderr: 'ssh: connect to host vps.example port 22: Connection timed out\n' }))
    const kubo = kuboClient({ api: 'ssh://u@h', spawnFn })
    await expect(kubo.keys()).rejects.toThrow(/Kubo key\/list over ssh failed \(exit 255\): ssh: connect to host vps.example port 22: Connection timed out/)
    const failing = fakeSpawn(() => ({ code: 22, stderr: 'curl: (22) The requested URL returned error: 500' }))
    await expect(kuboClient({ api: 'ssh://u@h', spawnFn: failing.spawnFn }).resolve('k51x')).rejects.toThrow(/exit 22.*returned error: 500/)
  })
  it('streams the archive as the remote command prints it, and ends the stream with an error when the command fails', async () => {
    const parts = [Buffer.from('first '), Buffer.from('second '), Buffer.from('third')]
    const ok = fakeSpawn(() => ({ stdout: parts }))
    const stream = await kuboClient({ api: 'ssh://u@h', spawnFn: ok.spawnFn }).archive(cid('a'))
    const chunks: string[] = []
    for await (const chunk of stream) chunks.push(String(chunk))
    expect(chunks.join('')).toBe('first second third')
    expect(ok.calls[0]!.argv.at(-1)).toBe(CURL(`http://127.0.0.1:5001/api/v0/get?arg=%2Fipfs%2F${cid('a')}&archive=true`))
    const broken = fakeSpawn(() => ({ stdout: parts.slice(0, 1), code: 255, stderr: 'Connection reset by peer' }))
    const cut = await kuboClient({ api: 'ssh://u@h', spawnFn: broken.spawnFn }).archive(cid('a'))
    await expect((async () => { for await (const chunk of cut) void chunk })()).rejects.toThrow(/exit 255.*Connection reset by peer/)
  })
  it('stops the remote download when the consumer gives up', async () => {
    const { killed, spawnFn } = fakeSpawn(() => ({ stdout: [Buffer.from('a'), Buffer.from('b')] }))
    const stream = await kuboClient({ api: 'ssh://u@h', spawnFn }).archive(cid('a'))
    const closed = once(stream, 'close')
    stream.destroy()
    await closed
    expect(killed).toHaveLength(1)
  })
  it('reads a file on the remote machine with cat, the path quoted', async () => {
    const { calls, spawnFn } = fakeSpawn(() => ({ stdout: 'explore a.eth\n' }))
    expect(await readRemoteFile("ssh://me@h:2200/home/me/it's names.conf", spawnFn)).toBe('explore a.eth\n')
    expect(calls[0]!.argv).toEqual(['-o', 'BatchMode=yes', '-p', '2200', 'me@h', "cat -- '/home/me/it'\\''s names.conf'"])
    const missing = fakeSpawn(() => ({ code: 1, stderr: 'cat: /x: No such file or directory' }))
    await expect(readRemoteFile('ssh://me@h/x', missing.spawnFn)).rejects.toThrow(/exit 1.*No such file/)
  })
})

describe('sync with Kubo and the names file behind ssh', () => {
  const runs: ReturnType<typeof makeRun>[] = []
  afterEach(() => { for (const r of runs.splice(0)) r.cleanup() })

  it('reads the names and asks Kubo only through ssh, and publishes as usual', async () => {
    const env = { IPFS_API: 'ssh://ubuntu@vps.example', NAMES_FILE: 'ssh://ubuntu@vps.example/srv/status/names.conf' }
    let world: ReturnType<typeof makeRun>['world'] | undefined
    const { calls, spawnFn } = fakeSpawn((argv) => {
      const command = argv.at(-1)!
      if (command.startsWith('cat --')) return { stdout: '# sites\nexplore explore.orivon.eth\n' }
      if (command.includes('key/list')) return { stdout: JSON.stringify({ Keys: [{ Name: 'self', Id: 'k51self' }, ...world!.keys.map((k) => ({ Name: k.name, Id: k.id }))] }) }
      const id = /ipns%2F(\w+)/.exec(command)![1]!
      return { stdout: JSON.stringify({ Path: `/ipfs/${world!.cids.get(id)!}` }) }
    })
    const t = makeRun(env, { spawnFn })
    runs.push(t)
    world = t.world
    const { code, calls: beeCalls } = await t.go()
    expect(code).toBe(0)
    expect(calls.map((c) => c.argv.at(-1))).toEqual([
      "cat -- '/srv/status/names.conf'",
      CURL('http://127.0.0.1:5001/api/v0/key/list?l=true&ipns-base=base36'),
      CURL('http://127.0.0.1:5001/api/v0/name/resolve?arg=%2Fipns%2Fk51explore&offline=true')
    ])
    expect(calls.every((c) => c.command === 'ssh' && c.argv.slice(0, 2).join(' ') === '-o BatchMode=yes')).toBe(true)
    expect(Object.keys(t.state().sites)).toEqual(['explore'])
    expect(beeCalls.some((c) => c.includes('/api/v0/'))).toBe(false)
  })
  it('refuses a malformed ssh address as a configuration error', async () => {
    const t = makeRun({ IPFS_API: 'ssh://-oProxyCommand=x@host' })
    runs.push(t)
    expect((await t.go()).code).toBe(2)
  })
})

const gnuTar = spawnSync('tar', ['--version']).stdout?.toString().includes('GNU tar') ?? false

describe.skipIf(!gnuTar)('packing a version for upload', () => {
  const dirs: string[] = []
  const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'swarm-feeds-pack-')); dirs.push(dir); return dir }
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  /** What Kubo's `get --archive` sends: every entry under `<cid>/`. */
  function archiveOf (files: Record<string, string>, root = cid('a')): Buffer {
    const dir = scratch()
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, root, path, '..'), { recursive: true })
      writeFileSync(join(dir, root, path), text)
    }
    mkdirSync(join(dir, root), { recursive: true })
    const file = join(dir, 'in.tar')
    execFileSync('tar', ['-C', dir, '-cf', file, root])
    return readFileSync(file)
  }
  const httpKubo = (body: Buffer) => kuboClient({ api: 'http://kubo.test', fetchFn: (async () => new Response(body)) as unknown as typeof fetch })

  it('packs the site under its own paths, dotfiles included, and keeps only the tar on disk', async () => {
    const work = scratch()
    const packed = await packSite({ kubo: httpKubo(archiveOf({ 'index.html': '<h1>hi</h1>', '.well-known/orivon.json': '{}', 'assets/app.js': 'x' })), cid: cid('a'), workDir: work })
    expect(packed.hasIndex).toBe(true)
    const listing = execFileSync('tar', ['-tf', packed.file]).toString().split('\n').filter((l) => l !== '')
    expect(listing).toEqual(expect.arrayContaining(['./index.html', './.well-known/orivon.json', './assets/app.js']))
    expect(listing.every((entry) => entry.startsWith('./'))).toBe(true)
    expect(packed.bytes).toBeGreaterThan(0)
    const [site] = readdirSync(work)
    expect(readdirSync(join(work, site!))).toEqual(['site.tar'])
    packed.cleanup()
    expect(readdirSync(work)).toEqual([])
  })
  it('says so when the site has no index.html, and when the version holds no files', async () => {
    const work = scratch()
    const noIndex = await packSite({ kubo: httpKubo(archiveOf({ 'a.txt': 'x' })), cid: cid('a'), workDir: work })
    expect(noIndex.hasIndex).toBe(false)
    noIndex.cleanup()
    await expect(packSite({ kubo: httpKubo(archiveOf({})), cid: cid('a'), workDir: work })).rejects.toThrow(/holds no files/)
    expect(readdirSync(work)).toEqual([])
  })
  it('fails and cleans up when the download is cut short, naming the ssh failure behind it', async () => {
    const work = scratch()
    const whole = archiveOf({ 'index.html': 'x'.repeat(20_000) })
    const { spawnFn } = fakeSpawn(() => ({ stdout: [whole.subarray(0, 3000)], code: 255, stderr: 'Connection reset by peer' }))
    await expect(packSite({ kubo: kuboClient({ api: 'ssh://u@h', spawnFn }), cid: cid('a'), workDir: work })).rejects.toThrow(/exit 255.*Connection reset by peer/)
    expect(readdirSync(work)).toEqual([])
  })
  it('clears what a killed run left, and only that', () => {
    const work = scratch()
    mkdirSync(join(work, 'site-abc'))
    writeFileSync(join(work, 'site-abc', 'site.tar'), 'x')
    writeFileSync(join(work, 'keep.txt'), 'x')
    clearWork(work)
    expect(readdirSync(work)).toEqual(['keep.txt'])
    expect(existsSync(join(work, 'site-abc'))).toBe(false)
    expect(() => { clearWork(join(work, 'missing')) }).not.toThrow()
  })
})
