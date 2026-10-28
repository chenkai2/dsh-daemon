## 版本对照（dsh-daemon ↔ dsh）

| dsh-daemon | 支撑的 dsh | 说明 |
|---|---|---|
| 0.1.29 | **0.1.x 与 0.2.x** | 自动更新加 dsh 兼容门禁：每版在 `package.json` 声明 `dsh.requires.dsh`，更新前比对客户端已装 dsh 版本，**不满足/未声明/读不到就跳过自动升级**（`dsh-daemon update --apply` 可人工强制）；更新检查改为 2 次尝试 + 15s 预算，错误细分为 timeout / DNS / HTTP / 连接失败，status 显示上次成功检查时间 |
| 0.1.28 | **0.1.x 与 0.2.x** | 修「健康检查误杀 + 重启风暴」：`/health` 单次预算 5s → **20s**、失败阈值 3 → **5**（~50s 真超时才重启）；tick 串行（`tickBusy`）+ `launch()` 单飞，杜绝同一秒拉起两个 dsh web（`EADDRINUSE`）；**收养**未托管但正在服务的 dsh web（纠正 pid 文件）而不是再拉一个；停进程前校验「这个 PID 真的是 dsh web」（PID 复用不误杀）；`status` 报出 pid 文件与实际监听者不一致；非 JS 入口（`dsh.ps1`/`.cmd` shim）拒绝启动并明确报错 |
| 0.1.27 | **0.1.x 与 0.2.x** | 健康检查间隔默认 30s → **10s**（自愈更快）；新增 `dsh-daemon logs` 与 `dsh_daemon_logs`：dsh web 启动失败时像 systemctl 一样打印明细入口（web + watchdog 日志尾部、`/health`、PID、启动时长） |
| 0.1.26 | **0.1.x 与 0.2.x** | 启动宽限期：`dsh web` 启动慢（大插件集、冷缓存）时不再被 watchdog 按 90 秒判死反复重启，宽限期内不计健康失败（`DSH_DAEMON_STARTUP_GRACE`，默认 5 分钟）；停旧进程改为先 SIGTERM 再 SIGKILL 并等端口真正释放（修 `EADDRINUSE` 连锁失败）；`status` / `start` 如实报「仍在启动」 |
| 0.1.25 | **0.1.x 与 0.2.x** | 适配 0.2.x 的 shell 服务改名：`run(spec)` → `execute(spec)` + 句柄 `result()`（0.2.1 上 `reinstall` 曾报 `shell.run is not a function`），并兼容两种结果形状 |
| 0.1.24 | 0.1.x（0.2.x 部分路径不可用） | OIDC 发布流水线；未适配 0.2.x shell API |
| 0.1.23 | ≥ `0.1.2-alpha.1`（token 认证起） | 注册漂移自愈、status 如实上报注册状态、拒绝易失 DSH_HOME |
| 0.1.21–0.1.22 | 同上 | 单实例守卫校验 cmdline、dsh web 显式传 cwd |
| 0.1.20 | 同上 | `DSH_DAEMON_TRUSTED_HOST`：反代场景下给 dsh web 追 `--trusted-host` |
| 0.1.19 | 同上 | 自动开浏览器补齐 token 认证的入场 cookie |
| ≤ 0.1.18 | ≥ `0.1.0-rc.8`（`--no-open` 起） | 更早的 dsh 没有 `--no-open`，watchdog 启动时会跳过该参数 |

两个门限常量取自代码（`lib/index.js`）：`DSH_NO_OPEN_MIN = 0.1.0-rc.8`、`DSH_TOKEN_AUTH_MIN = 0.1.2-alpha.1`。
dsh 侧与 daemon 交互的接口只有三处：web 启动参数、`/health` 探活、以及注入的 `shell`/`fs` 服务 —— 后者是 0.2.x 唯一改过的地方。

---

# dsh-daemon

[中文](README.md) | [English](README.en.md)

将 **DeepSeek Harness** 网络服务（`dsh web`）注册为**自启动、自愈**的后台服务。

安装后，`dsh web` 将：

- 登录时自动启动（LaunchAgent `RunAtLoad` / systemd `WantedBy=default.target` / cron `@reboot`）
- 睡眠唤醒后自动重启
- 自愈：watchdog 每 **10 秒**（可配置）健康检查一次 `http://127.0.0.1:<port>/health`，连续 3 次失败后重启服务
- 慢启动安全：刚拉起的 `dsh web` 处在**启动宽限期**（`DSH_DAEMON_STARTUP_GRACE`，默认 5 分钟）内时，健康检查失败不计入重启阈值，进程也不会被杀
- 不依赖当前会话：watchdog 是独立生成的脚本，而非内存中的插件

安装/卸载**永远不会触碰**当前正在运行的会话。

> 账号对应关系（npm scope / GitHub 账号）见 [CONTEXT.md](CONTEXT.md)。

---

## 使用方式

### 方式 A —— 用 `dsh plugin` 安装（v0.1.9+，推荐）

1. 用官方插件管理器将包安装到 **web profile**（在 profile 目录内运行 pnpm，使 loader 能解析到它；仅全局安装不够——见下）：

   ```bash
   dsh plugin --profile web add @chenkai114/dsh-daemon
   ```

   （需要 PATH 上有 `pnpm`——用 `corepack enable` 一次性启用。）

   > 为什么不能只 `npm install -g`？loader 以 Node ESM 解析导入 `name:` 行，解析锚点是 profile 目录（`~/.dsh/profiles/web/`）；全局 `node_modules` 不在该解析链上（`NODE_PATH` 对 ESM 无效）。profile 自己的 `node_modules`——由 pnpm 管理——才是包可达的原因。

