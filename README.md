# dsh-orb

**把 DeepSeek Orb 的桌面 Agent 带回 DeepSeek Harness 0.2，以插件形式。**

DeepSeek Harness 0.2 移除了 Orb（DSH 桌面版 0.1.x）的整套桌面 Agent：悬浮球、Computer Use 模式、后台 `code_agent`、
悬浮对话、Orb 设置页。dsh-orb 把这些功能重新做成一个 **DSH 配置文件插件（profile plugin）**，不修改 Harness 内核。

> 本项目的核心代码来自 **DeepSeek Orb 0.1.7-rc.1**（`@deepseek-ai/dsh-desktop`，作者 **DeepSeek**，MIT 许可）。
> Computer Use 工具、`code_agent`、Computer Use 预设、Desktop Host 插件、悬浮球前端、紧凑对话和设置页都是 DeepSeek 的原作，
> dsh-orb 只做了让它们在 0.2 上以插件形式运行所需的适配。原作的许可证见 [`LICENSE.deepseek-computer-use`](LICENSE.deepseek-computer-use)。

## 为什么做成插件

Orb 的这些功能原本写在桌面应用内核（`app.asar`）里，本地改动每次官方更新都会被覆盖。做成插件以后：

- **跟着 Harness 更新也不会丢**：插件装在你的配置目录（`~/.dsh/profiles/desktop`）里，不碰安装目录；
- **用官方的插件机制加载**：`cordis.patch.yml` 注入预设和宿主插件，`dsh.client` 注入前端页面；
- **方便后续维护**：Harness 接口变化时只需要更新这个插件，Orb 的原始文件基本保持原样，改动点集中、可追溯（见 [`docs/DESIGN.md`](docs/DESIGN.md)）。

## 功能

| 功能 | 说明 |
| --- | --- |
| **Computer Use 模式** | Orb 的 `computer-use` 预设，提示词、工具描述和参数逐字不变，所以"自己操作屏幕还是交给后台 code_agent"的判断和 Orb 一致 |
| **后台 code_agent** | `code_agent` / `code_agent_status` / `code_agent_stop`，完成后通知、重新判断、汇报；子会话完成后自动归档 |
| **悬浮球** | Orb 原版悬浮球前端：拖动、贴边隐藏、点开面板、历史对话、新对话、权限切换、提问卡片 |
| **紧凑对话** | 面板里只显示对话内容（0.2 的会话组件，隐藏侧栏/标题栏/输入框） |
| **面板可调大小** | 拖面板远离悬浮球的边或角调整，大小会被记住（Orb 原版固定 320×420） |
| **右键菜单** | 打开主窗口、悬浮球 Agent 模型、后台 Agent 模型、千分比坐标、退出 |
| **Orb 设置页** | 设置 → 悬浮球：头像、两个 Agent 的模型、千分比坐标 |

Orb 的偏好文件（`orb-agent-models.json`、`orb-permission.json`、`floating-session.json`、头像等）直接沿用，从 Orb 换过来不用重新设置。

## 与 Orb 的差异

- 悬浮面板里的对话详略跟随主窗口的"工作详情"设置（0.2 把它存在宿主端、与主窗口共享，插件无法单独强制紧凑）；
- 右键菜单的"退出"只关闭悬浮球，不退出 Harness；
- 没用过的空对话不显示在悬浮球的历史列表里；
- 不包含划词工具条。

## 要求

- Windows x64
- DeepSeek Harness **0.2.0-rc.2**
- WebView2 运行时（Windows 11 自带）

## 安装

1. 从 Releases 下载 `dsh-orb-<版本>.tgz`（已包含编译好的 `orb-shell.exe`），或者自己构建（见下）。
2. 退出 DeepSeek Harness，用桌面版自带的 CLI 安装到 `desktop` 配置：

   ```console
   "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add C:\path\to\dsh-orb-0.1.0.tgz
   ```

3. 确认 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `"dsh-orb"`（同一个包重复安装时 CLI 不会再添加，需要手动加上）。
4. 启动 Harness：新建会话时可以选「Computer Use 模式」，悬浮球会出现在屏幕右侧。

### 从 Orb 迁移：修复旧的 Computer Use 会话

Orb 在每个悬浮球会话里写了 `computer-use/coordinate-mode` 事件。0.2 不认识这个事件类型，会拒绝加载这些会话，
并把它们从工作区列表里移除。退出 Harness 后运行：

```console
node scripts/repair-session-logs.mjs --dry-run   # 先看看会改哪些
node scripts/repair-session-logs.mjs
```

脚本只给这类事件加上 0.2 支持的 `"ignorable": true` 标记，逐帧改写并校验，每个改过的日志旁边保留 `.orb-backup` 原文件。
如果会话已经从列表里消失，修复后需要把会话 ID 加回 `~/.dsh/storages/workspace.json` 对应工作区的 `sessionIds`。

dsh-orb 自己不会再往会话日志里写 0.2 不认识的事件（每个会话的坐标模式记在 `orb-session-coordinate-modes.json`）。

## 构建

```console
cd orb-shell
cargo build --release
copy target\release\orb-shell.exe orb-shell.exe
cd ..
node scripts/build-client.mjs
npm pack
```

需要 Rust（MSVC 工具链）和 Visual Studio C++ 生成工具。

## 结构

```
cordis.patch.yml        Computer Use 预设 + 宿主插件行
lib/computer-use/       Orb 的 Computer Use 工具与 code_agent
lib/host/               Orb 的 Desktop Host 插件、偏好读取、悬浮球宿主路由（shell.js）
lib/client.js           前端：紧凑对话 + Orb 设置页（由 src/client/ 生成）
renderer/               Orb 的悬浮球前端 + orb-bridge.js（代替 Electron preload）
orb-shell/              Rust + WebView2 伴随程序：悬浮窗、几何、右键菜单、截图排除
scripts/                前端打包、会话日志修复
```

## 排查问题

- 伴随程序日志：`%LOCALAPPDATA%\dsh-orb\orb-shell.log`
- 设置环境变量 `DSH_ORB_DEBUG_NOHIDE=1` 再启动 Harness：悬浮球不自动贴边隐藏，便于调试。

## 致谢与许可

- **DeepSeek Orb / DeepSeek Harness** — DeepSeek，MIT。本项目的 Computer Use、code_agent、悬浮球与设置页源自 Orb 0.1.7-rc.1。
- **Koffi**（Niels Martignène）— MIT，随包附带的预编译版本，见 `lib/vendor/`。
- **tao / wry**（Tauri）— Apache-2.0 / MIT。

dsh-orb 以 MIT 许可发布，见 [`LICENSE`](LICENSE)。本项目与 DeepSeek 无官方关联。
