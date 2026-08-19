# deepseek-harness 镜像

基于 npm 发行版 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) 打包的 DeepSeek Harness Docker 镜像，默认监听 `0.0.0.0`，配合 Docker 端口映射开箱即用。镜像由 GitHub Actions 定时检查 `dsh` 最新版本并自动构建推送到腾讯云 CCR。

镜像：`sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness`（`:latest` / `:<版本>`）　上游：<https://github.com/deepseek-ai/deepseek-harness>

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

### 需要配置的环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填，也可写进 `./dsh-home/.env`） | 无 |
| `DSH_PORT` | 监听端口 | `3080` |
| `DSH_DEFAULT_DIRECTORY` | 默认工作目录 | `/workspace`（容器当前目录） |
| `DSH_RETRY` | 请求失败重试次数 | `30` |
| `UA` | 覆盖请求模型供应商的 User-Agent | `deepseek-harness/<版本> (+url)` |
| `DSH_HOST` | `0.0.0.0` 或 `127.0.0.1`（仅本机） | `0.0.0.0` |
| `DSH_TRUSTED_HOSTS` | 信任的访问地址（空格/逗号分隔）：局域网 IP、域名、反向代理地址。`/api` 与插件路由（`/sidebar/*`）都会放行 | 无（容器自身的局域网 IP 自动受信） |
| `DSH_DISABLE_TRUST_FENCE` | 设为 `1` 彻底关闭信任栅栏，**同时作用于 `/api` 和已安装插件的路由（如 `/sidebar/*`）**；无鉴权，仅在你自己的反代 / 鉴权后使用 | 无 |

### 任意模型 / 任意供应商都可设置思考等级（推理等级）

镜像内置了对 dsh 的思考等级（模型选择器里的「推理等级」）增强：任何模型都会暴露思考等级选项，不再要求模型供应商声明推理能力。

- **手写声明（自定义 OpenAI 兼容网关等）或目录中未声明推理能力的模型**：显示通用等级梯子 `Off / Medium / High / Max`，选择后按原样发送给供应商（如 `reasoning_effort` 等 wire 参数）；不选择时保持发送行为不变（跟随供应商默认）。
- **目录中已声明推理能力的模型**（如 DeepSeek 官方、OpenAI 等）：仍只显示其真实支持的等级，行为不变。
- **已明确标注不支持推理的目录模型**：不显示思考等级选项（避免把不支持的参数发给模型）。

该增强通过 `patch-dsh.cjs` 在构建时注入 dsh 的 LLM 核心与 pi-ai 适配器，无需额外配置。

### 远程访问报 403？

DSH 有一个浏览器信任栅栏（防 DNS rebinding / 跨站）：凡是 `Host` 头既不是回环地址（`127.0.0.1`/`localhost`），也不是容器自身局域网 IP，又不在 `DSH_TRUSTED_HOSTS` 里，`/api` 一律返回 **403**。通过 Docker 端口映射从**宿主机局域网 IP 或域名**打开页面时最容易踩到（容器的 IP 跟你电脑的 IP 不是同一个）。

已安装的第三方插件（如 `dsh-better-sidebar`）在自己的 `/sidebar/*` 路由上实现了同一套栅栏。镜像默认情况下容器自身的局域网 IP 已自动受信，所以：

- **本机访问**（`http://localhost:3080`）不受影响；
- **同局域网其它设备用 `http://<宿主机IP>:3080` 访问**、或**通过域名/反代访问**时：
  - 方式一（推荐，保留栅栏）：把访问地址加进 `DSH_TRUSTED_HOSTS`，例如 `DSH_TRUSTED_HOSTS: "192.168.1.10 dsh.example.com"`；
  - 方式二（完全放开，无鉴权）：设 `DSH_DISABLE_TRUST_FENCE=1`。镜像启动时会自动把该开关同步到已安装插件的内置栅栏（见 `patch-plugin-fence.cjs`），因此 `/api` 和插件的 `/sidebar/*` 路由都会放行，不会只修好一半、插件仍报 403。