2. 重启 `dsh web`。包声明了 `dsh.bundle` manifest，`dsh plugin add` 会把它自动加入 `dsh.profile.bundles`，启动时作为 bundle 层挂载——**不需要**（也**不应该**）再手动往 `~/.dsh/profiles/web/cordis.patch.yml` 里 insert 同一行，否则会触发 `duplicate loader entry id: dsh-daemon` 启动失败。

   七个 `dsh_daemon_*` 工具即可供每个 agent 使用——直接让 agent 运行 `dsh_daemon_install`。

以后升级：`dsh plugin --profile web update @chenkai114/dsh-daemon`（并重启）。

> ⚠️ 从 v0.1.8 及更早版本升级：如果你之前按旧文档在 `~/.dsh/profiles/web/cordis.patch.yml` 里手动加过 `- insert: dsh-daemon` 行，升级后必须**删掉那一行**（保留文件里其他内容），否则 bundle 层 + 手动层会插入同一个 `id: dsh-daemon` 两次，`dsh web` 启动时报 `duplicate loader entry id`。删除后重启即可。

> 权限说明：daemon 管理用户级系统服务（LaunchAgent plist、`$DSH_HOME` 下的状态文件），因此插件对其文件与命令操作请求 `danger-full-access`。若部署拒绝提权，工具会以沙箱拒绝失败。

### 方式 B —— 动态 Cordis 插件（无需安装）

将 `lib/index.js` 的内容粘贴到 `cordis_define` 的 `code.host` 字段并运行。这正是插件在真实会话中开发与验证的方式：沙箱提供 `harness` 全局，文件以 `return plugin;` 结尾。

### 端口

默认端口为当前监听的 `webServer` 端口（通常 `3080`），其次 `DSH_WEB_PORT`，再其次工具显式 `port` 参数。更换端口后运行 `dsh_daemon_reinstall`。

---

## 架构

守护进程是一个**watchdog 监督者**，由三部分组成。

### 1. 平台注册

一个按用户注册的服务，负责在登录时启动 watchdog 并保持其存活：

| 平台 | 机制 |
| --- | --- |
| macOS | LaunchAgent `~/Library/LaunchAgents/com.deepseek-ai.dsh-watchdog.plist` —— `ProgramArguments=[node, watchdog.js]`、`RunAtLoad`、`KeepAlive{SuccessfulExit:false}`、`ThrottleInterval=10`，环境变量携带 `DSH_WEB_PORT` 与 `DSH_HOME`。通过 `launchctl load -w` 加载。 |
| Linux | systemd 用户单元 `~/.config/systemd/user/dsh-watchdog.service` —— `Type=simple`、`Restart=always`、`RestartSec=10`、`StartLimitIntervalSec=0`；通过 `systemctl --user enable --now` 启用。systemd 不可用时回退为 cron `@reboot` 条目。 |
| Windows | VBS 启动器 + 计划任务 —— 任务 `DshWatchdog`（XML 在 `$DSH_HOME/daemon/dsh-watchdog-task.xml`，UTF-16LE）在登录时运行 `wscript.exe //B dsh-watchdog.vbs`；VBS 设置 `DSH_WEB_PORT`/`DSH_HOME` 并以隐藏窗口启动 `node watchdog.js`。`RestartOnFailure` PT1M/999，`MultipleInstancesPolicy=IgnoreNew`。通过 `schtasks /Create` 注册。 |

> Windows 支持按 macOS/Linux 的同等行为实现（插件的 shell 层在 win32 下切换到 PowerShell，即 DSH 的 shell 执行器），但尚未在真实 Windows 机器上验证。

### 2. watchdog 循环

生成的独立脚本 `$DSH_HOME/daemon/watchdog.js`（零依赖，任意 Node ≥ 18 可运行，无需会话）：

- 将自身 PID 写入 `.dsh-watchdog.pid`；SIGINT / SIGTERM / SIGHUP 清理后退出；单实例锁拒绝重复的 watchdog
- 启动时若 `http://127.0.0.1:<port>/health` 不健康，则拉起 web 服务（`node <dsh> web --port <port>`，分离运行，输出到 `logs/dsh-web.log`）
- 之后每 10 秒（可通过 `DSH_DAEMON_HEALTH_INTERVAL` 配置）：
  - 存在 `.daemon-stopped`（用户暂停监控）或 `.daemon-restart.lock` 较新（< 120 秒，重启进行中）时跳过；
  - tick 间隔超过 90 秒（睡眠唤醒）时重启服务；
  - 服务仍在**启动宽限期**内（`.dsh-web.started` 距今 < `DSH_DAEMON_STARTUP_GRACE`，默认 5 分钟）且进程存活时，只记录「仍在启动」，不计失败、不重启——大插件集/冷缓存的 `dsh web` 可能几十秒到几分钟才对外提供 `/health`，旧的「90 秒判死」会让它永远起不来；
  - 进程已消失（崩溃、激活期 `EADDRINUSE`、OOM）时立刻重启，不等满 3 次失败；
  - 连续 3 次健康检查失败后重启服务（进程存活但超过宽限期仍未健康）；
  - 停旧进程先发 SIGTERM，等待最多 8 秒（`dsh web` 会优雅退出并释放监听端口），仍不退再 SIGKILL；随后等端口真正空闲（最多 5 秒）才拉起新进程，避免新进程在插件激活期报 `EADDRINUSE` 而秒退；
  - `.daemon-installed` 标记消失（已卸载）时退出；
