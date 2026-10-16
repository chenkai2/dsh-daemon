## Compatibility (dsh-daemon vs dsh)

| dsh-daemon | Supported dsh | Notes |
|---|---|---|
| 0.1.26 | **0.1.x and 0.2.x** | Startup grace: a slow-booting `dsh web` (large plugin set, cold caches) is no longer declared dead after ~90 s and restarted forever — health misses inside the grace never count (`DSH_DAEMON_STARTUP_GRACE`, default 5m); stopping the previous server now sends SIGTERM before SIGKILL and waits for the port to be free (fixes the `EADDRINUSE` restart storm); `status` / `start` report "still starting" honestly |
| 0.1.25 | **0.1.x and 0.2.x** | Adapts to the renamed shell service in 0.2.x: `run(spec)` → `execute(spec)` plus a handle's `result()` (0.2.1 failed `reinstall` with `shell.run is not a function`), with tolerant result shapes |
| 0.1.24 | 0.1.x (parts of 0.2.x broken) | Adds the OIDC publish pipeline; does not adapt to the 0.2.x shell API |
| 0.1.23 | ≥ `0.1.2-alpha.1` (token auth) | Registration-drift self-heal, honest registration status, refuses ephemeral DSH_HOME |
| 0.1.21–0.1.22 | same | Single-instance guard verifies cmdline; explicit cwd for dsh web |
| 0.1.20 | same | `DSH_DAEMON_TRUSTED_HOST`: appends `--trusted-host` behind a reverse proxy |
| 0.1.19 | same | Opens the browser once to seed the token-auth cookie |
| ≤ 0.1.18 | ≥ `0.1.0-rc.8` (`--no-open`) | Older dsh lacks `--no-open`; the watchdog omits the flag |

Thresholds are read from code (`lib/index.js`): `DSH_NO_OPEN_MIN = 0.1.0-rc.8`, `DSH_TOKEN_AUTH_MIN = 0.1.2-alpha.1`.
The daemon touches only three dsh interfaces: web launch flags, the `/health` probe, and the injected `shell`/`fs` services — the last being the one 0.2.x changed.

---

# dsh-daemon

[中文](README.md) | [English](README.en.md)

Register the **DeepSeek Harness** web server (`dsh web`) as an auto-start,
self-healing background service.

After install, `dsh web`:

- starts automatically on login (LaunchAgent `RunAtLoad` / systemd `WantedBy=default.target` / cron `@reboot`),
- restarts automatically after sleep/wake,
- self-heals: a watchdog health-checks `http://127.0.0.1:<port>/health` every 30 s (configurable) and restarts the server after 3 consecutive failures,
- tolerates slow boots: while a freshly launched `dsh web` is inside its **startup grace** (`DSH_DAEMON_STARTUP_GRACE`, default 5m) health misses never count towards a restart and the process is never killed,
- survives this session: the watchdog is a standalone generated script, not an in-memory plugin.

The currently running session is never touched by install/uninstall.

> For the account map (npm scope / GitHub account) see [CONTEXT.md](CONTEXT.md).

---

## Usage

### Option A — install with `dsh plugin`, mount as a composition row

1. Install the package **into the web profile** with the official plugin
   manager (runs pnpm in the profile directory, so the loader can resolve it;
   a plain global install is not enough — see below):

   ```bash
   dsh plugin --profile web add @chenkai114/dsh-daemon
   ```

   (needs `pnpm` on PATH — enable it once with `corepack enable`.)

   > Why not just `npm install -g`? The loader imports `name:` rows with
   > Node's ESM resolution anchored at the profile directory
   > (`~/.dsh/profiles/web/`); the global `node_modules` is not on that
   > resolution chain (and `NODE_PATH` does not apply to ESM). The profile's
   > own `node_modules` — managed here by pnpm — is what makes the package
   > reachable.

2. Restart `dsh web`. The package declares a `dsh.bundle` manifest, so
   `dsh plugin add` automatically appends it to `dsh.profile.bundles` and it
   mounts as a bundle layer at boot — you do **not** need (and **must not**)
   also insert the same row manually into
   `~/.dsh/profiles/web/cordis.patch.yml`, or boot fails with
   `duplicate loader entry id: dsh-daemon`.

   The seven `dsh_daemon_*` tools then become available to every agent — just
   ask the agent to run `dsh_daemon_install`.

