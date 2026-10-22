'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');
const { FIXTURES, RICH, tmpDir, copyDir } = require('./helpers');

// O servidor grava server.log no diretório de dados: usa uma cópia descartável das fixtures.
const CONFIG = tmpDir();
copyDir(FIXTURES, CONFIG);

const START = path.join(__dirname, '..', 'scripts', 'start-server.js');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

function health(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject);
  });
}

function start(port, args) {
  return spawnSync(process.execPath, [START].concat(args || []), { env: Object.assign({}, process.env, { DIDI_TRACE_PORT: String(port), CLAUDE_CONFIG_DIR: CONFIG }), encoding: 'utf8', timeout: 20000 });
}

test('chamar duas vezes não sobe dois servidores', async () => {
  const port = await freePort();
  let pid;
  try {
    const a = start(port, [RICH]);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /iniciado/);
    assert.ok(a.stdout.includes(`http://127.0.0.1:${port}/#${RICH}`));
    pid = (await health(port)).pid;
    const b = start(port);
    assert.equal(b.status, 0);
    assert.match(b.stdout, /já está em execução/);
    assert.equal((await health(port)).pid, pid);
  } finally { if (pid) process.kill(pid); }
});

test('id de sessão inválido é ignorado na URL', async () => {
  const port = await freePort();
  let pid;
  try {
    const a = start(port, ['../x']);
    pid = (await health(port)).pid;
    assert.ok(a.stdout.trim().endsWith(`http://127.0.0.1:${port}/`));
  } finally { if (pid) process.kill(pid); }
});

test('porta ocupada por outro processo é informada com clareza', async () => {
  const other = http.createServer((req, res) => res.end('outro serviço'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  try {
    const r = start(other.address().port);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /ocupada por outro processo/);
  } finally { other.close(); }
});
