FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates && rm -rf /var/lib/apt/lists/* && python3 -m pip --version >/dev/null 2>&1 || true
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 curl ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY .env.example ./.env.example
RUN mkdir -p storage/downloads storage/jobs storage/tmp
EXPOSE 8080
CMD ["node","src/server.js"]
