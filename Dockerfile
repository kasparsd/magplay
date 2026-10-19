# Only the workspace manifests, so the install layers are cached until a package.json changes.
FROM node:24-alpine AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN find apps packages -type f ! -name package.json -delete

FROM node:24-alpine AS deps
WORKDIR /app
COPY --from=manifests /app ./
# Install scripts fetch prebuilt native modules (node-datachannel, which WebTorrent loads at startup).
# hls.js is bundled into the client at build time, so the runtime never serves it from node_modules.
# Nothing reads source maps or type definitions at runtime.
RUN npm ci --omit=dev \
 && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.md' \) -delete

# Full install (dev dependencies: esbuild) to bundle the browser client.
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=manifests /app ./
RUN npm ci
# esbuild reads each package's tsconfig.json, which extends this one.
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY public ./public
RUN npm run build

# The server without ffmpeg (`--target lite`): files stream as they are, the browser repackages what it can, and
# nothing is re-encoded. For small hosts such as RouterOS containers and single-board computers.
FROM node:24-alpine AS lite
WORKDIR /app
# node_modules/@magplay/* are relative symlinks into packages/ and apps/server.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
ENV CACHE_DIR=/data
EXPOSE 8080 6881/tcp 6881/udp
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]

# The default image: the same server with ffmpeg for server-side remux, transcode and subtitle extraction.
FROM lite AS full
USER root
RUN apk add --no-cache ffmpeg
USER node
