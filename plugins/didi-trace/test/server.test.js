'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createApp } = require('../server/server');
const { FIXTURES, SIMPLE, RICH, tmpDir, copyDir } = require('./helpers');

function get(port, p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function withServer(configDir, fn) {
  const app = createApp({ configDir });
  const port = await app.listen(0);
  try { await fn(port, app); } finally { await app.close(); }
}

test('escuta somente em 127.0.0.1', async () => {
  await withServer(FIXTURES, async (port, app) => {
    assert.equal(app.server.address().address, '127.0.0.1');
  });
});

test('lista sessões com projeto, primeiro prompt e estado ativo', async () => {
  await withServer(FIXTURES, async (port) => {
    const r = await get(port, '/api/sessions');
    assert.equal(r.status, 200);
    const { sessions } = JSON.parse(r.body);
    assert.equal(sessions.length, 2);
    const rich = sessions.find((s) => s.id === RICH);
    assert.equal(rich.project, '/work/demo');
    assert.equal(rich.firstPrompt, 'Corrija o bug <script>alert(1)</script> no parser');
    assert.equal(rich.hooks, true);
    assert.equal(sessions.find((s) => s.id === SIMPLE).firstPrompt, 'Liste os arquivos');
  });
});

test('prompt gigante cortado pelo limite de leitura ainda aparece resumido', async () => {
  const cfg = tmpDir();
  const dir = path.join(cfg, 'projects', '-x'); fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ type: 'user', uuid: 'u', timestamp: '2026-01-01T00:00:00Z', cwd: '/x', message: { role: 'user', content: 'Plano enorme ' + 'y'.repeat(400000) } });
  fs.writeFileSync(path.join(dir, 'big.jsonl'), line + '\n');
  await withServer(cfg, async (port) => {
    const { sessions } = JSON.parse((await get(port, '/api/sessions')).body);
    assert.match(sessions[0].firstPrompt, /^Plano enorme y+/);
    assert.ok(sessions[0].firstPrompt.length <= 200);
  });
});

test('detalhe traz transcript, subagentes, eventos e offsets', async () => {
  await withServer(FIXTURES, async (port) => {
    const d = JSON.parse((await get(port, '/api/sessions/' + RICH)).body);
    assert.ok(d.main.length > 20);
    assert.deepEqual(d.agents.map((a) => a.agentId).sort(), ['agentfile1', 'lost1']);
    assert.equal(d.agents.find((a) => a.agentId === 'agentfile1').meta.toolUseId, 'toolu_task1');
    assert.equal(d.events.length, 7);
    assert.ok(d.offsets.main > 0 && d.offsets.events > 0 && d.offsets['agent:agentfile1'] > 0);
    // a última linha incompleta do transcript fica de fora até ser terminada
    assert.ok(!d.main.some((l) => l.includes('msg_inc')));
    const tree = JSON.parse((await get(port, '/api/sessions/' + RICH + '?format=tree')).body);
    assert.equal(tree.turns.length, 2);
    assert.equal(tree.unlinkedAgents.length, 1);
  });
});

test('rejeita path traversal, ids inválidos e hosts estranhos', async () => {
  await withServer(FIXTURES, async (port) => {
    for (const p of ['/api/sessions/..%2F..%2Fetc%2Fpasswd', '/api/sessions/%2e%2e', '/api/sessions/..', '/api/sessions/a%00b', '/api/sessions/%E0%A4%A', '/api/sessions/.hidden']) {
      const r = await get(port, p);
      assert.ok(r.status === 400 || r.status === 404, p + ' -> ' + r.status);
      assert.ok(!r.body.includes('root:'));
    }
    assert.equal((await get(port, '/api/sessions/naoexiste')).status, 404);
    for (const p of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/server.js', '/public/../server.js']) {
      const r = await get(port, p);
      assert.equal(r.status, 404, p);
    }
    assert.equal((await get(port, '/', { Host: 'evil.example' })).status, 403);
    const post = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/sessions', method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(post, 405);
  });
});

