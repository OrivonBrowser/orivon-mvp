// "Copy as text": the report as Markdown for a GitHub issue. It leaves out the contact address, which has no
// place on a public page, and the dump, which is binary; the rest is what the preview shows.
import type { ReportPayload } from './report-payload.js'

/** A code fence longer than any run of backticks inside the text, so the text cannot close it early. */
function fenced (text: string, language = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${text}\n${fence}`
}

function details (summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`
}

export function reportMarkdown (payload: ReportPayload): string {
  const parts = [`**Orivon ${payload.version}**`, '## What happened', payload.description]
  const { crash } = payload
  if (crash !== null) {
    const exit = crash.exitCode === null ? '' : `, exit code ${crash.exitCode}`
    parts.push('## Crash', `${crash.kind} in ${crash.process} at ${crash.at}: ${crash.reason}${exit}`)
    if (crash.message !== '') parts.push(fenced(crash.message))
    if (crash.stack !== '') parts.push(details('Stack', fenced(crash.stack)))
  }
  if (payload.page !== null) parts.push(`Page: ${payload.page}`)
  if (payload.diagnostics !== null) parts.push(details('Technical details', fenced(JSON.stringify(payload.diagnostics, null, 2), 'json')))
  if (payload.log !== null) parts.push(details(`Recent log (${payload.log.length} lines)`, fenced(payload.log.join('\n'))))
  return `${parts.join('\n\n')}\n`
}