To upgrade later: `dsh plugin --profile web update @chenkai114/dsh-daemon`
(plus a restart).

> ⚠️ Upgrading from v0.1.8 or earlier: if you previously followed the old docs
> and added a manual `- insert: dsh-daemon` row to
> `~/.dsh/profiles/web/cordis.patch.yml`, you must **delete that row** (keep
> anything else in the file) after upgrading — otherwise the bundle layer and
> the manual layer insert the same `id: dsh-daemon` twice and `dsh web` fails
> to boot with `duplicate loader entry id`. Restart after deleting it.

> Permissions: the daemon manages per-user system services (LaunchAgent
> plists, state files under `$DSH_HOME`), so the plugin requests
> `danger-full-access` for its file and command operations. On a deployment
> that denies escalation the tools fail with sandbox denials.

### Option B — dynamic Cordis plugin (no install)

Paste the content of `lib/index.js` into the `code.host` field of
`cordis_define` and run it. This is how the plugin is developed and verified
in a live session: the sandbox supplies the `harness` global, and the file
ends with `return plugin;`.

### Port

Default port is the currently listening `webServer` port (usually `3080`),
then `DSH_WEB_PORT`, then the explicit `port` tool argument. After changing
the port, run `dsh_daemon_reinstall`.

---

## Architecture

The daemon is a **watchdog supervisor** made of three parts.

### 1. Platform registration

A per-user service that starts the watchdog at login and keeps it alive:

| Platform | Mechanism |
| --- | --- |
| macOS | LaunchAgent `~/Library/LaunchAgents/com.deepseek-ai.dsh-watchdog.plist` — `ProgramArguments=[node, watchdog.js]`, `RunAtLoad`, `KeepAlive{SuccessfulExit:false}`, `ThrottleInterval=10`, environment carries `DSH_WEB_PORT` and `DSH_HOME`. Loaded with `launchctl load -w`. |
| Linux | systemd user unit `~/.config/systemd/user/dsh-watchdog.service` — `Type=simple`, `Restart=always`, `RestartSec=10`, `StartLimitIntervalSec=0`; enabled with `systemctl --user enable --now`. Falls back to a cron `@reboot` entry when systemd is unavailable. |
| Windows | VBS launcher + Task Scheduler — task `DshWatchdog` (XML in `$DSH_HOME/daemon/dsh-watchdog-task.xml`, UTF-16LE) runs `wscript.exe //B dsh-watchdog.vbs` at logon; the VBS sets `DSH_WEB_PORT`/`DSH_HOME` and starts `node watchdog.js` hidden. `RestartOnFailure` PT1M/999, `MultipleInstancesPolicy=IgnoreNew`. Registered with `schtasks /Create`. |

> Windows support is implemented mirroring the macOS/Linux behavior (the
> plugin's shell layer switches to PowerShell, which is the DSH shell
> executor on win32) but has not yet been verified on a real Windows machine.

### 2. The watchdog loop

The generated standalone script `$DSH_HOME/daemon/watchdog.js` (dependency-free,
runs on any Node ≥ 18, no session required):

- writes its PID to `.dsh-watchdog.pid`; SIGINT / SIGTERM / SIGHUP clean up and exit; a single-instance lock refuses duplicate watchers;
- at startup, launches the web server (`node <dsh> web --port <port>`, detached, output to `logs/dsh-web.log`) if `http://127.0.0.1:<port>/health` is not OK;
- then every 30 s (configurable via `DSH_DAEMON_HEALTH_INTERVAL`):
  - skips when `.daemon-stopped` exists (user paused monitoring) or `.daemon-restart.lock` is fresh (< 120 s, a restart is in progress);
  - restarts the server when a tick gap exceeds 90 s (sleep/wake);
  - logs "still starting" (never kills, never counts failures) while the process is alive inside its **startup grace** (`.dsh-web.started` younger than `DSH_DAEMON_STARTUP_GRACE`, default 5m) — a `dsh web` with a large plugin set or cold caches can take tens of seconds to minutes before it serves `/health`, and the old hard 90 s verdict made it impossible to start;
  - restarts immediately when the process is gone (crash, `EADDRINUSE` during plugin activation, OOM) instead of waiting out the failure threshold;
  - restarts the server after 3 consecutive failed health checks (process alive past the grace but never healthy);
  - stops the previous server with SIGTERM first, waits up to 8 s for `dsh web` to dispose cleanly and release its listener, escalates to SIGKILL, then waits for the port to be free (up to 5 s) before launching — a fresh `dsh web` that starts onto a held port dies with `EADDRINUSE` during activation;
  - exits when the `.daemon-installed` marker disappears (uninstalled);
