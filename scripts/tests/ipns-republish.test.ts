import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Runs scripts/ipns-republish.sh against a fake `ipfs` on PATH that logs each call and serves the records the test
// wrote. Needs bash, jq, coreutils' timeout and GNU date, so it is skipped where one is missing (Windows, macOS).
const SCRIPT = join(process.cwd(), 'scripts', 'ipns-republish.sh')
const has = (command: string, args: string[]): boolean => spawnSync(command, args).status === 0
const ready = process.platform !== 'win32' && has('jq', ['--version']) && has('timeout', ['--version']) && has('date', ['-d', '@0'])

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// `routing get` prints the record file of the key; `name inspect` prints its stdin, so a record file holds the JSON
// that inspect would print. A file named fail.<call>.<key> makes that call fail, hang.<call>.<key> makes it hang, and
// a publish that works leaves a record ending RENEWED.
const FAKE_IPFS = `#!/bin/sh
[ "$1" = --api ] && shift 2
echo "$*" >> "$FAKE/calls"
case "$1 $2" in
  'key list') cat "$FAKE/keys" ;;
  'routing get') cat "$FAKE/record.\${4#/ipns/}" ;;
  'name inspect') cat ;;
  'routing put')
    id=\${3#/ipns/}
    [ ! -e "$FAKE/hang.put.$id" ] || exec sleep 30
    [ ! -e "$FAKE/fail.put.$id" ] || { echo 'Error: routing: not found' >&2; exit 1; }
    cp "$4" "$FAKE/put.$id" ;;
  'name publish')
    key=\${3#--key=}
    [ ! -e "$FAKE/fail.publish.$key" ] || { echo 'Error: context deadline exceeded' >&2; exit 1; }
    id=$(awk -v key="$key" '$2 == key { print $1 }' "$FAKE/keys")
    printf '{"Entry":{"Value":"%s","Validity":"%s","Sequence":7}}' "\${6}" "$RENEWED" > "$FAKE/record.$id" ;;
esac
`

interface Key { id: string, name: string, value: string, daysLeft: number | null }
interface Run { status: number | null, stdout: string, stderr: string, calls: string[], dir: string }

// A key with `daysLeft: null` has no record on the node; `keys` null leaves the node unable to list its keys.
function run (keys: Key[] | null, env: Record<string, string> = {}, args: string[] = ['run'], marks: string[] = [], systemctl = ''): Run {
  const dir = mkdtempSync(join(tmpdir(), 'ipns-republish-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  const fake = join(dir, 'fake')
  for (const folder of [bin, fake]) mkdirSync(folder)
  const install = (name: string, body: string): void => { const path = join(bin, name); writeFileSync(path, body); chmodSync(path, 0o755) }
  install('ipfs', FAKE_IPFS)
  if (systemctl !== '') { install('systemctl', systemctl); install('sleep', '#!/bin/sh\necho "sleep $*" >> "$FAKE/calls"\n') }
  for (const one of keys ?? []) {
    if (one.daysLeft === null) continue
    const validity = new Date(Date.now() + one.daysLeft * 86_400_000).toISOString()
    writeFileSync(join(fake, `record.${one.id}`), JSON.stringify({ Entry: { Value: one.value, Validity: validity, Sequence: 3 } }))
  }
  if (keys !== null) writeFileSync(join(fake, 'keys'), keys.map((one) => `${one.id} ${one.name}\n`).join(''))
  for (const mark of marks) writeFileSync(join(fake, mark), '')
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, FAKE: fake, RENEWED: '2036-11-14T10:00:00.5Z', ...env }
  })
  const calls = existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter((line) => line !== '') : []
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, dir: fake }
}

const lines = (output: string): string[] => output.split('\n').filter((line) => line !== '').sort()
const key = (name: string, daysLeft: number | null, id = `k51${name}`): Key => ({ id, name, value: `/ipfs/bafy${name}`, daysLeft })

