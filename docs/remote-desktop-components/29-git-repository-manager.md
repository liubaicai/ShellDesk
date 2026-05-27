# Git 仓库管理器功能设计与开发计划

## 定位

Git 仓库管理器用于在远程主机上查看和维护代码仓库。它不是完整 IDE，而是面向服务器维护场景，帮助用户快速确认分支、变更、提交记录，并执行轻量级同步操作。

## 目标用户场景

- 查看远程目录是否是 Git 仓库。
- 查看当前分支、未提交变更和远程同步状态。
- 浏览最近提交记录和文件 diff。
- 查看本地分支树、远程分支和标签。
- 新建本地分支、删除本地分支、跟踪并切换远程分支。
- 暂存/取消暂存文件，填写提交信息并提交已暂存内容。
- 执行 fetch、pull、push、checkout 等常见同步操作。
- 在部署前确认服务器代码状态。

## 首版功能范围

- 仓库定位：
  - 输入路径或从文件管理器跳转。
  - 检测 `.git` 是否存在。
- 状态视图：
  - 当前分支、上游分支、ahead/behind。
  - changed、staged、untracked 文件列表。
- 分支视图：
  - 本地分支按 `/` 前缀分组。
  - 远程分支按 remote 名称分组。
  - 标签列表作为低优先级折叠信息。
- 提交视图：
  - 最近 50 条 commit。
  - 提交作者、时间、摘要、hash。
- Diff 视图：
  - 单文件 diff。
  - staged 和 unstaged 区分。
- 操作：
  - create branch。
  - delete local branch。
  - track remote branch。
  - stage all、stage selected、unstage all、unstage selected。
  - commit staged changes。
  - fetch。
  - pull。
  - push。
  - checkout 已存在分支。
  - discard 单文件作为后续功能，首版不默认做危险操作。

## 交互设计

界面参考 Sourcetree 的仓库工作台，采用顶部工具栏 + 左侧导航树 + 中间历史表 + 底部详情面板：

- 顶部：提交、拉取、推送、获取、分支、切换等高频按钮，以及仓库目录选择。
- 左侧：Workspace 导航、搜索、本地分支树、远程分支树、低优先级标签列表。
- 中间：History 表格，包含图谱列、描述、日期、作者和短 hash。
- 工作区：提交框、暂存/取消暂存、变更摘要和原始状态。
- 底部：选中提交详情、变更文件列表和 diff 入口。

commit、pull、push、checkout、删除分支、跟踪远程分支等会改变代码或远端状态的操作必须显示确认弹窗，列出当前分支、目标分支、仓库路径和提交信息。

## 数据模型

```ts
interface GitRepositoryState {
  path: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileChange[];
  branches: GitBranchSummary[];
  tags: GitTagSummary[];
}

interface GitBranchSummary {
  name: string;
  current: boolean;
  kind: 'local' | 'remote';
  upstream?: string;
}

interface GitFileChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}
```

## 远程命令设计

- 检测：`git -C <path> rev-parse --is-inside-work-tree`。
- 根目录：`git -C <path> rev-parse --show-toplevel`。
- 状态：`git -C <path> status --porcelain=v1 -b`。
- 分支：`git -C <path> branch --format=...` 和 `git branch -r --format=...`。
- 标签：`git -C <path> tag --sort=-creatordate -n 1`。
- 日志：`git -C <path> log --date=iso --pretty=format:'%H%x09%an%x09%ad%x09%s' -n 50`。
- Diff：`git -C <path> diff -- <file>` 和 `git diff --cached -- <file>`。
- 分支管理：`git checkout -b <branch>`、`git branch -d <branch>`、`git checkout -t <remote/branch>`。
- 暂存：`git add -A`、`git add -- <file>`。
- 取消暂存：优先 `git reset -- <file>` / `git reset -- .`，无 HEAD 的初始仓库回退到 `git rm --cached`。
- 提交：`git commit -F -` 或 Windows 远程临时提交信息文件。
- 同步操作：`git fetch --prune`、`git pull --ff-only`、`git push`、`git checkout <branch>`。

路径、分支、文件名和提交信息必须经过严格校验或转义。默认使用 `pull --ff-only`，避免自动产生 merge commit。

## IPC 与代码落点

首版复用 `runCommand`，不新增主进程 IPC。路径、分支和文件参数在渲染进程构造命令前校验并分别使用 POSIX shell / PowerShell 引号处理。

已实现文件：

- `src/components/remote-desktop/RemoteGitManager.tsx`
- `src/components/remote-desktop/gitUtils.ts`
- `src/styles/remote-desktop/_git-manager.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`
- `src/assets/desktop-icons/git-manager.png`

## 开发计划

1. 已接入远程桌面入口、窗口尺寸和图标。
2. 已实现仓库检测、根目录解析和状态展示。
3. 已实现变更文件列表、staged/unstaged diff 查看。
4. 已实现最近 50 条提交历史列表。
5. 已实现 Sourcetree 风格顶部工具栏、左侧分支树、历史表和底部详情布局。
6. 已实现本地/远程分支解析、分组展示、新建分支、删除本地分支、跟踪远程分支。
7. 已实现暂存、取消暂存、提交已暂存内容。
8. 已实现 fetch、pull --ff-only、push、checkout 本地分支。
9. 文件管理器跳转入口保留为后续联动。
10. 已完成错误状态、空状态、确认弹窗和浅色主题。

## 验收标准

- 远程 Git 仓库能正确显示分支和变更。
- 非 Git 目录显示明确提示。
- diff 能按文件展示。
- 能显示本地分支树、远程分支树和标签。
- 能新建分支、删除非当前本地分支、跟踪远程分支。
- 能完成暂存、填写提交信息、commit、push 的基础提交流程。
- fetch/pull/push 操作完成后刷新状态。
- 分支和路径参数不会造成命令注入。

## 后续增强

- stash。
- 强制删除分支、重命名分支。
- merge/rebase 可视化。
- 从部署面板关联仓库状态。