- logs to `logs/watchdog.log` (5 MB × 3 rotation).

### 3. Daemon-aware start / stop

- `dsh_daemon_stop` writes `.daemon-stopped` (the watchdog will not restart the server) and stops the daemon-managed server if one is running.
- `dsh_daemon_start` clears the flag, makes sure the watchdog runs, and launches the server if it is unhealthy.

---

## Tools

The plugin is Host-only and registers seven model-callable tools:

| Tool | What it does |
| --- | --- |
| `dsh_daemon_install` | Generates `watchdog.js` + state files, writes the LaunchAgent plist (or systemd unit / cron entry, VBS + Task Scheduler on Windows), starts the watchdog now. Optional `port` argument. |
| `dsh_daemon_uninstall` | Stops the watchdog, unloads and deletes the platform registration, removes all state files. |
| `dsh_daemon_reinstall` | uninstall + install (use after upgrading dsh or changing the port; also regenerates the watchdog with the current auto-update configuration). |
| `dsh_daemon_status` | Installed since, port, local/latest versions, update state, watchdog PID/liveness, manual-stop flag, server health, last log lines. |
| `dsh_daemon_start` | Clears the stopped flag, ensures the watchdog runs, launches the server if unhealthy. |
| `dsh_daemon_stop` | Writes the stopped flag (watchdog will not restart), stops the daemon-managed server if one is running. Never touches the current session. |
| `dsh_daemon_update` | Check for a newer version (`apply: false`, default) or download and apply it (`apply: true`). Also the manual entry point for major version changes. |

### Command line (`dsh-daemon`)

`dsh_daemon_install` also writes a thin **`dsh-daemon`** command into the node
`bin` directory (PATH), so the daemon is controllable from a terminal without
opening the GUI:

| Command | What it does |
| --- | --- |
| `dsh-daemon status` | Same status as the GUI tool. |
| `dsh-daemon restart` | **Immediately** restarts `dsh web` (kills the process on the port and launches a new one; no waiting for the health loop), verified healthy before returning. |
| `dsh-daemon start` | Clears the stopped flag, starts the watchdog if missing, launches the web server if unhealthy. |
| `dsh-daemon stop` | Writes the stopped flag and kills the web server (including a manually started one). |
| `dsh-daemon update` | Check the registry (`--apply` to download and apply). |
| `dsh-daemon install` / `uninstall` / `reinstall` | Registration operations, executed by the plugin through its `/dsh-daemon/command` route — these need `dsh web` to be up (the supervision commands above work standalone via the watchdog script). |
| `dsh-daemon help` | Usage. |

`restart`/`stop` interrupt all open sessions, exactly like a manual `pkill` —
the watchdog relaunches the web server on the next health cycle if the direct
launch fails.

### State files (`$DSH_HOME/daemon/`, `$DSH_HOME` defaults to `~/.dsh`)

```
daemon/
├── watchdog.js            # generated watchdog script (standalone, no deps)
├── .daemon-installed      # install timestamp marker
├── .daemon-port           # supervised port
├── .daemon-stopped        # pause flag: watchdog will not restart the server
├── .daemon-restart.lock   # restart-in-progress marker (TTL 120 s)
├── .dsh-watchdog.pid      # watchdog PID
├── .dsh-web.pid           # daemon-managed web server PID
├── .daemon-update.lock    # update-in-progress lock (concurrency guard)
├── .daemon-update-pending # downloaded update awaiting a restart to activate
├── .daemon-update-check.json  # last update check result (status display)
├── dsh-watchdog.vbs       # Windows: hidden wscript launcher
├── dsh-watchdog-task.xml  # Windows: Task Scheduler XML (UTF-16LE)
└── logs/
    ├── watchdog.log       # watchdog log (5 MB × 3 rotation)
    └── dsh-web.log        # web server stdout/stderr when launched by the watchdog
```

---

## Auto-update

The watchdog checks the npm registry **at startup and every 6 h** and updates
`@chenkai114/dsh-daemon` in the profile directory with pnpm:

