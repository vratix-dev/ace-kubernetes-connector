const { readFileSync } = require('node:fs')
try {
  const state = JSON.parse(readFileSync('/tmp/ace-connector-health.json','utf8'))
  const at = process.argv[2] === 'ready' ? state.connectedAt : state.attemptedAt
  process.exitCode = Number.isFinite(at) && Date.now()-at < (process.argv[2] === 'ready' ? 60000 : 120000) ? 0 : 1
} catch { process.exitCode = 1 }