test('serve a interface com CSP e sem recursos externos', async () => {
  await withServer(FIXTURES, async (port) => {
    const r = await get(port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.ok(!/https?:\/\//.test(r.body), 'o HTML não referencia URLs externas');
    for (const f of ['/app.js', '/format.js', '/transcript.js', '/styles.css']) assert.equal((await get(port, f)).status, 200);
  });
});

test('config sem projetos informa o caminho esperado', async () => {
  const cfg = tmpDir();
  await withServer(cfg, async (port) => {
    const r = JSON.parse((await get(port, '/api/sessions')).body);
    assert.deepEqual(r.sessions, []);
    assert.equal(r.projectsDir, path.join(cfg, 'projects'));
  });
});

function readSse(port, p, until, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = ''; const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block); const data = /^data: (.*)$/m.exec(block);
          if (ev && data) { events.push({ event: ev[1], data: JSON.parse(data[1]) }); if (until(events)) { req.destroy(); resolve(events); } }
        }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('SSE sem o evento esperado: ' + JSON.stringify(events).slice(0, 400))); }, timeoutMs || 5000);
  });
}

test('SSE envia apenas as linhas acrescentadas depois da conexão', async () => {
  const cfg = tmpDir(); copyDir(FIXTURES, cfg);
  const file = path.join(cfg, 'projects', '-work-demo', SIMPLE + '.jsonl');
  await withServer(cfg, async (port) => {
    const d = JSON.parse((await get(port, '/api/sessions/' + SIMPLE)).body);
    const offsets = encodeURIComponent(JSON.stringify(d.offsets));
    const pending = readSse(port, `/api/sessions/${SIMPLE}/stream?offsets=${offsets}`, (evs) => evs.some((e) => e.event === 'lines' && e.data.key === 'main'));
    await new Promise((r) => setTimeout(r, 300));
    const added = JSON.stringify({ type: 'assistant', uuid: 'novo', timestamp: '2026-01-10T10:01:00Z', message: { id: 'msg_novo', content: [{ type: 'text', text: 'linha nova' }] } });
    fs.appendFileSync(file, added.slice(0, 20));
    await new Promise((r) => setTimeout(r, 1300));
    fs.appendFileSync(file, added.slice(20) + '\n');
    const evs = await pending;
    const lines = evs.filter((e) => e.event === 'lines');
    assert.equal(lines.length, 1, 'a linha parcial não pode ser enviada antes de terminar');
    assert.deepEqual(lines[0].data.lines, [added]);
    assert.equal(lines[0].data.offset, fs.statSync(file).size);
  });
});

test('SSE descobre subagentes e eventos novos', async () => {
  const cfg = tmpDir(); copyDir(FIXTURES, cfg);
  await withServer(cfg, async (port) => {
    const d = JSON.parse((await get(port, '/api/sessions/' + SIMPLE)).body);
    const offsets = encodeURIComponent(JSON.stringify(d.offsets));
    const pending = readSse(port, `/api/sessions/${SIMPLE}/stream?offsets=${offsets}`, (evs) => evs.some((e) => e.data.kind === 'agent') && evs.some((e) => e.data.kind === 'events'));
    await new Promise((r) => setTimeout(r, 300));
    const sub = path.join(cfg, 'projects', '-work-demo', SIMPLE, 'subagents'); fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-novo1.meta.json'), JSON.stringify({ toolUseId: 'toolu_s1' }));
    fs.writeFileSync(path.join(sub, 'agent-novo1.jsonl'), '{"type":"user"}\n');
    fs.mkdirSync(path.join(cfg, 'didi-trace', 'events'), { recursive: true });
    fs.appendFileSync(path.join(cfg, 'didi-trace', 'events', SIMPLE + '.jsonl'), '{"hook_event_name":"Stop","_recv":1}\n');
    const evs = await pending;
    const agent = evs.find((e) => e.data.kind === 'agent');
    assert.equal(agent.data.agentId, 'novo1');
    assert.equal(agent.data.meta.toolUseId, 'toolu_s1');
  });
});
