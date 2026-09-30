import type { DnrResourceType } from './types.js'

/** `OnBeforeRequestListenerDetails.resourceType` from `electron.d.ts` (Electron 44). */
export type ElectronResourceType =
  | 'mainFrame'
  | 'subFrame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xhr'
  | 'ping'
  | 'cspReport'
  | 'media'
  | 'webSocket'
  | 'other'

const ELECTRON_TO_CHROME: Record<ElectronResourceType, DnrResourceType> = {
  mainFrame: 'main_frame',
  subFrame: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspReport: 'csp_report',
  media: 'media',
  webSocket: 'websocket',
  other: 'other',
}

/**
 * Maps Electron's `webRequest` resource type spelling to
 * `declarativeNetRequest`'s (Chrome's). Electron 44 has no `webtransport` or
 * `webbundle` equivalent (see `electron.d.ts`'s `OnBeforeRequestListenerDetails`);
 * a caller evaluating one of those directly passes the Chrome name to
 * `evaluate()` without going through this function.
 */
export function mapElectronResourceType(resourceType: ElectronResourceType): DnrResourceType {
  return ELECTRON_TO_CHROME[resourceType]
}
