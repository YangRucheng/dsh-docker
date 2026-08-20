'use strict'
// Build-time patch for dsh's compiled packages, applied to a SOURCE checkout.
//
// dsh is built from the deepseek-harness monorepo (pnpm workspace): each
// package's compiled bundle lives in-package (packages/<tier>/<name>/lib).
// This script locates each target package by name (no reliance on npm's
// global-install layout, which pnpm's isolation does not reproduce), patches
// its built bundle in place, and bakes in `process.env.*` READs (not literal
// values) so the value is resolved at RUNTIME: changing the env var and
// restarting the container works without rebuilding.

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error('patch-dsh: pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}

// Workspace package dirs live under packages/<tier>/<name> (or apps/*, vendor/*).
function findPackageDir(name) {
  const candidates = []
  for (const sub of ['packages', 'apps', 'vendor']) {
    const base = path.join(root, sub)
    if (!fs.existsSync(base)) continue
    for (const tier of fs.readdirSync(base)) {
      const tierDir = path.join(base, tier)
      if (!fs.statSync(tierDir).isDirectory()) continue
      let dirs = [tierDir]
      if (sub === 'packages') {
        dirs = fs.readdirSync(tierDir)
          .filter((d) => fs.statSync(path.join(tierDir, d)).isDirectory())
          .map((d) => path.join(tierDir, d))
      }
      for (const dir of dirs) {
        const pj = path.join(dir, 'package.json')
        if (!fs.existsSync(pj)) continue
        try {
          if (JSON.parse(fs.readFileSync(pj, 'utf8')).name === name) candidates.push(dir)
        } catch {}
      }
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`patch-dsh: expected exactly one workspace dir for "${name}", found ${candidates.length}`)
  }
  return candidates[0]
}

// The compiled entry a patch rewrites: the package's `exports["."]` default or
// `main`, resolved relative to the package dir (lib/index.js for these hosts).
function entryFile(pkgDir, name) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const def = pj.exports?.['.']?.default ?? pj?.exports?.['.']?.import ?? pj.main
  if (typeof def !== 'string' || def.length === 0) {
    throw new Error(`patch-dsh: cannot resolve the entry file of "${name}"`)
  }
  return path.resolve(pkgDir, def)
}

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
      // reasoning capability still exposes a thinking-level ladder
      // (off/medium/high/xhigh/max, default high), so the model picker's
      // 推理等级 control is available for every model and every provider.
      [
        'const DEFAULT_RETRYABLE_CODES = Object.freeze([',
        'const UNIVERSAL_REASONING_LEVELS = Object.freeze([\n' +
          '\tObject.freeze({ id: "off", name: "Off" }),\n' +
          '\tObject.freeze({ id: "medium", name: "Medium" }),\n' +
          '\tObject.freeze({ id: "high", name: "High" }),\n' +
          '\tObject.freeze({ id: "xhigh", name: "XHigh" }),\n' +
          '\tObject.freeze({ id: "max", name: "Max" })\n' +
          ']);\n' +
          'const DEFAULT_RETRYABLE_CODES = Object.freeze([',
      ],
      // Fill the reasoning metadata for models without any (universal ladder
      // with a FORCED default of High -- the picker then offers no "Default"
      // entry and every selection/request carries high unless changed).
      [
        'const reasoning = resolved.reasoning;\n\t\tif (reasoning === void 0) return info;',
        'const reasoning = resolved.reasoning;\n' +
          '\t\tif (reasoning === void 0) return {\n' +
          '\t\t\t...info,\n' +
          '\t\t\treasoning: {\n' +
          '\t\t\t\tefforts: UNIVERSAL_REASONING_LEVELS.map((effort) => ({ ...effort })),\n' +
          '\t\t\t\tdefaultEffort: "high"\n' +
          '\t\t\t}\n' +
          '\t\t};',
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
          '\txhigh: "XHigh",\n' +
          '\tmax: "Max"\n' +
          '});',
      ],
      // Universal thinking for models pi-ai knows nothing about (hand-declared
      // providers, models without a catalog reasoning flag): instead of marking
      // them non-reasoning (`reasoning: false`, which hides the 推理等级 control
      // and suppresses every reasoning wire knob), give them a universal
      // thinkingLevelMap matching the universal ladder (off/medium/high/xhigh/max).
      // minimal/low are pinned to null (unsupported) because pi-ai reads an
      // ABSENT key as supported for the five base levels; medium/high/xhigh/max
      // map to their own wire spelling, so a chosen level is sent as-is
      // (`reasoning_effort` etc.) and the provider decides. "off" stays absent
      // from the map so no-level sends nothing. The `universal` marker lets
      // reasoningInfo force the High default (no "Default" entry in the picker).
      [
        'if (efforts === void 0) return { reasoning: base?.reasoning ?? false };',
        'if (efforts === void 0) {\n' +
          '\t\tif (base?.reasoning === false) return { reasoning: false };\n' +
          '\t\tif (base?.reasoning === true) return { reasoning: true };\n' +
          '\t\treturn {\n' +
          '\t\t\treasoning: true,\n' +
          '\t\t\tthinkingLevelMap: {\n' +
          '\t\t\t\tminimal: null,\n' +
          '\t\t\t\tlow: null,\n' +
          '\t\t\t\tmedium: "medium",\n' +
          '\t\t\t\thigh: "high",\n' +
          '\t\t\t\txhigh: "xhigh",\n' +
          '\t\t\t\tmax: "max"\n' +
          '\t\t\t},\n' +
          '\t\t\tuniversal: true\n' +
          '\t\t};\n' +
          '\t}',
      ],
      // Use the friendlier names in the picker metadata (must run BEFORE the
      // reasoningInfo rewrite below, which matches the post-name-mapping text).
      [
        'name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`',
        'name: REASONING_LEVEL_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`',
      ],
      // Force the High default for universal models (a configured profile-level
      // reasoning still wins); the "Default" option disappears once a default
      // effort is present.
      [
        'if (!model.reasoning) return {};\n\treturn { reasoning: {\n\t\tefforts: getSupportedThinkingLevels(model).map((level) => ({\n\t\t\tid: ReasoningEffortId(level),\n\t\t\tname: REASONING_LEVEL_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`\n\t\t})),\n\t\t...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }\n\t} };',
        'if (!model.reasoning) return {};\n\tconst effectiveDefault = defaultLevel ?? (model.universal === true ? "high" : void 0);\n\treturn { reasoning: {\n\t\tefforts: getSupportedThinkingLevels(model).map((level) => ({\n\t\t\tid: ReasoningEffortId(level),\n\t\t\tname: REASONING_LEVEL_NAMES[level] ?? `${level.charAt(0).toUpperCase()}${level.slice(1)}`\n\t\t})),\n\t\t...effectiveDefault === void 0 ? {} : { defaultEffort: ReasoningEffortId(effectiveDefault) }\n\t} };',
      ],
    ],
  },
  {
    // Mobile: hide the model name + thinking level in the composer's model seat
    // so the seat never overlaps the sibling read/write policy buttons in the
    // tool row on phones. The compiled client bundle inlines the CSS module as
    // a string with content-hashed class names, so the media-query suffix is
    // built from the triggerLabel/triggerEffort classes found in that same
    // bundle -- hash-independent and safe across dsh builds.
    pkg: '@deepseek-ai/dsh-client-ui-model-selection',
    file: 'lib/client.js',
    custom(entry, src, log) {
      const cssMatch = src.match(/const css = ("[^"]*");/)
      if (!cssMatch) throw new Error('patch-dsh: model-selection css const not found')
      const mapMatch = src.match(/module_css_default = \{\n([\s\S]*?)\n\s*\};/)
      const map = mapMatch?.[1] ?? ''
      const label = map.match(/"triggerLabel": "([^"]+)"/)?.[1]
      const effort = map.match(/"triggerEffort": "([^"]+)"/)?.[1]
      if (!label || !effort) throw new Error('patch-dsh: model-selection triggerLabel/triggerEffort classes not found')
      const suffix = `@media (max-width:560px){.${label},.${effort}{display:none}}`
      if (cssMatch[1].includes(suffix)) {
        log(`already applied in ${path.relative(root, entry)}`)
        return src
      }
      const newCss = cssMatch[1].slice(0, -1) + suffix + '"'
      return src.replace(cssMatch[0], `const css = ${newCss};`)
    },
  },
]

for (const { pkg, replacements, custom, file } of targets) {
  const dir = findPackageDir(pkg)
  const entry = path.resolve(dir, file ?? entryFile(dir, pkg))
  let src = fs.readFileSync(entry, 'utf8')
  if (custom !== undefined) {
    src = custom(entry, src, (msg) => console.log(`patch-dsh: ${msg}`))
  } else {
    for (const [from, to] of replacements) {
      const count = src.split(from).length - 1
      if (count === 0 && src.includes(to)) {
        console.log(`patch-dsh: already applied in ${path.relative(root, entry)}: ${from.slice(0, 60)}...`)
        continue
      }
      if (count !== 1) {
        console.error(
          `patch-dsh: expected exactly one occurrence (found ${count}) in ${path.relative(root, entry)}:\n  ${from}`,
        )
        process.exit(1)
      }
      src = src.replace(from, to)
    }
  }
  fs.writeFileSync(entry, src)

  // The patched file must still parse.
  const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
  if (check.status !== 0) process.exit(check.status ?? 1)

  console.log(`patch-dsh: patched ${path.relative(root, entry)}`)
}