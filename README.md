# Cobalt Premium API v3.3

A dependency-free Node.js HTTP API for inspecting and downloading media through yt-dlp and FFmpeg.

## Termux

```bash
pkg update
pkg install nodejs ffmpeg
cd ~/try
cp .env.example .env
npm test
npm run doctor
npm start
```

Open `http://127.0.0.1:8080`.

## API

- `GET /health`
- `GET /docs`
- `GET /v1/formats`
- `POST /v1/info`
- `POST /v1/inspect`
- `POST /v1/download`
- `GET /v1/jobs/:id`
- `GET /v1/jobs/:id/events`
- `GET /v1/jobs/:id/file`
- `DELETE /v1/jobs/:id`

Use only public content you are authorized to download. This project does not bypass DRM, private access controls, or authentication barriers.
