# 司衡 · 运行镜像
#
# 三条设计取舍，写在前面省得后来人猜：
#
# 1. **零依赖直跑 TS**。运行时不需要 npm install，也不需要 tsc 编译 ——
#    Node 22 的 type stripping 直接执行 .ts。镜像里没有 node_modules（除了前端构建产物），
#    扫描出来的漏洞面就只有 Node 自己。
# 2. **两阶段**。前端要 vite 才能出 dist，构建工具不该进运行镜像。
# 3. **非 root + 只读根**。进程以 siheng 用户跑；只读根靠 `docker run --read-only` 打开，
#    Dockerfile 里的注释和 docker-compose.yml 都写了怎么开。不写死的理由：
#    read-only 是运行期参数，镜像自己声明不了。
#
# 构建：docker build -t siheng:latest .
# 运行：docker run --rm -p 18150:18150 --read-only --tmpfs /tmp -v siheng-data:/app/data siheng:latest

FROM node:22-alpine AS build

WORKDIR /app

# 先只拷清单：源码改动不该让 npm ci 的层缓存失效。
COPY web/package.json web/package-lock.json ./web/

RUN npm --prefix web ci --no-audit --no-fund

COPY . .

# 构建前端并内联成单文件（scripts/inline-app.mjs 会把 js/css 塞进 index.html）。
RUN npm run build:app

# ───────────────────────────── 运行镜像 ─────────────────────────────

FROM node:22-alpine

# dumb-init 之类不装：这个进程自己处理 SIGTERM（见 track-pi/src/lifecycle.ts），
# 用 node 直接当 PID 1 反而让信号路径更短。代价是必须自己回收僵尸子进程 ——
# 本项目只 spawn MCP 子进程，由 McpClient 负责关闭。
WORKDIR /app

ENV NODE_ENV=production \
    PORT=18150 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    LOG_FORMAT=json \
    SHUTDOWN_TIMEOUT_MS=10000

# 一次性建好用户与数据目录：运行期根文件系统是只读的，那时再建就晚了。
RUN addgroup -S -g 10001 siheng \
 && adduser -S -u 10001 -G siheng siheng \
 && mkdir -p /app/data \
 && chown -R siheng:siheng /app/data

# 只拷运行需要的东西。刻意不拷 scripts/、docs/、.git —— 镜像里不该有构建期和文档期的东西。
COPY --from=build --chown=siheng:siheng /app/package.json ./package.json
COPY --from=build --chown=siheng:siheng /app/track-pi ./track-pi
COPY --from=build --chown=siheng:siheng /app/shared ./shared
COPY --from=build --chown=siheng:siheng /app/mcp ./mcp
COPY --from=build --chown=siheng:siheng /app/web/dist ./web/dist

USER siheng

EXPOSE 18150

VOLUME ["/app/data"]

# 探针用 /live 而不是 /ready：健康检查失败会触发重启，而「状态读不出来」重启也修不好，
# 那种情况该做的是摘流量（/ready 交给编排层的就绪探针）。
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18150)+'/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "track-pi/src/index.ts"]
