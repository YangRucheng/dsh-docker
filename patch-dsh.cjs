'use strict'
// Build-time patch for @deepseek-ai/dsh-llm (the compiled LLM core).
//
// dsh is consumed from npm as compiled JS, so we patch its build output rather
// than its source. Two env-driven tweaks, applied by text replacement:
//   1. DSH_RETRY -> overrides the default model-request retry count (default 30).
//   2. UA        -> overrides the `User-Agent` sent to the model provider.
//
// The patch bakes in the `process.env.*` READS (not literal values), so the
// values are resolved at RUNTIME: changing the env var and restarting the
// container works without rebuilding the image.
//
// Run with NODE_PATH pointing at the global node_modules so require.resolve
// finds the hoisted package, e.g.:
//   NODE_PATH="$(npm root -g)" node /tmp/patch-dsh.cjs

const fs = require('node:fs')

const entry = require.resolve('@deepseek-ai/dsh-llm')

const replacements = [
  // Failure retry count (was a hardcoded 2).
  [
    'const DEFAULT_MAX_RETRIES = 2;',
    'const DEFAULT_MAX_RETRIES = Number(process.env.DSH_RETRY ?? 30);',
  ],
  // Provider request User-Agent (was always `deepseek-harness/<version> (+url)`).
  [
    '`${identity.product}/${identity.version} (+${identity.url})`',
    'process.env.UA ?? `${identity.product}/${identity.version} (+${identity.url})`',
  ],
]

let src = fs.readFileSync(entry, 'utf8')
for (const [from, to] of replacements) {
  const count = src.split(from).length - 1
  if (count !== 1) {
    console.error(
      `patch-dsh: expected exactly one occurrence (found ${count}) in ${entry}:\n  ${from}`,
    )
    process.exit(1)
  }
  src = src.replace(from, to)
}
fs.writeFileSync(entry, src)
console.log(`patch-dsh: patched ${entry}`)
