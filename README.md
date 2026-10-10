# dsh-daemon

[中文](README.md) | [English](README.en.md)

将 **DeepSeek Harness** 网络服务（`dsh web`）注册为**自启动、自愈**的后台服务。

安装后，`dsh web` 将：

- 登录时自动启动（LaunchAgent `RunAtLoad` / systemd `WantedBy=default.target` / cron `@reboot`）
- 睡眠唤醒后自动重启
- 自愈：watchdog 每 **30 秒**（可配置）健康检查一次 `http://127.0.0.1:<port>/health`，连续 3 次失败后重启服务
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
- 之后每 30 秒（可通过 `DSH_DAEMON_HEALTH_INTERVAL` 配置）：
  - 存在 `.daemon-stopped`（用户暂停监控）或 `.daemon-restart.lock` 较新（< 120 秒，重启进行中）时跳过；
  - tick 间隔超过 90 秒（睡眠唤醒）时重启服务；
  - 连续 3 次健康检查失败后重启服务；
  - `.daemon-installed` 标记消失（已卸载）时退出；
- 日志写入 `logs/watchdog.log`（5 MB × 3 轮转）。

### 3. daemon 感知的 start / stop

- `dsh_daemon_stop` 写入 `.daemon-stopped`（watchdog 不再重启服务），并停止正在运行的托管服务。
- `dsh_daemon_start` 清除该标记、确保 watchdog 运行，并在服务不健康时拉起它。

---

## 工具

插件仅包含 Host 侧，注册 7 个可供模型调用的工具：

| 工具 | 功能 |
| --- | --- |
| `dsh_daemon_install` | 生成 `watchdog.js` 与状态文件，写入 LaunchAgent plist（或 systemd 单元 / cron 条目、Windows 的 VBS + 计划任务），立即启动 watchdog。可选 `port` 参数。 |
| `dsh_daemon_uninstall` | 停止 watchdog，卸载并删除平台注册，清除全部状态文件。 |
| `dsh_daemon_reinstall` | 先卸载再安装（升级 dsh 或更换端口后使用；同时按当前自动更新配置重新生成 watchdog）。 |
| `dsh_daemon_status` | 安装时间、端口、本地/最新版本、更新状态、watchdog PID/存活、手动停止标记、服务健康、最近日志。 |
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
| `dsh-daemon update` | 检查 registry（加 `--apply` 下载并应用）。 |
| `dsh-daemon install` / `uninstall` / `reinstall` | 注册类操作，由插件通过其 `/dsh-daemon/command` 路由执行——需要 `dsh web` 处于运行状态（上面的监督类命令通过 watchdog 脚本独立工作）。 |
| `dsh-daemon help` | 用法说明。 |

`restart`/`stop` 会中断所有打开的会话，与手动 `pkill` 效果相同——若直接拉起失败，watchdog 会在下一个健康周期重新拉起 web 服务。

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
| `DSH_DAEMON_HEALTH_INTERVAL` | `30s` | watchdog 循环的健康检查间隔（`ms`/`s`/`m`；连续 3 次失败触发重启） |
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
- launchd `KeepAlive`：`SIGKILL` watchdog 后约 11 秒内被 launchd 重启
- 单实例保护：重复运行 `watchdog.js` 立即退出
- `stop` 写入暂停标记并只杀托管服务；`start` 清除；`uninstall` 移除 launchd 注册、plist、状态文件并释放端口；`status` 反映全部状态

### 本地测试

```bash
node test/harness.js dsh_daemon_status          # 静态包模式
DYNAMIC=1 node test/harness.js dsh_daemon_status # 动态沙箱模式
```

测试驱动运行真实插件代码（真实 bash/fs），并真实调用工具。

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
