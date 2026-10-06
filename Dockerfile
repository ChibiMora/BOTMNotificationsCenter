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
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/src/api.js"]
