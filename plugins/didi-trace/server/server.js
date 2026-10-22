#!/usr/bin/env node
'use strict';
/*
 * Servidor local do dashboard: HTTP + SSE, apenas módulos nativos, apenas 127.0.0.1.
 * Só lê (nunca escreve) dentro de <config>/projects e <config>/didi-trace.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { configDir, SAFE_ID } = require('../scripts/paths');
const { buildSession } = require('./public/transcript');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4747;
const APP_ID = 'didi-trace';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/format.js': ['format.js', 'text/javascript; charset=utf-8'],
  '/transcript.js': ['transcript.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const HEAD_BYTES = 256 * 1024;
const ACTIVE_NO_HOOKS_MS = 30 * 1000;
const ACTIVE_WITH_HOOKS_MS = 10 * 60 * 1000;
const POLL_MS = 1000;
const version = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch (_) { return null; }
})();

function createApp(opts) {
  const cfg = (opts && opts.configDir) || configDir();
  const projectsDir = path.join(cfg, 'projects');
  const eventsDir = path.join((opts && opts.dataDir) || path.join(cfg, 'didi-trace'), 'events');
  const headCache = new Map();
  let indexCache = { at: 0, map: new Map() };
  let listenPort = null;

  function readDirs(dir) {
    try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  }

  function sessionIndex() {
    const now = Date.now();
    if (now - indexCache.at < 800) return indexCache.map;
    const map = new Map();
    for (const d of readDirs(projectsDir)) {
      if (!d.isDirectory()) continue;
      const dir = path.join(projectsDir, d.name);
      for (const f of readDirs(dir)) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const id = f.name.slice(0, -6);
        if (!SAFE_ID.test(id)) continue;
        const prev = map.get(id);
        const file = path.join(dir, f.name);
        let st; try { st = fs.statSync(file); } catch (_) { continue; }
        if (!prev || st.mtimeMs > prev.mtimeMs) map.set(id, { id, slug: d.name, file, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
    indexCache = { at: now, map };
    return map;
  }

  function readHead(file, bytes) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  }

  function readTail(file, bytes) {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  function truncatedField(line, key) {
    const m = new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.){0,600})').exec(line);
    if (!m) return null;
    let s = m[1].replace(/\\$/, '');
    try { return JSON.parse('"' + s + '"'); } catch (_) { s = s.replace(/\\u[0-9a-fA-F]{0,3}$/, ''); try { return JSON.parse('"' + s + '"'); } catch (__) { return null; } }
  }

  function headMeta(entry) {
    const key = entry.mtimeMs + ':' + entry.size;
    const hit = headCache.get(entry.file);
    if (hit && hit.key === key) return hit.meta;
    const meta = { firstPrompt: null, cwd: null, gitBranch: null, startedAt: null };
    try {
      for (const line of readHead(entry.file, HEAD_BYTES).split('\n')) {
        if (!line.trim()) continue;
        let o = null;
        try { o = JSON.parse(line); } catch (_) { /* linha cortada pelo limite de leitura */ }
        if (o) {
          if (!meta.cwd && typeof o.cwd === 'string') meta.cwd = o.cwd;
          if (!meta.gitBranch && typeof o.gitBranch === 'string') meta.gitBranch = o.gitBranch;
          if (!meta.startedAt && o.timestamp) meta.startedAt = o.timestamp;
        }
        if (!meta.firstPrompt && (o ? o.type === 'user' : /"type":"user"/.test(line.slice(0, 400)))) {
          let text = null;
          if (o && !o.isMeta && o.message) {
            const c = o.message.content;
            if (typeof c === 'string') text = c;
            else if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) text = c.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ');
          } else if (!o && !/"isMeta":true/.test(line)) text = truncatedField(line, 'content');
          if (text && text.trim() && !/^\s*<(local-command|system-reminder|command-)/.test(text)) meta.firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 200);
        }
        if (meta.firstPrompt && meta.cwd) break;
      }
    } catch (_) { /* arquivo ilegível: segue sem metadados */ }
    headCache.set(entry.file, { key, meta });
    return meta;
  }

  function lastEventName(id) {
    try {
      const lines = readTail(path.join(eventsDir, id + '.jsonl'), 8192).trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]).hook_event_name; } catch (_) { /* linha parcial no começo do trecho */ }
      }
    } catch (_) { /* sem eventos */ }
    return null;
  }

  function activityOf(entry) {
    let last = entry.mtimeMs;
    let hooks = false;
    try { const st = fs.statSync(path.join(eventsDir, entry.id + '.jsonl')); hooks = true; last = Math.max(last, st.mtimeMs); } catch (_) { /* sem hooks */ }
    try { last = Math.max(last, fs.statSync(path.join(path.dirname(entry.file), entry.id, 'subagents')).mtimeMs); } catch (_) { /* sem subagentes */ }
    const age = Date.now() - last;
    let active;
    if (hooks) {
      const name = age < ACTIVE_WITH_HOOKS_MS ? lastEventName(entry.id) : null;
      active = age < ACTIVE_WITH_HOOKS_MS && name !== 'SessionEnd' && (age < ACTIVE_NO_HOOKS_MS || name !== 'Stop');
    } else active = age < ACTIVE_NO_HOOKS_MS;
    return { last, hooks, active };
  }

  function listSessions() {
    const out = [];
    for (const e of sessionIndex().values()) {
      const m = headMeta(e);
      const a = activityOf(e);
      out.push({
        id: e.id, slug: e.slug, project: m.cwd || e.slug, cwd: m.cwd, gitBranch: m.gitBranch,
        firstPrompt: m.firstPrompt, startedAt: m.startedAt, lastActivity: new Date(a.last).toISOString(),
        active: a.active, hooks: a.hooks, size: e.size,
      });
    }
    out.sort((x, y) => (x.lastActivity < y.lastActivity ? 1 : -1));
    return out;
  }

  function agentFiles(entry) {
    const dir = path.join(path.dirname(entry.file), entry.id, 'subagents');
    const out = [];
    for (const f of readDirs(dir)) {
      const m = /^agent-(.+)\.jsonl$/.exec(f.name);
      if (!f.isFile() || !m || !SAFE_ID.test(m[1])) continue;
      out.push({ agentId: m[1], file: path.join(dir, f.name), metaFile: path.join(dir, 'agent-' + m[1] + '.meta.json') });
    }
    return out;
  }

  function readMeta(file) {
    try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; }
  }

  /** Lê o arquivo a partir de `from` e devolve só as linhas completas. */
  function readLines(file, from) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (_) { return { lines: [], offset: from, size: 0 }; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= from) return { lines: [], offset: from, size };
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const cut = buf.lastIndexOf(10);
      if (cut < 0) return { lines: [], offset: from, size };
      const lines = buf.toString('utf8', 0, cut).split('\n').map((l) => l.replace(/\r$/, ''));
      return { lines, offset: from + cut + 1, size };
    } finally { fs.closeSync(fd); }
  }

  function sessionRaw(entry) {
    const offsets = {};
    const main = readLines(entry.file, 0);
    offsets.main = main.offset;
    const agents = agentFiles(entry).map((a) => {
      const r = readLines(a.file, 0);
      offsets['agent:' + a.agentId] = r.offset;
      return { agentId: a.agentId, meta: readMeta(a.metaFile), lines: r.lines };
    });
    const eventsFile = path.join(eventsDir, entry.id + '.jsonl');
    const ev = readLines(eventsFile, 0);
    offsets.events = ev.offset;
    return { id: entry.id, slug: entry.slug, main: main.lines, agents, events: ev.lines, offsets, active: activityOf(entry).active };
  }

  function send(res, status, body, type, extra) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, Object.assign({
      'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    }, extra));
    res.end(buf);
  }
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

  function hostAllowed(req) {
    const h = String(req.headers.host || '').toLowerCase();
    return h === `127.0.0.1:${listenPort}` || h === `localhost:${listenPort}`;
  }

  function streamSession(req, res, entry, url) {
    let offsets = {};
    try { offsets = JSON.parse(url.searchParams.get('offsets') || '{}') || {}; } catch (_) { offsets = {}; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const sentMeta = new Map();
    let lastActive = null;
    let closed = false;
    let busy = false;
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    function pump(key, kind, file, extra) {
      const from = Number.isFinite(offsets[key]) && offsets[key] >= 0 ? offsets[key] : 0;
      const r = readLines(file, from);
      if (r.size < from) { emit('reset', { key }); offsets[key] = r.size; return; }
      if (!r.lines.length) return;
      offsets[key] = r.offset;
      emit('lines', Object.assign({ key, kind, lines: r.lines, offset: r.offset }, extra));
    }

    function tick() {
      if (closed || busy) return;
      busy = true;
      try {
        pump('main', 'main', entry.file, {});
        for (const a of agentFiles(entry)) {
          const meta = readMeta(a.metaFile);
          const metaStr = JSON.stringify(meta);
          const changed = sentMeta.get(a.agentId) !== metaStr;
          const before = offsets['agent:' + a.agentId];
          pump('agent:' + a.agentId, 'agent', a.file, { agentId: a.agentId, meta });
          if (changed && before === offsets['agent:' + a.agentId]) emit('meta', { agentId: a.agentId, meta });
          sentMeta.set(a.agentId, metaStr);
        }
        pump('events', 'events', path.join(eventsDir, entry.id + '.jsonl'), {});
        const active = activityOf(entry).active;
        if (active !== lastActive) { lastActive = active; emit('status', { active }); }
      } catch (_) { /* um ciclo ruim não derruba a conexão */ } finally { busy = false; }
    }

    let timer = null;
    const watchers = [];
    const kick = () => { if (!timer) timer = setTimeout(() => { timer = null; tick(); }, 50); };
    for (const dir of [path.dirname(entry.file), path.join(path.dirname(entry.file), entry.id, 'subagents'), eventsDir]) {
      try { const w = fs.watch(dir, kick); w.on('error', () => {}); watchers.push(w); } catch (_) { /* o polling cobre */ }
    }
    const poll = setInterval(tick, POLL_MS);
    const beat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      closed = true;
      clearInterval(poll); clearInterval(beat); clearTimeout(timer);
      for (const w of watchers) w.close();
    });
    tick();
  }

  function handler(req, res) {
    try {
      if (!hostAllowed(req)) return send(res, 403, 'Host não permitido', 'text/plain; charset=utf-8');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
      const url = new URL(req.url, `http://${HOST}`);
      const p = url.pathname;
      if (STATIC[p]) {
        const [name, type] = STATIC[p];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, name)), type);
      }
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (p === '/api/health') return json(res, 200, { app: APP_ID, version, pid: process.pid });
      if (p === '/api/config') {
        return json(res, 200, { configDir: cfg, projectsDir, projectsDirExists: fs.existsSync(projectsDir), eventsDir, version });
      }
      if (p === '/api/sessions') return json(res, 200, { sessions: listSessions(), projectsDir });
      const m = /^\/api\/sessions\/([^/]+)(\/stream)?$/.exec(p);
      if (m) {
        let id;
        try { id = decodeURIComponent(m[1]); } catch (_) { return json(res, 400, { error: 'id inválido' }); }
        if (!SAFE_ID.test(id)) return json(res, 400, { error: 'id inválido' });
        const entry = sessionIndex().get(id);
        if (!entry) return json(res, 404, { error: 'sessão não encontrada' });
        if (m[2]) return streamSession(req, res, entry, url);
        const raw = sessionRaw(entry);
        if (url.searchParams.get('format') === 'tree') {
          return json(res, 200, buildSession({ sessionId: id, main: raw.main, agents: raw.agents, events: raw.events, active: raw.active }));
        }
        return json(res, 200, raw);
      }
      return json(res, 404, { error: 'não encontrado' });
    } catch (err) {
      return json(res, 500, { error: 'erro interno' });
    }
  }

  const server = http.createServer(handler);
  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => { listenPort = server.address().port; server.removeListener('error', reject); resolve(listenPort); });
      });
    },
    close() { return new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }); },
  };
}

if (require.main === module) {
  const port = Number(process.env.DIDI_TRACE_PORT) || DEFAULT_PORT;
  const app = createApp();
  app.listen(port).then(
    () => {},
    (err) => { process.stderr.write(`didi-trace: não foi possível escutar em ${HOST}:${port}: ${err.message}\n`); process.exit(1); },
  );
}

module.exports = { createApp, HOST, DEFAULT_PORT, APP_ID };
