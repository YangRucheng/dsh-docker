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
      - ./dsh-home:/home/dsh/.dsh   # 插件 / 配置 / 凭证 / 存储
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
  -v "$PWD/dsh-home:/home/dsh/.dsh" \
  sgccr.ccs.tencentyun.com/misaka-network/deepseek-harness:latest
```

### 需要配置的环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（必填，也可写进 `./dsh-home/.env`） | 无 |
| `DSH_PORT` | 监听端口 | `3080` |
| `DSH_RETRY` | 请求失败重试次数 | `30` |
| `UA` | 覆盖请求模型供应商的 User-Agent | `deepseek-harness/<版本> (+url)` |
| `DSH_HOST` | `0.0.0.0` 或 `127.0.0.1`（仅本机） | `0.0.0.0` |
| `DSH_TRUSTED_HOSTS` | 信任的访问域名（空格/逗号分隔），供反向代理 / 域名访问 | 无 |

### 跨机器 / 域名访问

dsh 的 `/api` 信任栅栏默认只放行 `localhost` / `127.x`。通过域名或反向代理访问时，需把访问域名加入信任，否则 `/api` 会返回 403：

```yaml
environment:
  DSH_TRUSTED_HOSTS: "dsh.example.com"
```

多个用空格或逗号分隔；也可追加 `--trusted-host <host>`（或 `command: ["--trusted-host", "host"]`）。

> ⚠️ 监听 `0.0.0.0` 会把能执行代码的 agent 暴露到网络，且 dsh 无鉴权层。公网部署请加反向代理 / VPN，或设 `DSH_HOST=127.0.0.1` 仅本机访问。

### 插件

插件随挂载卷持久化，用内置 `pnpm` 管理：

```bash
docker exec -it dsh dsh plugin --profile web add <包名或 git 地址>
docker restart dsh
```
