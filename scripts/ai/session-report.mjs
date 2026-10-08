#!/usr/bin/env node
// Where an AI session's time and tokens went, read from Claude Code's own transcripts
// (~/.claude/projects/<checkout path with every non-alphanumeric as ->/<session>.jsonl, and its
// subagents/ folder). Time is each tool call's call-to-result span, plus the model's time to answer;
// what is left of the wall clock is waiting (for the owner, CI or a background task). For cost in
// money, `npx ccusage` reads the same transcripts. `--digest` prints instead what the owner said and
// what the model concluded, tool calls left out: the material a skill is improved from.
// `--grep <regex>` picks the sessions whose transcript matches at least `--min` times, most first.
//
//   node scripts/ai/session-report.mjs [<session id prefix>...] [--last N] [--grep <regex> [--min N]]
//     [--digest] [--dir <folder>] [--json]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERIFY = /\bheavy\b|vitest|\bnpm\s+(?:run\s+)?(?:test|typecheck|check|smoke|qa|build)|\btsc\b|build-e2e|run-headless|check-[\w-]+\.mjs|select-e2e/
const SHIP = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:git|gh)\b/
const REMOTE = /\b(?:ssh|rsync|scp|curl)\b/
const LOOK = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:grep|rg|sed\s+-n|cat|head|tail|ls|find|wc|jq|file|stat|tree)\b/

/** The kind of a file an edit touched. */
export function kindOfPath (path) {
  if (/(^|\/)(tests?|__tests__)\/|\.test\.[cm]?[jt]s$/.test(path)) return 'tests'
  if (/\.md$/.test(path) || /(^|\/)(docs|devlog)\//.test(path)) return 'docs'
  return 'code'
}

/** The bucket a tool call's time goes in. */
export function bucketOf (name, input = {}) {
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return 'explore'
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return `edit:${kindOfPath(String(input.file_path ?? ''))}`
  if (name === 'Agent') return 'agents'
  if (name === 'AskUserQuestion') return 'owner'
  if (name === 'Bash') {
    const command = String(input.command ?? '')
    if (VERIFY.test(command)) return 'verify'
    if (SHIP.test(command)) return 'git+gh'
    if (REMOTE.test(command)) return 'remote'
    if (LOOK.test(command)) return 'explore'
    return 'shell'
  }
  return 'other'
}

/**
 * Totals for one transcript's parsed lines.
 * @param {readonly any[]} lines
 */
export function summarize (lines) {
  const calls = new Map()
  const usage = new Map()
  const buckets = {}
  const files = { code: new Set(), tests: new Set(), docs: new Set() }
  let first, last, previous
  let modelMs = 0
  for (const line of lines) {
    const at = Date.parse(line.timestamp ?? '')
    if (Number.isNaN(at)) continue
    first ??= at
    last = at
    const content = Array.isArray(line.message?.content) ? line.message.content : []
    if (line.type === 'assistant') {
      // One answer is written as one line per content block while it streams, each with the usage so
      // far: the largest is the closest to the answer's own, and output is a lower bound.
      const id = line.message?.id
      const seen = usage.get(id)
      if (id !== undefined && line.message.usage !== undefined && (seen?.output_tokens ?? -1) <= (line.message.usage.output_tokens ?? 0)) usage.set(id, line.message.usage)
      if (previous !== undefined) modelMs += at - previous.at
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        calls.set(block.id, { at, bucket: bucketOf(block.name, block.input) })
        if (['Edit', 'Write', 'NotebookEdit'].includes(block.name) && typeof block.input?.file_path === 'string') files[kindOfPath(block.input.file_path)].add(block.input.file_path)
      }
    } else if (line.type === 'user') {
      for (const block of content) {
        const call = block.type === 'tool_result' ? calls.get(block.tool_use_id) : undefined
        if (call !== undefined) buckets[call.bucket] = (buckets[call.bucket] ?? 0) + (at - call.at)
      }
    }
    previous = { type: line.type, at }
  }
  const tokens = { output: 0, input: 0, cacheRead: 0 }
  for (const u of usage.values()) {
    tokens.output += u.output_tokens ?? 0
    tokens.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    tokens.cacheRead += u.cache_read_input_tokens ?? 0
  }
  const wallMs = first === undefined ? 0 : last - first
  const toolMs = Object.values(buckets).reduce((sum, ms) => sum + ms, 0)
  return {
    wallMs,
    modelMs,
    buckets,
    waitingMs: Math.max(0, wallMs - modelMs - toolMs),
    tokens,
    files: Object.fromEntries(Object.entries(files).map(([kind, set]) => [kind, set.size]))
  }
}

