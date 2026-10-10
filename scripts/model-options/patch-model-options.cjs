'use strict'
/**
 * 模型选择选项裁剪（一个功能、三条规则）：
 *
 *  1. 移除 **DeepSeek 官方渠道**（host 侧 provider id `deepseek-official`，即 API Key 路由，
 *     模型选择菜单里的分组名是「DeepSeek」）的模型选项。账号登录路由 `deepseek-account`
 *     与第三方提供方（NewAPI / pi-ai 等自定义 provider）不受影响。
 *  2. 移除推理等级里的 **Default**（provider-default）选项：适配器没有公布 defaultEffort
 *     的模型，上游会在已公布的等级前额外插入一个「Default」，代表「不指定、用提供方默认」；
 *     这里删掉该行，只保留模型真正公布的等级。
 *  3. 默认推理等级改为**最后一个**公布的等级：在 Host 目录落地时把每个模型的
 *     `reasoning.defaultEffort` 归一成 `efforts` 的最后一项。上游在没有 defaultEffort 时
 *     会让模型停在「未指定」——模型位显示 Default、等级菜单没有勾选行、从菜单选模型也不会
 *     带 reasoningEffort（请求交给适配器的默认）；归一之后这三处都变成最后一个等级，
 *     与规则 2「不再有 Default 这个等级」保持一致。**公布过 defaultEffort 的模型同样以最后
 *     一个等级为准**（本条是无条件覆盖，不是兜底）；模型没有公布等级（`reasoning` 缺失或
 *     `efforts` 为空）时保持原样。
 *
 * 三条规则都注入 `dsh-client-ui-model-selection` 的**浏览器产物** `lib/client.js`：
 *  - 规则 1 改的是会话级 `ModelDirectory.syncInputs()` 写进 store 的 `groups` —— composer 的
 *    模型位菜单与 `/model` 弹窗共用这一份目录，所以在这一处过滤即可同时覆盖两个入口；
 *    当前会话若正停在被移除渠道的模型上，触发器退化成上游既有的「provider/model ID」显示
 *    （上游在模型/提供方被删除时就是这个行为），菜单里不再有该渠道。
 *  - 规则 2 改的是 composer 模型位里构造 `effortChoices` 的那个条件，让它永远不插入
 *    provider-default 行；模型公布的等级与标签原样保留。
 *  - 规则 3 改的是 `ModelCatalogDirectory.load()`：在 `session/modelCatalog` 响应通过校验、
 *    写进 store 之前就地归一 `response.value.groups` 里每个模型的 defaultEffort。放在这里
 *    是因为模型位、`/model` 弹窗、目录显示与提交共用这份 catalog，改一处即全局生效。
 *  设置页的提供方 / 模型配置列表（`dsh-client-ui-settings-models`）与 subagent 授权卡片
 *  （`dsh-client-ui-settings-subagent`）不是「模型选择」，本脚本不动。
 *
 * 锚点兼容已验证的上游布局：0.1.7-rc.1 与 0.1.7-rc.2（`syncInputs` 只有 ready 分支
 * 写 `groups`）、0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-alpha.1（loading/error 分支也写一份
 * `groups`，两条都会打上；catalog 侧 0.1.7-rc.1 没有 reasoning 映射表，规则 3 的锚点在
 * 五种布局上都存在）。锚点缺失 / 命中次数不符直接报错退出（构建即失败），绝不静默跳过。
 *
 * 收尾复检：三条规则都按 marker 判定「已应用」，但 marker 只能证明**某一处**注入过。上游若
 * 再加一个写 `groups` 的分支、或产物停在半打补丁的中间态，光看 marker 会把「ready 分支已
 * 打、loading 分支漏打」误判成整条规则已完成（官方渠道会在目录加载中/出错时闪回来）。因此
 * 写盘前对产物做一次终态复检：**任何**写进 store 的 `groups` 都必须带官方渠道 marker，且
 * provider-default 的插入条件与 Default 行不得残留——任一条不满足即报错终止构建。
 *
 * 单一职责、自包含：本脚本不引用 scripts/ 下的任何其他脚本。清单见 docs/scripts.md。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const NAME = 'patch-model-options'
const PACKAGE = '@deepseek-ai/dsh-client-ui-model-selection'
/** 浏览器产物（package.json exports["./client"]）——上游把 client 面编译到同一个文件。 */
const CLIENT_ENTRY = 'lib/client.js'
/** 要移除的渠道：DeepSeek 官方 API Key 路由（账号路由 deepseek-account 不受影响）。 */
const OFFICIAL_PROVIDER = 'deepseek-official'

