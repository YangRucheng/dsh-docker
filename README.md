# deepseek-harness 镜像

基于 [deepseek-harness 仓库源码](https://github.com/deepseek-ai/deepseek-harness)（`dsh-v*` 发布标签）在镜像内构建的 DeepSeek Harness Docker 镜像：pnpm workspace 安装依赖、编译原生 system 扩展（flock / landlock 沙箱启动器）与所有包、Web 前端，再注入本仓库的构建时补丁（`scripts/` 下一个功能一个的单一职责脚本，清单见 [`docs/scripts.md`](docs/scripts.md)）。基础镜像为 `node:24-trixie-slim`（Debian 13 + Node 24），默认监听 `0.0.0.0`，配合 Docker 端口映射开箱即用。镜像由 GitHub Actions 定时检查上游最新发布标签并自动构建推送到腾讯云 CCR；**定时轮询发现上游版本变更时，工作流会先把新版本写进 `VERSION` 并提交推送，再构建镜像**（`:<版本>` 标签与 `VERSION` 始终对应当前构建的上游版本）。

镜像：`sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness`（`:latest` / `:<版本>`）　上游：<https://github.com/deepseek-ai/deepseek-harness>

## 仓库结构

```
scripts/<功能>/                     所有 hook 脚本，一个功能一个目录；每个脚本单一职责、自包含（脚本之间不互相引用）
  patch-<功能>.cjs                  构建时补丁：由 Dockerfile 按固定顺序调用，只改编译产物
  bind-host/*.patch.yml             配置载荷（dsh 的 cordis patch 层，非可执行）
  container-entrypoint/             容器入口编排脚本
  plugin-fence/                     容器启动时的运行时补丁
  dsh-version/*.sh                  CI 脚本：解析上游版本 / 同步 VERSION
docs/scripts.md                     脚本清单：每个脚本的作用、注入对象、环境变量与运行时机
Dockerfile                          多阶段构建（构建阶段依次执行 scripts/ 下的补丁脚本）
.github/workflows/build.yml         定时轮询上游 dsh 版本 → 更新 VERSION → 构建并推送镜像
VERSION                             当前镜像构建自哪个上游 dsh 版本（由工作流自动维护）
```

新增脚本前先读 [`docs/scripts.md`](docs/scripts.md) 的「新增脚本约定」：单一职责、自包含、失败要响亮、幂等，并在清单里登记。

## 使用

### 部署

`docker-compose.yml`：

```yaml
services:
  dsh:
    image: sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness:latest
    container_name: dsh
    restart: unless-stopped
    ports:
      - "3080:3080"
    environment:
      DEEPSEEK_API_KEY: "sk-..."
    volumes:
      - ./workspace:/workspace      # 工作目录
      - ./dsh-home:/root/.dsh   # 插件 / 配置 / 凭证 / 存储
```

```bash
docker compose up -d
```

打开 <http://localhost:3080>。

或 `docker run`：

```bash
docker run -d --name dsh \
  -p 3080:3080 \
  -e DEEPSEEK_API_KEY=sk-... \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/dsh-home:/root/.dsh" \
  sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness:latest
```

自建镜像（从上游源码构建，`DSH_REF` 为发布标签 / 分支 / commit，默认最新 `dsh-v*` 标签）：

```bash
docker build -t deepseek-harness:local .
docker build --build-arg DSH_REF=dsh-v0.1.0-rc.7 -t deepseek-harness:local .
```

### 需要配置的环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填，也可写进 `./dsh-home/.env`） | 无 |
| `DSH_PORT` | 监听端口 | `3080` |
| `DSH_DEFAULT_DIRECTORY` | 默认工作目录 | `/workspace`（容器当前目录） |
| `DSH_PERMISSION_MODE` | 部署级文件读写策略：`workspace-write`（沙箱限制在工作区内）/ `danger-full-access`（不限制，审批同时放行） | `workspace-write` |
| `DSH_RETRY` | 请求失败重试次数 | `30` |
| `DSH_RETRY_INITIAL_DELAY_MS` | 重试退避初始延迟（毫秒） | `500` |
| `DSH_RETRY_MAX_DELAY_MS` | 重试退避上限（毫秒） | `10000` |
| `DSH_RETRY_JITTER_RATIO` | 重试退避抖动比例（0–1） | `0.1` |
| `DSH_RETRYABLE_CODES` | 追加可重试的错误码（逗号分隔），如 `PI_AI_ERROR,HTTP_408`。网关的自定义报错文案若被归入不可重试的兜底错误码，加进来即可参与同一套退避重试 | 无 |
| `UA` | 覆盖请求模型供应商的 User-Agent | `deepseek-harness/<版本> (+url)` |
| `DSH_HOST` | `0.0.0.0` 或 `127.0.0.1`（仅本机） | `0.0.0.0` |
| `DSH_TRUSTED_HOSTS` | 信任的访问地址（空格/逗号分隔）：局域网 IP、域名、反向代理地址。`/api` 与插件路由（`/sidebar/*`）都会放行 | 无（容器自身的局域网 IP 自动受信） |
| `DSH_DISABLE_TRUST_FENCE` | 设为 `1` 彻底关闭信任栅栏**与浏览器会话（token/cookie）鉴权**，同时作用于 `/api`、已安装插件的路由（如 `/sidebar/*`）以及 0.1.3 起新增的会话认证——关闭后远程浏览器访问 `/api` 与首页不再要求携带 `?token=` 换取 cookie（不再 401），并解锁远程浏览器访问 settings（模型 / 凭证设置页，默认仅限 `localhost` 可用，远程显示「加载提供方目录失败」）；无鉴权，仅在你自己的反代 / 鉴权后使用 | 无 |
| `DSH_SHOW_WELCOME_NOTICE` | 设为 `1` 恢复首次进入 GUI 时的内测声明弹窗；默认（不设置）已通过构建时补丁跳过该弹窗 | 无 |

### `/auto-plan` 命令：计划退出自动批准

镜像通过 `scripts/auto-plan/patch-auto-plan.cjs` 为 `dsh-plan-mode` 注入 `/auto-plan` 命令：与 `/plan` 一样进入计划模式（`plan:policy` 引导、模型探索并制定计划），但当模型调用 `exit_plan_mode` 时**跳过用户评审确认卡片直接批准**，退出计划模式并继续执行计划——省去一次手动确认。`/auto-plan off` 与 `/plan off` 均可退出；auto 标记由会话日志折叠（`command/run` 记录），重启 / fork 后可恢复。普通 `/plan` 的行为完全不变（仍弹评审确认），在已激活计划会话中用 `/auto-plan` 或 `/plan` 可在两种模式间切换。

命令文案跟随界面语言：`/auto-plan` 是本仓库注入的命令，上游默认不认识它，因此 `/` 菜单里它只有宿主注册的英文描述。补丁脚本同时给 `dsh-client-ui-commands` 的浏览器产物登记它的菜单文案，中文界面显示「自动计划 / 进入或退出自动批准的计划模式」，英文界面显示 `Auto Plan / Enter or leave auto-approving plan mode`；其余第三方命令行为不变。上游 0.1.6 起把「内建命令」的识别方式从**比对描述文案**（`HOST_DESCRIPTION_KEYS`）改成**比对定义标识**（`BUILTINS` 的 `definitionId` + `HOST_FACES` 菜单面），所以脚本会按产物形态走两条注入路径：新版补 label / description / token 三组 zh/en 字典、`BUILTINS` 映射与 `HOST_FACES` 菜单面，旧版补 description 字典与 `[name, key]` 映射对。`/auto-plan` 与 `/plan` 由同一个包注册，因此宿主侧的 `definitionId` 用 `@deepseek-ai/dsh-plan-mode#auto-plan`（**必须**与 `/plan` 不同：新版按 `find` 首个匹配识别，共用 id 会让 `/auto-plan` 显示成「计划」）。该增强通过 `scripts/auto-plan/patch-auto-plan.cjs` 在构建时完成，无需额外配置。

### 红色 favicon

镜像通过 `scripts/red-favicon/patch-red-favicon.cjs` 把 favicon（浏览器标签页 / PWA 图标）换成红色版：鲸鱼标由上游的浅色模式黑色（`fill="#000"`）/ 深色模式白色统一改为固定红 `#E60012`，浅色与深色两种配色方案下都是红标。上游 0.1.7 起把深色配色拆成了独立文件：`/favicon.svg` 供浅色、`/favicon-dark.svg` 供深色，`index.html` 用两个带 `media` 的 `<link>` 引入；0.1.6 及更早则是单文件里 `<style>` 媒体查询的 `fill: #fff`。补丁两种布局都覆盖，且两种都对不上时报错终止构建（不会静默留下白标）。补丁只改 Web 构建产物 `apps/web/dist/favicon.svg` 与 `apps/web/dist/favicon-dark.svg`（dsh web 作为静态资源伺服），上游被 git 跟踪的源文件 `apps/web/public/favicon*.svg` 不受影响；颜色写死在脚本里，无需环境变量。

### 中文支持（locale 与字体）

`node:24-trixie-slim` 基础镜像既没有 UTF-8 locale 也没有中日韩字体，两者各自会让中文出问题；镜像构建时一并补齐：

- **UTF-8 locale**（`locales` + `localedef` 生成 `C.UTF-8` / `en_US.UTF-8` / `zh_CN.UTF-8`，并设 `ENV LANG=C.UTF-8`）：没有 UTF-8 ctype 时，POSIX 工具把字节当字符——`ps` 显示 `????`、`wc -m` 与 `awk length` 数出字节数（「中文」= 6 而不是 2）、`cut -c` / `fold -w` 会把一个汉字劈成两半、bash 的 `${#var}` 与行编辑也按字节算宽度，于是在终端里编辑中文命令行会错位。`LANG` 会被 `dsh web` 进程继承，而上游的子进程层在清洗环境变量时**刻意保留 locale**（`scrubbedParentEnv` 只剔除凭据形状与 `DSH_*` 变量），因此 agent 终端（terminal-bash）与 GUI 终端（terminal-controller）都自动生效，**无需改上游源码**。选 `C.UTF-8` 而不是 `zh_CN.UTF-8`：只打开多字节处理，不改变 `LC_MESSAGES` / `LC_COLLATE`，工具输出语言与排序顺序保持原样（`zh_CN.UTF-8` 会把排序变成拼音序）。
- **中日韩字体**（`fonts-noto-cjk` + `fontconfig`）：没有 CJK 字体时 fontconfig 对 `:lang=zh` 返回 DejaVu，而 DejaVu 没有汉字字形，容器内自己渲染的内容（headless Chromium / browser-use 截图、文档预览）会显示成豆腐块。
- **`git config --system core.quotepath false`**：不设时 git 会把中文文件名输出成八进制转义（`"\344\270\255\346\226\207.txt"`），中文路径在终端里没法直接读；这一项与 locale 无关，是 git 自己的默认行为。

构建时会对以上每一条做断言（locale 生成成功、`printf '\344\270\255\346\226\207' | wc -m` 必须是 2、`fc-match monospace:lang=zh-cn` 必须命中 CJK 字体），因此上游基础镜像或字体包变化会**响亮地让构建失败**，而不是静默推出一个中文坏掉的镜像。

### GUI 终端的中文等宽对齐

镜像通过 `scripts/terminal-font/patch-terminal-font.cjs` 给 GUI 终端（右栏 shell）的字体栈补上等宽 CJK 回退族。上游写死的字体栈是 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`：前四个都是拉丁等宽字体，容器里一个都没有，实际落到泛型 `monospace` → DejaVu Sans Mono（拉丁步进 0.602em），而汉字回退到 Noto Sans CJK（全角步进 1.0em）；结果全角字符的步进只有格宽的 **1.661 倍**，而 xterm 按 Unicode 宽度给它分配 **2 格**——中文画在 2 格里只占 1.66 格，右侧留缝，与 ASCII 混排时整行错位。

补丁往栈里插入 **`Noto Sans Mono CJK SC`**（`fonts-noto-cjk` 随包提供，拉丁 0.5em / 全角 1.0em），使「格宽 : 全角宽」正好是 **1 : 2**（实测 `W` = 6.5px、`中` = 13px，比值 2.000），与 xterm 的两格分配一致；插在拉丁等宽字体之后、泛型 `monospace` 之前，装了 SF Mono / Menlo / Consolas 的桌面端仍优先用它们画拉丁。**只加等宽 CJK 变体、不加比例字体**（`Noto Sans CJK SC` 拉丁步进 0.878em，会把比例重新退回 1.66）。

补丁只改浏览器编译产物 `lib/client.terminal.js`（终端按需加载的 chunk，由 `dsh web` 直接伺服），上游被 git 跟踪的源码不动。两种上游布局的锚点是同一个字符串字面量，一条替换同时覆盖——0.2.1-alpha.2 起是终端字体改为可配置后的内建回退常量 `TERMINAL_FONT_STACK`，0.2.1-alpha.1 及更早直接写在 `new Terminal({...})` 的 `fontFamily` 里；锚点缺失或命中次数不是 1 直接报错终止构建，出现「CJK 族已在、旧栈还在」的半打补丁状态同样报错拒写。

### 手机端 UI 优化

镜像通过 `scripts/mobile-ui/patch-mobile-ui.cjs`（一个脚本、五条规则）优化窄视口下的 GUI：

- **隐藏输入框里的模型名与思考等级**（视口 < 560px）：该座位在窄屏会与同一行的读写策略按钮重叠；
- **隐藏会话头部的 session log 导出入口**（视口 < 560px）：0.1.5-rc.1 起上游把它从独立下载按钮改成「更多操作」菜单，两个版本的类名都兼容；
- **折叠后的侧边栏不占页面宽度**（视口 < 1024px，对应上游 `SIDEBAR_AUTO_COLLAPSE`）：折叠时把三列 grid 强制成 `0 / 1fr / 0`（`!important` 压过组件内联样式），中心内容占满整页；
- **折叠后的侧边栏收起到左上角角标**（视口 < 1024px）：**44×44 品牌红 `#E60012` 实心圆角角标 + 白图标 + 投影**（上游默认的图标按钮是白底无阴影，叠在内容上几乎看不见），只留这一个入口——新建会话、全局面板列表（插件入口）、工作区、页脚、设置区在收起态全部隐藏，展开后恢复；角标直接显示展开图标（触屏没有 hover），点击即展开，再次折叠回到角标；
- **角标可拖动**（视口 < 1024px）：按住角标可以拖到任意位置，位置记在 `localStorage['dsh-docker:mobile-fab']` 并同步到 `:root` 的 `--dsh-fab-x/-y`，刷新 / 切会话都不丢，越界会按角标实测尺寸限幅在视口内；位移小于 6px 仍算「点击展开」，超过才当拖动（不会误触展开）。

第 3 条与第 4 条共同构成一条规范：折叠后不占页面宽度，且展开入口（角标）始终可见可点；第 5 条让这个入口可以拖开，免得它挡住会话内容。桌面端（≥1024px）行为与上游一致（56px rail）。所有隐藏类名与选择器都从**目标 css 串所属的** css map 解析（一个 bundle 里可能有多个 CSS module，按哈希无关的类名归属判定），无需改上游源码。

### 模型选择选项裁剪

镜像通过 `scripts/model-options/patch-model-options.cjs`（一个脚本、三条规则）裁剪模型选择界面里的选项：

- **移除 DeepSeek 官方渠道的模型**：host 侧 `deepseek-official` 是 API Key 路由（模型选择菜单里的分组名是「DeepSeek」），与账号登录路由 `deepseek-account`、第三方提供方（NewAPI / pi-ai 等自定义 provider）各自列出一份模型目录。补丁把官方渠道分组从模型列表里过滤掉，composer 模型位菜单与 `/model` 弹窗都不再显示它；账号路由与第三方提供方不受影响。过滤点在两个入口共用的会话级目录（`ModelDirectory.syncInputs()` 写进 store 的 `groups`），所以打一处即同时覆盖两个入口。
- **移除推理等级里的 Default**：适配器没有公布 `defaultEffort` 的模型，上游会在已公布等级前额外插入一行「Default」（代表「不指定、用提供方默认」）。补丁去掉这一行，只保留模型真正公布的等级——例如菜单原来是 Default / Off / High，现在只剩 Off / High。
- **默认推理等级取最后一个公布的等级**：删掉 Default 之后，模型若没有公布 `defaultEffort`，上游会让它停在「未指定」——模型位显示 Default、等级菜单没有勾选行、从菜单选中模型也不带 `reasoningEffort`。补丁在 `session/modelCatalog` 响应通过校验、写进目录之前，把每个模型的 `reasoning.defaultEffort` 归一成它 `efforts` 的最后一项，于是模型位显示、等级菜单的勾选行、以及选中模型时提交给 Host 的推理等级都变成最后一个等级（例如 Off / High 会默认 High）。**公布过 `defaultEffort` 的模型同样以最后一个等级为准**（这是无条件覆盖，不是兜底）；模型没有公布等级（无 `reasoning` 或 `efforts` 为空）时保持原样。

三条都只改 `dsh-client-ui-model-selection` 的浏览器产物 `lib/client.js`（构建时由 `pnpm build:lib` 产出，上游被 git 跟踪的 `src/client/*.tsx` 不动）。当前会话若正停在官方渠道的模型上，模型位会按上游既有的「已被移除的 provider/model ID」方式显示，直到用户重新选一个可用模型。设置页的提供方 / 模型配置列表与 subagent 授权卡片不属于「模型选择」，不在裁剪范围内。锚点缺失 / 命中次数不符会直接报错终止构建；已验证兼容 0.1.7-rc.1（`syncInputs` 只有 ready 分支写 `groups`）与 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-alpha.1（loading/error 分支也写一份，两条都过滤；catalog 侧的默认等级归一五种布局都打得上）。

写盘前还会跑一次**终态复检**：官方渠道的漏过滤属于「静默失效」——marker 只能证明某一条 `groups` 分支打过，上游若再加一条写 `groups` 的分支，只按 marker 会把「ready 分支已打、loading 分支漏打」误判成整条规则已完成，官方渠道会在目录加载中/出错时闪回来。因此复检要求**任何**写进 store 的 `groups` 都带官方渠道 marker、且 `provider-default` 的插入条件与 Default 行没有残留；缺一条就报错终止构建、不写盘。**已应用状态同样过复检**，所以半打补丁的旧产物重跑会响亮失败，而不是带着漏过滤的产物出镜像。

### 语音识别模型走国内镜像站

镜像通过 `scripts/speech-model-mirror/patch-speech-model-mirror.cjs` 让本地语音识别（SenseVoice 转写）的模型**优先**从国内可直连的 `https://hf-mirror.com` 下载：转写模型（int8 / fp32）、`tokens.txt` 与 Silero VAD 三份 pinned 资源都先取镜像站，不需要代理。

- 下载地址在上游是 `origin` + 清单里的 pathname 拼出来的（`runtime/assets.json` 只锁路径、字节数与 sha256，其中的 origin 不参与下载），所以补丁改的是**编译产物里 origin 的默认值**：`packages/experimental/speech-to-text-sensevoice` 的 `lib/index.js`（宿主侧真正发起下载）与 `lib/worker.js`（私有 worker 的同一份 schema），构建时由 `pnpm build:lib` 产出，上游被 git 跟踪的 `src/config.ts` 与 `runtime/assets.json` 不动。
- 上游 0.1.7-rc.1 起自己引入了多源回退（`modelOrigins` 默认 `["https://huggingface.co", "https://hf-mirror.com"]`，运行时并行 HEAD 探测、优先用先响应的源，其余作为回退）：补丁改为把镜像**挪到默认数组首位**、官方站保留为容灾回退。下载是**按顺序尝试**，探测无论成功还是超时都不会把镜像排到官方站之后，因此国内部署必定优先命中镜像站；0.1.7-alpha.2 及更早的单源版本则直接把默认 origin 换成镜像站。
- 上游的 `modelOrigin` 配置项保留原样：想换成别的 Hugging Face 兼容源（含私有镜像）时，在该 provider 的配置里显式指定即可，不必改镜像。
- 镜像站提供的就是上游 pin 住的那几份文件：`tokens.txt` 与 `silero_vad.onnx` 的 sha256 与上游锁定值逐字节相同，两个 onnx 权重的字节数也一致，因此运行时的 sha256 校验照常通过。

### 启动时自动初始化 profiles 目录

容器启动时会自动创建 `${DSH_HOME:-$HOME/.dsh}/profiles` 目录。这样即使把一个空的宿主机目录挂载到 `/root/.dsh`，首次启动也不会因为 profiles 目录不存在而提示错误；已有目录和其中的插件配置不会受到影响。

### 文件读写策略（沙箱）

镜像在构建阶段编译了上游 `native/system` 的两个原生二进制：会话写租约用的 POSIX flock 扩展，以及 Linux 沙箱用的静态 musl Landlock 启动器（`bin/landlock-run`）。两者都是上游仓库里 gitignored 的构建产物，源码构建必须自己编译——否则 addon 缺失会让会话在启动时直接抛 `Cannot find module .../bin/glibc/system.node`，沙箱则因为没有可用后端而拒绝执行命令（镜像内不装 bwrap，Linux 侧只有 Landlock 这一档；容器内探测结果为 `fully enforced`）。

因此容器默认的 `workspace-write` 策略是真正生效的：命令对工作区（`/workspace`）之外的写入由内核拒绝。若要让容器本身充当隔离边界（例如已用只读挂载、独立用户等收紧权限），可设 `DSH_PERMISSION_MODE=danger-full-access` 关闭沙箱（审批策略随之变为自动放行）。

### 预装 Claude Code CLI

镜像预装了 [Claude Code](https://code.claude.com/)（通过 `npm install -g @anthropic-ai/claude-code` 安装，跟随最新 release；npm 包与官方原生安装是同一份二进制，但不依赖 claude.ai 的地区可用性），容器内 `claude` 命令可直接使用，方便把它作为 sub agent 工具调用：

- **认证**：设置 `ANTHROPIC_API_KEY` 环境变量即可免登录使用；也可以把宿主机已有的 `~/.claude` 目录挂载进容器（`-v ~/.claude:/root/.claude`）复用登录态。认证与配置存放在 `/root/.claude`、`/root/.claude.json`，与 `/root/.dsh` 挂载互不影响。
- **版本更新**：npm 全局安装不自动更新（镜像里的 `DISABLE_AUTOUPDATER=1` 保持关闭），版本随重新构建镜像更新；容器内可随时用 `claude update` 手动升级。
- **验证**：构建时执行 `claude --version` 确认安装成功。
