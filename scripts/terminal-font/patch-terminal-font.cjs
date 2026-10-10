'use strict'
/**
 * 终端字体补上中文等宽回退族，让中日韩全角字符正好占两格。
 *
 * 上游给 GUI 终端（右栏 shell）写死的等宽字体栈是
 * `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`：前四个都是拉丁等宽字体，
 * 容器里一个都没有，落到泛型 `monospace` —— 在 Debian 上解析成 **DejaVu Sans Mono**
 * （拉丁步进 0.602em，实测 `W` = 7.83px @13px），而中文回退到 Noto Sans CJK SC
 * （全角步进 1.0em = 13px）。于是全角字符的步进只有拉丁格宽的 **1.661 倍**，而 xterm
 * 按 Unicode 宽度给它分配 **2 格**：中文就画在 2 格里但只占 1.66 格，右侧留缝、与 ASCII
 * 同排混排时整行错位，画框字符（`│─█`）也跟着一起歪。
 *
 * 修法是往字体栈里补上 **Noto Sans Mono CJK SC**（拉丁步进 0.5em、全角 1.0em 的等宽 CJK
 * 字体，Debian 的 fonts-noto-cjk 随包提供）。它既补上中文字形，又让「拉丁格宽 : 全角格宽」
 * 正好是 1 : 2 —— 实测 `W` = 6.5px、`中` = 13px，比值 **2.000**，与 xterm 的两格分配一致。
 * 插在泛型 `monospace` 之前、拉丁等宽字体之后：装了 SF Mono / Menlo / Consolas 的桌面端
 * 仍优先用它们画拉丁，没有那些字体的容器里则由 Noto 同时承担拉丁与中文，比例天然是 2:1。
 *
 * 只改浏览器编译产物 `lib/client.terminal.js`（终端按需加载的 chunk，由 dsh web 直接伺服），
 * 上游被 git 跟踪的 `src/client/*.tsx` 不动。两种上游布局的锚点都是**同一个字符串字面量**，
 * 因此一条替换同时覆盖：
 *   - 0.2.1-alpha.2 起：`const TERMINAL_FONT_STACK = "ui-monospace, ..."`（终端字体改为可配置，
 *     常量作为「用户列表之后的内建回退栈」）；
 *   - 0.2.1-alpha.1 及更早：`fontFamily: "ui-monospace, ..."` 直接写在 `new Terminal({...})` 里。
 * 锚点缺失或命中次数不是 1 直接报错退出（构建即失败），绝不静默跳过。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-terminal-font'
const PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
/** 终端 chunk：由同包 lib/client.js 的 `require.async("./client.terminal.js")` 按需加载。 */
const CHUNK = 'lib/client.terminal.js'

/** 上游写死的拉丁等宽字体栈（两种布局下都是这一份字符串字面量）。 */
const FROM = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
/**
 * 补上等宽 CJK 族；`Noto Sans Mono CJK SC` 是让全角正好占两格的那个（拉丁 0.5em / 全角 1.0em）。
 * 族名一律用**单引号**：上游把这份栈放在双引号 JS 字符串里，注入双引号会提前终止该字面量
 * （脚本自身语法校验会拦下，但一开始就别写错）。只加等宽 CJK 变体、不加比例字体（`Noto Sans
 * CJK SC`）：比例字体拉丁步进 0.878em，会让比例重新退回 1.66。
 */
const TO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans Mono CJK SC', monospace"
/**
 * 「已应用」判据：字体栈里已经点名了等宽 CJK 族。判据必须落在注入串本身（字体名），
 * 因为栈是 JS 字符串字面量，塞不进 `/*...*​/` 形式的注释 marker。
 */
const MARKER = "'Noto Sans Mono CJK SC'"

const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error(NAME + ': pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}
const log = (message) => console.log(NAME + ': ' + message)
const fail = (message) => {
  console.error(NAME + ': ' + message)
  process.exit(1)
}

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
    fail('expected exactly one workspace dir for "' + name + '", found ' + candidates.length)
  }
  return candidates[0]
}

const pkgDir = findPackageDir(PACKAGE)
const chunkFile = path.join(pkgDir, CHUNK)
if (!fs.existsSync(chunkFile)) {
  fail('terminal chunk not found: ' + path.relative(root, chunkFile) + ' (run `pnpm run build:lib` first)')
}
const display = path.relative(root, chunkFile)
const before = fs.readFileSync(chunkFile, 'utf8')

// 终态复检：字体栈必须点名等宽 CJK 族，且上游那份不含 CJK 的字面量一处不剩。复检对**最终
// 内容**跑（已应用状态同样过检），这样半打补丁 / 上游再改字体栈都会响亮失败而不是带病出镜像。
const markerCount = before.split(MARKER).length - 1
const staleCount = before.split(FROM).length - 1
if (markerCount > 0 && staleCount === 0) {
  log(display + ': already applied (no change)')
  process.exit(0)
}
if (markerCount > 0 && staleCount > 0) {
  fail('partial patch in ' + display + ': CJK family present but the upstream stack is still there '
    + '(' + staleCount + ' occurrence(s)) -- refusing to write a mixed font stack')
}
if (staleCount !== 1) {
  fail('expected exactly one occurrence (found ' + staleCount + ') in ' + display + ':\n  ' + FROM)
}

const after = before.replace(FROM, TO)

// 写盘前的终态复检（marker 就位 + 旧栈清零）。
if (!after.includes(MARKER)) fail('injected CJK family missing after patch in ' + display)
if (after.includes(FROM)) fail('upstream font stack still present after patch in ' + display)

fs.writeFileSync(chunkFile, after)

// 打完补丁的产物必须仍能通过语法检查。
const check = spawnSync(process.execPath, ['--check', chunkFile], { stdio: 'inherit' })
if (check.status !== 0) process.exit(check.status ?? 1)
log('patched ' + display)
