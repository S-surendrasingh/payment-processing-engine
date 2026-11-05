FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.check.json vitest.config.ts ./
RUN DATABASE_URL=postgresql://unused:unused@localhost/unused npx prisma generate
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# Include CLI tooling so the same image supports explicit migrate/seed jobs.
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