- 日志写入 `logs/watchdog.log`（5 MB × 3 轮转）。

### 3. daemon 感知的 start / stop

- `dsh_daemon_stop` 写入 `.daemon-stopped`（watchdog 不再重启服务），并停止正在运行的托管服务。
- `dsh_daemon_start` 清除该标记、确保 watchdog 运行，并在服务不健康时拉起它。

---

## 工具

插件仅包含 Host 侧，注册 8 个可供模型调用的工具：

| 工具 | 功能 |
| --- | --- |
| `dsh_daemon_install` | 生成 `watchdog.js` 与状态文件，写入 LaunchAgent plist（或 systemd 单元 / cron 条目、Windows 的 VBS + 计划任务），立即启动 watchdog。可选 `port` 参数。 |
| `dsh_daemon_uninstall` | 停止 watchdog，卸载并删除平台注册，清除全部状态文件。 |
| `dsh_daemon_reinstall` | 先卸载再安装（升级 dsh 或更换端口后使用；同时按当前自动更新配置重新生成 watchdog）。 |
| `dsh_daemon_status` | 安装时间、端口、本地/最新版本、更新状态、watchdog PID/存活、手动停止标记、服务健康、最近日志。服务不健康时额外打印 `Details:` 行指向 `dsh_daemon_logs`。 |
| `dsh_daemon_logs` | dsh web 启动失败的明细入口：web 服务 stdout/stderr 日志尾部 + watchdog 日志尾部，附当前 `/health`、web PID 与本次启动时长。可选 `lines`（默认 50）与 `source`（`all`/`web`/`watchdog`）。终端等价命令 `dsh-daemon logs`。 |
| `dsh_daemon_start` | 清除停止标记，确保 watchdog 运行，服务不健康时拉起。 |
| `dsh_daemon_stop` | 写入停止标记（watchdog 不再重启），停止托管服务（若有）。绝不触碰当前会话。 |
| `dsh_daemon_update` | 检查新版本（默认 `apply: false`）或下载并应用（`apply: true`）。也是大版本变更的人工入口。 |

### 命令行（`dsh-daemon`）

`dsh_daemon_install` 还会在 node 的 `bin` 目录（PATH 内）生成一个轻量 **`dsh-daemon`** 命令，无需打开 GUI 即可在终端控制 daemon：

| 命令 | 功能 |
| --- | --- |
| `dsh-daemon status` | 与 GUI 工具相同的状态。 |
| `dsh-daemon restart` | **立即**重启 `dsh web`（杀掉端口上的进程并拉起新进程，无需等待健康循环），返回前已验证健康。 |
| `dsh-daemon start` | 清除停止标记；watchdog 缺失时启动；web 不健康时拉起。 |
| `dsh-daemon stop` | 写入停止标记并杀掉 web 服务（包括手动启动的）。 |
| `dsh-daemon logs` | 查看明细：web 日志与 watchdog 日志尾部（`-n 100` 指定行数，`--web` / `--watchdog` 只看一个）。dsh web 启动失败时用这个命令。 |
| `dsh-daemon update` | 检查 registry（加 `--apply` 下载并应用）。 |
| `dsh-daemon install` / `uninstall` / `reinstall` | 注册类操作，由插件通过其 `/dsh-daemon/command` 路由执行——需要 `dsh web` 处于运行状态（上面的监督类命令通过 watchdog 脚本独立工作）。 |
| `dsh-daemon help` | 用法说明。 |

`restart`/`stop` 会中断所有打开的会话，与手动 `pkill` 效果相同——若直接拉起失败，watchdog 会在下一个健康周期重新拉起 web 服务。

#### 启动失败的明细入口

像 `systemctl` 在服务启动失败时打印「用 journalctl 看明细」一样，daemon 的每条失败信息都指向同一个命令：

```
$ dsh-daemon restart
dsh-daemon: restarting dsh web on port 3080...
  launched dsh web (PID 51234)
❌ dsh web exited during startup — last log lines:
     | Error: cannot find module @acme/plugin-x
     |     plugin activation failed for row "plugin-x"
   Details: dsh-daemon logs -n 100  (raw log: ~/.dsh/daemon/logs/dsh-web.log)

$ dsh-daemon logs -n 50
dsh-daemon logs — dsh web startup diagnostics
  port 3080  |  /health ❌ not serving  |  web pid 51234 (not running)  |  last launch 3s ago
  web log:      ~/.dsh/daemon/logs/dsh-web.log  (272 bytes, updated ...)
  watchdog log: ~/.dsh/daemon/logs/watchdog.log  (975 bytes, updated ...)

--- dsh-web.log (last 50 lines, ~/.dsh/daemon/logs/dsh-web.log) ---
  | Error: cannot find module @acme/plugin-x
  |     plugin activation failed for row "plugin-x"

--- watchdog.log (last 50 lines, ~/.dsh/daemon/logs/watchdog.log) ---
  | [2026-10-16T12:23:42.653Z] [watchdog] web server not healthy on port 3080 at startup, launching... (details: dsh-daemon logs -n 100)
```

- `dsh-daemon logs` 默认打印两个日志各 50 行，末尾给出 `tail -f` 实时跟踪命令；
- 第一次诊断头先回答三个关键问题：`/health` 是否在服务、托管的 web PID 是否存活、本次启动多久（还在启动宽限期内就不算失败）；
- 沙箱/无终端场景可用工具 `dsh_daemon_logs`（参数 `lines`、`source`）拿到同样的内容；
- 日志文件位置固定：`$DSH_HOME/daemon/logs/dsh-web.log`（web 的 stdout/stderr，启动崩溃的原因就在这里）与 `$DSH_HOME/daemon/logs/watchdog.log`（watchdog 的决策过程）。

