/**
 * Builds qa-artifacts/latest/inspect.md: one entry per captured state, with
 * what the state should show, what the deterministic checks found, and a blank
 * Verdict line for the reader (Claude, looking at the PNG) to fill in.
 *
 * The sheet never decides anything. Audit findings, shell errors, a blank
 * window and a baseline mismatch already fail the spec; this exists so the
 * screenshots are read against an explicit expectation, and so a state that
 * merely did not crash is not mistaken for one that looks right.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const LATEST = join(ROOT, 'qa-artifacts', 'latest')

export const VERDICTS = ['expected-variation', 'harmless', 'defect', 'functional-bug', 'needs-human-review']

const list = (items, empty) => (items.length === 0 ? empty : items.map((i) => `\n  - ${i}`).join(''))

/**
 * @param {Array<Record<string, any>>} reports state records written by captureState()
 * @param {string} failuresIndex contents of qa-artifacts/latest/index.md, or ''
 * @returns {string}
 */
export function renderInspectSheet (reports, failuresIndex = '') {
  const out = [
    '# QA inspection sheet',
    '',
    'Read each screenshot against its Expected line, then fill in the Verdict.',
    `Verdicts: ${VERDICTS.join(' | ')}.`,
    'A state passes only with positive evidence that what Expected describes is on screen. "It did not crash" is not evidence.',
    'A finding you judge harmless or intended is not silently ignored: name why, and if it should stay quiet, allowlist it in the spec with that reason.',
    ''
  ]
  if (reports.length === 0) out.push('No state records were found. Run `npm run qa:visual` first.', '')
  for (const [i, r] of reports.entries()) {
    const findings = (r.audit?.findings ?? []).map((f) => `${f.rule} ${f.selector}: ${f.detail}`)
    const allowed = (r.audit?.allowed ?? []).map((f) => `${f.rule} ${f.selector}: ${f.detail} (allowed: ${f.reason})`)
    const errors = (r.errors ?? []).map((e) => `${e.kind} ${e.url}: ${String(e.text).slice(0, 160)}`)
    const b = r.baseline ?? { status: 'unknown' }
    const ratio = b.ratio === undefined ? '' : `, ${(b.ratio * 100).toFixed(4)}% of pixels differ (limit ${(b.maxDiffRatio * 100).toFixed(4)}%)`
    out.push(
      `## ${i + 1}. ${r.name}`, '',
      `- Screenshot: states/${r.name}.png${r.png === undefined ? ' (none was produced)' : ''}`,
      `- Expected: ${r.expected}`,
      `- Action: ${r.action}`,
      `- Views: ${(r.views ?? []).map((v) => `${v.url} "${v.title}"${v.shown ? '' : ' (hidden)'}`).join('; ')}`,
      `- Layout audit: ${findings.length === 0 ? 'clean' : `${findings.length} finding(s)`}${list(findings, '')}`,
      `- Allowed findings: ${list(allowed, 'none')}`,
      `- Shell errors since the last state: ${list(errors, 'none')}`,
      `- Window painted: ${r.blank ? 'NO, one flat colour' : 'yes'}`,
      `- Pixel baseline: ${b.status}${ratio}${b.diffPath === undefined ? '' : `, diff at ${b.diffPath}`}`,
      `- Verdict: `,
      `- Notes: `,
      ''
    )
  }
  const failures = failuresIndex.trim()
  out.push('## Failure evidence', '', failures === '' ? 'No spec failed in this run.' : failures, '')
  return out.join('\n')
}

export async function readReports (dir = join(LATEST, 'states')) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort()
  return await Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8'))))
}

if (isInvokedDirectly(import.meta.url)) {
  const sheet = renderInspectSheet(await readReports(), await readFile(join(LATEST, 'index.md'), 'utf8').catch(() => ''))
  await mkdir(LATEST, { recursive: true })
  await writeFile(join(LATEST, 'inspect.md'), sheet)
  console.log(`Wrote qa-artifacts/latest/inspect.md (${(sheet.match(/^## \d+\./gm) ?? []).length} state(s)).`)
}
