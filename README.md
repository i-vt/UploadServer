# fileshare

Single Node.js service for sharing large files. Uploads are gated by keys —
a master key plus temporary limited-use keys generated from the admin
console; every uploaded file gets a UUID download link. Uploads stream to
disk (never buffered in memory), so files up to **50 GB** work from a
browser.

## Features

- **Master upload key** — 64-char random key generated at startup (or fixed
  via `UPLOAD_KEY`), unlimited uses.
- **Admin console** (`/admin`) — sign in with the admin key to see stats,
  reveal/copy the master key, generate temporary keys, and manage stored
  files.
- **Temporary keys** — generate keys good for **1, 2, … N uploads**. One use
  is consumed per *completed* upload; a key at 0 uses stops working
  automatically. Keys can also be revoked at any time. Temp keys persist
  across restarts (`keys.json`).
- **Per-upload retention** — each upload can be limited by:
  - **Delete on reboot** *(on by default)* — the file is wiped when the
    server restarts.
  - **Keep-for time (TTL)** — auto-delete after N minutes/hours/days.
  - **Max downloads** — auto-delete after N downloads. A download counts
    when the file's final byte is served, so a resumed/ranged download
    counts once.
- **Secure deletion** — every deletion (admin delete, TTL expiry, download
  limit, reboot wipe, aborted-upload cleanup) overwrites the bytes with
  random data, fsyncs, then unlinks.
- **Config file** — `config.json` for port, limits, sweeper interval, and
  the per-upload retention defaults.
- **Phone-friendly UI** — responsive layout, large touch targets, no
  auto-zoom on input focus, works one-handed.
- **Docker** — first-class image + compose file; setup script can deploy
  either way.

## Requirements

- Node.js >= 18, dependencies: `express`, `busboy` — **or** Docker.

## Quick start (bare metal)

```bash
npm install
node server.js        # or: npm start
```

On startup the server prints two keys to stdout and writes them to
`/tmp/FileUploadKeys.txt` (mode `0600`):

```
upload_key=<64 hex>   # master upload key
admin_key=<64 hex>    # admin console key
```

Open `http://<host>:3000/` in a browser — paste an upload key, drop a file,
and you get a share link `http://<host>:3000/download?id=<uuid>`.

## Quick start (Docker)

```bash
docker build -t fileshare .
docker run -d --name fileshare -p 3000:3000 -v fileshare-data:/data \
  --restart unless-stopped fileshare
docker logs fileshare     # <- the upload & admin keys are printed here
```

or with compose: `docker compose up -d --build`.

Uploaded files and metadata live in the `fileshare-data` volume (`/data` in
the container). Keys are regenerated on each container start unless you pin
them (`-e ADMIN_KEY=... -e UPLOAD_KEY=...`). To tweak settings without
rebuilding, mount your own config: `-v $PWD/config.json:/app/config.json:ro`.

## Install as a service (Debian/Ubuntu)

`setup.sh` handles both deployment modes (must run as root):

```bash
sudo ./setup.sh                # bare metal: Node.js + systemd, port 3000
sudo ./setup.sh --port 8080    # custom port
sudo ./setup.sh --docker       # Docker: builds the image, (re)creates the
                               # container 'fileshare' with a data volume
```

- systemd mode writes `/etc/systemd/system/fileshare.service`
  (`Restart=always`) and enables it. Logs: `journalctl -u fileshare -f`.
- Docker mode installs `docker.io` via apt if needed, builds the image, and
  runs the container with `--restart unless-stopped`. Logs:
  `docker logs fileshare`.
- Both modes create a default `config.json` if missing (an existing one is
  never overwritten).

`installer.sh` still works — it just forwards to `setup.sh`.

## Uninstall

```bash
sudo ./uninstall.sh                  # systemd: stop, disable, remove the unit
sudo ./uninstall.sh --purge          # + delete uploads/, files.json, keys.json
sudo ./uninstall.sh --docker         # docker: remove container and image
sudo ./uninstall.sh --docker --purge # + delete the fileshare-data volume
```

The purge options destroy all stored files and state. `config.json` and the
application files are always kept — delete the directory by hand if unwanted.

## Configuration

Settings resolve in this order: **environment variable** > `config.json` >
built-in default. `config.json` sits next to `server.js` (override the path
with `CONFIG_FILE`):

```json
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
```

