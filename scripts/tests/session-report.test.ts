import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bucketOf, digest, isHookRefusal, kindOfPath, linesOf, summarize, summarizeFile } from '../ai/session-report.mjs'

describe('bucketOf', () => {
  it('sorts tool calls into what the time was spent on', () => {
    expect(bucketOf('Read')).toBe('explore')
    expect(bucketOf('Edit', { file_path: 'src/telemetry/consent.ts' })).toBe('edit:code')
    expect(bucketOf('Write', { file_path: 'src/telemetry/tests/consent.test.ts' })).toBe('edit:tests')
    expect(bucketOf('Edit', { file_path: 'docs/privacy/notice.md' })).toBe('edit:docs')
    expect(bucketOf('Bash', { command: '~/.claude/orivon-fleet/bin/heavy npm run test:changed' })).toBe('verify')
    expect(bucketOf('Bash', { command: 'cd x && git push -q' })).toBe('git+gh')
    expect(bucketOf('Bash', { command: 'ssh host uptime' })).toBe('remote')
    expect(bucketOf('Bash', { command: 'grep -n region src/a.ts' })).toBe('explore')
    expect(bucketOf('AskUserQuestion')).toBe('owner')
  })

  it('tells tests and docs from code by path', () => {
    expect(kindOfPath('test/telemetry/e2e-telemetry-send.test.ts')).toBe('tests')
    expect(kindOfPath('devlog/journal.md')).toBe('docs')
    expect(kindOfPath('scripts/test-changed.mjs')).toBe('code')
  })
})

