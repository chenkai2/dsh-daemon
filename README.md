# dsh-daemon

Register the **DeepSeek Harness** web server (`dsh web`) as an auto-start,
self-healing background service — a faithful port of
[`wecode daemon install`](https://github.com/weibo/wecode-cli) for DSH.

After install, `dsh web`:

- starts automatically on login (LaunchAgent `RunAtLoad` / systemd `WantedBy=default.target` / cron `@reboot`),
- restarts automatically after sleep/wake,
- self-heals: a watchdog health-checks `http://127.0.0.1:<port>/health` every 30 s and restarts the server after 3 consecutive failures,
- survives this session: the watchdog is a standalone generated script, not an in-memory plugin.

The currently running session is never touched by install/uninstall.

---

## How `wecode daemon install` works (the original)

The wecode CLI (`~/.wecode/wecode-cli/bin/cli.js`) implements a
**watchdog-supervisor architecture** rather than a plain login item:

| Piece | wecode implementation |
| --- | --- |
| `daemon install` | Captures `WECODE_CLI_PORT` + key env vars, writes a `.daemon-installed` timestamp marker, clears the `.daemon-stopped` pause flag, then registers a platform service that runs `wecode daemon --run-watchdog`: macOS `~/Library/LaunchAgents/com.weibo.wecode-watchdog.plist` (`RunAtLoad`, `KeepAlive{SuccessfulExit:false}`, `ThrottleInterval=10`, captured env) + `launchctl load -w`; Linux systemd user unit (`Restart=always`) with a cron `@reboot` fallback; Windows `schtasks` + VBS launcher. Finally it spawns the watchdog for the current session. |
| `daemon --run-watchdog` | The watchdog loop (`JU()` in cli.js): writes its PID to `.wecode-watchdog.pid`; on SIGINT/SIGTERM/SIGHUP cleans up and exits; at startup launches the proxy if `/health` is not OK; then every 30 s — skip when `.daemon-stopped` exists (user paused) or `.daemon-restart.lock` is fresh (< 120 s, a restart is in progress); restart the proxy when the tick gap exceeds 90 s (sleep/wake); restart after 3 consecutive failed health checks. Logs to `logs/watchdog.log` (5 MB × 3 rotation). |
| daemon-aware `start/stop/restart` | `stop` writes `.daemon-stopped` (the watchdog will not restart it) and kills the service; `start` clears the flag; `restart` writes `.daemon-restart.lock` around stop → start → silent `daemon reinstall` → delete lock. |
| `daemon uninstall` | SIGTERMs the watchdog, `launchctl unload -w` + removes the plist (or systemd disable / cron removal), deletes every state file. |

## This port

The DSH plugin reproduces the same design. The only structural difference:
wecode embeds the watchdog loop in the CLI (`daemon --run-watchdog`); DSH has
no such CLI mode, so the plugin **generates a standalone, dependency-free
Node script** at `$DSH_HOME/daemon/watchdog.js` (same loop: 30 s interval,
3-failure threshold, 90 s sleep/wake gap, 120 s restart-lock TTL, PID files,
rotating log). launchd/systemd/cron run that script, so self-healing keeps
working even when no session is open. An extra single-instance lock prevents
duplicate watchdogs.

### Tools

The plugin is Host-only and registers six model-callable tools:

| Tool | wecode equivalent | What it does |
| --- | --- | --- |
| `dsh_daemon_install` | `wecode daemon install` | Writes `watchdog.js` + state files, writes the LaunchAgent plist (or systemd unit / cron entry), `launchctl load -w`, starts the watchdog now. Optional `port` arg. |
| `dsh_daemon_uninstall` | `wecode daemon uninstall` | Stops the watchdog, unloads and deletes the platform registration, removes all state files. |
| `dsh_daemon_reinstall` | `wecode daemon reinstall` | uninstall + install (use after upgrading dsh or changing the port). |
| `dsh_daemon_status` | `wecode daemon status` | Installed since, port, watchdog PID/liveness, manual-stop flag, server health, last log lines. |
| `dsh_daemon_start` | daemon-aware `wecode start` | Clears the stopped flag, ensures the watchdog runs, launches the server if unhealthy. |
| `dsh_daemon_stop` | daemon-aware `wecode stop` | Writes the stopped flag (watchdog will not restart), stops the daemon-managed server if one is running. Never touches the current session. |

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
└── logs/
    ├── watchdog.log       # watchdog log (5 MB × 3 rotation)
    └── dsh-web.log        # web server stdout/stderr when launched by the watchdog
```

Platform registration: macOS `~/Library/LaunchAgents/com.deepseek-ai.dsh-watchdog.plist`; Linux `~/.config/systemd/user/dsh-watchdog.service` (cron `@reboot` fallback); Windows is not supported yet.

---

## Usage

### As a DSH composition row (static package)

Add to the web profile's `cordis.yml` (or a patch layer):

```yaml
- id: dsh-daemon
  name: '@chenkai2/dsh-daemon'
```

(`npm install @chenkai2/dsh-daemon` into the deployment first, or vendor the
package into the deployment's `node_modules`.)

### As a dynamic Cordis plugin

The file `lib/index.js` is dual-mode: paste its content into the `code.host`
field of `cordis_define` (the sandbox supplies the `harness` global; the file
ends with `return plugin;`). That is how this plugin was originally built and
verified inside a live session.

### Port

Default port is the currently listening `webServer` port (usually `3080`),
then `DSH_WEB_PORT`, then the explicit `port` tool argument. After changing
the port, run `dsh_daemon_reinstall`.

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
