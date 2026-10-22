'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp } = require('../server/server');
const { FIXTURES, RICH } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'server', 'public');

test('os arquivos JS do front têm sintaxe válida', () => {
  for (const f of fs.readdirSync(PUBLIC).filter((n) => n.endsWith('.js'))) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(PUBLIC, f)]), f);
  }
});

test('o front não usa recursos externos nem estilos inline', () => {
  for (const f of fs.readdirSync(PUBLIC)) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    assert.ok(!/(src|href)=["']https?:/.test(src), f + ' referencia recurso externo');
    assert.ok(!/@import|url\(https?:/.test(src), f + ' importa recurso externo');
  }
  assert.ok(!/\sstyle="/.test(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')));
});

test('o front não tem emojis', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
  for (const f of fs.readdirSync(PUBLIC)) assert.ok(!emoji.test(fs.readFileSync(path.join(PUBLIC, f), 'utf8')), f);
});

function loadPlaywright() {
  const candidates = ['playwright'];
  try { candidates.push(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright')); } catch (_) { /* sem npm */ }
  for (const c of candidates) { try { return require(c); } catch (_) { /* tenta o próximo */ } }
  return null;
}

const pw = loadPlaywright();

test('teste de fumaça no navegador (opcional: exige playwright e chromium já instalados)', { skip: pw ? false : 'playwright não encontrado' }, async (t) => {
  let browser;
  try { browser = await pw.chromium.launch(); } catch (err) { t.skip('chromium indisponível: ' + err.message.split('\n')[0]); return; }
  const app = createApp({ configDir: FIXTURES });
  const port = await app.listen(0);
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('.sess');
    assert.equal(await page.locator('.sess').count(), 2);
    await page.goto(`http://127.0.0.1:${port}/#${RICH}`);
    await page.waitForSelector('.node');
    await page.click('#b-expand');
    assert.equal(await page.locator('#timeline script, #timeline img').count(), 0, 'conteúdo do transcript não pode virar HTML');
    assert.match(await page.textContent('#timeline'), /<script>alert\(1\)<\/script>/);
    assert.ok((await page.locator('.diff .add').count()) > 0 && (await page.locator('.diff .del').count()) > 0);
    // teclado: ir ao primeiro erro e conferir a trilha de localização
    await page.click('#b-collapse');
    await page.keyboard.press('n');
    assert.match(await page.textContent('#crumbs'), /turno 1 › Bash/);
    assert.equal(await page.locator('.node.status-error:focus').count(), 1);
    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('.node:focus', 'aria-expanded'), 'true');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.getAttribute('.node:focus', 'aria-expanded'), 'false');
    await page.keyboard.press('ArrowLeft');
    assert.match(await page.textContent('#crumbs'), /^sessão › turno 1$/);
    // busca expande os nós que contêm a ocorrência
    await page.click('#b-collapse');
    await page.fill('#q', 'git diff');
    await page.waitForSelector('mark');
    assert.equal(await page.textContent('#q-count'), '1 resultados');
    await page.keyboard.press('Escape');
    // filtro só erros
    await page.fill('#q', '');
    await page.check('#f-errors');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.node.kind-tool').count(), 1);
    // o link do nó fica no hash e sobrevive a recarregar a página
    assert.match(page.url(), new RegExp('#' + RICH + '/'));
    await page.reload();
    await page.waitForSelector('.node');
    assert.match(await page.textContent('#head'), new RegExp(RICH));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.close(); }
});
