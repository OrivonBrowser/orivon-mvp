import { beforeEach, describe, expect, it, vi } from 'vitest'

// The generic tail of eventListenerFilter: a namespace's permission, then a
// per-event gate. The listener's manifest comes from a faked session.
const manifests = new Map<string, unknown>()
vi.mock('electron', () => ({
  session: { defaultSession: { extensions: { getExtension: (id: string) => (manifests.has(id) ? { manifest: manifests.get(id) } : null) } } }
}))

const { EVENT_GATES, eventListenerFilter, registerEventPermission } = await import('../extension-event-filter.js')
const { installPermissionCheck } = await import('../extension-permission-check.js')
const { createExtensionPrefsStore } = await import('../extension-prefs-runner.js')

const ID = 'a'.repeat(32)
const prefs = createExtensionPrefsStore(null)

beforeEach(() => {
  manifests.clear()
  prefs.forget(ID)
  installPermissionCheck({
    stripped: () => [],
    manifestPermissions: (id) => (manifests.get(id) as { permissions?: string[] } | undefined)?.permissions,
    prefs
  }, () => {})
  registerEventPermission('history', 'history')
})

describe('eventListenerFilter: a namespace with a registered permission', () => {
  it('drops the event for a listener that does not hold it', () => {
    manifests.set(ID, { permissions: ['tabs'] })
    expect(eventListenerFilter(ID, 'history.onVisited', [{ url: 'https://a.example/' }])).toBeUndefined()
  })

  it('delivers it when the manifest holds the permission', () => {
    manifests.set(ID, { permissions: ['history'] })
    expect(eventListenerFilter(ID, 'history.onVisited', [1])).toEqual([1])
  })

  it('delivers it when the person granted an optional permission at runtime', () => {
    manifests.set(ID, { optional_permissions: ['history'] })
    expect(eventListenerFilter(ID, 'history.onVisited', [1])).toBeUndefined()
    prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
    expect(eventListenerFilter(ID, 'history.onVisited', [1])).toEqual([1])
  })

  it('leaves a namespace nobody registered alone, as before', () => {
    manifests.set(ID, {})
    expect(eventListenerFilter(ID, 'alarms.onAlarm', [1])).toEqual([1])
    expect(eventListenerFilter(ID, 'noDot', [1])).toEqual([1])
  })
})

describe('EVENT_GATES', () => {
  it('lets a gate rewrite or withhold the arguments after the permission passed', () => {
    manifests.set(ID, { permissions: ['history'] })
    const gates = EVENT_GATES as Record<string, (q: { extensionId: string, manifest: unknown, args: readonly unknown[] }) => readonly unknown[] | undefined>
    gates['history.onVisited'] = (q) => (q.args[0] === 'private' ? undefined : [`seen:${String(q.args[0])}`])
    try {
      expect(eventListenerFilter(ID, 'history.onVisited', ['public'])).toEqual(['seen:public'])
      expect(eventListenerFilter(ID, 'history.onVisited', ['private'])).toBeUndefined()
    } finally {
      delete gates['history.onVisited']
    }
  })
})
