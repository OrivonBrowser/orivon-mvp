const stage = process.env.PROBE_STAGE || 'A'
require(path_join(stage))
function path_join (stage) {
  const path = require('node:path')
  return path.join(__dirname, `stage-${stage.toLowerCase()}.js`)
}
