// The Chrome-style on/off control every capability row uses. A real
// `<button role="switch">`, not a checkbox styled to look like one -- a
// switch has no associated `<label for>` semantics to get right, and the
// visual state IS the accessible state (`aria-checked`), so there is
// nothing else to keep in sync.

export function createSwitch (checked: boolean, disabled: boolean, onToggle: (next: boolean) => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'switch'
  button.setAttribute('role', 'switch')
  button.setAttribute('aria-checked', String(checked))
  button.classList.toggle('on', checked)
  button.disabled = disabled

  const thumb = document.createElement('span')
  thumb.className = 'switch-thumb'
  button.append(thumb)

  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true'
    button.setAttribute('aria-checked', String(next))
    button.classList.toggle('on', next)
    onToggle(next)
  })

  return button
}
