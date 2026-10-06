# One image, two services (§11.1): api (default) and worker (`node dist/src/worker.js`).
# tsc compiles with rootDir ".", so entry points land in dist/src/ and compiled migrations in dist/migrations/.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json knexfile.ts vitest.workspace.ts ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
COPY test ./test
RUN npm run build && npm prune --omit=dev && rm -rf dist/test dist/vitest.workspace.* && find dist -name '*.map' -delete

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Application files stay root-owned (read-only to the runtime user `node`).
USER node
EXPOSE 3000
# Probes HEALTH_PORT when set; otherwise PORT (default 3000), then WORKER_HEALTH_PORT (default 3001), healthy if
# either answers 2xx. A container runs one process, so only that process's port answers on 127.0.0.1: the API and the
# worker are both healthy without extra settings, even when they share one env file.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const e=process.env,p=e.HEALTH_PORT?[e.HEALTH_PORT]:[e.PORT||3000,e.WORKER_HEALTH_PORT||3001],t=i=>i<p.length?fetch('http://127.0.0.1:'+p[i]+'/healthz').then(r=>r.ok?process.exit(0):t(i+1),()=>t(i+1)):process.exit(1);t(0)"
CMD ["node", "dist/src/api.js"]
