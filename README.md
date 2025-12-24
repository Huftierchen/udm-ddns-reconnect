# udm-ddns-reconnect

A tiny Dockerized Node.js service that:

- checks your external IP every **5 minutes** (configurable)
- updates your **ddnss.de** record **only when the IP changes**
- triggers a nightly **UniFi Dream Machine Pro** reconnect via SSH (cron-based)

## Features

- ✅ No DDNS spam: updates only on IP change (state persisted to `/data/state.json`)
- ✅ Nightly reconnect via SSH command (default: `killall -HUP pppd`)
- ✅ Runs well on **Raspberry Pi 5 (arm64)** and x86_64 (multi-arch images via GitHub Actions)
- ✅ Timezone-aware cron (default: `Europe/Berlin`)

---

## Configuration

All configuration is done via environment variables.

### Required (DDNS)

| Variable | Description |
|---|---|
| `DDNS_USER` | ddnss.de username |
| `DDNS_PASSWORD` | ddnss.de password |
| `DDNS_HOST` | hostname to update (e.g. `myhost.ddnss.de`) |

### Optional (DDNS)

| Variable | Default | Description |
|---|---:|---|
| `DDNS_UPDATE_URL` | `https://www.ddnss.de/upd.php` | Update endpoint (for IPv4/IPv6 prefer `https://ip4.ddnss.de/upd.php` / `https://ip6.ddnss.de/upd.php`) |
| `CHECK_INTERVAL_MINUTES` | `5` | IP check interval |
| `IP_SERVICE_URL` | `https://api.ipify.org` | External IP service URL |
| `DATA_DIR` | `/data` | Persistent data directory |

### Optional (Nightly reconnect)

| Variable | Default | Description |
|---|---:|---|
| `RECONNECT_ENABLED` | `true` | Enable/disable reconnect |
| `RECONNECT_CRON` | `0 5 * * *` | Cron schedule (minute hour day month weekday) |
| `TZ` | `Europe/Berlin` | Timezone for cron scheduling |
| `SSH_HOST` |  | UDM host/IP |
| `SSH_PORT` | `22` | SSH port |
| `SSH_USER` |  | SSH username (often `root`) |
| `SSH_PASSWORD` |  | SSH password |
| `SSH_COMMAND` | `/usr/bin/killall -HUP pppd` | Command executed on the UDM |

> **Important:** If your passwords contain special characters (e.g. `#`, `!`, `:`), quote them in YAML or use a `.env` file.

---

## Run with Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  udm-ddns-reconnect:
    image: ghcr.io/<YOUR_GITHUB_USER>/<YOUR_REPO>:latest
    container_name: udm-ddns-reconnect
    restart: unless-stopped
    environment:
      TZ: "Europe/Berlin"

      # DDNS
      DDNS_USER: "YOUR_DDNS_USER"
      DDNS_PASSWORD: "YOUR_DDNS_PASSWORD"
      DDNS_HOST: "yourhost.ddnss.de"
      DDNS_UPDATE_URL: "https://ip4.ddnss.de/upd.php"
      CHECK_INTERVAL_MINUTES: "5"
      IP_SERVICE_URL: "https://api.ipify.org"

      # Reconnect
      RECONNECT_ENABLED: "true"
      RECONNECT_CRON: "32 1 * * *"   # daily 01:32
      SSH_HOST: "192.168.1.1"
      SSH_PORT: "22"
      SSH_USER: "root"
      SSH_PASSWORD: "YOUR_SSH_PASSWORD"
      SSH_COMMAND: "/usr/bin/killall -HUP pppd"
    volumes:
      - udm_ddns_state:/data

volumes:
  udm_ddns_state:
````

Start:

```bash
docker compose up -d
docker logs -f udm-ddns-reconnect
```

---

## Build locally (optional)

```bash
docker build -t udm-ddns-reconnect:local .
docker run --rm -it \
  -e DDNS_USER=... -e DDNS_PASSWORD=... -e DDNS_HOST=... \
  -e SSH_HOST=... -e SSH_USER=... -e SSH_PASSWORD=... \
  -v udm_ddns_state:/data \
  udm-ddns-reconnect:local
```


## GitHub Actions (multi-arch image to GHCR)

This repo can build and publish a multi-arch image (`linux/arm64`, `linux/amd64`) to GitHub Container Registry using GitHub Actions.

Add a workflow at `.github/workflows/docker.yml` (example):

```yaml
name: build-and-push

on:
  push:
    branches: [ "main" ]
  workflow_dispatch:

permissions:
  contents: read
  packages: write

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          platforms: linux/arm64,linux/amd64
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
```

After the first successful run, you can pull:

```bash
docker pull ghcr.io/<YOUR_GITHUB_USER>/<YOUR_REPO>:latest
```

## Notes / Troubleshooting

### ddnss says “parameters missing”

Usually means one of `DDNS_USER`, `DDNS_PASSWORD`, `DDNS_HOST` is empty or got cut off by YAML parsing.
Use quotes, or `.env`.

### SSH: “All configured authentication methods failed”

* verify username/password are correct
* ensure password is not being truncated by YAML (`#` needs quotes!)
* UDM may use keyboard-interactive auth; the app supports it when `tryKeyboard` is enabled.