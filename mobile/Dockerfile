FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY stub ./stub
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build --prefix mobile

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY mobile/runtime/package.json mobile/runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/mobile/dist ./mobile/dist
COPY mobile/server ./mobile/server
COPY mobile/shared ./mobile/shared
COPY mobile/model-map.json ./mobile/model-map.json
COPY LICENSE mobile/NOTICE ./
COPY src/lib/server/endpoints/openai/openAIChatToTextGenerationStream.ts ./src/lib/server/endpoints/openai/openAIChatToTextGenerationStream.ts
WORKDIR /app/mobile
RUN mkdir -p data backups && chown node:node data backups
USER node
EXPOSE 3001
CMD ["node", "server/index.mjs"]
