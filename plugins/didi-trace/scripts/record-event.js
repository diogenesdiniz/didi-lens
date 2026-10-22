#!/usr/bin/env node
'use strict';
/*
 * Hook de coleta: acrescenta cada evento recebido no stdin a
 * <config>/didi-trace/events/<session-id>.jsonl.
 *
 * Regras: nunca bloqueia o Claude Code, nunca escreve no stdout (em SessionStart e
 * UserPromptSubmit o stdout vai para o contexto do modelo) e sempre sai com código 0.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dataDir, SAFE_ID } = require('./paths');

const MAX_FIELD = 1024 * 1024;

function clip(value, depth) {
  if (typeof value === 'string') {
    return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) + `\n[... truncado: ${value.length - MAX_FIELD} caracteres omitidos]` : value;
  }
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clip(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) out[k] = clip(value[k], depth + 1);
  return out;
}

function logError(err) {
  try {
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'errors.log');
    try { if (fs.statSync(file).size > 256 * 1024) fs.truncateSync(file, 0); } catch (_) { /* arquivo ainda não existe */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`);
  } catch (_) { /* sem onde registrar: segue em silêncio */ }
}

function maybeAutostart() {
  if (process.env.DIDI_TRACE_AUTOSTART !== '1') return;
  const child = spawn(process.execPath, [path.join(__dirname, 'start-server.js'), '--quiet'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

function main() {
  const input = fs.readFileSync(0, 'utf8');
  const payload = JSON.parse(input);
  if (!payload || typeof payload !== 'object') return;
  const sid = payload.session_id;
  if (typeof sid !== 'string' || !SAFE_ID.test(sid)) return;
  const dir = path.join(dataDir(), 'events');
  fs.mkdirSync(dir, { recursive: true });
  const record = clip(payload, 0);
  record._recv = Date.now();
  fs.appendFileSync(path.join(dir, sid + '.jsonl'), JSON.stringify(record) + '\n');
  if (payload.hook_event_name === 'SessionStart') maybeAutostart();
}

try { main(); } catch (err) { logError(err); }
process.exitCode = 0;
