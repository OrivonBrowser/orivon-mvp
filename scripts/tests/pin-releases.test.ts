import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Runs start_page from scripts/pin-releases.sh, the index.html of the newest-release folder. The script has no entry
// point for one function, so the function is cut out of the file and run alone: no Kubo, no network. Windows has no bash.
const SCRIPT = join(process.cwd(), 'scripts', 'pin-releases.sh')
const onUnix = process.platform !== 'win32'

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
