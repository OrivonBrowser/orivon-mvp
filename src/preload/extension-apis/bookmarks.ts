import type { Crx } from './crx.js'

/** `chrome.bookmarks`, defined when the manifest declares the permission (required or optional); main answers each call only while it is held. */
export function bookmarksApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  if (!crx.declares('bookmarks')) return
  crx.define('bookmarks', () => ({
    get: crx.call('bookmarks.get'),
    getChildren: crx.call('bookmarks.getChildren'),
    getRecent: crx.call('bookmarks.getRecent'),
    getTree: crx.call('bookmarks.getTree'),
    getSubTree: crx.call('bookmarks.getSubTree'),
    search: crx.call('bookmarks.search'),
    create: crx.call('bookmarks.create'),
    move: crx.call('bookmarks.move'),
    update: crx.call('bookmarks.update'),
    remove: crx.call('bookmarks.remove'),
    removeTree: crx.call('bookmarks.removeTree'),
    onCreated: crx.event('bookmarks.onCreated'),
    onRemoved: crx.event('bookmarks.onRemoved'),
    onChanged: crx.event('bookmarks.onChanged'),
    onMoved: crx.event('bookmarks.onMoved'),
    onChildrenReordered: crx.event('bookmarks.onChildrenReordered'),
    onImportBegan: crx.event('bookmarks.onImportBegan'),
    onImportEnded: crx.event('bookmarks.onImportEnded'),
    MAX_WRITE_OPERATIONS_PER_HOUR: 1000,
    MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 100
  }))
}
