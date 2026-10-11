import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { isFirstDashboardLoad, markFirstDashboardLoad } from '../dashboard-first-load.js'

const DASHBOARD = 'orivon-shell://renderer/newtab/index.html'
let nextId = 1000

function contents (): EventEmitter & { id: number } {
  return Object.assign(new EventEmitter(), { id: nextId++ })
}

describe('markFirstDashboardLoad', () => {
  it('holds a new-tab page until its first document commits', () => {
    const tab = contents()
    markFirstDashboardLoad(tab as never, DASHBOARD)
    tab.emit('did-start-navigation', { isMainFrame: true, url: DASHBOARD })
    expect(isFirstDashboardLoad(tab.id)).toBe(true)
    tab.emit('did-navigate')
    expect(isFirstDashboardLoad(tab.id)).toBe(false)
  })

  it('lets go as soon as the tab starts to load another address, so a website document is never held', () => {
    const tab = contents()
    markFirstDashboardLoad(tab as never, DASHBOARD)
    tab.emit('did-start-navigation', { isMainFrame: false, url: 'https://ad.example/' })
    expect(isFirstDashboardLoad(tab.id)).toBe(true)
    tab.emit('did-start-navigation', { isMainFrame: true, url: 'https://a.example/' })
    expect(isFirstDashboardLoad(tab.id)).toBe(false)
  })

  it('lets go when the tab is destroyed, and holds nothing it was never told of', () => {
    const tab = contents()
    markFirstDashboardLoad(tab as never, DASHBOARD)
    tab.emit('destroyed')
    expect(isFirstDashboardLoad(tab.id)).toBe(false)
    expect(isFirstDashboardLoad(contents().id)).toBe(false)
  })
})
