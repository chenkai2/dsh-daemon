# dsh-daemon

[English](README.md) | [中文](README.zh.md)

将 **DeepSeek Harness** 网络服务（`dsh web`）注册为**自启动、自愈**的后台服务。

安装后，`dsh web` 将：

- 登录时自动启动（LaunchAgent `RunAtLoad` / systemd `WantedBy=default.target` / cron `@reboot`）
- 睡眠唤醒后自动重启
- 自愈：watchdog 每 **3 秒**（可配置）健康检查一次 `http://127.0.0.1:<port>/health`，连续 3 次失败后重启服务
- 不依赖当前会话：watchdog 是独立生成的脚本，而非内存中的插件

安装/卸载**永远不会触碰**当前正在运行的会话。

> 账号对应关系：npm 包发布在 **`@chenkai114`** scope 下（npm 账号 `chenkai114`）；源码仓库在 GitHub 账号 **`chenkai2`** 下——`github.com/chenkai2/dsh-daemon`。文档中 `@chenkai114` 一律指 npm，`chenkai2` 一律指 GitHub。

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
- 之后每 3 秒（可通过 `DSH_DAEMON_HEALTH_INTERVAL` 配置）：
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
  - `download`（默认）：新包安装到 profile 并写入待生效标记；下次自然重启 `dsh web` 时生效。绝不中断任何会话。
  - `restart`：下载完成后，watchdog 每 30 秒轮询插件的 `/dsh-daemon/activity` 端点（进行中的回合 + 后台任务），仅在安静窗口后重启 `dsh web`——进行中的对话或任务会推迟重启直到结束。端点不可达（插件未挂载）时，仍会在 `DSH_DAEMON_DEFER_MAX` 之后重启。
- **失败安全**：registry 不可达、pnpm 失败或更新后版本不一致只会写日志行与检查状态；旧包保持安装（pnpm store 保留旧版本，`dsh plugin --profile web add @chenkai114/dsh-daemon@<旧版>` 可回滚）。

配置在 `dsh_daemon_install`/`reinstall` 时捕获并嵌入生成的 watchdog 脚本：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_DAEMON_AUTO_UPDATE` | `1` | `0` 关闭检查 |
| `DSH_DAEMON_UPDATE_INTERVAL` | `6h` | 检查间隔（`ms`/`s`/`m`/`h`/`d`） |
| `DSH_DAEMON_UPDATE_MODE` | `download` | `download` 或 `restart` |
| `DSH_DAEMON_QUIET_WINDOW` | `5m` | restart 模式重启前所需的安静时间 |
| `DSH_DAEMON_DEFER_MAX` | `15m` | 活动端点不可达时最多等待多久再重启 |
| `DSH_DAEMON_NPM_REGISTRY` | `https://registry.npmjs.org` | 检查与 pnpm 更新所用的 registry |
| `DSH_DAEMON_PROFILE` | `web` | 存放插件的 profile 目录 |
| `DSH_DAEMON_HEALTH_INTERVAL` | `3s` | watchdog 循环的健康检查间隔（`ms`/`s`/`m`；连续 3 次失败触发重启） |

> 自动更新逻辑位于生成的 `watchdog.js` 中；升级到含新更新逻辑的版本后，运行一次 `dsh_daemon_reinstall` 重新生成。

---

## 使用方式

### 方式 A —— 用 `dsh plugin` 安装并挂载为组合行

1. 用官方插件管理器将包安装到 **web profile**（在 profile 目录内运行 pnpm，使 loader 能解析到它；仅全局安装不够——见下）：

   ```bash
   dsh plugin --profile web add @chenkai114/dsh-daemon
   ```

   （需要 PATH 上有 `pnpm`——用 `corepack enable` 一次性启用。）

   > 为什么不能只 `npm install -g`？loader 以 Node ESM 解析导入 `name:` 行，解析锚点是 profile 目录（`~/.dsh/profiles/web/`）；全局 `node_modules` 不在该解析链上（`NODE_PATH` 对 ESM 无效）。profile 自己的 `node_modules`——由 pnpm 管理——才是包可达的原因。

2. 在 web profile 添加 loader 补丁条目，使插件在下次启动时挂载：

   ```yaml
   # ~/.dsh/profiles/web/cordis.patch.yml
   - insert:
       - id: dsh-daemon
         name: '@chenkai114/dsh-daemon'
   ```

3. 重启 `dsh web`。七个 `dsh_daemon_*` 工具即可供每个 agent 使用——直接让 agent 运行 `dsh_daemon_install`。

以后升级：`dsh plugin --profile web update @chenkai114/dsh-daemon`（并重启）。

> 权限说明：daemon 管理用户级系统服务（LaunchAgent plist、`$DSH_HOME` 下的状态文件），因此插件对其文件与命令操作请求 `danger-full-access`。若部署拒绝提权，工具会以沙箱拒绝失败。

### 方式 B —— 动态 Cordis 插件（无需安装）

将 `lib/index.js` 的内容粘贴到 `cordis_define` 的 `code.host` 字段并运行。这正是插件在真实会话中开发与验证的方式：沙箱提供 `harness` 全局，文件以 `return plugin;` 结尾。

### 端口

默认端口为当前监听的 `webServer` 端口（通常 `3080`），其次 `DSH_WEB_PORT`，再其次工具显式 `port` 参数。更换端口后运行 `dsh_daemon_reinstall`。

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

---

## 许可证

MIT
