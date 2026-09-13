# Mailflare self-hosted image: Next.js app, SMTP listener, job queues and
# backups in one Node process. Data lives in /data (mount a volume).
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 MAILFLARE_RUNTIME=node

# better-sqlite3 ships prebuilt binaries for this image; the toolchain is only
# a fallback for platforms without one.
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
RUN npm run build:node && rm -rf .next/cache

# Production dependencies only. The Workers toolchain arrives as transitive
# dependencies of the Cloudflare adapter and is never loaded here, so it goes.
FROM deps AS prod-deps
RUN npm prune --omit=dev --ignore-scripts \
	&& rm -rf node_modules/wrangler node_modules/miniflare node_modules/workerd node_modules/@cloudflare node_modules/cloudflare node_modules/@aws-sdk node_modules/esbuild node_modules/@esbuild node_modules/typescript

FROM base AS runtime
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 SMTP_INBOUND_PORT=25
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node --from=build /app/drizzle ./drizzle
COPY --chown=node:node --from=build /app/package.json /app/next.config.ts ./
COPY --chown=node:node --from=build /app/src/lib/security/headers.ts ./src/lib/security/headers.ts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000 25
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/setup/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
