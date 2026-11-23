import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// test:changed reads src/main/start.ts

const source = readFileSync(new URL('../start.ts', import.meta.url), 'utf8')

describe('the process entry', () => {
  it('imports only what it needs to take the single-instance lock, so a second start does not load the browser', () => {
    const imported = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(imported.sort()).toEqual(['./launch/compile-cache.js', './launch/start-launch.js', './startup/startup-marks-runner.js', './startup/startup-profile-runner.js', 'electron', 'node:module'])
  })

  it('imports the start-up profile first, so a profile asked for covers what the other imports evaluate', () => {
    expect([...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)][0]?.[1]).toBe('./startup/startup-profile-runner.js')
  })

  it('ends a profile with the start-up line, before it marks the first moment', () => {
    expect(source.indexOf('onStartupLine(')).toBeGreaterThan(-1)
    expect(source.indexOf('stopStartupProfile(')).toBeLessThan(source.indexOf("markStartup('entry')"))
  })

  it('has no import of the browser, however it is written: that is a require after the lock', () => {
    expect(source).not.toMatch(/^import\s[^\n]*['"]\.\/index(\.js)?['"]/m)
    expect(source).not.toMatch(/^\s*import\s*['"]/m)
  })

  it('registers the uncaught-error handlers before it starts the launch', () => {
    expect(source.indexOf("process.on('uncaughtException'")).toBeGreaterThan(-1)
    expect(source.indexOf("process.on('uncaughtException'")).toBeLessThan(source.indexOf('startLaunch(app'))
    expect(source.indexOf("process.on('unhandledRejection'")).toBeLessThan(source.indexOf('startLaunch(app'))
  })
})
