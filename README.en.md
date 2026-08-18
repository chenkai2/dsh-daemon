# dsh-daemon

[中文](README.md) | [English](README.en.md)

Register the **DeepSeek Harness** web server (`dsh web`) as an auto-start,
self-healing background service.

After install, `dsh web`:

- starts automatically on login (LaunchAgent `RunAtLoad` / systemd `WantedBy=default.target` / cron `@reboot`),
- restarts automatically after sleep/wake,
- self-heals: a watchdog health-checks `http://127.0.0.1:<port>/health` every 3 s (configurable) and restarts the server after 3 consecutive failures,
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

2. Add a loader patch entry to the web profile so the plugin mounts at the
   next boot:

   ```yaml
   # ~/.dsh/profiles/web/cordis.patch.yml
   - insert:
       - id: dsh-daemon
         name: '@chenkai114/dsh-daemon'
   ```

3. Restart `dsh web`. The seven `dsh_daemon_*` tools then become available to
   every agent — just ask the agent to run `dsh_daemon_install`.

To upgrade later: `dsh plugin --profile web update @chenkai114/dsh-daemon`
(plus a restart).

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
- then every 3 s (configurable via `DSH_DAEMON_HEALTH_INTERVAL`):
  - skips when `.daemon-stopped` exists (user paused monitoring) or `.daemon-restart.lock` is fresh (< 120 s, a restart is in progress);
  - restarts the server when a tick gap exceeds 90 s (sleep/wake);
  - restarts the server after 3 consecutive failed health checks;
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
  - `download` (default): the new package is installed in the profile and a
    pending marker is written; the update activates on the next natural
    `dsh web` restart. No session is ever interrupted.
  - `restart`: after downloading, the watchdog polls the plugin's
    `/dsh-daemon/activity` endpoint (agent turns + background jobs) every 30 s
    and restarts `dsh web` only after it has been idle for the quiet window —
    an in-progress conversation or job defers the restart until it finishes.
    If the endpoint is unreachable (plugin not mounted), the restart still
    happens after `DSH_DAEMON_DEFER_MAX`.
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
| `DSH_DAEMON_UPDATE_MODE` | `download` | `download` or `restart` |
| `DSH_DAEMON_QUIET_WINDOW` | `5m` | idle time required before a restart-mode restart |
| `DSH_DAEMON_DEFER_MAX` | `15m` | max wait for the activity endpoint before restarting anyway |
| `DSH_DAEMON_NPM_REGISTRY` | `https://registry.npmjs.org` | registry used for checks and pnpm update |
| `DSH_DAEMON_PROFILE` | `web` | profile directory holding the plugin |
| `DSH_DAEMON_HEALTH_INTERVAL` | `3s` | health-check interval of the watchdog loop (`ms`/`s`/`m`; 3 failures trigger a restart) |

> The auto-update logic lives in the generated `watchdog.js`; after upgrading
> to a version with new update logic, run `dsh_daemon_reinstall` once to
> regenerate it.

---

## Verification

All of the following were verified end-to-end against the real plugin code:

- install → `plutil -lint` OK, `launchctl list` shows the agent, watchdog logs `watchdog started (PID …, port 3080)` / `web server already healthy on port 3080`;
- on an empty port the watchdog launches a real `dsh web --port <port>` at startup (health OK on the new port);
- self-heal: after `SIGKILL` of the managed server → `health check failed (1/3 → 2/3 → 3/3)` → `failure threshold reached, restarting web server` → new process serves 200;
- launchd `KeepAlive`: `SIGKILL` of the watchdog → launchd restarts it within ~11 s;
- single-instance guard: running `watchdog.js` a second time exits immediately;
- `stop` writes the pause flag and kills only the daemon-managed server; `start` clears it; `uninstall` removes launchd registration, plist, state files and frees the port; `status` reflects every state.

### Local test

```bash
node test/harness.js dsh_daemon_status          # static package mode
DYNAMIC=1 node test/harness.js dsh_daemon_status # dynamic sandbox mode
```

The harness runs the real plugin code with real bash/fs and invokes the tool
for real.

---

## License

MIT
