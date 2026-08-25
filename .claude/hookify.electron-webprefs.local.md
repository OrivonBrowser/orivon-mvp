---
name: block-insecure-webpreferences
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.(ts|tsx|js|mjs|cjs)$
  - field: content
    operator: regex_match
    pattern: nodeIntegration\s*:\s*true|contextIsolation\s*:\s*false|sandbox\s*:\s*false|webSecurity\s*:\s*false|allowRunningInsecureContent\s*:\s*true|enableRemoteModule\s*:\s*true|nodeIntegrationInWorker\s*:\s*true|nodeIntegrationInSubFrames\s*:\s*true|@electron/remote
---

**Insecure Electron webPreferences — blocked (`docs/architecture/security-model.md`).**

This is a browser that loads third-party apps. Every renderer runs with `contextIsolation: true`,
`sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. Apps reach the network and
filesystem only through the capability broker over `contextBridge` + IPC — never through Node
in the renderer. If a spike or test genuinely needs an exception, disable this rule explicitly
for that file and record why in `docs/open-questions.md`.
