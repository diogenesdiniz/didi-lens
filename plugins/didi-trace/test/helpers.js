'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures', 'config');
const SIMPLE = 'aaaaaaaa-0000-4000-8000-000000000001';
const RICH = 'bbbbbbbb-0000-4000-8000-000000000002';

function lines(file) { return fs.readFileSync(file, 'utf8').split('\n'); }

/** Lê uma sessão das fixtures no mesmo formato que o servidor entrega. */
function loadRaw(id) {
  const dir = path.join(FIXTURES, 'projects', '-work-demo');
  const out = { sessionId: id, main: lines(path.join(dir, id + '.jsonl')), agents: [], events: [] };
  const sub = path.join(dir, id, 'subagents');
  if (fs.existsSync(sub)) {
    for (const f of fs.readdirSync(sub)) {
      const m = /^agent-(.+)\.jsonl$/.exec(f);
      if (!m) continue;
      const metaFile = path.join(sub, 'agent-' + m[1] + '.meta.json');
      out.agents.push({ agentId: m[1], meta: fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {}, lines: lines(path.join(sub, f)) });
    }
  }
  const ev = path.join(FIXTURES, 'didi-trace', 'events', id + '.jsonl');
  if (fs.existsSync(ev)) out.events = lines(ev);
  return out;
}

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'didi-trace-')); }

function copyDir(from, to) { fs.cpSync(from, to, { recursive: true }); }

function allSteps(session) {
  const out = [];
  const visit = (steps) => { for (const s of steps) { out.push(s); if (s.agent) visit(s.agent.steps); if (s.kind === 'agent') visit(s.steps); } };
  for (const t of session.turns) visit(t.steps);
  for (const a of session.unlinkedAgents) visit(a.steps);
  return out;
}

module.exports = { FIXTURES, SIMPLE, RICH, loadRaw, tmpDir, copyDir, allSteps };
