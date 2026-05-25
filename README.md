<p align="center">
  <img src="src/assets/images/icon.png" alt="ShellDesk" width="128" height="128">
</p>

<h1 align="center">ShellDesk</h1>

<p align="center">
  <strong>图形化 SSH 客户端、远程桌面工作台与服务器管理工具</strong>
</p>

<p align="center">
  ShellDesk 基于 Electron、React 19、TypeScript 和 xterm.js 构建。<br/>
  它把 SSH 主机库、密钥管理、远程终端、SFTP 文件管理、远程编辑器、浏览器、数据库与系统工具放进一个桌面式工作区。
</p>

<p align="center">
  <img alt="当前版本" src="https://img.shields.io/badge/当前版本-0.1.0-blue?style=for-the-badge">
  &nbsp;
  <img alt="开发阶段" src="https://img.shields.io/badge/开发阶段-Alpha-orange?style=for-the-badge">
  &nbsp;
  <img alt="平台" src="https://img.shields.io/badge/平台-Windows-lightgrey?style=for-the-badge&logo=electron">
  &nbsp;
  <img alt="包管理器" src="https://img.shields.io/badge/包管理器-pnpm-f69220?style=for-the-badge&logo=pnpm">
</p>

---

# 目录 <!-- omit in toc -->

- [ShellDesk 是什么](#shelldesk-是什么)
- [为什么是 ShellDesk](#为什么是-shelldesk)
- [功能特性](#功能特性)
- [界面模块](#界面模块)
- [数据与安全](#数据与安全)
- [快速开始](#快速开始)
- [构建与打包](#构建与打包)
- [项目结构](#项目结构)
- [技术栈](#技术栈)
- [开发约定](#开发约定)
- [后续方向](#后续方向)
- [参与贡献](#参与贡献)
- [开源协议](#开源协议)

---

<a name="shelldesk-是什么"></a>
# ShellDesk 是什么

**ShellDesk** 是一个面向开发者、运维工程师和服务器维护场景的图形化 SSH 客户端原型。它不只是一个终端窗口，而是围绕远程服务器日常操作设计的桌面工作台。

- **ShellDesk 是** 一个 SSH 主机库，用于维护主机、分组、标签、备注和认证信息
- **ShellDesk 是** 一个远程桌面工作区，可以在一次 SSH 连接内打开多个工具窗口
- **ShellDesk 是** 一个 SFTP 文件管理器，支持上传、下载、新建、删除、重命名、压缩与解压
- **ShellDesk 是** 一个远程文件编辑器，可以直接打开和保存远程文本文件
- **ShellDesk 是** 一个数据库和系统管理入口，支持 MySQL、Redis、进程、网络、镜像源、更新、Hosts、路由和磁盘信息
- **ShellDesk 不是** Shell 替代品，它通过 SSH 连接到远程系统，并把常用操作封装成图形化工作流

---

<a name="为什么是-shelldesk"></a>
# 为什么是 ShellDesk

如果你经常在终端、文件传输工具、数据库客户端和浏览器之间来回切换，ShellDesk 更像是一个面向远程服务器的集成工作台。

- **连接之后再展开工作流**：一次 SSH 连接进入远程桌面，终端、文件、浏览器和监控可以并行打开
- **主机库适合长期维护**：主机支持分组、标签、搜索、网格与列表视图，适合管理多台服务器
- **文件操作贴近日常习惯**：SFTP 文件管理器采用桌面文件管理器风格，右键菜单覆盖常见操作
- **远程编辑少切工具**：记事本支持多标签、查找、跳转、语法高亮和远程保存
- **服务管理更集中**：MySQL、Redis、进程管理和系统设置都在连接窗口内完成

---

<a name="功能特性"></a>
# 功能特性

### 主机库

- **主机管理**：新建、编辑、删除 SSH 主机
- **认证方式**：支持密码登录和私钥登录
- **组织方式**：支持分组、标签、备注、搜索筛选
- **视图切换**：支持网格视图和列表视图
- **快速连接**：搜索框可解析 `ssh user@hostname -p 2222` 这类连接输入
- **凭据补录**：密码或密钥口令缺失时，可在连接前弹窗补录

### 密钥管理

- **导入密钥对**：选择本地私钥和公钥文件，保存为本地密钥记录
- **生成密钥对**：支持在应用内创建 RSA 密钥
- **公钥复制**：可快速复制已有密钥的公钥内容
- **密钥检索**：按名称、算法或指纹搜索
- **主机关联**：主机可引用已保存的密钥记录

### 远程桌面

- **多窗口工作区**：连接后进入桌面式界面，窗口支持拖拽、缩放、最小化和最大化
- **Dock 栏**：文件管理、终端、浏览器固定在 Dock，其他应用打开后动态出现
- **桌面应用**：文件管理、终端、记事本、浏览器、系统监视器、MySQL、Redis、进程管理、系统设置
- **独立连接窗口**：每个连接可在独立窗口中运行，并显示当前 SSH 地址与 SOCKS 代理端口

### 远程终端

- **交互式 SSH Shell**：通过 xterm.js 渲染终端
- **多终端会话**：一次连接内可打开多个终端窗口
- **终端偏好**：支持字号、字体、字重、连字、行高、光标、滚动和主题配置
- **主题预设**：内置多套终端配色，包括深色、浅色、Tokyo Night、Dracula、Monokai 等

### SFTP 文件管理

- **目录浏览**：列出远程目录、文件、符号链接和修改时间
- **文件操作**：新建文件、新建文件夹、删除、重命名、复制路径
- **传输操作**：上传、下载、进度提示和取消传输
- **归档操作**：支持压缩和解压常见归档格式
- **联动记事本**：文本文件可直接从文件管理器打开到远程记事本

### 远程记事本

- **多标签编辑**：同时打开多个远程文件
- **远程读写**：通过 SFTP 读取和保存文本文件
- **编辑辅助**：支持查找、跳转行、语法高亮和未保存提示
- **文件保护**：通过二进制扩展名黑名单避免误打开图片、音视频、压缩包、可执行文件和数据库等文件
- **沙箱兼容**：使用自定义模态对话框替代 Electron sandbox 下不可用的 `prompt`、`confirm` 和 `alert`

### 浏览器与书签

- **内置 webview**：在连接上下文中打开网页或本地服务地址
- **导航能力**：支持后退、前进、刷新、主页和地址栏输入
- **书签管理**：支持添加、编辑、删除书签
- **连接隔离**：书签按 `用户名@主机:端口` 作用域保存

### 数据库与系统工具

- **MySQL 管理**：通过 SSH 隧道连接 MySQL，支持库表浏览、字段查看、SQL 查询和单元格更新
- **Redis 管理**：通过 SSH 隧道连接 Redis，支持键搜索、读取、写入、删除和命令执行
- **系统监视器**：查看远程系统状态信息
- **进程管理**：查看进程、搜索、按 CPU 或内存排序，并可发送终止信号
- **系统设置**：查看系统信息、网络接口、镜像源、系统更新、Hosts、路由和磁盘挂载信息

### 设置、日志与备份

- **应用设置**：支持语言、界面字体、主题、强调色、默认主机视图和终端偏好
- **日志页面**：记录连接、主机、密钥、配置和系统操作，可搜索、筛选和清空
- **配置导入导出**：可完整导出或导入主机、密钥、设置和浏览器书签
- **本地 Vault**：主机、密钥、设置和书签统一存入主进程本地仓库

---

<a name="界面模块"></a>
# 界面模块

| 模块 | 说明 |
| :--- | :--- |
| 主机 | 管理 SSH 主机、分组、标签、搜索、快速连接和连接入口 |
| 密钥 | 导入密钥对、生成 RSA 密钥、复制公钥、编辑和删除密钥 |
| 日志 | 查看连接、主机、密钥、配置和系统日志 |
| 设置 | 配置主题、字体、终端偏好、凭据保存策略和备份导入导出 |
| 远程桌面 | 连接后的多窗口工作区与 Dock |
| 文件管理 | Windows 风格 SFTP 文件管理器 |
| 终端 | xterm.js 远程 SSH Shell |
| 记事本 | 远程文本文件编辑器 |
| 浏览器 | webview 浏览器和书签栏 |
| 系统监视器 | 远程状态信息概览 |
| MySQL | 通过 SSH 隧道管理 MySQL |
| Redis | 通过 SSH 隧道管理 Redis |
| 进程管理 | 查看、搜索、排序和终止远程进程 |
| 系统设置 | 网络、镜像源、更新、Hosts、路由和磁盘工具 |

---

<a name="数据与安全"></a>
# 数据与安全

ShellDesk 会把本地数据保存在 Electron 的用户数据目录中，主机、密钥、设置和浏览器书签共用本地 Vault。

- **Vault 路径**：运行后可在设置页的“存储状态”中查看
- **加密保存**：当系统支持 Electron `safeStorage` 时，Vault 会使用系统凭据加密保存
- **权限保护**：当系统不支持加密时，会退回到本地文件权限保护
- **日志存储**：日志同样写入用户数据目录中的本地文件
- **明文备份提醒**：导出的配置 JSON 包含主机、密钥、密码、私钥内容与密钥口令，只适合放在完全信任的位置

---

<a name="快速开始"></a>
# 快速开始

### 前置条件

- Node.js 20 或更高版本
- pnpm 9 或更高版本
- Windows 10 或更高版本

### 安装依赖

```bash
pnpm install
```

### 启动开发模式

```bash
pnpm dev
```

该命令会并行启动 Vite 开发服务器和 Electron：

- Vite 默认监听 `127.0.0.1:5173`
- Electron 会等待开发服务器就绪后自动打开窗口
- 如果退出后端口 `5173` 被残留进程占用，只停止占用该端口的 PID

可用以下命令定位并停止残留进程：

```powershell
netstat -ano | findstr :5173
Stop-Process -Id <PID>
```

---

<a name="构建与打包"></a>
# 构建与打包

### 生产构建

```bash
pnpm build
```

该命令会执行 TypeScript 检查，并通过 Vite 输出生产资源到 `dist/`。

### 运行已构建应用

```bash
pnpm start
```

通常建议先执行 `pnpm build`，再使用该命令加载构建产物。

### 预览前端构建

```bash
pnpm preview
```

该命令只预览 Vite 构建产物，不会启动 Electron 主进程能力。

### 生成目录包

```bash
pnpm release:dir
```

### 生成 Windows 安装包

```bash
pnpm release
```

当前发布脚本面向 Windows NSIS 安装包。其他平台可基于 Electron Builder 继续补充打包配置。

---

<a name="项目结构"></a>
# 项目结构

```text
ShellDesk/
├── electron/
│   ├── main.cjs                         # 主进程：窗口管理、SSH、SFTP、数据库隧道、IPC
│   └── preload.cjs                      # contextBridge 安全桥接
├── src/
│   ├── App.tsx                          # 主机库、密钥、日志、设置和连接入口
│   ├── RemoteDesktop.tsx                # 远程桌面导出入口
│   ├── RemoteDesktopShell.tsx           # 多窗口远程桌面与 Dock
│   ├── main.tsx                         # React 入口
│   ├── assets/
│   │   ├── images/                      # 应用图标
│   ├── components/
│   │   ├── navigation/                  # 主界面导航图标
│   │   └── remote-desktop/              # 远程桌面内置应用
│   ├── pages/
│   │   ├── KeysPage.tsx                 # SSH 密钥管理
│   │   ├── LogsPage.tsx                 # 日志页面
│   │   └── SettingsPage.tsx             # 应用设置
│   └── styles/
│       ├── index.scss                   # 全局样式入口
│       ├── _tokens.scss                 # 字体、CSS 变量和主题 token
│       ├── foundations/                 # reset、基础元素、全局行为
│       ├── layout/                      # 应用壳、顶部栏、侧边导航
│       ├── pages/                       # 主机、密钥、日志、设置样式
│       ├── remote-desktop/              # 远程桌面和内置应用样式
│       └── themes/                      # 浅色主题覆盖
├── index.html
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
└── vite.config.ts
```

---

<a name="技术栈"></a>
# 技术栈

| 分类 | 技术 |
| :--- | :--- |
| 桌面框架 | Electron 40 |
| 前端框架 | React 19 |
| 类型系统 | TypeScript 5.9 |
| 构建工具 | Vite 7 |
| 样式方案 | Sass / SCSS + CSS 变量 |
| SSH / SFTP | ssh2 |
| 终端渲染 | xterm.js |
| 代码高亮 | highlight.js |
| MySQL | mysql2 |
| Redis | ioredis |
| 打包工具 | electron-builder |
| 包管理器 | pnpm |

---

<a name="开发约定"></a>
# 开发约定

- **新增 IPC 需要同步三处**：`electron/main.cjs`、`electron/preload.cjs`、`src/vite-env.d.ts`
- **Electron 文件使用 CommonJS**：主进程和预加载脚本保持 `.cjs`
- **前端文件使用 ESM**：React 与工具代码使用 `.tsx` 或 `.ts`
- **状态管理使用 React Hooks**：不引入 Redux、Zustand 等全局状态库
- **样式统一放在 SCSS 模块中**：入口为 `src/styles/index.scss`
- **主题需要成对维护**：新增样式时同时考虑深色和浅色主题
- **右键菜单和弹窗使用 Portal**：远程桌面窗口使用 `transform` 定位，浮层需要渲染到 `document.body`
- **文案保持中文**：界面文案和说明文字以中文为主

更完整的工程说明见 [AGENTS.md](AGENTS.md)。

---

<a name="后续方向"></a>
# 后续方向

- 补充正式截图、演示动图和安装包下载说明
- 完善多平台打包与发布流程
- 继续增强 SFTP 批量操作、传输队列和错误恢复
- 增加更细粒度的凭据管理和备份加密选项
- 完善日志查询、连接历史和审计信息
- 为远程系统设置模块补充更多发行版适配
- 增加自动化测试和端到端验证

---

<a name="参与贡献"></a>
# 参与贡献

欢迎提交 Issue、建议和 Pull Request。

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 安装依赖并启动开发环境：`pnpm install && pnpm dev`
4. 提交前运行构建检查：`pnpm build`
5. 提交变更并发起 Pull Request

---

<a name="开源协议"></a>
# 开源协议

当前仓库尚未声明开源协议。如需对外发布或分发，请先补充 `LICENSE` 文件并在本节同步说明。

---

<p align="center">
  用心构建一个更顺手的远程服务器工作台。
</p>