### 状态文件（`$DSH_HOME/daemon/`，`$DSH_HOME` 默认为 `~/.dsh`）

```
daemon/
├── watchdog.js            # 生成的 watchdog 脚本（独立、零依赖）
├── .daemon-installed      # 安装时间戳标记
├── .daemon-port           # 被监督的端口
├── .daemon-stopped        # 暂停标记：watchdog 不再重启服务
├── .daemon-restart.lock   # 重启进行中标记（TTL 120 秒）
├── .dsh-watchdog.pid      # watchdog PID
├── .dsh-web.pid           # 托管 web 服务 PID
├── .daemon-update.lock    # 更新进行中锁（并发保护）
├── .daemon-update-pending # 已下载待重启生效的更新
├── .daemon-update-check.json  # 最近一次更新检查结果（状态显示用）
├── dsh-watchdog.vbs       # Windows：隐藏的 wscript 启动器
├── dsh-watchdog-task.xml  # Windows：计划任务 XML（UTF-16LE）
└── logs/
    ├── watchdog.log       # watchdog 日志（5 MB × 3 轮转）
    └── dsh-web.log        # watchdog 拉起的 web 服务输出
```

---

## 自动更新

watchdog **启动时及每 6 小时**检查 npm registry，并用 pnpm 更新 profile 目录中的 `@chenkai114/dsh-daemon`：

- **版本策略**：同 major 版本（0.1.3 → 0.1.4、0.2.x → 0.2.y）自动更新；major 变更（0.x → 1.x、1.x → 2.x、…）仅提示，需人工执行 `dsh_daemon_update` 工具。
- **dsh 兼容门禁**：除 daemon 自身版本外，还要求新版本声明的 `dsh.requires.dsh` 与本机已装 dsh 版本相符；不满足、未声明或读不到本机 dsh 版本时**只提示、不自动安装**（`dsh-daemon update --apply` 可强制）。
- **更新模式**（`DSH_DAEMON_UPDATE_MODE`）：
  - `restart`（默认）：下载完成后，watchdog 每 30 秒轮询插件的 `/dsh-daemon/activity` 端点（进行中的回合 + 后台任务），仅在安静窗口后重启 `dsh web`——进行中的对话或任务会推迟重启直到结束。端点不可达（插件未挂载）时，仍会在 `DSH_DAEMON_DEFER_MAX` 之后重启。完全无人值守。
  - `download`：新包安装到 profile 并写入待生效标记；下次自然重启 `dsh web` 时生效。绝不中断任何会话，把"何时生效"的控制权留给用户。
- **失败安全**：registry 不可达、pnpm 失败或更新后版本不一致只会写日志行与检查状态；旧包保持安装（pnpm store 保留旧版本，`dsh plugin --profile web add @chenkai114/dsh-daemon@<旧版>` 可回滚）。

配置在 `dsh_daemon_install`/`reinstall` 时捕获并嵌入生成的 watchdog 脚本：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_DAEMON_AUTO_UPDATE` | `1` | `0` 关闭检查 |
| `DSH_DAEMON_UPDATE_INTERVAL` | `6h` | 检查间隔（`ms`/`s`/`m`/`h`/`d`） |
| `DSH_DAEMON_UPDATE_MODE` | `restart` | `restart` 或 `download` |
| `DSH_DAEMON_QUIET_WINDOW` | `5m` | restart 模式重启前所需的安静时间 |
| `DSH_DAEMON_DEFER_MAX` | `15m` | 活动端点不可达时最多等待多久再重启 |
| `DSH_DAEMON_NPM_REGISTRY` | `https://registry.npmjs.org` | 检查与 pnpm 更新所用的 registry |
| `DSH_DAEMON_PROFILE` | `web` | 存放插件的 profile 目录 |
| `DSH_DAEMON_HEALTH_INTERVAL` | `10s` | watchdog 循环的健康检查间隔（`ms`/`s`/`m`；宽限期外连续 3 次失败触发重启，默认 tick 下约 30 秒） |
| `DSH_DAEMON_STARTUP_GRACE` | `5m` | `dsh web` 启动宽限期（`ms`/`s`/`m`）：这段时间内的健康检查失败不计入重启阈值，也不会杀进程。插件多、机器冷启动慢时保持默认；确定自己的 `dsh web` 十几秒就能起来时可以调小（如 `90s`）以更快发现真正的卡死 |
| `DSH_DAEMON_OPEN_BROWSER` | `1` | `0` 时即使检测到新版 dsh 的启动 token 也不自动弹浏览器（URL 仍写入 `~/.dsh/daemon/.web-auth-url` 与 watchdog 日志，可人工访问） |
| `DSH_DAEMON_CLI_DIR` | node bin 目录 | 生成的 `dsh-daemon` CLI 写入目录（测试/沙箱安装时指向临时目录，避免污染真实 PATH） |
| `DSH_DAEMON_NO_SYSTEM` | 未设置 | `1` 时跳过系统级注册（launchd/schtasks/systemd）——测试/沙箱安装不触碰宿主系统服务，watchdog 仍直接启动 |
| `DSH_DAEMON_TRUSTED_HOST` | 未设置 | 反代场景：安装/重装时把 Host（可逗号分隔）固化进生成的 watchdog，`dsh web` 启动时自动追加 `--trusted-host`；不设置而由反代进来时 dsh 的 `/api` 会 403。固化进脚本是因为插件自启的 watchdog 拿不到 plist/unit 的环境变量 |
| `DSH_DAEMON_ALLOW_EPHEMERAL_HOME` | 未设置 | `1` 时允许把注册装到临时 `DSH_HOME`（`/tmp`、`/var/folders`）上；默认拒绝并改用 `~/.dsh`，避免临时目录被清理后 LaunchAgent/systemd 注册永久失效（`DSH_DAEMON_NO_SYSTEM=1` 的测试不受影响） |
| `DSH_DAEMON_TRUSTED_HOST` | 未设置 | 逗号分隔的 `--trusted-host` 列表（如 `dsh.example.com,10.0.0.5:8080`）。经反向代理（nginx）访问时 Host 头是公网域名，/api 信任围栏会 403——设此项让 dsh web 信任这些 Host |

