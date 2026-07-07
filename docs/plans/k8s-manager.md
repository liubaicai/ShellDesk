# K8s Manager 实现计划

## Issue
https://github.com/liubaicai/ShellDesk/issues/98

Feature: 在 ShellDesk 远程桌面中添加 Kubernetes 集群管理组件。

## 架构决策

**后端策略**: 通过 SSH 执行 `kubectl` 命令，输出格式使用 `-o json`。
- `kubectl` 是 K8s 的标准 CLI，绝大多数 K8s 节点上都已安装
- `-o json` 输出结构化 JSON，前端直接解析，后端无需额外 Rust 代码
- 完全复用现有的 `runCommand()`（`window.guiSSH.connections.runCommand`）设施
- 无需新增 Rust 后端模块或 IPC

**kubeconfig 管理**: 支持两种模式：
1. 远端服务器已有默认的 `~/.kube/config`
2. 用户上传自定义 kubeconfig（通过 SFTP 上传到远程）

**Namespace 切换**: 通过 `kubectl -n <namespace>` 参数实现，额外支持 `--all-namespaces` 模式。

## 文件结构

```
src/components/remote-desktop/
├── k8sTypes.ts          # K8s 数据类型定义
├── k8sCommands.ts       # kubectl 命令构建
├── k8sParsers.ts        # JSON 输出解析器
├── RemoteK8sManager.tsx  # 主组件
├── K8sPodDetail.tsx     # Pod 详情面板
├── K8sWorkloadDetail.tsx # Workload 详情面板
├── K8sLogViewer.tsx     # 日志查看（可复用 LogViewer 模式）
├── K8sYamlEditor.tsx    # YAML 编辑（可复用 CodeEditor 模式）
styles/remote-desktop/
├── _k8s-manager.scss    # K8s 组件样式
```

## Phase 1: K8s 基础连接 + Pod 管理 (P0) — ~3-5天

### 数据类型 (k8sTypes.ts)
```
K8sContext       — kubeconfig 中的集群上下文
K8sNamespace     — 命名空间
K8sPod           — Pod 摘要（name, namespace, status, node, age, containers）
K8sPodContainer  — Pod 内的容器
K8sPodDetail     — 完整 Pod 详情（conditions, events, resource usage）
```
kubectl `-o json` 输出的 JSON 结构稳定，直接映射 TypeScript 接口。

### 命令构建 (k8sCommands.ts)
```typescript
// kubectl 路径探测
getKubectlDetectCommand(): RemoteCommandInput
// kubectl version 探测
getKubectlVersionCommand(): RemoteCommandInput

// 上下文/命名空间
getContextListCommand(): RemoteCommandInput     // kubectl config get-contexts -o json
getNamespaceListCommand(): RemoteCommandInput   // kubectl get ns -o json

// Pod 操作
getPodListCommand(namespace?: string): RemoteCommandInput
getPodDetailCommand(name, namespace): RemoteCommandInput
getPodLogsCommand(name, namespace, container?, tail?): RemoteCommandInput
getPodExecCommand(name, namespace, container?): RemoteCommandInput
getPodDeleteCommand(name, namespace): RemoteCommandInput

// 节点
getNodeListCommand(): RemoteCommandInput
getNodeDetailCommand(name): RemoteCommandInput
```

所有命令输出格式统一使用 `-o json`。

### JSON 解析器 (k8sParsers.ts)
```typescript
parseKubectlList<T>(jsonOutput: string): T[]
parseKubectlItem<T>(jsonOutput: string): T
parsePodList(output): K8sPod[]
parseNamespaceList(output): K8sNamespace[]
parseNodeList(output): K8sNode[]
```

kubectl 的 JSON 输出格式：
```json
{
  "apiVersion": "v1",
  "items": [ ... ],
  "metadata": { ... }
}
```
直接类型映射即可，无需复杂解析逻辑。

### 主组件 (RemoteK8sManager.tsx)
- 连接窗口打开时自动探测 kubectl 可用性
- 顶部工具栏：Namespace 下拉选择器 + 刷新按钮 + 配置导入
- 主面板：Pod 列表表格（Name, Namespace, Status, Node, Age, Containers）
- 搜索/过滤：按 Pod 名称和状态过滤

### Pod 详情 (K8sPodDetail.tsx)
- 基础信息（labels, annotations, node, IP, service account）
- 容器列表（name, image, state, restart count）
- Conditions
- Events（排序，最近事件优先）
- 操作按钮：查看日志、Exec 终端、删除

### 不需要 Rust 后端的理由
- `runCommand()` 已经支持 SSH 执行任意命令并返回 stdout/stderr/code
- kubectl 的 JSON 输出全部在前端解析
- 不需要端口转发、不需要守护进程、不需要任何新依赖