| config.json key | Env override | Default | Description |
|---|---|---|---|
| `port` | `PORT` | `3000` | Listen port |
| `maxFileSizeGB` | `MAX_FILE_SIZE_GB` | `50` | Upload size limit |
| `sweepIntervalSeconds` | `SWEEP_INTERVAL_SECONDS` | `30` | How often expired files are deleted (min 2) |
| `uploads.deleteOnReboot` | `DELETE_ON_REBOOT` | `true` | Default: wipe files on server restart |
| `uploads.ttlMinutes` | `UPLOAD_TTL_MINUTES` | `0` | Default keep-for minutes; `0` = forever |
| `uploads.maxDownloads` | `UPLOAD_MAX_DOWNLOADS` | `0` | Default download limit; `0` = unlimited |
| `uploadDir` | `UPLOAD_DIR` | `<repo>/uploads` (`/data/uploads` in Docker) | Stored files (named by UUID) |
| `dataFile` | `DATA_FILE` | `<repo>/files.json` (`/data/files.json`) | File metadata store |
| `keysFile` | `KEYS_FILE` | `<repo>/keys.json` (`/data/keys.json`) | Temp key store |

Key-related env vars (not in config.json): `UPLOAD_KEY` / `ADMIN_KEY` pin the
two keys instead of generating random ones; `KEY_FILE` sets where keys are
written (default `/tmp/FileUploadKeys.txt`, empty to disable; disabled in
the Docker image — use `docker logs`).

The `uploads.*` values are only **defaults** — every upload can override
them individually (web UI options, multipart fields, or query params).

## Per-upload retention

On the upload page each option is set under **Retention**. With curl, send
them as multipart fields (or query params):

```bash
KEY=$(grep '^upload_key=' /tmp/FileUploadKeys.txt | cut -d= -f2)

# keep 1 day, survive reboots, vanish after 3 downloads
curl -H "x-upload-key: $KEY" \
  -F "deleteOnReboot=0" -F "ttlMinutes=1440" -F "maxDownloads=3" \
  -F "file=@bigfile.bin" \
  http://localhost:3000/api/upload

# same via query params
curl -H "x-upload-key: $KEY" -F "file=@bigfile.bin" \
  "http://localhost:3000/api/upload?deleteOnReboot=0&ttlMinutes=1440&maxDownloads=3"
```

| Field / param | Values | Meaning |
|---|---|---|
| `deleteOnReboot` | `1`/`0`, `true`/`false` | Wipe the file when the server restarts (default from config: on) |
| `ttlMinutes` | `0`–`525600` | Minutes to keep the file; `0` = forever |
| `maxDownloads` | `0`–`1000000` | Delete after N downloads; `0` = unlimited |

The download page shows the expiry date and remaining downloads when set.
Deleted files are **securely overwritten** with random data before unlink.

## Admin console

Open `/admin` and paste the admin key (kept in `sessionStorage`, so closing
the tab signs you out). From there you can:

- view file count / total size / active temp keys;
- reveal or copy the master upload key;
- generate a temporary key with a chosen number of uses (quick chips for
  1 / 2 / 5 / 10, or any N);
- copy or revoke existing temp keys (shows remaining uses, created/last-used
  times);
- see per-file retention info (expiry, downloads used, reboot flag), copy
  share links, or delete files (secure wipe).

## API

| Route | Auth | Description |
|---|---|---|
| `GET /` | — | 302 redirect to `/upload` |
| `GET /upload` · `/download` · `/admin` | — | Pages |
| `GET /api/upload-defaults` | — | Server-side retention defaults + size limit |
| `POST /api/upload` | upload key | Multipart upload (one file) + retention fields. Key via `x-upload-key` header or `?key=`. Wrong/exhausted key → `403`. Over limit → `413`. |
| `GET /api/file/:id` | — | JSON metadata incl. `expiresAt`, `maxDownloads`, `downloads`, `deleteOnReboot`; 404 if unknown |
| `GET /api/download/:id` | — | Streams the file, supports `Range` |
| `GET /api/admin/overview` | admin | Counts, total size, master upload key, retention defaults |
| `GET /api/admin/keys` | admin | List temp keys (`usesLeft`, `createdAt`, `lastUsedAt`) |
| `POST /api/admin/keys` | admin | Create temp key: `{"uses": N}` → `{ key, usesLeft }` |
| `DELETE /api/admin/keys/:key` | admin | Revoke a temp key |
| `GET /api/admin/files` | admin | List stored files (with retention info) |
| `DELETE /api/admin/files/:id` | admin | Securely delete a file (overwrite + unlink) |

Admin routes take the key via `x-admin-key` header (or `?admin_key=`).
All key comparisons are constant-time.

## Reverse proxy note

If you put nginx/Apache/Cloudflare in front of fileshare, make sure large
uploads and long-lived connections are allowed:

- nginx: set `client_max_body_size 50g;` (or `0` to disable) and disable
  request/response buffering timeouts (`proxy_request_buffering off;`,
  large `proxy_read_timeout`) for the upload location.
- Apache: raise `LimitRequestBody` and `Timeout`/`ProxyTimeout`.
- Cloudflare (proxied) caps request bodies at 100–500 MB depending on plan —
  use a direct (DNS-only) hostname for very large uploads.

The Node server itself has all HTTP timeouts disabled
(`server.timeout = headersTimeout = requestTimeout = 0`).