describe('summarize', () => {
  const at = (s: number): string => new Date(Date.UTC(2026, 9, 7, 12, 0, s)).toISOString()
  const lines = [
    { type: 'user', timestamp: at(0), message: { content: 'go' } },
    { type: 'assistant', timestamp: at(10), message: { id: 'm1', usage: { output_tokens: 5, input_tokens: 1, cache_read_input_tokens: 100 }, content: [{ type: 'text', text: 'x' }] } },
    { type: 'assistant', timestamp: at(12), message: { id: 'm1', usage: { output_tokens: 40, input_tokens: 1, cache_read_input_tokens: 100 }, content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/a.ts' } }] } },
    { type: 'user', timestamp: at(15), message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'assistant', timestamp: at(20), message: { id: 'm2', usage: { output_tokens: 7, input_tokens: 2, cache_read_input_tokens: 200 }, content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', timestamp: at(80), message: { content: 'thanks' } }
  ]

  it('splits the wall clock into model, tool and waiting time, and counts each answer once', () => {
    const s = summarize(lines)
    expect(s.wallMs).toBe(80_000)
    expect(s.modelMs).toBe(17_000)
    expect(s.buckets).toEqual({ 'edit:code': 3_000 })
    expect(s.waitingMs).toBe(60_000)
    expect(s.tokens).toEqual({ output: 47, input: 3, cacheRead: 300 })
    expect(s.files).toEqual({ code: 1, tests: 0, docs: 0 })
  })
})

describe('digest', () => {
  it('keeps what the owner said and what the model concluded, and drops tools, markup, notifications and subagents', () => {
    const lines = [
      { type: 'user', timestamp: '2026-10-08T09:00:00Z', message: { content: [{ type: 'text', text: '<ide_opened_file>x</ide_opened_file>' }, { type: 'text', text: 'Port the app' }] } },
      { type: 'assistant', timestamp: '2026-10-08T09:01:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }, { type: 'text', text: 'Recon first.' }] } },
      { type: 'user', timestamp: '2026-10-08T09:02:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'noise' }] } },
      { type: 'assistant', isSidechain: true, timestamp: '2026-10-08T09:03:00Z', message: { content: [{ type: 'text', text: 'a subagent' }] } },
      { type: 'user', timestamp: '2026-10-08T09:04:00Z', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', timestamp: '2026-10-08T09:05:00Z', message: { content: '<task-notification>done</task-notification>' } },
      { type: 'user', isMeta: true, timestamp: '2026-10-08T09:06:00Z', message: { content: [{ type: 'text', text: 'injected skill text' }] } }
    ]
    expect(digest(lines)).toBe('### owner 2026-10-08T09:00\nPort the app\n\n--- model 2026-10-08T09:01\nRecon first.')
  })
})

const stamp = (s: number): string => new Date(Date.UTC(2026, 9, 7, 12, 0, s)).toISOString()
const call = (id: string, s: number): object => ({ type: 'assistant', timestamp: stamp(s), message: { id: `m-${id}`, usage: { output_tokens: 3 }, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
const result = (id: string, s: number, content: unknown, isError = true): object => ({ type: 'user', timestamp: stamp(s), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } })

describe('hook refusals', () => {
  it('counts an error result that opens with a hook block, once per call, and nothing else', () => {
    const lines = [
      call('t1', 0), result('t1', 1, 'PreToolUse:Bash hook error: Blocked by hook'), result('t1', 2, 'PreToolUse:Bash hook error: Blocked by hook'),
      call('t2', 3), result('t2', 4, [{ type: 'text', text: '<tool_use_error>Blocked: sleep 45 followed by a check</tool_use_error>' }]),
      call('t3', 5), result('t3', 6, 'BLOCKED: a native module'),
      call('t4', 7), result('t4', 8, 'BLOCKED 39cd4e754 2680987 01:14:25', false),
      call('t5', 9), result('t5', 10, 'Exit code 1\nBlocked by the firewall'),
      call('t6', 11), result('t6', 12, 'fine', false)
    ]
    const s = summarize(lines)
    expect([s.toolCalls, s.hookRefusals, s.hookRefusalsPer1000]).toEqual([6, 3, 500])
    expect(summarize([]).hookRefusalsPer1000).toBe(0)
  })

  it('reads the marker from a string or a text block, and only from an error', () => {
    expect(isHookRefusal({ is_error: true, content: [{ type: 'image' }, { type: 'text', text: 'Blocked: x' }] })).toBe(true)
    expect(isHookRefusal({ is_error: true, content: [{ type: 'image' }] })).toBe(false)
    expect(isHookRefusal({ content: 'Blocked: x' })).toBe(false)
    expect(isHookRefusal({ is_error: true })).toBe(false)
  })
})

describe('streaming a transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-session-report-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const turns = (needle: number): object[] => Array.from({ length: 1000 }, (_, i) => [
    call(`c${i}`, 4 * i),
    result(`c${i}`, 4 * i + 1, i % 50 === 0 ? 'PreToolUse:Bash hook error: Blocked by hook' : 'ok', i % 50 === 0),
    { type: 'assistant', timestamp: stamp(4 * i + 2), message: { id: `a${i}`, usage: { output_tokens: 9 }, content: [{ type: 'text', text: `${'é'.repeat(60)} ${i < needle ? 'needle' : ''}` }] } }
  ]).flat()
  const written = (lines: object[]): string => lines.map((l, i) => (i % 700 === 3 ? `\n${JSON.stringify(l)}\nnot json\n` : JSON.stringify(l))).join('\n')
  const collect = async (file: string, options?: { highWaterMark?: number, maxChars?: number }): Promise<string[]> => {
    const out: string[] = []
    for await (const line of linesOf(file, options)) out.push(line)
    return out
  }

  it('gives the same totals as reading the lines whole, from a file of a few thousand lines', async () => {
    const lines = turns(0)
    const file = join(dir, 'whole.jsonl')
    writeFileSync(file, written(lines))
    const totals = await summarizeFile(file)
    expect(totals).toEqual(summarize(lines))
    expect([totals.toolCalls, totals.hookRefusals]).toEqual([1000, 20])
    expect(totals.tokens.output).toBe(12 * 1000)
  })

  it('splits lines as split() would, whatever the chunk size and where a multi-byte letter falls', async () => {
    const text = written(turns(0).slice(0, 120))
    const file = join(dir, 'split.jsonl')
    for (const trailing of ['', '\n']) {
      writeFileSync(file, text + trailing)
      const expected = (text + trailing).split('\n')
      if (expected.at(-1) === '') expected.pop()
      for (const highWaterMark of [1, 7, 4096, 1 << 20]) expect(await collect(file, { highWaterMark })).toEqual(expected)
    }
  })

  it('skips a line longer than the limit and carries on with the next', async () => {
    const file = join(dir, 'long.jsonl')
    writeFileSync(file, `aaaa\n${'b'.repeat(100)}\ncc\n${'d'.repeat(100)}`)
    for (const highWaterMark of [3, 64, 4096]) expect(await collect(file, { highWaterMark, maxChars: 10 })).toEqual(['aaaa', 'cc'])
  })

  it('runs as a command: report, --json, --digest and --grep read the same files', () => {
    const script = fileURLToPath(new URL('../ai/session-report.mjs', import.meta.url))
    const run = (...args: string[]): string => execFileSync(process.execPath, [script, '--dir', dir + '/cli', ...args], { encoding: 'utf8' })
    mkdirSync(join(dir, 'cli', 'a', 'subagents'), { recursive: true })
    const a = turns(3)
    writeFileSync(join(dir, 'cli', 'a.jsonl'), written(a))
    writeFileSync(join(dir, 'cli', 'b.jsonl'), written(turns(1)))
    writeFileSync(join(dir, 'cli', 'a', 'subagents', 'agent-1.jsonl'), written(turns(0)))
    writeFileSync(join(dir, 'cli', 'a', 'subagents', 'agent-1.meta.json'), JSON.stringify({ description: 'helper' }))

    const [report] = JSON.parse(run('--json', 'a')) as [{ main: object, agents: Array<{ label: string }> }]
    expect(report.main).toEqual(JSON.parse(JSON.stringify(summarize(a))))
    expect(report.agents.map((x) => x.label)).toEqual(['helper'])
    expect(run('a')).toMatch(/hook refusals: 20 in 1000 tool calls \(20 per 1,000\)/)
    expect(run('--digest', 'a')).toBe(`# Session a\n\n${digest(a)}\n`)
    const ids = (...args: string[]): string[] => (JSON.parse(run('--json', ...args)) as Array<{ id: string }>).map((r) => r.id)
    expect(ids('--grep', 'needle')).toEqual(['a', 'b'])
    expect(ids('--grep', 'needle', '--min', '2')).toEqual(['a'])
    expect(ids('--grep', 'needle', '--last', '1')).toEqual(['a'])
  })
})
