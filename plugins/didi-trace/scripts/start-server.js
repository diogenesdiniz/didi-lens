#!/usr/bin/env node
'use strict';
/*
 * Sobe o servidor do dashboard em background, de forma idempotente, e imprime a URL.
 * Uso: node start-server.js [session-id] [--quiet]
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { dataDir, SAFE_ID } = require('./paths');

const HOST = '127.0.0.1';
const port = Number(process.env.DIDI_TRACE_PORT) || 4747;
const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const sessionArg = args.find((a) => !a.startsWith('--'));
const sessionId = sessionArg && SAFE_ID.test(sessionArg) ? sessionArg : null;

function say(msg) { if (!quiet) process.stdout.write(msg + '\n'); }

/** Devolve 'ours', 'other' (porta ocupada por outro processo) ou 'free'. */
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/health', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 4096) res.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'didi-trace' ? 'ours' : 'other'); } catch (_) { resolve('other'); } });
      res.on('error', () => resolve('other'));
    });
    req.on('timeout', () => { req.destroy(); resolve('other'); });
    req.on('error', (err) => resolve(err.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

async function waitUntilUp() {
  for (let i = 0; i < 40; i++) {
    const s = await probe();
    if (s === 'ours') return true;
    await new Promise((r) => setTimeout(r, 125));
  }
  return false;
}

async function main() {
  const url = `http://${HOST}:${port}/` + (sessionId ? `#${sessionId}` : '');
  let state = await probe();
  if (state === 'other') {
    say(`A porta ${port} está ocupada por outro processo. Defina DIDI_TRACE_PORT com uma porta livre e tente de novo.`);
    process.exitCode = 1;
    return;
  }
  if (state === 'free') {
    fs.mkdirSync(dataDir(), { recursive: true });
    const log = fs.openSync(path.join(dataDir(), 'server.log'), 'a');
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env,
    });
    child.on('error', () => {});
    child.unref();
    fs.closeSync(log);
    if (!(await waitUntilUp())) {
      state = await probe();
      if (state !== 'ours') {
        say(`O servidor não respondeu em ${HOST}:${port}. Veja ${path.join(dataDir(), 'server.log')}.`);
        process.exitCode = 1;
        return;
      }
    }
    say(`Servidor do didi-trace iniciado. Abra: ${url}`);
  } else {
    say(`Servidor do didi-trace já está em execução. Abra: ${url}`);
  }
}

main().catch((err) => { say(`Erro ao iniciar o servidor: ${err.message}`); process.exitCode = 1; });
