# GUI-SSH

一个基于 Electron + React 构建的现代化图形化 SSH 客户端。

> 当前版本：`0.1.0` · 开发阶段：Alpha

## 功能特性

### 已实现

- **主机管理** — 分组、标签、网格/列表视图，支持搜索与筛选
- **SSH 连接** — 密码 / 私钥两种认证方式，自动保存凭据
- **远程终端** — 实时交互式 Shell
- **文件管理器** — 基于 SFTP 的远程目录浏览
- **资源监视器** — 查看服务器状态信息
- **端口转发** — 本地代理端口映射
- **浏览器视图** — 通过代理访问远程内部服务
- **钥匙串 / 已知主机 / 代理 / 代码片段 / 日志** — 侧边栏统一管理
- **暗色主题** — 跟随系统或手动切换

### 规划中

SFTP 高级操作、串口连接、密钥生成与管理等

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Electron 40 |
| 前端 | React 19 + TypeScript 5.9 |
| 构建 | Vite 7 |
| SSH | ssh2 |
| 包管理 | pnpm |

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 9

### 安装依赖

```bash
pnpm install
```

### 开发模式

```bash
pnpm dev
```

该命令会同时启动 Vite 开发服务器和 Electron 窗口，支持热更新。

### 构建打包

```bash
pnpm build
```

### 直接启动

```bash
pnpm start
```

## 项目结构

```
GUISSH/
├── electron/           # Electron 主进程 & 预加载脚本
│   ├── main.cjs        # 主进程：窗口管理、IPC、SSH 连接
│   └── preload.cjs     # 预加载脚本：安全桥接
├── src/                # React 前端源码
│   ├── App.tsx         # 主应用组件
│   ├── main.tsx        # 入口文件
│   └── styles.css      # 全局样式
├── index.html          # HTML 模板
├── vite.config.ts      # Vite 配置
└── package.json
```

## 许可证

[MIT](LICENSE)