## Phase 2: Workload 管理 (P1) — ~3-5天

### 新增命令
```typescript
// Deployment
getDeploymentListCommand(namespace?)
getDeploymentDetailCommand(name, namespace)
getDeploymentScaleCommand(name, namespace, replicas)
getDeploymentRolloutRestartCommand(name, namespace)
getDeploymentRolloutStatusCommand(name, namespace)

// StatefulSet （与 Deployment 同理）
// DaemonSet （与 Deployment 同理）
```

### 新增组件
- K8sWorkload.tsx — Deployment/StatefulSet/DaemonSet 共用的列表组件，通过 tab 切换
- K8sWorkloadDetail.tsx — workload 详情（策略、selector、replicas 状态、容器模板）

### Workload 列表
| 列 | 数据来源 |
|---|---|
| Name | `metadata.name` |
| Namespace | `metadata.namespace` |
| Desired/Ready/Up-to-date/Available | `status.replicas` 相关字段 |
| Age | `metadata.creationTimestamp` |
| Image | `spec.template.spec.containers[].image` |

### 扩缩容
```bash
kubectl scale deployment/<name> -n <namespace> --replicas=N
```
用 `runCommand()` 执行，检查返回 code。

### 滚动更新操作
```bash
kubectl rollout restart deployment/<name> -n <namespace>
kubectl rollout status deployment/<name> -n <namespace>
```

### YAML 编辑
```bash
kubectl get deployment/<name> -n <namespace> -o yaml
# 编辑后：
kubectl apply -f - <<'EOF'
<edited-yaml>
EOF
```
通过代码编辑器（CodeEditor）组件或直接编辑文本。

## Phase 3: 网络 & 配置资源 (P2) — ~3-5天

### Service/Ingress
```bash
kubectl get svc -n <ns> -o json
kubectl get ingress -n <ns> -o json
kubectl get svc/<name> -n <ns> -o yaml
```
展示 type, cluster-ip, ports, selector。

### ConfigMap/Secret
```bash
kubectl get cm -n <ns> -o json
kubectl get secret -n <ns> -o json
```
ConfigMap 直接展示 data 字段。Secret 需要解码 base64。

### Node 资源监控
```bash
kubectl get nodes -o json
kubectl top node  # 需要 metrics-server
```
展示 CPU/memory 使用率、node conditions、taints。

## Phase 4: kubeconfig 管理 (P1) — ~2-3天

### kubeconfig 管理 UI
- 显示当前 kubeconfig 中的 contexts
- 切换当前 context（`kubectl config use-context`）
- 上传本地 kubeconfig 到远端（使用 SFTP 写入 `~/.kube/config` 或自定义路径）
- 通过环境变量 `KUBECONFIG` 支持多配置文件

### 命令
```bash
kubectl config view -o json         # 查看所有上下文
kubectl config use-context <name>   # 切换上下文
kubectl config current-context      # 当前上下文
```

---

## 桌面应用注册（所有 Phase 共用）

需更新的文件：
1. `src/components/remote-desktop/index.ts` — 导出组件
2. `src/RemoteDesktopShell.tsx` — 注册 appKey `k8s-manager`，图标映射
3. `src/vite-env.d.ts` — 添加类型声明
4. `src/tauriBridge.ts` — 桥接方法（如有需要）
5. `src/i18nCatalog.ts` — i18n 翻译（zhCN + enUS）
6. `src/App.tsx` — 默认 app catalog 版本 + persistence whitelist
7. `src-tauri/src/vault.rs` — `default_settings()` + `normalize.rs` 中的 catalog
8. `src/styles/remote-desktop/index.scss` — 引入样式
9. `src/assets/desktop-icons/k8s-manager.png` — 图标

## 技术风险点
1. kubectl 在远端不一定可用 — 需要探测 + 清晰的错误提示
2. 权限不足 — 有些操作需要 cluster-admin 权限，执行前可用 `kubectl auth can-i` 检查
3. 集群规模 — 大型集群（1000+ Pod）需要分页或 `--chunk-size`
4. kubectl 版本差异 — 老版本 K8s 的 JSON 字段名可能不同
5. exec 终端 — 需要复用 ShellDesk 现有终端组件，传入 `kubectl exec` 命令
6. 日志流式 — `kubectl logs -f` 需要流式输出支持

## 现有可复用组件
- **终端**: `RemoteTerminal` 或 Codex terminal pattern — 用于 `kubectl exec`
- **日志查看器**: `RemoteLogViewer` 或代码编辑器 — 用于 `kubectl logs`
- **YAML 编辑器**: `RemoteCodeEditor` — 用于编辑 K8s 资源 YAML
- sudo prompt: `useSudoCommand` — 如果 kubectl 需要 sudo
