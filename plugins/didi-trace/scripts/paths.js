'use strict';
const os = require('os');
const path = require('path');

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function dataDir() {
  return path.join(configDir(), 'didi-trace');
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

module.exports = { configDir, dataDir, SAFE_ID };
