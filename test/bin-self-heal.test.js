'use strict';
// Tests for the watchdog's dsh-bin self-heal: when the baked DSH_BIN (a
// resolved .pnpm hash-dir path) vanishes because pnpm moved/GC'd the store
// dir, the watchdog re-resolves the fresh entry through the stable
// pre-resolution anchor (DSH_SHIM — the pnpm sh shim or npm bin symlink)
// instead of crash-looping on MODULE_NOT_FOUND.
//
// resolveDshBinThroughShim() is module-scope in lib/index.js, inlined into
// the watchdog via Function.prototype.toString(), and tested here directly —
// so these fixtures test exactly what the generated watchdog runs. The
// incident-shaped fixture (store dir moved between install and launch) is
// the real-world failure this guards against.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

process.env.DSH_DAEMON_TEST_HOOK = '1';
const root = path.join(__dirname, '..');
delete require.cache[require.resolve(path.join(root, 'lib', 'index.js'))];
const plugin = require(path.join(root, 'lib', 'index.js'));
const { resolveDshBinThroughShim } = plugin.__test;

assert.ok(resolveDshBinThroughShim, 'test hook not exported (DSH_DAEMON_TEST_HOOK=1 must be set)');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-selfheal-'));
const BIN_JS = ['#!/usr/bin/env node', "require('../dist/cli.js').main(process.argv.slice(2));", ''].join('\n');

function storeDir(name) {
  // Mirrors pnpm's global layout: global/v11/<hash>/node_modules/.pnpm/
  // @deepseek-ai+dsh@<ver>_<peerhash>/node_modules/@deepseek-ai/dsh/lib/bin.js
  const dir = path.join(tmp, name, 'node_modules', '.pnpm',
    '@deepseek-ai+dsh@0.1.5-rc.2_e9d2d048de7c09ca8938eeb2ac06a85a',
    'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin.js'), BIN_JS);
  return dir;
}

// ---- incident replica: the store dir the shim points at still exists -------
// pnpm >= 9.15 shim with the absolute cmd-shim-target marker (the real-world
// shape on this machine: prefix 1dcc-… was GC'd, the shim now tags 2f831-…).
const liveStore = storeDir('store-live');
const pnpmShim = path.join(tmp, 'pnpm-bin');
fs.mkdirSync(pnpmShim);
const shimFile = path.join(pnpmShim, 'dsh');
fs.writeFileSync(shimFile, [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  'if [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node"  "' + path.join(liveStore, 'bin.js') + '" "$@"',
  'elif command -v node >/dev/null 2>&1; then',
  '  exec node  "' + path.join(liveStore, 'bin.js') + '" "$@"',
  'fi',
  '# cmd-shim-target=' + path.join(liveStore, 'bin.js'),
  '',
].join('\n'));
assert.strictEqual(
  resolveDshBinThroughShim(shimFile),
  fs.realpathSync(path.join(liveStore, 'bin.js')),
  'a pnpm marker shim must resolve to the live store entry');

// ---- older cmd-shim: $basedir-relative target, no marker -------------------
const oldStore = storeDir('store-old');
const oldShim = path.join(tmp, 'old-shim');
fs.mkdirSync(oldShim);
const oldShimFile = path.join(oldShim, 'dsh');
fs.writeFileSync(oldShimFile, [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  'if [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node"  "' + path.join(oldStore, 'bin.js') + '" "$@"',
  'else',
  '  exec node  "' + path.join(oldStore, 'bin.js') + '" "$@"',
  'fi',
  '',
].join('\n'));
assert.strictEqual(
  resolveDshBinThroughShim(oldShimFile),
  fs.realpathSync(path.join(oldStore, 'bin.js')),
  'an old $basedir-relative shim must resolve to the store entry');

// ---- npm layout: the anchor is a symlink to the JS entry -------------------
const npmPkg = path.join(tmp, 'npm-lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
fs.mkdirSync(npmPkg, { recursive: true });
fs.writeFileSync(path.join(npmPkg, 'bin.js'), BIN_JS);
const npmBin = path.join(tmp, 'npm-bin-dsh');
fs.symlinkSync(path.join(npmPkg, 'bin.js'), npmBin);
assert.strictEqual(
  resolveDshBinThroughShim(npmBin),
  fs.realpathSync(path.join(npmPkg, 'bin.js')),
  'an npm bin symlink must resolve through realpath to the JS entry');

// ---- Windows .cmd shim: %dp0%-relative target ------------------------------
const cmdStore = storeDir('store-cmd');
const cmdShim = path.join(tmp, 'cmd-shim-dsh');
fs.writeFileSync(cmdShim, [
  '@ECHO off',
  'SETLOCAL',
  'CALL :find_dp0',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\store-cmd\\node_modules\\.pnpm\\@deepseek-ai+dsh@0.1.5-rc.2_e9d2d048de7c09ca8938eeb2ac06a85a\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*',
  '',
].join('\r\n'));
assert.strictEqual(
  resolveDshBinThroughShim(cmdShim),
  fs.realpathSync(path.join(cmdStore, 'bin.js')),
  'a .cmd shim must resolve its %dp0%-relative target');

// ---- failure modes degrade to null (watchdog logs and keeps DSH_BIN) -------
assert.strictEqual(resolveDshBinThroughShim(path.join(tmp, 'nope')), null,
  'a missing anchor must resolve to null');
fs.writeFileSync(path.join(tmp, 'not-a-shim'), '#!/bin/sh\necho hi\n');
assert.strictEqual(resolveDshBinThroughShim(path.join(tmp, 'not-a-shim')), null,
  'a sh script with no JS target must resolve to null');
const deadTargetShim = path.join(tmp, 'dead-target-shim');
fs.writeFileSync(deadTargetShim, '# cmd-shim-target=' + path.join(tmp, 'gone', 'bin.js') + '\n');
assert.strictEqual(resolveDshBinThroughShim(deadTargetShim), null,
  'a shim whose target no longer exists must resolve to null');

// ---- watchdog template wiring ----------------------------------------------
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
const tplStart = src.indexOf('function watchdogScript');
const tplEnd = src.indexOf('function plistContent');
assert.ok(tplStart > 0 && tplEnd > tplStart, 'template region not found in lib/index.js');
const tpl = src.slice(tplStart, tplEnd);
assert.ok(tpl.includes("'const DSH_SHIM = ' + j(cfg.dshShim || '') + ';"),
  'template must bake the stable pre-resolution anchor as DSH_SHIM');
assert.ok(tpl.includes('parseShimTarget.toString()') && tpl.includes('resolveDshBinThroughShim.toString()'),
  'template must inline the shim parser and self-heal resolver from the module-scope originals');
assert.ok(tpl.includes('function currentDshBin()'),
  'template must define the cached currentDshBin() wrapper');
assert.ok(tpl.includes('FS.existsSync(DSH_BIN)'),
  'currentDshBin() must probe the baked path before trusting it');
assert.ok(tpl.includes('dsh-daemon reinstall'),
  'unresolvable anchors must log an actionable hint');
assert.ok(!tpl.includes("PATH.dirname(DSH_BIN)"),
  'version detection must not derive from the baked DSH_BIN (stale-path blind spot)');
assert.ok(tpl.includes('PATH.dirname(currentDshBin())'),
  'version detection must follow the self-healed entry');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('bin-self-heal tests passed (pnpm marker shim, $basedir shim, npm symlink, .cmd shim, failure modes, template wiring)');
