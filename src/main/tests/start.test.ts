import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../start.ts', import.meta.url), 'utf8')

describe('the process entry', () => {
  it('imports only what it needs to take the single-instance lock, so a second start does not load the browser', () => {
    const imported = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(imported.sort()).toEqual(['./launch/start-launch.js', 'electron', 'node:module'])
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