- **Version policy**: same-major versions (0.1.3 → 0.1.4, 0.2.x → 0.2.y) update
  automatically; a major change (0.x → 1.x, 1.x → 2.x, …) is only reported and
  requires the manual `dsh_daemon_update` tool.
- **Update modes** (`DSH_DAEMON_UPDATE_MODE`):
  - `restart` (default): after downloading, the watchdog polls the plugin's
    `/dsh-daemon/activity` endpoint (agent turns + background jobs) every 30 s
    and restarts `dsh web` only after it has been idle for the quiet window —
    an in-progress conversation or job defers the restart until it finishes.
    If the endpoint is unreachable (plugin not mounted), the restart still
    happens after `DSH_DAEMON_DEFER_MAX`. Fully unattended.
  - `download`: the new package is installed in the profile and a
    pending marker is written; the update activates on the next natural
    `dsh web` restart. No session is ever interrupted — the user decides when
    the update takes effect.
- **Failure safety**: registry unreachable, pnpm failure, or a version
  mismatch after update only writes a log line and the check state; the old
  package stays installed (pnpm's store keeps it, so
  `dsh plugin --profile web add @chenkai114/dsh-daemon@<old>` rolls back).

Configuration is captured at `dsh_daemon_install`/`reinstall` time and embedded
into the generated watchdog script:

| Env var | Default | Meaning |
| --- | --- | --- |
| `DSH_DAEMON_AUTO_UPDATE` | `1` | `0` disables the checks |
| `DSH_DAEMON_UPDATE_INTERVAL` | `6h` | check interval (`ms`/`s`/`m`/`h`/`d`) |
| `DSH_DAEMON_UPDATE_MODE` | `restart` | `restart` or `download` |
| `DSH_DAEMON_QUIET_WINDOW` | `5m` | idle time required before a restart-mode restart |
| `DSH_DAEMON_DEFER_MAX` | `15m` | max wait for the activity endpoint before restarting anyway |
| `DSH_DAEMON_NPM_REGISTRY` | `https://registry.npmjs.org` | registry used for checks and pnpm update |
| `DSH_DAEMON_PROFILE` | `web` | profile directory holding the plugin |
| `DSH_DAEMON_HEALTH_INTERVAL` | `30s` | health-check interval of the watchdog loop (`ms`/`s`/`m`; 3 failures outside the startup grace trigger a restart) |
| `DSH_DAEMON_STARTUP_GRACE` | `5m` | startup grace for `dsh web` (`ms`/`s`/`m`): health misses inside it never count towards a restart and never kill the process. Keep the default for a large plugin set or a slow cold boot; lower it (e.g. `90s`) if you know your `dsh web` is up in seconds and you want a genuinely hung boot detected sooner |
| `DSH_DAEMON_OPEN_BROWSER` | `1` | when `0`, never auto-open the browser even when a new-dsh launch token is detected (the URL is still written to `~/.dsh/daemon/.web-auth-url` and the watchdog log for manual access) |
| `DSH_DAEMON_CLI_DIR` | node bin dir | directory for the generated `dsh-daemon` CLI (tests/sandboxed installs point it at a temp dir to avoid polluting the real PATH) |
| `DSH_DAEMON_NO_SYSTEM` | unset | when `1`, skips system-level registration (launchd/schtasks/systemd) — test/sandboxed installs never touch the host's services; the watchdog is still started directly |
| `DSH_DAEMON_TRUSTED_HOST` | unset | Reverse-proxy deployments: the host (comma-separated list) is captured at install/reinstall time and embedded into the generated watchdog so `dsh web` is launched with `--trusted-host`; without it dsh's `/api` trust fence answers 403 for the public Host. It is embedded because the plugin's own nohup-started watchdog never sees the plist/unit environment |
| `DSH_DAEMON_ALLOW_EPHEMERAL_HOME` | unset | `1` allows registering against a temporary `DSH_HOME` (`/tmp`, `/var/folders`); by default the canonical `~/.dsh` is used instead, so cleaning a temp dir can no longer leave the LaunchAgent/systemd registration permanently broken (test runs with `DSH_DAEMON_NO_SYSTEM=1` are never redirected) |
| `DSH_DAEMON_TRUSTED_HOST` | unset | comma-separated `--trusted-host` list (e.g. `dsh.example.com,192.168.5.5:8080`). When dsh web is reached through a reverse proxy (nginx) the Host header is the public hostname and the /api browser-trust fence would reject it with 403 — set this to make dsh web trust those Hosts |

