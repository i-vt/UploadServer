#!/usr/bin/env bash
#
# fileshare setup — installs and starts the service.
#
#   sudo ./setup.sh                  # bare-metal: Node.js + systemd (default)
#   sudo ./setup.sh --docker         # container: Docker image + volume
#   sudo ./setup.sh --port 8080      # custom port (works with either mode)
#
# Must be run as root.

set -euo pipefail

usage() {
  echo "Usage: sudo $0 [--docker] [--port PORT]" >&2
  echo "  --docker      Build and run fileshare as a Docker container" >&2
  echo "  --port PORT   Port the service listens on (default: 3000)" >&2
}

MODE="systemd"
PORT=3000
while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker)
      MODE="docker"
      shift
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "ERROR: --port requires a value" >&2; usage; exit 1; }
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#--port=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || [[ "${PORT}" -lt 1 ]] || [[ "${PORT}" -gt 65535 ]]; then
  echo "ERROR: invalid port '${PORT}' (must be an integer between 1 and 65535)" >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: this setup must be run as root (try: sudo $0)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Docker mode
# ---------------------------------------------------------------------------
if [[ "${MODE}" == "docker" ]]; then
  echo "==> Checking for docker..."
  if ! command -v docker >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      echo "==> Installing docker.io via apt-get..."
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
      systemctl enable --now docker || true
    else
      echo "ERROR: docker not found and apt-get is unavailable." >&2
      echo "Install Docker manually (https://docs.docker.com/engine/install/), then re-run." >&2
      exit 1
    fi
  fi

  echo "==> Building image 'fileshare' from ${SCRIPT_DIR}..."
  docker build -t fileshare "${SCRIPT_DIR}"

  echo "==> (Re)creating container 'fileshare' on port ${PORT}..."
  docker rm -f fileshare >/dev/null 2>&1 || true
  docker run -d \
    --name fileshare \
    --restart unless-stopped \
    -p "${PORT}:3000" \
    -v fileshare-data:/data \
    fileshare

  echo
  echo "==> Done. fileshare is listening on port ${PORT}."
  echo "==> Keys (upload + admin) are in the container logs:"
  echo "      docker logs fileshare"
  echo "==> Files and metadata persist in the 'fileshare-data' volume."
  echo "==> Tip: to keep stable keys across restarts, pass them explicitly:"
  echo "      docker run -d --name fileshare -p ${PORT}:3000 -v fileshare-data:/data \\"
  echo "        -e ADMIN_KEY=\$(openssl rand -hex 32) -e UPLOAD_KEY=\$(openssl rand -hex 32) \\"
  echo "        --restart unless-stopped fileshare"
  exit 0
fi

# ---------------------------------------------------------------------------
# systemd mode (bare metal)
# ---------------------------------------------------------------------------
echo "==> Checking for nodejs and npm..."
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "==> Installing nodejs and npm via apt-get..."
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
  else
    echo "ERROR: nodejs/npm not found and apt-get is unavailable." >&2
    echo "Please install Node.js >= 18 manually, then re-run this setup." >&2
    exit 1
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "ERROR: Node.js >= 18 is required (found $(node --version))." >&2
  exit 1
fi

echo "==> Installing dependencies in ${SCRIPT_DIR}..."
cd "${SCRIPT_DIR}"
npm install --omit=dev

echo "==> Ensuring config.json exists..."
if [[ ! -f "${SCRIPT_DIR}/config.json" ]]; then
  cat > "${SCRIPT_DIR}/config.json" <<'EOF'
{
  "port": 3000,
  "maxFileSizeGB": 50,
  "sweepIntervalSeconds": 30,
  "uploads": {
    "deleteOnReboot": true,
    "ttlMinutes": 0,
    "maxDownloads": 0
  }
}
EOF
  echo "    wrote default config.json"
else
  echo "    keeping existing config.json"
fi

echo "==> Writing systemd unit /etc/systemd/system/fileshare.service..."
cat > /etc/systemd/system/fileshare.service <<EOF
[Unit]
Description=fileshare - large-file upload & share service
After=network.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3
User=root
Environment=PORT=${PORT}

[Install]
WantedBy=multi-user.target
EOF

echo "==> Enabling and starting fileshare.service..."
systemctl daemon-reload
systemctl enable --now fileshare

echo
systemctl --no-pager --full status fileshare || true
echo
echo "==> Done. fileshare is listening on port ${PORT}."
echo "==> The upload and admin keys are printed in the service logs"
echo "    (journalctl -u fileshare) and stored in: /tmp/FileUploadKeys.txt"
echo "    Read them with:  cat /tmp/FileUploadKeys.txt"
