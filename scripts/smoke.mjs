// Real smoke check for build step 1's shell. Replaces spike/smoke-launch.mjs
// (throwaway, spike-only) -- this is the shell's own regression check,
// exercised against the actual built app via real clicks and typing, not
// injected commands.
//
// Per open-questions.md C6 (narrowed 2026-08-26): app.firstWindow() is not
// reliable here -- it depends on view-add order, an implementation detail,
// not a contract. Windows are matched by URL via app.windows() instead.
//
// Per CLAUDE.md's traps list: never trust an exit code alone -- this script
// prints a JSON result and a failure list; read them, not just the exit code.
import { createServer } from 'node:http'
import { launchElectron } from '../test/launch-electron.mjs'

function findChrome (app) {
  const win = app.windows().find((w) => w.url().endsWith('index.html'))
  if (win === undefined) throw new Error('chrome view not found in app.windows()')
  return win
}

async function startFixtureServer () {
  const pages = {
    '/a': '<title>fixture-a</title><body>fixture A</body>',
    '/b': '<title>fixture-b</title><body>fixture B</body>'
  }
  const server = createServer((req, res) => {
    const body = pages[req.url] ?? '<title>fixture-404</title>'
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { server, urlFor: (path) => `http://127.0.0.1:${port}${path}` }
}

async function navigateTo (chrome, url) {
  await chrome.click('#address')
  await chrome.fill('#address', url)
  await chrome.press('#address', 'Enter')
  await chrome.waitForTimeout(500)
}

async function activeTabInfo (chrome) {
  return chrome.evaluate(() => {
    const title = document.querySelector('.tab.active .title')?.textContent
    const backDisabled = document.querySelector('#back')?.disabled
    const forwardDisabled = document.querySelector('#forward')?.disabled
    return { title, backDisabled, forwardDisabled }
  })
}

async function main () {
  const result = { checks: [], leakChecks: [] }
  const failures = []
  const check = (name, cond) => {
    result.checks.push({ name, pass: cond })
    if (!cond) failures.push(name)
  }

  const { server, urlFor } = await startFixtureServer()
  const app = await launchElectron({ appPath: '.' })

  try {
    await new Promise((r) => setTimeout(r, 1000))

    check('exactly two windows on launch (chrome + one default tab)', app.windows().length === 2)

    for (const win of app.windows()) {
      const leak = await win.evaluate(() => ({
        url: location.href,
        leakedRequire: typeof globalThis.require,
        leakedProcess: typeof globalThis.process
      }))
      result.leakChecks.push(leak)
      check(`no require() leak in ${leak.url}`, leak.leakedRequire === 'undefined')
      check(`no process leak in ${leak.url}`, leak.leakedProcess === 'undefined')
    }

    const chrome = findChrome(app)

    await navigateTo(chrome, urlFor('/a'))
    const afterA = await activeTabInfo(chrome)
    check('address-bar navigation loaded fixture A', afterA.title === 'fixture-a')

    await navigateTo(chrome, urlFor('/b'))
    const afterB = await activeTabInfo(chrome)
    check('address-bar navigation loaded fixture B', afterB.title === 'fixture-b')
    check('back is enabled after two navigations', afterB.backDisabled === false)

    await chrome.click('#back')
    await chrome.waitForTimeout(500)
    const afterBack = await activeTabInfo(chrome)
    check('back button returned to fixture A', afterBack.title === 'fixture-a')
    check('forward is enabled after going back', afterBack.forwardDisabled === false)

    await chrome.click('#forward')
    await chrome.waitForTimeout(500)
    const afterForward = await activeTabInfo(chrome)
    check('forward button returned to fixture B', afterForward.title === 'fixture-b')
  } finally {
    await app.close()
    server.close()
  }

  console.log(JSON.stringify(result, null, 2))

  if (failures.length > 0) {
    console.error('\nSmoke check FAILED:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('\nSmoke check passed.')
}

main().catch((e) => {
  console.error('Smoke check crashed:', e)
  process.exit(1)
})