function readLines (file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

const minutes = (ms) => `${Math.round(ms / 60000)} min`
const thousands = (n) => `${Math.round(n / 1000)}k`

function report (dir, id) {
  const main = summarize(readLines(join(dir, `${id}.jsonl`)))
  const subDir = join(dir, id, 'subagents')
  const agents = existsSync(subDir)
    ? readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => {
      const meta = join(subDir, f.replace(/\.jsonl$/, '.meta.json'))
      let label = f
      try { const m = JSON.parse(readFileSync(meta, 'utf8')); label = m.description ?? m.agentType ?? f } catch {}
      return { label, ...summarize(readLines(join(subDir, f))) }
    })
    : []
  return { id, main, agents }
}

function print ({ id, main, agents }) {
  const out = [`Session ${id.slice(0, 8)}: ${minutes(main.wallMs)} wall = ${minutes(main.modelMs)} model + ${minutes(main.wallMs - main.modelMs - main.waitingMs)} tools + ${minutes(main.waitingMs)} waiting (owner, CI, background agents)`]
  for (const [bucket, ms] of Object.entries(main.buckets).sort((a, b) => b[1] - a[1])) if (ms >= 30000) out.push(`  ${bucket.padEnd(12)} ${minutes(ms)}`)
  out.push(`  Edit/Write on: ${main.files.code} code, ${main.files.tests} test, ${main.files.docs} doc files (shell edits not counted)`)
  out.push(`  tokens: ${thousands(main.tokens.output)}+ out, ${thousands(main.tokens.input)} in, ${thousands(main.tokens.cacheRead)} cache read`)
  for (const agent of agents) {
    const busiest = Object.entries(agent.buckets).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([b, ms]) => `${b} ${minutes(ms)}`).join(', ')
    out.push(`  agent "${agent.label}": ${minutes(agent.wallMs)} wall, ${minutes(agent.modelMs)} model, ${minutes(agent.waitingMs)} waiting (${busiest}); ${thousands(agent.tokens.cacheRead)} cache read`)
  }
  return out.join('\n')
}

const MARKUP = /<(ide_selection|ide_opened_file|system-reminder)>[\s\S]*?<\/\1>/g

/** The owner's messages and the model's prose of one transcript, oldest first; tool calls and their results left out. */
export function digest (lines, { ownerChars = 4000, modelChars = 1500 } = {}) {
  const out = []
  for (const line of lines) {
    if (line.isSidechain === true || line.isMeta === true) continue
    const content = line.message?.content
    const at = (line.timestamp ?? '').slice(0, 16)
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text ?? '') : []
    for (const raw of texts) {
      const text = raw.replace(MARKUP, '').trim()
      if (text === '' || /^<(?:command-|local-command|task-notification)/.test(text)) continue
      if (line.type === 'user') out.push(`### owner ${at}\n${text.slice(0, ownerChars)}`)
      else if (line.type === 'assistant') out.push(`--- model ${at}\n${text.slice(0, modelChars)}`)
    }
  }
  return out.join('\n\n')
}

/** Sessions whose transcript matches `pattern` at least `min` times, most matches first. */
function grepSessions (dir, sessions, pattern, min) {
  const regex = new RegExp(pattern, 'g')
  return sessions.map((id) => ({ id, hits: (readFileSync(join(dir, `${id}.jsonl`), 'utf8').match(regex) ?? []).length }))
    .filter((s) => s.hits >= min).sort((a, b) => b.hits - a.hits).map((s) => s.id)
}

function main (argv) {
  const flag = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1] }
  const dir = flag('--dir') ?? join(homedir(), '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'))
  const prefixes = argv.filter((arg, i) => !arg.startsWith('--') && !['--dir', '--last', '--grep', '--min'].includes(argv[i - 1] ?? ''))
  const sessions = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length))
    .sort((a, b) => statSync(join(dir, `${b}.jsonl`)).mtimeMs - statSync(join(dir, `${a}.jsonl`)).mtimeMs)
  const grep = flag('--grep')
  const chosen = prefixes.length > 0
    ? sessions.filter((id) => prefixes.some((p) => id.startsWith(p)))
    : grep !== undefined
      ? grepSessions(dir, sessions, grep, Number(flag('--min') ?? 1)).slice(0, flag('--last') === undefined ? undefined : Number(flag('--last')))
      : sessions.slice(0, Number(flag('--last') ?? 1))
  if (argv.includes('--digest')) {
    console.log(chosen.map((id) => `# Session ${id}\n\n${digest(readLines(join(dir, `${id}.jsonl`)))}`).join('\n\n'))
    return 0
  }
  const reports = chosen.map((id) => report(dir, id))
  console.log(argv.includes('--json') ? JSON.stringify(reports, null, 2) : reports.map(print).join('\n\n'))
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