// 注入内容的稳定 marker（纯 ASCII、无引号，可安全放进 JS 表达式里）。
const MARKER = {
  officialChannel: '/*dsh-docker:model-options:official-channel*/',
  noDefaultEffort: '/*dsh-docker:model-options:no-default-effort*/',
  lastEffortDefault: '/*dsh-docker:model-options:last-effort-default*/',
}

const root = path.resolve(process.argv[2] ?? process.env.DSH_SOURCE_DIR ?? '')
if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error(NAME + ': pass the built source checkout dir as argv[1] (or set DSH_SOURCE_DIR)')
  process.exit(1)
}
const log = (message) => console.log(NAME + ': ' + message)

/** 在工作区里按包名定位唯一的包目录（packages/<tier>/<name> / apps/* / vendor/*）。 */
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

// 逐条替换，单次生效且幂等：条目为 [from, to, all?, marker?]。
//   from   默认必须在文件里恰好出现一次；all 为真时允许零次以上（零次=该上游布局没有
//          这条分支，全部命中则全部替换，用于兼容新旧布局）；
//   marker 默认取 to，命中即视为本补丁已应用，直接跳过；
//   锚点不匹配则以非零码退出（构建即失败），绝不静默跳过。
function applyReplacements(display, src, replacements) {
  for (const [from, to, all, marker] of replacements) {
    if (src.includes(marker ?? to)) {
      log('already applied in ' + display)
      continue
    }
    const count = src.split(from).length - 1
    if (!all && count !== 1) {
      console.error(NAME + ': expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + from)
      process.exit(1)
    }
    src = all ? src.split(from).join(to) : src.replace(from, to)
  }
  return src
}

// 规则 1：把一段 `groups` 表达式包成过滤掉官方渠道的表达式。
const withoutOfficial = (expression) =>
  `${MARKER.officialChannel}${expression}.filter((group) => group.id !== ${JSON.stringify(OFFICIAL_PROVIDER)})`

// 规则 3：catalog 响应校验通过之后、落地之前，把每个模型的默认推理等级归一成最后一个等级。
// 这一行在所有已验证布局里都是 `session/modelCatalog` 回调里唯一的 ok 校验：把注入块紧跟在
// 它后面（同一行内完成，不引入缩进/换行差异；此时 response.ok 必为真）。
const CATALOG_OK_LINE = 'if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);'
// 注入块用起止 marker 包住：重跑按 marker 整块原地替换，因此实现细节改了也能收敛到当前版本，
// 不会越打越多；起止 marker 都是 JS 注释，产物语法不受影响。
const LAST_EFFORT_START = MARKER.lastEffortDefault
const LAST_EFFORT_END = '/*dsh-docker:model-options:last-effort-default:end*/'
const LAST_EFFORT_CODE = [
  'for (const group of response.value.groups)',
  'for (const model of group.models) {',
  'const __efforts = model.reasoning?.efforts;',
  'if (__efforts !== void 0 && __efforts.length > 0) model.reasoning.defaultEffort = __efforts[__efforts.length - 1].id;',
  '}',
].join(' ')

// 规则 3 的 upsert：marker 块已存在就整块替换（老版本注入的块可能只有起始 marker，按行尾兜底），
// 否则以 catalog 的 ok 校验行为锚点追加；ok 行缺失/不唯一直接报错（构建即失败）。
function applyLastEffortDefault(src, display) {
  const block = LAST_EFFORT_START + LAST_EFFORT_CODE + LAST_EFFORT_END
  const at = src.indexOf(LAST_EFFORT_START)
  if (at >= 0) {
    let stop = src.indexOf(LAST_EFFORT_END, at + LAST_EFFORT_START.length)
    stop = stop >= 0 ? stop + LAST_EFFORT_END.length : src.indexOf('\n', at)
    if (stop < 0) stop = src.length
    if (src.slice(at, stop) === block) {
      log('already applied in ' + display)
      return src
    }
    return src.slice(0, at) + block + src.slice(stop)
  }
  const count = src.split(CATALOG_OK_LINE).length - 1
  if (count !== 1) {
    console.error(NAME + ': expected exactly one occurrence (found ' + count + ') in ' + display + ':\n  ' + CATALOG_OK_LINE)
    process.exit(1)
  }
  return src.replace(CATALOG_OK_LINE, CATALOG_OK_LINE + block)
}

// 终态复检：写盘前确认三条规则**真的**都落到产物上，而不是只有 marker 命中。
// 规则 1 的 marker 只能证明某一条 `groups` 分支打过。上游再加一条写 `groups` 的分支（0.1.7-rc.1
// → 0.1.7-rc.2 已经加过一次），或产物停在上次半打补丁的中间态时，只按 marker 会静默漏过滤，
// 官方渠道会在目录加载中/出错时重新出现——这正是本脚本要防的失效模式。因此把「所有写进 store
// 的 groups 都必须带官方渠道 marker」写成硬性复检，任一条不满足即报错终止构建。
function finalStateProblem(display, src) {
  const problems = []
  const groupLines = src.split('\n').filter((line) => line.includes('groups:') && line.includes('catalog.value'))
  if (groupLines.length === 0) problems.push('no `groups` assignment reads catalog.value (anchor layout changed?)')
  for (const line of groupLines) {
    if (!line.includes(MARKER.officialChannel)) {
      problems.push('a `groups` assignment is not filtered: ' + line.trim().slice(0, 120))
    }
  }
  if (src.includes('...reasoning.defaultEffort === void 0 ? [{')) {
    problems.push('the provider-default (Default) effort row is still inserted')
  }
  if (!src.includes('...' + MARKER.noDefaultEffort + 'false ? [{')) {
    problems.push('the provider-default suppression marker is missing')
  }
  if (!src.includes(LAST_EFFORT_START) || !src.includes(LAST_EFFORT_END)) {
    problems.push('the default-effort normalisation block is missing')
  }
  return problems.length === 0 ? null : display + ' failed final-state check: ' + problems.join('; ')
}

const replacements = [
  // 规则 1·ready 分支：所有上游版本都有这一条（0.1.7-rc.1 起）。
  [
    'groups: catalog.value.groups,',
    `groups: ${withoutOfficial('catalog.value.groups')},`,
  ],
  // 规则 1·loading/error 分支：0.1.7-rc.2 / 0.2.0 起才写 `?? []`，旧布局没有（all=true 允许零次）。
  [
    'groups: catalog.value?.groups ?? [],',
    `groups: ${withoutOfficial('(catalog.value?.groups ?? [])')},`,
    true,
  ],
  // 规则 2：把 provider-default 行的插入条件改成恒假，推理等级只剩模型公布的等级。
  // 产物里原表达式为 `[...<cond> ? [{ key: "provider-default", ... }] : [], ...efforts.map(...)]`。
  [
    '...reasoning.defaultEffort === void 0 ? [{',
    `...${MARKER.noDefaultEffort}false ? [{`,
  ],
]

const dir = findPackageDir(PACKAGE)
const entry = path.join(dir, CLIENT_ENTRY)
if (!fs.existsSync(entry)) {
  console.error(`${NAME}: ${PACKAGE} has no built browser bundle at ${entry}`)
  process.exit(1)
}
const display = path.relative(root, entry)
const before = fs.readFileSync(entry, 'utf8')
// 规则 3 的注入在规则 1/2 之后做（它按 marker 整块替换，与另外两条互不相干）。
const after = applyLastEffortDefault(applyReplacements(display, before, replacements), display)

// 终态复检对**最终内容**跑（不是只对新写入的部分）：已应用也要复检，这样半打补丁的旧产物
// （例如上游新增了 `groups` 分支、或上次构建被中断）重跑时会响亮失败，而不是继续带着漏过滤
// 的产物出镜像。复检不过就不写盘。
const problem = finalStateProblem(display, after)
if (problem !== null) {
  console.error(NAME + ': ' + problem)
  process.exit(1)
}

if (after === before) {
  log(display + ': already applied (no change)')
  process.exit(0)
}
fs.writeFileSync(entry, after)

// 打完补丁的产物必须仍能通过语法检查。
const check = spawnSync(process.execPath, ['--check', entry], { stdio: 'inherit' })
if (check.status !== 0) process.exit(check.status ?? 1)
log('patched ' + display)