> The auto-update logic lives in the generated `watchdog.js`; after upgrading
> to a version with new update logic, run `dsh_daemon_reinstall` once to
> regenerate it.

---

## Verification

All of the following were verified end-to-end against the real plugin code:

- install → `plutil -lint` OK, `launchctl list` shows the agent, watchdog logs `watchdog started (PID …, port 3080)` / `web server already healthy on port 3080`;
- on an empty port the watchdog launches a real `dsh web --port <port>` at startup (health OK on the new port);
- self-heal: after `SIGKILL` of the managed server → `health check failed (1/3 → 2/3 → 3/3)` → `failure threshold reached, restarting web server` → new process serves 200;
- startup grace (`node test/startup-grace.test.js`, real generated watchdog + fake `dsh`): a boot that only serves /health after 8 s is only logged as "still starting" inside a 20 s grace (no restart, no kill); once a 2 s grace expires the previous process is stopped with SIGTERM before a relaunch, and every relaunch follows such a stop (port released first);
- launchd `KeepAlive`: `SIGKILL` of the watchdog → launchd restarts it within ~11 s;
- single-instance guard: running `watchdog.js` a second time exits immediately;
- `stop` writes the pause flag and kills only the daemon-managed server; `start` clears it; `uninstall` removes launchd registration, plist, state files and frees the port; `status` reflects every state.

### Local test

```bash
node test/harness.js dsh_daemon_status          # static package mode
DYNAMIC=1 node test/harness.js dsh_daemon_status # dynamic sandbox mode
node test/startup-grace.test.js                 # startup grace: slow boot survives, grace expiry restarts, graceful stop
```

The harness runs the real plugin code with real bash/fs and invokes the tool
for real.

### v0.1.19 — dsh web token-auth adaptation (seeding the `?token=` launch token)

Since `dsh` ≥ 0.1.2-alpha.1 (harness commit 3e24087bfa) `dsh web` generates an
in-process random token at startup and prints
`dsh web: http://127.0.0.1:<port>/?token=...`: the browser must visit that URL
once to seed a 30-day host-only Cookie (the signing key persists across
restarts; a bare 3080 visit with no Cookie → 401). The watchdog used to launch
with `--no-open`, so the user's browser never got a Cookie and the daemon-managed
web was 401.

**Adaptation**: after launching, the watchdog extracts the **current run's**
token URL from `dsh-web.log` (the web process stdout), then:

- `?token=` detected (new dsh) → open the default browser once to seed the
  Cookie (same as manual `dsh web`); if opening fails (headless), the URL is
  already on disk for manual access;
- not detected (old dsh) → status quo (`--no-open`, never touch the browser);
- the URL is always written to `~/.dsh/daemon/.web-auth-url` (0600, overwritten
  each launch) and shown by `dsh-daemon status`;
- `DSH_DAEMON_OPEN_BROWSER=0` disables the auto-popup (disk + log only);
- the scan is anchored to the pre-launch file offset: the append-only POSIX log
  never reuses an old run's dead token (the LAST `dsh web:` line of the current
  run's segment wins; win32 `Start-Process` overwrite semantics fall back to
  reading the whole file, and `dsh-web.log.1` — the previous process — is never
  read);
- the probe is cross-version stable: `dsh web: http://...` has been printed by
  every dsh version, old and new differ only in whether the URL carries
  `?token=` — so `?token=` presence is the judge, robust to future versions;
- reverse insurance: if a new dsh's token line is slow to appear the watchdog
  KEEPS WAITING (fast poll 15s@250ms then a slow retry phase 75s@5s) instead of
  dismissing it as "no token" (treating a probe failure as old dsh would miss
  the auth); on total timeout it only logs and the next launch retries;
