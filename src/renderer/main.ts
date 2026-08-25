declare global {
  interface Window {
    orivon?: { version: number }
  }
}

const target = document.querySelector('#api-version')
if (target !== null) {
  const version = window.orivon?.version
  target.textContent = version === undefined
    ? 'orivon.* not exposed - preload did not run'
    : `orivon.version === ${String(version)}`
}

export {}
