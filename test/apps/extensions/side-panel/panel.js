// "Back" does what an extension's panel does to hand over to its popup: a second history entry, then close.
document.getElementById('back').addEventListener('click', () => {
  location.hash = 'next'
  window.close()
})

// A page that saves on a timer, once the test arms it: it would write back whatever an uninstall had just emptied.
setInterval(() => {
  if (window.armed === true) {
    localStorage.setItem('armed', '1')
    localStorage.setItem('tick', String(Date.now()))
  }
}, 50)