describe.skipIf(!ready)('ipns-republish.sh run', () => {
  it('re-announces a record with years left exactly as the node signed it, and signs nothing anew', () => {
    const result = run([key('site', 3000)])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('[ipns-republish] site k51site: re-announced\n')
    expect(result.calls.filter((call) => call.startsWith('routing put /ipns/k51site '))).toHaveLength(1)
    expect(result.calls.some((call) => call.startsWith('name publish'))).toBe(false)
    expect(readFileSync(join(result.dir, 'put.k51site'), 'utf8')).toBe(readFileSync(join(result.dir, 'record.k51site'), 'utf8'))
  })

  it('signs a record with days left anew for the lifetime, with its own value, and says until when', () => {
    const result = run([key('docs', 5)])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('[ipns-republish] docs k51docs: re-signed until 2036-11-14\n')
    expect(result.calls).toContain('name publish --key=docs --lifetime=87672h --resolve=false /ipfs/bafydocs')
    expect(result.calls.some((call) => call.startsWith('routing put'))).toBe(false)
  })

  it('switches between the two at RENEW_DAYS', () => {
    const result = run([key('near', 12), key('far', 20)], { RENEW_DAYS: '15', LIFETIME: '2h30m' })
    expect(result.status, result.stderr).toBe(0)
    expect(lines(result.stdout)).toEqual(['[ipns-republish] far k51far: re-announced', '[ipns-republish] near k51near: re-signed until 2036-11-14'])
    expect(result.calls).toContain('name publish --key=near --lifetime=2h30m --resolve=false /ipfs/bafynear')
  })

  it('leaves self, and every key of SKIP_KEYS, alone', () => {
    const keys = [key('self', 5), key('site', 3000), key('docs', 3000), key('latest', 3000)]
    const first = run(keys)
    expect(lines(first.stdout)).toEqual(['[ipns-republish] docs k51docs: re-announced', '[ipns-republish] latest k51latest: re-announced', '[ipns-republish] site k51site: re-announced'])
    expect(first.calls.some((call) => call.includes('k51self'))).toBe(false)
    const second = run(keys, { SKIP_KEYS: 'self,docs' })
    expect(lines(second.stdout)).toEqual(['[ipns-republish] latest k51latest: re-announced', '[ipns-republish] site k51site: re-announced'])
  })

  it('fails a key with no valid record, saying how to publish it by hand, and still handles the others', () => {
    const result = run([key('gone', null), key('site', 3000)])
    expect(result.status).toBe(1)
    expect(lines(result.stdout)).toEqual([
      expect.stringMatching(/^\[ipns-republish\] gone k51gone: failed: the node holds no valid record .*ipfs name publish --key=gone --lifetime=87672h \/ipfs\/<its CID>$/),
      '[ipns-republish] site k51site: re-announced'
    ])
  })

  it('fails the key whose put or publish fails, and still handles the others', () => {
    const result = run([key('put', 3000), key('sign', 5), key('site', 3000), key('docs', 5)], {}, ['run'], ['fail.put.k51put', 'fail.publish.sign'])
    expect(result.status).toBe(1)
    expect(lines(result.stdout)).toEqual([
      '[ipns-republish] docs k51docs: re-signed until 2036-11-14',
      '[ipns-republish] put k51put: failed: re-announcing: Error: routing: not found',
      '[ipns-republish] sign k51sign: failed: re-signing: Error: context deadline exceeded',
      '[ipns-republish] site k51site: re-announced'
    ])
  })

  it('gives up on a key whose call never ends after TIMEOUT, and still handles the others', () => {
    const result = run([key('hung', 3000), key('site', 3000)], { TIMEOUT: '1' }, ['run'], ['hang.put.k51hung'])
    expect(result.status).toBe(1)
    expect(lines(result.stdout)).toEqual(['[ipns-republish] hung k51hung: failed: re-announcing: no answer in 1s', '[ipns-republish] site k51site: re-announced'])
  })

  it('handles more keys than PARALLEL, each once', () => {
    const keys = Array.from({ length: 7 }, (_, i) => key(`n${i}`, 3000))
    const result = run(keys, { PARALLEL: '2' })
    expect(result.status, result.stderr).toBe(0)
    expect(lines(result.stdout)).toEqual(keys.map((one) => `[ipns-republish] ${one.name} ${one.id}: re-announced`))
  })

  it('with DRY_RUN=1 says what it would do and neither signs nor puts anything', () => {
    const result = run([key('site', 3000), key('docs', 5), key('gone', null)], { DRY_RUN: '1' })
    expect(result.status).toBe(1)
    const text = lines(result.stdout).join('\n')
    expect(text).toMatch(/docs k51docs: DRY RUN: would re-sign \/ipfs\/bafydocs for 87672h/)
    expect(text).toMatch(/site k51site: DRY RUN: would re-announce its record, valid until \d{4}-\d{2}-\d{2}/)
    expect(text).toMatch(/gone k51gone: failed: the node holds no valid record/)
    expect(result.calls.some((call) => call.startsWith('name publish') || call.startsWith('routing put'))).toBe(false)
  })

  it('waits while the release pinner runs, then goes ahead', () => {
    // active for the first three looks, then idle
    const systemctl = '#!/bin/sh\nn=$(cat "$FAKE/looks" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE/looks"\n[ "$n" -lt 3 ] && echo active || echo inactive\n'
    const result = run([key('site', 3000)], {}, ['run'], [], systemctl)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('[ipns-republish] waiting for orivon-release-pinner.service to finish\n[ipns-republish] site k51site: re-announced\n')
    const names = result.calls.map((call) => call.split(' ').slice(0, 2).join(' '))
    expect(names.filter((name) => name === 'sleep 10')).toHaveLength(2)
    expect(names.lastIndexOf('sleep 10')).toBeLessThan(names.indexOf('routing put'))
  })

  it('gives up with nothing done when the release pinner outlasts PINNER_WAIT', () => {
    const result = run([key('site', 5)], { PINNER_WAIT: '20' }, ['run'], [], '#!/bin/sh\necho activating\n')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('orivon-release-pinner.service still runs after 20s: nothing was done')
    expect(result.calls.some((call) => call.startsWith('routing') || call.startsWith('name'))).toBe(false)
  })

  it('exits 1 when the node does not answer for its keys', () => {
    const result = run(null)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('[ipns-republish] failed: could not list the keys of the node at /ip4/127.0.0.1/tcp/5001\n')
  })

  it.each([
    ['no command', [], {}],
    ['another command', ['status'], {}],
    ['a PARALLEL that is not a number', ['run'], { PARALLEL: 'many' }],
    ['a PARALLEL of 0', ['run'], { PARALLEL: '0' }],
    ['a TIMEOUT that is not a number', ['run'], { TIMEOUT: '5m' }],
    ['a LIFETIME that is not a duration', ['run'], { LIFETIME: '10 years' }]
  ])('exits 2 for %s, touching nothing', (_label, args, env) => {
    const result = run([key('site', 5)], env, args)
    expect(result.status).toBe(2)
    expect(result.calls).toEqual([])
  })
})
