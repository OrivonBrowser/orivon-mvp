// Isolated-world preload. Exposes THREE variants of a probe API on the
// page's main world:
//
//   window.probeA -- plain contextBridge.exposeInMainWorld('probeA', {...}).
//     Captures the stack in the ISOLATED world (crossing the bridge first).
//   window.probeB -- mirrors src/preload/surface/main-world-socket.ts's own
//     shape: closures handed to contextBridge.executeInMainWorld's `args`,
//     serialised and re-run fresh in the main world. Also captures in the
//     ISOLATED world.
//   window.probeM -- captures the stack IN THE MAIN WORLD itself, using
//     intrinsics captured at install time so a later main-world tamper
//     cannot reach them. Only plain frame data crosses back, via
//     bridgeM.report.
//
// probeA/probeB's call(tag, opts) records `new Error().stack` as a plain
// string, plus a structured CallSite walk via a local
// Error.prepareStackTrace override. opts.deep raises
// Error.stackTraceLimit to Infinity for one capture; opts.perf skips the
// IPC send and returns the frame count instead, for timing.
const { contextBridge, ipcRenderer } = require('electron')

function capture (tag, opts) {
  opts = opts || {}
  let stackString = null
  try { stackString = new Error('capture:' + tag).stack } catch (e) { stackString = 'ERR:' + (e && e.message) }

  let frames = null
  let frameErr = null
  const prevPrepare = Error.prepareStackTrace
  const prevLimit = Error.stackTraceLimit
  try {
    if (opts.deep) Error.stackTraceLimit = Infinity
    Error.prepareStackTrace = function (_err, structuredStack) { return structuredStack }
    const e2 = new Error()
    const raw = e2.stack
    frames = raw.map(function (cs) {
      try {
        return {
          fileName: cs.getFileName(),
          scriptNameOrSourceURL: cs.getScriptNameOrSourceURL(),
          isEval: cs.isEval(),
          evalOrigin: cs.getEvalOrigin(),
          functionName: cs.getFunctionName(),
          isNative: cs.isNative()
        }
      } catch (inner) {
        return { error: String(inner) }
      }
    })
  } catch (e) {
    frameErr = String((e && e.stack) || e)
  } finally {
    Error.prepareStackTrace = prevPrepare
    Error.stackTraceLimit = prevLimit
  }

  if (opts.perf) return frames ? frames.length : -1

  try {
    ipcRenderer.send('probe:call', {
      tag: tag,
      href: (typeof location !== 'undefined' ? location.href : null),
      stackString: stackString,
      frameCount: frames ? frames.length : 0,
      frames: frames,
      frameErr: frameErr,
      variant: 'isolatedWorld',
      ts: Date.now()
    })
  } catch (e) {}

  return 'ack:' + tag
}

// Variant A: plain exposeInMainWorld.
contextBridge.exposeInMainWorld('probeA', {
  call: function (tag, opts) { return capture(tag, opts) }
})

// Variant B: mirror orivon's shape -- bridge of closures handed directly to
// executeInMainWorld's `args`, consumed by a serialised installer.
const bridge = {
  call: function (tag, opts) { return capture(tag, opts) }
}

function installProbeB (bridgeArg) {
  Object.defineProperty(window, 'probeB', {
    value: Object.freeze({
      call: function (tag, opts) { return bridgeArg.call(tag, opts) }
    }),
    writable: false,
    configurable: false,
    enumerable: true
  })
}

try {
  contextBridge.executeInMainWorld({ func: installProbeB, args: [bridge] })
} catch (e) {
  try {
    ipcRenderer.send('probe:call', { tag: 'installProbeB-threw', frameErr: String(e && e.stack || e) })
  } catch (e2) {}
}

// Variant M: capture the stack IN THE MAIN WORLD, inside the installed
// object itself, using intrinsics grabbed at install time (before any page
// or extension script has run). Only plain frame data crosses back.
const bridgeM = {
  report: function (tag, payload) {
    try {
      ipcRenderer.send('probe:call', {
        tag: tag,
        href: (typeof location !== 'undefined' ? location.href : null),
        frameCount: payload && payload.frames ? payload.frames.length : 0,
        frames: payload && payload.frames,
        tampered: !!(payload && payload.tampered),
        tamperReason: payload && payload.tamperReason,
        variant: 'mainWorld',
        ts: Date.now()
      })
    } catch (e) {}
  }
}

