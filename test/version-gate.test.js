'use strict';
// Unit tests for the dsh --no-open version gate in lib/index.js, plus a
// source-level check that the generated watchdog template builds its launch
// args with the runtime gate instead of a hardcoded --no-open.
//
// The gate functions are module-scope so the watchdog inlines the exact same
// code via Function.prototype.toString(); testing them here therefore tests
// exactly what the generated watchdog embeds.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

process.env.DSH_DAEMON_TEST_HOOK = '1';
const root = path.join(__dirname, '..');
delete require.cache[require.resolve(path.join(root, 'lib', 'index.js'))];
const plugin = require(path.join(root, 'lib', 'index.js'));
const gate = plugin.__test;

assert.ok(gate, 'test hook not exported (DSH_DAEMON_TEST_HOOK=1 must be set)');
assert.strictEqual(gate.DSH_NO_OPEN_MIN, '0.1.0-rc.8');

// ---- versionGte: dsh --no-open is supported from 0.1.0-rc.8 --------------
const cases = [
  // [version, min, expected]
  ['0.1.0-rc.7', '0.1.0-rc.8', false], // the broken installed pair
  ['0.1.0-rc.8', '0.1.0-rc.8', true],
  ['0.1.0-rc.8', '0.1.0-rc.7', true],
  ['0.1.0-rc.9', '0.1.0-rc.8', true],
  ['0.1.1-rc.1', '0.1.0-rc.8', true],
  ['0.1.1-rc.2', '0.1.0-rc.8', true],
  ['0.1.0', '0.1.0-rc.8', true],       // release beats any prerelease
  ['0.1.0-rc.8', '0.1.0', false],      // prerelease < release
  ['0.1.1', '0.1.0-rc.8', true],
  ['0.2.0-rc.1', '0.1.0-rc.8', true],
  ['1.0.0', '0.1.0-rc.8', true],
  [null, '0.1.0-rc.8', false],         // unknown version → conservative: skip the flag
  ['junk', '0.1.0-rc.8', false],
  ['', '0.1.0-rc.8', false],
];
for (const [v, min, want] of cases) {
  assert.strictEqual(gate.versionGte(v, min), want,
    `versionGte(${JSON.stringify(v)}, ${JSON.stringify(min)})`);
}

// ---- dshNoOpenSupported: the same comparison against the embedded minimum --
assert.strictEqual(gate.dshNoOpenSupported('0.1.0-rc.7'), false);
assert.strictEqual(gate.dshNoOpenSupported('0.1.0-rc.8'), true);
assert.strictEqual(gate.dshNoOpenSupported('0.1.1-rc.2'), true);
assert.strictEqual(gate.dshNoOpenSupported(null), false);
assert.strictEqual(gate.dshNoOpenSupported(undefined), false);

// ---- watchdog template wiring (raw source assertions) ----------------------
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
assert.ok(src.includes("const args = [currentDshBin(), \\'web\\', \\'--port\\', String(PORT)];"),
  'template should build the launch args from currentDshBin() (self-healing bin resolution)');
assert.ok(!src.includes("const args = [DSH_BIN,"),
  'template must not launch from the baked DSH_BIN directly (vanishes when pnpm moves the store dir)');
assert.ok(src.includes("args.push(\\'--no-open\\')"),
  'template should append --no-open via a conditional push');
assert.ok(!src.includes("[DSH_BIN, \\'web\\', \\'--port\\', String(PORT), \\'--no-open\\']"),
  'template must not hardcode --no-open in the args array');
assert.ok(src.includes('versionGte.toString()'),
  'template should inline the gate functions from the module-scope originals');