> 自动更新逻辑位于生成的 `watchdog.js` 中；升级到含新更新逻辑的版本后，运行一次 `dsh_daemon_reinstall` 重新生成。

---

## 验证记录

以下全部针对真实插件代码端到端验证过：

- 安装 → `plutil -lint` 通过，`launchctl list` 显示该 agent，watchdog 日志 `watchdog started (PID …, port 3080)` / `web server already healthy on port 3080`
- 在空端口上，watchdog 启动时拉起真实 `dsh web --port <port>`（新端口健康 OK）
- 自愈：`SIGKILL` 托管服务后 → `health check failed (1/3 → 2/3 → 3/3)` → `failure threshold reached, restarting web server` → 新进程返回 200
- 启动宽限期（`node test/startup-grace.test.js`，真实生成的 watchdog + 假 `dsh`）：8 秒才健康的慢启动在 20 秒宽限内只记录「仍在启动」，不重启也不杀进程；宽限期结束（2 秒）后先 SIGTERM 再拉起新进程，每次重启都有对应的优雅停止（端口先释放）
- 启动失败可诊断（`node test/logs-command.test.js`，真实生成的 watchdog + 秒退的假 `dsh`）：默认 tick 固化为 `INTERVAL_MS = 10000`；`--start` 失败时打印 `Details: dsh-daemon logs -n 100`；`dsh-daemon logs` / `--logs` / `dsh_daemon_logs` 三条入口都能看到 dsh web 的崩溃原因与 watchdog 决策日志
- launchd `KeepAlive`：`SIGKILL` watchdog 后约 11 秒内被 launchd 重启
- 单实例保护：重复运行 `watchdog.js` 立即退出
- `stop` 写入暂停标记并只杀托管服务；`start` 清除；`uninstall` 移除 launchd 注册、plist、状态文件并释放端口；`status` 反映全部状态

### 本地测试

```bash
node test/harness.js dsh_daemon_status          # 静态包模式
DYNAMIC=1 node test/harness.js dsh_daemon_status # 动态沙箱模式
node test/startup-grace.test.js                 # 启动宽限期：慢启动不被杀、超时才重启、优雅停止
node test/logs-command.test.js                  # 10s tick 默认值 + dsh-daemon logs / 失败明细入口
node test/restart-loop.test.js                  # 收养未托管实例 + 慢 /health 不再误杀
node test/update-gate.test.js                   # dsh 兼容区间门禁 + 更新失败分类
```

测试驱动运行真实插件代码（真实 bash/fs），并真实调用工具。

### v0.1.29 — 自动更新加 dsh 兼容门禁，更新失败可诊断

**背景**：更新逻辑一直只比较 **daemon 自己**的版本（`isNewer` + `sameMajor`）。
一个装着旧 dsh 的客户端，会把「要求更新 dsh 才能跑的 daemon」自动装进来，
然后 crash-loop 并连带把 `dsh web` 拖下水——之前 0.2.x 那次是靠「同时兼容
两种 shell 形状」侥幸扛过去的，不是门禁保证的。

**兼容门禁**（默认保守，宁可不动）：

- 每个发布版本在 `package.json` 声明自己支持的 dsh 区间：
  `"dsh": { "requires": { "dsh": ">=0.1.2-alpha.1 <0.3.0" } }`；
- 更新检查直接读 registry `/latest` 返回的 manifest 里的这个字段，与**本机已装
  dsh 版本**比对（区间语法只支持 `>= > <= < =` 用空格 AND 组合；不支持 `^ ~ ||`，
  遇到看不懂的区间一律按「无法判定」处理，不猜）；
- 三种情况都**跳过自动更新**并把原因写进 status：
  `incompatible`（区间不满足，显示要求版本与当前版本）、
  `unknown-dsh`（读不到本机 dsh 版本）、
  `unverified-compat`（新版本没声明区间）；
- 人工覆盖：`dsh-daemon update --apply` / `dsh_daemon_update` 的 `apply:true`
  视为强制，会照装并在日志里写明「兼容性不满足但被强制」。

**错误细分 + 重试**：单次 `fetch` 从 10s 一次改为 **15s × 2 次**（间隔 2s），
失败按 `timeout after 15s` / `DNS lookup failed (ENOTFOUND)` /
`connection failed (ECONNREFUSED)` / `registry HTTP 5xx` 分别记录，
`status` 里额外显示 `Last successful registry check`。这修的是之前「离线、
DNS 抖动、5xx 全都显示 registry unreachable」的问题。

新增 `test/update-gate.test.js`：区间解析器 18 个边界用例（含 prerelease 排序、
非法区间返回「无法判定」）+ 模板接线 + 真实生成一次 watchdog 并 `node --check`。

### v0.1.28 — 健康检查不再误杀，重启风暴收口

