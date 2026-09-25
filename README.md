# fileshare

Single Node.js service for sharing large files. Uploads are gated by a 64-char
random key generated at startup; every uploaded file gets a UUID download link.
Uploads stream to disk (never buffered in memory), so files up to **50 GB**
work from a browser.

## Requirements

- Node.js >= 18
- Dependencies: `express`, `busboy` (installed via `npm install`)

## Quick start

```bash
npm install
node server.js        # or: npm start
```

On startup the server generates a random upload key and:

- prints it to stdout (`Upload key: <key>`)
- writes it to `/tmp/FileUploadKeys.txt` (mode `0600`)

Open `http://<host>:3000/` in a browser — you'll be redirected to the upload
page. Paste the key, drop a file, and you get a share link of the form
`http://<host>:3000/download?id=<uuid>`.

## Getting the upload key

```bash
cat /tmp/FileUploadKeys.txt
```

The key changes every time the service restarts.

## Install as a systemd service (Debian/Ubuntu)

```bash
sudo ./installer.sh                # default port 3000
sudo ./installer.sh --port 8080    # custom port
```

The installer:

1. Installs `nodejs` + `npm` via apt if missing (requires Node >= 18).
2. Runs `npm install --omit=dev` in the script directory.
3. Writes `/etc/systemd/system/fileshare.service` (`Environment=PORT=<port>`, `Restart=always`).
4. Runs `systemctl daemon-reload && systemctl enable --now fileshare`.

Check status and logs with:

```bash
systemctl status fileshare
journalctl -u fileshare -f
```

## Uploading / downloading

- **Browser:** open `/upload`, paste the 64-char key, drag & drop a file.
  Progress (%, MB/s, ETA) is shown during the upload. The resulting share link
  is displayed in a copyable box.
- **curl:**

  ```bash
  KEY=$(cat /tmp/FileUploadKeys.txt)
  curl -H "x-upload-key: $KEY" -F "file=@bigfile.bin" http://localhost:3000/api/upload
  ```

- **Download:** open the share link (`/download?id=<uuid>`) and click
  Download, or:

  ```bash
  curl -OJ http://localhost:3000/api/download/<uuid>
  ```

Downloads support HTTP `Range` requests (`Accept-Ranges: bytes`, 206 partial
content), so download managers can resume.

## API

| Route | Auth | Description |
|---|---|---|
| `GET /` | — | 302 redirect to `/upload` |
| `GET /upload` | — | Upload page |
| `GET /download` | — | Download page |
| `POST /api/upload` | key | Multipart upload (one file). Key via `x-upload-key` header or `?key=` query. Returns `{ id, name, size, url }`. Wrong/missing key → `403`. Over 50 GB → `413`. |
| `GET /api/file/:id` | — | JSON metadata `{ id, name, size, uploadedAt }`, 404 if unknown |
| `GET /api/download/:id` | — | Streams the file (`Content-Disposition: attachment`), supports `Range` |

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `UPLOAD_DIR` | `<repo>/uploads` | Where uploaded files are stored (named by UUID) |
| `DATA_FILE` | `<repo>/files.json` | JSON metadata store (uuid → name/size/date) |

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
