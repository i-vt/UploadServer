'use strict';

/**
 * fileshare — large-file upload & share service.
 *
 * Uploads are gated by keys:
 *   - a master upload key (64-char hex, random at startup or via UPLOAD_KEY)
 *   - temporary keys with a limited number of uses (1, 2, … N), created
 *     from the admin console
 * Admin operations are gated by a separate admin key (random at startup or
 * via ADMIN_KEY). Both keys are printed to stdout and written to KEY_FILE.
 *
 * Per-upload retention options (defaults come from config.json):
 *   - deleteOnReboot  wipe the file when the server (re)starts   [default on]
 *   - ttlMinutes      keep the file only for this long
 *   - maxDownloads    remove the file after N downloads
 * Every deletion is secure: the bytes are overwritten with random data
 * (and fsync'd) before the file is unlinked.
 *
 * Every uploaded file gets a UUID download link. Everything streams to disk;
 * request bodies are never buffered in memory, so uploads up to 50 GB work.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const express = require('express');
const Busboy = require('busboy');

const ROOT = __dirname;

// ---------------------------------------------------------------------------
// Configuration — built-in defaults < config.json < environment variables
// ---------------------------------------------------------------------------

const CONFIG_FILE = process.env.CONFIG_FILE || path.join(ROOT, 'config.json');

function loadConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.error(`Ignoring ${CONFIG_FILE}: top level must be a JSON object`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not parse ${CONFIG_FILE}, using defaults:`, err.message);
  }
  return {};
}

const fileConfig = loadConfigFile();
const fileUploadDefaults = (fileConfig.uploads && typeof fileConfig.uploads === 'object') ? fileConfig.uploads : {};

/** Config helper: env var (string) > config file > fallback. */
function pick(envValue, fileValue, fallback) {
  if (envValue !== undefined && envValue !== '') return envValue;
  if (fileValue !== undefined && fileValue !== null) return fileValue;
  return fallback;
}

function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function toNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const PORT = toNumber(pick(process.env.PORT, fileConfig.port, 3000), 3000);
const UPLOAD_DIR = path.resolve(String(pick(process.env.UPLOAD_DIR, fileConfig.uploadDir, path.join(ROOT, 'uploads'))));
const DATA_FILE = path.resolve(String(pick(process.env.DATA_FILE, fileConfig.dataFile, path.join(ROOT, 'files.json'))));
const KEYS_FILE = path.resolve(String(pick(process.env.KEYS_FILE, fileConfig.keysFile, path.join(ROOT, 'keys.json'))));
const KEY_FILE = process.env.KEY_FILE === undefined ? '/tmp/FileUploadKeys.txt' : process.env.KEY_FILE;
const MAX_FILE_SIZE_GB = toNumber(pick(process.env.MAX_FILE_SIZE_GB, fileConfig.maxFileSizeGB, 50), 50);
const MAX_FILE_SIZE = MAX_FILE_SIZE_GB * 1024 ** 3;
const SWEEP_INTERVAL_SECONDS = Math.max(2, toNumber(pick(process.env.SWEEP_INTERVAL_SECONDS, fileConfig.sweepIntervalSeconds, 30), 30));
const MAX_KEY_USES = 100000; // sanity cap for temp-key use counts
const MAX_TTL_MINUTES = 525600; // 1 year
const MAX_DOWNLOADS_CAP = 1000000;

