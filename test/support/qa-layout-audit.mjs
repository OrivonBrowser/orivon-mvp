// In-page layout audit. Runs inside a renderer through page.evaluate(), so it
// must be self-contained and must stay plain JavaScript: a TypeScript
// transform can inject helpers (esbuild's __name) that do not exist in the page.
// qa-visual.ts is the caller; the rules and their reasons are listed there.

/**
 * @param {{ verticalScroll?: 'allow' | 'forbid' }} [options]
 * @returns {Array<{ rule: string, selector: string, detail: string }>}
 */
export function layoutAudit (options = {}) {
  const PER_RULE_CAP = 25 // inside: only the function body is sent to the page
  const findings = []
  const counts = {}
  const add = (rule, el, detail) => {
    counts[rule] = (counts[rule] ?? 0) + 1
    if (counts[rule] <= PER_RULE_CAP) findings.push({ rule, selector: describe(el), detail })
  }

  function describe (el) {
    if (el === document.documentElement) return 'html'
    let out = el.tagName.toLowerCase()
    if (el.id) out += '#' + el.id
    else if (typeof el.className === 'string' && el.className.trim()) out += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ')
    return text ? `${out} "${text.slice(0, 30)}"` : out
  }

  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const all = [...document.body.querySelectorAll('*')].filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible')
  const rectOf = (el) => el.getBoundingClientRect()

  // An ancestor that clips or scrolls its overflow makes "outside the
  // viewport" intentional for everything inside it.
  const clippingAncestor = (el) => {
    for (let p = el.parentElement; p !== null && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p)
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return p
    }
    return null
  }

  for (const el of all) {
    const r = rectOf(el)
    if (r.width <= 1 || r.height <= 1) continue
    const s = getComputedStyle(el)
    const fixed = s.position === 'fixed'
    if ((r.right > vw + 1 || r.left < -1) && clippingAncestor(el) === null) {
      add('outside-viewport', el, `x ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`)
    } else if (fixed && (r.bottom > vh + 1 || r.top < -1)) {
      add('outside-viewport', el, `fixed, y ${Math.round(r.top)}..${Math.round(r.bottom)} of ${vh}`)
    }
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '')
    if (hasOwnText) {
      const ox = s.overflowX
      const oy = s.overflowY
      if ((ox === 'hidden' || ox === 'clip') && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis') {
        add('clipped-text', el, `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}, no ellipsis`)
      }
      const clamp = s.webkitLineClamp
      if ((oy === 'hidden' || oy === 'clip') && el.scrollHeight > el.clientHeight + 1 && (clamp === 'none' || clamp === '')) {
        add('clipped-text', el, `scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}`)
      }
    }
  }

  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [tabindex]:not([tabindex="-1"])'
  for (const el of document.body.querySelectorAll(INTERACTIVE)) {
    if (el.getClientRects().length === 0) continue
    // An inert control takes no click and no focus: a page under a modal is meant to be covered by it.
    if (el.closest('[inert]') !== null) continue
    const s = getComputedStyle(el)
    if (s.visibility !== 'visible' || s.pointerEvents === 'none') continue
    const r = rectOf(el)
    if (r.width === 0 || r.height === 0) {
      add('invisible-control', el, `zero-size control ${r.width}x${r.height}`)
      continue
    }
    // Not audited: a control hidden by opacity. Hover-revealed buttons (a tab's
    // close button), fades and custom checkboxes make that mostly intended.
    const nativeInput = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'

    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2))
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2))
    if (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) continue
    const clip = clippingAncestor(el)
    if (clip !== null) {
      const c = clip.getBoundingClientRect()
      if (cx < c.left || cx > c.right || cy < c.top || cy > c.bottom) continue
    }
    const hit = document.elementFromPoint(cx, cy)
    if (hit !== null && !el.contains(hit) && !hit.contains(el)) add('overlapped-control', el, `covered by ${describe(hit)} at ${Math.round(cx)},${Math.round(cy)}`)

    if (el.disabled === true && el.getAttribute('aria-disabled') === 'false') add('disabled-mismatch', el, 'disabled but aria-disabled="false"')
    if (nativeInput || el.tagName === 'BUTTON') {
      if (el.disabled !== true && el.getAttribute('aria-disabled') === 'true') add('disabled-mismatch', el, 'aria-disabled="true" but still clickable')
    }
  }

  const doc = document.scrollingElement ?? document.documentElement
  if (doc.scrollWidth > vw + 1) add('unexpected-scroll', document.documentElement, `horizontal: scrollWidth ${doc.scrollWidth} > ${vw}`)
  if (options.verticalScroll === 'forbid' && doc.scrollHeight > vh + 1) add('unexpected-scroll', document.documentElement, `vertical: scrollHeight ${doc.scrollHeight} > ${vh}`)

  for (const img of document.body.querySelectorAll('img')) {
    if (img.getClientRects().length > 0 && img.complete && img.naturalWidth === 0 && img.currentSrc !== '') add('broken-image', img, `failed to load ${img.currentSrc.slice(0, 80)}`)
  }
  for (const svg of document.body.querySelectorAll('svg')) {
    if (svg.getClientRects().length === 0 || rectOf(svg).width === 0) continue
    let box
    try { box = svg.getBBox() } catch { continue }
    if (box.width === 0 && box.height === 0) add('broken-image', svg, 'svg renders nothing')
  }

  for (const el of document.body.querySelectorAll('[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]')) {
    if (el.getClientRects().length === 0) continue
    const r = rectOf(el)
    if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) add('modal-placement', el, `extends outside the ${vw}x${vh} viewport`)
    else if (Math.abs(r.left + r.width / 2 - vw / 2) > 24) add('modal-placement', el, `horizontal centre ${Math.round(r.left + r.width / 2)} vs viewport ${Math.round(vw / 2)}`)
  }

  for (const [rule, n] of Object.entries(counts)) {
    if (n > PER_RULE_CAP) findings.push({ rule, selector: '(more)', detail: `${n - PER_RULE_CAP} further ${rule} findings not listed` })
  }
  return findings
}