- popup throttle: the token changes on every start but the 30-day cookie
  outlives any single token (persistent signing key), so the browser is not
  re-opened when the URL equals the last recorded one (`.web-auth-url` is still
  refreshed for manual access); `SSH_CONNECTION`/`SSH_TTY` non-empty suppresses
  the popup entirely (never open a browser on a remote host's desktop);
- the version gate mirrors the `--no-open` pattern
  (`DSH_TOKEN_AUTH_MIN = 0.1.2-alpha.1`, module-scope functions inlined into the
  watchdog via `toString()`, re-decided at every launch) and only skips the poll
  when the installed dsh is **known** to predate token auth; the URL-line probe
  is the authoritative detector.

### v0.1.18 — Windows black-box fix: hidden console, not no console; `start` waits for health

On Windows the watchdog spawns `dsh web`, pnpm, netstat, etc. with
`CP.spawn(..., { detached: true })`, and Node gives detached children their
**own console window** by default (the watchdog itself runs hidden — VBS /
Task Scheduler — and has no console), so every launch/restart flashed black
boxes. Once v0.1.17 fixed the `--no-open` restart loop, the black boxes became
the visible problem.

**Mechanism choice (deepseek-harness discussion #1564 / #810)**: `dsh web`
must NOT be launched with `windowsHide` (CREATE_NO_WINDOW) — a console-less
host forces every child it spawns to allocate a new visible console, and
CREATE_NO_WINDOW kills the Windows ACL sandbox's restricted-token children
with 0xC0000142 (DLL initialization failed). The correct approach is to give
`dsh web` a **hidden console** (STARTF_USESHOWWINDOW + SW_HIDE, keeping
dwCreationFlags=0 — on Windows implemented via `Start-Process -WindowStyle
Hidden`, matching the `dsh-daemon start` direct-launch path): dsh web has no
visible window itself, and its console children inherit that hidden console,
so nothing flashes at any level.

- on win32 the watchdog now launches dsh web through
  `powershell.exe -Command "Start-Process -FilePath <node> -ArgumentList ...
  -WindowStyle Hidden -RedirectStandardOutput <web.log> -PassThru"` (the
  powershell wrapper itself uses windowsHide — short-lived, normal token,
  safe); the wrapper writes the PID file and the watchdog polls for it;
  ⚠️ the wrapper must NOT use `detached: true` — Node maps it to
  `DETACHED_PROCESS` on Windows, which hangs the Start-Process command (no PID
  file, child never starts; reproduced empirically). Start-Process children
  are independent processes anyway, so the short-lived wrapper needs no
  detachment; Start-Process redirects with OVERWRITE semantics, so before
  each launch the old `dsh-web.log` is rotated to `dsh-web.log.1` (the
  previous run's crash output survives; the log stays bounded — current +
  one previous run, never unbounded);
- the watchdog's other short-lived children (self-spawn, pnpm, idle-restart
  waiter, netstat/lsof probes) keep `windowsHide: true` — safe under a normal
  token, consistent with the discussion's subprocess-local treatment;
- `dsh-daemon start` now polls for health after launching (like `restart`
  does, up to ~13 s) before returning — previously `start` returned while
  `dsh web` was still booting, the next `status` looked unhealthy, and users
  ran `start` again, which killed the still-booting first instance via the
  PID file;
- template assertions: every spawn site carries `windowsHide`, and the win32
  web launch must go through `Start-Process -WindowStyle Hidden` (regression
  guard).

> Note: the DSH-internal layer from #1564 (two spawns in
> `dsh-sandbox-windows-acl` `dwFlags:256→257` + `wShowWindow:0`;
> `windowsHide:true` in `dsh-subprocess-local`) is a patch to dsh itself, not
> this repo; re-apply it after upgrading dsh (the community script
> `Culeot/dsh-no-console-flash` is idempotent).

### v0.1.17 — pass `--no-open` only when the dsh version supports it

Since v0.1.16 the watchdog launched `dsh web --port <port> --no-open`, but
`--no-open` only exists in `@deepseek-ai/dsh` **0.1.0-rc.8** (dsh-web-app
0.1.0-rc.8, which also introduced default browser opening). Older CLIs reject
the flag with `unknown option '--no-open'` and exit immediately, so the
watchdog fell into a restart loop: launch → instant death → failed health
check → relaunch, and web never came up.

- The watchdog reads the dsh package `package.json` version at every launch
  and appends `--no-open` only when it is **≥ 0.1.0-rc.8** (semver, including
  prerelease ordering); an unknown/unreadable version conservatively skips the
  flag — the server still starts, and pre-rc.8 dsh never opened a browser
  anyway, so nothing is lost;
- the `dsh-daemon start` direct-launch commands (Windows `Start-Process` /
  Unix `nohup`) make the same version-based decision;
