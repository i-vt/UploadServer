#!/usr/bin/env bash
#
# fileshare installer — installs Node.js if needed, installs dependencies,
# and sets up a systemd service. Must be run as root.

set -euo pipefail

usage() {
  echo "Usage: sudo $0 [--port PORT]" >&2
  echo "  --port PORT   Port the service listens on (default: 3000)" >&2
}

PORT=3000
while [[ $# -gt 0 ]]; do
  case "$1" in
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
  echo "ERROR: this installer must be run as root (try: sudo $0)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Checking for nodejs and npm..."
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "==> Installing nodejs and npm via apt-get..."
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
  else
    echo "ERROR: nodejs/npm not found and apt-get is unavailable." >&2
    echo "Please install Node.js >= 18 manually, then re-run this installer." >&2
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
echo "==> The upload key is printed in the service logs (journalctl -u fileshare)"
echo "    and stored in: /tmp/FileUploadKeys.txt"
echo "    Read it with:  cat /tmp/FileUploadKeys.txt"