一次真实故障（8 核机器 load average 100+、swap 用满）：`/health` 偶尔要
4.6 秒才回，watchdog 的单次预算是 5 秒、失败阈值 3 次 —— 于是健康的 dsh web
在半小时内被杀了三次；第三次之后 pid 文件落在一个已经死掉的进程上，真正在
服务的是另一个未托管实例，watchdog 既认不出它、也管不到它，只能每隔几分钟
再拉起一个注定 `EADDRINUSE` 的新实例，把本已紧张的 CPU 再踩一脚。

- **单次 `/health` 预算 5s → 20s，失败阈值 3 → 5**：约 50 秒真实超时才重启，
  瞬时抖动与 GC/换页停顿不再被判死（`DSH_DAEMON_HEALTH_INTERVAL` 不受影响）。
- **tick 串行**：`setInterval` 的异步体可以重叠，探测变慢后两轮同时看到
  「进程没了」就各自拉起一次 —— 这正是同一秒出现两个 dsh web 的来源。现在
  用 `tickBusy` 互斥，探测再慢也不会叠加。
- **`launch()` 单飞**：tick、CLI、更新器同时要求启动时共享同一个 in-flight
  promise，不会再出现「赢家服务、输家被记进 pid 文件」。
- **收养未托管实例**：pid 文件指向死进程、而端口上已有健康的 dsh web 时，
  把 pid 文件纠正为真实监听者并记日志（`adopted the running dsh web`），
  不再拉起第二个；端口被非 dsh 进程占用时明确记录并拒绝盲拉。
- **停进程前校验身份**：只对「确实是 `dsh web`」或「真的占着本端口的」PID
  发信号，PID 复用不再误杀无关进程（issue #3 问题 1）。
- **`status` 诚实**：pid 文件与实际监听者不一致时直接点出来，并给出
  `dsh-daemon restart` 的修法。
- **拒绝非 JS 入口**：`dsh.ps1`/`dsh.cmd`/pnpm sh 之类的 shim 若没解析成
  `lib/bin.js`，直接报错而不是让 `node` 去解析 PowerShell（issue #3 N1 的
  兜底），不再产出「日志显示启动成功、实际永远起不来」的循环。
- 合并 PR #2（@QiE2035）：pnpm sh / `.cmd` shim 解析到真实 `lib/bin.js`，
  并在 pnpm store GC / 重装后通过 shim 自愈 `DSH_BIN`。

新增 `test/restart-loop.test.js`：用真实生成的 watchdog + 假 `dsh web` 复刻
两个现场 —— ①pid 文件指向死进程时收养真实监听者且不重启；②单次 `/health`
慢到 6 秒仍不触发重启。

### v0.1.27 — 健康检查 10s，启动失败可查明细（`dsh-daemon logs`）

**更快的自愈**：watchdog 的健康检查默认间隔从 30 秒改为 **10 秒**
（`DSH_DAEMON_HEALTH_INTERVAL`，仍可用 `ms`/`s`/`m` 覆盖）。失败阈值仍是
连续 3 次，所以「进程活着但超过宽限期仍未健康」的重启判定从约 90 秒缩短到
约 30 秒；睡眠唤醒判定（90 秒 tick gap）与最小重启间隔（15 秒）保持大于
tick，不会误判也不会热重启。

**启动失败有明细入口**：`dsh web` 没起来时，此前只能从
`~/.dsh/daemon/logs/` 里自己找文件。现在：

- 新增 `dsh-daemon logs [-n N] [--web | --watchdog]`（watchdog 的 `--logs`
  模式，bash/cmd 包装脚本同步生成）：默认打印 web 与 watchdog 两个日志各
  50 行，先给一段诊断头（`/health` 状态、托管 PID 是否存活、本次启动多久、
  是否处于暂停），末尾给出 `tail -f` 实时跟踪命令；
- 所有失败路径都像 systemctl 一样打印入口：`dsh-daemon start` / `restart`
  失败时输出 `Details: dsh-daemon logs -n 100  (raw log: …/dsh-web.log)`，
  `status` 不健康时同样打印，生成的 watchdog 写日志时也带上
  `(details: dsh-daemon logs -n 100)`，因此只看 `watchdog.log` 也能找到出口；
- 新增工具 `dsh_daemon_logs`（参数 `lines`、`source`），沙箱/无终端场景拿到
  同样的内容；
- 回归测试 `test/logs-command.test.js` 用真实生成的 watchdog + 秒退的假
  `dsh` 覆盖：10s 默认 tick、失败提示、`--logs` 两种筛选、未知参数、CLI
  转发与工具输出。

> 生成物变更需要重新生成：升级后 watchdog 会按 `GEN_VERSION` 自动重写；
> 若版本未变，运行一次 `dsh_daemon_reinstall`。

### v0.1.19 — dsh web token 授权适配（`?token=` 启动令牌种子）

`dsh` ≥ 0.1.2-alpha.1（harness commit 3e24087bfa）起 `dsh web` 启动时生成进程
内随机 token 并打印 `dsh web: http://127.0.0.1:<port>/?token=...`：浏览器访问该
URL 一次后种下 30 天有效的 host-only Cookie（签名密钥持久化，跨重启有效），
直接访问 3080 无 Cookie → 401。此前 watchdog 用 `--no-open` 拉起，用户浏览器
从未种过 Cookie，daemon 托管的 web 直接 401。

**适配**：watchdog 拉起 web 后从 `dsh-web.log`（web stdout 的重定向目标）提取
**本次运行**的 token URL，然后：