- the gate is a single module-scope implementation; the watchdog inlines the
  exact same code via `Function.prototype.toString()`, so dsh upgrades or
  downgrades take effect at the next launch without reinstalling the daemon;
- new `test/version-gate.test.js` unit tests (run by `npm test`).

### v0.1.16 — health check, browser pop-ups, and env forwarding

- **`/health` route**: the watchdog health-checks
  `http://127.0.0.1:<port>/health` every 30 s, but deepseek-harness's web
  server has no such route (unknown paths 404), so a running web was
  reported unhealthy forever. The plugin now registers `/health` itself,
  returning `200 {"ok":true}` — plugin up means web up, and the check is
  reliable.
- **`--no-open`**: daemon-managed web restarts (auto-update, self-heal) no
  longer pop a browser tab; manual `dsh web` still opens by default.
- **Env forwarding**: `dsh-daemon install/uninstall/reinstall` execute in
  the web process via the `/dsh-daemon/command` route, so `DSH_DAEMON_*`
  variables from the invoking shell never reached the plugin. The CLI
  wrapper now collects all `DSH_DAEMON_*` from the current shell and
  forwards them with the request, so
  `DSH_DAEMON_UPDATE_INTERVAL=1m dsh-daemon reinstall` configures the
  watchdog correctly.

### v0.1.15 — test/sandboxed installs no longer touch the host

Test harness installs with a temp HOME used to pollute the real environment;
two switches close that gap:

- `DSH_DAEMON_CLI_DIR`: overrides where the generated `dsh-daemon` CLI is
  written (default: node bin) — tests point it at a temp dir so the real
  wrapper on PATH is never overwritten;
- `DSH_DAEMON_NO_SYSTEM`: when `1`, skips system-level registration
  (launchd/schtasks/systemd) so a test install cannot steal the system
  service label and leave the real daemon dead. The harness sets both by
  default.

### v0.1.14 — restart is now the default auto-update mode

The default of `DSH_DAEMON_UPDATE_MODE` changed from `download` to
`restart`: when unset, after an update is downloaded the watchdog restarts
`dsh web` on its own once it is idle (fully unattended, never interrupting
an in-progress session). Set it explicitly to `download` when you want to
control when the update takes effect.

### v0.1.13 — watchdog regenerated automatically after auto-update

Previously auto-update only refreshed the npm package; the already-generated
`watchdog.js` (a one-time artifact from install time) never picked up the new
generator logic — a manual `dsh_daemon_reinstall` was required. Since v0.1.13:

- the plugin version is embedded into the generated watchdog (`GEN_VERSION`);
- on every plugin boot the script's `GEN_VERSION` is compared with the
  installed package version; when they differ (after an auto-update, or a
  manual package upgrade) the plugin regenerates `watchdog.js` and the CLI
  wrapper and restarts the watchdog process;
- so after an auto-update (user restarts web in download mode, or the
  idle-aware restart does it in restart mode) or a manual upgrade + web
  restart, the watchdog catches up with the new version on its own — no
  manual `dsh_daemon_reinstall`;
- test/development loads can skip the sync with `DSH_DAEMON_AUTOREGEN=0`.

### v0.1.12 — Windows console-flash regression fix

v0.1.11 added `windowsHide: true` (Windows `CREATE_NO_WINDOW`) to the
watchdog's `launch()` and other spawns. The side effect: the `dsh web`
process **lost its console handle**, so any child it spawns afterwards (git,
tool executions, …) gets a **visible** console window on Windows — frequent
console flashes while the server runs ([issue #1](https://github.com/chenkai2/dsh-daemon/issues/1)).

v0.1.12 removes all four `windowsHide` flags and restores the v0.1.10 model:
the watchdog is started by VBS `shell.Run ..., 0` (SW_HIDE) with its own
**hidden console**, the web process inherits it, and web's children inherit in
turn — the whole chain stays windowless (verified on v0.1.10).

> Note: if console windows still flash during plugin install/command execution
> (the DSH sandbox/subprocess path, not this plugin's watchdog), that is a
> deepseek-harness Windows console-handling issue, not this plugin — see
> [discussion #1564](https://github.com/deepseek-ai/deepseek-harness/discussions/1564)
> and the Culeot/dsh-no-console-flash patch.

---

## License

MIT
