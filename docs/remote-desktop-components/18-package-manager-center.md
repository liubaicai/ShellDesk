# 包管理器中心功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `package-manager`），实现入口为 `src/components/remote-desktop/RemotePackageManager.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

包管理器中心用于图形化管理远程系统软件包。它面向日常维护场景：查看更新、搜索包、安装、卸载、升级，以及识别当前系统包管理器。

镜像源管理已迁入系统设置的“镜像源”菜单，包管理器中心仅保留跳转入口，避免包操作和系统级仓库配置混在同一工作区。

## 目标用户场景

- 查看系统是否有可升级软件包。
- 搜索并安装某个工具，例如 `htop`、`ncdu`。
- 卸载不再需要的软件包。
- 一键执行安全更新或全部更新。
- 查看某个包是否已安装。

## 首版功能范围

- 自动检测包管理器：
  - apt、dnf、yum、pacman、zypper、apk。
  - Windows winget 和 choco 可第二阶段增强。
- 软件包搜索。
- 已安装包查询。
- 可升级包列表。
- 操作：
  - install。
  - remove。
  - upgrade selected 或 upgrade all。
  - refresh metadata。

## 交互设计

采用三块区域：

- 顶部状态栏：系统类型、包管理器、上次刷新时间、刷新按钮。
- 左侧导航：可升级、已安装、搜索。
- 主区域：
  - 包列表表格。
  - 包详情抽屉。
  - 操作按钮。

安装、卸载、升级都必须使用自定义确认弹窗，并展示将执行的命令。

## 数据模型

```ts
type PackageManagerKind = 'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'apk' | 'winget' | 'choco' | 'unknown';

interface RemotePackageInfo {
  name: string;
  version?: string;
  latestVersion?: string;
  description?: string;
  installed: boolean;
  upgradable?: boolean;
  source?: string;
}
```

## 远程命令设计

检测：

- `command -v apt-get dnf yum pacman zypper apk`。

apt：

- 已安装：`dpkg-query -W -f='${Package}\t${Version}\t${binary:Summary}\n'`。
- 搜索：`apt-cache search <keyword>`。
- 可升级：`apt list --upgradable`。
- 刷新：`sudo apt-get update`。
- 安装：`sudo apt-get install -y <package>`。
- 卸载：`sudo apt-get remove -y <package>`。

dnf/yum：

- `dnf list installed`
- `dnf search`
- `dnf check-update`
- `sudo dnf install -y`

pacman：

- `pacman -Q`
- `pacman -Ss`
- `checkupdates` 如果不存在则提示。
- `sudo pacman -S --noconfirm`

zypper/apk 类似封装为 provider。

## IPC 与代码落点

首版可以用 `runCommand`，但安装/升级命令可能需要 sudo 密码和较长输出。更稳妥的长期方案是支持“在终端中运行此命令”，让用户处理交互式 sudo。

首版策略：

- 默认执行非交互查询命令。
- 安装、卸载、升级先展示命令，提供“复制命令”和“在终端中打开”的路径。
- 若确认直接执行，只支持无交互 sudo 环境。

首版文件建议：

- `src/components/remote-desktop/RemotePackageManager.tsx`
- `src/components/remote-desktop/PackageSourcesPanel.tsx`
- `src/styles/remote-desktop/_package-manager.scss`
- `src/components/remote-desktop/packageProviders.ts`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 设计 provider 接口和包管理器检测。
2. 实现 apt provider。
3. 实现 dnf/yum provider。
4. 实现 pacman、zypper、apk 查询能力。
5. 完成搜索、已安装、可升级三个视图。
6. 实现操作确认和命令执行/复制。
7. 增加 Windows winget/choco 基础检测。

## 验收标准

- Ubuntu/Debian 能搜索、列出已安装、列出可升级包。
- Fedora/RHEL 系能识别 dnf/yum。
- 未安装对应工具时给出明确提示。
- 安装/卸载命令不会静默执行危险操作，必须确认。
- 命令参数经过包名校验。

## 后续增强

- 交互式命令绑定终端。
- 软件源管理。
- 更新历史。
- 按安全更新筛选。
- 包详情依赖树。
