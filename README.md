# ShellDesk

一个基于 Electron、React 与 TypeScript 的图形化 SSH 客户端原型。

当前版本聚焦于 **本地主机库管理**、**SSH 连接** 与 **连接后的远程工作台**，适合作为桌面端 GUI SSH 工具的早期实现基础。

> 当前版本：`0.1.0` · 阶段：Alpha / Prototype

## 当前已实现

### 主机库

- 新建、编辑、删除 SSH 主机
- 支持主机分组、标签、备注
- 支持搜索筛选
- 支持网格 / 列表两种视图
- 支持密码登录与私钥登录两种认证方式

### 密钥管理

- 新建密钥记录
- 选择本地私钥文件
- 导入已有私钥路径
- 维护密钥名称、路径与可选口令

### 远程连接与工作台

- 通过 `ssh2` 建立 SSH 连接
- 认证失败时补录密码或密钥口令后重试
- 打开独立连接窗口
- 为每个连接创建本地 SOCKS5 代理
- 连接后提供桌面式多窗口工作区，包含：
  - 远程终端
  - SFTP 文件浏览器
  - 系统监视器
  - 远程浏览器视图

### 界面体验

- 左侧功能导航
- 可拖拽、缩放、最大化的桌面窗口
- 设置页原型界面
- 深色主题默认样式

## 当前限制

- 日志页目前仍为占位界面，尚未接入真实日志数据
- 设置页当前以界面原型为主，绝大部分设置尚未持久化
- 暂未提供独立的端口转发管理页、已知主机管理、代码片段等模块
- 当前未包含 Electron 安装包生成与发布流程

## 数据存储说明

- 主机列表与密钥信息保存在本地应用存储中
- 若用户选择保存，主机密码或密钥口令也会写入本地存储
- 当前版本 **尚未接入系统钥匙串 / 安全存储**，因此更适合作为开发中的原型版本使用

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 40 |
| 前端 | React 19 + TypeScript 5.9 |
| 构建工具 | Vite 7 |
| 样式 | Sass / SCSS + CSS 变量 |
| SSH 能力 | ssh2 |
| 终端渲染 | xterm.js |
| 包管理 | pnpm |

## 快速开始

### 环境要求

- 建议 Node.js >= 20
- pnpm >= 9

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm dev
```

该命令会启动本地 Vite 开发服务器（`127.0.0.1:5173`），随后拉起 Electron 窗口，适合日常开发与调试。

### 构建前端资源

```bash
pnpm build
```

该命令会先执行 TypeScript 检查，再输出 Vite 构建结果到 `dist/`。

### 运行 Electron

```bash
pnpm start
```

该命令直接启动 Electron，并加载已构建好的 `dist/` 资源。通常建议先执行一次 `pnpm build`。

### 预览构建结果

```bash
pnpm preview
```

用于预览前端构建产物，不会启动 Electron。

## 页面与模块概览

| 模块 | 说明 |
|------|------|
| 主机 | 管理 SSH 主机、分组、标签、搜索与连接 |
| 密钥 | 管理私钥路径与口令信息 |
| 日志 | 预留页面，尚未接入真实数据 |
| 设置 | 主题、颜色、语言与基础偏好设置原型 |
| 远程桌面 | 终端、文件、浏览器、监视器四类连接工具 |

## 项目结构

```text
ShellDesk/
├── electron/
│   ├── main.cjs                        # Electron 主进程、SSH 连接、SOCKS5 代理、IPC
│   └── preload.cjs                     # 预加载脚本与安全桥接
├── src/
│   ├── App.tsx                         # 主应用入口，主机/密钥/设置导航与状态管理
│   ├── RemoteDesktop.tsx               # 远程桌面导出入口
│   ├── RemoteDesktopShell.tsx          # 连接后的桌面式窗口容器
│   ├── main.tsx                        # React 启动入口
│   ├── styles/
│   │   ├── index.scss                  # 全局样式入口，按级联顺序聚合模块
│   │   ├── _tokens.scss                # 字体、CSS 变量、主题 token
│   │   ├── foundations/                # reset、基础元素、全局行为
│   │   ├── layout/                     # 应用壳、顶部栏、侧边导航
│   │   ├── pages/                      # 主机、密钥、日志、设置等页面样式
│   │   ├── remote-desktop/             # 远程桌面及各内置应用样式
│   │   └── themes/                     # 浅色主题与远程应用主题覆盖
│   ├── components/
│   │   ├── navigation/
│   │   │   └── NavIcon.tsx             # 导航图标
│   │   └── remote-desktop/
│   │       ├── RemoteBrowser.tsx       # 远程浏览器视图
│   │       ├── RemoteFileExplorer.tsx  # SFTP 文件浏览
│   │       ├── RemoteMonitor.tsx       # 系统监视器
│   │       ├── RemoteTerminal.tsx      # 终端组件（xterm.js）
│   │       ├── desktopUtils.ts         # 桌面工具函数
│   │       ├── index.ts
│   │       └── types.ts                # 连接类型定义
│   └── pages/
│       ├── KeysPage.tsx                # 密钥页面
│       ├── LogsPage.tsx                # 日志页面
│       └── SettingsPage.tsx            # 设置页面
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## 样式架构

- React 入口 `src/main.tsx` 仅导入 `src/styles/index.scss`
- `index.scss` 使用 Sass `@use` 聚合各功能模块，导入顺序即最终 CSS 级联顺序
- 基础 token 与全局 reset 放在 `src/styles/_tokens.scss` 与 `src/styles/foundations/`
- 页面级样式放在 `src/styles/pages/`，远程桌面窗口与内置应用样式放在 `src/styles/remote-desktop/`
- 主题覆盖放在 `src/styles/themes/`
- 当前视觉刷新与紧凑密度规则就近维护在对应模块文件末尾，不再使用全局 `overrides/` 补丁目录

## 后续方向

- 完善日志系统与连接历史
- 持久化设置与主题配置
- 增加更完整的 SFTP 操作能力
- 补充更安全的凭据存储方案
- 增加打包发布与安装流程

## 许可证

暂未声明。
