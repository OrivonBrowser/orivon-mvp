// What each extension set through `chrome.sidePanel`: whether the toolbar click opens the panel, the panel every
// tab shows, and the panel a tab shows instead. Pure: the manifest and the permission check come in as
// functions. The document a panel may load is always one of the extension's own pages.

/** What `chrome.sidePanel.setOptions` took, checked. */
export interface PanelOptionsInput {
  readonly tabId?: number | undefined
  readonly path?: string | undefined
  readonly enabled?: boolean | undefined
}

/** What `chrome.sidePanel.getOptions` answers and what decides whether a panel can show. */
export interface PanelOptionsView {
  readonly enabled: boolean
  readonly path?: string | undefined
}

export interface SidePanelOptionsDeps {
  readonly manifestOf: (extensionId: string) => unknown
  /** The extension holds `sidePanel` right now. */
  readonly holds: (extensionId: string) => boolean
}

export interface SidePanelOptions {
  set: (extensionId: string, input: PanelOptionsInput) => void
  /** What the extension set for `tabId` (or for every tab), merged over the manifest's default path. */
  get: (extensionId: string, tabId?: number) => PanelOptionsView
  /** The address of the panel the extension shows on `tabId` (any tab when undefined); undefined when it has none or it is disabled. */
  panelFor: (extensionId: string, tabId?: number) => string | undefined
  /** Whether any tab-specific entry of the extension names `tabId`. */
  hasTabOptions: (extensionId: string, tabId: number) => boolean
  /** Ids of the tabs the extension set options for. */
  tabsOf: (extensionId: string) => readonly number[]
  openOnActionClick: (extensionId: string) => boolean
  setOpenOnActionClick: (extensionId: string, value: boolean) => void
  forgetTab: (tabId: number) => void
  /** Drops what the extension set, keeping nothing: it was unloaded. */
  forget: (extensionId: string) => void
}

/** The address of `path` inside the extension's own origin, or undefined for anything that leaves it. */
export function panelUrl (extensionId: string, path: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(path, `chrome-extension://${extensionId}/`)
  } catch {
    return undefined
  }
  return parsed.protocol === 'chrome-extension:' && parsed.hostname === extensionId ? parsed.toString() : undefined
}

function fail (message: string): never { throw new Error(message) }

/** `chrome.sidePanel.setOptions`'s argument: an object with an optional integer `tabId`, string `path` and boolean `enabled`. */
export function parseOptionsInput (raw: unknown): PanelOptionsInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('Error in invocation of sidePanel.setOptions(object options): options must be an object.')
  const { tabId, path, enabled } = raw as Record<string, unknown>
  if (tabId !== undefined && (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0)) return fail("Invalid value for argument 1. Property 'tabId': Expected integer.")
  if (path !== undefined && (typeof path !== 'string' || path.trim() === '')) return fail("Invalid value for argument 1. Property 'path': Expected string.")
  if (enabled !== undefined && typeof enabled !== 'boolean') return fail("Invalid value for argument 1. Property 'enabled': Expected boolean.")
  return { tabId: tabId as number | undefined, path: path as string | undefined, enabled: enabled as boolean | undefined }
}

interface Entry { path?: string | undefined, enabled?: boolean | undefined }
interface Held { global: Entry, tabs: Map<number, Entry>, behavior: boolean }

function defaultPath (manifest: unknown): string | undefined {
  const panel = (manifest as { side_panel?: { default_path?: unknown } } | undefined)?.side_panel
  return typeof panel?.default_path === 'string' && panel.default_path.trim() !== '' ? panel.default_path : undefined
}

export function createSidePanelOptions (deps: SidePanelOptionsDeps): SidePanelOptions {
  const held = new Map<string, Held>()
  const of = (id: string): Held => {
    let entry = held.get(id)
    if (entry === undefined) { entry = { global: {}, tabs: new Map(), behavior: false }; held.set(id, entry) }
    return entry
  }

  const view = (id: string, tabId: number | undefined): PanelOptionsView => {
    const entry = held.get(id)
    const global = entry?.global
    const tab = tabId === undefined ? undefined : entry?.tabs.get(tabId)
    const path = tab?.path ?? global?.path ?? defaultPath(deps.manifestOf(id))
    const enabled = tab?.enabled ?? global?.enabled ?? true
    return { enabled: enabled && path !== undefined, ...(path === undefined ? {} : { path }) }
  }

  return {
    set (id, input) {
      const entry = of(id)
      const target = input.tabId === undefined ? entry.global : (entry.tabs.get(input.tabId) ?? {})
      if (input.path !== undefined) target.path = input.path
      if (input.enabled !== undefined) target.enabled = input.enabled
      if (input.tabId !== undefined) entry.tabs.set(input.tabId, target)
    },
    get: view,
    panelFor (id, tabId) {
      if (!deps.holds(id)) return undefined
      const { enabled, path } = view(id, tabId)
      return enabled && path !== undefined ? panelUrl(id, path) : undefined
    },
    hasTabOptions: (id, tabId) => held.get(id)?.tabs.has(tabId) === true,
    tabsOf: (id) => [...(held.get(id)?.tabs.keys() ?? [])],
    openOnActionClick: (id) => held.get(id)?.behavior === true,
    setOpenOnActionClick (id, value) { of(id).behavior = value },
    forgetTab (tabId) { for (const entry of held.values()) entry.tabs.delete(tabId) },
    forget (id) { held.delete(id) }
  }
}
