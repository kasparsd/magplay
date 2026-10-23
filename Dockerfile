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
# What remains is the current platform's prebuild, stripped, and the one build variant Node loads:
# published packages also ship other platforms, browser bundles, TypeScript sources and tests.
RUN npm ci --omit=dev \
 && apk add --no-cache binutils \
 && platform="$(node -p 'process.platform + "-" + process.arch')" \
 && find node_modules -type d -path '*/prebuilds/*' -prune ! -name "$platform" -exec rm -rf {} + \
 && find node_modules -name '*.node' -exec strip --strip-unneeded {} + \
 && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
      -o -name '*.ts' -o -name '*.mts' -o -name '*.md' -o -name '*.bare' -o -name '*.tsbuildinfo' \
      -o -name '*.c' -o -name '*.cc' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' -o -name '*.gyp' \) -delete \
 && find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name benchmarks -o -name examples -o -name docs \) -prune -exec rm -rf {} + \
 && rm -rf node_modules/mediabunny/dist/bundles node_modules/mediabunny/src \
      node_modules/@mediabunny/*/dist/modules node_modules/@mediabunny/*/src \
 && find node_modules/@mediabunny \( -path '*/dist/bundles/*.min.mjs' -o -path '*/dist/bundles/*' -name '*.js' \) -delete \
 && rm -rf node_modules/webtorrent/dist node_modules/xml2js/lib/xml2js.bc.js node_modules/node-datachannel/src \
      node_modules/@opentelemetry/api/build/esm node_modules/@opentelemetry/api/build/esnext

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

# magplay-core (`--target core`): the server without ffmpeg. Files stream as they are, the browser repackages what
# it can, and nothing is re-encoded. For small hosts such as RouterOS containers and single-board computers.
# Alpine's nodejs is Node 24 without the npm, yarn and headers that node:24-alpine adds. 3.24 is the Alpine
# release that image is built on.
FROM alpine:3.24 AS core
RUN apk add --no-cache nodejs \
 && addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node
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

# magplay (the default target): core plus Alpine's ffmpeg, which brings libx264, the AAC/AC3 codecs and the
# VAAPI/Quick Sync hooks used for server-side remux, transcode and subtitle extraction.
FROM core AS full
USER root
RUN apk add --no-cache ffmpeg
USER node
