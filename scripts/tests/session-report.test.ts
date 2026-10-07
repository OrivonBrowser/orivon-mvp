import { describe, expect, it } from 'vitest'
import { bucketOf, kindOfPath, summarize } from '../ai/session-report.mjs'

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
