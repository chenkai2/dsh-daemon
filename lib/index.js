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
// and self-heals via /health checks every 30s.
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
    // checks http://127.0.0.1:<port>/health every 30s and restarts
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
    async function sh(command, timeoutMs, signal) {
      const shell = ctx.shell;
      if (!shell) throw new Error('shell service unavailable');
      const spec = shell.resolve({ command, timeoutMs: timeoutMs || 30000, signal, sandboxPolicy: fullPolicy() });
      const r = await shell.run(spec);
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
      ]);
      return {
        autoUpdate: !(vals[0] === '0' || vals[0] === 'false'),
        updateIntervalMs: parseDuration(vals[1], 6 * 3600000),
        updateMode: vals[2] === 'download' ? 'download' : 'restart',
        quietWindowMs: parseDuration(vals[3], 5 * 60000),
        deferMaxMs: parseDuration(vals[4], 15 * 60000),
        npmRegistry: (vals[5] && /^https?:\/\//.test(vals[5])) ? vals[5] : 'https://registry.npmjs.org',
        profile: (vals[6] && /^[a-z0-9-]+$/.test(vals[6])) ? vals[6] : 'web',
        healthIntervalMs: parseDuration(vals[7], 30000),
        // On token-auth dsh the watchdog opens the launch-token URL in the
        // default browser once per launch to seed the 30-day cookie (default
        // on, matching manual `dsh web`); DSH_DAEMON_OPEN_BROWSER=0 keeps the
        // URL in .web-auth-url / logs only. Irrelevant for pre-token dsh.
        openBrowser: !(vals[8] === '0' || vals[8] === 'false'),
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
      const healthIntervalMs = u.healthIntervalMs || 30000;
      const openBrowser = u.openBrowser !== false;
      return '\'use strict\';\n' +
        'const FS = require(\'node:fs\');\n' +
        'const PATH = require(\'node:path\');\n' +
        'const CP = require(\'node:child_process\');\n' +
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
        'const WATCHDOG_PID = PATH.join(STATE_DIR, \'.dsh-watchdog.pid\');\n' +
        'const HEALTH_URL = \'http://127.0.0.1:\' + PORT + \'/health\';\n' +
        'const PORT_FILE = PATH.join(STATE_DIR, \'.daemon-port\');\n' +
        'const INTERVAL_MS = ' + String(healthIntervalMs) + ';\n' +
        'const SLEEP_GAP_MS = 90000;\n' +
        'const FAIL_THRESHOLD = 3;\n' +
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
        'function killPid(pid) { try { process.kill(pid, \'SIGKILL\'); } catch (e) {} }\n' +
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
        'async function healthy() {\n' +
        '  try {\n' +
        '    const ctrl = new AbortController();\n' +
        '    const t = setTimeout(function () { ctrl.abort(); }, 5000);\n' +
        '    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });\n' +
        '    clearTimeout(t);\n' +
        '    return res.ok;\n' +
        '  } catch (e) { return false; }\n' +
        '}\n' +
        'function launch() {\n' +
        '  const old = readPid(WEB_PID);\n' +
        '  if (old && old !== process.pid && alive(old)) { log(\'stopping previous web server (PID \' + old + \')\'); killPid(old); }\n' +
        '  try { FS.unlinkSync(WEB_PID); } catch (e) {}\n' +
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
        '  const args = [currentDshBin(), \'web\', \'--port\', String(PORT)];\n' +
        '  if (versionGte(ver, DSH_NO_OPEN_MIN)) args.push(\'--no-open\');\n' +
        '  else log(\'dsh \' + (ver || \'unknown\') + \' predates --no-open (\' + DSH_NO_OPEN_MIN + \'), launching without it\');\n' +
        '  // Optional --trusted-host for /api browser-trust fence: when dsh web is\n' +
        '  // reached through a reverse proxy (nginx) the Host header is the public\n' +
        '  // hostname, which the fence would otherwise reject with 403. Comma-\n' +
        '  // separated list accepted (e.g. "dsh.example.com,10.0.0.5:8080").\n' +
        '  const trustedHost = process.env.DSH_DAEMON_TRUSTED_HOST || \'\';\n' +
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
        '    wrapper.on(\'error\', function (err) { log(\'spawn dsh web (via Start-Process) failed: \' + err.message); });\n' +
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
        '    child.on(\'error\', function (err) { log(\'spawn dsh web failed: \' + err.message); });\n' +
        '    if (child.pid) { try { FS.writeFileSync(WEB_PID, String(child.pid)); } catch (e) {} }\n' +
        '    child.unref();\n' +
        '    log(\'launched dsh web (PID \' + child.pid + \'): \' + process.execPath + \' \' + args.join(\' \'));\n' +
        '  }\n' +
        '  seedWebAuth(ver, webLogBase);\n' +
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
        '  launch();\n' +
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
        '  if (FS.existsSync(STOPPED)) console.log(\'   Server:   ⏸  manually stopped — run dsh-daemon start\');\n' +
        '  const ok = await healthy();\n' +
        '  console.log(ok ? \'   Web server: ✅ healthy on 127.0.0.1:\' + port : \'   Web server: ❌ unhealthy on 127.0.0.1:\' + port);\n' +
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
        '  stopServer(false);\n' +
        '  launch();\n' +
        '  console.log(\'  launched dsh web\');\n' +
        '  await sleep(3000);\n' +
        '  let ok = false;\n' +
        '  for (let i = 0; i < 10; i++) { if (await healthy()) { ok = true; break; } await sleep(1000); }\n' +
        '  try { FS.unlinkSync(RESTART_LOCK); } catch (e) {}\n' +
        '  console.log(ok ? \'✅ dsh web restarted and healthy on port \' + PORT : \'⚠️  web not healthy yet — the watchdog will retry\');\n' +
        '  return ok ? 0 : 1;\n' +
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
        '  if (await healthy()) console.log(\'  web server already healthy\');\n' +
        '  else {\n' +
        '    launch();\n' +
        '    console.log(\'  launched dsh web\');\n' +
        '    // dsh web takes a while to boot; wait for health so `dsh-daemon start`\n' +
        '    // does not report success while the server is still coming up.\n' +
        '    await sleep(3000);\n' +
        '    let ok = false;\n' +
        '    for (let i = 0; i < 10; i++) { if (await healthy()) { ok = true; break; } await sleep(1000); }\n' +
        '    console.log(ok ? \'✅ dsh web healthy on port \' + PORT : \'⚠️  web not healthy yet — the watchdog will keep retrying\');\n' +
        '  }\n' +
        '  return 0;\n' +
        '}\n' +
        'async function stopWeb() {\n' +
        '  try { FS.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}\n' +
        '  try { FS.writeFileSync(STOPPED, new Date().toISOString()); } catch (e) {}\n' +
        '  console.log(\'dsh-daemon: monitoring paused — the watchdog will not restart the server\');\n' +
        '  stopServer(false);\n' +
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
        '    log(\'web server not healthy on port \' + PORT + \' at startup, launching...\');\n' +
        '    launch();\n' +
        '    await sleep(3000);\n' +
        '  } else log(\'web server already healthy on port \' + PORT);\n' +
        '  let failures = 0;\n' +
        '  let last = Date.now();\n' +
        '  let lastUpdateCheck = Date.now();\n' +
        '  if (AUTO_UPDATE) { checkUpdate(true); }\n' +
        '  setInterval(async function () {\n' +
        '    const now = Date.now();\n' +
        '    const gap = now - last;\n' +
        '    last = now;\n' +
        '    if (!FS.existsSync(INSTALLED)) { log(\'daemon marker removed, exiting\'); shutdown(); return; }\n' +
        '    if (FS.existsSync(STOPPED)) { failures = 0; return; }\n' +
        '    if (restartLockFresh()) { failures = 0; return; }\n' +
        '    if (AUTO_UPDATE && now - lastUpdateCheck >= UPDATE_INTERVAL_MS) { lastUpdateCheck = now; checkUpdate(true); }\n' +
        '    if (gap > SLEEP_GAP_MS) {\n' +
        '      log(\'sleep/wake detected (gap=\' + Math.round(gap / 1000) + \'s), restarting web server\');\n' +
        '      launch(); failures = 0; return;\n' +
        '    }\n' +
        '    if (await healthy()) failures = 0;\n' +
        '    else {\n' +
        '      failures++;\n' +
        '      log(\'health check failed (\' + failures + \'/\' + FAIL_THRESHOLD + \')\');\n' +
        '      if (failures >= FAIL_THRESHOLD) { log(\'failure threshold reached, restarting web server\'); launch(); failures = 0; }\n' +
        '    }\n' +
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
        '  update)\n' +
        '    if [ "${2:-}" = "--apply" ]; then exec "$NODE" "$WATCHDOG" --apply-update; else exec "$NODE" "$WATCHDOG" --check-update; fi ;;\n' +
        '  install|uninstall|reinstall)\n' +
        '    env_json=$(env | sed -n \'s/^\\(DSH_DAEMON_[A-Z0-9_]*\\)=\\(.*\\)$/\\"\\1\\":\\"\\2\\"/p\' | paste -sd, -)\n' +
        '    if [ -n "$env_json" ]; then body="{\\"cmd\\":\\"$1\\",\\"env\\":{$env_json}}"; else body="{\\"cmd\\":\\"$1\\"}"; fi\n' +
        '    out=$(curl -s -X POST -H "Content-Type: application/json" -d "$body" "http://127.0.0.1:${PORT}/dsh-daemon/command")\n' +
        '    exec "$NODE" -e "const j=JSON.parse(process.argv[1]);process.stdout.write(j.output||j.error||\'\');process.exit(j.ok?0:1)" "$out" ;;\n' +
        '  help|-h|--help)\n' +
        '    echo "Usage: dsh-daemon <status|restart|start|stop|install|uninstall|reinstall|update [--apply]|help>" ;;\n' +
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
        'if "%1"=="help" (echo Usage: dsh-daemon status^|restart^|start^|stop^|install^|uninstall^|reinstall^|update [--apply]^|help & exit /b 0)\r\n' +
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
    async function regenerateWatchdogIfStale() {
      // Test harnesses and development loads must not rewrite the real
      // daemon: DSH_DAEMON_AUTOREGEN=0 opts out of the boot-time sync.
      try {
        if (String(process.env.DSH_DAEMON_AUTOREGEN) === '0') return;
      } catch (e) { return; }
      let cfg;
      let p;
      try {
        const h = await homeAndDshHome();
        cfg = { home: h.home, dshHome: h.dshHome, port: DEFAULT_PORT };
        p = paths(cfg);
        const existing = await readFileSafe(p.watchdogJs);
        if (!existing) return; // daemon not installed
        const m = existing.match(/const GEN_VERSION = ['"]([^'"]+)['"]/);
        if (m && m[1] === currentVersion()) return; // already current
      } catch (e) { return; } // not installed / unreadable — leave alone

      try {
        const full = await discover(cfg.port);
        const pp = paths(full);
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
      say('   dsh_daemon_start       — resume monitoring (clears stopped flag)');
      say('   dsh_daemon_stop        — pause monitoring (watchdog will not restart)');
      say('   dsh_daemon_reinstall   — refresh registration after upgrade or port change');
      say('   dsh_daemon_uninstall   — remove daemon registration');
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

    // ---- status / start / stop -------------------------------------------
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
        say('   Web server: ❌ unhealthy on 127.0.0.1:' + port + ' (HTTP ' + (code || 'timeout') + ')');
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
        if (r.exitCode !== 0) say('   ⚠️  Failed to launch web server: ' + (r.stderr || r.stdout));
        else say('   Web server not running — launched it (PID written to ' + p.webPid + ').');
        await sleep(1500);
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

    // ---- tool definitions -------------------------------------------------
    const tools = [
      {
        name: 'dsh_daemon_install',
        description: 'Register the dsh web server as an auto-start, self-healing background service: writes a watchdog script and a macOS LaunchAgent (or systemd/cron on Linux, VBS + Task Scheduler on Windows) so `dsh web` starts on login, restarts after sleep/wake, and self-heals via /health checks every 30s. Starts the watchdog immediately. The currently running session is untouched.',
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
        description: 'Show dsh daemon status: installed since, port, watchdog PID and liveness, manual-stop flag, web server health on the supervised port, and the last watchdog log lines.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (args, value) => [{ type: 'text', text: String(value) }] },
        async execute() { return await doStatus(); },
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
    // The watchdog health-checks http://127.0.0.1:<port>/health every 30s;
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
