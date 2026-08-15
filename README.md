# deepseek-harness 镜像

基于 npm 发行版 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 构建 DeepSeek Harness 的 Docker 镜像，并通过 GitHub Actions 定时检查版本、自动构建并推送到腾讯云容器镜像服务（CCR）。

- 镜像地址：`sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness`
- 标签：`:latest` 与 `:<dsh 版本>`（如 `:0.1.0-rc.6`）
- 上游源码：<https://github.com/deepseek-ai/deepseek-harness>

## 特性

- 使用 npm 发行版安装 `dsh`，无需从源码构建前端。
- 定时（每日）检查 npm 上的最新 `dsh` 版本，有更新即自动构建并推送。
- 内置监听 `0.0.0.0` 的 patch，Docker `-p 3080:3080` 开箱即用。
- 支持 `UA` 环境变量覆盖请求模型供应商的 User-Agent、`DSH_RETRY` 环境变量设置重试次数（默认 30）。
- 两个挂载点：`/workspace`（工作目录）、`/home/dsh/.dsh`（插件 / 配置 / 凭证 / 存储）。

## 首次配置

### 1. 配置腾讯云 CCR

在[腾讯云容器镜像服务控制台](https://console.cloud.tencent.com/tcr)创建命名空间 `misaka-network` 和镜像仓库 `deepseek-harness`，并获取登录凭证（个人版用「长期密码 / 临时密码」，企业版用「访问凭证」）。

### 2. 配置仓库 Secrets

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 值 |
|---|---|
| `TENCENT_CCR_USERNAME` | CCR 登录用户名 |
| `TENCENT_CCR_PASSWORD` | CCR 登录密码 / token |

### 3. 触发构建

- **定时**：默认每日 02:00 UTC 自动检查（见 `.github/workflows/build.yml` 的 `cron`）。
- **手动**：Actions 页 → *check-and-build* → *Run workflow*（可填指定版本号，留空则用 npm 最新版）。
- **Push**：推送到 `main`（`VERSION`、`.md`、`.github` 变更除外）。

构建会推送两个标签 `:latest` 和 `:<版本号>`，并把版本号写回仓库的 `VERSION` 文件。

## 本地运行

### Docker Compose（推荐）

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
      - ./workspace:/workspace
      - ./dsh-home:/home/dsh/.dsh
```

```bash
docker compose up -d
```

打开 <http://localhost:3080>。

### docker run

```bash
docker run -d --name dsh \
  -p 3080:3080 \
  -e DEEPSEEK_API_KEY=sk-... \
  -v "$PWD/workspace:/workspace" \
  -v "$PWD/dsh-home:/home/dsh/.dsh" \
  sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness:latest
```

## 挂载点

| 容器路径 | 用途 |
|---|---|
| `/workspace` | 工作目录（agent 的 workspace root，放你的项目文件） |
| `/home/dsh/.dsh` | `DSH_HOME`：插件（`profiles/`）、凭证（`.credentials.yaml` / `.env`）、会话、存储 |

> 入口脚本以 root 启动，会自动把 `/home/dsh/.dsh`（递归）和 `/workspace`（顶层）的属主修正为容器内的 `dsh` 用户，再用 `gosu` 降权运行。因此**绑定挂载的宿主机目录即使属主是 root 也能正常写入**，无需手动 `chown`。

## 配置

### API Key

`dsh` 按以下顺序读取凭证：继承的环境变量 → `$DSH_HOME/.credentials.yaml` → 工作目录 `.env` → `$DSH_HOME/.env`。任选其一：

- 环境变量：`-e DEEPSEEK_API_KEY=sk-...`
- 文件：在 `./dsh-home/.env` 写入 `DEEPSEEK_API_KEY=sk-...`

### 端口

- 环境变量 `DSH_PORT`（默认 `3080`），或运行时追加 `--port <port>`。

### 失败重试次数

- 环境变量 `DSH_RETRY` 指定模型请求失败的重试次数，默认 `30`（不设置时为 30）。

### User-Agent

- 环境变量 `UA` 覆盖请求模型供应商时的 `User-Agent` 头；不设置时保持默认 `deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)`。

### 监听地址（0.0.0.0）

镜像默认通过 cordis patch 让 Web 服务监听 `0.0.0.0`，使 Docker 端口映射生效。

- 回到仅回环（安全）：设 `DSH_HOST=127.0.0.1`。
- 从其他机器 / 域名访问：dsh 的 `/api` 浏览器信任栅栏默认只放行 `localhost` / `127.x`；跨机器访问需追加 `--trusted-host <host>`，例如：

  ```bash
  docker run -p 3080:3080 ... 镜像 --trusted-host 192.168.1.10
  ```

  或在 compose 里：`command: ["--trusted-host", "192.168.1.10"]`。

> ⚠️ **安全**：`dsh` 本身没有鉴权层，监听 `0.0.0.0` 等于把能执行代码的 agent 暴露到网络。公网部署请务必在前面加反向代理 / VPN / 防火墙，或保持 `DSH_HOST=127.0.0.1` 仅本机访问。

## 插件管理

插件装在 `$DSH_HOME/profiles/<name>/node_modules`（随挂载卷持久化）。容器内置 `pnpm`，可直接用 `dsh plugin` 管理：

```bash
# 给 web profile 装插件（npm 包或 git 地址）
docker exec -it dsh dsh plugin --profile web add <package-or-git-spec>

# 装完重启生效
docker restart dsh
```

也可以在 `./dsh-home/cordis.patch.yml` 写自定义 patch 层覆盖配置（优先级高于镜像内置 patch 之外的默认层）。

## 本地构建

```bash
docker build --build-arg DSH_VERSION=0.1.0-rc.6 -t dsh:test .
```

可用 build-arg：`NODE_VERSION`（默认 `22`）、`DSH_VERSION`（默认 `latest`）。

## 许可

MIT
