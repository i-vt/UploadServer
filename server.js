'use strict';

/**
 * fileshare — large-file upload & share service.
 *
 * Uploads are gated by a 64-char random key generated at startup
 * (written to /tmp/FileUploadKeys.txt). Every uploaded file gets a UUID
 * download link. Everything streams to disk; request bodies are never
 * buffered in memory, so uploads up to 50 GB work.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const Busboy = require('busboy');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'files.json');
const KEY_FILE = '/tmp/FileUploadKeys.txt';
const MAX_FILE_SIZE = 50 * 1024 ** 3; // 50 GB

// ---------------------------------------------------------------------------
// Startup key
// ---------------------------------------------------------------------------

const UPLOAD_KEY = crypto.randomBytes(32).toString('hex'); // 64 lowercase hex chars

function writeKeyFile() {
  const fd = fs.openSync(KEY_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, UPLOAD_KEY + '\n');
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(KEY_FILE, 0o600); // in case the file already existed with looser perms
}

// ---------------------------------------------------------------------------
// Metadata store — JSON object: { "<uuid>": { id, name, size, uploadedAt } }
// ---------------------------------------------------------------------------

/** @type {Record<string, {id: string, name: string, size: number, uploadedAt: string}>} */
let metadata = {};

function loadMetadata() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed;
    } else {
      metadata = {};
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Could not parse ${DATA_FILE}, starting with empty metadata:`, err.message);
    }
    metadata = {};
  }
}

let persistQueue = Promise.resolve();

/**
 * Persist metadata atomically-ish (write tmp file + rename). Calls are
 * serialized so concurrent uploads cannot interleave writes.
 */
function persistMetadata() {
  persistQueue = persistQueue.then(async () => {
    const tmp = `${DATA_FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    await fsp.writeFile(tmp, JSON.stringify(metadata, null, 2));
    await fsp.rename(tmp, DATA_FILE);
  }).catch((err) => {
    console.error('Failed to persist metadata:', err);
  });
  return persistQueue;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

// Serve only the two pages explicitly; no directory listing, no static upload dir.
app.get('/', (req, res) => {
  res.redirect(302, '/upload');
});

app.get('/upload', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'upload.html'));
});

app.get('/download', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'download.html'));
});

// ---------------------------------------------------------------------------
// Upload — key checked BEFORE the body is parsed.
// ---------------------------------------------------------------------------

app.post('/api/upload', (req, res) => {
  const key = req.get('x-upload-key') || req.query.key;
  if (!key || key !== UPLOAD_KEY) {
    return res.status(403).json({ error: 'invalid upload key' });
  }

  const id = crypto.randomUUID();
  const destPath = path.join(UPLOAD_DIR, id);

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    });
  } catch (err) {
    return res.status(400).json({ error: 'invalid multipart request' });
  }

  let fileSeen = false;
  let fileName = null;
  let sizeLimitHit = false;
  let aborted = false;
  let responded = false;
  let writeStream = null;
  let writeDone = null; // resolves once every byte is flushed to disk

  const cleanup = async () => {
    try {
      await fsp.unlink(destPath);
    } catch {
      // nothing to remove
    }
  };

  const fail = (status, message) => {
    if (responded) return;
    responded = true;
    if (writeStream) writeStream.destroy();
    cleanup().finally(() => {
      if (!res.headersSent) res.status(status).json({ error: message });
      else res.destroy();
    });
  };

  busboy.on('file', (fieldname, file, info) => {
    fileSeen = true;
    fileName = info.filename || 'unnamed';
    writeStream = fs.createWriteStream(destPath);
    writeDone = new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    writeDone.catch(() => {}); // rejection is handled in the finish handler below

    writeStream.on('error', (err) => {
      console.error('Write error:', err);
      file.resume(); // drain the rest of the part so the request can settle
    });

    file.on('limit', () => {
      sizeLimitHit = true;
    });

    file.pipe(writeStream);
  });

  busboy.on('error', (err) => {
    console.error('Busboy error:', err);
    fail(400, 'malformed multipart body');
  });

  busboy.on('finish', async () => {
    if (responded || aborted) return;
    if (!fileSeen) return fail(400, 'no file in request');

    // busboy finishes parsing before the write stream has flushed; wait for
    // every byte to hit the disk before measuring the file.
    try {
      await writeDone;
    } catch {
      return fail(500, 'failed to store file');
    }
    if (sizeLimitHit) return fail(413, 'file exceeds the 50 GB limit');

    let size;
    try {
      size = (await fsp.stat(destPath)).size;
    } catch (err) {
      console.error('Stat error:', err);
      return fail(500, 'failed to store file');
    }

    metadata[id] = {
      id,
      name: fileName,
      size,
      uploadedAt: new Date().toISOString(),
    };
    await persistMetadata();

    if (responded || aborted) {
      // Client went away while we were finishing up; drop the file.
      await cleanup();
      return;
    }
    responded = true;
    res.status(200).json({ id, name: fileName, size, url: `/download?id=${id}` });
  });

  // Client aborted mid-upload: delete the partial file. Note: we deliberately
  // do NOT use req.on('close') — that also fires after a normally-consumed
  // request body, which would race the write stream's final flush.
  req.on('aborted', () => {
    aborted = true;
    if (writeStream) writeStream.destroy();
    cleanup();
  });

  req.pipe(busboy);
});

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

app.get('/api/file/:id', (req, res) => {
  const rec = metadata[req.params.id];
  if (!rec) return res.status(404).json({ error: 'file not found' });
  res.json({ id: rec.id, name: rec.name, size: rec.size, uploadedAt: rec.uploadedAt });
});

// ---------------------------------------------------------------------------
// Download — streamed, with Range support.
// ---------------------------------------------------------------------------

app.get('/api/download/:id', (req, res) => {
  const rec = metadata[req.params.id];
  if (!rec) return res.status(404).json({ error: 'file not found' });

  const filePath = path.join(UPLOAD_DIR, rec.id);
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ error: 'file not found' });

    const total = st.size;
    const encoded = encodeURIComponent(rec.name);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

    const sendStream = (start, end, status) => {
      res.status(status);
      res.setHeader('Content-Length', end - start + 1);
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', (streamErr) => {
        console.error('Download stream error:', streamErr);
        if (!res.headersSent) res.status(500).json({ error: 'download failed' });
        else res.destroy();
      });
      stream.pipe(res);
    };

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).json({ error: 'range not satisfiable' });
      }

      let start;
      let end;
      if (m[1] === '') {
        // suffix range: last N bytes
        const suffix = parseInt(m[2], 10);
        if (suffix <= 0) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).json({ error: 'range not satisfiable' });
        }
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
      }

      if (total === 0 || start >= total || start > end) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).json({ error: 'range not satisfiable' });
      }
      end = Math.min(end, total - 1);

      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      return sendStream(start, end, 206);
    }

    if (total === 0) {
      res.setHeader('Content-Length', 0);
      return res.status(200).end();
    }
    sendStream(0, total - 1, 200);
  });
});

// JSON 404 for unknown API routes.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Central error handler — never leak stack traces to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
  else res.destroy();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  loadMetadata();
  writeKeyFile();

  const server = app.listen(PORT, () => {
    console.log(`Upload key: ${UPLOAD_KEY}`);
    console.log(`Key written to ${KEY_FILE}`);
    console.log(`fileshare listening on http://0.0.0.0:${PORT}`);
  });

  // Long uploads/downloads must never be killed by Node's HTTP timeouts.
  server.timeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
