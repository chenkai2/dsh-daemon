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
    function paths(cfg) {
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
        vbs: dir + '/dsh-watchdog.vbs',
        taskXml: dir + '/dsh-watchdog-task.xml',
        plist: cfg.home + '/Library/LaunchAgents/' + LABEL + '.plist',
        unitDir: cfg.home + '/.config/systemd/user',
        unit: cfg.home + '/.config/systemd/user/' + SYSTEMD_UNIT + '.service',
      };
    }

    // ---- generated watchdog script --------------------------------------
    function watchdogScript(cfg, p) {
      const j = (v) => JSON.stringify(String(v));
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
        '  setInterval(async function () {\n' +
        '    const now = Date.now();\n' +
        '    const gap = now - last;\n' +
        '    last = now;\n' +
        '    if (!FS.existsSync(INSTALLED)) { log(\'daemon marker removed, exiting\'); shutdown(); return; }\n' +
        '    if (FS.existsSync(STOPPED)) { failures = 0; return; }\n' +
        '    if (restartLockFresh()) { failures = 0; return; }\n' +
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
        '})().catch(function (err) { log(\'watchdog fatal: \' + (err && err.stack ? err.stack : String(err))); shutdown(); });\n';
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
      const plat = await platform();
      const isMac = plat === 'mac';
      const isLinux = plat === 'linux';
      const isWin = plat === 'win';
      say('📦 Installing dsh daemon...');
      say('   Captured DSH_WEB_PORT=' + cfg.port + ' for the daemon service');
      say('   dsh CLI: ' + cfg.dshBin);
      say('   node: ' + cfg.nodePath);
      await shellMkdir(p.dir, p.logDir);
      await writeFile(p.watchdogJs, watchdogScript(cfg, p));
      say('   Wrote watchdog script: ' + p.watchdogJs);
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
      await shellRm(p.installed, p.portFile, p.stopped, p.restartLock, p.webPid, p.watchdogPid, p.watchdogJs, p.vbs, p.taskXml);
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
    ];
    for (const tool of tools) {
      const def = defineTool(tool);
      const dispose = registerTool(def);
      ctx.effect(() => dispose);
    }
}

const plugin = {
  name: "dsh-daemon",
  // Hard dependencies: declared inject makes `ctx.<service>` property access
  // legal in both the dynamic sandbox and a static composition row (the
  // deployment's own plugins, e.g. tool-bash, declare the same services).
  inject: ["tools", "shell", "fs", "timer", "webServer"],
  apply,
};
if (typeof module !== 'undefined' && module.exports) module.exports = plugin;
return plugin;
