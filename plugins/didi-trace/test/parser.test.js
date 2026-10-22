'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../server/public/transcript');
const { SIMPLE, RICH, loadRaw, allSteps } = require('./helpers');

const NOW = Date.parse('2026-01-10T10:00:40Z');
const rich = () => T.buildSession(Object.assign(loadRaw(RICH), { now: NOW, active: true }));

test('sessão simples: um turno, texto e ferramenta pareada', () => {
  const s = T.buildSession(loadRaw(SIMPLE));
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].prompt, 'Liste os arquivos');
  const kinds = s.turns[0].steps.map((x) => x.kind);
  assert.deepEqual(kinds, ['text', 'tool', 'text']);
  const tool = s.turns[0].steps[1];
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.result.text, 'a.txt\nb.txt');
  assert.equal(tool.status, 'done');
  assert.equal(s.cwd, '/work/demo');
  assert.equal(s.gitBranch, 'main');
  assert.equal(s.ignored['queue-operation'], 1);
});

test('múltiplos turnos: tool_result e mensagens de sistema não abrem turno', () => {
  const s = rich();
  assert.deepEqual(s.turns.map((t) => t.prompt), ['Corrija o bug <script>alert(1)</script> no parser', 'Segundo prompt']);
  assert.deepEqual(s.turns.map((t) => t.number), [1, 2]);
  const meta = T.buildSession({ main: [
    JSON.stringify({ type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'oi' } }),
    JSON.stringify({ type: 'user', uuid: 'b', isMeta: true, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'Caveat: ...' } }),
    JSON.stringify({ type: 'user', uuid: 'c', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: '<local-command-stdout>x</local-command-stdout>' } }),
  ] });
  assert.equal(meta.turns.length, 1);
  assert.equal(meta.turns[0].steps.length, 2);
  assert.ok(meta.turns[0].steps.every((x) => x.kind === 'note'));
});

test('tokens contados uma vez por message.id, incluindo subagentes', () => {
  const s = rich();
  // 8 mensagens principais com id distinto (msg_r1 aparece em 3 linhas) x 10/5/100/20
  assert.deepEqual(s.stats.mainTokens, { input: 80, output: 40, cacheRead: 800, cacheCreation: 160 });
  assert.equal(s.stats.agentTokens.input, 4 + 5 + 7 + 1);
  assert.equal(s.stats.tokens.input, 80 + 17);
});

test('thinking, erro, MCP e saída enorme', () => {
  const s = rich();
  const steps = allSteps(s);
  assert.ok(steps.some((x) => x.kind === 'thinking' && /ler o arquivo/.test(x.text)));
  const test_ = steps.find((x) => x.id === 'toolu_test');
  assert.equal(test_.status, 'error');
  assert.equal(test_.result.isError, true);
  assert.ok(test_.result.text.length > 5000);
  const mcp = steps.find((x) => x.name === 'mcp__github__get_file_contents');
  assert.equal(mcp.result.text, '# Readme\nsegunda parte');
  assert.equal(s.stats.errors, 1);
});

test('subagente em arquivo separado é vinculado pelo toolUseId do meta', () => {
  const s = rich();
  const task = allSteps(s).find((x) => x.id === 'toolu_task1');
  assert.ok(task.agent);
  assert.equal(task.agent.agentType, 'Explore');
  assert.deepEqual(task.agent.steps.map((x) => x.kind), ['tool', 'text']);
  assert.equal(task.agent.prompt, 'Procure usos de parse()');
});

test('subagente inline (isSidechain) é vinculado pelo prompt', () => {
  const s = rich();
  const agent = allSteps(s).find((x) => x.id === 'toolu_task2');
  assert.ok(agent.agent);
  assert.equal(agent.agent.steps[0].name, 'Bash');
  assert.equal(agent.agent.steps[0].result.text, 'diff --git a b');
});

test('subagente sem vínculo não é descartado', () => {
  const s = rich();
  assert.deepEqual(s.unlinkedAgents.map((a) => a.agentId), ['lost1']);
  assert.equal(s.unlinkedAgents[0].steps[0].text, 'Sou órfão.');
});

test('vínculo alternativo pelo agentId do toolUseResult', () => {
  const raw = loadRaw(RICH);
  raw.agents.find((a) => a.agentId === 'agentfile1').meta = {};
  const s = T.buildSession(raw);
  assert.ok(allSteps(s).find((x) => x.id === 'toolu_task1').agent);
});

test('entradas desconhecidas ou corrompidas viram etapas brutas, sem exceção', () => {
  const s = rich();
  const raws = allSteps(s).filter((x) => x.kind === 'raw');
  const whys = raws.map((x) => x.why).join('|');
  assert.match(whys, /tipo de bloco desconhecido/);
  assert.match(whys, /tipo de linha desconhecido/);
  assert.match(whys, /JSON inválido/);
  assert.match(whys, /incompleta/);
  assert.doesNotThrow(() => T.buildSession({ main: ['{', 'null', '[]', '1', '{"type":"assistant","message":5}', '{"type":"user","message":{"content":[null,1,{"type":"x"}]}}'], agents: [null, { agentId: 3 }], events: ['x', '{}'] }));
  assert.doesNotThrow(() => T.buildSession());
});

test('estados: execução, aguardando permissão e duração por eventos de hook', () => {
  const s = rich();
  const steps = allSteps(s);
  assert.equal(steps.find((x) => x.id === 'toolu_pending').status, 'waiting');
  const failed = steps.find((x) => x.id === 'toolu_test');
  assert.equal(failed.durationMs, 4000);
  assert.ok(s.live.hasEvents);
  const markers = s.turns[0].steps.filter((x) => x.kind === 'marker').map((x) => x.event);
  assert.deepEqual(markers, ['SessionStart', 'Notification']);
  assert.equal(s.turns[0].steps[0].kind, 'marker', 'o marcador de início vem antes das etapas');
});

test('sem eventos: ferramenta sem resultado depende de a sessão estar ativa', () => {
  const raw = loadRaw(RICH); raw.events = [];
  assert.equal(allSteps(T.buildSession(Object.assign({}, raw, { active: true }))).find((x) => x.id === 'toolu_pending').status, 'running');
  assert.equal(allSteps(T.buildSession(Object.assign({}, raw, { active: false }))).find((x) => x.id === 'toolu_pending').status, 'incomplete');
});

test('PreToolUse sem desfecho conta como em execução', () => {
  const raw = loadRaw(RICH);
  raw.events = [JSON.stringify({ _recv: Date.parse('2026-01-10T10:00:31Z'), hook_event_name: 'PreToolUse', tool_use_id: 'toolu_pending' })];
  const s = T.buildSession(Object.assign(raw, { active: true }));
  assert.equal(allSteps(s).find((x) => x.id === 'toolu_pending').status, 'running');
});
