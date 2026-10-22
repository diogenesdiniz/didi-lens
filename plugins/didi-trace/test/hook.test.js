'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'record-event.js');

function run(input, env) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [SCRIPT], { input, env: Object.assign({}, process.env, env), encoding: 'utf8' });
  r.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return r;
}

test('grava o evento no arquivo da sessão, com stdout vazio e código 0', () => {
  const cfg = tmpDir();
  const payload = { session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'ls' } };
  const r = run(JSON.stringify(payload), { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const lines = fs.readFileSync(path.join(cfg, 'didi-trace', 'events', 'sess-1.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.tool_use_id, 'toolu_1');
  assert.equal(typeof rec._recv, 'number');
  run(JSON.stringify(Object.assign(payload, { hook_event_name: 'PostToolUse' })), { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(fs.readFileSync(path.join(cfg, 'didi-trace', 'events', 'sess-1.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('campos acima de 1 MB são truncados com marcador', () => {
  const cfg = tmpDir();
  const big = 'z'.repeat(1024 * 1024 + 500);
  run(JSON.stringify({ session_id: 's', hook_event_name: 'PostToolUse', tool_response: { stdout: big } }), { CLAUDE_CONFIG_DIR: cfg });
  const rec = JSON.parse(fs.readFileSync(path.join(cfg, 'didi-trace', 'events', 's.jsonl'), 'utf8'));
  assert.ok(rec.tool_response.stdout.length < big.length);
  assert.match(rec.tool_response.stdout, /truncado: 500 caracteres/);
});

test('JSON inválido, stdin vazio e session_id malicioso não falham nem escrevem fora', () => {
  const cfg = tmpDir();
  for (const input of ['isto não é json', '', 'null', '{"session_id":"../../evil","hook_event_name":"Stop"}', '{"hook_event_name":"Stop"}']) {
    const r = run(input, { CLAUDE_CONFIG_DIR: cfg });
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
  }
  assert.ok(!fs.existsSync(path.join(cfg, 'evil.jsonl')));
  const events = path.join(cfg, 'didi-trace', 'events');
  assert.ok(!fs.existsSync(events) || fs.readdirSync(events).length === 0);
  assert.match(fs.readFileSync(path.join(cfg, 'didi-trace', 'errors.log'), 'utf8'), /SyntaxError/);
});

test('diretório sem permissão de escrita não causa falha', () => {
  const base = tmpDir();
  const blocker = path.join(base, 'arquivo');
  fs.writeFileSync(blocker, 'x');
  const r = run(JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }), { CLAUDE_CONFIG_DIR: path.join(blocker, 'dentro') });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('tempo de execução fica baixo', () => {
  const cfg = tmpDir();
  run('{"session_id":"w","hook_event_name":"Stop"}', { CLAUDE_CONFIG_DIR: cfg });
  const times = [];
  for (let i = 0; i < 5; i++) times.push(run('{"session_id":"w","hook_event_name":"Stop"}', { CLAUDE_CONFIG_DIR: cfg }).ms);
  times.sort((a, b) => a - b);
  console.log('# hook: mediana ' + times[2].toFixed(0) + ' ms (inclui a inicialização do Node)');
  assert.ok(times[2] < 1000);
});

test('SessionStart não inicia o servidor sem DIDI_TRACE_AUTOSTART', () => {
  const cfg = tmpDir();
  const r = run('{"session_id":"a","hook_event_name":"SessionStart"}', { CLAUDE_CONFIG_DIR: cfg, DIDI_TRACE_PORT: '1' });
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(cfg, 'didi-trace', 'server.log')));
});
