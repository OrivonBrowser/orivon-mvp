# Cross-site state checklist

A page on one site must never change what another site gets, and must never change the browser for
everyone. This page lists the places in this repository where that could go wrong, and what to check
at each. Use it when reviewing a change that stores something, reads a stored value for a page, or sets
something on a session or on the process. Use it as well when a report says one site changed after
another site or an app was used.

## The three questions

For every piece of state a change touches, answer:

1. **Who can write it?** The person through Orivon's own pages, an app through a grant, a website, or
   an extension.
2. **What is it keyed by?** And what is that key for a page with no real origin?
3. **How long does it last?** The page, the session, or across restarts.

The shape to look for is state that a website or an app can write, that is read for another site or for
every site, and that survives a restart.

## Orivon's own state

1. **The profile's files.** `settings.json`, `routes.json`, `zoom.json`, `site-settings.json`,
   bookmarks, shortcuts, the side panel and the new-tab background are written only on a request from a
   shell surface or an `orivon://` page. The request is identified by its sender frame and that frame's
   session (T3, T43), never by an address or an origin the request carries.
2. **Internal pages.** No website loads, frames or scripts an `orivon://` page (T43). No address of one
   applies a setting just by being opened: a link that changes a setting is a cross-site request
   forgery against the browser.
3. **Switches that reach every page.** `nativeTheme.themeSource`, `session.setProxy`, `setUserAgent`,
   `setSpellCheckerLanguages`, permission handlers, `webRequest` listeners and `protocol.handle` act on
   every page of the process or the session they are set on. Each is set from Settings, or for one app
   on that app's own partition. None is set on the default session for one site's sake.
4. **Injected stylesheets and scripts.** `insertCSS` and `executeJavaScript` choose their target by
   session, never by address alone, because a site can navigate to any address. The inserted text is
   never built from page data ([`src/main/appearance/`](../../src/main/appearance/)).
5. **Per-site keys.** Zoom levels, site permissions, grants and consent notes are keyed by origin. A
   sandboxed frame, a `data:`, `blob:` or `about:blank` page and a `file:` page have an opaque origin,
   which serialises as `"null"` with an empty host. Nothing is stored under that key, or the entry
   matches every other opaque page. Check the key for `.eth` names, `*.ipfs.orivon`, `*.ipns.orivon` and
   `localhost` with a port as well.
6. **Grants stay with their address.** A grant given to one name covers neither its parent nor its
   siblings, nor another IPNS name served the same way.

## What an app reaches through its grants

7. **Files (T1).** An app reads and writes inside its own directory, checked after `..` and symlinks
   are resolved. It never reaches the profile's root, which holds `settings.json`, Chromium's
   `Preferences` and `extensions/`.
8. **Local servers (T12, T15, T35).** A port an app listens on, and the control interface of Orivon's
   own IPFS and Swarm nodes, accept nothing from another site or app that changes their configuration,
   pins or keys.
9. **Spawned programs.** A program an app starts never gets the profile directory as its working
   directory or in its environment.

## Orivon's own caches

10. **Content Orivon serves itself.** `.eth`, IPFS and IPNS content is served by Orivon, outside
    Chromium's per-site cache. Every cache there is keyed by a content hash or a signed record, and
    kept per top-level origin where timing could leak (T27, T33, T36). One site never fills an entry
    that another site trusts.

## Web features that are browser-wide by design

11. **Site-registered handlers and installs.** Registering a protocol handler, adding a search engine
    from a page (`<link rel="search">`), installing a web app, notification permission and download
    defaults each change the browser for every site. Where this build supports one, it asks first, and
    Settings lists it with a way to undo it.

## Extensions

12. **Where content scripts run.** An extension's content scripts run in every website frame its site
    access covers, sandboxed frames included, and its storage is one store for all sites. They do not
    load in a cache-served app's partition or in the shell's sessions (T49, T50). An extension that
    learns from what pages show (dark-theme detection, colour-scheme reports, site lists it fills by
    itself) can be steered by any page, for every site. Orivon cannot fix the extension. It decides
    where content scripts run, and a change to that is reviewed against this page.
13. **Page-to-extension messages.** A page can message an extension only when the extension's
    `externally_connectable` names that page.

## Reading a report

When a site looks or behaves differently after another site or an app was used, where the change shows
narrows down which layer holds it. A private window starts with a copy of the profile's settings and
shortcuts, plus the extensions allowed in private windows, and nothing else (T47).

| Where the change shows | Look first at |
|---|---|
| One site, or a few | A per-site entry (zoom, permissions, grants) or an extension's site list |
| Normal windows, not a private one | An extension not allowed in private windows; the site's own cookies and storage, which its A/B tests follow; a session switch set outside Settings |
| Private windows too | A value in `settings.json`, a process-wide switch such as `nativeTheme`, the system's fonts, or the site itself |

Read the profile before the code: `settings.json`, `zoom.json`, `site-settings.json`, `routes.json`
and `extensions/registry.json`. Each extension keeps its own storage, as a LevelDB database, under
`Local Extension Settings/<extension id>/`.