/** Per-upload retention defaults (overridable per upload via form fields/query). */
const UPLOAD_DEFAULTS = {
  deleteOnReboot: toBool(pick(process.env.DELETE_ON_REBOOT, fileUploadDefaults.deleteOnReboot, true), true),
  ttlMinutes: Math.max(0, toNumber(pick(process.env.UPLOAD_TTL_MINUTES, fileUploadDefaults.ttlMinutes, 0), 0)),
  maxDownloads: Math.max(0, Math.floor(toNumber(pick(process.env.UPLOAD_MAX_DOWNLOADS, fileUploadDefaults.maxDownloads, 0), 0))),
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const newKey = () => crypto.randomBytes(32).toString('hex'); // 64 lowercase hex chars

const UPLOAD_KEY = (process.env.UPLOAD_KEY || newKey()).trim();
const ADMIN_KEY = (process.env.ADMIN_KEY || newKey()).trim();

/** Constant-time string compare that tolerates length mismatch. */
function keyEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function writeKeyFile() {
  if (!KEY_FILE) return; // disabled via KEY_FILE=""
  const body = [
    `upload_key=${UPLOAD_KEY}`,
    `admin_key=${ADMIN_KEY}`,
    '',
  ].join('\n');
  try {
    const fd = fs.openSync(KEY_FILE, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
    try {
      fs.writeSync(fd, body);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(KEY_FILE, 0o600); // in case the file already existed with looser perms
  } catch (err) {
    console.error(`Could not write key file ${KEY_FILE}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Secure deletion — overwrite with random data, fsync, then unlink.
// ---------------------------------------------------------------------------

const OVERWRITE_CHUNK = 8 * 1024 ** 2; // 8 MB

async function secureDelete(filePath) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch {
    return; // already gone
  }
  if (!st.isFile()) return;
  try {
    if (st.size > 0) {
      const fd = await fsp.open(filePath, 'r+');
      try {
        const pattern = crypto.randomBytes(Math.min(OVERWRITE_CHUNK, st.size));
        let offset = 0;
        while (offset < st.size) {
          const len = Math.min(pattern.length, st.size - offset);
          await fd.write(pattern, 0, len, offset);
          offset += len;
        }
        await fd.sync();
      } finally {
        await fd.close();
      }
    }
    await fsp.unlink(filePath);
  } catch (err) {
    console.error(`Secure delete failed for ${filePath}:`, err.message);
    // Last resort: still try to unlink so the data is at least unreachable.
    try { await fsp.unlink(filePath); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Metadata store — JSON object: { "<uuid>": { id, name, size, uploadedAt,
//   deleteOnReboot, expiresAt, maxDownloads, downloads } }
// Temp key store  — JSON object: { "<key>": { usesLeft, createdAt, lastUsedAt } }
// ---------------------------------------------------------------------------

/** @type {Record<string, object>} */
let metadata = {};

/** @type {Record<string, {usesLeft: number, createdAt: string, lastUsedAt: string|null}>} */
let tempKeys = {};

function loadJsonFile(file, what) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Could not parse ${file}, starting with empty ${what}:`, err.message);
    }
  }
  return {};
}

let persistQueue = Promise.resolve();

/**
 * Persist both stores atomically-ish (write tmp file + rename). Calls are
 * serialized so concurrent uploads/admin actions cannot interleave writes.
 */
function persistState() {
  persistQueue = persistQueue.then(async () => {
    const suffix = `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    await fsp.writeFile(DATA_FILE + suffix, JSON.stringify(metadata, null, 2));
    await fsp.rename(DATA_FILE + suffix, DATA_FILE);
    await fsp.writeFile(KEYS_FILE + suffix, JSON.stringify(tempKeys, null, 2));
    await fsp.rename(KEYS_FILE + suffix, KEYS_FILE);
  }).catch((err) => {
    console.error('Failed to persist state:', err);
  });
  return persistQueue;
}

/**
 * Validate an upload key. Returns { type: 'master' } for the master key,
 * { type: 'temp', key } for a live temp key, or null.
 */
function resolveUploadKey(key) {
  if (!key || typeof key !== 'string') return null;
  if (keyEquals(key, UPLOAD_KEY)) return { type: 'master' };
  for (const k of Object.keys(tempKeys)) {
    if (keyEquals(k, key)) {
      const rec = tempKeys[k];
      if (rec && rec.usesLeft > 0) return { type: 'temp', key: k };
      return null; // exhausted keys are dead weight — treat as invalid
    }
  }
  return null;
}

/** Consume one use of a temp key; deletes the key when it reaches zero. */
function consumeTempKey(key) {
  const rec = tempKeys[key];
  if (!rec) return;
  rec.usesLeft -= 1;
  rec.lastUsedAt = new Date().toISOString();
  if (rec.usesLeft <= 0) delete tempKeys[key];
}

/** Remove a file record and securely wipe its bytes from disk. */
async function deleteFile(id, reason) {
  const rec = metadata[id];
  if (!rec) return false;
  delete metadata[id];
  console.log(`Deleting ${id} (${rec.name}) — ${reason}`);
  await persistState();
  await secureDelete(path.join(UPLOAD_DIR, id));
  return true;
}

/**
 * Count a completed download; removes the file once it reaches its
 * maxDownloads limit.
 */
async function recordDownload(id) {
  const rec = metadata[id];
  if (!rec) return;
  rec.downloads = (rec.downloads || 0) + 1;
  if (rec.maxDownloads && rec.downloads >= rec.maxDownloads) {
    await deleteFile(id, `download limit reached (${rec.downloads}/${rec.maxDownloads})`);
  } else {
    await persistState();
  }
}

/** Delete every expired file. Runs on a timer. */
async function sweepExpired() {
  const now = Date.now();
  for (const rec of Object.values(metadata)) {
    if (rec.expiresAt && Date.parse(rec.expiresAt) <= now) {
      await deleteFile(rec.id, `expired (ttl, expiresAt ${rec.expiresAt})`);
    }
  }
}

/** On boot: wipe all files uploaded with deleteOnReboot (the default). */
async function wipeEphemeralFiles() {
  const doomed = Object.values(metadata).filter((rec) => rec.deleteOnReboot);
  if (!doomed.length) return;
  console.log(`Startup: wiping ${doomed.length} file(s) marked delete-on-reboot...`);
  for (const rec of doomed) {
    delete metadata[rec.id]; // unreachable immediately, bytes wiped below
  }
  await persistState();
  for (const rec of doomed) {
    await secureDelete(path.join(UPLOAD_DIR, rec.id));
  }
  console.log('Startup: ephemeral wipe complete.');
}

/** Parse the per-upload retention options from query params + form fields. */
function parseUploadOptions(query, fields) {
  const rawDeleteOnReboot = query.deleteOnReboot !== undefined ? query.deleteOnReboot : fields.deleteOnReboot;
  const rawTtl = query.ttlMinutes !== undefined ? query.ttlMinutes : fields.ttlMinutes;
  const rawMaxDl = query.maxDownloads !== undefined ? query.maxDownloads : fields.maxDownloads;

  const deleteOnReboot = rawDeleteOnReboot === undefined
    ? UPLOAD_DEFAULTS.deleteOnReboot
    : toBool(rawDeleteOnReboot, UPLOAD_DEFAULTS.deleteOnReboot);

  let ttlMinutes = rawTtl === undefined || rawTtl === '' ? UPLOAD_DEFAULTS.ttlMinutes : toNumber(rawTtl, UPLOAD_DEFAULTS.ttlMinutes);
  ttlMinutes = Math.min(Math.max(ttlMinutes, 0), MAX_TTL_MINUTES);

  let maxDownloads = rawMaxDl === undefined || rawMaxDl === '' ? UPLOAD_DEFAULTS.maxDownloads : Math.floor(toNumber(rawMaxDl, UPLOAD_DEFAULTS.maxDownloads));
  maxDownloads = Math.min(Math.max(maxDownloads, 0), MAX_DOWNLOADS_CAP);

  return {
    deleteOnReboot,
    expiresAt: ttlMinutes > 0 ? new Date(Date.now() + ttlMinutes * 60000).toISOString() : null,
    maxDownloads: maxDownloads > 0 ? maxDownloads : null,
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Pages + shared assets (style.css). No directory listing, no upload dir.
app.use(express.static(path.join(ROOT, 'public'), { index: false, dotfiles: 'ignore' }));

app.get('/', (req, res) => {
  res.redirect(302, '/upload');
});

app.get('/upload', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'upload.html'));
});

app.get('/download', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'download.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'admin.html'));
});

// Public defaults so the upload page can pre-fill the options form.
app.get('/api/upload-defaults', (req, res) => {
  res.json({
    deleteOnReboot: UPLOAD_DEFAULTS.deleteOnReboot,
    ttlMinutes: UPLOAD_DEFAULTS.ttlMinutes,
    maxDownloads: UPLOAD_DEFAULTS.maxDownloads,
    maxFileSize: MAX_FILE_SIZE,
  });
});

// ---------------------------------------------------------------------------
// Upload — key checked BEFORE the body is parsed.
// ---------------------------------------------------------------------------

app.post('/api/upload', (req, res) => {
  const key = req.get('x-upload-key') || req.query.key;
  const grant = resolveUploadKey(key);
  if (!grant) {
    return res.status(403).json({ error: 'invalid or exhausted upload key' });
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
  const fields = {}; // text fields (retention options) parsed alongside the file

  const cleanup = async () => {
    await secureDelete(destPath);
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

  busboy.on('field', (name, value) => {
    if (typeof value === 'string' && value.length <= 256) fields[name] = value;
  });

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
    if (sizeLimitHit) return fail(413, `file exceeds the ${MAX_FILE_SIZE_GB} GB limit`);

    let size;
    try {
      size = (await fsp.stat(destPath)).size;
    } catch (err) {
      console.error('Stat error:', err);
      return fail(500, 'failed to store file');
    }

    const options = parseUploadOptions(req.query, fields);

    metadata[id] = {
      id,
      name: fileName,
      size,
      uploadedAt: new Date().toISOString(),
      deleteOnReboot: options.deleteOnReboot,
      expiresAt: options.expiresAt,
      maxDownloads: options.maxDownloads,
      downloads: 0,
    };
    // A temp-key use is only consumed once the upload actually succeeded.
    if (grant.type === 'temp') consumeTempKey(grant.key);
    await persistState();

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
  res.json({
    id: rec.id,
    name: rec.name,
    size: rec.size,
    uploadedAt: rec.uploadedAt,
    expiresAt: rec.expiresAt || null,
    maxDownloads: rec.maxDownloads || null,
    downloads: rec.downloads || 0,
    deleteOnReboot: !!rec.deleteOnReboot,
  });
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

    // A download "counts" once the final byte of the file has been served,
    // so a resumed/ranged download counts once (when its last chunk lands).
    const watchCompletion = (end) => {
      res.on('finish', () => {
        if (total === 0 || end === total - 1) {
          recordDownload(rec.id).catch((e) => console.error('download accounting failed:', e));
        }
      });
    };

    const sendStream = (start, end, status) => {
      res.status(status);
      res.setHeader('Content-Length', end - start + 1);
      watchCompletion(end);
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
      watchCompletion(-1);
      return res.status(200).end();
    }
    sendStream(0, total - 1, 200);
  });
});

// ---------------------------------------------------------------------------
// Admin API — every route requires the admin key.
// ---------------------------------------------------------------------------

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.admin_key;
  if (!keyEquals(key || '', ADMIN_KEY)) {
    return res.status(403).json({ error: 'invalid admin key' });
  }
  next();
}

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const files = Object.values(metadata);
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
  res.json({
    uploadKey: UPLOAD_KEY,
    fileCount: files.length,
    totalSize,
    tempKeyCount: Object.keys(tempKeys).length,
    maxFileSize: MAX_FILE_SIZE,
    uploadDefaults: UPLOAD_DEFAULTS,
  });
});

app.get('/api/admin/keys', requireAdmin, (req, res) => {
  const keys = Object.entries(tempKeys)
    .map(([key, rec]) => ({ key, usesLeft: rec.usesLeft, createdAt: rec.createdAt, lastUsedAt: rec.lastUsedAt }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ keys });
});

app.post('/api/admin/keys', requireAdmin, async (req, res) => {
  const uses = Number(req.body && req.body.uses);
  if (!Number.isInteger(uses) || uses < 1 || uses > MAX_KEY_USES) {
    return res.status(400).json({ error: `uses must be an integer between 1 and ${MAX_KEY_USES}` });
  }
  const key = newKey();
  tempKeys[key] = { usesLeft: uses, createdAt: new Date().toISOString(), lastUsedAt: null };
  await persistState();
  res.status(201).json({ key, usesLeft: uses });
});

app.delete('/api/admin/keys/:key', requireAdmin, async (req, res) => {
  if (!tempKeys[req.params.key]) return res.status(404).json({ error: 'key not found' });
  delete tempKeys[req.params.key];
  await persistState();
  res.json({ ok: true });
});

app.get('/api/admin/files', requireAdmin, (req, res) => {
  const files = Object.values(metadata)
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  res.json({ files });
});

app.delete('/api/admin/files/:id', requireAdmin, async (req, res) => {
  if (!metadata[req.params.id]) return res.status(404).json({ error: 'file not found' });
  await deleteFile(req.params.id, 'deleted by admin');
  res.json({ ok: true });
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
  await fsp.mkdir(path.dirname(KEYS_FILE), { recursive: true });
  metadata = loadJsonFile(DATA_FILE, 'metadata');
  tempKeys = loadJsonFile(KEYS_FILE, 'temp keys');
  writeKeyFile();

  // Files marked delete-on-reboot (the default) do not survive a restart.
  await wipeEphemeralFiles();

  // TTL enforcement.
  const sweeper = setInterval(() => {
    sweepExpired().catch((err) => console.error('sweep failed:', err));
  }, SWEEP_INTERVAL_SECONDS * 1000);
  sweeper.unref();

  const server = app.listen(PORT, () => {
    console.log(`Upload key (master, unlimited uses): ${UPLOAD_KEY}`);
    console.log(`Admin key:                           ${ADMIN_KEY}`);
    if (KEY_FILE) console.log(`Keys written to ${KEY_FILE}`);
    console.log(`Config file: ${CONFIG_FILE}`);
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