- 检测到 `?token=`（新版 dsh）→ 打开默认浏览器访问一次种 Cookie（与手动
  `dsh web` 行为一致）；无 GUI 环境打开失败时 URL 已落盘可人工访问；
- 未检测到（旧版 dsh）→ 保持现状（`--no-open`、绝不弹浏览器）；
- token URL 始终写入 `~/.dsh/daemon/.web-auth-url`（0600，每次 launch 覆盖），
  `dsh-daemon status` 会显示当前有效 URL；
- `DSH_DAEMON_OPEN_BROWSER=0` 关闭自动弹窗（仅落盘 + 日志）；
- 提取锚定 launch 前的文件偏移：POSIX 追加日志不会误取旧 run 的失效 token
  （永远取本次运行新增段里**最后一条** `dsh web:` 行；win32 `Start-Process`
  覆盖语义下自动回退读整文件，`dsh-web.log.1` 是上一进程的过期 URL、从不读取）；
- 探测跨版本稳定：`dsh web: http://...` 这行自最老版本就打印，新旧唯一差异是
  URL 是否带 `?token=`，故以 `?token=` 有无为判据，对未来版本成立；
- 反向保险：新版 dsh 的 token 行迟迟不出现时**继续等待重试**（快轮询 15s@250ms
  后接慢轮询 75s@5s），绝不按「无 token」当旧版跳过；超时仅告警、下次 launch 重试；
- 弹窗节流：token 每次启动必变，但 30 天 Cookie 跨重启有效（签名密钥持久），
  因此**本次 URL 与上次记录相同时不再弹**（`.web-auth-url` 仍刷新供人工访问）；
  `SSH_CONNECTION`/`SSH_TTY` 非空时抑制弹窗（远程会话不弹别人桌面），只落盘+日志；
- 版本门控照搬 `--no-open` 模式（`DSH_TOKEN_AUTH_MIN = 0.1.2-alpha.1`，
  模块级函数经 `toString()` 内联进 watchdog，每次 launch 运行时重判），仅在
  **确定**旧版时跳过轮询；URL 行探测是主判据，与版本无关地可靠。

### v0.1.18 — Windows 黑框修复：隐藏控制台而非无控制台；`start` 等待健康

Windows 上 watchdog 用 `CP.spawn(..., { detached: true })` 拉起 `dsh web`、
pnpm、netstat 等子进程时，Node 默认给 detached 子进程分配**独立控制台窗口**
（watchdog 本身由 VBS/计划任务隐藏启动、无控制台），于是每次拉起/重启都会
闪出黑框。v0.1.17 的 `--no-open` 修复让重启循环消失后，黑框成了最显眼的问题。

**机制选择（deepseek-harness discussion #1564 / #810）**：不能给 `dsh web`
用 `windowsHide`（CREATE_NO_WINDOW）——无控制台的宿主会让它每次 spawn 的
子进程都新建一个可见控制台，而且 CREATE_NO_WINDOW 会让 Windows ACL 沙箱的
受限令牌子进程直接 0xC0000142（DLL 初始化失败）。正确做法是**给 `dsh web`
一个隐藏的控制台**（STARTF_USESHOWWINDOW + SW_HIDE，保持 dwCreationFlags=0，
Windows 上经 `Start-Process -WindowStyle Hidden` 实现，与 `dsh-daemon start`
直启路径一致）：dsh web 自身无可见窗口，它的控制台子进程又继承这个隐藏控制台，
层层都不再闪框。

- win32 上 watchdog 改经 `powershell.exe -Command "Start-Process -FilePath
  <node> -ArgumentList ... -WindowStyle Hidden -RedirectStandardOutput
  <web.log> -PassThru"` 拉起 dsh web（wrapper 本身 windowsHide，短命且普通
  令牌，安全），PID 由 wrapper 写入 pidfile、watchdog 轮询确认；
  ⚠️ wrapper **不能带 `detached: true`**——Node 在 Windows 上把它映射成
  `DETACHED_PROCESS`，会让 Start-Process 整条命令卡死（PID 不写、子进程不
  起，实测复现）；Start-Process 的子进程本就独立存活，wrapper 无需脱离；
  Start-Process 的重定向是**覆盖**语义，因此每次拉起前先把旧
  `dsh-web.log` 轮转为 `dsh-web.log.1`（保留上一代崩溃现场），新日志有界
  （当前 + 上一代，不无限增长）；
- watchdog 其余短命子进程（自spawn、pnpm、空闲重启 waiter、netstat/lsof）
  保留 `windowsHide: true`——普通令牌下安全，且与讨论中 subprocess-local
  的处理一致；
- `dsh-daemon start` 现在像 `restart` 一样在 launch 后**轮询等待健康**（最多
  约 13s）再返回——此前 dsh web 要十几秒才起来，`start` 立即返回导致紧随的
  `status` 显示 unhealthy，用户常误以为失败又重复 start（重复 start 会按 PID
  文件杀掉上一个还在启动的实例）；
- 模板断言：spawn 点必须带 `windowsHide`，且 win32 拉起必须走
  `Start-Process -WindowStyle Hidden`（防回归）。

> 注：dsh 内部组件（`dsh-sandbox-windows-acl` 两处 spawn
> `dwFlags:256→257` + `wShowWindow:0`；`dsh-subprocess-local` 加
> `windowsHide:true`）是 #1564 讨论里的另一层补丁，针对 dsh 本体、不属于本
> 仓库；升级 dsh 后需重新应用（社区补丁脚本
> `Culeot/dsh-no-console-flash` 幂等可重跑）。