function installProbeM (bridgeArg) {
  // Private references, taken before any page/extension script has had a
  // chance to run (executeInMainWorld runs this at preload time). A later
  // reassignment of window.Error, or of Error.captureStackTrace/
  // Reflect.defineProperty as own properties, cannot reach these locals.
  const E = Error
  const nativeCaptureStackTrace = E.captureStackTrace
  const defineProperty = Reflect.defineProperty
  const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor
  const apply = Reflect.apply
  const arrayMap = Array.prototype.map

  function mapFrames (raw) {
    return apply(arrayMap, raw, [function (cs) {
      try {
        return {
          fileName: cs.getFileName(),
          scriptNameOrSourceURL: cs.getScriptNameOrSourceURL(),
          isEval: cs.isEval(),
          evalOrigin: cs.getEvalOrigin(),
          functionName: cs.getFunctionName()
        }
      } catch (inner) {
        return { error: String(inner) }
      }
    }])
  }

  function call (tag, opts) {
    opts = opts || {}
    let tampered = false
    let tamperReason = null
    let frames = null

    // Try to install our own prepareStackTrace. If Error.prepareStackTrace
    // has been made non-configurable (tamper case a), this fails and we
    // refuse outright -- we have no way to capture a trustworthy stack.
    const savedPST = getOwnPropertyDescriptor(E, 'prepareStackTrace')
    let definedPST = false
    try {
      definedPST = defineProperty(E, 'prepareStackTrace', {
        value: function (_err, structuredStack) { return structuredStack },
        writable: true,
        configurable: true,
        enumerable: false
      })
    } catch (e) { definedPST = false }
    if (!definedPST) {
      tampered = true
      tamperReason = 'prepareStackTrace not redefinable'
    }

    // Defend against Error.stackTraceLimit = 0 (tamper case d) by raising
    // it ourselves around the capture. If THAT redefinition also fails
    // because the property was frozen at 0 (tamper case e), record it as
    // its own tamper signal -- our defence cannot help there.
    const savedLimitDesc = getOwnPropertyDescriptor(E, 'stackTraceLimit')
    let definedLimit = false
    try {
      definedLimit = defineProperty(E, 'stackTraceLimit', {
        value: Infinity, writable: true, configurable: true, enumerable: false
      })
    } catch (e) { definedLimit = false }
    if (!definedLimit && savedLimitDesc && savedLimitDesc.value === 0 && !savedLimitDesc.writable) {
      tampered = true
      tamperReason = (tamperReason ? tamperReason + '; ' : '') + 'stackTraceLimit frozen at 0'
    }

    if (definedPST) {
      const holder = {}
      try {
        if (typeof nativeCaptureStackTrace === 'function') {
          apply(nativeCaptureStackTrace, E, [holder])
        } else {
          holder.stack = (new E()).stack
        }
        const raw = holder.stack
        if (raw && raw.length) {
          frames = mapFrames(raw)
          if (frames.length === 0) {
            tampered = true
            tamperReason = (tamperReason ? tamperReason + '; ' : '') + 'zero frames captured'
          }
        } else {
          tampered = true
          tamperReason = (tamperReason ? tamperReason + '; ' : '') + 'no stack produced'
        }
      } catch (e) {
        tampered = true
        tamperReason = (tamperReason ? tamperReason + '; ' : '') + 'capture threw: ' + String(e)
      } finally {
        try {
          if (savedPST) defineProperty(E, 'prepareStackTrace', savedPST)
          else delete E.prepareStackTrace
        } catch (e2) {}
        try {
          if (definedLimit) {
            if (savedLimitDesc) defineProperty(E, 'stackTraceLimit', savedLimitDesc)
            else delete E.stackTraceLimit
          }
        } catch (e3) {}
      }
    }

    if (opts.perf) return frames ? frames.length : -1

    try { bridgeArg.report(tag, { frames: frames, tampered: tampered, tamperReason: tamperReason }) } catch (e) {}

    return tampered ? 'refused:' + tag : 'ack:' + tag
  }

  Reflect.defineProperty(window, 'probeM', {
    value: Object.freeze({ call: call }),
    writable: false,
    configurable: false,
    enumerable: true
  })
}

try {
  contextBridge.executeInMainWorld({ func: installProbeM, args: [bridgeM] })
} catch (e) {
  try {
    ipcRenderer.send('probe:call', { tag: 'installProbeM-threw', frameErr: String(e && e.stack || e) })
  } catch (e2) {}
}
