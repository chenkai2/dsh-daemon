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
      const nodePath = await shOut('node -e "console.log(process.execPath)"');
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
      dshBin = await shOut('node -e "console.log(require(\'node:fs\').realpathSync(process.argv[1]))" ' + sq(dshBin));
      if (!dshBin) dshBin = await shOut(win ? '(Get-Command dsh -ErrorAction SilentlyContinue).Source' : 'command -v dsh');
      if (win && dshBin) dshBin = String(dshBin).replace(/\\/g, '/');
      let port = DEFAULT_PORT;
      try {
        const ws = ctx.webServer;
        if (ws && typeof ws.port === 'number' && ws.port > 0 && ws.port < 65536) port = ws.port;
      } catch (e) { /* keep default */ }
      const envPort = await shOut(win ? '$env:DSH_WEB_PORT' : 'echo ${DSH_WEB_PORT:-}');
      if (envPort && /^\d+$/.test(envPort)) port = parseInt(envPort, 10);
      if (typeof portArg === 'number' && portArg > 0 && portArg < 65536) port = portArg;
      return { home, dshHome, nodePath, dshBin, port };
    }
    function parseDuration(v, def) {
      if (!v) return def;
      const m = String(v).trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
      if (!m) return def;
      const n = parseInt(m[1], 10);
      const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[String(m[2] || 'ms').toLowerCase()];
      return n * mult;
    }
    async function envVal(name) {
      return await shOut((await isWindows()) ? '$env:' + name : 'echo ${' + name + ':-}');
    }
    // Auto-update configuration, captured at install/reinstall time and
    // embedded into the generated watchdog script.
    async function updateConfig() {
      const vals = await Promise.all([
        envVal('DSH_DAEMON_AUTO_UPDATE'),
        envVal('DSH_DAEMON_UPDATE_INTERVAL'),
        envVal('DSH_DAEMON_UPDATE_MODE'),
        envVal('DSH_DAEMON_QUIET_WINDOW'),
        envVal('DSH_DAEMON_DEFER_MAX'),
        envVal('DSH_DAEMON_NPM_REGISTRY'),
        envVal('DSH_DAEMON_PROFILE'),
      ]);
      return {
        autoUpdate: !(vals[0] === '0' || vals[0] === 'false'),
        updateIntervalMs: parseDuration(vals[1], 6 * 3600000),
        updateMode: vals[2] === 'restart' ? 'restart' : 'download',
        quietWindowMs: parseDuration(vals[3], 5 * 60000),
        deferMaxMs: parseDuration(vals[4], 15 * 60000),
        npmRegistry: (vals[5] && /^https?:\/\//.test(vals[5])) ? vals[5] : 'https://registry.npmjs.org',
        profile: (vals[6] && /^[a-z0-9-]+$/.test(vals[6])) ? vals[6] : 'web',
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
    function watchdogScript(cfg, p, opts) {
      const j = (v) => JSON.stringify(String(v));
      const u = opts || {};
      const autoUpdate = u.autoUpdate !== false;
      const updateIntervalMs = u.updateIntervalMs || 6 * 3600000;
      const updateMode = u.updateMode === 'restart' ? 'restart' : 'download';
      const quietWindowMs = u.quietWindowMs || 5 * 60000;
      const deferMaxMs = u.deferMaxMs || 15 * 60000;
      const npmRegistry = u.npmRegistry || 'https://registry.npmjs.org';
      const profile = u.profile || 'web';
      return '\'use strict\';\n' +
        'const FS = require(\'node:fs\');\n' +
        'const PATH = require(\'node:path\');\n' +
        'const CP = require(\'node:child_process\');\n' +
        'const STATE_DIR = ' + j(p.dir) + ';\n' +
        'const DSH_HOME = ' + j(cfg.dshHome) + ';\n' +
        'const DSH_BIN = ' + j(cfg.dshBin) + ';\n' +
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
        'const INTERVAL_MS = 30000;\n' +
        'const SLEEP_GAP_MS = 90000;\n' +
        'const FAIL_THRESHOLD = 3;\n' +
        'const RESTART_LOCK_TTL_MS = 120000;\n' +
        'const MAX_LOG_BYTES = 5 * 1024 * 1024;\n' +
        '// ---- auto-update configuration (embedded at install time) --------\n' +
        'const PACKAGE_NAME = ' + j('@chenkai114/dsh-daemon') + ';\n' +
        'const PROFILE_DIR = ' + j(String(cfg.dshHome + '/profiles/' + profile).replace(/\\/g, '/')) + ';\n' +
        'const PACKAGE_JSON = PATH.join(PROFILE_DIR, \'node_modules\', PACKAGE_NAME, \'package.json\');\n' +
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
        'function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }\n' +
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
        '  const args = [DSH_BIN, \'web\', \'--port\', String(PORT)];\n' +
        '  const opts = fd >= 0 ? { detached: true, stdio: [\'ignore\', fd, fd], env: Object.assign({}, process.env, { DSH_HOME: DSH_HOME }) }\n' +
        '                        : { detached: true, stdio: \'ignore\', env: Object.assign({}, process.env, { DSH_HOME: DSH_HOME }) };\n' +
        '  const child = CP.spawn(process.execPath, args, opts);\n' +
        '  child.on(\'error\', function (err) { log(\'spawn dsh web failed: \' + err.message); });\n' +
        '  if (child.pid) { try { FS.writeFileSync(WEB_PID, String(child.pid)); } catch (e) {} }\n' +
        '  child.unref();\n' +
        '  log(\'launched dsh web (PID \' + child.pid + \'): \' + process.execPath + \' \' + args.join(\' \'));\n' +
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
        '    const child = CP.spawn(bin.cmd, args, { cwd: PROFILE_DIR, stdio: [\'ignore\', \'pipe\', \'pipe\'], shell: bin.shell, env: env });\n' +
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
        '      if (!ok || nowLocal !== latest) {\n' +
        '        state.action = \'error\';\n' +
        '        state.error = \'pnpm update failed or version mismatch (local=\' + nowLocal + \')\';\n' +
        '        log(\'update FAILED: \' + state.error);\n' +
        '      } else if (UPDATE_MODE === \'download\') {\n' +
        '        state.action = \'pending-restart\';\n' +
        '        try { FS.writeFileSync(UPDATE_PENDING, latest); } catch (e) {}\n' +
        '        log(\'update \' + local + \' -> \' + latest + \' downloaded; restart dsh web to activate\');\n' +
        '      } else {\n' +
        '        state.action = \'restart-scheduled\';\n' +
        '        writeCheck(state);\n' +
        '        log(\'scheduling idle-aware restart...\');\n' +
        '        try {\n' +
        '          const waiter = CP.spawn(process.execPath, [__filename, \'--restart-pending\'], { detached: true, stdio: \'ignore\' });\n' +
        '          waiter.unref();\n' +
        '        } catch (e) { log(\'failed to spawn restart waiter: \' + e.message); }\n' +
        '        return;\n' +
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
        '// ---- CLI modes (one-shot, used by dsh_daemon_update) ----------------\n' +
        'const CLI_ARGS = process.argv.slice(2);\n' +
        'if (CLI_ARGS.indexOf(\'--restart-pending\') !== -1) {\n' +
        '  quietThenRestart().then(function () { process.exit(0); }).catch(function (e) { log(\'restart waiter failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--apply-update\') !== -1) {\n' +
        '  checkUpdate(true).then(function () { process.exit(0); }).catch(function (e) { log(\'apply-update failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else if (CLI_ARGS.indexOf(\'--check-update\') !== -1) {\n' +
        '  checkUpdate(false).then(function () { process.exit(0); }).catch(function (e) { log(\'check-update failed: \' + (e && e.message)); process.exit(1); });\n' +
        '} else {\n' +
        'const existing = readPid(WATCHDOG_PID);\n' +
        'if (existing && existing !== process.pid && alive(existing)) process.exit(0);\n' +
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

    // ---- install / uninstall --------------------------------------------
    async function doInstall(portArg) {
      const lines = [];
      const say = (m) => lines.push(m);
      const cfg = await discover(portArg);
      const p = paths(cfg);
      const uopts = await updateConfig();
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
      say('   Auto-update: ' + (uopts.autoUpdate ? 'enabled (every ' + Math.round(uopts.updateIntervalMs / 3600000) + 'h, mode ' + uopts.updateMode + ')' : 'disabled'));
      await writeFile(p.installed, new Date().toISOString());
      await writeFile(p.portFile, String(cfg.port));
      await shellRm(p.stopped);
      if (isMac) {
        await writeFile(p.plist, plistContent(cfg, p));
        say('   Wrote LaunchAgent: ' + p.plist);
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
      } else if (isLinux) {
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
        await sh('nohup ' + sq(cfg.nodePath) + ' ' + sq(p.watchdogJs) + ' >> ' + sq(p.watchdogLog) + ' 2>&1 &');
        say('   Started watchdog for the current session');
      } else if (isWin) {
        const username = await shOut('whoami', 8000);
        await writeFile(p.vbs, vbsContent(cfg, p));
        say('   Wrote watchdog launcher: ' + p.vbs);
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
      } else {
        throw new Error('Unsupported platform: ' + plat);
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
        await sh('launchctl unload -w ' + sq(p.plist) + ' 2>/dev/null; true');
        await shellRm(p.plist);
        say('   Removed LaunchAgent plist and unloaded from launchd');
      } else if (isLinux) {
        if (await existsFile(p.unit)) {
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
        await sh('schtasks /End /TN ' + TASK_NAME + ' 2>$null', 8000);
        await sh('schtasks /Delete /TN ' + TASK_NAME + ' /F 2>$null', 8000);
        say('   Removed Task Scheduler entry (' + TASK_NAME + ')');
      }
      await shellRm(p.installed, p.portFile, p.stopped, p.restartLock, p.webPid, p.watchdogPid, p.watchdogJs, p.vbs, p.taskXml, p.updateCheck, p.updatePending, p.updateLock);
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
        let r;
        if (win) {
          r = await sh('$proc = Start-Process -FilePath ' + psq(cfg.nodePath) + ' -ArgumentList ' + psq(cfg.dshBin) + ",'web','--port','" + String(cfg.port) + "' -WindowStyle Hidden -RedirectStandardOutput " + psq(webLog) + ' -PassThru; $proc.Id | Out-File -Encoding ascii ' + psq(p.webPid));
        } else {
          r = await sh('nohup ' + sq(cfg.nodePath) + ' ' + sq(cfg.dshBin) + ' web --port ' + String(cfg.port) + ' >> ' + sq(webLog) + ' 2>&1 & echo $! > ' + sq(p.webPid) + '; true');
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

    // ---- activity endpoint ------------------------------------------------
    // Lets the watchdog defer an update restart while dsh web is in active
    // use (agent turns running or background jobs). Serves only two counters;
    // no session or user data crosses the wire.
    const ws = ctx.webServer;
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
if (typeof module !== 'undefined' && module.exports) module.exports = plugin;
return plugin;
