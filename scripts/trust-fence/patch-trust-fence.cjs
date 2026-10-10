'use strict'
/**
 * 信任栅栏逃生门（DSH_DISABLE_TRUST_FENCE=1）。
 *
 * 关掉 dsh 的浏览器信任栅栏与会话（token/cookie）鉴权，共四处：
 *  - 主机端 /api 的 Host/Origin/cross-site 校验（dsh-client-connection lib/index.js）；
 *  - 主机端浏览器会话鉴权 BrowserAuth.isAuthenticated（同包）；
 *  - 浏览器端把本页当成 loopback，让 settings（模型 / 凭证页）在远程浏览器也可用
 *    （dsh-client-connection lib/client.js）；
 *  - 把 __DSH_TRUST_FENCE_OFF__ 注入页面全局（dsh-client-modules），供客户端读取。
 *
 * 已安装插件自带的 /sidebar 路由由容器启动脚本 plugin-fence/patch-plugin-fence.cjs 处理。
 * 安全提示：关掉后没有任何鉴权层，只应放在自己的反代 / VPN 之后。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-trust-fence'
const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error(NAME + ': pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}
const log = (message) => console.log(NAME + ': ' + message)

// 在工作区里按包名定位唯一的包目录（packages/<tier>/<name> / apps/* / vendor/*）。
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
    throw new Error(NAME + ': expected exactly one workspace dir for "' + name + '", found ' + candidates.length)
  }
  return candidates[0]
}

// 补丁目标文件：包内 exports["."] 的 default/import 或 main 指向的编译产物。
function entryFile(pkgDir, name) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const def = pj.exports?.['.']?.default ?? pj?.exports?.['.']?.import ?? pj.main
  if (typeof def !== 'string' || def.length === 0) {
    throw new Error(NAME + ': cannot resolve the entry file of "' + name + '"')
  }
  return path.resolve(pkgDir, def)
}

// 逐条替换，单次生效且幂等：条目为 [from, to, all?, marker?]。
//   from   默认必须在文件里恰好出现一次（all 为真时允许 0 次以上，全部替换）；
//   marker 默认取 to，命中即视为本补丁已应用，直接跳过；
//   锚点不匹配则以非零码退出（构建即失败），绝不静默跳过。
//
// 历史实现迁移：本脚本换过锚点（0.2.1-alpha.2 不再锚 isTrustedApiRequest /
// isAuthenticated 的签名行）。旧修订打过的产物里，旁路留在**老位置**；若新锚点的 marker
// 匹配不到老位置，就会再插一条，同一个函数里出现两条等价的 `return true`——语义等价但
// 是脏产物。这里登记「旧修订会留下、新修订已不再产生」的组合，每轮开始时先恢复成上游形态，
// 再按新锚点重打，使新旧产物都收敛到同一终态。
//
// 注意：只登记**新旧形态确实不同**的组合。isTrustedApiRequest 新旧锚点插出来的组合完全
// 相同（guard 后紧跟取 Host 头那行），marker 天然命中、不会重复，登记反而会在已应用状态
// 下把唯一的旁路删掉，导致每轮来回增删（非幂等），所以这里不能登记它。
const LEGACY_LINES = [
  // 老锚点：旁路插在 isAuthenticated 首行 requestAuthority(...) 之前（0.2.1-alpha.1 形态）。
  [
    '\t\tif (process.env.DSH_DISABLE_TRUST_FENCE === "1") return true;\n\t\tconst authority = requestAuthority(request.headers);',
    '\t\tconst authority = requestAuthority(request.headers);',
  ],
]

// 把旧修订留下的组合恢复成上游形态（幂等；产物里不存在时零改动）。
function dropLegacyLines(src) {
  for (const [legacy, upstream] of LEGACY_LINES) {
    while (src.includes(legacy)) src = src.replace(legacy, upstream)
  }
  return src
}

function applyReplacements(display, src, replacements) {
  src = dropLegacyLines(src)
  for (const [from, to, all, marker] of replacements) {
    if (src.includes(marker ?? to)) {
      log('already applied in ' + display)
      continue
    }
    const count = src.split(from).length - 1
    if ((all && count === 0) || (!all && count !== 1)) {
      console.error(NAME + ': expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + from)
      process.exit(1)
    }
    src = all ? src.split(from).join(to) : src.replace(from, to)
  }
  return src
}
const targets = [
  {
    pkg: '@deepseek-ai/dsh-client-connection',
    replacements: [
      // Browser-trust fence bypass (opt-in: DSH_DISABLE_TRUST_FENCE=1). Disables
      // the Host/Origin/cross-site checks so any client that can reach the port
      // may call the /api — use only behind your own auth.
      // 0.2.1-alpha.2 给该函数加了 bindHost / protocol 两个参数（并据此判定 bind
      // 地址），所以**不锚签名行**：改锚函数体里两条签名之后都唯一的第一条语句
      // （取 Host 头），旁路插在它前面——此时函数已进入，一进来就短路，与签名无关。
      [
        '\tconst host = header$1(request.headers, "host");',
        '\tif (process.env.DSH_DISABLE_TRUST_FENCE === "1") return true;\n\tconst host = header$1(request.headers, "host");',
      ],
      // Browser-session (cookie/token) auth bypass — the second half of the same
      // opt-in. Since 0.1.3-alpha.1 the /api and the index page additionally
      // demand a valid browser session: a launch ?token= on the root URL mints
      // a signed cookie, and a trusted-but-unauthenticated request otherwise
      // gets 401 even when the Host/Origin fence is off — which is what shows up
      // as "token parameter" authentication for a non-loopback browser. Every
      // auth decision funnels through BrowserAuth.isAuthenticated
      // (requestRejection for the API/channels/WebSocket, authorizeIndex for
      // serving index.html), so under DSH_DISABLE_TRUST_FENCE=1 it always passes
      // and the whole GUI opens without any token/cookie — use only behind your
      // own auth.
      // 0.2.1-alpha.2 起签名变成 isAuthenticated(request, secure = false)，且首行
      // 取 authority 的函数由 requestAuthority 改名 requestAudience（多一个 secure
      // 参数）。锚点不锚签名/首行，改用两条签名之后都唯一的 cookie 取值行，把旁路
      // 插在它前面（此时 request/secure 都已到位，函数一进来就短路，与上游实现无关）。
      [
        '\t\tconst rawCookie = header(request.headers, "cookie");',
        '\t\tif (process.env.DSH_DISABLE_TRUST_FENCE === "1") return true;\n\t\tconst rawCookie = header(request.headers, "cookie");',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-client-connection',
    file: 'lib/client.js',
    replacements: [
      [
        'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
        'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || globalThis.__DSH_TRUST_FENCE_OFF__ === true,',
      ],
    ],
  },
  {
    pkg: '@deepseek-ai/dsh-client-modules',
    replacements: [
      [
        "\t\tvalue: graph\n\t});",
        "\t\tvalue: graph\n\t});\n\trows.push({\n\t\tkind: \"global\",\n\t\tname: \"__DSH_TRUST_FENCE_OFF__\",\n\t\tvalue: process.env.DSH_DISABLE_TRUST_FENCE === \"1\"\n\t});",
        void 0,
        'name: "__DSH_TRUST_FENCE_OFF__"',
      ],
    ],
  },
]
for (const { pkg, file, replacements, custom } of targets) {
  const dir = findPackageDir(pkg)
  const entry = path.resolve(dir, file ?? entryFile(dir, pkg))
  const display = path.relative(root, entry)
  let src = fs.readFileSync(entry, 'utf8')
  src = custom === void 0 ? applyReplacements(display, src, replacements) : custom(entry, src, log)
  fs.writeFileSync(entry, src)

  // 打完补丁的产物必须仍能通过语法检查。
  const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
  if (check.status !== 0) process.exit(check.status ?? 1)
  log('patched ' + display)
}
