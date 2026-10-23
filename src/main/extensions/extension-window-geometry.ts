// What a window an extension opens or moves is made of: its type, and where and how large it may be. The extension
// asks for numbers; the display decides what fits. No Electron runtime import: the work areas arrive as arguments.

export interface Rect { x: number, y: number, width: number, height: number }
export interface Size { width: number, height: number }

/** Chrome's other window types ('panel', 'app', 'devtools') are ordinary shell windows here. */
export function extensionWindowType (details: { type?: unknown }): 'normal' | 'popup' {
  return details.type === 'popup' ? 'popup' : 'normal'
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function distanceTo (area: Rect, x: number, y: number): number {
  const dx = Math.max(area.x - x, 0, x - (area.x + area.width))
  const dy = Math.max(area.y - y, 0, y - (area.y + area.height))
  return dx * dx + dy * dy
}

/** The work area holding the point, else the nearest one, else the first. */
function areaFor (areas: readonly Rect[], x: number, y: number): Rect | undefined {
  let best: Rect | undefined
  let bestDistance = Infinity
  for (const area of areas) {
    const distance = distanceTo(area, x, y)
    if (distance < bestDistance) { best = area; bestDistance = distance }
  }
  return best
}

/**
 * The bounds a `windows.create` or `windows.update` call may have. `request` is what the extension gave (`left` is `x`,
 * `top` is `y`); `base` is the window's present bounds on an update. A create names only what was asked, so the shell's
 * defaults decide the rest. A size is held between `min` and the work area; a corner is moved back until the window,
 * at its size, lies inside the work area it is on.
 */
export function placeExtensionWindow (
  request: { left?: unknown, top?: unknown, width?: unknown, height?: unknown },
  areas: readonly Rect[], min: Size, base?: Rect
): Partial<Rect> {
  const asked: Partial<Rect> = {
    ...(finite(request.left) ? { x: Math.round(request.left) } : {}),
    ...(finite(request.top) ? { y: Math.round(request.top) } : {}),
    ...(finite(request.width) ? { width: Math.round(request.width) } : {}),
    ...(finite(request.height) ? { height: Math.round(request.height) } : {})
  }
  const merged: Partial<Rect> = { ...base, ...asked }
  const area = merged.x !== undefined && merged.y !== undefined ? areaFor(areas, merged.x, merged.y) : areas[0]

  const length = (value: number | undefined, least: number, most: number | undefined): number | undefined =>
    value === undefined ? undefined : Math.max(least, most === undefined ? value : Math.min(value, most))
  const width = length(merged.width, min.width, area?.width)
  const height = length(merged.height, min.height, area?.height)
  const origin = (value: number | undefined, from: number | undefined, span: number | undefined, size: number): number | undefined => {
    if (value === undefined) return undefined
    if (from === undefined || span === undefined) return value
    return Math.max(from, Math.min(value, from + span - size))
  }
  const x = origin(merged.x, area?.x, area?.width, width ?? min.width)
  const y = origin(merged.y, area?.y, area?.height, height ?? min.height)
  return {
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {})
  }
}
