// Non-blocking webRequest listener for <all_urls> -- this is the shape the
// PR (#45050) describes as triggering Chromium's per-extension URL loader
// factory proxy, which is what makes net.fetch hand it a null RenderFrameHost.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => { /* observe only, no return value */ },
  { urls: ['<all_urls>'] }
)
