'use strict';
// dsh-daemon: register the DeepSeek Harness web server (dsh web) as an
// auto-start, self-healing background service.
//
// Dual mode:
//   1. Static package - mount from a DSH composition row:
//        - id: dsh-daemon
//          name: '@chenkai114/dsh-daemon'
//   2. Dynamic Cordis plugin - paste THIS FILE into cordis_define code.host;
//      the sandbox supplies the `harness` global and the file ends by
//      returning the plugin object.
//
// A standalone watchdog script is generated into $DSH_HOME/daemon/watchdog.js
// and registered with launchd (macOS) or systemd/cron (Linux), so the daemon
// survives this session: dsh web starts on login, restarts after sleep/wake,
// and self-heals via /health checks every 10s.
//
// ---- dsh --no-open version gate -----------------------------------------
// `dsh web` gained default browser opening and the `--no-open` flag in
// @deepseek-ai/dsh 0.1.0-rc.8 (dsh-web-app 0.1.0-rc.8); older CLIs reject the
// flag with `unknown option '--no-open'` and exit immediately, which made the
// watchdog's restart loop useless on old dsh installs. The daemon therefore
// only passes `--no-open` when the installed dsh version supports it, and
// skips it (conservatively) when the version cannot be determined — the
// server still starts; the only cost is a possible browser tab on
// daemon-managed restarts, and pre-rc.8 dsh never opened a browser anyway.
// These functions are module-scope so the generated watchdog inlines the
// exact same logic via Function.prototype.toString() and can re-decide at
// every launch (survives dsh upgrades/downgrades without a reinstall).
const DSH_NO_OPEN_MIN = '0.1.0-rc.8';
function parseSemver(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { maj: +m[1], min: +m[2], pat: +m[3], pre: m[4] ? m[4].split('.') : [] };
}
function preGt(a, b) {
  // semver prerelease ordering: a release beats any prerelease; numeric ids
  // sort before alphanumeric ids; a shorter list beats an equal-prefix longer
  // one (e.g. 1.0.0-alpha < 1.0.0-alpha.1).
  if (a.length === 0 && b.length === 0) return false;
  if (a.length === 0) return true;
  if (b.length === 0) return false;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return +x > +y;
    if (xn) return false; // numeric < alphanumeric
    if (yn) return true;
    return x > y;
  }
  return a.length > b.length;
}
function versionGte(v, min) {
  const a = parseSemver(v), b = parseSemver(min);
  if (!a || !b) return false;
  if (a.maj !== b.maj) return a.maj > b.maj;
  if (a.min !== b.min) return a.min > b.min;
  if (a.pat !== b.pat) return a.pat > b.pat;
  return !preGt(b.pre, a.pre); // same core: a >= b iff b.pre is not greater than a.pre
}
function dshNoOpenSupported(v) { return versionGte(v, DSH_NO_OPEN_MIN); }
// ---- dsh web token auth --------------------------------------------------
// Since 0.1.2-alpha.1 (harness commit 3e24087bfa) `dsh web` prints a
// per-process launch-token URL to stdout (`dsh web: http://127.0.0.1:<port>/?token=...`);
// a browser must visit it once to seed the 30-day host-only auth cookie
// (signing key persists across restarts, the launch token itself does not).
// The watchdog extracts that line from dsh-web.log and opens it once, so a
// --no-open launch still ends up authorized. The URL-line probe is the
// authoritative detector: the `dsh web: http://...` line has been printed by
// every dsh version (oldest included), and the ONLY difference is whether the
// URL carries `?token=` — so probing the line is stable across versions. The
// version gate only lets the watchdog skip the poll when the installed dsh is
// KNOWN to predate token auth (and even then only to save the harmless poll).
// Same module-scope + Function.prototype.toString() inlining pattern as the
// --no-open gate, so the generated watchdog re-decides at every launch.
const DSH_TOKEN_AUTH_MIN = '0.1.2-alpha.1';
function dshTokenAuthSupported(v) { return versionGte(v, DSH_TOKEN_AUTH_MIN); }
function extractTokenUrl(line, port) {
  if (typeof line !== 'string') return null;
  // Match any URL printed after `dsh web: `, then judge by ?token= presence:
  // pre-token dsh prints a bare URL, token-auth dsh prints ?token=... . The
  // URL belongs to the process we spawned, so our port is the only filter we
  // need (keeps a child process's other-port line from being picked up).
  const m = line.match(/dsh web: (http:\/\/\S+)/);
  if (!m) return null;
  const url = m[1];
  if (url.indexOf('?token=') < 0) return null; // pre-token dsh: no token
  if (port && url.indexOf(':' + port + '/') < 0) return null; // not our port
  return url;
}
// ---- pnpm global bin shims ----------------------------------------------
// `pnpm add -g` does NOT symlink package bins the way npm does; it writes a
// POSIX sh shim (a .cmd/.ps1 pair on Windows) that execs the real JS entry.
// The daemon spawns `node <DSH_BIN> web`, so an unresolved shim would have
// node execute the shim's shell code as JavaScript and die with a
// SyntaxError before dsh web ever starts. parseShimTarget() follows a shim
// to the JS file it execs: pnpm >= 9.15 tags every shim with an absolute
// `# cmd-shim-target=` comment; the older cmd-shim format quotes the target
// after the node invocation in every exec branch (relative to $basedir /
// %dp0%). Returns null when the text is not a recognizable shim (npm bins
// resolve through realpath long before this, so they never get here).
function parseShimTarget(text, shimDir) {
  if (typeof text !== 'string' || !text) return null;
  const marker = text.match(/^#\s*cmd-shim-target=(\S+)/m); // marker sits on the LAST line
  if (marker && /^(?:[A-Za-z]:)?[\\/]/.test(marker[1])) return marker[1].replace(/\\/g, '/');
  const re = /exec\s+(?:"[^"]*node[^"]*"|"%_prog%"|\bnode(?:\.exe)?)\s+"([^"]+\.js)"/g;
  let m = null;
  let hit = null;
  while ((m = re.exec(text)) !== null) hit = m[1]; // last exec branch wins
  if (!hit) {
    // Last resort: any quoted .js path (the exec regex covers every shim
    // format seen in the wild; this only catches exotic wrappers).
    const loose = text.match(/"([^"]*\.js)"/g);
    hit = loose ? loose[loose.length - 1].slice(1, -1) : null;
  }
  if (!hit) return null;
  const rel = hit.replace(/\\/g, '/').replace(/^(?:\$basedir(?:_win)?|%dp0%?|%~dp0)\//, '');
  if (/^(?:[A-Za-z]:)?\//.test(rel)) return rel;
  const dir = String(shimDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return dir ? dir + '/' + rel : null;
}
// ---- watchdog self-heal: re-resolve the dsh entry through the shim --------
// The watchdog bakes the RESOLVED dsh entry (realpath of
// …/global/vN/<hash>/node_modules/.pnpm/@deepseek-ai+dsh@<ver>_<hash>/…/lib/bin.js).
// pnpm store GC, `pnpm add -g` reinstalls and version bumps all move that
// hash dir; the baked path then vanishes and every `node <DSH_BIN> web`
// launch dies with MODULE_NOT_FOUND while the watchdog keeps restarting
// into the same wall (observed 2026-09-22: store prefix 1dcc-… GC'd to
// 2f831-…). The pre-resolution anchor (`command -v dsh` — the pnpm sh shim,
// or npm's bin symlink) is written by the package manager and survives
// those moves, so the watchdog re-runs discovery through it. Module-scope +
// Function.prototype.toString() inlining, same as the gate functions above;
// also exported via __test.
function resolveDshBinThroughShim(shimPath) {
  // Inline require (not a top-level const): under the dynamic sandbox this
  // file is evaluated where require is guarded (see currentVersion); inside
  // the generated watchdog it always resolves. Guarded for the sandbox.
  let fs = null;
  try { if (typeof require === 'function') fs = require('node:fs'); } catch (e) { return null; }
  if (!fs) return null;
  let cur = null;
  try { cur = fs.realpathSync(shimPath); } catch (e) { return null; }
  cur = String(cur).replace(/\\/g, '/');
  let text = null;
  try { text = fs.readFileSync(cur, 'utf8'); } catch (e) { return null; }
  if (/^#![^\n]*\bnode\b/.test(text)) return cur; // npm bin symlink → already the JS entry
  const target = parseShimTarget(text, cur.slice(0, cur.lastIndexOf('/')));
  if (!target) return null;
  try { return fs.realpathSync(target); } catch (e) { return null; }
}
function apply(ctx) {
  // ---- harness adapter: dynamic sandbox global vs static package ------
  const sandboxHarness = typeof harness !== 'undefined' ? harness : null;
  let defineTool;
  let registerTool;
  if (sandboxHarness) {
    defineTool = function (def) { return sandboxHarness.defineTool(def); };
    registerTool = function (def) { return sandboxHarness.registerTool(ctx, def); };
  } else {
    const toolsPkg = require('@deepseek-ai/dsh-tools');
    defineTool = toolsPkg.defineTool;
    registerTool = function (def) { return ctx.tools.register(def); };
  }
    // ------------------------------------------------------------------
    // dsh-daemon: registers the DSH web server as an auto-start, self-healing
    // background service.
    // A standalone watchdog script (generated into $DSH_HOME/daemon) health-
    // checks http://127.0.0.1:<port>/health every 10s and restarts
    // `dsh web` on 3 consecutive failures, on sleep/wake gaps, and at login
    // (LaunchAgent RunAtLoad / systemd / cron @reboot). The plugin itself
    // only registers model-callable tools; all state lives on disk so the
    // daemon survives this session.
    // ------------------------------------------------------------------
    const LABEL = 'com.deepseek-ai.dsh-watchdog';
    const SYSTEMD_UNIT = 'dsh-watchdog';
    const TASK_NAME = 'DshWatchdog';
    const DEFAULT_PORT = 3080;

    // ---- helpers -------------------------------------------------------
    // The daemon manages per-user system services (LaunchAgents, state files
    // under $DSH_HOME), so its file and command operations explicitly request
    // full access. Undefined when the deployment has no sandbox policy.
    function fullPolicy() {
      const sp = ctx.get('sandboxPolicy');
      if (sp && typeof sp.resolve === 'function') return sp.resolve({ mode: 'danger-full-access' });
      return undefined;
    }
    // dsh 0.1.x 的 shell 服务是 run(spec)；0.2.x 改名为 execute(spec) 并返回带 result() 的句柄。
    // 两个都支持，避免升级 dsh 后整个安装/重启路径炸掉（实测 0.2.1 报 shell.run is not a function）。
    async function shellExec(spec, shell) {
      const raw = typeof shell.run === 'function'
        ? await shell.run(spec)
        : (typeof shell.execute === 'function'
            ? await shell.execute(spec)
            : (() => { throw new Error('dsh-daemon: shell service exposes neither run() nor execute()') })());
      const settled = raw && typeof raw.result === 'function' ? await raw.result() : raw;
      return normalizeExecResult(settled);
    }
    // 结果形状也可能不同：{exitCode, stdout:{text}} 与 {code, stdout:'...'} 都兼容。
    function normalizeExecResult(r) {
      const toText = (v) => {
        if (v === undefined || v === null) return '';
        if (typeof v === 'string') return v;
        if (typeof v.text === 'string') return v.text;
        try { return String(v); } catch (e) { return ''; }
      };
      if (!r || typeof r !== 'object') return { exitCode: 1, stdout: { text: '' }, stderr: { text: '' } };
      const code = typeof r.exitCode === 'number' ? r.exitCode : (typeof r.code === 'number' ? r.code : 1);
      return { exitCode: code, stdout: { text: toText(r.stdout) }, stderr: { text: toText(r.stderr) } };
    }

    async function sh(command, timeoutMs, signal) {
      const shell = ctx.shell;
      if (!shell) throw new Error('shell service unavailable');
      const spec = shell.resolve({ command, timeoutMs: timeoutMs || 30000, signal, sandboxPolicy: fullPolicy() });
      const r = await shellExec(spec, shell);
      return { exitCode: r.exitCode, stdout: (r.stdout && r.stdout.text) || '', stderr: (r.stderr && r.stderr.text) || '' };
    }
    async function shOut(command, timeoutMs, signal) {
      const r = await sh(command, timeoutMs, signal);
      return (r.stdout || '').trim();
    }
    async function sleep(ms) {
      const timer = ctx.timer;
      if (timer && typeof timer.timeout === 'function') {
        try { await timer.timeout(ms); return; } catch (e) { /* fall through */ }
      }
    }
    function sq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
    // PowerShell single-quote escaping ('' doubles inside a quoted string).
    function psq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
    // Platform facts. The shell executor is bash on macOS/Linux and PowerShell
    // on Windows (the deployment disables bash-sandbox on win32), so every
    // command below is emitted per platform.
    let platformPromise = null;
    function platform() {
      if (!platformPromise) {
        platformPromise = (async () => {
          const os = await shOut('echo $env:OS', 5000);
          if (os === 'Windows_NT') return 'win';
          const u = await shOut('uname -s', 5000);
          if (u === 'Darwin') return 'mac';
          if (u === 'Linux') return 'linux';
          if (/MINGW|MSYS|CYGWIN/i.test(u)) return 'win';
          return u ? 'unknown:' + u : 'unknown';
        })();
      }
      return platformPromise;
    }
    async function isWindows() { return (await platform()) === 'win'; }
    async function homeAndDshHome() {
      const win = await isWindows();
      const home = win ? await shOut('Write-Output $HOME') : await shOut('echo $HOME');
      const dshHome = win
        ? await shOut('$d = $env:DSH_HOME; if (-not $d) { $d = Join-Path $HOME \'.dsh\' }; Write-Output $d')
        : await shOut('echo ${DSH_HOME:-$HOME/.dsh}');
      return { home, dshHome };
    }
    async function shellMkdir(...dirs) {
      if (await isWindows()) {
        await sh('New-Item -ItemType Directory -Force -Path ' + dirs.map(psq).join(',') + ' | Out-Null');
      } else {
        await sh('mkdir -p ' + dirs.map(sq).join(' '));
      }
    }
    async function shellRm(...files) {
      if (await isWindows()) {
        if (files.length) await sh('Remove-Item -Force -ErrorAction SilentlyContinue ' + files.map(psq).join(','));
      } else {
        if (files.length) await sh('rm -f ' + files.map(sq).join(' '));
      }
    }
    async function writeFile(absPath, content) {
      const fs = ctx.fs;
      if (!fs) throw new Error('fs service unavailable');
      await fs.writeText(await fs.resolve(absPath), content, undefined, undefined, fullPolicy());
    }
    async function readFileSafe(absPath) {
      try {
        const fs = ctx.fs;
        if (!fs) return null;
        return await fs.readText(await fs.resolve(absPath));
      } catch (e) { return null; }
    }
    async function existsFile(absPath) {
      try {
        const fs = ctx.fs;
        if (!fs) return false;
        return (await fs.stat(await fs.resolve(absPath))) !== undefined;
      } catch (e) { return false; }
    }
    async function dshVersionOf(dshBin) {
      // dshBin is normally the realpath of .../@deepseek-ai/dsh/lib/bin.js;
      // read the sibling package.json for the installed dsh version. Unknown
      // or unreadable → null (callers treat null as "do not pass --no-open").
      const b = String(dshBin || '').replace(/\\/g, '/');
      const cands = [];
      if (/\/bin\.js$/.test(b)) cands.push(b.replace(/\/bin\.js$/, '/package.json'));
      cands.push(b.replace(/\/[^/]+$/, '/../package.json'));
      for (const c of cands) {
        const raw = await readFileSafe(c);
        if (!raw) continue;
        try {
          const pkg = JSON.parse(raw);
          if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version;
        } catch (e) { /* try the next candidate */ }
      }
      return null;
    }
    async function pidAlive(pid) {
      if (!pid || !/^\d+$/.test(String(pid))) return false;
      const win = await isWindows();
      const r = win
        ? await sh('$p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if ($p) { exit 0 } else { exit 1 }', 5000)
        : await sh('kill -0 ' + pid + ' 2>/dev/null', 5000);
      return r.exitCode === 0;
    }
    function xmlEscape(v) {
      return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    // ---- discovery -----------------------------------------------------
    async function discover(portArg) {
      const win = await isWindows();
      const home = win
        ? await shOut('Write-Output $HOME')
        : await shOut('echo $HOME');
      if (!home) throw new Error('could not determine $HOME');
      const dshHome = win
        ? await shOut('$d = $env:DSH_HOME; if (-not $d) { $d = Join-Path $HOME \'.dsh\' }; Write-Output $d')
        : await shOut('echo ${DSH_HOME:-$HOME/.dsh}');
      let nodePath = await shOut('node -e "console.log(process.execPath)"');
      // Resolve symlinks/junctions (fnm multishell shims on Windows, nvm
      // symlinks on macOS) to the real node binary, so the daemon does not
      // pin a path that vanishes when the invoking terminal closes.
      if (nodePath) {
        try {
          const q = win ? psq(nodePath) : sq(nodePath);
          const real = await shOut('node -e "console.log(require(\'node:fs\').realpathSync(process.argv[1]))" ' + q);
          if (real) nodePath = real;
        } catch (e) { /* keep the unresolved path */ }
      }
      if (!nodePath) {
        // Fallback for a web process with a minimal PATH (launchd/systemd):
        // read the node that runs the watchdog from its process command line.
        const wpid = ((await readFileSafe(paths({ home, dshHome }).watchdogPid)) || '').trim();
        if (wpid && /^\d+$/.test(wpid)) {
          nodePath = win
            ? await shOut('(Get-Process -Id ' + wpid + ' -ErrorAction SilentlyContinue).Path')
            : await shOut('ps -o command= -p ' + wpid + ' | awk \'{print $1}\'');
        }
      }
      if (!nodePath) throw new Error('could not resolve the node executable');
      let dshBin = '';
      if (win) {
        // npm global shims on Windows are .cmd wrappers, not node scripts —
        // resolve the real package entry through the global root instead.
        const npmRoot = await shOut('$r = npm root -g 2>$null; Write-Output $r');
        const cand = npmRoot ? String(npmRoot).replace(/\\/g, '/') + '/@deepseek-ai/dsh/lib/bin.js' : '';
        if (cand && await existsFile(cand)) dshBin = cand;
        if (!dshBin) {
          const src = await shOut('(Get-Command dsh -ErrorAction SilentlyContinue).Source');
          if (src) dshBin = String(src).replace(/\\/g, '/');
        }
      } else {
        dshBin = await shOut('command -v dsh');
        if (!dshBin) {
          const npmRoot = await shOut('npm root -g 2>/dev/null');
          const cand = npmRoot ? npmRoot + '/@deepseek-ai/dsh/lib/bin.js' : '';
          if (cand && await existsFile(cand)) dshBin = cand;
        }
      }
      if (!dshBin) throw new Error('dsh CLI not found on PATH; cannot install the daemon');
      // The pre-realpath location (pnpm sh shim / npm bin symlink / .cmd) is
      // written by the package manager and stable across pnpm store GCs and
      // reinstalls; the resolved dshBin below lives in a .pnpm hash dir that
      // those moves invalidate. Baked into the watchdog as DSH_SHIM so it can
      // re-resolve DSH_BIN when the baked path vanishes
      // (resolveDshBinThroughShim).
      const dshShim = String(dshBin).replace(/\\/g, '/');
      dshBin = await shOut('node -e "console.log(require(\'node:fs\').realpathSync(process.argv[1]))" ' + sq(dshBin));
      if (!dshBin) dshBin = await shOut(win ? '(Get-Command dsh -ErrorAction SilentlyContinue).Source' : 'command -v dsh');
      if (win && dshBin) dshBin = String(dshBin).replace(/\\/g, '/');
      // pnpm-installed dsh: `command -v dsh` landed on a sh shim, and the
      // realpath above is a no-op (a shim is a regular file, not a symlink).
      // Follow the shim to the JS entry it execs so the watchdog's
      // `node <DSH_BIN>` spawns real JavaScript; also fixes version
      // detection, which reads the package.json next to bin.js. No-op for
      // npm installs (realpath already resolved the symlink) and for bins
      // that carry a node shebang themselves.
      const shimText = await readFileSafe(dshBin);
      if (shimText && !/^#![^\n]*\bnode\b/.test(shimText)) {
        const shimDir = String(dshBin).slice(0, String(dshBin).lastIndexOf('/'));
        const target = parseShimTarget(shimText, shimDir);
        if (target && await existsFile(target)) {
          const real = await shOut('node -e "console.log(require(\'node:fs\').realpathSync(process.argv[1]))" ' + sq(target));
          dshBin = String(real || target).replace(/\\/g, '/');
        }
      }
      const dshVersion = await dshVersionOf(dshBin);
      let port = DEFAULT_PORT;
      try {
        const ws = ctx.webServer;
        if (ws && typeof ws.port === 'number' && ws.port > 0 && ws.port < 65536) port = ws.port;
      } catch (e) { /* keep default */ }
      const envPort = await shOut(win ? '$env:DSH_WEB_PORT' : 'echo ${DSH_WEB_PORT:-}');
      if (envPort && /^\d+$/.test(envPort)) port = parseInt(envPort, 10);
      if (typeof portArg === 'number' && portArg > 0 && portArg < 65536) port = portArg;
      return { home, dshHome, nodePath, dshBin, dshShim, port, dshVersion };
    }
    function parseDuration(v, def) {
      if (!v) return def;
      const m = String(v).trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
      if (!m) return def;
      const n = parseInt(m[1], 10);
      const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[String(m[2] || 'ms').toLowerCase()];
      return n * mult;
    }
    /** Format a duration in ms with a human unit (d/h/m/s), e.g. 60000 → "1m", 21600000 → "6h". */
    function formatDuration(ms) {
      const units = [
        [86400000, 'd'],
        [3600000, 'h'],
        [60000, 'm'],
        [1000, 's'],
      ];
      for (const [div, label] of units) {
        const v = ms / div;
        if (v >= 1) return (Number.isInteger(v) ? v : v.toFixed(1)) + label;
      }
      return ms + 'ms';
    }
    async function envVal(name, overrides) {
      // Overrides win when provided: the dsh-daemon CLI forwards the
      // invoking shell's DSH_DAEMON_* variables through /dsh-daemon/command,
      // so `DSH_DAEMON_UPDATE_INTERVAL=1m dsh-daemon reinstall` configures
      // the watchdog with 1m even though the web process env differs.
      if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
        return String(overrides[name]);
      }
      return await shOut((await isWindows()) ? '$env:' + name : 'echo ${' + name + ':-}');
    }
    // Auto-update configuration, captured at install/reinstall time and
    // embedded into the generated watchdog script.
    async function updateConfig(overrides) {
      const vals = await Promise.all([
        envVal('DSH_DAEMON_AUTO_UPDATE', overrides),
        envVal('DSH_DAEMON_UPDATE_INTERVAL', overrides),
        envVal('DSH_DAEMON_UPDATE_MODE', overrides),
        envVal('DSH_DAEMON_QUIET_WINDOW', overrides),
        envVal('DSH_DAEMON_DEFER_MAX', overrides),
        envVal('DSH_DAEMON_NPM_REGISTRY', overrides),
        envVal('DSH_DAEMON_PROFILE', overrides),
        envVal('DSH_DAEMON_HEALTH_INTERVAL', overrides),
        envVal('DSH_DAEMON_OPEN_BROWSER', overrides),
        envVal('DSH_DAEMON_TRUSTED_HOST', overrides),
        envVal('DSH_DAEMON_STARTUP_GRACE', overrides),
      ]);
      return {
        autoUpdate: !(vals[0] === '0' || vals[0] === 'false'),
        updateIntervalMs: parseDuration(vals[1], 6 * 3600000),
        updateMode: vals[2] === 'download' ? 'download' : 'restart',
        quietWindowMs: parseDuration(vals[3], 5 * 60000),
        deferMaxMs: parseDuration(vals[4], 15 * 60000),
        npmRegistry: (vals[5] && /^https?:\/\//.test(vals[5])) ? vals[5] : 'https://registry.npmjs.org',
        profile: (vals[6] && /^[a-z0-9-]+$/.test(vals[6])) ? vals[6] : 'web',
        healthIntervalMs: parseDuration(vals[7], 10000),
        // On token-auth dsh the watchdog opens the launch-token URL in the
        // default browser once per launch to seed the 30-day cookie (default
        // on, matching manual `dsh web`); DSH_DAEMON_OPEN_BROWSER=0 keeps the
        // URL in .web-auth-url / logs only. Irrelevant for pre-token dsh.
        openBrowser: !(vals[8] === '0' || vals[8] === 'false'),
        // Reverse-proxy Host allowlist for dsh's /api browser-trust fence, captured at
        // install/reinstall time and embedded into the generated watchdog so it applies
        // however the watchdog was started (launchd, systemd, Task Scheduler, or the
        // plugin's nohup self-start, which never sees the plist's EnvironmentVariables).
        trustedHost: /^[A-Za-z0-9._,:-]*$/.test(vals[9] || '') ? (vals[9] || '') : '',
        // How long a freshly launched dsh web may take to serve /health before
        // the watchdog treats it as broken. A slow (but working) boot used to be
        // SIGKILLed after three 30s health misses, so the daemon could not start
        // a dsh web that starts fine by hand. DSH_DAEMON_STARTUP_GRACE accepts a
        // duration (90s, 5m, ...).
        startupGraceMs: parseDuration(vals[10], 5 * 60000),
      };
    }
    async function readCheckState() {
      const raw = await readFileSafe(paths(await homeAndDshHome()).updateCheck);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    function paths(cfg, profileName) {
      // Forward slashes everywhere: node, wscript and schtasks all accept them
      // on Windows, and they keep the bash-side quoting simple.
      const dir = String(cfg.dshHome + '/daemon').replace(/\\/g, '/');
      const logDir = dir + '/logs';
      return {
        dir, logDir,
        watchdogJs: dir + '/watchdog.js',
        installed: dir + '/.daemon-installed',
        portFile: dir + '/.daemon-port',
        stopped: dir + '/.daemon-stopped',
        restartLock: dir + '/.daemon-restart.lock',
        webPid: dir + '/.dsh-web.pid',
        webStarted: dir + '/.dsh-web.started',
        watchdogPid: dir + '/.dsh-watchdog.pid',
        watchdogLog: logDir + '/watchdog.log',
        webLog: logDir + '/dsh-web.log',
        webAuthUrl: dir + '/.web-auth-url',
        updateCheck: dir + '/.daemon-update-check.json',
        updatePending: dir + '/.daemon-update-pending',
        updateLock: dir + '/.daemon-update.lock',
        profilePkgJson: String(cfg.dshHome + '/profiles/' + (profileName || 'web') + '/node_modules/@chenkai114/dsh-daemon/package.json').replace(/\\/g, '/'),
        vbs: dir + '/dsh-watchdog.vbs',
        taskXml: dir + '/dsh-watchdog-task.xml',
        plist: cfg.home + '/Library/LaunchAgents/' + LABEL + '.plist',
        unitDir: cfg.home + '/.config/systemd/user',
        unit: cfg.home + '/.config/systemd/user/' + SYSTEMD_UNIT + '.service',
      };
    }

    // ---- generated watchdog script --------------------------------------
    // The package version the watchdog was generated from, embedded into the
    // script as GEN_VERSION. On plugin boot the daemon compares it against
    // the currently installed version and regenerates the watchdog when the
    // generator logic changed (e.g. Windows console handling), so an
    // auto-update never leaves a stale watchdog behind.
    let cachedVersion = null;
    function currentVersion() {
      if (cachedVersion) return cachedVersion;
      try {
        // Read via fs (relative to this file) instead of require(): under the
        // dynamic sandbox (`new Function` eval) require() resolves against the
        // caller's directory, not this file, and would silently miss the
        // package root. fs paths are explicit in both modes.
        const fsMod = typeof require === 'function' ? require('node:fs') : null;
        if (fsMod) {
          const pkgPath = require('node:path').join(__dirname, '..', 'package.json');
          if (fsMod.existsSync(pkgPath)) {
            const pkg = JSON.parse(fsMod.readFileSync(pkgPath, 'utf8'));
            cachedVersion = (pkg && pkg.version) || 'unknown';
            return cachedVersion;
          }
        }
      } catch (e) { /* fall through */ }
      cachedVersion = 'unknown';
      return cachedVersion;
    }
    function watchdogScript(cfg, p, opts) {
      const j = (v) => JSON.stringify(String(v));
      const u = opts || {};
      const autoUpdate = u.autoUpdate !== false;
      const updateIntervalMs = u.updateIntervalMs || 6 * 3600000;
      const updateMode = u.updateMode === 'download' ? 'download' : 'restart';
      const quietWindowMs = u.quietWindowMs || 5 * 60000;
      const deferMaxMs = u.deferMaxMs || 15 * 60000;
      const npmRegistry = u.npmRegistry || 'https://registry.npmjs.org';
      const profile = u.profile || 'web';
      const healthIntervalMs = u.healthIntervalMs || 10000;
      const startupGraceMs = u.startupGraceMs || 5 * 60000;
      const openBrowser = u.openBrowser !== false;
      return '\'use strict\';\n' +
        'const FS = require(\'node:fs\');\n' +
        'const PATH = require(\'node:path\');\n' +
        'const CP = require(\'node:child_process\');\n' +
        'const NET = require(\'node:net\');\n' +
        'const GEN_VERSION = ' + j(currentVersion()) + ';\n' +
        'const STATE_DIR = ' + j(p.dir) + ';\n' +
        'const DSH_HOME = ' + j(cfg.dshHome) + ';\n' +
        'const DSH_BIN = ' + j(cfg.dshBin) + ';\n' +
        '// Where `dsh` was found BEFORE resolution (pnpm sh shim / npm bin\n' +
        '// symlink / .cmd). Written by the package manager and stable across\n' +
        '// pnpm store GCs and reinstalls; DSH_BIN itself is a resolved .pnpm\n' +
        '// hash-dir path that those moves invalidate. When DSH_BIN vanishes the\n' +
        '// watchdog re-resolves through this anchor instead of crash-looping on\n' +
        '// MODULE_NOT_FOUND until a manual reinstall.\n' +
        'const DSH_SHIM = ' + j(cfg.dshShim || '') + ';\n' +
        parseShimTarget.toString() + '\n' +
        resolveDshBinThroughShim.toString() + '\n' +
        '// Lazily cached for the watchdog process lifetime: DSH_BIN while it\n' +
        '// exists, otherwise the fresh shim target. Resolution is attempted\n' +
        '// once per process so a failing re-resolve logs once, not on every\n' +
        '// health-check launch.\n' +
        'let dshBinResolved = null;\n' +
        'let dshBinChecked = false;\n' +
        'function currentDshBin() {\n' +
        '  if (dshBinChecked) return dshBinResolved;\n' +
        '  dshBinChecked = true;\n' +
        '  dshBinResolved = DSH_BIN;\n' +
        '  if (DSH_SHIM && !FS.existsSync(DSH_BIN)) {\n' +
        '    const t = resolveDshBinThroughShim(DSH_SHIM);\n' +
        '    if (t) { log(\'DSH_BIN missing (\' + DSH_BIN + \') — re-resolved through shim: \' + t); dshBinResolved = t; }\n' +
        '    else log(\'DSH_BIN missing (\' + DSH_BIN + \') and shim \' + DSH_SHIM + \' did not resolve — run dsh-daemon reinstall\');\n' +
        '  }\n' +
        '  return dshBinResolved;\n' +
        '}\n' +
        'const PORT = ' + String(cfg.port) + ';\n' +
        'const LOG_DIR = PATH.join(STATE_DIR, \'logs\');\n' +
        'const WATCHDOG_LOG = PATH.join(LOG_DIR, \'watchdog.log\');\n' +
        'const WEB_LOG = PATH.join(LOG_DIR, \'dsh-web.log\');\n' +
        'const INSTALLED = PATH.join(STATE_DIR, \'.daemon-installed\');\n' +
        'const STOPPED = PATH.join(STATE_DIR, \'.daemon-stopped\');\n' +
        'const RESTART_LOCK = PATH.join(STATE_DIR, \'.daemon-restart.lock\');\n' +
        'const WEB_PID = PATH.join(STATE_DIR, \'.dsh-web.pid\');\n' +
        'const WEB_STARTED = PATH.join(STATE_DIR, \'.dsh-web.started\');\n' +
        'const WATCHDOG_PID = PATH.join(STATE_DIR, \'.dsh-watchdog.pid\');\n' +
        'const REG_PLIST = ' + j(p.plist) + ';\n' +
        'const REG_LABEL = ' + j(LABEL) + ';\n' +
        'const HEALTH_URL = \'http://127.0.0.1:\' + PORT + \'/health\';\n' +
        'const PORT_FILE = PATH.join(STATE_DIR, \'.daemon-port\');\n' +
        'const INTERVAL_MS = ' + String(healthIntervalMs) + ';\n' +
        'const SLEEP_GAP_MS = 90000;\n' +
        // 5 consecutive misses on the 10s grid (~50s) instead of 3 (~30s): a
        // host under memory pressure loses three probes in a row while the
        // server is perfectly fine, and a false restart drops every live
        // session. A genuinely hung server still gets recycled.
        'const FAIL_THRESHOLD = 5;\n' +
        // Per-probe budget. /health runs on the same event loop as every
        // session, so a busy machine delays it by seconds: a 5s budget plus 3
        // strikes restarted healthy servers (measured: one probe at 4.6s on an
        // 8-core box under load average >100). 20s of patience, together with
        // FAIL_THRESHOLD, still catches a real hang.
        'const HEALTH_TIMEOUT_MS = 20000;\n' +
        // A booting dsh web is not a hang. The watchdog used to SIGKILL it after
        // FAIL_THRESHOLD misses (~60-90s on the tick grid), which turned a slow
        // plugin set into a kill/relaunch loop: the process never got the time it
        // needed to serve /health, so the daemon "could not start" a dsh web that
        // starts fine (just slowly) by hand. While the launched process is alive
        // and inside STARTUP_GRACE_MS, health misses never count towards a restart.
        'const STARTUP_GRACE_MS = ' + String(startupGraceMs) + ';\n' +
        'const STARTUP_LOG_EVERY_MS = 60000;\n' +
        // Floor between two launches: a dsh web that dies instantly (EADDRINUSE,
        // plugin activation failure) must not be relaunched in a hot loop.
        'const MIN_RESTART_GAP_MS = 15000;\n' +
        'const SIGTERM_WAIT_MS = 8000;\n' +
        'const PORT_FREE_WAIT_MS = 5000;\n' +
        'const RESTART_LOCK_TTL_MS = 120000;\n' +
        'const MAX_LOG_BYTES = 5 * 1024 * 1024;\n' +
        '// ---- auto-update configuration (embedded at install time) --------\n' +
        'const PACKAGE_NAME = ' + j('@chenkai114/dsh-daemon') + ';\n' +
        'const PROFILE_DIR = ' + j(String(cfg.dshHome + '/profiles/' + profile).replace(/\\/g, '/')) + ';\n' +
        'const PACKAGE_JSON = PATH.join(PROFILE_DIR, \'node_modules\', PACKAGE_NAME, \'package.json\');\n' +
        '// Working directory for `dsh web`. It must never inherit whatever\n' +
        '// directory the operator happened to start the daemon from: the launchd\n' +
        '// agent and any manual restart otherwise hand an arbitrary project tree\n' +
        '// (a git checkout with node_modules, a monorepo, $HOME) to the web\n' +
        '// process, and every relative-path scan or file watcher inside it then\n' +
        '// walks that tree. A stable DSH-owned directory removes the amplifier.\n' +
        'const WEB_CWD = PROFILE_DIR;\n' +
        'const NPM_REGISTRY = ' + j(npmRegistry) + ';\n' +
        'const AUTO_UPDATE = ' + (autoUpdate ? '1' : '0') + ';\n' +
        'const UPDATE_INTERVAL_MS = ' + String(updateIntervalMs) + ';\n' +
        'const UPDATE_MODE = ' + j(updateMode) + ';\n' +
        'const QUIET_WINDOW_MS = ' + String(quietWindowMs) + ';\n' +
        'const DEFER_MAX_MS = ' + String(deferMaxMs) + ';\n' +
        'const ACTIVITY_URL = \'http://127.0.0.1:\' + PORT + \'/dsh-daemon/activity\';\n' +
        'const UPDATE_LOCK = PATH.join(STATE_DIR, \'.daemon-update.lock\');\n' +
        'const UPDATE_PENDING = PATH.join(STATE_DIR, \'.daemon-update-pending\');\n' +
        'const UPDATE_CHECK = PATH.join(STATE_DIR, \'.daemon-update-check.json\');\n' +
        '// ---- dsh --no-open version gate (runtime: re-checked at every launch) ----\n' +
        'const DSH_NO_OPEN_MIN = ' + j(DSH_NO_OPEN_MIN) + ';\n' +
        'function dshVersion() {\n' +
        '  try { return JSON.parse(FS.readFileSync(PATH.join(PATH.dirname(currentDshBin()), \'..\', \'package.json\'), \'utf8\')).version || null; } catch (e) { return null; }\n' +
        '}\n' +
        parseSemver.toString() + '\n' +
        preGt.toString() + '\n' +
        versionGte.toString() + '\n' +
        '// ---- dsh web token auth (runtime: re-checked at every launch) ------\n' +
        '// Since dsh ' + DSH_TOKEN_AUTH_MIN + ' `dsh web` prints a per-process launch-token\n' +
        '// URL to stdout; the browser must visit it once to seed the 30-day cookie.\n' +
        '// We extract the line from dsh-web.log (the web process stdout) and open it\n' +
        '// once, so --no-open launches still end up authorized. Old dsh (no token)\n' +
        '// keeps the current behaviour: never touch the browser. The URL line itself\n' +
        '// is printed by every dsh version; `?token=` presence is the cross-version\n' +
        '// probe. New dsh that has not printed the line yet must be WAITED FOR, not\n' +
        '// treated as old (reverse insurance): fast poll then a slow retry phase.\n' +
        'const DSH_TOKEN_AUTH_MIN = ' + j(DSH_TOKEN_AUTH_MIN) + ';\n' +
        'const WEB_AUTH_URL_FILE = PATH.join(STATE_DIR, \'.web-auth-url\');\n' +
        'const OPEN_BROWSER = ' + (openBrowser ? '1' : '0') + ';\n' +
        'const WEB_TOKEN_FAST_MS = 15000;\n' +
        'const WEB_TOKEN_FAST_STEP_MS = 250;\n' +
        'const WEB_TOKEN_SLOW_MS = 75000;\n' +
        'const WEB_TOKEN_SLOW_STEP_MS = 5000;\n' +
        'let webAuthPollActive = false;\n' +
        dshTokenAuthSupported.toString() + '\n' +
        extractTokenUrl.toString() + '\n' +
        '\n' +
        'function log(msg) {\n' +
        '  const line = \'[\' + new Date().toISOString() + \'] [watchdog] \' + msg + \'\\n\';\n' +
        '  try {\n' +
        '    try { if (FS.existsSync(WATCHDOG_LOG) && FS.statSync(WATCHDOG_LOG).size > MAX_LOG_BYTES) {\n' +
        '      if (FS.existsSync(WATCHDOG_LOG + \'.1\')) {\n' +
        '        if (FS.existsSync(WATCHDOG_LOG + \'.2\')) FS.unlinkSync(WATCHDOG_LOG + \'.2\');\n' +
        '        FS.renameSync(WATCHDOG_LOG + \'.1\', WATCHDOG_LOG + \'.2\');\n' +
        '      }\n' +
        '      FS.renameSync(WATCHDOG_LOG, WATCHDOG_LOG + \'.1\');\n' +
        '    } } catch (e) {}\n' +
        '    FS.appendFileSync(WATCHDOG_LOG, line);\n' +
        '  } catch (e) {}\n' +
        '}\n' +
        'function readPid(file) {\n' +
        '  try { const n = parseInt(FS.readFileSync(file, \'utf8\').trim(), 10); return isNaN(n) ? null : n; } catch (e) { return null; }\n' +
        '}\n' +
        'function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return false; } }\n' +
        'function killPid(pid) {\n' +
        '  try { process.kill(pid, \'SIGKILL\'); }\n' +
        '  catch (e) { if (!e || e.code !== \'ESRCH\') log(\'failed to kill PID \' + pid + \': \' + (e && e.message ? e.message : String(e))); }\n' +
        '}\n' +
        '// Single-instance guard: only trust a pid file whose PID is actually a watchdog\n' +
        '// process. Otherwise a stale file whose PID got reused (e.g. tail -f in a\n' +
        '// container) makes the guard misfire and exit(0) forever. On non-Linux there is\n' +
        '// no /proc, so fall back to the old pid-only behaviour.\n' +
        'function isWatchdogProcess(pid) {\n' +
        '  if (process.platform !== \'linux\') return true;\n' +
        '  try { return FS.readFileSync(\'/proc/\' + pid + \'/cmdline\', \'utf8\').indexOf(\'watchdog.js\') !== -1; }\n' +
        '  catch (e) { return false; }\n' +
        '}\n' +
        'function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }\n' +
        '// PowerShell single-quote escaping (\'\' doubles inside a PS string).\n' +
        'function psq(s) { return "\'" + String(s).replace(/\'/g, "\'\'") + "\'"; }\n' +
        '// ---- startup window, port and process probes -----------------------\n' +
        'function webStartedAt() {\n' +
        '  try { const n = parseInt(FS.readFileSync(WEB_STARTED, \'utf8\').trim(), 10); return isNaN(n) ? 0 : n; }\n' +
        '  catch (e) { return 0; }\n' +
        '}\n' +
        'function webUptimeMs() { const t = webStartedAt(); return t ? Math.max(0, Date.now() - t) : 0; }\n' +
        '// True while the dsh web we launched is alive inside its startup window.\n' +
        'function webStarting() {\n' +
        '  const pid = readPid(WEB_PID);\n' +
        '  if (!(pid && alive(pid))) return false;\n' +
        '  const up = webUptimeMs();\n' +
        '  return up > 0 && up < STARTUP_GRACE_MS;\n' +
        '}\n' +
        '// Is anything listening on our port? Distinguishes "still booting"\n' +
        '// (closed) from "listening but not serving /health yet" (open).\n' +
        'function portListening() {\n' +
        '  return new Promise(function (resolve) {\n' +
        '    let settled = false;\n' +
        '    const sock = NET.connect({ host: \'127.0.0.1\', port: PORT });\n' +
        '    const done = function (v) { if (settled) return; settled = true; try { sock.destroy(); } catch (e) {} resolve(v); };\n' +
        '    sock.setTimeout(1000);\n' +
        '    sock.once(\'connect\', function () { done(true); });\n' +
        '    sock.once(\'timeout\', function () { done(false); });\n' +
        '    sock.once(\'error\', function () { done(false); });\n' +
        '  });\n' +
        '}\n' +
        'async function waitPortFree(ms) {\n' +
        '  const deadline = Date.now() + ms;\n' +
        '  while (await portListening()) {\n' +
        '    if (Date.now() >= deadline) return false;\n' +
        '    await sleep(250);\n' +
        '  }\n' +
        '  return true;\n' +
        '}\n' +
        '// The PID that actually holds PORT. The pid file can drift: a launch race\n' +
        '// leaves the loser recorded while the winner serves the port, and an\n' +
        '// untracked listener used to make every restart spawn a doomed second dsh\n' +
        '// web (EADDRINUSE) while the real server kept running unmanaged.\n' +
        'function listenerPid() {\n' +
        '  try {\n' +
        '    if (process.platform === \'win32\') {\n' +
        '      const out = CP.execFileSync(\'netstat\', [\'-ano\'], { encoding: \'utf8\', windowsHide: true, timeout: 5000 });\n' +
        '      let hit = null;\n' +
        '      out.split(String.fromCharCode(10)).forEach(function (line) {\n' +
        '        if (line.indexOf(\':\' + PORT) === -1 || line.indexOf(\'LISTENING\') === -1) return;\n' +
        '        const cols = line.trim().split(\' \');\n' +
        '        const n = parseInt(cols[cols.length - 1], 10);\n' +
        '        if (n > 0) hit = n;\n' +
        '      });\n' +
        '      return hit;\n' +
        '    }\n' +
        '    const out = CP.execFileSync(\'lsof\', [\'-nP\', \'-ti\', \'tcp:\' + PORT, \'-sTCP:LISTEN\'], { encoding: \'utf8\', windowsHide: true, timeout: 5000 });\n' +
        '    const pids = String(out).split(String.fromCharCode(10)).map(function (v) { return parseInt(v.trim(), 10); }).filter(function (n) { return n > 0; });\n' +
        '    return pids.length ? pids[0] : null;\n' +
        '  } catch (e) { return null; }\n' +
        '}\n' +
        '// Is this PID a `dsh web`? "The PID exists" is not "our server": after a\n' +
        '// crash the OS can hand the number to an unrelated process, and killing\n' +
        '// that one is worse than doing nothing. Returns null when identity cannot\n' +
        '// be read (no /proc, ps blocked) so callers can decide instead of guessing.\n' +
        'function isDshWebProcess(pid) {\n' +
        '  if (!(pid && alive(pid))) return false;\n' +
        '  try {\n' +
        '    let cmd = \'\';\n' +
        '    if (process.platform === \'linux\') {\n' +
        '      cmd = FS.readFileSync(\'/proc/\' + pid + \'/cmdline\', \'utf8\').split(String.fromCharCode(0)).join(\' \');\n' +
        '    } else if (process.platform === \'win32\') {\n' +
        '      cmd = CP.execFileSync(\'powershell.exe\', [\'-NoProfile\', \'-NonInteractive\', \'-Command\', \'Get-CimInstance Win32_Process -Filter "ProcessId=\' + pid + \'" | Select-Object -ExpandProperty CommandLine\'], { encoding: \'utf8\', windowsHide: true, timeout: 8000 });\n' +
        '    } else {\n' +
        '      cmd = CP.execFileSync(\'ps\', [\'-p\', pid + \'\', \'-o\', \'command=\'], { encoding: \'utf8\', windowsHide: true, timeout: 5000 });\n' +
        '    }\n' +
        '    if (!cmd) return null;\n' +
        '    return cmd.indexOf(\'bin.js\') !== -1 && cmd.indexOf(\' web\') !== -1 && cmd.indexOf(\'--port\') !== -1;\n' +
        '  } catch (e) { return null; }\n' +
        '}\n' +
        '// Stop the previous web server the way a supervisor should: SIGTERM first\n' +
        '// (`dsh web` disposes cleanly and releases the listener), SIGKILL only as a\n' +
        '// last resort, then wait for the port to be free — launching onto a port\n' +
        '// that is still held makes the fresh dsh web die with EADDRINUSE during\n' +
        '// plugin activation, which then reads as "the daemon cannot start it".\n' +
        'async function stopWebServer(pid) {\n' +
        '  const targets = [];\n' +
        '  const add = function (v) { if (v && v !== process.pid && alive(v) && targets.indexOf(v) === -1) targets.push(v); };\n' +
        '  const lp = listenerPid();\n' +
        '  // A tracked PID that owns the port IS our server, whatever its argv looks\n' +
        '  // like; that is the identity check that cannot misfire. A recycled PID\n' +
        '  // (issue #3) does neither, so it is left alone.\n' +
        '  if (pid && alive(pid) && (lp === pid || isDshWebProcess(pid) !== false)) add(pid);\n' +
        '  else if (pid && alive(pid)) log(\'PID \' + pid + \' is not a dsh web (recycled PID?) — not stopping it\');\n' +
        '  // An untracked listener still owns the port. Stopping only the tracked\n' +
        '  // PID would leave it serving and the replacement would die with\n' +
        '  // EADDRINUSE — the state that made the daemon launch storm.\n' +
        '  if (lp && isDshWebProcess(lp) === true) add(lp);\n' +
        '  if (!targets.length) return;\n' +
        '  targets.forEach(function (v) { log(\'stopping web server (PID \' + v + \')\'); try { process.kill(v, \'SIGTERM\'); } catch (e) {} });\n' +
        '  const deadline = Date.now() + SIGTERM_WAIT_MS;\n' +
        '  while (targets.some(function (v) { return alive(v); }) && Date.now() < deadline) await sleep(200);\n' +
        '  const stubborn = targets.filter(function (v) { return alive(v); });\n' +
        '  if (stubborn.length) { log(\'web server (PID \' + stubborn.join(\', \') + \') ignored SIGTERM for \' + Math.round(SIGTERM_WAIT_MS / 1000) + \'s — SIGKILL\'); stubborn.forEach(killPid); }\n' +
        '  if (!(await waitPortFree(1000))) {\n' +
        '    log(\'port \' + PORT + \' is still held after stopping PID \' + targets.join(\', \') + \'; waiting up to \' + Math.round(PORT_FREE_WAIT_MS / 1000) + \'s\');\n' +
        '    if (!(await waitPortFree(PORT_FREE_WAIT_MS))) log(\'port \' + PORT + \' is still in use by another process — not killing it; check: lsof -ti :\' + PORT);\n' +
        '  }\n' +
        '}\n' +
        'function webLogTail(n) {\n' +
        '  try {\n' +
        '    const lines = FS.readFileSync(WEB_LOG, \'utf8\').split(\'\\n\').filter(function (l) { return l.trim(); });\n' +
        '    return lines.slice(-n);\n' +
        '  } catch (e) { return []; }\n' +
        '}\n' +
        '// The one command every failure report points at (systemctl prints a\n' +
        '// `journalctl -xe` pointer when a unit fails; this is the equivalent).\n' +
        'function logsHint() { return \'dsh-daemon logs -n 100\'; }\n' +
        'function printLogsHelp() {\n' +
        '  console.log(\'Usage: dsh-daemon logs [-n <lines>] [--web | --watchdog]\');\n' +
        '  console.log(\'  -n, --lines <n>  trailing lines per log (default 50)\');\n' +
        '  console.log(\'  --web            only the dsh web log (logs/dsh-web.log)\');\n' +
        '  console.log(\'  --watchdog       only the watchdog log (logs/watchdog.log)\');\n' +
        '}\n' +
        'function readLogTail(file, n) {\n' +
        '  try {\n' +
        '    const lines = FS.readFileSync(file, \'utf8\').split(\'\\n\');\n' +
        '    if (lines.length && lines[lines.length - 1] === \'\') lines.pop();\n' +
        '    return lines.slice(-n);\n' +
        '  } catch (e) { return []; }\n' +
        '}\n' +
        'function fileInfo(file) {\n' +
        '  try {\n' +
        '    const st = FS.statSync(file);\n' +
        '    return st.size + \' bytes, updated \' + new Date(st.mtimeMs).toISOString();\n' +
        '  } catch (e) { return \'not created yet\'; }\n' +
        '}\n' +
        '// `dsh-daemon logs`: the two logs this daemon owns, plus the three facts a\n' +
        '// startup-failure report needs (is /health serving, is the tracked process\n' +
        '// alive, how old is the current launch). Async only for the health probe.\n' +
        'async function printLogs(argv) {\n' +
        '  const args = argv || [];\n' +
        '  let n = 50;\n' +
        '  const only = [];\n' +
        '  for (let i = 0; i < args.length; i++) {\n' +
        '    const a = args[i];\n' +
        '    if (a === \'-n\' || a === \'--lines\') { const v = parseInt(args[++i], 10); if (v > 0) n = Math.min(v, 10000); }\n' +
        '    else if (/^-[0-9]+$/.test(a)) n = Math.min(parseInt(a.slice(1), 10), 10000);\n' +
        '    else if (a === \'--web\' || a === \'--web-only\') only.push(\'web\');\n' +
        '    else if (a === \'--watchdog\' || a === \'--watchdog-only\') only.push(\'watchdog\');\n' +
        '    else if (a === \'--all\') only.length = 0;\n' +
        '    else if (a === \'-h\' || a === \'--help\') { printLogsHelp(); return 0; }\n' +
        '    else { console.log(\'dsh-daemon logs: unknown option \' + a); printLogsHelp(); return 2; }\n' +
        '  }\n' +
        '  const want = only.length ? only : [\'web\', \'watchdog\'];\n' +
        '  const ok = await healthy();\n' +
        '  const pid = readPid(WEB_PID);\n' +
        '  const startedAt = webStartedAt();\n' +
        '  const age = startedAt ? Math.round((Date.now() - startedAt) / 1000) + \'s ago\' : \'unknown\';\n' +
        '  console.log(\'dsh-daemon logs — dsh web startup diagnostics\');\n' +
        '  console.log(\'  port \' + PORT + \'  |  /health \' + (ok ? \'✅ 200\' : \'❌ not serving\') +\n' +
        '    \'  |  web pid \' + (pid ? pid + (alive(pid) ? \' (alive)\' : \' (not running)\') : \'none\') +\n' +
        '    \'  |  last launch \' + age +\n' +
        '    (FS.existsSync(STOPPED) ? \'  |  ⏸ monitoring paused\' : \'\'));\n' +
        '  console.log(\'  web log:      \' + WEB_LOG + \'  (\' + fileInfo(WEB_LOG) + \')\');\n' +
        '  console.log(\'  watchdog log: \' + WATCHDOG_LOG + \'  (\' + fileInfo(WATCHDOG_LOG) + \')\');\n' +
        '  const show = function (label, file) {\n' +
        '    const tail = readLogTail(file, n);\n' +
        '    console.log(\'\');\n' +
        '    console.log(\'--- \' + label + \' (last \' + n + \' lines, \' + file + \') ---\');\n' +
        '    if (!tail.length) { console.log(\'  (empty — dsh web has not written anything yet)\'); return; }\n' +
        '    for (const l of tail) console.log(\'  | \' + l);\n' +
        '  };\n' +
        '  if (want.indexOf(\'web\') !== -1) show(\'dsh-web.log\', WEB_LOG);\n' +
        '  if (want.indexOf(\'watchdog\') !== -1) show(\'watchdog.log\', WATCHDOG_LOG);\n' +
        '  console.log(\'\');\n' +
        '  console.log(\'Follow live (dsh web):  tail -f \' + WEB_LOG);\n' +
        '  console.log(\'Follow live (watchdog): tail -f \' + WATCHDOG_LOG);\n' +
        '  console.log(\'Full status:             dsh-daemon status\');\n' +
        '  return 0;\n' +
        '}\n' +
        '// Wait for /health, stopping early when the process dies (a dead process\n' +
        '// will never become healthy; a slow one is normal).\n' +
        'async function waitForHealth(deadlineMs, onTick) {\n' +
        '  const t0 = Date.now();\n' +
        '  let lastReport = 0;\n' +
        '  for (;;) {\n' +
        '    if (await healthy()) return { ok: true, died: false, ms: Date.now() - t0 };\n' +
        '    const pid = readPid(WEB_PID);\n' +
        '    if (!(pid && alive(pid))) return { ok: false, died: true, ms: Date.now() - t0 };\n' +
        '    const elapsed = Date.now() - t0;\n' +
        '    if (elapsed >= deadlineMs) return { ok: false, died: false, ms: elapsed };\n' +
        '    if (onTick && elapsed - lastReport >= 10000) { lastReport = elapsed; onTick(elapsed, pid); }\n' +
        '    await sleep(1000);\n' +
        '  }\n' +
        '}\n' +
        'async function healthy() {\n' +
        '  try {\n' +
        '    const ctrl = new AbortController();\n' +
        '    const t = setTimeout(function () { ctrl.abort(); }, HEALTH_TIMEOUT_MS);\n' +
        '    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });\n' +
        '    clearTimeout(t);\n' +
        '    return res.ok;\n' +
        '  } catch (e) { return false; }\n' +
        '}\n' +
        'let launchInFlight = null;\n' +
        '// Single-flight: the tick, the CLI and the update path can all ask for a\n' +
        '// launch in the same second. Two overlapping launches spawned two dsh web\n' +
        '// processes ~1s apart; the loser died with EADDRINUSE and the pid file kept\n' +
        '// whichever PID was written last, leaving the daemon tracking a phantom\n' +
        '// while the winner served the port unmanaged.\n' +
        'async function launch() {\n' +
        '  if (launchInFlight) return launchInFlight;\n' +
        '  launchInFlight = doLaunch();\n' +
        '  try { return await launchInFlight; } finally { launchInFlight = null; }\n' +
        '}\n' +
        'async function doLaunch() {\n' +
        '  const lastStart = webStartedAt();\n' +
        '  if (lastStart && Date.now() - lastStart < MIN_RESTART_GAP_MS) {\n' +
        '    log(\'restart skipped: dsh web was launched \' + Math.round((Date.now() - lastStart) / 1000) + \'s ago\');\n' +
        '    return false;\n' +
        '  }\n' +
        '  await stopWebServer(readPid(WEB_PID));\n' +
        '  try { FS.unlinkSync(WEB_PID); } catch (e) {}\n' +
        '  // Recorded before the spawn: the startup window and the token scan both\n' +
        '  // anchor on this timestamp, for this run only.\n' +
        '  try { FS.writeFileSync(WEB_STARTED, String(Date.now())); } catch (e) {}\n' +
        '  let fd = -1;\n' +
        '  try { fd = FS.openSync(WEB_LOG, \'a\'); } catch (e) { log(\'cannot open web log: \' + e.message); }\n' +
        '  const ver = dshVersion();\n' +
        '  // Anchor the token scan to this run: on POSIX dsh-web.log is append-only\n' +
        '  // (previous runs\' token lines must never be reused — they are invalid\n' +
        '  // once the process restarts); on win32 Start-Process truncates/recreates\n' +
        '  // the file, which the poll detects (size < base). Recorded BEFORE the\n' +
        '  // spawn so a token line printed very early is still within the window.\n' +
        '  const webLogBase = (function () { try { return FS.statSync(WEB_LOG).size; } catch (e) { return 0; } })();\n' +
        '  // currentDshBin() re-resolves through the shim when the baked path\n' +
        '  // has vanished (pnpm store GC / reinstall moved the hash dir).\n' +
        '  const entry = currentDshBin();\n' +
        '  // A shell shim (dsh.ps1 / dsh.cmd / pnpm sh) handed to `node` is an\n' +
        '  // instant SyntaxError with nothing listening, i.e. a restart loop whose\n' +
        '  // log still reads "launched dsh web" (issue #3, N1). Refuse it loudly.\n' +
        '  if (!(String(entry).endsWith(\'.js\') || String(entry).endsWith(\'.cjs\') || String(entry).endsWith(\'.mjs\'))) {\n' +
        '    log(\'dsh entry is not JavaScript (\' + entry + \') — refusing to spawn `node <shim>`; run dsh-daemon reinstall so the shim resolves to lib/bin.js\');\n' +
        '    return false;\n' +
        '  }\n' +
        '  const args = [entry, \'web\', \'--port\', String(PORT)];\n' +
        '  if (versionGte(ver, DSH_NO_OPEN_MIN)) args.push(\'--no-open\');\n' +
        '  else log(\'dsh \' + (ver || \'unknown\') + \' predates --no-open (\' + DSH_NO_OPEN_MIN + \'), launching without it\');\n' +
        '  // Optional --trusted-host for /api browser-trust fence: when dsh web is\n' +
        '  // reached through a reverse proxy (nginx) the Host header is the public\n' +
        '  // hostname, which the fence would otherwise reject with 403. Comma-\n' +
        '  // separated list accepted (e.g. "dsh.example.com,10.0.0.5:8080").\n' +
        '  const trustedHost = process.env.DSH_DAEMON_TRUSTED_HOST || ' + j(u.trustedHost || '') + ';\n' +
        '  if (trustedHost) {\n' +
        '    String(trustedHost).split(\',\').map(function (h) { return h.trim(); }).filter(Boolean).forEach(function (h) { args.push(\'--trusted-host\', h); });\n' +
        '    log(\'dsh web trusted-host(s): \' + trustedHost);\n' +
        '  }\n' +
        '  // Prepend the node directory to PATH: launchd/systemd give this\n' +
        '  // process a minimal PATH, and the web process (plus the plugins\n' +
        '  // running inside it) must be able to resolve `node`.\n' +
        '  const env = Object.assign({}, process.env, { DSH_HOME: DSH_HOME, PATH: PATH.dirname(process.execPath) + PATH.delimiter + (process.env.PATH || \'\') });\n' +
        '  // cwd is passed explicitly to both launches below; make sure it exists\n' +
        '  // first, otherwise the spawn itself fails with ENOENT.\n' +
        '  try { FS.mkdirSync(WEB_CWD, { recursive: true }); } catch (e) {}\n' +
        '  if (process.platform === \'win32\') {\n' +
        '    // Give dsh web a HIDDEN console (STARTF_USESHOWWINDOW + SW_HIDE,\n' +
        '    // dwCreationFlags stays 0) via Start-Process -WindowStyle Hidden —\n' +
        '    // NOT CREATE_NO_WINDOW (windowsHide): a hidden console lets dsh web\'s\n' +
        '    // own console children inherit it, while a console-less dsh web makes\n' +
        '    // every child allocate a new visible console, and CREATE_NO_WINDOW on\n' +
        '    // restricted-token sandbox children kills them with 0xC0000142\n' +
        '    // (deepseek-harness discussions #1564 / #810).\n' +
        '    const psArgs = args.map(function (a) { return "\'" + String(a).replace(/\'/g, "\'\'") + "\'"; }).join(\',\');\n' +
        '    // Rotate the previous web log first: Start-Process redirects with\n' +
        '    // OVERWRITE semantics (no append mode), so keep one generation by\n' +
        '    // moving web.log -> web.log.1 before the fresh run writes it. The\n' +
        '    // log is bounded (current + one previous run) and the previous\n' +
        '    // run\'s crash output survives for diagnosis.\n' +
        '    const ps = \'if (Test-Path \' + psq(WEB_LOG) + \') { Move-Item -Force \' + psq(WEB_LOG) + \' \' + psq(WEB_LOG + \'.1\') + \' }\' +\n' +
        '      \'; Start-Process -FilePath \' + psq(process.execPath) + \' -ArgumentList \' + psArgs + \' -WindowStyle Hidden -RedirectStandardOutput \' + psq(WEB_LOG) + \' -PassThru | % { $_.Id } | Out-File -Encoding ascii \' + psq(WEB_PID);\n' +
        '    // The wrapper runs powershell.exe -> Start-Process. IMPORTANT: no\n' +
        '    // detached:true here — on Windows Node maps it to DETACHED_PROCESS,\n' +
        '    // which makes the Start-Process command hang (no PID file, child\n' +
        '    // never starts; verified empirically). Start-Process children are\n' +
        '    // independent processes anyway, so the short-lived wrapper needs no\n' +
        '    // detachment. windowsHide (CREATE_NO_WINDOW) is fine for the wrapper\n' +
        '    // itself — normal token, short-lived.\n' +
        '    // -WorkingDirectory is not passed to Start-Process: it inherits the\n' +
        '    // wrapper\'s cwd, so cwd: WEB_CWD here already decides the web\n' +
        '    // process\'s working directory on Windows too.\n' +
        '    const wrapper = CP.spawn(\'powershell.exe\', [\'-NoProfile\', \'-NonInteractive\', \'-Command\', ps], { cwd: WEB_CWD, stdio: fd >= 0 ? [\'ignore\', fd, fd] : \'ignore\', env: env, windowsHide: true });\n' +
        '    wrapper.on(\'error\', function (err) { log(\'spawn dsh web (via Start-Process) failed: \' + err.message + \' (details: \' + logsHint() + \')\'); });\n' +
        '    wrapper.unref();\n' +
        '    // The wrapper writes WEB_PID (Start-Process -PassThru); poll briefly.\n' +
        '    const t0 = Date.now();\n' +
        '    (function waitPid() {\n' +
        '      const pid = readPid(WEB_PID);\n' +
        '      if (pid) { log(\'launched dsh web (PID \' + pid + \'): \' + process.execPath + \' \' + args.join(\' \')); return; }\n' +
        '      if (Date.now() - t0 > 10000) { log(\'launched dsh web via Start-Process (PID not reported within 10s)\'); return; }\n' +
        '      setTimeout(waitPid, 250);\n' +
        '    })();\n' +
        '  } else {\n' +
        '    const child = CP.spawn(process.execPath, args, { cwd: WEB_CWD, detached: true, stdio: fd >= 0 ? [\'ignore\', fd, fd] : \'ignore\', env: env, windowsHide: true });\n' +
        '    child.on(\'error\', function (err) { log(\'spawn dsh web failed: \' + err.message + \' (details: \' + logsHint() + \')\'); });\n' +
        '    if (child.pid) { try { FS.writeFileSync(WEB_PID, String(child.pid)); } catch (e) {} }\n' +
        '    child.unref();\n' +
        '    log(\'launched dsh web (PID \' + child.pid + \'): \' + process.execPath + \' \' + args.join(\' \'));\n' +
        '  }\n' +
        '  seedWebAuth(ver, webLogBase);\n' +
        '  return true;\n' +
        '}\n' +
        '// ---- web auth token bootstrap ----------------------------------------\n' +
        'function seedWebAuth(ver, base) {\n' +
        '  // Any failure in the bootstrap must only log — it must never break the\n' +
        '  // watchdog main loop. The synchronous part is guarded here and the\n' +
        '  // async timer callbacks inside poll() are guarded there: an unexpected\n' +
        '  // throw must not leave webAuthPollActive stuck (that would block every\n' +
        '  // later launch from seeding auth). The poll chain is self-terminating\n' +
        '  // (at most one pending timer per round; stops after found / timeout /\n' +
        '  // error) and watchdog shutdown uses process.exit, which drops any\n' +
        '  // pending timer — nothing leaks.\n' +
        '  try {\n' +
        '    // Old dsh (no token auth) keeps the current behaviour: never open a\n' +
        '    // browser. The URL-line probe is authoritative; the version gate only\n' +
        '    // skips the poll when we KNOW the installed dsh predates token auth.\n' +
        '    if (ver !== null && !dshTokenAuthSupported(ver)) return;\n' +
        '    if (webAuthPollActive) return; // a poll already covers the latest launch\n' +
        '    webAuthPollActive = true;\n' +
        '    // Reverse insurance: a new dsh whose token line is slow to appear must\n' +
        '    // be WAITED FOR, never dismissed as "no token" (treating a probe failure\n' +
        '    // as old dsh would silently skip the auth). Fast poll first, then a slow\n' +
        '    // retry phase; only after both does the poll give up (next launch retries).\n' +
        '    const fastDeadline = Date.now() + WEB_TOKEN_FAST_MS;\n' +
        '    const slowDeadline = Date.now() + WEB_TOKEN_FAST_MS + WEB_TOKEN_SLOW_MS;\n' +
        '    // The token line is printed once dsh web is listening, so a slow\n' +
        '    // boot delays it past the fixed window. While the process we just\n' +
        '    // launched is still inside its startup grace, keep waiting (the\n' +
        '    // grace, not this window, decides how long a boot may take).\n' +
        '    let slowWindowExtended = false;\n' +
        '    (function poll() {\n' +
        '      try {\n' +
        '        let text = \'\';\n' +
        '        try {\n' +
        '          const st = FS.statSync(WEB_LOG);\n' +
        '          const start = st.size < base ? 0 : base; // win32 truncation -> whole file\n' +
        '          if (st.size > start) {\n' +
        '            let fd = -1;\n' +
        '            try {\n' +
        '              fd = FS.openSync(WEB_LOG, \'r\');\n' +
        '              const buf = Buffer.alloc(st.size - start);\n' +
        '              FS.readSync(fd, buf, 0, buf.length, start);\n' +
        '              text = buf.toString(\'utf8\');\n' +
        '            } finally {\n' +
        '              // Always close the fd, even if readSync throws.\n' +
        '              if (fd >= 0) { try { FS.closeSync(fd); } catch (e2) {} }\n' +
        '            }\n' +
        '          }\n' +
        '        } catch (e) { text = \'\'; }\n' +
        '        // Always take the LAST matching `dsh web:` line of this run\'s segment:\n' +
        '        // on POSIX the log accumulates across restarts, so earlier lines are\n' +
        '        // dead tokens from previous processes; on win32 the log is recreated\n' +
        '        // per run and web.log.1 (the previous process) is never read.\n' +
        '        let url = null;\n' +
        '        if (text) {\n' +
        '          const lines = text.split(\'\\n\');\n' +
        '          for (let i = lines.length - 1; i >= 0; i--) {\n' +
        '            url = extractTokenUrl(lines[i], PORT);\n' +
        '            if (url) break;\n' +
        '          }\n' +
        '        }\n' +
        '        if (url) {\n' +
        '          webAuthPollActive = false;\n' +
        '          // Throttle: the launch token changes every process start, and the\n' +
        '          // 30-day cookie outlives any single token (signing key persists), so\n' +
        '          // popping the browser for the SAME URL we already recorded is wasted\n' +
        '          // work — skip it. The file is still refreshed so `status` stays\n' +
        '          // accurate and manual access always has the current URL.\n' +
        '          let same = false;\n' +
        '          try { same = FS.readFileSync(WEB_AUTH_URL_FILE, \'utf8\').trim() === url; } catch (e) { same = false; }\n' +
        '          try { FS.writeFileSync(WEB_AUTH_URL_FILE, url + \'\\n\', { mode: 0o600 }); } catch (e) {}\n' +
        '          log(\'web auth token: \' + url);\n' +
        '          if (!OPEN_BROWSER) log(\'browser open disabled (DSH_DAEMON_OPEN_BROWSER=0) — open manually: \' + url);\n' +
        '          else if (same) log(\'token unchanged since last launch — skipping browser (cookie already seeded)\');\n' +
        '          else if (process.env.SSH_CONNECTION || process.env.SSH_TTY) log(\'SSH session detected — not opening browser; open manually: \' + url);\n' +
        '          else openBrowser(url);\n' +
        '          return;\n' +
        '        }\n' +
        '        const now = Date.now();\n' +
        '        if (now >= slowDeadline && webStarting()) {\n' +
        '          if (!slowWindowExtended) {\n' +
        '            slowWindowExtended = true;\n' +
        '            log(\'web auth token line still pending after \' + Math.round((WEB_TOKEN_FAST_MS + WEB_TOKEN_SLOW_MS) / 1000) + \'s — dsh web is still starting, waiting up to the startup grace\');\n' +
        '          }\n' +
        '          setTimeout(poll, WEB_TOKEN_SLOW_STEP_MS);\n' +
        '          return;\n' +
        '        }\n' +
        '        if (now >= slowDeadline) {\n' +
        '          webAuthPollActive = false;\n' +
        '          // Clear the stale URL: the previous run\'s token died with its\n' +
        '          // process, so leaving it would make `status` show a dead URL as\n' +
        '          // "valid while this web process runs" (misleading).\n' +
        '          try { FS.unlinkSync(WEB_AUTH_URL_FILE); } catch (e) {}\n' +
        '          log(\'no web auth token line within \' + Math.round((WEB_TOKEN_FAST_MS + WEB_TOKEN_SLOW_MS) / 1000) + \'s (dsh \' + (ver || \'unknown\') + \'); next launch will retry\');\n' +
        '          return;\n' +
        '        }\n' +
        '        setTimeout(poll, now >= fastDeadline ? WEB_TOKEN_SLOW_STEP_MS : WEB_TOKEN_FAST_STEP_MS);\n' +
        '      } catch (e) {\n' +
        '        webAuthPollActive = false;\n' +
        '        log(\'web auth poll error: \' + (e && e.message));\n' +
        '      }\n' +
        '    })();\n' +
        '  } catch (e) {\n' +
        '    webAuthPollActive = false;\n' +
        '    log(\'web auth bootstrap error: \' + (e && e.message));\n' +
        '  }\n' +
        '}\n' +
        'function openBrowser(url) {\n' +
        '  try {\n' +
        '    if (process.platform === \'win32\') {\n' +
        '      // Start-Process with a URL opens the default browser (hidden console).\n' +
        '      // NOT detached: on Windows Node maps detached to DETACHED_PROCESS,\n' +
        '      // which hangs Start-Process (same empirical finding as the web\n' +
        '      // launch wrapper — see launch() and version-gate.test.js). unref()\n' +
        '      // keeps the short-lived powershell out of the event loop.\n' +
        '      const cmd = \'Start-Process \' + psq(url);\n' +
        '      const c = CP.spawn(\'powershell.exe\', [\'-NoProfile\', \'-NonInteractive\', \'-Command\', cmd], { stdio: \'ignore\', windowsHide: true });\n' +
        '      c.on(\'error\', function (e) { log(\'open browser failed: \' + e.message); });\n' +
        '      c.unref();\n' +
        '      log(\'opening browser: \' + url);\n' +
        '      return;\n' +
        '    }\n' +
        '    // POSIX: detached is fine and desirable (own process group, survives\n' +
        '    // a watchdog exit; `open`/`xdg-open` return right after handing the\n' +
        '    // URL to the desktop).\n' +
        '    const opener = process.platform === \'darwin\' ? \'open\' : \'xdg-open\';\n' +
        '    const c = CP.spawn(opener, [url], { detached: true, stdio: \'ignore\', windowsHide: true });\n' +
        '    c.on(\'error\', function (e) { log(\'open browser failed (\' + opener + \'): \' + e.message); });\n' +
        '    c.on(\'exit\', function (code) { if (code !== 0) log(\'open browser exited \' + code + \' (no GUI?) — access manually: \' + url); });\n' +
        '    c.unref();\n' +
        '    log(\'opening browser: \' + url);\n' +
        '  } catch (e) { log(\'open browser error: \' + (e && e.message)); }\n' +
        '}\n' +
        'function restartLockFresh() {\n' +
        '  try { const t = Number(FS.readFileSync(RESTART_LOCK, \'utf8\').trim()); return !isNaN(t) && Date.now() - t < RESTART_LOCK_TTL_MS; } catch (e) { return false; }\n' +
        '}\n' +
        '// ---- auto-update ----------------------------------------------------\n' +
        'function parseV(v) {\n' +
        '  const p = String(v || \'\').trim().split(\'.\').map(function (n) { return parseInt(n, 10) || 0; });\n' +
        '  return [p[0] || 0, p[1] || 0, p[2] || 0];\n' +
        '}\n' +
        'function sameMajor(a, b) { return parseV(a)[0] === parseV(b)[0]; }\n' +
        'function isNewer(a, b) {\n' +
        '  const A = parseV(a), B = parseV(b);\n' +
        '  return A[0] > B[0] || (A[0] === B[0] && (A[1] > B[1] || (A[1] === B[1] && A[2] > B[2])));\n' +
        '}\n' +
        'function readLocalVersion() {\n' +
        '  try { return JSON.parse(FS.readFileSync(PACKAGE_JSON, \'utf8\')).version || null; } catch (e) { return null; }\n' +
        '}\n' +
        'async function fetchLatestVersion() {\n' +
        '  try {\n' +
        '    const ctrl = new AbortController();\n' +
        '    const t = setTimeout(function () { ctrl.abort(); }, 10000);\n' +
        '    const res = await fetch(NPM_REGISTRY + \'/\' + PACKAGE_NAME + \'/latest\', { signal: ctrl.signal, headers: { accept: \'application/json\' } });\n' +
        '    clearTimeout(t);\n' +
        '    if (!res.ok) return null;\n' +
        '    const body = await res.json();\n' +
        '    return typeof body.version === \'string\' && body.version ? body.version : null;\n' +
        '  } catch (e) { return null; }\n' +
        '}\n' +
        'function writeCheck(state) {\n' +
        '  try { FS.writeFileSync(UPDATE_CHECK, JSON.stringify(state)); } catch (e) {}\n' +
        '}\n' +
        'function readCheck() {\n' +
        '  try { return JSON.parse(FS.readFileSync(UPDATE_CHECK, \'utf8\')); } catch (e) { return null; }\n' +
        '}\n' +
        'function pnpmBinPath() {\n' +
        '  const win = process.platform === \'win32\';\n' +
        '  const exe = win ? \'pnpm.cmd\' : \'pnpm\';\n' +
        '  const local = PATH.join(PATH.dirname(process.execPath), exe);\n' +
        '  if (FS.existsSync(local)) return { cmd: local, shell: win };\n' +
        '  return { cmd: \'pnpm\', shell: win };\n' +
        '}\n' +
        'async function runPnpmUpdate(latest) {\n' +
        '  const bin = pnpmBinPath();\n' +
        '  // Pin the explicit target version: pnpm\'s minimum-release-age gate\n' +
        '  // silently skips versions younger than the configured age, which would\n' +
        '  // leave a just-published update unapplied while exiting 0.\n' +
        '  const args = [\'update\', PACKAGE_NAME + \'@\' + latest, \'--registry\', NPM_REGISTRY];\n' +
        '  log(\'running \' + bin.cmd + \' \' + args.join(\' \') + \' in \' + PROFILE_DIR);\n' +
        '  // launchd/systemd run with a minimal PATH; the pnpm corepack shim\n' +
        '  // resolves node via `env node`, so prepend the node directory.\n' +
        '  const env = Object.assign({}, process.env, { PATH: PATH.dirname(process.execPath) + PATH.delimiter + (process.env.PATH || \'\') });\n' +
        '  return await new Promise(function (resolve) {\n' +
        '    const child = CP.spawn(bin.cmd, args, { cwd: PROFILE_DIR, stdio: [\'ignore\', \'pipe\', \'pipe\'], shell: bin.shell, env: env, windowsHide: true });\n' +
        '    let out = \'\';\n' +
        '    let err = \'\';\n' +
        '    if (child.stdout) child.stdout.on(\'data\', function (d) { out += d.toString(); if (out.length > 4000) out = out.slice(-4000); });\n' +
        '    if (child.stderr) child.stderr.on(\'data\', function (d) { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });\n' +
        '    child.on(\'error\', function (e) { log(\'pnpm spawn failed: \' + e.message); resolve(false); });\n' +
        '    child.on(\'close\', function (code) {\n' +
        '      if (code !== 0) log(\'pnpm exited \' + code + \': \' + (err.trim() || out.trim()).slice(0, 500));\n' +
        '      resolve(code === 0);\n' +
        '    });\n' +
        '  });\n' +
        '}\n' +
        'async function activity() {\n' +
        '  try {\n' +
        '    const ctrl = new AbortController();\n' +
        '    const t = setTimeout(function () { ctrl.abort(); }, 5000);\n' +
        '    const res = await fetch(ACTIVITY_URL, { signal: ctrl.signal });\n' +
        '    clearTimeout(t);\n' +
        '    if (!res.ok) return null;\n' +
        '    const body = await res.json();\n' +
        '    return { active: (body.agentsRunning || 0) > 0 || (body.jobsRunning || 0) > 0 };\n' +
        '  } catch (e) { return null; }\n' +
        '}\n' +
        'async function quietThenRestart() {\n' +
        '  log(\'update downloaded; waiting for dsh web to be idle before restarting\');\n' +
        '  let lastBusy = Date.now();\n' +
        '  let unreachableSince = null;\n' +
        '  let quietStreak = 0;\n' +
        '  for (;;) {\n' +
        '    const a = await activity();\n' +
        '    const now = Date.now();\n' +
        '    if (a === null) {\n' +
        '      unreachableSince = unreachableSince === null ? now : unreachableSince;\n' +
        '      if (now - unreachableSince >= DEFER_MAX_MS) {\n' +
        '        log(\'activity endpoint unreachable for \' + Math.round(DEFER_MAX_MS / 1000) + \'s, restarting anyway\');\n' +
        '        break;\n' +
        '      }\n' +
        '    } else {\n' +
        '      unreachableSince = null;\n' +
        '      if (a.active) { lastBusy = now; quietStreak = 0; }\n' +
        '      else {\n' +
        '        quietStreak++;\n' +
        '        if (now - lastBusy >= QUIET_WINDOW_MS && quietStreak >= 2) {\n' +
        '          log(\'dsh web idle, restarting to apply update\');\n' +
        '          break;\n' +
        '        }\n' +
        '      }\n' +
        '    }\n' +
        '    await sleep(30000);\n' +
        '  }\n' +
        '  try { FS.writeFileSync(RESTART_LOCK, String(Date.now())); } catch (e) {}\n' +
        '  await launch();\n' +
        '  await sleep(5000);\n' +
        '  try { FS.unlinkSync(RESTART_LOCK); } catch (e) {}\n' +
        '  try { FS.unlinkSync(UPDATE_PENDING); } catch (e) {}\n' +
        '  try { FS.writeFileSync(UPDATE_CHECK, JSON.stringify({ checkedAt: new Date().toISOString(), local: readLocalVersion(), latest: readLocalVersion(), action: \'restarted\' })); } catch (e) {}\n' +
        '  log(\'dsh web restarted; update active\');\n' +
        '}\n' +
        'async function checkUpdate(apply) {\n' +
        '  const state = { checkedAt: new Date().toISOString() };\n' +
        '  try {\n' +
        '    if (!AUTO_UPDATE && !apply) { state.action = \'disabled\'; writeCheck(state); return; }\n' +
        '    const latest = await fetchLatestVersion();\n' +
        '    if (!latest) { state.action = \'error\'; state.error = \'registry unreachable\'; writeCheck(state); log(\'update check failed: registry unreachable\'); return; }\n' +
        '    const local = readLocalVersion();\n' +
        '    state.local = local || \'unknown\';\n' +
        '    state.latest = latest;\n' +
        '    if (!local) { state.action = \'error\'; state.error = \'cannot read \' + PACKAGE_JSON; writeCheck(state); return; }\n' +
        '    if (!isNewer(latest, local)) {\n' +
        '      state.action = \'up-to-date\';\n' +
        '      if (local === latest) { try { FS.unlinkSync(UPDATE_PENDING); } catch (e) {} }\n' +
        '      writeCheck(state);\n' +
        '      return;\n' +
        '    }\n' +
        '    if (!sameMajor(latest, local)) {\n' +
        '      state.action = \'manual-major\';\n' +
        '      writeCheck(state);\n' +
        '      log(\'new major version \' + latest + \' available (local \' + local + \'); major updates require manual dsh_daemon_update\');\n' +
        '      return;\n' +
        '    }\n' +
        '    if (!apply) { state.action = \'update-available\'; writeCheck(state); return; }\n' +
        '    if (FS.existsSync(UPDATE_LOCK)) { state.action = \'locked\'; writeCheck(state); return; }\n' +
        '    try { FS.writeFileSync(UPDATE_LOCK, String(process.pid)); } catch (e) {}\n' +
        '    try {\n' +
        '      log(\'updating \' + PACKAGE_NAME + \' \' + local + \' -> \' + latest + \' via pnpm\');\n' +
        '      const ok = await runPnpmUpdate(latest);\n' +
        '      const nowLocal = readLocalVersion();\n' +
        '      // pnpm may exit non-zero on peer-dependency warnings yet still\n' +
        '      // apply the update; the source of truth is the installed version.\n' +
        '      if (nowLocal !== latest) {\n' +
        '        state.action = \'error\';\n' +
        '        state.error = \'pnpm update failed or version mismatch (local=\' + nowLocal + \')\';\n' +
        '        log(\'update FAILED: \' + state.error);\n' +
        '      } else {\n' +
        '        if (!ok) log(\'pnpm exited non-zero but \' + PACKAGE_NAME + \' is now \' + nowLocal + \' — treating as applied\');\n' +
        '        if (UPDATE_MODE === \'download\') {\n' +
        '          state.action = \'pending-restart\';\n' +
        '          try { FS.writeFileSync(UPDATE_PENDING, latest); } catch (e) {}\n' +
        '          log(\'update \' + local + \' -> \' + latest + \' downloaded; restart dsh web to activate\');\n' +
        '        } else {\n' +
        '          state.action = \'restart-scheduled\';\n' +
        '          writeCheck(state);\n' +
        '          log(\'scheduling idle-aware restart...\');\n' +
        '          try {\n' +
        '            const waiter = CP.spawn(process.execPath, [__filename, \'--restart-pending\'], { detached: true, stdio: \'ignore\', windowsHide: true });\n' +
        '            waiter.unref();\n' +
        '          } catch (e) { log(\'failed to spawn restart waiter: \' + e.message); }\n' +
        '          return;\n' +
        '        }\n' +
        '      }\n' +
        '    } finally {\n' +
        '      try { FS.unlinkSync(UPDATE_LOCK); } catch (e) {}\n' +
        '    }\n' +
        '  } catch (e) {\n' +
        '    state.action = \'error\';\n' +
        '    state.error = (e && e.message) || String(e);\n' +
        '    log(\'update check error: \' + state.error);\n' +
        '  }\n' +
        '  writeCheck(state);\n' +
        '}\n' +
        '// ---- terminal CLI modes (used by the dsh-daemon command) ------------\n' +
        'function killByPort() {\n' +
        '  let killed = false;\n' +
        '  try {\n' +
        '    if (process.platform === \'win32\') {\n' +
        '      const out = CP.execFileSync(\'netstat\', [\'-ano\'], { encoding: \'utf8\', windowsHide: true });\n' +
        '      const re = new RegExp(\':\' + PORT + \'\\\\s+.*LISTENING\\\\s+(\\\\d+)\');\n' +
        '      const pids = new Set();\n' +
        '      out.split(\'\\n\').forEach(function (line) { const m = re.exec(line); if (m) pids.add(parseInt(m[1], 10)); });\n' +
        '      pids.forEach(function (pid) { try { process.kill(pid, \'SIGKILL\'); killed = true; } catch (e) {} });\n' +
        '    } else {\n' +
        '      const out = CP.execFileSync(\'lsof\', [\'-ti\', \':\' + PORT], { encoding: \'utf8\', windowsHide: true });\n' +
        '      out.trim().split(\'\\n\').forEach(function (line) {\n' +
        '        const pid = parseInt(line.trim(), 10);\n' +
        '        if (pid && pid !== process.pid) { try { process.kill(pid, \'SIGKILL\'); killed = true; } catch (e) {} }\n' +
        '      });\n' +
        '    }\n' +
        '  } catch (e) {}\n' +
        '  return killed;\n' +
        '}\n' +
        'function stopServer(quiet) {\n' +
        '  try { FS.unlinkSync(WEB_STARTED); } catch (e) {}\n' +
        '  const pid = readPid(WEB_PID);\n' +
        '  if (pid && alive(pid)) { try { process.kill(pid, \'SIGKILL\'); } catch (e) {} if (!quiet) console.log(\'  stopped web server (PID \' + pid + \')\'); return true; }\n' +
        '  if (killByPort()) { if (!quiet) console.log(\'  stopped process listening on port \' + PORT); return true; }\n' +
        '  if (!quiet) console.log(\'  no web server is running\');\n' +
        '  return false;\n' +
        '}\n' +
        'async function printStatus() {\n' +
        '  if (!FS.existsSync(INSTALLED)) { console.log(\'🔕 Daemon: not installed\'); console.log(\'   Run dsh_daemon_install (GUI) or dsh-daemon reinstall\'); return; }\n' +
        '  const since = (function () { try { return FS.readFileSync(INSTALLED, \'utf8\').trim(); } catch (e) { return \'unknown\'; } })();\n' +
        '  const port = (function () { try { return FS.readFileSync(PORT_FILE, \'utf8\').trim(); } catch (e) { return String(PORT); } })();\n' +
        '  console.log(\'🔔 Daemon: installed (since \' + since + \')\');\n' +
        '  console.log(\'   Current port: \' + port);\n' +
        '  console.log(\'   Version: \' + (readLocalVersion() || \'unknown\'));\n' +
        '  const check = readCheck();\n' +
        '  if (check) console.log(\'   Update: latest \' + (check.latest || \'?\') + \' — \' + (check.action || \'?\') + (check.error ? \' (\' + check.error + \')\' : \'\'));\n' +
        '  const wpid = readPid(WATCHDOG_PID);\n' +
        '  if (wpid && alive(wpid)) console.log(\'   Watchdog: ✅ running (PID \' + wpid + \')\');\n' +
        '  else if (wpid) console.log(\'   Watchdog: ⚠️  registered but process not found (will restart on next login)\');\n' +
        '  else console.log(\'   Watchdog: ⏳ not yet started (starts on next login or reboot)\');\n' +
        '  // Registration health: the service manager is what brings dsh web back after a\n' +
        '  // reboot or crash. A stale registration (e.g. a plist left behind by a /tmp\n' +
        '  // staging DSH_HOME) must not hide behind a live nohup-spawned watchdog.\n' +
        '  if (process.platform === \'darwin\') {\n' +
        '    try {\n' +
        '      const regText = FS.readFileSync(REG_PLIST, \'utf8\');\n' +
        '      const regMatch = regText.match(/<string>([^<]*watchdog\\.js)<\\/string>/);\n' +
        '      const regSame = (function () {\n' +
        '        if (!regMatch) return false;\n' +
        '        try { return FS.realpathSync(regMatch[1]) === FS.realpathSync(__filename); } catch (e) { return regMatch[1] === __filename; }\n' +
        '      })();\n' +
        '      if (!regSame) {\n' +
        '        console.log(\'   Registration: ❌ stale — \' + REG_PLIST + \' points at a different watchdog path\');\n' +
        '        console.log(\'      fix: dsh-daemon reinstall\');\n' +
        '      } else {\n' +
        '        let regOut = \'\';\n' +
        '        try { regOut = String(CP.execSync(\'launchctl list \' + REG_LABEL, { encoding: \'utf8\' })); } catch (e) { regOut = \'\'; }\n' +
        '        if (!regOut) {\n' +
        '          console.log(\'   Registration: ❌ not loaded in launchd (fix: dsh-daemon reinstall)\');\n' +
        '        } else {\n' +
        '          const mm = regOut.match(/"LastExitStatus"\\s*=\\s*(-?\\d+)/);\n' +
        '          const regExit = mm ? Number(mm[1]) : 0;\n' +
        '          console.log(regExit === 0\n' +
        '            ? \'   Registration: ✅ loaded (\' + REG_LABEL + \')\'\n' +
        '            : \'   Registration: ⚠️  loaded but last exit \' + regExit + \' — fix: dsh-daemon reinstall\');\n' +
        '        }\n' +
        '      }\n' +
        '    } catch (e) { console.log(\'   Registration: ❌ missing — \' + REG_PLIST + \' (fix: dsh-daemon reinstall)\'); }\n' +
        '  }\n' +
        '  if (FS.existsSync(STOPPED)) console.log(\'   Server:   ⏸  manually stopped — run dsh-daemon start\');\n' +
        '  const ok = await healthy();\n' +
        '  if (ok) {\n' +
        '    const tp = readPid(WEB_PID);\n' +
        '    console.log(\'   Web server: ✅ healthy on 127.0.0.1:\' + port + (tp ? \' (PID \' + tp + \')\' : \'\'));\n' +
        '    const lp = listenerPid();\n' +
        '    if (lp && tp && lp !== tp) console.log(\'                ⚠️  port \' + port + \' is served by PID \' + lp + \', but the tracked PID is \' + tp + \' — run dsh-daemon restart to re-track the real server\');\n' +
        '  }\n' +
        '  else {\n' +
        '    const wpid2 = readPid(WEB_PID);\n' +
        '    const up = webUptimeMs();\n' +
        '    if (wpid2 && alive(wpid2) && up > 0 && up < STARTUP_GRACE_MS) {\n' +
        '      console.log(\'   Web server: ⏳ still starting on 127.0.0.1:\' + port + \' (PID \' + wpid2 + \', \' + Math.round(up / 1000) + \'s of \' + Math.round(STARTUP_GRACE_MS / 1000) + \'s startup grace)\');\n' +
        '      console.log(\'                — a slow boot is not a failure; the watchdog only restarts after the grace\');\n' +
        '    } else if (wpid2 && alive(wpid2)) {\n' +
        '      console.log(\'   Web server: ❌ unhealthy on 127.0.0.1:\' + port + \' (PID \' + wpid2 + \' up \' + Math.round(up / 1000) + \'s without serving /health — the watchdog restarts it)\');\n' +
        '    } else if (!(await portListening())) {\n' +
        '      console.log(\'   Web server: ❌ unhealthy on 127.0.0.1:\' + port + \' (nothing listening; no managed web process)\');\n' +
        '    } else {\n' +
        '      console.log(\'   Web server: ❌ unhealthy on 127.0.0.1:\' + port + \' (port is taken by an unmanaged process — check: lsof -ti :\' + port + \')\');\n' +
        '    }\n' +
        '    const tail = webLogTail(3);\n' +
        '    if (tail.length) { console.log(\'   Web log (\' + WEB_LOG + \'):\'); tail.forEach(function (l) { console.log(\'     | \' + l); }); }\n' +
        '    console.log(\'   Details: \' + logsHint() + \'  (raw logs: \' + WEB_LOG + \', \' + WATCHDOG_LOG + \')\');\n' +
        '  }\n' +
        '  try {\n' +
        '    const u = FS.readFileSync(WEB_AUTH_URL_FILE, \'utf8\').trim();\n' +
        '    if (u) console.log(\'   Web auth URL: \' + u + \' (valid while this web process runs)\');\n' +
        '  } catch (e) {}\n' +
        '}\n' +
        'async function restartWeb() {\n' +
        '  if (!FS.existsSync(INSTALLED)) { console.log(\'dsh-daemon: daemon not installed — run install first\'); return 1; }\n' +
        '  if (FS.existsSync(STOPPED)) { console.log(\'dsh-daemon: monitoring paused (dsh-daemon stop) — run start first\'); return 1; }\n' +
        '  console.log(\'dsh-daemon: restarting dsh web on port \' + PORT + \'...\');\n' +
        '  try { FS.writeFileSync(RESTART_LOCK, String(Date.now())); } catch (e) {}\n' +
        '  // launch() stops the tracked process gracefully and waits for the port, so\n' +
        '  // the fresh dsh web cannot die with EADDRINUSE during activation. A\n' +
        '  // listener we do not manage (stale pid file, manual `dsh web`) is cleared\n' +
        '  // here, which is what an explicit restart has always done.\n' +
        '  const tracked = readPid(WEB_PID);\n' +
        '  if (await portListening() && !(tracked && alive(tracked)) && killByPort()) console.log(\'  stopped the unmanaged process on port \' + PORT);\n' +
        '  const launched = await launch();\n' +
        '  if (!launched) console.log(\'  restart skipped: dsh web was launched moments ago\');\n' +
        '  else console.log(\'  launched dsh web (PID \' + (readPid(WEB_PID) || \'?\') + \')\');\n' +
        '  const res = await waitForHealth(STARTUP_GRACE_MS, function (elapsed, pid) {\n' +
        '    console.log(\'  … still starting (\' + Math.round(elapsed / 1000) + \'s/\' + Math.round(STARTUP_GRACE_MS / 1000) + \'s grace, PID \' + pid + \')\');\n' +
        '  });\n' +
        '  try { FS.unlinkSync(RESTART_LOCK); } catch (e) {}\n' +
        '  if (res.ok) console.log(\'✅ dsh web restarted and healthy on port \' + PORT + \' after \' + Math.round(res.ms / 1000) + \'s\');\n' +
        '  else if (res.died) { console.log(\'❌ dsh web exited during startup — last log lines:\'); webLogTail(5).forEach(function (l) { console.log(\'     | \' + l); }); }\n' +
        '  else { console.log(\'⏳ dsh web still starting after \' + Math.round(res.ms / 1000) + \'s — it gets killed and restarted from here; last log lines:\'); webLogTail(5).forEach(function (l) { console.log(\'     | \' + l); }); }\n' +
        '  if (!res.ok) console.log(\'   Details: \' + logsHint() + \'  (raw log: \' + WEB_LOG + \')\');\n' +
        '  return res.ok ? 0 : 1;\n' +
        '}\n' +
        'async function startWeb() {\n' +
        '  try { FS.unlinkSync(STOPPED); } catch (e) {}\n' +
        '  console.log(\'dsh-daemon: monitoring resumed\');\n' +
        '  const wpid = readPid(WATCHDOG_PID);\n' +
        '  if (!(wpid && alive(wpid))) {\n' +
        '    try {\n' +
        '      const fd = FS.openSync(WATCHDOG_LOG, \'a\');\n' +
        '      const child = CP.spawn(process.execPath, [__filename], { detached: true, stdio: [\'ignore\', fd, fd], windowsHide: true });\n' +
        '      child.unref();\n' +
        '      console.log(\'  watchdog was not running — started it\');\n' +
        '    } catch (e) { console.log(\'  failed to start watchdog: \' + e.message); }\n' +
        '  }\n' +
        '  if (await healthy()) { console.log(\'  web server already healthy\'); return 0; }\n' +
        '  const launched = await launch();\n' +
        '  if (launched) console.log(\'  launched dsh web (PID \' + (readPid(WEB_PID) || \'?\') + \')\');\n' +
        '  else console.log(\'  a dsh web launch happened seconds ago — waiting for that one instead of starting another\');\n' +
        '  // A slow dsh web is normal (big plugin set, cold caches). Wait out the\n' +
        '  // whole startup grace that the watchdog honours, so `dsh-daemon start`\n' +
        '  // reports what is really happening instead of a premature verdict.\n' +
        '  const res = await waitForHealth(STARTUP_GRACE_MS, function (elapsed, pid) {\n' +
        '    console.log(\'  … still starting (\' + Math.round(elapsed / 1000) + \'s/\' + Math.round(STARTUP_GRACE_MS / 1000) + \'s grace, PID \' + pid + \')\');\n' +
        '  });\n' +
        '  if (res.ok) console.log(\'✅ dsh web healthy on port \' + PORT + \' after \' + Math.round(res.ms / 1000) + \'s\');\n' +
        '  else if (res.died) { console.log(\'❌ dsh web exited during startup — last log lines:\'); webLogTail(5).forEach(function (l) { console.log(\'     | \' + l); }); }\n' +
        '  else { console.log(\'⏳ dsh web still starting after \' + Math.round(res.ms / 1000) + \'s (startup grace) — the watchdog takes over from here; last log lines:\'); webLogTail(5).forEach(function (l) { console.log(\'     | \' + l); }); }\n' +
        '  if (!res.ok) console.log(\'   Details: \' + logsHint() + \'  (raw log: \' + WEB_LOG + \')\');\n' +
        '  return res.ok ? 0 : 1;\n' +
        '}\n' +
        'async function stopWeb() {\n' +
        '  try { FS.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}\n' +
        '  try { FS.writeFileSync(STOPPED, new Date().toISOString()); } catch (e) {}\n' +
        '  console.log(\'dsh-daemon: monitoring paused — the watchdog will not restart the server\');\n' +
        '  // Graceful first: dsh web disposes cleanly and releases its listener, so a\n' +
        '  // following `dsh-daemon start` cannot race a port that is still held.\n' +
        '  let stopped = false;\n' +
        '  const pid = readPid(WEB_PID);\n' +
        '  if (pid && alive(pid)) { await stopWebServer(pid); stopped = true; }\n' +
        '  if (await portListening()) { if (killByPort()) stopped = true; }\n' +
        '  try { FS.unlinkSync(WEB_PID); } catch (e) {}\n' +
        '  try { FS.unlinkSync(WEB_STARTED); } catch (e) {}\n' +
        '  console.log(stopped ? \'  stopped the web server on port \' + PORT + (pid ? \' (PID \' + pid + \')\' : \'\') : \'  no web server is running\');\n' +
        '  return 0;\n' +
        '}\n' +
        'function printCheckResult() {\n' +
        '  const c = readCheck();\n' +
        '  if (!c) { console.log(\'No update state yet — the watchdog will check at startup.\'); return; }\n' +
        '  console.log(\'   Local:  \' + (c.local || \'unknown\'));\n' +
        '  console.log(\'   Latest: \' + (c.latest || \'unknown\'));\n' +
        '  const map = {\'up-to-date\': \'✅ up to date\', \'update-available\': \'📦 newer version available — run dsh-daemon update --apply\', \'manual-major\': \'⚠️  major version change — install manually with dsh-daemon update --apply\', \'pending-restart\': \'⏳ downloaded — restart dsh web to activate\', \'restart-scheduled\': \'🔄 downloaded — idle-aware restart scheduled\', \'restarted\': \'✅ updated\', \'locked\': \'🔒 another update is in progress\', \'error\': \'❌ \' + (c.error || \'update failed\'), \'disabled\': \'🚫 auto-update is disabled\'};\n' +
        '  console.log(\'   Status: \' + (map[c.action] || c.action));\n' +
        '}\n' +
        '// ---- CLI modes (one-shot, used by dsh_daemon_update) ----------------\n' +
        'const CLI_ARGS = process.argv.slice(2);\n' +
        'if (CLI_ARGS.indexOf(\'--restart-pending\') !== -1) {\n' +
        '  quietThenRestart().then(function () { process.exit(0); }).catch(function (e) { log(\'restart waiter failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--apply-update\') !== -1) {\n' +
        '  checkUpdate(true).then(function () { printCheckResult(); process.exit(0); }).catch(function (e) { log(\'apply-update failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--check-update\') !== -1) {\n' +
        '  checkUpdate(false).then(function () { printCheckResult(); process.exit(0); }).catch(function (e) { log(\'check-update failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--status\') !== -1) {\n' +
        '  printStatus().then(function () { process.exit(0); }).catch(function (e) { log(\'status failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--logs\') !== -1) {\n' +
        '  const logsAt = CLI_ARGS.indexOf(\'--logs\');\n' +
        '  printLogs(CLI_ARGS.slice(logsAt + 1)).then(function (code) { process.exit(code); }).catch(function (e) { console.log(\'logs failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--restart\') !== -1) {\n' +
        '  restartWeb().then(function (code) { process.exit(code); }).catch(function (e) { log(\'restart failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--start\') !== -1) {\n' +
        '  startWeb().then(function (code) { process.exit(code); }).catch(function (e) { log(\'start failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--stop\') !== -1) {\n' +
        '  stopWeb().then(function (code) { process.exit(code); }).catch(function (e) { log(\'stop failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else {\n' +
        'const existing = readPid(WATCHDOG_PID);\n' +
        'if (existing && existing !== process.pid && alive(existing) && isWatchdogProcess(existing)) process.exit(0);\n' +
        'if (existing && alive(existing)) log(\'stale watchdog pid \' + existing + \' is not this watchdog — taking over\');\n' +
        'try { FS.writeFileSync(WATCHDOG_PID, String(process.pid)); } catch (e) {}\n' +
        'if (readPid(WATCHDOG_PID) !== process.pid) process.exit(0);\n' +
        'let shuttingDown = false;\n' +
        'function shutdown() { if (shuttingDown) return; shuttingDown = true; try { FS.unlinkSync(WATCHDOG_PID); } catch (e) {} process.exit(0); }\n' +
        'process.on(\'SIGINT\', shutdown);\n' +
        'process.on(\'SIGTERM\', shutdown);\n' +
        'if (process.platform !== \'win32\') process.on(\'SIGHUP\', shutdown);\n' +
        '(async function () {\n' +
        '  log(\'watchdog started (PID \' + process.pid + \', port \' + PORT + \')\');\n' +
        '  if (FS.existsSync(STOPPED)) { log(\'web server manually stopped; monitoring paused\'); }\n' +
        '  else if (!(await healthy())) {\n' +
        '    log(\'web server not healthy on port \' + PORT + \' at startup, launching... (details: \' + logsHint() + \')\');\n' +
        '    await launch();\n' +
        '    await sleep(3000);\n' +
        '  } else log(\'web server already healthy on port \' + PORT);\n' +
        '  let failures = 0;\n' +
        '  let lastStartingLog = 0;\n' +
        '  let last = Date.now();\n' +
        '  let lastUpdateCheck = Date.now();\n' +
        '  // Ticks must never overlap: a probe can take HEALTH_TIMEOUT_MS and a\n' +
        '  // restart waits out SIGTERM plus the port, i.e. longer than INTERVAL_MS.\n' +
        '  // setInterval does not queue callbacks, but the async bodies still run\n' +
        '  // concurrently, and two overlapping ticks both see "the process is gone"\n' +
        '  // and both launch — the double dsh web that produced EADDRINUSE storms.\n' +
        '  let tickBusy = false;\n' +
        '  if (AUTO_UPDATE) { checkUpdate(true); }\n' +
        '  setInterval(async function () {\n' +
        '    if (tickBusy) return;\n' +
        '    tickBusy = true;\n' +
        '    try {\n' +
        '    const now = Date.now();\n' +
        '    const gap = now - last;\n' +
        '    last = now;\n' +
        '    if (!FS.existsSync(INSTALLED)) { log(\'daemon marker removed, exiting\'); shutdown(); return; }\n' +
        '    if (FS.existsSync(STOPPED)) { failures = 0; return; }\n' +
        '    if (restartLockFresh()) { failures = 0; return; }\n' +
        '    if (AUTO_UPDATE && now - lastUpdateCheck >= UPDATE_INTERVAL_MS) { lastUpdateCheck = now; checkUpdate(true); }\n' +
        '    if (gap > SLEEP_GAP_MS) {\n' +
        '      log(\'sleep/wake detected (gap=\' + Math.round(gap / 1000) + \'s), restarting web server\');\n' +
        '      await launch(); failures = 0; return;\n' +
        '    }\n' +
        '    if (await healthy()) {\n' +
        '      failures = 0;\n' +
        '      // Healthy does not prove the tracked PID is the one serving: a launch\n' +
        '      // race can leave the pid file on a process that is already gone while\n' +
        '      // the winner keeps answering /health. Adopt it instead of ignoring it.\n' +
        '      const tp = readPid(WEB_PID);\n' +
        '      if (!(tp && alive(tp))) {\n' +
        '        const lp = listenerPid();\n' +
        '        if (lp && lp !== process.pid) {\n' +
        '          if (isDshWebProcess(lp) !== false) {\n' +
        '            try { FS.writeFileSync(WEB_PID, String(lp)); } catch (e) {}\n' +
        '            if (!webStartedAt()) { try { FS.writeFileSync(WEB_STARTED, String(Date.now())); } catch (e) {} }\n' +
        '            log(\'adopted the running dsh web (PID \' + lp + \') — the pid file pointed at a process that is gone\');\n' +
        '          } else {\n' +
        '            log(\'port \' + PORT + \' answers /health but a non-dsh process holds it (PID \' + lp + \') — check: lsof -ti :\' + PORT);\n' +
        '          }\n' +
        '        }\n' +
        '      }\n' +
        '      return;\n' +
        '    }\n' +
        '    else if (webStarting()) {\n' +
        '      // A slow boot must never count as a failure: killing it here is what\n' +
        '      // used to make dsh-daemon unable to start a dsh web that starts fine\n' +
        '      // (just slowly) by hand.\n' +
        '      failures = 0;\n' +
        '      if (now - lastStartingLog >= STARTUP_LOG_EVERY_MS) {\n' +
        '        lastStartingLog = now;\n' +
        '        log(\'dsh web still starting (\' + Math.round(webUptimeMs() / 1000) + \'s of \' + Math.round(STARTUP_GRACE_MS / 1000) + \'s grace, PID \' + readPid(WEB_PID) + \') — not restarting\');\n' +
        '      }\n' +
        '    }\n' +
        '    else {\n' +
        '      const pid = readPid(WEB_PID);\n' +
        '      if (!(pid && alive(pid))) {\n' +
        '        // The process is gone (crash, EADDRINUSE at activation, OOM).\n' +
        '        // Restart now instead of waiting out the failure threshold.\n' +
        '        failures = 0;\n' +
        '        // An unmanaged listener already serving the port must be adopted,\n' +
        '        // never shadowed by a second dsh web (that one can only die with\n' +
        '        // EADDRINUSE — the launch storm).\n' +
        '        if (await portListening()) {\n' +
        '          const lp = listenerPid();\n' +
        '          if (lp && lp !== process.pid && isDshWebProcess(lp) !== false) {\n' +
        '            try { FS.writeFileSync(WEB_PID, String(lp)); } catch (e) {}\n' +
        '            if (!webStartedAt()) { try { FS.writeFileSync(WEB_STARTED, String(Date.now())); } catch (e) {} }\n' +
        '            log(\'adopted the running dsh web (PID \' + lp + \') — pid file pointed at a process that is gone\');\n' +
        '          } else {\n' +
        '            log(\'port \' + PORT + \' is held by an unmanaged process — not launching a second dsh web (check: lsof -ti :\' + PORT + \')\');\n' +
        '          }\n' +
        '          return;\n' +
        '        }\n' +
        '        if (await launch()) { log(\'web server process was not running — restarted it (details: \' + logsHint() + \')\'); }\n' +
        '        return;\n' +
        '      }\n' +
        '      failures++;\n' +
        '      log(\'health check failed (\' + failures + \'/\' + FAIL_THRESHOLD + \')\');\n' +
        '      if (failures >= FAIL_THRESHOLD) {\n' +
        '        // Another PID holding the port means the tracked PID is the stale one:\n' +
        '        // adopt the real listener instead of killing a server we do not manage.\n' +
        '        const lp = listenerPid();\n' +
        '        if (lp && lp !== pid && isDshWebProcess(lp) === true) {\n' +
        '          try { FS.writeFileSync(WEB_PID, String(lp)); } catch (e) {}\n' +
        '          log(\'failure threshold reached, but PID \' + pid + \' does not hold the port — adopted the real listener (PID \' + lp + \') instead of restarting\');\n' +
        '          failures = 0;\n' +
        '          return;\n' +
        '        }\n' +
        '        log(\'failure threshold reached, restarting web server (details: \' + logsHint() + \')\');\n' +
        '        await launch(); failures = 0;\n' +
        '      }\n' +
        '    }\n' +
        '    } finally { tickBusy = false; }\n' +
        '  }, INTERVAL_MS);\n' +
        '})().catch(function (err) { log(\'watchdog fatal: \' + (err && err.stack ? err.stack : String(err))); shutdown(); });\n' +
        '}\n';
    }

    function plistContent(cfg, p) {
      return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0">\n<dict>\n' +
        '  <key>Label</key>\n  <string>' + LABEL + '</string>\n' +
        '  <key>ProgramArguments</key>\n  <array>\n' +
        '    <string>' + xmlEscape(cfg.nodePath) + '</string>\n' +
        '    <string>' + xmlEscape(p.watchdogJs) + '</string>\n' +
        '  </array>\n' +
        '  <key>EnvironmentVariables</key>\n  <dict>\n' +
        '    <key>DSH_WEB_PORT</key>\n    <string>' + xmlEscape(cfg.port) + '</string>\n' +
        '    <key>DSH_HOME</key>\n    <string>' + xmlEscape(cfg.dshHome) + '</string>\n' +
        '  </dict>\n' +
        '  <key>RunAtLoad</key>\n  <true/>\n' +
        '  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n' +
        '  <key>ThrottleInterval</key>\n  <integer>10</integer>\n' +
        '</dict>\n</plist>\n';
    }

    function systemdUnit(cfg, p) {
      return '[Unit]\n' +
        'Description=dsh watchdog (health monitor and auto-restart)\n' +
        'After=network.target\n\n' +
        '[Service]\n' +
        'Type=simple\n' +
        'Environment=DSH_WEB_PORT=' + String(cfg.port) + '\n' +
        'Environment=DSH_HOME=' + cfg.dshHome + '\n' +
        'ExecStart=' + cfg.nodePath + ' ' + p.watchdogJs + '\n' +
        'Restart=always\n' +
        'RestartSec=10\n' +
        'StartLimitIntervalSec=0\n\n' +
        '[Install]\n' +
        'WantedBy=default.target\n';
    }

    // ---- Windows: VBS launcher + Task Scheduler XML ----------------------
    // Mirrors the wecode Windows daemon: a hidden wscript launcher that sets
    // the daemon env and runs `node watchdog.js`, registered as a logon task
    // with restart-on-failure.
    function vbsContent(cfg, p) {
      const q = 'Chr(34)';
      return [
        'Set shell = CreateObject("WScript.Shell")',
        'shell.Environment("Process")("DSH_WEB_PORT") = "' + String(cfg.port) + '"',
        'shell.Environment("Process")("DSH_HOME") = "' + cfg.dshHome + '"',
        'shell.Run ' + q + ' & "' + cfg.nodePath + '" & ' + q + ' & " " & ' + q + ' & "' + p.watchdogJs + '" & ' + q + ', 0, True',
        '',
      ].join('\r\n');
    }

    function taskXmlContent(cfg, p, username) {
      const e = xmlEscape;
      return '<?xml version="1.0" encoding="UTF-16"?>\n' +
        '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n' +
        '  <RegistrationInfo>\n' +
        '    <Description>dsh watchdog (health monitor and auto-restart)</Description>\n' +
        '  </RegistrationInfo>\n' +
        '  <Triggers>\n' +
        '    <LogonTrigger>\n' +
        '      <Enabled>true</Enabled>\n' +
        '      <UserId>' + e(username) + '</UserId>\n' +
        '    </LogonTrigger>\n' +
        '  </Triggers>\n' +
        '  <Principals>\n' +
        '    <Principal id="Author">\n' +
        '      <UserId>' + e(username) + '</UserId>\n' +
        '      <LogonType>InteractiveToken</LogonType>\n' +
        '      <RunLevel>LeastPrivilege</RunLevel>\n' +
        '    </Principal>\n' +
        '  </Principals>\n' +
        '  <Settings>\n' +
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n' +
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n' +
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n' +
        '    <AllowHardTerminate>true</AllowHardTerminate>\n' +
        '    <StartWhenAvailable>true</StartWhenAvailable>\n' +
        '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>\n' +
        '    <AllowStartOnDemand>true</AllowStartOnDemand>\n' +
        '    <Enabled>true</Enabled>\n' +
        '    <Hidden>false</Hidden>\n' +
        '    <RunOnlyIfIdle>false</RunOnlyIfIdle>\n' +
        '    <WakeToRun>false</WakeToRun>\n' +
        '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n' +
        '    <Priority>7</Priority>\n' +
        '    <RestartOnFailure>\n' +
        '      <Interval>PT1M</Interval>\n' +
        '      <Count>999</Count>\n' +
        '    </RestartOnFailure>\n' +
        '  </Settings>\n' +
        '  <Actions Context="Author">\n' +
        '    <Exec>\n' +
        '      <Command>wscript.exe</Command>\n' +
        '      <Arguments>' + e('//B "' + p.vbs + '"') + '</Arguments>\n' +
        '    </Exec>\n' +
        '  </Actions>\n' +
        '</Task>\n';
    }

    // ---- dsh-daemon terminal command (thin wrapper) -----------------------
    // A generated `dsh-daemon` executable on PATH that forwards to the
    // watchdog script (supervision: status/restart/start/stop/update) or to
    // the plugin's /dsh-daemon/command route (registration: install/
    // uninstall/reinstall, which need the harness services).
    function cliWrapperBash(cfg, p) {
      return '#!/usr/bin/env bash\n' +
        '# dsh-daemon — command-line control for the dsh daemon (generated; regenerate with dsh_daemon_reinstall)\n' +
        'NODE=' + JSON.stringify(cfg.nodePath) + '\n' +
        'WATCHDOG=' + JSON.stringify(p.watchdogJs) + '\n' +
        'PORT=' + String(cfg.port) + '\n' +
        'case "${1:-help}" in\n' +
        '  status|restart|start|stop)\n' +
        '    exec "$NODE" "$WATCHDOG" "--$1" ;;\n' +
        '  logs)\n' +
        '    # Startup-failure detail: last N lines of the dsh web and watchdog logs.\n' +
        '    shift; exec "$NODE" "$WATCHDOG" --logs "$@" ;;\n' +
        '  update)\n' +
        '    if [ "${2:-}" = "--apply" ]; then exec "$NODE" "$WATCHDOG" --apply-update; else exec "$NODE" "$WATCHDOG" --check-update; fi ;;\n' +
        '  install|uninstall|reinstall)\n' +
        '    env_json=$(env | sed -n \'s/^\\(DSH_DAEMON_[A-Z0-9_]*\\)=\\(.*\\)$/\\"\\1\\":\\"\\2\\"/p\' | paste -sd, -)\n' +
        '    if [ -n "$env_json" ]; then body="{\\"cmd\\":\\"$1\\",\\"env\\":{$env_json}}"; else body="{\\"cmd\\":\\"$1\\"}"; fi\n' +
        '    out=$(curl -s -X POST -H "Content-Type: application/json" -d "$body" "http://127.0.0.1:${PORT}/dsh-daemon/command")\n' +
        '    exec "$NODE" -e "const j=JSON.parse(process.argv[1]);process.stdout.write(j.output||j.error||\'\');process.exit(j.ok?0:1)" "$out" ;;\n' +
        '  help|-h|--help)\n' +
        '    echo "Usage: dsh-daemon <status|restart|start|stop|logs|install|uninstall|reinstall|update [--apply]|help>"\n' +
        '    echo "  logs [-n N] [--web|--watchdog]   show dsh web + watchdog logs (startup failures)" ;;\n' +
        '  *)\n' +
        '    echo "dsh-daemon: unknown command \'$1\' (see \'dsh-daemon help\')" >&2; exit 2 ;;\n' +
        'esac\n';
    }

    function cliWrapperCmd(cfg, p) {
      return '@echo off\r\n' +
        'rem dsh-daemon - command-line control for the dsh daemon (generated; regenerate with dsh_daemon_reinstall)\r\n' +
        'set "NODE=' + cfg.nodePath + '"\r\n' +
        'set "WATCHDOG=' + p.watchdogJs + '"\r\n' +
        'set "PORT=' + String(cfg.port) + '"\r\n' +
        'if "%1"=="install" goto http\r\n' +
        'if "%1"=="uninstall" goto http\r\n' +
        'if "%1"=="reinstall" goto http\r\n' +
        'if "%1"=="update" (\r\n' +
        '  if "%2"=="--apply" ("%NODE%" "%WATCHDOG%" --apply-update) else ("%NODE%" "%WATCHDOG%" --check-update)\r\n' +
        '  exit /b %errorlevel%\r\n' +
        ')\r\n' +
        'if "%1"=="status" ("%NODE%" "%WATCHDOG%" --status) & exit /b %errorlevel%\r\n' +
        'if "%1"=="restart" ("%NODE%" "%WATCHDOG%" --restart) & exit /b %errorlevel%\r\n' +
        'if "%1"=="start" ("%NODE%" "%WATCHDOG%" --start) & exit /b %errorlevel%\r\n' +
        'if "%1"=="stop" ("%NODE%" "%WATCHDOG%" --stop) & exit /b %errorlevel%\r\n' +
        'if "%1"=="logs" ("%NODE%" "%WATCHDOG%" --logs %2 %3) & exit /b %errorlevel%\r\n' +
        'if "%1"=="help" (echo Usage: dsh-daemon status^|restart^|start^|stop^|logs^|install^|uninstall^|reinstall^|update [--apply]^|help & echo   logs [-n N] [--web^|--watchdog]   show dsh web + watchdog logs & exit /b 0)\r\n' +
        'echo dsh-daemon: unknown command "%1" 1>&2 & exit /b 2\r\n' +
        ':http\r\n' +
        '"%NODE%" -e "const env={};for(const k of Object.keys(process.env)){if(k.startsWith(\'DSH_DAEMON_\'))env[k]=process.env[k]}const body=JSON.stringify({cmd:process.argv[1],env});fetch(\'http://127.0.0.1:%PORT%/dsh-daemon/command\',{method:\'POST\',headers:{\'content-type\':\'application/json\'},body}).then(r=>r.json()).then(j=>{process.stdout.write(j.output||j.error||\'\');process.exit(j.ok?0:1)}).catch(e=>{process.stderr.write(String(e));process.exit(1)})" %1\r\n' +
        'exit /b %errorlevel%\r\n';
    }

    async function cliWrapperPath(cfg) {
      const win = await isWindows();
      // DSH_DAEMON_CLI_DIR overrides the write target so tests and
      // sandboxed installs never pollute the real node bin directory
      // (the CLI wrapper is always placed on PATH, but a test harness
      // points it at a temp dir instead).
      const override = process.env.DSH_DAEMON_CLI_DIR;
      if (override) {
        return String(override).replace(/\\/g, '/') + (win ? '/dsh-daemon.cmd' : '/dsh-daemon');
      }
      // process.execPath on Windows uses backslashes; normalize to forward
      // slashes so the separator scan below works on both platforms
      // (paths() already normalizes everything else the same way).
      const nodePath = String(cfg.nodePath).replace(/\\/g, '/');
      const nodeDir = nodePath.slice(0, nodePath.lastIndexOf('/'));
      // The default target is the node bin directory: user-managed node
      // installs (nvm/fnm/volta, pnpm's shims, …) keep it writable AND on
      // PATH. System node (/usr/bin/node, /usr/local/bin/node, …) lives in
      // a root-owned, package-manager territory — the write fails outright
      // (and would be wiped by the next system upgrade even if it didn't).
      // Fall back to ~/.local/bin, the conventional user-local bin dir.
      if (!win) {
        const writable = await sh('test -w ' + sq(nodeDir), 5000);
        if (writable.exitCode !== 0) {
          return String(cfg.home) + '/.local/bin/dsh-daemon';
        }
      }
      return nodeDir + (win ? '/dsh-daemon.cmd' : '/dsh-daemon');
    }

    async function dirOnPath(dir) {
      const pathv = await shOut('echo $PATH');
      return String(pathv || '').split(':').indexOf(String(dir)) >= 0;
    }

    async function generateCliWrapper(cfg, p) {
      const win = await isWindows();
      const target = await cliWrapperPath(cfg);
      // The ~/.local/bin fallback may not exist yet on a fresh system-node
      // install (some distros only add it to PATH once it exists); node bin
      // dirs always exist, so only the fallback target needs creating.
      if (!win && target.indexOf(String(cfg.home) + '/.local/bin/') === 0) {
        await shellMkdir(String(cfg.home) + '/.local/bin');
      }
      if (win) {
        await writeFile(target, cliWrapperCmd(cfg, p));
      } else {
        await writeFile(target, cliWrapperBash(cfg, p));
        await sh('chmod +x ' + sq(target));
      }
      return target;
    }

    // ---- regenerate on version change -----------------------------------
    // Auto-update refreshes the npm package but not the already-generated
    // watchdog script. This compares the script's GEN_VERSION against the
    // installed package version and, when they differ, rewrites watchdog.js
    // and the dsh-daemon CLI wrapper from the current generator, then
    // restarts the watchdog so the new script takes effect. Called on every
    // plugin boot; no-ops when the daemon is not installed or already current.
    // ---- registration drift repair -----------------------------------------
    // The service-manager registration is what restores dsh web after a reboot or a
    // crash. A previous install could bake a since-vanished watchdog path into it
    // (observed in the wild: a /tmp/dshd-*-staging DSH_HOME that got cleaned), leaving
    // the LaunchAgent/systemd unit permanently broken while a nohup-spawned watchdog
    // keeps the web server alive — so the breakage is silent. Re-emit the registration
    // whenever the recorded path is missing or no longer matches the current one.
    async function repairRegistrationIfDrifted(full, pp) {
      // DSH_DAEMON_NO_SYSTEM=1 skips only the service-manager calls below; the
      // registration FILE is still repaired so the drift logic stays testable.
      const skipSystem = noSystem();
      try {
        const plat = await platform();
        if (plat === 'mac') {
          const want = '<string>' + xmlEscape(pp.watchdogJs) + '</string>';
          const plist = await readFileSafe(pp.plist);
          if (plist && plist.indexOf(want) !== -1) return;   // registration is current
          await shellMkdir(String(pp.plist).replace(/\/[^/]*$/, ''));
          await writeFile(pp.plist, plistContent(full, pp));
          if (!skipSystem) await sh('launchctl unload ' + sq(pp.plist) + ' 2>/dev/null; true');
          const load = skipSystem ? { exitCode: -1 } : await sh('launchctl load -w ' + sq(pp.plist));
          await sh('printf "%s\\n" "[' + new Date().toISOString() + '] [plugin] repaired stale LaunchAgent (' + (plist ? 'watchdog path mismatch' : 'plist missing') + ', launchctl exit ' + load.exitCode + ')" >> ' + sq(pp.watchdogLog));
        } else if (plat === 'linux') {
          const want = 'ExecStart=' + full.nodePath + ' ' + pp.watchdogJs;
          const unit = await readFileSafe(pp.unit);
          if (unit && unit.indexOf(want) !== -1) return;     // registration is current
          await shellMkdir(pp.unitDir);
          await writeFile(pp.unit, systemdUnit(full, pp));
          if (!skipSystem) await sh('systemctl --user daemon-reload 2>/dev/null; true');
          if (!skipSystem) await sh('systemctl --user enable --now ' + sq(SYSTEMD_UNIT + '.service') + ' 2>/dev/null; true');
          await sh('printf "%s\\n" "[' + new Date().toISOString() + '] [plugin] repaired stale systemd unit" >> ' + sq(pp.watchdogLog));
        }
      } catch (e) { /* best-effort: never break boot */ }
    }

    async function regenerateWatchdogIfStale() {
      // Test harnesses and development loads must not rewrite the real
      // daemon: DSH_DAEMON_AUTOREGEN=0 opts out of the boot-time sync.
      try {
        if (String(process.env.DSH_DAEMON_AUTOREGEN) === '0') return;
      } catch (e) { return; }
      let cfg;
      let p;
      let upToDate = false;
      try {
        const h = await homeAndDshHome();
        cfg = { home: h.home, dshHome: h.dshHome, port: DEFAULT_PORT };
        p = paths(cfg);
        const existing = await readFileSafe(p.watchdogJs);
        if (!existing) return; // daemon not installed
        const m = existing.match(/const GEN_VERSION = ['"]([^'"]+)['"]/);
        upToDate = !!(m && m[1] === currentVersion());
      } catch (e) { return; } // not installed / unreadable — leave alone

      try {
        const full = await discover(cfg.port);
        const pp = paths(full);
        // Registration drift is repaired even when the watchdog script itself is current:
        // an older install can have baked a since-deleted path (e.g. a /tmp staging home)
        // into the service registration, which the version check above cannot see.
        await repairRegistrationIfDrifted(full, pp);
        if (upToDate) return; // script already current; the drift repair above was the work
        const uopts = await updateConfig();
        await shellMkdir(pp.dir, pp.logDir);
        await writeFile(pp.watchdogJs, watchdogScript(full, pp, uopts));
        await writeFile(pp.installed, new Date().toISOString());
        await writeFile(pp.portFile, String(full.port));
        let cliPath = null;
        try {
          cliPath = await generateCliWrapper(full, pp);
        } catch (e) { /* CLI is optional; watchdog is the load-bearing piece */ }
        // Restart the watchdog so the regenerated script is what runs.
        const wpid = ((await readFileSafe(pp.watchdogPid)) || '').trim();
        if (wpid && await pidAlive(wpid)) {
          if (await isWindows()) await sh('taskkill /PID ' + wpid + ' /F 2>$null', 8000);
          else await sh('kill -TERM ' + wpid + ' 2>/dev/null; sleep 1; kill -KILL ' + wpid + ' 2>/dev/null; true', 8000);
        }
        await shellRm(pp.watchdogPid);
        const plat = await platform();
        if (plat === 'mac') {
          await sh('nohup ' + sq(full.nodePath) + ' ' + sq(pp.watchdogJs) + ' >> ' + sq(pp.watchdogLog) + ' 2>&1 &');
        } else if (plat === 'linux') {
          await sh('nohup ' + sq(full.nodePath) + ' ' + sq(pp.watchdogJs) + ' >> ' + sq(pp.watchdogLog) + ' 2>&1 &');
        } else if (plat === 'win') {
          await sh('schtasks /Run /TN ' + TASK_NAME + ' 2>$null', 10000);
        }
        // Log the regeneration (and the CLI path when one was written).
        const cliNote = cliPath ? '; CLI ' + cliPath : '';
        const log = pp.watchdogLog;
        try {
          await sh('printf "%s\\n" "[' + new Date().toISOString() + '] [plugin] regenerated watchdog (' + (currentVersion()) + ')' + cliNote + '" >> ' + sq(log));
        } catch (e) { /* log best-effort */ }
      } catch (e) { /* regeneration is best-effort; do not break boot */ }
    }

    // ---- install / uninstall --------------------------------------------
    // DSH_DAEMON_NO_SYSTEM=1 skips real system registration (launchctl,
    // schtasks, systemd) so test harnesses and sandboxed installs can
    // exercise the full generation logic without touching the host. The
    // watchdog is still started directly (nohup) so behaviour stays real.
    function noSystem() {
      try { return String(process.env.DSH_DAEMON_NO_SYSTEM) === '1'; } catch (e) { return false; }
    }
    async function doInstall(portArg, envOverrides) {
      const lines = [];
      const say = (m) => lines.push(m);
      const cfg = await discover(portArg);
      // A registration baked with an ephemeral DSH_HOME (e.g. /tmp/dshd-*) rots as soon as
      // that temp dir is cleaned: the LaunchAgent keeps pointing at a deleted watchdog
      // script and supervision silently disappears, while status keeps reporting the
      // nohup-spawned watchdog as healthy. Register against the canonical home instead;
      // DSH_DAEMON_ALLOW_EPHEMERAL_HOME=1 opts out, and test runs (DSH_DAEMON_NO_SYSTEM=1)
      // are never redirected.
      const allowEphemeralHome = String(process.env.DSH_DAEMON_ALLOW_EPHEMERAL_HOME || '') === '1';
      const EPHEMERAL_HOME = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/)/;
      if (!noSystem() && !allowEphemeralHome && EPHEMERAL_HOME.test(String(cfg.dshHome))) {
        const canonical = String(cfg.home).replace(/\/+$/, '') + '/.dsh';
        say('   \u26a0\ufe0f  DSH_HOME looks ephemeral: ' + cfg.dshHome);
        say('      registering with ' + canonical + ' instead (set DSH_DAEMON_ALLOW_EPHEMERAL_HOME=1 to keep it)');
        cfg.dshHome = canonical;
      }
      const p = paths(cfg);
      const uopts = await updateConfig(envOverrides);
      const plat = await platform();
      const isMac = plat === 'mac';
      const isLinux = plat === 'linux';
      const isWin = plat === 'win';
      say('📦 Installing dsh daemon...');
      say('   Captured DSH_WEB_PORT=' + cfg.port + ' for the daemon service');
      say('   dsh CLI: ' + cfg.dshBin);
      say('   node: ' + cfg.nodePath);
      await shellMkdir(p.dir, p.logDir);
      await writeFile(p.watchdogJs, watchdogScript(cfg, p, uopts));
      say('   Wrote watchdog script: ' + p.watchdogJs);
      say('   Auto-update: ' + (uopts.autoUpdate ? 'enabled (every ' + formatDuration(uopts.updateIntervalMs) + ', mode ' + uopts.updateMode + ')' : 'disabled'));
      say('   Web launch flags: ' + (dshNoOpenSupported(cfg.dshVersion)
        ? '--no-open (dsh ' + (cfg.dshVersion || '?') + ' >= ' + DSH_NO_OPEN_MIN + ')'
        : 'none (dsh ' + (cfg.dshVersion || 'unknown') + ' predates ' + DSH_NO_OPEN_MIN + ') — no browser popup on this dsh anyway'));
      say('   Web auth: ' + (dshTokenAuthSupported(cfg.dshVersion)
        ? 'token mode (dsh ' + (cfg.dshVersion || '?') + ' >= ' + DSH_TOKEN_AUTH_MIN + ') — watchdog opens the launch-token URL once per launch to seed the 30d cookie' + (uopts.openBrowser ? '' : ' (browser open disabled via DSH_DAEMON_OPEN_BROWSER=0; URL written to ' + p.webAuthUrl + ')')
        : 'not applicable (dsh ' + (cfg.dshVersion || 'unknown') + ' predates ' + DSH_TOKEN_AUTH_MIN + ')'));
      await writeFile(p.installed, new Date().toISOString());
      await writeFile(p.portFile, String(cfg.port));
      await shellRm(p.stopped);
      if (isMac) {
        await writeFile(p.plist, plistContent(cfg, p));
        say('   Wrote LaunchAgent: ' + p.plist);
        if (noSystem()) {
          say('   [test] skipped launchd registration (DSH_DAEMON_NO_SYSTEM=1)');
          await sh('nohup ' + sq(cfg.nodePath) + ' ' + sq(p.watchdogJs) + ' >> ' + sq(p.watchdogLog) + ' 2>&1 &');
          say('   Started watchdog for the current session');
        } else {
          await sh('launchctl unload ' + sq(p.plist) + ' 2>/dev/null; true');
          const load = await sh('launchctl load -w ' + sq(p.plist));
          if (load.exitCode !== 0) throw new Error('launchctl load failed: ' + (load.stderr || load.stdout));
          say('   Registered with launchd (RunAtLoad + KeepAlive)');
          let started = false;
          for (let i = 0; i < 10; i++) {
            const pid = ((await readFileSafe(p.watchdogPid)) || '').trim();
            if (pid && await pidAlive(pid)) { started = true; break; }
            await sleep(300);
          }
          if (started) say('   Watchdog started for the current session');
          else {
            await sh('nohup ' + sq(cfg.nodePath) + ' ' + sq(p.watchdogJs) + ' >> ' + sq(p.watchdogLog) + ' 2>&1 &');
            say('   launchd did not report the watchdog yet — started it directly');
          }
        }
      } else if (isLinux) {
        if (noSystem()) {
          say('   [test] skipped systemd/cron registration (DSH_DAEMON_NO_SYSTEM=1)');
        } else {
          const probe = await sh('systemctl --user status 2>/dev/null; echo ok', 8000);
          if (probe.exitCode === 0) {
            try {
              await sh('mkdir -p ' + sq(p.unitDir));
              await writeFile(p.unit, systemdUnit(cfg, p));
              say('   Wrote systemd user unit: ' + p.unit);
              await sh('systemctl --user daemon-reload', 15000);
              await sh('systemctl --user enable --now ' + SYSTEMD_UNIT, 20000);
              say('   Registered with systemd (Restart=always)');
              say('   ℹ️  For service start without a user session: loginctl enable-linger');
            } catch (err) {
              await sh('rm -f ' + sq(p.unit) + '; true');
              say('   systemd registration failed, falling back to cron: ' + (err && err.message));
              await cronInstall(cfg, p, say);
            }
          } else {
            await cronInstall(cfg, p, say);
          }
        }
        await sh('nohup ' + sq(cfg.nodePath) + ' ' + sq(p.watchdogJs) + ' >> ' + sq(p.watchdogLog) + ' 2>&1 &');
        say('   Started watchdog for the current session');
      } else if (isWin) {
        const username = await shOut('whoami', 8000);
        await writeFile(p.vbs, vbsContent(cfg, p));
        say('   Wrote watchdog launcher: ' + p.vbs);
        if (noSystem()) {
          say('   [test] skipped Task Scheduler registration (DSH_DAEMON_NO_SYSTEM=1)');
          await sh('Start-Process -FilePath ' + psq(cfg.nodePath) + ' -ArgumentList ' + psq(p.watchdogJs) + ' -WindowStyle Hidden');
          say('   Started watchdog for the current session');
        } else {
          await writeFile(p.taskXml, taskXmlContent(cfg, p, username || ''));
          // schtasks requires the task XML in UTF-16LE with a BOM; fs writes
          // UTF-8, so re-encode in-place with PowerShell.
          const enc = await sh('$p=' + psq(p.taskXml) + '; $c=[IO.File]::ReadAllText($p); [IO.File]::WriteAllText($p, $c, [Text.Encoding]::Unicode)');
          if (enc.exitCode !== 0) throw new Error('failed to encode task XML as UTF-16: ' + (enc.stderr || enc.stdout));
          say('   Wrote Task Scheduler XML: ' + p.taskXml);
          await sh('schtasks /Delete /TN ' + TASK_NAME + ' /F 2>$null', 10000);
          const create = await sh('schtasks /Create /TN ' + TASK_NAME + ' /XML ' + psq(p.taskXml) + ' /F', 20000);
          if (create.exitCode !== 0) throw new Error('schtasks /Create failed (exit ' + create.exitCode + '): ' + (create.stderr || create.stdout));
          say('   Registered with Task Scheduler (task: ' + TASK_NAME + ', restart-on-failure enabled)');
          const run = await sh('schtasks /Run /TN ' + TASK_NAME, 10000);
          if (run.exitCode !== 0) say('   ⚠️  schtasks /Run failed (exit ' + run.exitCode + '), task will start at next logon');
          else say('   Started watchdog task for the current session');
        }
      } else {
        throw new Error('Unsupported platform: ' + plat);
      }
      try {
        const cliPath = await generateCliWrapper(cfg, p);
        say('   Wrote CLI: ' + cliPath + ' — run `dsh-daemon help`');
        const localBin = String(cfg.home) + '/.local/bin';
        if (cliPath.indexOf(localBin + '/') === 0 && !(await dirOnPath(localBin))) {
          say('   ⚠️  ' + localBin + ' is not on PATH — add it to your shell profile');
          say('      (e.g. echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc) and reopen the terminal');
        }
      } catch (e) {
        say('   ⚠️  failed to write the dsh-daemon CLI: ' + (e && e.message));
      }
      say('');
      say('✅ Daemon installed. The dsh web server will now:');
      say('   • Start automatically on login');
      say('   • Restart automatically after sleep/wake');
      say('   • Self-heal if the server becomes unresponsive');
      say('');
      say('Available tools:');
      say('   dsh_daemon_status      — show daemon + watchdog + server status');
      say('   dsh_daemon_logs        — show dsh web + watchdog logs (startup failures)');
      say('   dsh_daemon_start       — resume monitoring (clears stopped flag)');
      say('   dsh_daemon_stop        — pause monitoring (watchdog will not restart)');
      say('   dsh_daemon_reinstall   — refresh registration after upgrade or port change');
      say('   dsh_daemon_uninstall   — remove daemon registration');
      say('');
      say('Terminal: dsh-daemon logs — last log lines when dsh web fails to start.');
      say('');
      say('Port changes: pass port to dsh_daemon_install/reinstall, or set DSH_WEB_PORT.');
      return lines.join('\n');
    }

    async function cronInstall(cfg, p, say) {
      const line = '@reboot ' + cfg.nodePath + ' ' + p.watchdogJs + ' >> ' + p.watchdogLog + ' 2>&1';
      const current = await shOut('crontab -l 2>/dev/null', 8000);
      if (current.split('\n').some((l) => l.indexOf(p.watchdogJs) !== -1)) {
        say('   cron @reboot entry already exists');
      } else {
        const next = current ? current + '\n' + line + '\n' : line + '\n';
        const r = await sh('printf \'%s\n\' ' + sq(next) + ' | crontab -', 8000);
        if (r.exitCode !== 0) {
          say('   ⚠️  crontab update failed: ' + (r.stderr || r.stdout));
          say('   Auto-start on reboot unavailable; run dsh_daemon_install again after each reboot');
        } else say('   Added cron @reboot entry (no systemd detected)');
      }
    }

    async function doUninstall() {
      const lines = [];
      const say = (m) => lines.push(m);
      const { home, dshHome } = await homeAndDshHome();
      const p = paths({ home, dshHome });
      const plat = await platform();
      const isMac = plat === 'mac';
      const isLinux = plat === 'linux';
      const isWin = plat === 'win';
      say('🗑  Uninstalling dsh daemon...');
      const wpid = ((await readFileSafe(p.watchdogPid)) || '').trim();
      if (wpid) {
        if (isWin) {
          await sh('taskkill /PID ' + wpid + ' /F 2>$null', 8000);
        } else {
          await sh('kill -TERM ' + wpid + ' 2>/dev/null; sleep 1; kill -KILL ' + wpid + ' 2>/dev/null; true', 8000);
        }
        say('   Stopped watchdog (PID ' + wpid + ')');
      }
      if (isMac) {
        if (noSystem()) {
          say('   [test] skipped launchd unload (DSH_DAEMON_NO_SYSTEM=1)');
          await shellRm(p.plist);
        } else {
          await sh('launchctl unload -w ' + sq(p.plist) + ' 2>/dev/null; true');
          await shellRm(p.plist);
          say('   Removed LaunchAgent plist and unloaded from launchd');
        }
      } else if (isLinux) {
        if (noSystem()) {
          say('   [test] skipped systemd/cron removal (DSH_DAEMON_NO_SYSTEM=1)');
          await shellRm(p.unit);
        } else if (await existsFile(p.unit)) {
          await sh('systemctl --user disable --now ' + SYSTEMD_UNIT + ' 2>/dev/null; true', 15000);
          await shellRm(p.unit);
          await sh('systemctl --user daemon-reload 2>/dev/null; true', 15000);
          say('   Removed systemd user unit');
        } else {
          try {
            const cur = await shOut('crontab -l 2>/dev/null', 8000);
            const next = cur.split('\n').filter((l) => l.indexOf('dsh-watchdog') === -1 && l.indexOf('watchdog.js') === -1).join('\n');
            await sh('printf \'%s\n\' ' + sq(next) + ' | crontab -', 8000);
            say('   Removed cron @reboot entry');
          } catch (e) { /* no cron */ }
        }
      } else if (isWin) {
        if (noSystem()) {
          say('   [test] skipped Task Scheduler removal (DSH_DAEMON_NO_SYSTEM=1)');
        } else {
          await sh('schtasks /End /TN ' + TASK_NAME + ' 2>$null', 8000);
          await sh('schtasks /Delete /TN ' + TASK_NAME + ' /F 2>$null', 8000);
          say('   Removed Task Scheduler entry (' + TASK_NAME + ')');
        }
      }
      try {
        const cfg = await discover();
        const cliPath = await cliWrapperPath(cfg);
        await shellRm(cliPath);
        say('   Removed CLI: ' + cliPath);
      } catch (e) { /* nothing to remove */ }
      await shellRm(p.installed, p.portFile, p.stopped, p.restartLock, p.webPid, p.watchdogPid, p.watchdogJs, p.vbs, p.taskXml, p.updateCheck, p.updatePending, p.updateLock, p.webAuthUrl);
      say('');
      say('✅ Daemon uninstalled. dsh web returns to manual behavior.');
      return lines.join('\n');
    }

    // ---- status / start / stop / logs ------------------------------------
    // systemctl prints a pointer to the detail command when a unit fails
    // ("See 'systemctl status' / 'journalctl -xe'"); every daemon failure path
    // prints the same kind of pointer to `dsh-daemon logs`, plus the raw paths
    // so the details are reachable even without the generated CLI on PATH.
    function logsCommandHint(p) {
      return 'dsh-daemon logs -n 100  (raw logs: ' + p.logDir + '/dsh-web.log, ' + p.logDir + '/watchdog.log)';
    }
    async function doStatus() {
      const lines = [];
      const say = (m) => lines.push(m);
      const { home, dshHome } = await homeAndDshHome();
      const p = paths({ home, dshHome });
      if (!(await existsFile(p.installed))) {
        say('🔕 Daemon: not installed');
        say('   Run dsh_daemon_install to enable auto-start and auto-restart');
        return lines.join('\n');
      }
      const since = ((await readFileSafe(p.installed)) || 'unknown').trim();
      const port = ((await readFileSafe(p.portFile)) || String(DEFAULT_PORT)).trim();
      say('🔔 Daemon: installed (since ' + since + ')');
      say('   Current port: ' + port);
      const profile = (await envVal('DSH_DAEMON_PROFILE')) || 'web';
      const pkgJsonRaw = await readFileSafe(paths({ home, dshHome }, profile).profilePkgJson);
      let local = 'unknown';
      if (pkgJsonRaw) {
        try { local = JSON.parse(pkgJsonRaw).version || 'unknown'; } catch (e) { /* keep unknown */ }
      }
      say('   Version: ' + local);
      const pending = ((await readFileSafe(p.updatePending)) || '').trim();
      const check = await readCheckState();
      if (pending) {
        say('   Update: ⏳ v' + pending + ' downloaded — restart dsh web to activate');
      } else if (check) {
        const when = check.checkedAt ? ' (checked ' + String(check.checkedAt).replace('T', ' ').replace(/\.\d+Z$/, 'Z') + ')' : '';
        const map = {
          'up-to-date': '✅ up to date',
          'update-available': '📦 newer version ' + (check.latest || '') + ' available — run dsh_daemon_update with apply:true',
          'manual-major': '⚠️  new major version ' + (check.latest || '') + ' — run dsh_daemon_update manually',
          'pending-restart': '⏳ v' + (check.latest || '') + ' downloaded — restart dsh web to activate',
          'restart-scheduled': '🔄 v' + (check.latest || '') + ' downloaded — idle-aware restart scheduled',
          'restarted': '✅ updated to ' + (check.latest || ''),
          'locked': '🔒 update in progress',
          'error': '⚠️  update check failed: ' + (check.error || 'error'),
          'disabled': '🚫 auto-update disabled',
        };
        say('   Update: ' + (map[check.action] || String(check.action)) + when);
      }
      const wpid = ((await readFileSafe(p.watchdogPid)) || '').trim();
      if (wpid && await pidAlive(wpid)) say('   Watchdog: ✅ running (PID ' + wpid + ')');
      else if (wpid) say('   Watchdog: ⚠️  registered but process not found (will restart on next login)');
      else say('   Watchdog: ⏳ not yet started (starts on next login or reboot)');
      if (await existsFile(p.stopped)) say('   Server:   ⏸  manually stopped — run dsh_daemon_start to resume monitoring');
      const webPid = ((await readFileSafe(p.webPid)) || '').trim();
      const win = await isWindows();
      const code = await shOut(win
        ? 'curl.exe -s -o NUL -w "%{http_code}" --max-time 5 http://127.0.0.1:' + port + '/health'
        : "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:" + port + '/health');
      if (code === '200') {
        let alive = false;
        if (webPid) alive = await pidAlive(webPid);
        say('   Web server: ✅ healthy on 127.0.0.1:' + port + (alive ? ' (PID ' + webPid + ')' : ''));
      } else {
        // A booting dsh web reports no /health yet: say so instead of claiming
        // the server is broken while it is inside its startup grace.
        const startedAt = Number(((await readFileSafe(p.webStarted)) || '').trim());
        const upMs = Number.isFinite(startedAt) && startedAt > 0 ? Date.now() - startedAt : 0;
        const graceMs = parseDuration(await envVal('DSH_DAEMON_STARTUP_GRACE'), 5 * 60000);
        const pidAliveNow = webPid ? await pidAlive(webPid) : false;
        if (pidAliveNow && upMs > 0 && upMs < graceMs) {
          say('   Web server: ⏳ still starting on 127.0.0.1:' + port + ' (PID ' + webPid + ', ' + Math.round(upMs / 1000) + 's of ' + Math.round(graceMs / 1000) + 's startup grace)');
          say('                — a slow boot is not a failure; the watchdog only restarts after the grace');
        } else if (pidAliveNow) {
          say('   Web server: ❌ unhealthy on 127.0.0.1:' + port + ' (HTTP ' + (code || 'timeout') + ', PID ' + webPid + ' up ' + Math.round(upMs / 1000) + 's without serving /health — the watchdog restarts it)');
        } else {
          say('   Web server: ❌ unhealthy on 127.0.0.1:' + port + ' (HTTP ' + (code || 'timeout') + '; no managed web process running)');
        }
        const webTail = await shOut(win
          ? 'Get-Content -Tail 3 -Path ' + psq(p.logDir + '/dsh-web.log')
          : 'tail -n 3 ' + sq(p.logDir + '/dsh-web.log') + ' 2>/dev/null', 5000);
        if (webTail) {
          say('   Web log (' + p.logDir + '/dsh-web.log):');
          for (const l of webTail.split('\n')) say('     | ' + l);
        }
        say('   Details: ' + logsCommandHint(p));
      }
      const tail = await shOut(win
        ? 'Get-Content -Tail 5 -Path ' + psq(p.watchdogLog)
        : 'tail -n 5 ' + sq(p.watchdogLog) + ' 2>/dev/null', 5000);
      if (tail) {
        say('');
        say('   Last watchdog log lines:');
        for (const l of tail.split('\n')) say('     ' + l);
      }
      return lines.join('\n');
    }

    async function doStart() {
      const lines = [];
      const say = (m) => lines.push(m);
      const win = await isWindows();
      const { home, dshHome } = await homeAndDshHome();
      const p = paths({ home, dshHome });
      await shellRm(p.stopped);
      say('▶️  Monitoring resumed (stopped flag cleared).');
      const wpid = ((await readFileSafe(p.watchdogPid)) || '').trim();
      if (!(wpid && await pidAlive(wpid))) {
        const nodePath = await shOut('node -e "console.log(process.execPath)"');
        if (win) {
          await sh('Start-Process -FilePath ' + psq(nodePath) + ' -ArgumentList ' + psq(p.watchdogJs) + ' -WindowStyle Hidden');
        } else {
          await sh('nohup ' + sq(nodePath) + ' ' + sq(p.watchdogJs) + ' >> ' + sq(p.watchdogLog) + ' 2>&1 &');
        }
        say('   Watchdog was not running — started it.');
      }
      const port = ((await readFileSafe(p.portFile)) || String(DEFAULT_PORT)).trim();
      const healthy = (await shOut(win
        ? 'curl.exe -s -o NUL -w "%{http_code}" --max-time 5 http://127.0.0.1:' + port + '/health'
        : "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:" + port + '/health')) === '200';
      if (!healthy) {
        const cfg = await discover();
        const webLog = p.logDir + '/dsh-web.log';
        await shellMkdir(p.logDir);
        const webArgs = ['web', '--port', String(cfg.port)];
        if (dshNoOpenSupported(cfg.dshVersion)) webArgs.push('--no-open');
        let r;
        if (win) {
          r = await sh('$proc = Start-Process -FilePath ' + psq(cfg.nodePath) + ' -ArgumentList ' + psq(cfg.dshBin) + ',' + webArgs.map(psq).join(',') + ' -WindowStyle Hidden -RedirectStandardOutput ' + psq(webLog) + ' -PassThru; $proc.Id | Out-File -Encoding ascii ' + psq(p.webPid));
        } else {
          r = await sh('nohup ' + sq(cfg.nodePath) + ' ' + sq(cfg.dshBin) + ' ' + webArgs.map(sq).join(' ') + ' >> ' + sq(webLog) + ' 2>&1 & echo $! > ' + sq(p.webPid) + '; true');
        }
        if (r.exitCode !== 0) {
          say('   ⚠️  Failed to launch web server: ' + (r.stderr || r.stdout));
          say('   Details: ' + logsCommandHint(p));
        } else {
          say('   Web server not running — launched it (PID written to ' + p.webPid + ').');
          // dsh web can take a while to serve /health. Report the real state
          // instead of an immediate verdict: the watchdog now waits out the same
          // startup grace before it would ever restart the process.
          let ok = false;
          for (let i = 0; i < 30 && !ok; i++) {
            await sleep(1000);
            ok = (await shOut(win
              ? 'curl.exe -s -o NUL -w "%{http_code}" --max-time 5 http://127.0.0.1:' + port + '/health'
              : "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:" + port + '/health')) === '200';
            if (!ok) {
              const launchedPid = ((await readFileSafe(p.webPid)) || '').trim();
              if (!(launchedPid && await pidAlive(launchedPid))) break;
            }
          }
          if (ok) say('   ✅ dsh web healthy on port ' + port + '.');
          else say('   ⏳ dsh web is still starting — that is normal for a large plugin set; check again with dsh_daemon_status.');
          if (!ok) say('   Details: ' + logsCommandHint(p));
        }
        await sleep(500);
      } else {
        say('   Web server already healthy on port ' + port + '.');
      }
      return lines.join('\n');
    }

    async function doStop() {
      const lines = [];
      const say = (m) => lines.push(m);
      const win = await isWindows();
      const { home, dshHome } = await homeAndDshHome();
      const p = paths({ home, dshHome });
      await shellMkdir(p.dir);
      await writeFile(p.stopped, new Date().toISOString());
      say('⏸  Stopped flag written — the watchdog will not restart the server.');
      const webPid = ((await readFileSafe(p.webPid)) || '').trim();
      if (webPid && await pidAlive(webPid)) {
        if (win) {
          await sh('taskkill /PID ' + webPid + ' /F 2>$null', 8000);
        } else {
          await sh('kill -TERM ' + webPid + ' 2>/dev/null; sleep 1; kill -KILL ' + webPid + ' 2>/dev/null; true', 8000);
        }
        await shellRm(p.webPid);
        say('   Stopped the daemon-managed web server (PID ' + webPid + ').');
      } else {
        say('   No daemon-managed web server is running.');
      }
      return lines.join('\n');
    }

    async function doUpdate(apply) {
      const lines = [];
      const say = (m) => lines.push(m);
      const win = await isWindows();
      const { home, dshHome } = await homeAndDshHome();
      const profile = (await envVal('DSH_DAEMON_PROFILE')) || 'web';
      const p = paths({ home, dshHome }, profile);
      const nodePath = await shOut('node -e "console.log(process.execPath)"');
      const q = win ? psq : sq;
      const flag = apply ? '--apply-update' : '--check-update';
      say(apply ? '🔍 Checking and applying updates...' : '🔍 Checking for updates...');
      const r = await sh(q(nodePath) + ' ' + q(p.watchdogJs) + ' ' + flag, 180000);
      if (r.exitCode !== 0) say('   ⚠️  update command failed: ' + (r.stderr || r.stdout || ('exit ' + r.exitCode)));
      await sleep(400);
      const check = await readCheckState();
      if (check) {
        say('   Local:  ' + (check.local || 'unknown'));
        say('   Latest: ' + (check.latest || 'unknown'));
        const map = {
          'up-to-date': '✅ up to date',
          'update-available': '📦 newer version available — run with apply:true to install',
          'manual-major': '⚠️  major version change — install manually with apply:true',
          'pending-restart': '⏳ downloaded — restart dsh web to activate',
          'restart-scheduled': '🔄 downloaded — idle-aware restart scheduled',
          'restarted': '✅ updated',
          'locked': '🔒 another update is in progress',
          'error': '❌ ' + (check.error || 'update failed'),
          'disabled': '🚫 auto-update is disabled (DSH_DAEMON_AUTO_UPDATE=0)',
        };
        say('   Status: ' + (map[check.action] || String(check.action)));
      } else {
        say('   No update state yet — the watchdog will check at startup.');
      }
      return lines.join('\n');
    }

    // Log tails for a failed (or still starting) dsh web. This is the
    // model-callable equivalent of the `dsh-daemon logs` terminal command that
    // every failure message points at, so a startup failure can be diagnosed
    // without a shell: the same two files the daemon owns, plus the health,
    // PID and launch-age facts that make the tail interpretable.
    async function doLogs(args) {
      const lines = [];
      const say = (m) => lines.push(m);
      const n = Math.min(Math.max(parseInt(args && args.lines, 10) || 50, 1), 10000);
      const src = String((args && args.source) || 'all').toLowerCase();
      const win = await isWindows();
      const { home, dshHome } = await homeAndDshHome();
      const p = paths({ home, dshHome });
      if (!(await existsFile(p.installed))) {
        say('🔕 Daemon: not installed — no log files have been created yet');
        say('   Logs live in ' + p.logDir + ' after dsh_daemon_install');
        return lines.join('\n');
      }
      const port = ((await readFileSafe(p.portFile)) || String(DEFAULT_PORT)).trim();
      const code = await shOut(win
        ? 'curl.exe -s -o NUL -w "%{http_code}" --max-time 5 http://127.0.0.1:' + port + '/health'
        : "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:" + port + '/health');
      const webPid = ((await readFileSafe(p.webPid)) || '').trim();
      const webPidAlive = webPid ? await pidAlive(webPid) : false;
      const startedAt = Number(((await readFileSafe(p.webStarted)) || '').trim());
      say('📄 dsh web startup diagnostics (port ' + port + ')');
      say('   /health: ' + (code === '200' ? '✅ 200' : '❌ ' + (code || 'timeout')));
      say('   web PID: ' + (webPid ? webPid + (webPidAlive ? ' (alive)' : ' (not running)') : 'none') +
        (Number.isFinite(startedAt) && startedAt > 0 ? ' — last launch ' + Math.round((Date.now() - startedAt) / 1000) + 's ago' : ''));
      if (await existsFile(p.stopped)) say('   ⏸ monitoring paused (dsh_daemon_stop) — the watchdog will not restart the server');
      const readTail = async (file) => await shOut(win
        ? 'Get-Content -Tail ' + n + ' -Path ' + psq(file)
        : 'tail -n ' + n + ' ' + sq(file) + ' 2>/dev/null', 8000);
      const sections = [];
      if (src !== 'watchdog') sections.push(['dsh-web.log', p.logDir + '/dsh-web.log']);
      if (src !== 'web') sections.push(['watchdog.log', p.logDir + '/watchdog.log']);
      for (const [label, file] of sections) {
        const tail = await readTail(file);
        say('');
        say('--- ' + label + ' (last ' + n + ' lines, ' + file + ') ---');
        if (tail) for (const l of tail.split('\n')) say('  | ' + l);
        else say('  (empty or not created yet)');
      }
      say('');
      say('   Terminal equivalent: dsh-daemon logs' + (n === 50 ? '' : ' -n ' + n) +
        (src === 'web' ? ' --web' : src === 'watchdog' ? ' --watchdog' : ''));
      return lines.join('\n');
    }

    // ---- tool definitions -------------------------------------------------
    const tools = [
      {
        name: 'dsh_daemon_install',
        description: 'Register the dsh web server as an auto-start, self-healing background service: writes a watchdog script and a macOS LaunchAgent (or systemd/cron on Linux, VBS + Task Scheduler on Windows) so `dsh web` starts on login, restarts after sleep/wake, and self-heals via /health checks every 10s. Starts the watchdog immediately. The currently running session is untouched.',
        parameters: {
          port: { type: 'number', description: 'Web server port to supervise (default: the current dsh web port, usually 3080).' },
        },
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute(args) { return await doInstall(args && args.port); },
      },
      {
        name: 'dsh_daemon_uninstall',
        description: 'Remove the dsh daemon registration: stop the watchdog, unload and delete the LaunchAgent plist (or systemd unit / cron entry, Task Scheduler task on Windows), and remove all daemon state files. The currently running session is untouched.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute() { return await doUninstall(); },
      },
      {
        name: 'dsh_daemon_reinstall',
        description: 'Recreate the dsh daemon registration after upgrading dsh or changing the port (equivalent to uninstall then install).',
        parameters: {
          port: { type: 'number', description: 'Web server port to supervise (default: the current dsh web port, usually 3080).' },
        },
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute(args) {
          const out = await doUninstall();
          return out + '\n\n' + await doInstall(args && args.port);
        },
      },
      {
        name: 'dsh_daemon_status',
        description: 'Show dsh daemon status: installed since, port, watchdog PID and liveness, manual-stop flag, web server health on the supervised port, and the last watchdog log lines. When the web server is unhealthy it prints a Details line pointing at dsh_daemon_logs.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute() { return await doStatus(); },
      },
      {
        name: 'dsh_daemon_logs',
        description: 'Show why dsh web did not start: the tail of the dsh web log (its stdout/stderr) and of the watchdog log, plus the current /health code, web PID and launch age. This is what every daemon failure message points at (terminal equivalent: `dsh-daemon logs`). Use it after a failed install/start/restart or an unhealthy dsh_daemon_status.',
        parameters: {
          lines: { type: 'number', description: 'Trailing lines per log (default 50, max 10000).' },
          source: { type: 'string', description: 'Which logs: "all" (default), "web" (dsh web stdout/stderr) or "watchdog".' },
        },
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute(args) { return await doLogs(args); },
      },
      {
        name: 'dsh_daemon_start',
        description: 'Resume daemon monitoring: clears the stopped flag, makes sure the watchdog runs, and launches the web server if it is not healthy.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute() { return await doStart(); },
      },
      {
        name: 'dsh_daemon_stop',
        description: 'Pause daemon monitoring: writes the stopped flag so the watchdog will not restart the server, then stops the daemon-managed web server if one is running. Never touches the currently running session.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute() { return await doStop(); },
      },
      {
        name: 'dsh_daemon_update',
        description: 'Check for a newer dsh-daemon version and apply it. With apply=false (default) reports what the registry has; with apply=true downloads the update via pnpm in the profile directory (same-major only, matching the watchdog auto-update policy) and, in restart mode, schedules an idle-aware dsh web restart. Major version changes always require this manual tool.',
        parameters: {
          apply: { type: 'boolean', description: 'Apply the update after checking (default false = check only).' },
        },
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute(args) { return await doUpdate(!!(args && args.apply)); },
      },
    ];
    for (const tool of tools) {
      const def = defineTool(tool);
      const dispose = registerTool(def);
      ctx.effect(() => dispose);
    }

    // ---- health endpoint ------------------------------------------------
    // The watchdog health-checks http://127.0.0.1:<port>/health every 10s;
    // deepseek-harness's web server has no such route (unknown paths fall
    // through to a 404), so the plugin claims it here. A 200 means the
    // plugin (and therefore the web app it lives in) is up and serving.
    const ws = ctx.webServer;
    if (ws && typeof ws.register === 'function') {
      ctx.effect(() => ws.register({
        kind: 'exact',
        path: '/health',
        handler: (req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        },
      }));
    }

    // ---- activity endpoint ------------------------------------------------
    // Lets the watchdog defer an update restart while dsh web is in active
    // use (agent turns running or background jobs). Serves only two counters;
    // no session or user data crosses the wire.
    if (ws && typeof ws.register === 'function') {
      ctx.effect(() => ws.register({
        kind: 'exact',
        path: '/dsh-daemon/activity',
        handler: (req, res) => {
          let agentsRunning = 0;
          let jobsRunning = 0;
          try {
            const agents = ctx.agents;
            if (agents && typeof agents.list === 'function') {
              for (const agent of agents.list()) {
                if (agent && agent.status === 'running') agentsRunning++;
              }
            }
          } catch (e) { /* keep 0 */ }
          try {
            const jobs = ctx.jobs;
            if (jobs && typeof jobs.list === 'function') {
              for (const job of jobs.list()) {
                const st = job && (job.status || job.state);
                if (st === 'running' || st === 'pending') jobsRunning++;
              }
            }
          } catch (e) { /* keep 0 */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agentsRunning, jobsRunning }));
        },
      }));
      // Command route: lets the `dsh-daemon` terminal command run the
      // registration operations (install/uninstall/reinstall) through the
      // plugin, so the CLI and the GUI tools share one implementation.
      ctx.effect(() => ws.register({
        kind: 'exact',
        path: '/dsh-daemon/command',
        handler: (req, res) => {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 8192) req.destroy();
          });
          req.on('end', () => {
            (async () => {
              let cmd = '';
              let portArg;
              let envOverrides;
              try {
                const j = JSON.parse(body || '{}');
                cmd = j && j.cmd;
                portArg = j && j.port;
                // Forward DSH_DAEMON_* from the invoking shell (the CLI
                // collects them) so `DSH_DAEMON_UPDATE_INTERVAL=1m
                // dsh-daemon reinstall` configures the watchdog correctly.
                envOverrides = (j && j.env && typeof j.env === 'object') ? j.env : undefined;
              } catch (e) { /* cmd stays empty */ }
              let ok = false;
              let output = '';
              let error = '';
              try {
                if (cmd === 'install') { output = await doInstall(portArg, envOverrides); ok = true; }
                else if (cmd === 'uninstall') { output = await doUninstall(); ok = true; }
                else if (cmd === 'reinstall') { output = await doUninstall() + '\n\n' + await doInstall(portArg, envOverrides); ok = true; }
                else { error = 'unknown command: ' + String(cmd); }
              } catch (e) { error = (e && e.message) || String(e); }
              res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok, output, error }));
            })().catch((e) => {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, output: '', error: String((e && e.message) || e) }));
            });
          });
        },
      }));
      // After an auto-update the npm package is new but the generated
      // watchdog script is not; bring it in sync (see regenerateWatchdogIfStale).
      // Deliberately deferred: boot must not wait on shell/fs work.
      void Promise.resolve().then(() => regenerateWatchdogIfStale()).catch(() => {});
    }
}

const plugin = {
  name: "dsh-daemon",
  // Hard dependencies: declared inject makes `ctx.<service>` property access
  // legal in both the dynamic sandbox and a static composition row (the
  // deployment's own plugins, e.g. tool-bash, declare the same services).
  inject: ["tools", "shell", "fs", "timer", "webServer", "agents", "jobs"],
  apply,
};
if (typeof module !== 'undefined' && module.exports) {
  if (String(process.env.DSH_DAEMON_TEST_HOOK) === '1') {
    // Dev/test hook: the pure version-gate functions (the same ones the
    // generated watchdog inlines via toString()) — see test/version-gate.test.js.
    plugin.__test = { DSH_NO_OPEN_MIN, DSH_TOKEN_AUTH_MIN, parseSemver, preGt, versionGte, dshNoOpenSupported, dshTokenAuthSupported, extractTokenUrl, parseShimTarget, resolveDshBinThroughShim };
  }
  module.exports = plugin;
}
return plugin;
