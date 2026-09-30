// A QR code as drawn shapes. The encoder (qrcode-generator) only supplies the module matrix; the picture is
// built here from SVG primitives, so no markup string is ever parsed, and the same matrix draws the PNG.
import qrcode from 'qrcode-generator'
import { path, svg } from '../../pages/shared/svg-primitives.js'

/** Past this many characters the code is too dense to scan from a screen, so the sheet says so instead. */
export const MAX_QR_CHARACTERS = 2000
/** Modules of empty border a scanner needs around the code. */
export const QUIET_MODULES = 4

export interface QrMatrix {
  readonly size: number
  isDark: (row: number, column: number) => boolean
}

/** Text as the bytes the encoder takes: the encoder reads one byte per character, so anything outside ASCII is
 * percent-escaped first. A URL is ASCII already; this only matters for a display address that is not one. */
export function asciiOnly (text: string): string {
  return text.replace(/[^\x00-\x7f]/gu, (char) => encodeURIComponent(char))
}

/** The matrix for `text` at error correction M, or null when it is empty, too long, or does not fit any version. */
export function matrixFor (text: string): QrMatrix | null {
  const data = asciiOnly(text)
  if (data === '' || data.length > MAX_QR_CHARACTERS) return null
  try {
    const code = qrcode(0, 'M')
    code.addData(data)
    code.make()
    return { size: code.getModuleCount(), isDark: (row, column) => code.isDark(row, column) }
  } catch {
    return null
  }
}

/** One path: every horizontal run of dark modules is a rectangle, so a code is a few hundred segments, not thousands. */
export function pathData (matrix: QrMatrix): string {
  const rects: string[] = []
  for (let row = 0; row < matrix.size; row += 1) {
    let column = 0
    while (column < matrix.size) {
      if (!matrix.isDark(row, column)) { column += 1; continue }
      const start = column
      while (column < matrix.size && matrix.isDark(row, column)) column += 1
      rects.push(`M${String(start)} ${String(row)}h${String(column - start)}v1h-${String(column - start)}z`)
    }
  }
  return rects.join('')
}

/** The code as an SVG that scales to its box; black modules, no background (the tile behind it is white). */
export function qrSvg (matrix: QrMatrix): SVGSVGElement {
  const el = svg(`0 0 ${String(matrix.size)} ${String(matrix.size)}`)
  el.setAttribute('shape-rendering', 'crispEdges')
  const modules = path(pathData(matrix), '0')
  modules.setAttribute('fill', '#000')
  modules.setAttribute('stroke', 'none')
  el.append(modules)
  return el
}

/** The code as a PNG, base64 without its data-URL prefix: white ground, a quiet zone, `scale` pixels a module. */
export function qrPng (matrix: QrMatrix, scale = 8): string | undefined {
  const side = (matrix.size + 2 * QUIET_MODULES) * scale
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const context = canvas.getContext('2d')
  if (context === null) return undefined
  context.fillStyle = '#fff'
  context.fillRect(0, 0, side, side)
  context.fillStyle = '#000'
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.isDark(row, column)) context.fillRect((column + QUIET_MODULES) * scale, (row + QUIET_MODULES) * scale, scale, scale)
    }
  }
  const prefix = 'data:image/png;base64,'
  const url = canvas.toDataURL('image/png')
  return url.startsWith(prefix) ? url.slice(prefix.length) : undefined
}
