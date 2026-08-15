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

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { execSync, spawnSync } = require('node:child_process')

// Resolve @deepseek-ai/dsh-llm robustly: anchor resolution inside the installed
// @deepseek-ai/dsh package so the package is found whether npm hoisted it to the
// top-level node_modules or nested it under dsh/node_modules (npm nests some
// native deps like node-pty).
const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
const dshDir = path.join(globalRoot, '@deepseek-ai', 'dsh')
const req = createRequire(path.join(dshDir, 'package.json'))
const entry = req.resolve('@deepseek-ai/dsh-llm')

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

// The patched file must still parse.
const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
if (check.status !== 0) process.exit(check.status ?? 1)

console.log(`patch-dsh: patched ${entry}`)
