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
      // Universal reasoning ladder: any model whose adapter declares NO
      // reasoning capability still exposes the full thinking-level ladder
      // (off/minimal/low/medium/high/xhigh/max), so the model picker's
      // 推理等级 control is available for every model and every provider.
      [
        'const DEFAULT_RETRYABLE_CODES = Object.freeze([',
        'const UNIVERSAL_REASONING_LEVELS = Object.freeze([\n' +
          '\tObject.freeze({ id: "off", name: "Off" }),\n' +
          '\tObject.freeze({ id: "minimal", name: "Minimal" }),\n' +
          '\tObject.freeze({ id: "low", name: "Low" }),\n' +
          '\tObject.freeze({ id: "medium", name: "Medium" }),\n' +
          '\tObject.freeze({ id: "high", name: "High" }),\n' +
          '\tObject.freeze({ id: "xhigh", name: "Extra High" }),\n' +
          '\tObject.freeze({ id: "max", name: "Max" })\n' +
          ']);\n' +
          'const DEFAULT_RETRYABLE_CODES = Object.freeze([',
      ],
      // Fill the reasoning metadata for models without any (universal ladder,
      // no forced default: the picker offers "Default" + the seven levels).
      [
        'const reasoning = resolved.reasoning;\n\t\tif (reasoning === void 0) return info;',
        'const reasoning = resolved.reasoning;\n' +
          '\tif (reasoning === void 0) return {\n' +
          '\t\t...info,\n' +
          '\t\treasoning: {\n' +
          '\t\t\tefforts: UNIVERSAL_REASONING_LEVELS.map((effort) => ({ ...effort }))\n' +
          '\t\t}\n' +
          '\t};',
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
  {
    pkg: '@deepseek-ai/dsh-llm-pi-ai',
    replacements: [
      // Friendlier display names for the reasoning ladder (xhigh -> Extra High).
      [
        'import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";',
        'import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";\n' +
          '/** Display names for the reasoning ladder. */\n' +
          'const REASONING_LEVEL_NAMES = Object.freeze({\n' +
          '\toff: "Off",\n' +
          '\tminimal: "Minimal",\n' +
          '\tlow: "Low",\n' +
          '\tmedium: "Medium",\n' +
          '\thigh: "High",\n' +
          '\txhigh: "Extra High",\n' +
          '\tmax: "Max"\n' +
          '});',
      ],
      // Universal thinking for models pi-ai knows nothing about (hand-declared
      // providers, models without a catalog reasoning flag): instead of marking
      // them non-reasoning (`reasoning: false`, which hides the 推理等级 control
      // and suppresses every reasoning wire knob), give them a universal
      // thinkingLevelMap. Every level maps to its own wire spelling, so a chosen
      // level is sent as-is (`reasoning_effort` etc.) and the provider decides.
      // "off" stays absent from the map so the no-selection default keeps
      // sending nothing (provider default), exactly as before.
      [
        'if (efforts === void 0) return { reasoning: base?.reasoning ?? false };',
        'if (efforts === void 0) {\n' +
          '\t\tif (base?.reasoning === false) return { reasoning: false };\n' +
          '\t\tif (base?.reasoning === true) return { reasoning: true };\n' +
          '\t\treturn {\n' +
          '\t\t\treasoning: true,\n' +
          '\t\t\tthinkingLevelMap: {\n' +
          '\t\t\t\tminimal: "minimal",\n' +
          '\t\t\t\tlow: "low",\n' +
          '\t\t\t\tmedium: "medium",\n' +
          '\t\t\t\thigh: "high",\n' +
          '\t\t\t\txhigh: "xhigh",\n' +
          '\t\t\t\tmax: "max"\n' +
          '\t\t\t}\n' +
          '\t\t};\n' +
          '\t}',
      ],
      // Use the friendlier names in the picker metadata.
      [
        'name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`',
        'name: REASONING_LEVEL_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`',
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
