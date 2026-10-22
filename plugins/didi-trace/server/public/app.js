/* Interface do dashboard didi-trace. Todo texto vindo do transcript entra no DOM via textContent ou via F.escapeHtml/F.highlight. */
(function () {
  'use strict';
  const F = window.DidiFormat;
  const T = window.DidiTranscript;
  const BIG_TEXT = 400000;
  const STATUS_TEXT = { error: 'erro', running: 'executando', waiting: 'aguardando', incomplete: 'sem resultado' };

  const S = {
    sessions: [], projectsDir: '', sessionId: null, raw: null, offsets: {}, tree: null, active: false,
    index: new Map(), order: [], vis: new Map(), defaultTurns: new Set(),
    state: new Map(), forced: new Set(), full: new Set(),
    filters: { text: true, thinking: true, tool: true, errors: false },
    query: '', hits: [], hitIndex: -1, follow: false, tab: 'sessions', sessionFilter: '',
    es: null, esTimer: null, focusId: null, loading: false, error: null,
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const k of Object.keys(props || {})) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  }

  function store(key, value) {
    try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (_) { /* armazenamento indisponível */ }
    return null;
  }

  // ---------- árvore e índice ----------

  function childrenOf(step) {
    if (step.kind === 'turn' || step.kind === 'agent') return step.steps;
    if (step.kind === 'tool' && step.agent) return step.agent.steps;
    return [];
  }

  function turnsOf(tree) {
    const turns = tree.turns.slice();
    if (tree.unlinkedAgents.length) {
      turns.push({
        kind: 'turn', id: 'unlinked', index: turns.length, prompt: null, synthetic: true,
        steps: tree.unlinkedAgents.map((a) => Object.assign({ kind: 'agent', id: 'agent:' + a.agentId, t: a.steps.length ? a.steps[0].t : null }, a)),
      });
    }
    return turns;
  }

  function buildIndex() {
    S.index = new Map(); S.order = [];
    const turns = turnsOf(S.tree);
    S.turns = turns;
    const visit = (step, parent, depth) => {
      const info = { step, parent, depth, last: step.t || null };
      S.index.set(step.id, info);
      S.order.push(step.id);
      for (const c of childrenOf(step)) {
        const ci = visit(c, step.id, depth + 1);
        const end = c.endedAt || ci.last;
        if (end && (!info.last || end > info.last)) info.last = end;
      }
      return info;
    };
    for (const t of turns) visit(t, null, 1);
    const real = S.tree.turns;
    S.defaultTurns = new Set(real.length <= 3 ? real.map((t) => t.id) : real.slice(-2).map((t) => t.id));
  }

  function kindPasses(step) {
    const f = S.filters;
    if (f.errors) return step.kind === 'tool' && step.status === 'error';
    if (step.kind === 'text') return f.text;
    if (step.kind === 'thinking') return f.thinking;
    if (step.kind === 'tool' || step.kind === 'agent') return f.tool;
    return true;
  }

  function computeVisibility() {
    S.vis = new Map();
    const calc = (step) => {
      let kids = false;
      for (const c of childrenOf(step)) if (calc(c)) kids = true;
      const v = step.kind === 'turn' ? (!S.filters.errors || kids) : (kindPasses(step) || kids);
      S.vis.set(step.id, v);
      return v;
    };
    for (const t of S.turns) calc(t);
  }

  function isOpen(step) {
    if (S.forced.has(step.id)) return true;
    if (S.state.has(step.id)) return S.state.get(step.id);
    if (step.kind === 'turn') return S.defaultTurns.has(step.id);
    return step.kind === 'text';
  }

  function ownText(step) {
    switch (step.kind) {
      case 'turn': return step.prompt || '';
      case 'tool': return step.name + ' ' + JSON.stringify(step.input) + ' ' + (step.result ? step.result.text : '');
      case 'agent': return (step.description || '') + ' ' + (step.prompt || '');
      default: return (step.label || '') + ' ' + (step.text || '');
    }
  }

  function copyTextOf(step) {
    if (step.kind === 'tool') {
      return step.name + '\n\nEntrada:\n' + JSON.stringify(step.input, null, 2) + '\n\nSaída:\n' + (step.result ? step.result.text : '(sem resultado)');
    }
    if (step.kind === 'turn') return step.prompt || '';
    if (step.kind === 'agent') return step.prompt || '';
    return step.text || '';
  }

  // ---------- dados ----------

  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function loadSessions() {
    try {
      const d = await getJson('/api/sessions');
      S.sessions = d.sessions; S.projectsDir = d.projectsDir; S.error = null;
    } catch (err) {
      S.error = 'Não foi possível listar as sessões (' + err.message + ').';
    }
    renderSessions();
    if (!S.sessionId) renderEmpty();
  }

  async function openSession(id, nodeId) {
    closeStream();
    S.sessionId = id; S.loading = true; S.tree = null; S.error = null;
    S.state = new Map(); S.forced = new Set(); S.full = new Set(); S.hits = []; S.hitIndex = -1; S.focusId = null;
    $('toolbar').hidden = false;
    renderEmpty();
    try {
      const raw = await getJson('/api/sessions/' + encodeURIComponent(id));
      if (S.sessionId !== id) return;
      S.raw = { main: raw.main, events: raw.events, agents: new Map(raw.agents.map((a) => [a.agentId, a])) };
      S.offsets = raw.offsets; S.active = raw.active;
      S.follow = raw.active; $('f-follow').checked = S.follow;
      store('didi-trace:last', id);
    } catch (err) {
      S.loading = false;
      S.error = 'Não foi possível abrir a sessão ' + id + ' (' + err.message + ').';
      renderEmpty(); renderSessions();
      return;
    }
    S.loading = false;
    rebuild();
    setTab('outline');
    renderSessions();
    if (nodeId && S.index.has(nodeId)) reveal(nodeId);
    else if (S.follow) scrollToEnd();
    connectStream();
  }

  let lastBuildMs = 0; let lastBuildAt = 0; let rebuildTimer = null;

  function rebuild() {
    const t0 = performance.now();
    S.tree = T.buildSession({
      sessionId: S.sessionId, main: S.raw.main, events: S.raw.events, active: S.active, now: Date.now(),
      agents: Array.from(S.raw.agents.values()),
    });
    buildIndex();
    computeVisibility();
    computeHits();
    render();
    lastBuildMs = performance.now() - t0; lastBuildAt = performance.now();
  }

  function scheduleRebuild() {
    if (rebuildTimer) return;
    const wait = Math.max(0, Math.max(300, lastBuildMs * 3) - (performance.now() - lastBuildAt));
    rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuild(); if (S.follow) scrollToEnd(); }, wait);
  }

  function connectStream() {
    closeStream();
    const id = S.sessionId;
    const es = new EventSource('/api/sessions/' + encodeURIComponent(id) + '/stream?offsets=' + encodeURIComponent(JSON.stringify(S.offsets)));
    S.es = es;
    es.onopen = () => setConn('ao vivo', false);
    es.addEventListener('lines', (ev) => {
      const d = JSON.parse(ev.data);
      S.offsets[d.key] = d.offset;
      if (d.kind === 'main') S.raw.main.push(...d.lines);
      else if (d.kind === 'events') S.raw.events.push(...d.lines);
      else {
        let a = S.raw.agents.get(d.agentId);
        if (!a) { a = { agentId: d.agentId, meta: d.meta || {}, lines: [] }; S.raw.agents.set(d.agentId, a); }
        a.meta = d.meta || a.meta;
        a.lines.push(...d.lines);
      }
      scheduleRebuild();
    });
    es.addEventListener('meta', (ev) => {
      const d = JSON.parse(ev.data); const a = S.raw.agents.get(d.agentId);
      if (a) { a.meta = d.meta; scheduleRebuild(); }
    });
    es.addEventListener('status', (ev) => { S.active = JSON.parse(ev.data).active; scheduleRebuild(); });
    es.addEventListener('reset', () => openSession(id));
    es.onerror = () => {
      es.close();
      setConn('desconectado, tentando de novo…', true);
      S.esTimer = setTimeout(() => { if (S.sessionId === id) connectStream(); }, 2000);
    };
  }

  function closeStream() {
    if (S.es) S.es.close();
    clearTimeout(S.esTimer); clearTimeout(rebuildTimer); rebuildTimer = null;
    S.es = null;
    setConn('', false);
  }

  function setConn(text, bad) {
    const c = $('conn'); c.textContent = text; c.className = bad ? 'bad' : '';
  }

  // ---------- renderização: lateral ----------

  function renderSessions() {
    const box = $('sessions'); box.textContent = '';
    if (S.error && !S.sessions.length) { box.append(el('div', { class: 'side-msg', text: S.error })); return; }
    if (!S.sessions.length) {
      box.append(el('div', { class: 'side-msg', html: 'Nenhuma sessão encontrada em <code>' + F.escapeHtml(S.projectsDir) + '</code>. Verifique <code>CLAUDE_CONFIG_DIR</code>.' }));
      return;
    }
    const q = S.sessionFilter.toLowerCase();
    const groups = new Map();
    for (const s of S.sessions) {
      if (q && !(`${s.project} ${s.firstPrompt || ''} ${s.id} ${s.gitBranch || ''}`.toLowerCase().includes(q))) continue;
      if (!groups.has(s.project)) groups.set(s.project, []);
      groups.get(s.project).push(s);
    }
    if (!groups.size) { box.append(el('div', { class: 'side-msg', text: 'Nenhuma sessão corresponde ao filtro.' })); return; }
    for (const [project, list] of groups) {
      box.append(el('div', { class: 'proj', text: project }));
      for (const s of list) {
        const meta = el('span', { class: 'm' });
        if (s.active) meta.append(el('span', { class: 'on', text: 'ativa' }), ' · ');
        meta.append(F.fmtDateTime(Date.parse(s.lastActivity)) + (s.gitBranch ? ' · ' + s.gitBranch : ''));
        box.append(el('button', {
          type: 'button', class: 'sess', 'aria-current': s.id === S.sessionId ? 'true' : null, title: s.id,
          onclick: () => { location.hash = s.id; },
        }, el('span', { class: 'p', text: s.firstPrompt || '(sem prompt)' }), meta));
      }
    }
  }

  function setTab(tab) {
    S.tab = tab;
    $('tab-sessions').setAttribute('aria-selected', String(tab === 'sessions'));
    $('tab-outline').setAttribute('aria-selected', String(tab === 'outline'));
    $('pane-sessions').hidden = tab !== 'sessions';
    $('pane-outline').hidden = tab !== 'outline';
  }

  function renderOutline() {
    const box = $('pane-outline'); box.textContent = '';
    if (!S.tree) { box.append(el('div', { class: 'side-msg', text: 'Abra uma sessão para ver o sumário.' })); return; }
    const item = (step, depth, label, num) => {
      const b = el('button', {
        type: 'button', class: 'ol' + (step.kind === 'turn' ? '' : ' agent'), 'data-ol': step.id, title: label, onclick: () => reveal(step.id),
      }, num ? el('span', { class: 'n', text: num }) : null, label);
      b.style.paddingLeft = (8 + depth * 12) + 'px';
      return b;
    };
    const agentsIn = (steps, depth) => {
      for (const s of steps) {
        if ((s.kind === 'tool' && s.agent) || s.kind === 'agent') {
          const a = s.agent || s;
          box.append(item(s, depth, F.oneLine((a.agentType || 'subagente') + ': ' + (a.description || s.description || a.prompt || ''), 80)));
          agentsIn(childrenOf(s), depth + 1);
        }
      }
    };
    for (const t of S.turns) {
      if (!S.vis.get(t.id)) continue;
      const label = t.synthetic ? 'Subagentes sem vínculo' : (t.implicit ? 'Início da sessão' : F.oneLine(t.prompt, 80));
      box.append(item(t, 0, label, t.synthetic || t.implicit ? '' : String(t.number)));
      agentsIn(t.steps, 1);
    }
  }

  function renderEmpty() {
    const e = $('empty');
    if (S.loading) e.textContent = 'Carregando sessão…';
    else if (S.error) e.textContent = S.error;
    else if (!S.sessionId) {
      e.innerHTML = S.sessions.length ? 'Escolha uma sessão na lista à esquerda.' : 'Nenhuma sessão encontrada em <code>' + F.escapeHtml(S.projectsDir || '~/.claude/projects') + '</code>. Verifique <code>CLAUDE_CONFIG_DIR</code>.';
    } else e.textContent = '';
    if (!S.sessionId || S.loading || S.error) { $('head').textContent = ''; $('timeline').textContent = ''; $('crumbs').hidden = true; }
  }

  // ---------- renderização: sessão ----------

  function renderHead() {
    const t = S.tree; const head = $('head'); head.textContent = '';
    const meta = S.sessions.find((s) => s.id === S.sessionId);
    head.append(el('h1', { text: t.cwd || (meta && meta.project) || S.sessionId }));
    const dl = el('dl');
    const add = (k, v, title) => dl.append(el('div', { title }, el('dt', { text: k }), el('dd', { text: v })));
    add('sessão', S.sessionId);
    if (t.gitBranch) add('branch', t.gitBranch);
    if (t.models.length) add('modelo', t.models.join(', '));
    add('duração', F.fmtDuration(t.durationMs) || '—');
    add('turnos', String(t.stats.turns));
    add('ferramentas', String(t.stats.toolCalls));
    add('erros', String(t.stats.errors));
    add('subagentes', String(t.stats.agents));
    const k = t.stats.tokens;
    const a = t.stats.agentTokens;
    add('entrada', F.fmtCount(k.input), 'inclui subagentes: ' + F.fmtCount(a.input));
    add('saída', F.fmtCount(k.output), 'inclui subagentes: ' + F.fmtCount(a.output));
    add('cache leitura', F.fmtCount(k.cacheRead), 'inclui subagentes: ' + F.fmtCount(a.cacheRead));
    add('cache criação', F.fmtCount(k.cacheCreation), 'inclui subagentes: ' + F.fmtCount(a.cacheCreation));
    add('estado', S.active ? 'ativa' : 'inativa');
    head.append(dl);
    if (!t.live.hasEvents) {
      head.append(el('div', { class: 'note', text: 'Sem eventos de hook para esta sessão: durações e estados ao vivo são aproximados a partir do transcript.' }));
    }
  }

  function currentFocusId() {
    const a = document.activeElement;
    const n = a && a.closest ? a.closest('.node') : null;
    return n ? n.dataset.id : S.focusId;
  }

  function render() {
    if (!S.tree) { renderEmpty(); return; }
    $('empty').textContent = '';
    const focusId = currentFocusId();
    const hadFocus = document.activeElement && document.activeElement.closest && document.activeElement.closest('#timeline');
    renderHead();
    const tl = $('timeline'); tl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const t of S.turns) if (S.vis.get(t.id)) frag.append(renderNode(t, 1));
    tl.append(frag);
    if (!tl.firstChild) $('empty').textContent = S.filters.errors ? 'Nenhum erro nesta sessão.' : 'Esta sessão ainda não tem etapas.';
    const target = (focusId && tl.querySelector('[data-id="' + cssEscape(focusId) + '"]')) || tl.querySelector('.node');
    if (target) { target.tabIndex = 0; if (hadFocus) target.focus({ preventScroll: true }); }
    renderOutline();
    updateCount();
    spy();
  }

  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }

  function rowFor(step, open, expandable) {
    let label = ''; let sum = ''; let st = ''; let dur = '';
    let time = step.t;
    switch (step.kind) {
      case 'turn':
        label = step.synthetic ? 'sem vínculo' : (step.implicit ? 'início' : 'turno ' + step.number);
        sum = step.synthetic ? 'subagentes que não puderam ser ligados a uma chamada' : F.oneLine(step.prompt || '', 300);
        { const info = S.index.get(step.id); const first = step.t || (step.steps.find((x) => x.t) || {}).t; time = first; if (first && info.last && !step.synthetic) dur = F.fmtDuration(info.last - first); }
        break;
      case 'text': label = 'texto'; sum = F.oneLine(step.text, 300); break;
      case 'thinking': label = 'raciocínio'; sum = F.oneLine(step.text, 300) || '(conteúdo não registrado)'; break;
      case 'tool': {
        label = step.name;
        const a = step.agent;
        sum = (a && a.agentType ? '[' + a.agentType + '] ' : '') + F.toolSummary(step.name, step.input);
        st = STATUS_TEXT[step.status] || '';
        dur = F.fmtDuration(step.durationMs);
        break;
      }
      case 'agent': label = 'subagente'; sum = (step.agentType ? '[' + step.agentType + '] ' : '') + F.oneLine(step.description || step.prompt || step.agentId, 240); break;
      case 'marker': label = 'evento'; sum = step.text; break;
      default: label = step.label || step.kind; sum = F.oneLine(step.why || step.text || '', 240);
    }
    const q = S.query;
    return el('div', { class: 'row' },
      el('span', { class: 'caret', 'aria-hidden': 'true', text: expandable ? (open ? '▾' : '▸') : '' }),
      el('span', { class: 'time', title: step.ts || '', text: F.fmtTime(time) }),
      el('span', { class: 'dur', text: dur }),
      el('span', { class: 'st', text: st }),
      el('span', { class: 'label', title: label, text: label }),
      el('span', { class: 'sum', title: sum, html: F.highlight(sum, q) }),
      el('span', { class: 'actions' }, el('button', { type: 'button', 'data-act': 'link', tabindex: '-1', text: 'link' })));
  }

  function renderNode(step, depth) {
    const open = isOpen(step);
    const kids = childrenOf(step).filter((c) => S.vis.get(c.id));
    const expandable = step.kind !== 'marker';
    const node = el('div', {
      class: 'node kind-' + step.kind + (step.status ? ' status-' + step.status : '') + (S.hits[S.hitIndex] === step.id ? ' current-hit' : ''),
      role: 'treeitem', tabindex: '-1', 'data-id': step.id, 'aria-level': String(depth), 'aria-expanded': expandable ? String(open) : null,
    });
    node.append(rowFor(step, open, expandable));
    if (open && expandable) {
      let kidsEl = null;
      if (kids.length) {
        kidsEl = el('div', { class: 'children', role: 'group' });
        for (const c of kids) kidsEl.append(renderNode(c, depth + 1));
      }
      const body = renderBody(step, kidsEl);
      if (body) node.append(body);
      if (kidsEl && !(body && body.contains(kidsEl))) node.append(kidsEl);
    }
    return node;
  }

  // ---------- corpo dos nós ----------

  function copyButton(getText) {
    const b = el('button', { type: 'button', text: 'copiar', tabindex: '-1' });
    b.addEventListener('click', (ev) => { ev.stopPropagation(); copyToClipboard(getText()).then(() => { b.textContent = 'copiado'; setTimeout(() => { b.textContent = 'copiar'; }, 1200); }); });
    return b;
  }

  function sec(title, content, copyText) {
    return el('div', { class: 'sec' }, el('div', { class: 'h' }, el('span', { text: title }), copyText != null ? copyButton(() => copyText) : null), content);
  }

  function logBlock(id, text, cls) {
    const wrap = el('div');
    if (!text) { wrap.append(el('div', { class: 'thinking', text: '(vazio)' })); return wrap; }
    const cut = text.length > BIG_TEXT && !S.full.has(id);
    const shown = cut ? text.slice(0, BIG_TEXT) : text;
    const pre = el('pre', { class: 'log ' + (cls || '') });
    if (S.query && shown.length < 2000000) pre.innerHTML = F.highlight(shown, S.query);
    else pre.textContent = shown;
    wrap.append(pre);
    if (cut) {
      wrap.append(el('button', {
        type: 'button', class: 'more', text: 'mostrar tudo (' + F.fmtBytes(text.length) + ', exibindo ' + F.fmtBytes(BIG_TEXT) + ')',
        onclick: (ev) => { ev.stopPropagation(); S.full.add(id); render(); },
      }));
    }
    return wrap;
  }

  function kv(pairs) {
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of pairs) {
      if (v == null || v === '') continue;
      dl.append(el('dt', { text: k }), el('dd', { text: typeof v === 'string' ? v : JSON.stringify(v) }));
    }
    return dl.children.length ? dl : null;
  }

  function diffBlock(oldS, newS) {
    const lines = F.diffLines(oldS, newS);
    const box = el('div', { class: 'diff' });
    const max = 4000;
    for (const l of lines.slice(0, max)) box.append(el('div', { class: l.type, text: (l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  ') + l.text }));
    if (lines.length > max) box.append(el('div', { class: 'ctx', text: '… ' + (lines.length - max) + ' linhas omitidas' }));
    return box;
  }

  function scalarPairs(input, skip) {
    return Object.keys(input).filter((k) => !skip.includes(k) && (input[k] === null || typeof input[k] !== 'object')).map((k) => [k, input[k] === null ? 'null' : String(input[k])]);
  }

  function inputSections(step) {
    const i = step.input && typeof step.input === 'object' && !Array.isArray(step.input) ? step.input : null;
    const out = [];
    const id = step.id;
    if (!i) return [sec('Entrada', logBlock(id + ':in', JSON.stringify(step.input, null, 2)), JSON.stringify(step.input, null, 2))];
    switch (step.name) {
      case 'Bash':
        out.push(kv(scalarPairs(i, ['command'])));
        out.push(sec('Comando', logBlock(id + ':in', String(i.command || '')), String(i.command || '')));
        break;
      case 'Edit':
        out.push(kv([['arquivo', i.file_path], ['substituir todas', i.replace_all ? 'sim' : '']]));
        out.push(sec('Alteração', diffBlock(i.old_string, i.new_string)));
        break;
      case 'MultiEdit':
        out.push(kv([['arquivo', i.file_path]]));
        (Array.isArray(i.edits) ? i.edits : []).forEach((e, n) => out.push(sec('Alteração ' + (n + 1), diffBlock(e && e.old_string, e && e.new_string))));
        break;
      case 'Write':
        out.push(kv([['arquivo', i.file_path]]));
        out.push(sec('Conteúdo', logBlock(id + ':in', String(i.content == null ? '' : i.content)), String(i.content || '')));
        break;
      case 'Read':
        out.push(kv([['arquivo', i.file_path], ['a partir da linha', i.offset], ['limite de linhas', i.limit]]));
        break;
      case 'TodoWrite': {
        const box = el('div', { class: 'todo' });
        (Array.isArray(i.todos) ? i.todos : []).forEach((td) => {
          const mark = td.status === 'completed' ? '[x]' : td.status === 'in_progress' ? '[~]' : '[ ]';
          box.append(el('div', { text: mark + ' ' + (td.content || td.activeForm || '') }));
        });
        out.push(sec('Tarefas', box));
        break;
      }
      case 'Grep': case 'Glob': case 'WebFetch': case 'WebSearch':
        out.push(kv(scalarPairs(i, [])));
        break;
      case 'Task': case 'Agent':
        out.push(kv([['descrição', i.description], ['tipo', i.subagent_type]]));
        out.push(sec('Prompt enviado', logBlock(id + ':in', String(i.prompt || ''), 'wrap'), String(i.prompt || '')));
        break;
      default:
        out.push(sec('Entrada', logBlock(id + ':in', JSON.stringify(step.input, null, 2)), JSON.stringify(step.input, null, 2)));
    }
    return out.filter(Boolean);
  }

  function renderBody(step, kidsEl) {
    const body = el('div', { class: 'body' });
    switch (step.kind) {
      case 'turn':
        if (step.prompt && (step.prompt.length > 160 || step.prompt.includes('\n'))) body.append(sec('Prompt', logBlock(step.id + ':p', step.prompt, 'wrap'), step.prompt));
        else return null;
        break;
      case 'text':
        body.append(el('div', { class: 'md', html: F.highlightHtml(F.renderMarkdown(step.text), S.query) }));
        break;
      case 'thinking':
        body.append(el('div', { class: 'thinking', html: F.highlight(step.text || '(o conteúdo do raciocínio não foi registrado)', S.query) }));
        break;
      case 'tool': {
        for (const s of inputSections(step)) body.append(s);
        if (kidsEl) {
          body.append(sec('Linha do tempo do subagente' + (step.agent && step.agent.agentType ? ' (' + step.agent.agentType + ')' : ''), kidsEl));
        }
        if (step.result) {
          body.append(sec('Saída' + (step.result.isError ? ' (erro)' : ''), logBlock(step.id + ':out', step.result.text, step.result.isError ? 'err' : ''), step.result.text));
        } else {
          const msg = { running: 'Em execução…', waiting: 'Aguardando permissão do usuário.', incomplete: 'Sem resultado registrado no transcript.', pending: 'Sem resultado ainda.' }[step.status];
          body.append(el('div', { class: 'thinking', text: msg || '' }));
        }
        break;
      }
      case 'agent':
        body.append(kv([['id', step.agentId], ['tipo', step.agentType], ['descrição', step.description]]));
        if (step.prompt) body.append(sec('Prompt recebido', logBlock(step.id + ':p', step.prompt, 'wrap'), step.prompt));
        break;
      case 'raw':
        body.append(sec(step.why || 'Conteúdo bruto', logBlock(step.id + ':raw', step.text), step.text));
        break;
      default:
        body.append(logBlock(step.id + ':t', step.text || '', 'wrap'));
    }
    return body;
  }

  // ---------- interação ----------

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return; } catch (_) { /* tenta o método antigo */ }
    const ta = el('textarea');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) { /* sem clipboard */ }
    ta.remove();
  }

  function linkFor(id) { return location.origin + '/#' + S.sessionId + '/' + encodeURIComponent(id); }

  function toggle(id, force) {
    const info = S.index.get(id); if (!info) return;
    const next = force == null ? !isOpen(info.step) : force;
    if (!next) S.forced.delete(id);
    S.state.set(id, next);
    S.focusId = id;
    render();
    focusNode(id);
  }

  function focusNode(id, scroll) {
    const n = $('timeline').querySelector('[data-id="' + cssEscape(id) + '"]');
    if (!n) return null;
    for (const o of $('timeline').querySelectorAll('.node[tabindex="0"]')) o.tabIndex = -1;
    n.tabIndex = 0; n.focus({ preventScroll: !scroll });
    if (scroll) n.scrollIntoView({ block: 'center' });
    return n;
  }

  function reveal(id) {
    const info = S.index.get(id); if (!info) return;
    let p = info.parent;
    while (p) { S.state.set(p, true); p = S.index.get(p).parent; }
    S.focusId = id;
    render();
    focusNode(id, true);
    if (S.tab !== 'outline') setTab('outline');
  }

  function visibleNodes() { return Array.from($('timeline').querySelectorAll('.node')); }

  function siblingMove(node, dir) {
    const info = S.index.get(node.dataset.id); if (!info) return null;
    const list = info.parent ? childrenOf(S.index.get(info.parent).step) : S.turns;
    const ids = list.filter((s) => S.vis.get(s.id)).map((s) => s.id);
    return ids[ids.indexOf(info.step.id) + dir] || null;
  }

  function descendants(step, out) {
    out.push(step.id);
    for (const c of childrenOf(step)) descendants(c, out);
    return out;
  }

  function setSubtree(id, open) {
    const info = S.index.get(id); if (!info) return;
    for (const d of descendants(info.step, [])) { S.state.set(d, open); if (!open) S.forced.delete(d); }
    S.focusId = id; render(); focusNode(id);
  }

  function jumpError(dir) {
    const errs = S.order.filter((id) => { const s = S.index.get(id).step; return s.kind === 'tool' && s.status === 'error' && S.vis.get(id); });
    if (!errs.length) return;
    const cur = currentFocusId();
    const pos = S.order.indexOf(cur);
    let target = null;
    if (dir > 0) target = errs.find((id) => S.order.indexOf(id) > pos) || errs[0];
    else target = [...errs].reverse().find((id) => S.order.indexOf(id) < pos) || errs[errs.length - 1];
    reveal(target);
  }

  function onKey(ev) {
    const tag = ev.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if (ev.key === 'Escape') {
      if (!$('help').hidden) { $('help').hidden = true; return; }
      if (typing) { ev.target.blur(); return; }
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (typing) {
      if (ev.target.id === 'q' && ev.key === 'Enter') { ev.preventDefault(); gotoHit(ev.shiftKey ? -1 : 1); }
      return;
    }
    if (ev.key === '?') { $('help').hidden = false; $('help-close').focus(); return; }
    if (ev.key === '/') { ev.preventDefault(); $('q').focus(); $('q').select(); return; }
    if (!S.tree) return;
    if (ev.key === 'f') { setFollow(!S.follow); return; }
    if (ev.key === '.') { gotoHit(1); return; }
    if (ev.key === ',') { gotoHit(-1); return; }
    if (ev.key === 'n') { jumpError(1); return; }
    if (ev.key === 'N') { jumpError(-1); return; }
    const nodes = visibleNodes();
    if (!nodes.length) return;
    const cur = ev.target.closest && ev.target.closest('.node');
    if (!cur) {
      if (['j', 'k', 'ArrowDown', 'ArrowUp', 'g', 'G'].includes(ev.key) && !(tag === 'BUTTON')) { ev.preventDefault(); focusNode(S.focusId && S.index.has(S.focusId) ? S.focusId : nodes[0].dataset.id, true); }
      return;
    }
    const id = cur.dataset.id; const info = S.index.get(id);
    const idx = nodes.indexOf(cur);
    const go = (n) => { if (n) { S.focusId = n.dataset.id; focusNode(n.dataset.id, true); } };
    switch (ev.key) {
      case 'ArrowDown': case 'j': ev.preventDefault(); go(nodes[idx + 1]); break;
      case 'ArrowUp': case 'k': ev.preventDefault(); go(nodes[idx - 1]); break;
      case 'J': case 'K': { ev.preventDefault(); const sid = siblingMove(cur, ev.key === 'J' ? 1 : -1); if (sid) go($('timeline').querySelector('[data-id="' + cssEscape(sid) + '"]')); break; }
      case 'ArrowRight': case 'l':
        ev.preventDefault();
        if (cur.getAttribute('aria-expanded') === 'false') toggle(id, true);
        else if (cur.getAttribute('aria-expanded') === 'true') { const kid = cur.querySelector('.children > .node'); if (kid) go(kid); }
        break;
      case 'ArrowLeft': case 'h':
        ev.preventDefault();
        if (cur.getAttribute('aria-expanded') === 'true' && !S.forced.has(id)) toggle(id, false);
        else if (info.parent) go($('timeline').querySelector('[data-id="' + cssEscape(info.parent) + '"]'));
        break;
      case 'Enter': case ' ': ev.preventDefault(); if (cur.hasAttribute('aria-expanded')) toggle(id); break;
      case 'e': setSubtree(id, true); break;
      case 'c': setSubtree(id, false); break;
      case 'y': copyToClipboard(copyTextOf(info.step)); break;
      case 'g': go(nodes[0]); break;
      case 'G': go(nodes[nodes.length - 1]); break;
      default:
    }
  }

  function onTimelineClick(ev) {
    const node = ev.target.closest('.node'); if (!node) return;
    const row = ev.target.closest('.row');
    if (!row || row.parentNode !== node) return;
    const id = node.dataset.id;
    if (ev.target.closest('[data-act="link"]')) { copyToClipboard(linkFor(id)); ev.target.textContent = 'copiado'; setTimeout(() => { ev.target.textContent = 'link'; }, 1200); return; }
    if (node.hasAttribute('aria-expanded')) toggle(id);
    else { S.focusId = id; focusNode(id); }
  }

  function onFocusIn(ev) {
    const node = ev.target.closest && ev.target.closest('.node');
    if (!node || !S.sessionId) return;
    S.focusId = node.dataset.id;
    history.replaceState(null, '', '#' + S.sessionId + '/' + encodeURIComponent(node.dataset.id));
    renderCrumbs(node.dataset.id);
  }

  function renderCrumbs(id) {
    const info = S.index.get(id); const c = $('crumbs');
    if (!info) { c.hidden = true; return; }
    const parts = [];
    for (let cur = info; cur; cur = cur.parent ? S.index.get(cur.parent) : null) {
      const s = cur.step;
      parts.unshift(s.kind === 'turn' ? (s.synthetic ? 'sem vínculo' : s.implicit ? 'início' : 'turno ' + s.number)
        : s.kind === 'tool' ? s.name + (s.agent ? ' (' + (s.agent.agentType || 'subagente') + ')' : '')
          : s.kind === 'agent' ? 'subagente ' + (s.agentType || s.agentId) : (s.label || s.kind));
    }
    c.textContent = ['sessão'].concat(parts).join(' › ');
    c.hidden = false;
  }

  // ---------- busca, filtros, acompanhar ----------

  function computeHits() {
    S.hits = []; S.forced = new Set();
    if (!S.query || !S.tree) return;
    const ql = S.query.toLowerCase();
    for (const id of S.order) {
      const info = S.index.get(id);
      if (!S.vis.get(id)) continue;
      if (ownText(info.step).toLowerCase().includes(ql)) S.hits.push(id);
    }
    S.hits.forEach((id, n) => {
      if (n < 300) S.forced.add(id);
      for (let p = S.index.get(id).parent; p; p = S.index.get(p).parent) S.forced.add(p);
    });
    if (S.hitIndex >= S.hits.length) S.hitIndex = -1;
  }

  function updateCount() {
    $('q-count').textContent = S.query ? (S.hits.length ? (S.hitIndex < 0 ? S.hits.length + ' resultados' : (S.hitIndex + 1) + '/' + S.hits.length) : '0 resultados') : '';
  }

  function gotoHit(dir) {
    if (!S.hits.length) return;
    S.hitIndex = ((S.hitIndex < 0 ? (dir > 0 ? -1 : 0) : S.hitIndex) + dir + S.hits.length) % S.hits.length;
    reveal(S.hits[S.hitIndex]);
  }

  function setFollow(on) {
    S.follow = on; $('f-follow').checked = on;
    if (on) scrollToEnd();
  }

  let autoScroll = false; let lastY = 0;
  function scrollToEnd() {
    autoScroll = true;
    window.scrollTo(0, document.documentElement.scrollHeight);
    requestAnimationFrame(() => { lastY = window.scrollY; autoScroll = false; });
  }

  let spyQueued = false;
  function spy() {
    if (spyQueued) return;
    spyQueued = true;
    requestAnimationFrame(() => {
      spyQueued = false;
      let cur = null;
      for (const n of $('timeline').querySelectorAll('.node.kind-turn, .node.kind-agent, .node.kind-tool')) {
        if (n.classList.contains('kind-tool') && !S.index.get(n.dataset.id).step.agent) continue;
        if (n.getBoundingClientRect().top <= 90) cur = n.dataset.id; else break;
      }
      for (const b of $('pane-outline').querySelectorAll('.ol')) b.classList.toggle('cur', b.dataset.ol === cur);
    });
  }

  function onScroll() {
    if (!autoScroll && S.follow && window.scrollY < lastY - 2) { S.follow = false; $('f-follow').checked = false; }
    lastY = window.scrollY;
    spy();
  }

  function setAll(mode) {
    if (!S.tree) return;
    S.forced = new Set(); S.state = new Map();
    for (const id of S.order) {
      const step = S.index.get(id).step;
      if (mode === 'collapse') S.state.set(id, step.kind === 'turn');
      else if (mode === 'turns') { if (step.kind === 'turn') S.state.set(id, true); }
      else S.state.set(id, true);
    }
    render();
  }

  function parseHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    const i = h.indexOf('/');
    return i < 0 ? { id: h, node: null } : { id: h.slice(0, i), node: h.slice(i + 1) };
  }

  async function onHash() {
    const { id, node } = parseHash();
    if (!id) return;
    if (id !== S.sessionId) await openSession(id, node);
    else if (node && S.index.has(node)) reveal(node);
  }

  function init() {
    $('tab-sessions').addEventListener('click', () => setTab('sessions'));
    $('tab-outline').addEventListener('click', () => setTab('outline'));
    $('sq').addEventListener('input', (e) => { S.sessionFilter = e.target.value; renderSessions(); });
    for (const [id, key] of [['f-text', 'text'], ['f-thinking', 'thinking'], ['f-tool', 'tool'], ['f-errors', 'errors']]) {
      $(id).addEventListener('change', (e) => { S.filters[key] = e.target.checked; if (S.tree) { computeVisibility(); computeHits(); render(); } });
    }
    $('f-follow').addEventListener('change', (e) => setFollow(e.target.checked));
    $('b-collapse').addEventListener('click', () => setAll('collapse'));
    $('b-turns').addEventListener('click', () => setAll('turns'));
    $('b-expand').addEventListener('click', () => setAll('expand'));
    let qTimer = null;
    $('q').addEventListener('input', (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { S.query = e.target.value.trim(); S.hitIndex = -1; if (S.tree) { computeHits(); render(); } }, 200);
    });
    $('q-next').addEventListener('click', () => gotoHit(1));
    $('q-prev').addEventListener('click', () => gotoHit(-1));
    $('b-help').addEventListener('click', () => { $('help').hidden = false; $('help-close').focus(); });
    $('help-close').addEventListener('click', () => { $('help').hidden = true; });
    $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').hidden = true; });
    const tl = $('timeline');
    tl.addEventListener('click', onTimelineClick);
    tl.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('hashchange', onHash);
    const syncTop = () => document.documentElement.style.setProperty('--top', $('topbar').offsetHeight + 'px');
    new ResizeObserver(syncTop).observe($('topbar'));
    syncTop();
    setInterval(() => { if (!document.hidden && S.tab === 'sessions') loadSessions(); }, 4000);
    loadSessions().then(() => {
      const { id } = parseHash();
      if (id) return onHash();
      const last = store('didi-trace:last');
      if (last && S.sessions.some((s) => s.id === last)) { location.hash = last; return null; }
      return null;
    });
  }

  init();
})();
