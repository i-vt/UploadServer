#!/usr/bin/env bash
#
# fileshare uninstaller — stops and removes the service.
#
#   sudo ./uninstall.sh                  # systemd install (default)
#   sudo ./uninstall.sh --docker         # Docker install
#   sudo ./uninstall.sh --purge          # also delete stored files & state
#   sudo ./uninstall.sh --docker --purge # also delete the data volume
#
# Must be run as root. config.json is always kept (delete it by hand if wanted).

set -euo pipefail

usage() {
  echo "Usage: sudo $0 [--docker] [--purge]" >&2
  echo "  --docker   Remove the Docker container and image" >&2
  echo "  --purge    Also delete stored files, metadata and keys" >&2
  echo "             (systemd mode: uploads/, files.json, keys.json;" >&2
  echo "              docker mode: the 'fileshare-data' volume)" >&2
}

MODE="systemd"
PURGE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker) MODE="docker"; shift ;;
    --purge)  PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: this uninstaller must be run as root (try: sudo $0)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Docker mode
# ---------------------------------------------------------------------------
if [[ "${MODE}" == "docker" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is not installed (or not on PATH)." >&2
    exit 1
  fi

  echo "==> Stopping and removing container 'fileshare'..."
  docker rm -f fileshare >/dev/null 2>&1 && echo "    container removed" || echo "    no such container (skipped)"

  echo "==> Removing image 'fileshare'..."
  docker rmi fileshare >/dev/null 2>&1 && echo "    image removed" || echo "    no such image (skipped)"

  if [[ "${PURGE}" -eq 1 ]]; then
    echo "==> Removing volume 'fileshare-data' (all uploaded files and state)..."
    docker volume rm fileshare-data >/dev/null 2>&1 && echo "    volume removed" || echo "    no such volume (skipped)"
  else
    echo "==> Keeping volume 'fileshare-data' (use --purge to delete it)."
  fi

  echo
  echo "==> Done. fileshare (Docker) has been uninstalled."
  exit 0
fi

# ---------------------------------------------------------------------------
# systemd mode
# ---------------------------------------------------------------------------
if ! command -v systemctl >/dev/null 2>&1; then
  echo "ERROR: systemctl not found — this does not look like a systemd host." >&2
  echo "If you deployed with Docker, run: sudo $0 --docker" >&2
  exit 1
fi

echo "==> Stopping and disabling fileshare.service..."
systemctl stop fileshare 2>/dev/null && echo "    stopped" || echo "    not running (skipped)"
systemctl disable fileshare 2>/dev/null && echo "    disabled" || echo "    not enabled (skipped)"

echo "==> Removing /etc/systemd/system/fileshare.service..."
rm -f /etc/systemd/system/fileshare.service
systemctl daemon-reload

if [[ "${PURGE}" -eq 1 ]]; then
  echo "==> Deleting stored files and state in ${SCRIPT_DIR}..."
  rm -rf "${SCRIPT_DIR}/uploads" "${SCRIPT_DIR}/files.json" "${SCRIPT_DIR}/keys.json"
  echo "    removed uploads/, files.json, keys.json"
else
  echo "==> Keeping stored files and state in ${SCRIPT_DIR} (use --purge to delete them)."
fi

echo
echo "==> Done. fileshare has been uninstalled."
echo "    Kept: application files and config.json in ${SCRIPT_DIR} — delete the directory by hand if unwanted."
