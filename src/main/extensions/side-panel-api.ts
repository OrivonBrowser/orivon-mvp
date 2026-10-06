// `chrome.sidePanel`: what an extension may ask of the browser's side panel. This file checks the arguments,
// resolves the tab or window, and applies the rules (a tab that is not an ordinary web tab does not exist for an
// extension; `open` needs a gesture and a panel that can show). What the panel does on screen is the driver's
// (side-panel-runner.ts); a test supplies a fake one.
import type { WebContents } from 'electron'
import type { ShellWindow } from '../shell/window-registry.js'
import type { ApiEvent, ExtensionApiContext, ExtensionApiModule } from './api/api-types.js'
import type { GestureLedger } from './side-panel-gesture.js'
import { panelUrl, parseOptionsInput } from './side-panel-options.js'
import type { SidePanelOptions } from './side-panel-options.js'

export const GESTURE_ERROR = '`sidePanel.open()` may only be called in response to a user gesture.'
export const TARGET_ERROR = 'At least one of `tabId` and `windowId` must be provided.'

/** The window and, when the call named one, the tab a panel is opened or closed for. */
export interface PanelTarget {
  readonly extensionId: string
  readonly window: ShellWindow
  readonly tabId: number | undefined
}

export interface SidePanelDriver {
  readonly options: SidePanelOptions
  readonly gesture: GestureLedger
  readonly side: () => 'left' | 'right'
  /** The extension changed what it shows or when. */
  readonly optionsChanged: (extensionId: string) => void
  /** The toolbar behaviour was set; keep it. */
  readonly behaviorChanged: (extensionId: string) => void
  /** Opens the extension's panel for the target, or rejects with the reason nothing can show. */
  readonly open: (target: PanelTarget) => Promise<void>
  readonly close: (target: PanelTarget) => Promise<void>
}

function fail (message: string): never { throw new Error(message) }

function objectArg (raw: unknown, call: string): Record<string, unknown> {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(`Error in invocation of ${call}: options must be an object.`)
  return raw as Record<string, unknown>
}

function integerField (given: Record<string, unknown>, key: string): number | undefined {
  const value = given[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) return fail(`Invalid value for argument 1. Property '${key}': Expected integer.`)
  return value
}

/** A tab an extension can see: not a granted app's, not an Orivon page. */
export function isOrdinaryTab (ctx: ExtensionApiContext, contents: WebContents): boolean {
  const shell = ctx.shell()
  return shell !== undefined && !ctx.isAppOrigin(contents.getURL()) && shell.internalPages.pageOf(contents) === undefined
}

export function installSidePanel (ctx: ExtensionApiContext, driver: SidePanelDriver): void {
  const ordinaryTab = (tabId: number): NonNullable<ReturnType<ExtensionApiContext['tab']>> => {
    const found = ctx.tab(tabId)
    return found === undefined || !isOrdinaryTab(ctx, found.contents) ? fail(`No tab with id: ${String(tabId)}.`) : found
  }

  const targetOf = (event: ApiEvent, raw: unknown, call: string): PanelTarget => {
    const given = objectArg(raw, call)
    const tabId = integerField(given, 'tabId')
    const windowId = integerField(given, 'windowId')
    if (tabId === undefined && windowId === undefined) return fail(TARGET_ERROR)
    if (tabId !== undefined) return { extensionId: event.extension.id, window: ordinaryTab(tabId).window, tabId }
    const window = ctx.shell()?.windows.all().find((entry) => !entry.window.isDestroyed() && entry.window.id === windowId)
    return window === undefined ? fail(`No window with id: ${String(windowId)}.`) : { extensionId: event.extension.id, window, tabId: undefined }
  }

  ctx.handle('sidePanel.setOptions', (event, raw) => {
    const input = parseOptionsInput(raw)
    if (input.tabId !== undefined) ordinaryTab(input.tabId)
    if (input.path !== undefined && panelUrl(event.extension.id, input.path) === undefined) {
      return fail("Invalid value for argument 1. Property 'path': the page must be a file of the extension.")
    }
    driver.options.set(event.extension.id, input)
    driver.optionsChanged(event.extension.id)
  })

  ctx.handle('sidePanel.getOptions', (event, raw) => {
    const given = objectArg(raw, 'sidePanel.getOptions(object options)')
    const tabId = integerField(given, 'tabId')
    if (tabId !== undefined) ordinaryTab(tabId)
    const { enabled, path } = driver.options.get(event.extension.id, tabId)
    return { enabled, ...(path === undefined ? {} : { path }) }
  })

  ctx.handle('sidePanel.setPanelBehavior', (event, raw) => {
    const given = objectArg(raw, 'sidePanel.setPanelBehavior(object behavior)')
    const value = given['openPanelOnActionClick']
    if (value !== undefined && typeof value !== 'boolean') return fail("Invalid value for argument 1. Property 'openPanelOnActionClick': Expected boolean.")
    if (value === undefined) return
    driver.options.setOpenOnActionClick(event.extension.id, value)
    driver.behaviorChanged(event.extension.id)
  })

  ctx.handle('sidePanel.getPanelBehavior', (event) => ({ openPanelOnActionClick: driver.options.openOnActionClick(event.extension.id) }))

  ctx.handle('sidePanel.getLayout', () => ({ side: driver.side() }))

  ctx.handle('sidePanel.open', async (event, raw) => {
    const target = targetOf(event, raw, 'sidePanel.open(object options)')
    if (!driver.gesture.available(event.extension.id)) return fail(GESTURE_ERROR)
    await driver.open(target)
    driver.gesture.spend(event.extension.id)
  })

  ctx.handle('sidePanel.close', async (event, raw) => {
    await driver.close(targetOf(event, raw, 'sidePanel.close(object options)'))
  })
}

/** The module, with the driver it runs against made once the context exists. */
export function createSidePanelApi (makeDriver: (ctx: ExtensionApiContext) => SidePanelDriver): ExtensionApiModule {
  return {
    name: 'sidePanel',
    permission: 'sidePanel',
    install: (ctx) => { installSidePanel(ctx, makeDriver(ctx)) }
  }
}
