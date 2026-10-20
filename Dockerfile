FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATABASE_PATH=/data/missioncontrol.db TRUST_PROXY=1
# Mount a persistent volume at /data or the SQLite file is lost on redeploy.
VOLUME /data
EXPOSE 3000
USER node
RUN mkdir -p /data && chown node:node /data
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