### v0.1.17 — 按 dsh 版本决定是否传 `--no-open`

v0.1.16 起 watchdog 用 `dsh web --port <port> --no-open` 拉起服务，但
`--no-open` 是 `@deepseek-ai/dsh` **0.1.0-rc.8**（dsh-web-app 0.1.0-rc.8，
同期加入默认弹浏览器行为）才支持的参数：旧版 CLI 直接报
`unknown option '--no-open'` 退出，导致 watchdog 陷入「拉起即死 → 健康
检查失败 → 再拉起」的死循环，web 永远起不来。

- watchdog 每次 launch 时读取 dsh 包 `package.json` 的版本做 semver 比较，
  **≥ 0.1.0-rc.8 才追加 `--no-open`**；版本未知/读不到时保守跳过——服务照常
  启动，且 rc.8 之前的 dsh 本来就不弹浏览器，零损失；
- `dsh-daemon start` 的直启命令（Windows `Start-Process` / Unix `nohup`）
  同步按版本决定是否带 `--no-open`；
- 门控函数是模块级单一实现，watchdog 通过 `Function.prototype.toString()`
  内联同一份代码——升级/降级 dsh 无需重装 daemon，每次拉起都会重新判定；
- 新增 `test/version-gate.test.js` 单元测试（`npm test` 一并运行）。

### v0.1.16 — 健康检查、浏览器弹窗与环境变量转发

- **`/health` 路由**：watchdog 每 30s 检查 `http://127.0.0.1:<port>/health`，
  但 deepseek-harness 的 web server 没有该路由（未知路径 404），导致
  web 明明在跑却永远报 unhealthy。插件现在自己注册 `/health`，返回
  `200 {"ok":true}`——插件在线即 web 在线，检测可靠。
- **`--no-open`**：daemon 托管的 web 重启（自动更新、自愈）不再自动
  弹浏览器 tab；手动 `dsh web` 仍保持默认打开。
- **环境变量转发**：`dsh-daemon install/uninstall/reinstall` 通过
  `/dsh-daemon/command` 路由在 web 进程里执行，之前 shell 里的
  `DSH_DAEMON_*` 变量到不了插件。现在 CLI wrapper 收集当前 shell 的
  全部 `DSH_DAEMON_*` 并随请求转发，因此
  `DSH_DAEMON_UPDATE_INTERVAL=1m dsh-daemon reinstall` 能正确配置
  watchdog。

### v0.1.15 — 测试/沙箱安装不再污染宿主系统

测试 harness 用临时 HOME 跑 install 时会污染真实环境，两个开关封堵：

- `DSH_DAEMON_CLI_DIR`：覆盖生成的 `dsh-daemon` CLI 的写入目录（默认
  node bin），测试指向临时目录，不再覆盖真实 PATH 里的 wrapper；
- `DSH_DAEMON_NO_SYSTEM`：`1` 时跳过系统级注册（launchd/schtasks/
  systemd），防止测试 install 按 label 抢注系统服务、让真实 daemon
  失效。harness 默认同时设置两者。

### v0.1.14 — restart 成为默认自动更新模式

`DSH_DAEMON_UPDATE_MODE` 的默认值从 `download` 改为 `restart`：未显式
设置时，更新下载后 watchdog 会在 web 空闲时自动重启生效（完全无人
值守，绝不打断进行中的会话）。需要手动控制生效时机时显式设为
`download`。

### v0.1.13 — 自动更新后自动重新生成 watchdog

此前自动更新只刷新 npm 包，已生成的 `watchdog.js`（安装时的一次性产物）
不会自动用上新版的生成逻辑——需要手动 `dsh_daemon_reinstall`。v0.1.13
起：

- 生成 watchdog 时把**插件版本**嵌入脚本（`GEN_VERSION` 常量）；
- 插件每次启动时比对 `GEN_VERSION` 与当前安装版本，不一致（自动更新
  后、或手动升级包后）即自动**重新生成 watchdog.js 与 CLI wrapper 并
  重启 watchdog 进程**；
- 因此自动更新（download 模式用户重启 web / restart 模式自动重启 web）
  或手动升级后重启 `dsh web`，watchdog 都会自动跟上新版，无需手动
  `dsh_daemon_reinstall`；
- 测试/开发加载可通过 `DSH_DAEMON_AUTOREGEN=0` 跳过该同步。

### v0.1.12 — Windows 弹窗回归修复

v0.1.11 给 watchdog 的 `launch()` 等 spawn 加了 `windowsHide: true`（对应
Windows `CREATE_NO_WINDOW`）。副作用是 `dsh web` 进程**失去控制台句柄**，
此后 web 内部任何子进程（git、工具执行等）在 Windows 上都会新建**可见**
控制台窗口 → 运行期频繁弹窗（[issue #1](https://github.com/chenkai2/dsh-daemon/issues/1)）。

v0.1.12 移除全部 4 处 `windowsHide`，恢复 v0.1.10 的模型：watchdog 由
VBS `shell.Run ..., 0`（SW_HIDE）启动时自带**隐藏控制台**，web 继承它，
web 的子进程再继承 → 整条链不弹窗（此行为已在 v0.1.10 实测）。

> 注意：安装/执行插件命令时若仍有弹窗（DSH 沙箱/子进程路径，非本插件
> watchdog），那是 deepseek-harness 自身的 Windows 控制台处理问题，与本
> 插件无关——见 [discussion #1564](https://github.com/deepseek-ai/deepseek-harness/discussions/1564)
> 及 Culeot/dsh-no-console-flash 补丁。

---

## 许可证

MIT
