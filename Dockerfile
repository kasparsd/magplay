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

# Full install (dev dependencies: esbuild) to build the browser client into dist/client.
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=manifests /app ./
RUN npm ci
# esbuild reads each package's tsconfig.json, which extends this one.
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build

# ffmpeg for the `full` image, built to do only what magplay asks of it (packages/playback/src/media.ts): copy or
# re-encode one video and one audio track into fragmented MP4, convert text subtitles to WebVTT, and run the
# one-frame encoder probes. Alpine's package is 107 MB because it links every codec, filter and device;
# this one is a single binary plus x264, dav1d and libva. Every component below is named, so a codec added to the
# players needs a line here. `tools/scripts/check-ffmpeg.mjs` runs the app's own arguments against the result.
# Not built in: NVENC (it never ran on musl), Vulkan, v4l2, ffprobe, ffplay, TLS and every encoder but x264, AAC
# and the hardware H.264 ones. Quick Sync (libvpl) is x86_64 only, as in Alpine's package.
FROM alpine:3.24 AS ffmpeg
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
RUN apk add --no-cache build-base nasm pkgconf curl xz zlib-dev x264-dev dav1d-dev libva-dev \
 && if [ "$(apk --print-arch)" = x86_64 ]; then apk add --no-cache libvpl-dev; fi
WORKDIR /src
# ffmpeg.org first; Alpine's distfiles mirror serves the same tarball (its APKBUILD pins the same release).
RUN curl -fsSL --retry 3 -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
 || curl -fsSL --retry 3 -o ffmpeg.tar.xz "https://distfiles.alpinelinux.org/distfiles/v3.24/ffmpeg-$FFMPEG_VERSION.tar.xz"; \
 echo "$FFMPEG_SHA256  ffmpeg.tar.xz" | sha256sum -c - \
 && tar -xJf ffmpeg.tar.xz --strip-components=1 && rm ffmpeg.tar.xz
RUN qsv=""; [ "$(apk --print-arch)" = x86_64 ] && qsv=1; \
 ./configure \
  --prefix=/opt/ffmpeg --enable-gpl --enable-small --enable-pic --enable-runtime-cpudetect \
  --disable-everything --disable-autodetect --disable-debug --disable-doc \
  --disable-ffplay --disable-ffprobe --disable-shared --enable-static \
  --enable-zlib --enable-libx264 --enable-libdav1d --enable-vaapi ${qsv:+--enable-libvpl} \
  --enable-avdevice --enable-indev=lavfi \
  --enable-protocol=file,pipe,http,tcp \
  --enable-demuxer=matroska,mov,avi,mpegts,mpegps,flv,asf,ogg,mp3,flac,wav,aac,ac3,eac3,dts,dtshd,truehd,mlp,h264,hevc,m4v,mpegvideo,vc1,ivf,mxf,nut,srt,ass,webvtt,subviewer,subviewer1,microdvd,sami,mpl2,vplayer,realtext,stl,jacosub,pjs,aqtitle \
  --enable-parsers --enable-bsfs \
  --enable-decoder=h264,hevc,mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,vc1,wmv1,wmv2,wmv3,vp8,vp9,libdav1d,mjpeg,theora,h263,h263p,flv \
  --enable-decoder=aac,aac_latm,ac3,eac3,dca,truehd,mlp,flac,vorbis,opus,mp1float,mp2float,mp3float,alac,wmav1,wmav2,wmapro,wmalossless,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_u8,pcm_dvd,pcm_bluray,pcm_alaw,pcm_mulaw,adpcm_ms,adpcm_ima_wav \
  --enable-decoder=subrip,srt,ass,ssa,movtext,webvtt,text,subviewer,subviewer1,microdvd,sami,realtext,stl,jacosub,pjs,aqtitle,mpl2,vplayer \
  --enable-encoder=libx264,aac,h264_vaapi,webvtt ${qsv:+--enable-encoder=h264_qsv} \
  --enable-muxer=mp4,webvtt,null \
  --enable-filter=buffer,buffersink,abuffer,abuffersink,nullsrc,null,anull,scale,format,aformat,aresample,fifo,afifo,hwupload,hwdownload,scale_vaapi ${qsv:+--enable-filter=vpp_qsv} \
 && make -j"$(nproc)" install \
 && strip --strip-unneeded /opt/ffmpeg/bin/ffmpeg
RUN /opt/ffmpeg/bin/ffmpeg -hide_banner -version | head -1 \
 && ldd /opt/ffmpeg/bin/ffmpeg \
 && ls -l /opt/ffmpeg/bin/ffmpeg

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
COPY apps/client/*.html ./apps/client/

RUN mkdir -p /data && chown node:node /data
USER node
ENV CACHE_DIR=/data
# Node 24 keeps a 259 MiB heap ceiling in any container of 512 MiB or less, so it would allocate past a small limit
# instead of collecting. 128 MiB is enough for the server; set NODE_OPTIONS to override.
ENV NODE_OPTIONS=--max-old-space-size=128
EXPOSE 8080 6881/tcp 6881/udp
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/main.ts"]

# magplay (the default target): core plus the ffmpeg built above, with the libraries it links (x264, dav1d, libva
# and, on x86_64, Quick Sync's libvpl). No VAAPI driver or oneVPL GPU runtime is included; see the README.
FROM core AS full
USER root
RUN apk add --no-cache x264-libs libdav1d libva \
 && if [ "$(apk --print-arch)" = x86_64 ]; then apk add --no-cache libvpl; fi
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
USER node
