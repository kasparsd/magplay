FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts fetch prebuilt native modules (node-datachannel, which WebTorrent loads at startup).
# The server only serves hls.min.js from hls.js, and nothing reads source maps or type definitions.
RUN npm ci --omit=dev \
 && find node_modules/hls.js/dist -type f ! -name hls.min.js -delete \
 && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.md' \) -delete

FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
ENV CACHE_DIR=/data
EXPOSE 8080 6881/tcp 6881/udp
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
