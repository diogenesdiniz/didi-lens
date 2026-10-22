/*
 * Leitura e normalização de transcripts do Claude Code.
 *
 * Módulo puro, sem dependências: roda no Node (servidor e testes) e no navegador
 * (o front reconstrói a árvore a cada lote de linhas novas recebido por SSE).
 * Nunca lança exceção por causa do conteúdo: o que não for reconhecido vira
 * uma etapa "raw", exibida como JSON formatado.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DidiTranscript = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tipos de linha que existem no transcript mas não são etapas do workflow.
  const IGNORED_TYPES = new Set([
    'queue-operation', 'last-prompt', 'file-history-snapshot', 'atis-latch', 'attachment',
    'progress', 'permission-mode', 'mode', 'ai-title', 'custom-title', 'agent-name', 'pr-link',
  ]);
  const AGENT_TOOLS = new Set(['Task', 'Agent']);
  const NON_PROMPT_PREFIXES = ['<local-command-', '<system-reminder>', '<bash-input>', '<bash-stdout>', '<bash-stderr>'];

  function toMs(ts) {
    const n = Date.parse(ts);
    return Number.isNaN(n) ? null : n;
  }

  function parseLine(text, n) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { obj, n, text };
      return { n, text, bad: 'a linha não é um objeto JSON' };
    } catch (_) {
      return { n, text, bad: 'JSON inválido' };
    }
  }

  function parseLines(lines, prefix) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (typeof text !== 'string' || !text.trim()) continue;
      const e = parseLine(text, (prefix || '') + (i + 1));
      if (e.bad && i === lines.length - 1) e.bad += ' (possível linha incompleta)';
      out.push(e);
    }
    return out;
  }

  function resultText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((x) => {
        if (x && x.type === 'text') return String(x.text == null ? '' : x.text);
        if (x && x.type === 'image') return '[imagem]';
        return JSON.stringify(x, null, 2);
      }).join('\n');
    }
    return c == null ? '' : JSON.stringify(c, null, 2);
  }

  function rawStep(id, label, text, why, entry) {
    return { id, kind: 'raw', label, text, why, ts: entry && entry.obj ? entry.obj.timestamp : undefined, t: entry && entry.obj ? toMs(entry.obj.timestamp) : null };
  }

  function mergeUsage(map, id, usage) {
    if (!id || !usage || typeof usage !== 'object') return;
    const cur = map.get(id) || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const num = (v) => (typeof v === 'number' && v > 0 ? v : 0);
    cur.input = Math.max(cur.input, num(usage.input_tokens));
    cur.output = Math.max(cur.output, num(usage.output_tokens));
    cur.cacheRead = Math.max(cur.cacheRead, num(usage.cache_read_input_tokens));
    cur.cacheCreation = Math.max(cur.cacheCreation, num(usage.cache_creation_input_tokens));
    map.set(id, cur);
  }

  function sumUsage(map) {
    const t = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const u of map.values()) {
      t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheCreation += u.cacheCreation;
    }
    return t;
  }

  function addTokens(a, b) {
    return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation };
  }

  function isPromptText(obj, text) {
    if (obj.isMeta || obj.isCompactSummary || obj.sourceToolUseID || obj.isVisibleInTranscriptOnly) return false;
    const head = text.trimStart();
    return !NON_PROMPT_PREFIXES.some((p) => head.startsWith(p));
  }

  /**
   * Percorre as entradas de um arquivo (principal ou de subagente) e produz as etapas.
   * Para o arquivo principal devolve `turns`; para subagentes, uma lista plana em `steps`.
   */
  function walk(entries, ctx, isAgent, idPrefix) {
    const turns = [];
    const flat = [];
    let turn = null;
    let agentPrompt = null;
    const info = { cwd: null, gitBranch: null, version: null, first: null, last: null };

    const push = (step) => {
      if (isAgent) { flat.push(step); return; }
      if (!turn) {
        turn = { kind: 'turn', id: idPrefix + 'turn:0', index: 0, prompt: null, implicit: true, ts: step.ts, t: step.t, steps: [] };
        turns.push(turn);
      }
      turn.steps.push(step);
    };

    for (const e of entries) {
      if (e.bad) { push(rawStep(idPrefix + 'raw:' + e.n, 'Linha ilegível', e.text, e.bad)); continue; }
      const o = e.obj;
      const t = toMs(o.timestamp);
      if (t != null) {
        if (info.first == null || t < info.first) info.first = t;
        if (info.last == null || t > info.last) info.last = t;
      }
      if (!info.cwd && typeof o.cwd === 'string') info.cwd = o.cwd;
      if (!info.gitBranch && typeof o.gitBranch === 'string') info.gitBranch = o.gitBranch;
      if (!info.version && typeof o.version === 'string') info.version = o.version;
      const uid = o.uuid || ('l' + e.n);

      if (IGNORED_TYPES.has(o.type)) { ctx.ignored[o.type] = (ctx.ignored[o.type] || 0) + 1; continue; }

      if (o.type === 'assistant') {
        const m = o.message && typeof o.message === 'object' ? o.message : {};
        mergeUsage(ctx.usage(isAgent), m.id, m.usage);
        if (typeof m.model === 'string' && m.model && m.model[0] !== '<') ctx.models.add(m.model);
        const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
        blocks.forEach((b, i) => {
          const id = idPrefix + uid + ':' + i;
          if (!b || typeof b !== 'object') { push(rawStep(id, 'Bloco desconhecido', JSON.stringify(b), 'bloco inválido', e)); return; }
          if (b.type === 'text') {
            if (typeof b.text === 'string' && b.text.trim()) push({ id, kind: 'text', text: b.text, ts: o.timestamp, t });
          } else if (b.type === 'thinking') {
            const text = typeof b.thinking === 'string' ? b.thinking : '';
            // Raciocínio vazio costuma indicar conteúdo omitido pela API.
            push({ id, kind: 'thinking', text, ts: o.timestamp, t });
          } else if (b.type === 'tool_use') {
            const step = { id: typeof b.id === 'string' && b.id ? b.id : id, kind: 'tool', name: String(b.name || '?'), input: b.input === undefined ? {} : b.input, ts: o.timestamp, t, result: null, status: 'pending' };
            ctx.tools.set(step.id, step);
            push(step);
          } else {
            push(rawStep(id, 'Bloco ' + (b.type || 'sem tipo'), JSON.stringify(b, null, 2), 'tipo de bloco desconhecido', e));
          }
        });
        continue;
      }

      if (o.type === 'user') {
        const m = o.message && typeof o.message === 'object' ? o.message : {};
        const c = m.content;
        const blocks = Array.isArray(c) ? c : null;
        let promptText = '';
        if (typeof c === 'string') promptText = c;
        else if (blocks) {
          blocks.forEach((b, i) => {
            if (b && b.type === 'tool_result') {
              const step = ctx.tools.get(b.tool_use_id);
              const res = { text: resultText(b.content), isError: !!b.is_error, ts: o.timestamp, t };
              if (step && !step.result) {
                step.result = res;
                const tur = o.toolUseResult;
                if (tur && typeof tur === 'object' && typeof tur.agentId === 'string') step.agentId = tur.agentId;
              } else {
                push(rawStep(idPrefix + uid + ':' + i, 'Resultado sem chamada correspondente', JSON.stringify(b, null, 2), 'tool_result órfão', e));
              }
            } else if (b && b.type === 'text' && typeof b.text === 'string') {
              promptText += (promptText ? '\n' : '') + b.text;
            } else if (b && b.type === 'image') {
              promptText += (promptText ? '\n' : '') + '[imagem]';
            } else if (b && b.type !== 'tool_result') {
              push(rawStep(idPrefix + uid + ':' + i, 'Bloco ' + (b.type || 'sem tipo'), JSON.stringify(b, null, 2), 'tipo de bloco desconhecido', e));
            }
          });
        } else if (c != null) {
          push(rawStep(idPrefix + uid, 'Mensagem de usuário', JSON.stringify(c, null, 2), 'conteúdo em formato desconhecido', e));
        }
        if (!promptText.trim()) continue;
        if (isAgent && agentPrompt == null && !o.isMeta) { agentPrompt = promptText; continue; }
        if (!isAgent && isPromptText(o, promptText)) {
          turn = { kind: 'turn', id: idPrefix + 'turn:' + uid, index: turns.length, number: turns.filter((x) => !x.implicit).length + 1, prompt: promptText, ts: o.timestamp, t, steps: [] };
          turns.push(turn);
        } else if (/^\[Request interrupted/.test(promptText.trim())) {
          push({ id: idPrefix + uid, kind: 'note', label: 'Interrompido', text: promptText, ts: o.timestamp, t });
        } else {
          push({ id: idPrefix + uid, kind: 'note', label: o.isCompactSummary ? 'Resumo de compactação' : 'Mensagem do sistema', text: promptText, ts: o.timestamp, t });
        }
        continue;
      }

      if (o.type === 'system' || o.type === 'summary') {
        const text = typeof o.content === 'string' ? o.content : (typeof o.summary === 'string' ? o.summary : JSON.stringify(o, null, 2));
        push({ id: idPrefix + uid, kind: 'note', label: o.type === 'summary' ? 'Resumo' : 'Sistema' + (o.subtype ? ': ' + o.subtype : ''), text, ts: o.timestamp, t });
        continue;
      }

      push(rawStep(idPrefix + uid, 'Tipo ' + (o.type === undefined ? 'ausente' : String(o.type)), JSON.stringify(o, null, 2), 'tipo de linha desconhecido', e));
    }
    return { turns, steps: flat, agentPrompt, info };
  }

  function parseEvents(lines) {
    const out = [];
    for (const text of lines || []) {
      if (typeof text !== 'string' || !text.trim()) continue;
      try {
        const o = JSON.parse(text);
        if (!o || typeof o !== 'object') continue;
        const t = typeof o._recv === 'number' ? o._recv : toMs(o._recv);
        const name = o.hook_event_name;
        if (typeof name !== 'string' || t == null) continue;
        out.push({ t, name, p: o });
      } catch (_) { /* linha de evento corrompida: ignorada */ }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  const MARKER_EVENTS = new Set(['SessionStart', 'SessionEnd', 'PreCompact', 'PostCompact', 'Notification', 'SubagentStop']);

  function markerText(ev) {
    const p = ev.p;
    switch (ev.name) {
      case 'SessionStart': return 'Sessão iniciada' + (p.source ? ' (' + p.source + ')' : '');
      case 'SessionEnd': return 'Sessão encerrada' + (p.reason ? ' (' + p.reason + ')' : '');
      case 'PreCompact': return 'Compactação iniciada' + (p.trigger ? ' (' + p.trigger + ')' : '');
      case 'PostCompact': return 'Compactação concluída';
      case 'Notification': return 'Aguardando o usuário: ' + (p.message || p.notification_type || 'notificação');
      case 'SubagentStop': return 'Subagente encerrado' + (p.agent_type ? ' (' + p.agent_type + ')' : '');
      default: return ev.name;
    }
  }

  /**
   * Constrói a sessão normalizada.
   * @param {object} input { sessionId, main:string[], agents:[{agentId, meta, lines}], events:string[], now, active }
   */
  function buildSession(input) {
    const inp = input || {};
    const now = typeof inp.now === 'number' ? inp.now : Date.now();
    const mainEntries = parseLines(inp.main || []);
    const ctx = {
      tools: new Map(),
      models: new Set(),
      ignored: {},
      mainUsage: new Map(),
      agentUsage: new Map(),
      usage(isAgent) { return isAgent ? this.agentUsage : this.mainUsage; },
    };

    // Separa sidechains gravadas no próprio arquivo principal.
    const mainOnly = [];
    const sidechain = [];
    for (const e of mainEntries) (e.obj && e.obj.isSidechain === true ? sidechain : mainOnly).push(e);
    const inlineAgents = groupSidechains(sidechain);

    const main = walk(mainOnly, ctx, false, '');

    const agentInputs = [];
    for (const a of inp.agents || []) {
      if (!a || typeof a.agentId !== 'string') continue;
      agentInputs.push({ agentId: a.agentId, meta: a.meta && typeof a.meta === 'object' ? a.meta : {}, entries: parseLines(a.lines || [], a.agentId + ':') });
    }
    for (const a of inlineAgents) agentInputs.push(a);

    const agents = agentInputs.map((a) => {
      const w = walk(a.entries, ctx, true, a.agentId + '/');
      return {
        agentId: a.agentId, meta: a.meta, steps: w.steps, prompt: w.agentPrompt, info: w.info,
        agentType: typeof a.meta.agentType === 'string' ? a.meta.agentType : null,
        description: typeof a.meta.description === 'string' ? a.meta.description : null,
        linked: false,
      };
    });

    const unlinkedAgents = linkAgents(agents, ctx.tools);

    const events = parseEvents(inp.events);
    const live = applyEvents(ctx.tools, events, now, !!inp.active);
    const allSteps = [];
    const collect = (steps) => { for (const s of steps) { allSteps.push(s); if (s.agent) collect(s.agent.steps); } };
    for (const t of main.turns) collect(t.steps);
    for (const a of unlinkedAgents) collect(a.steps);
    for (const s of allSteps) if (s.kind === 'tool') finishTool(s, live, !!inp.active);

    insertMarkers(main.turns, events);

    const toolSteps = allSteps.filter((s) => s.kind === 'tool');
    const mainTokens = sumUsage(ctx.mainUsage);
    const agentTokens = sumUsage(ctx.agentUsage);
    const times = [main.info.first, main.info.last];
    for (const a of agents) times.push(a.info.first, a.info.last);
    for (const ev of events) times.push(ev.t);
    const valid = times.filter((x) => x != null);
    const startedAt = valid.length ? Math.min(...valid) : null;
    const endedAt = valid.length ? Math.max(...valid) : null;

    return {
      id: inp.sessionId || null,
      cwd: main.info.cwd || (agents.find((a) => a.info.cwd) || { info: {} }).info.cwd || null,
      gitBranch: main.info.gitBranch || null,
      version: main.info.version || null,
      models: Array.from(ctx.models),
      startedAt, endedAt,
      durationMs: startedAt != null ? endedAt - startedAt : null,
      turns: main.turns,
      unlinkedAgents: unlinkedAgents.map(toAgentView),
      live,
      ignored: ctx.ignored,
      stats: {
        toolCalls: toolSteps.length,
        errors: toolSteps.filter((s) => s.status === 'error').length,
        agents: agents.length,
        turns: main.turns.filter((t) => !t.implicit).length,
        tokens: addTokens(mainTokens, agentTokens),
        mainTokens, agentTokens,
      },
    };
  }

  function toAgentView(a) {
    return { agentId: a.agentId, agentType: a.agentType, description: a.description, prompt: a.prompt, steps: a.steps };
  }

  function groupSidechains(entries) {
    if (!entries.length) return [];
    const byUuid = new Map();
    for (const e of entries) if (e.obj.uuid) byUuid.set(e.obj.uuid, e);
    const groups = new Map();
    for (const e of entries) {
      let key = e.obj.agentId;
      if (!key) {
        let cur = e; const seen = new Set();
        while (cur.obj.parentUuid && byUuid.has(cur.obj.parentUuid) && !seen.has(cur.obj.uuid)) { seen.add(cur.obj.uuid); cur = byUuid.get(cur.obj.parentUuid); }
        key = 'sidechain-' + String(cur.obj.uuid || cur.n).slice(0, 8);
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    return Array.from(groups, ([agentId, entriesOf]) => ({ agentId, meta: {}, entries: entriesOf }));
  }

  function linkAgents(agents, tools) {
    const unlinked = [];
    const byAgentId = new Map();
    const agentToolsWithoutAgent = [];
    for (const s of tools.values()) {
      if (s.agentId) byAgentId.set(s.agentId, s);
      if (AGENT_TOOLS.has(s.name)) agentToolsWithoutAgent.push(s);
    }
    const attach = (a, step) => {
      a.linked = true;
      a.agentType = a.agentType || (step.input && step.input.subagent_type) || null;
      a.description = a.description || (step.input && step.input.description) || null;
      step.agent = toAgentView(a);
    };
    for (const a of agents) {
      let step = null;
      if (typeof a.meta.toolUseId === 'string') step = tools.get(a.meta.toolUseId) || null;
      if (!step) step = byAgentId.get(a.agentId) || null;
      if (!step && a.prompt) {
        const want = a.prompt.trim();
        step = agentToolsWithoutAgent.find((s) => !s.agent && s.input && typeof s.input.prompt === 'string' && s.input.prompt.trim() === want) || null;
      }
      if (step && !step.agent) attach(a, step);
      else unlinked.push(a);
    }
    return unlinked;
  }

  function applyEvents(tools, events, now, active) {
    const pre = new Map(); const post = new Map(); const failed = new Set();
    const open = []; // ids de PreToolUse ainda sem desfecho, na ordem
    const waiting = new Set();
    const notifications = [];
    let ended = false; let lastEventT = null; let lastEvent = null;
    for (const ev of events) {
      lastEventT = ev.t; lastEvent = ev.name;
      const id = ev.p.tool_use_id;
      if (ev.name === 'PreToolUse' && id) { pre.set(id, ev.t); open.push(id); }
      else if ((ev.name === 'PostToolUse' || ev.name === 'PostToolUseFailure') && id) {
        post.set(id, ev.t);
        if (ev.name === 'PostToolUseFailure') failed.add(id);
        const i = open.indexOf(id); if (i >= 0) open.splice(i, 1);
        waiting.delete(id);
      } else if (ev.name === 'PermissionRequest' || ev.name === 'Notification') {
        const target = id && !post.has(id) ? id : open[open.length - 1];
        if (ev.name === 'PermissionRequest' || /permission|aguard|waiting|needs your/i.test(String(ev.p.notification_type || '') + ' ' + String(ev.p.message || ''))) {
          if (target) waiting.add(target);
        }
        if (ev.name === 'Notification') notifications.push({ t: ev.t, message: ev.p.message || '' });
      } else if (ev.name === 'SessionEnd') ended = true;
      else if (ev.name === 'SessionStart') ended = false;
    }
    return { pre, post, failed, waiting, notifications, ended, lastEvent, lastEventT, hasEvents: events.length > 0, now, active };
  }

  function finishTool(s, live, active) {
    const pre = live.pre.get(s.id); const post = live.post.get(s.id);
    if (pre != null) s.startedAt = pre;
    else s.startedAt = s.t;
    if (s.result) {
      s.status = s.result.isError || live.failed.has(s.id) ? 'error' : 'done';
      s.endedAt = post != null ? post : s.result.t;
    } else if (post != null) {
      s.status = live.failed.has(s.id) ? 'error' : 'done';
      s.endedAt = post;
    } else if (live.waiting.has(s.id) && !live.ended) {
      s.status = 'waiting';
    } else if (live.hasEvents ? (pre != null && !live.ended && active) : active) {
      s.status = 'running';
    } else {
      s.status = 'incomplete';
    }
    s.durationMs = s.endedAt != null && s.startedAt != null ? Math.max(0, s.endedAt - s.startedAt) : null;
  }

  function insertMarkers(turns, events) {
    const markers = events.filter((e) => MARKER_EVENTS.has(e.name));
    if (!markers.length) return;
    if (!turns.length) turns.push({ kind: 'turn', id: 'turn:0', index: 0, prompt: null, implicit: true, ts: null, t: markers[0].t, steps: [] });
    for (const ev of markers) {
      let target = turns[0];
      for (const t of turns) if (t.t != null && t.t <= ev.t) target = t;
      const step = { id: 'marker:' + ev.name + ':' + ev.t, kind: 'marker', event: ev.name, text: markerText(ev), t: ev.t, ts: new Date(ev.t).toISOString() };
      // mantém a ordem cronológica dentro do turno
      const at = target.steps.findIndex((x) => x.t != null && x.t > ev.t);
      target.steps.splice(at < 0 ? target.steps.length : at, 0, step);
    }
  }

  return { buildSession };
});
