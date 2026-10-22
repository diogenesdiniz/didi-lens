'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../server/public/format');

test('escapeHtml escapa os cinco caracteres perigosos', () => {
  assert.equal(F.escapeHtml('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.equal(F.escapeHtml(null), '');
});

test('highlight escapa antes de marcar e aceita metacaracteres de regex', () => {
  assert.equal(F.highlight('a <b> a.c', 'a'), '<mark>a</mark> &lt;b&gt; <mark>a</mark>.c');
  assert.equal(F.highlight('x.*y', '.*'), 'x<mark>.*</mark>y');
  assert.equal(F.highlight('<script>', 'script'), '&lt;<mark>script</mark>&gt;');
});

test('renderMarkdown nunca deixa HTML do conteúdo passar', () => {
  const html = F.renderMarkdown('# t <b>\n\n<script>alert(1)</script> **negrito** `<x>`\n\n```\n<img onerror=1>\n```\n- um\n- dois\n\n[ok](https://a.com/x?a=1&b=2) [mau](javascript:alert(1))');
  assert.ok(!/<script|<img|<b>/.test(html), html);
  assert.match(html, /<strong>negrito<\/strong>/);
  assert.match(html, /<code>&lt;x&gt;<\/code>/);
  assert.match(html, /<li>um<\/li>/);
  assert.match(html, /<a href="https:\/\/a.com\/x\?a=1&amp;b=2"/);
  assert.ok(!/href="javascript/.test(html));
});

test('highlightHtml marca apenas texto, nunca dentro de tags', () => {
  assert.equal(F.highlightHtml('<a href="x">link x</a>', 'x'), '<a href="x">link <mark>x</mark></a>');
});

test('toolSummary resume cada ferramenta em uma linha', () => {
  assert.equal(F.toolSummary('Bash', { command: 'ls -la\n  /tmp' }), 'ls -la /tmp');
  assert.equal(F.toolSummary('Read', { file_path: '/a.js', offset: 10, limit: 5 }), '/a.js [10+5]');
  assert.equal(F.toolSummary('Edit', { file_path: '/a.js', old_string: 'x' }), '/a.js');
  assert.equal(F.toolSummary('Grep', { pattern: 'foo', path: '/src', glob: '*.js' }), 'foo em /src (*.js)');
  assert.equal(F.toolSummary('WebSearch', { query: 'node sse' }), 'node sse');
  assert.equal(F.toolSummary('TodoWrite', { todos: [1, 2] }), '2 tarefas');
  assert.equal(F.toolSummary('Task', { description: 'Pesquisar', prompt: 'x' }), 'Pesquisar');
  assert.equal(F.toolSummary('mcp__x__y', { repo: 'r', n: 1 }), 'repo=r');
  assert.equal(F.toolSummary('mcp__x__y', null), '');
  assert.equal(F.toolSummary('Bash', { command: 'x'.repeat(500) }).length, 240);
});

test('diffLines produz contexto, remoções e adições', () => {
  const d = F.diffLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(d.map((x) => x.type + ':' + x.text), ['ctx:a', 'del:b', 'add:B', 'ctx:c', 'add:d']);
  assert.deepEqual(F.diffLines('x', 'x').map((x) => x.type), ['ctx']);
  assert.deepEqual(F.diffLines('', 'novo').map((x) => x.type), ['del', 'add']);
});

test('formatação de tempo, contagens e bytes', () => {
  assert.equal(F.fmtDuration(250), '250 ms');
  assert.equal(F.fmtDuration(1500), '1.50 s');
  assert.equal(F.fmtDuration(125000), '2m 05s');
  assert.equal(F.fmtDuration(null), '');
  assert.equal(F.fmtCount(1500), '1.5k');
  assert.equal(F.fmtCount(2500000), '2.50M');
  assert.equal(F.fmtBytes(2048), '2.0 KB');
});