// Every child-process call in the generated watchdog must hide its console on
// Windows — otherwise each spawn flashes a black cmd box (Node gives detached
// children their own console window by default). Two mechanisms, per
// deepseek-harness discussion #1564: the dsh web launch gets a HIDDEN console
// (STARTF_USESHOWWINDOW + SW_HIDE via Start-Process -WindowStyle Hidden, keep
// dwCreationFlags=0 — CREATE_NO_WINDOW would break restricted-token sandbox
// children with 0xC0000142, #810), while the short-lived helper spawns use
// windowsHide (normal token, safe).
const tplStart = src.indexOf('function watchdogScript');
const tplEnd = src.indexOf('function plistContent');
assert.ok(tplStart > 0 && tplEnd > tplStart, 'template region not found in lib/index.js');
const tpl = src.slice(tplStart, tplEnd);
const spawnCalls = tpl.match(/CP\.(?:spawn|execFileSync)\([^;]*?\)/g) || [];
assert.ok(spawnCalls.length >= 7, 'expected >=7 spawn/execFileSync calls in the template, got ' + spawnCalls.length);
for (const call of spawnCalls) {
  assert.ok(call.includes('windowsHide: true'),
    'spawn/execFileSync call must set windowsHide: true (black console boxes on Windows): ' + call);
}
// The win32 web launch must use a hidden console (SW_HIDE), not windowsHide:
assert.ok(src.includes("'Start-Process -FilePath '"),
  'win32 launch should spawn via Start-Process');
assert.ok(src.includes('-WindowStyle Hidden'),
  'win32 launch should pass -WindowStyle Hidden (STARTF_USESHOWWINDOW + SW_HIDE)');
assert.ok(src.includes('0xC0000142'),
  'template comment should document why CREATE_NO_WINDOW is avoided');
// Every powershell spawn must NOT be detached: on Windows Node maps
// detached:true to DETACHED_PROCESS, which hangs Start-Process (no PID file,
// child never starts — verified empirically). This invariant applies to ALL
// powershell spawns in the template — the web-launch wrapper (launch()) and
// the openBrowser helper — not just the first one found.
const wrapperSpawns = spawnCalls.filter((c) => c.includes('powershell.exe'));
assert.ok(wrapperSpawns.length >= 1, 'powershell spawn should exist in the template');
for (const call of wrapperSpawns) {
  assert.ok(!call.includes('detached'),
    'powershell spawn must not use detached (DETACHED_PROCESS hangs Start-Process): ' + call);
}
// The win32 web log is rotated before the fresh run: Start-Process redirects
// with overwrite semantics, so the previous generation is kept as web.log.1
// (bounded: current + one previous run; previous crash output survives).
assert.ok(src.includes('Move-Item -Force'),
  'win32 launch should rotate web.log -> web.log.1 before Start-Process');
assert.ok(src.includes("WEB_LOG + \\'.1\\'"),
  'rotation target should be web.log.1');

// The `dsh web` launch must never inherit the operator's launch directory as
// its cwd. A daemon started from a git checkout / monorepo / $HOME otherwise
// hands that (possibly 100k-file) tree to the web process, where every
// relative-path scan and file watcher walks it. Both platform launches pass
// the same DSH-owned directory.
assert.ok(src.includes('const WEB_CWD = PROFILE_DIR;'),
  'template should pin the web working directory to a DSH-owned path (WEB_CWD)');
assert.ok(!src.includes("const WEB_CWD = '.'") && !src.includes('const WEB_CWD = process.cwd()'),
  'WEB_CWD must not fall back to the launch directory');
assert.ok(src.includes('FS.mkdirSync(WEB_CWD, { recursive: true })'),
  'launch should create the working directory before spawning (ENOENT otherwise)');
const cwdSpawns = spawnCalls.filter((call) => call.includes('cwd: WEB_CWD'));
assert.strictEqual(cwdSpawns.length, 2,
  'both dsh web launches (posix child + win32 powershell wrapper) must pass cwd: WEB_CWD, got ' + cwdSpawns.length);
assert.ok(cwdSpawns.some((call) => call.includes('process.execPath, args') && call.includes('detached: true')),
  'the posix dsh web launch must pass cwd: WEB_CWD');
assert.ok(cwdSpawns.some((call) => call.includes('powershell.exe') && call.includes('ps],')),
  'the win32 launch wrapper must pass cwd: WEB_CWD (Start-Process inherits it)');

console.log(`version-gate tests passed (${cases.length} versionGte cases + template wiring)`);
