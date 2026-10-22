/*
 * Funções puras de formatação usadas pela interface (e testadas no Node).
 * Todo texto que vai para HTML passa por escapeHtml.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DidiFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Texto puro -> HTML escapado, com as ocorrências de `query` dentro de <mark>. */
  function highlight(text, query) {
    const s = String(text == null ? '' : text);
    if (!query) return escapeHtml(s);
    const re = new RegExp(escapeRegExp(query), 'gi');
    let out = ''; let last = 0; let m;
    while ((m = re.exec(s)) !== null) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += escapeHtml(s.slice(last, m.index)) + '<mark>' + escapeHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    return out + escapeHtml(s.slice(last));
  }

  /** Destaca `query` apenas nos trechos de texto de um HTML já escapado. */
  function highlightHtml(html, query) {
    if (!query) return html;
    const re = new RegExp(escapeRegExp(escapeHtml(query)), 'gi');
    return html.split(/(<[^>]*>)/).map((part) => (part[0] === '<' ? part : part.replace(re, (m) => '<mark>' + m + '</mark>'))).join('');
  }

  function fmtDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return '';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
    const s = Math.round(ms / 1000);
    if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
  }

  function fmtTime(t) {
    if (t == null) return '';
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDateTime(t) {
    if (t == null) return '';
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtCount(n) {
    if (n == null) return '0';
    if (n < 1000) return String(n);
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
    return (n / 1e6).toFixed(2) + 'M';
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function oneLine(s, max) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  /** Resumo de uma linha da chamada de ferramenta. */
  function toolSummary(name, input) {
    const i = input && typeof input === 'object' ? input : {};
    const str = (v) => (typeof v === 'string' ? v : '');
    let s = '';
    switch (name) {
      case 'Bash': s = str(i.command) || str(i.description); break;
      case 'Read': s = str(i.file_path) + (i.offset != null || i.limit != null ? ' [' + (i.offset != null ? i.offset : 1) + (i.limit != null ? '+' + i.limit : '') + ']' : ''); break;
      case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': s = str(i.file_path) || str(i.notebook_path); break;
      case 'Grep': s = str(i.pattern) + (i.path ? '  em ' + str(i.path) : '') + (i.glob ? '  (' + str(i.glob) + ')' : ''); break;
      case 'Glob': s = str(i.pattern) + (i.path ? '  em ' + str(i.path) : ''); break;
      case 'WebFetch': s = str(i.url); break;
      case 'WebSearch': s = str(i.query); break;
      case 'TodoWrite': s = Array.isArray(i.todos) ? i.todos.length + ' tarefas' : ''; break;
      case 'Task': case 'Agent': s = str(i.description) || str(i.subagent_type) || str(i.prompt); break;
      default: {
        for (const k of Object.keys(i)) { if (typeof i[k] === 'string' && i[k]) { s = k + '=' + i[k]; break; } }
        if (!s && Object.keys(i).length) s = JSON.stringify(i);
      }
    }
    return oneLine(s, 240);
  }

  /** Diff por linhas (LCS). Devolve [{type:'ctx'|'add'|'del', text}]. */
  function diffLines(a, b) {
    const x = String(a == null ? '' : a).split('\n');
    const y = String(b == null ? '' : b).split('\n');
    let pre = 0;
    while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
    let suf = 0;
    while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
    const xm = x.slice(pre, x.length - suf);
    const ym = y.slice(pre, y.length - suf);
    const out = x.slice(0, pre).map((text) => ({ type: 'ctx', text }));
    if (xm.length * ym.length > 4000000) {
      for (const text of xm) out.push({ type: 'del', text });
      for (const text of ym) out.push({ type: 'add', text });
    } else {
      const w = ym.length + 1;
      const dp = new Uint32Array((xm.length + 1) * w);
      for (let i = xm.length - 1; i >= 0; i--) {
        for (let j = ym.length - 1; j >= 0; j--) {
          dp[i * w + j] = xm[i] === ym[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0; let j = 0;
      while (i < xm.length && j < ym.length) {
        if (xm[i] === ym[j]) { out.push({ type: 'ctx', text: xm[i] }); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ type: 'del', text: xm[i++] });
        else out.push({ type: 'add', text: ym[j++] });
      }
      while (i < xm.length) out.push({ type: 'del', text: xm[i++] });
      while (j < ym.length) out.push({ type: 'add', text: ym[j++] });
    }
    for (const text of x.slice(x.length - suf)) out.push({ type: 'ctx', text });
    return out;
  }

  function inlineMd(escaped) {
    return escaped
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  /** Markdown básico -> HTML. Todo o texto é escapado antes de qualquer marcação. */
  function renderMarkdown(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = []; let list = null; let i = 0;
    const flushPara = () => { if (para.length) { out.push('<p>' + inlineMd(escapeHtml(para.join('\n'))) + '</p>'); para = []; } };
    const flushList = () => { if (list) { out.push('<' + list.tag + '>' + list.items.map((t) => '<li>' + inlineMd(escapeHtml(t)) + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```(.*)$/.exec(line);
      if (fence) {
        flushPara(); flushList();
        const code = []; i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push('<pre class="code"><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (h) { flushPara(); flushList(); out.push('<h' + Math.min(h[1].length + 2, 6) + '>' + inlineMd(escapeHtml(h[2])) + '</h' + Math.min(h[1].length + 2, 6) + '>'); }
      else if (li) {
        flushPara();
        const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push(li[2]);
      } else if (/^\s*>\s?/.test(line)) { flushPara(); flushList(); out.push('<blockquote>' + inlineMd(escapeHtml(line.replace(/^\s*>\s?/, ''))) + '</blockquote>'); }
      else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); }
      else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
      i++;
    }
    flushPara(); flushList();
    return out.join('\n');
  }

  return { escapeHtml, highlight, highlightHtml, fmtDuration, fmtTime, fmtDateTime, fmtCount, fmtBytes, oneLine, toolSummary, diffLines, renderMarkdown };
});
