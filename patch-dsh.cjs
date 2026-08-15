'use strict'
// Build-time patch for dsh's compiled packages.
//
// dsh is consumed from npm as compiled JS, so we patch its build output rather
// than its source. Each patch bakes in a `process.env.*` READ (not a literal
// value), so the value is resolved at RUNTIME: changing the env var and
// restarting the container works without rebuilding.

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { execSync, spawnSync } = require('node:child_process')

// Resolve packages robustly: anchor resolution inside the installed
// @deepseek-ai/dsh package so each package is found whether npm hoisted it to
// the top-level node_modules or nested it under dsh/node_modules.
const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
const dshDir = path.join(globalRoot, '@deepseek-ai', 'dsh')
const req = createRequire(path.join(dshDir, 'package.json'))

const targets = [
  {
    pkg: '@deepseek-ai/dsh-llm',
    replacements: [
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
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-client-connection',
    replacements: [
      // Browser-trust fence bypass (opt-in: DSH_DISABLE_TRUST_FENCE=1). Disables
      // the Host/Origin/cross-site checks so any client that can reach the port
      // may call the /api — use only behind your own auth.
      [
        'function isTrustedApiRequest(request, trustedHosts) {',
        'function isTrustedApiRequest(request, trustedHosts) {\n\tif (process.env.DSH_DISABLE_TRUST_FENCE === "1") return true;',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-host-directory-picker-browse',
    replacements: [
      // Default directory: follow the container cwd (/workspace via WORKDIR)
      // instead of $HOME (which gosu points at /home/dsh). Overridable via env.
      [
        'const home = homedir()',
        'const home = process.env.DSH_DEFAULT_DIRECTORY ?? process.cwd()',
      ],
    ],
  },
]

for (const { pkg, replacements } of targets) {
  const entry = req.resolve(pkg)
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
}
