# 避难所联机服务端镜像。构建上下文是 shelter/，由仓库根目录的 docker-compose.yml 调用。
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/shelter.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
# 服务端用共享核心生成与校验面板存档
COPY src/shared/core.js ./src/shared/core.js
COPY index.html host.html player.html ./
# 数据库目录交给 node 用户；命名卷第一次挂载时会沿用这个属主
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
