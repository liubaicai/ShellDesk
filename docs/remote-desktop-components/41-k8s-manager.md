# Kubernetes 管理器

<!-- current-implementation:start -->
## 当前实现状态

- 接入状态：已接入远程桌面目录，appKey 为 `k8s-manager`；注册、窗口、图标、翻译和渲染分支由合同检查覆盖。
- 能力声明：平台 `linux / windows / macos`；模式 `management`；权限 `user`。
- 依赖探测：Linux `kubectl`；Windows `kubectl`；macOS `kubectl`。存在依赖时由 Launchpad 连接级探测并显示缺失原因。
- 验证边界：启动合同为 `automated-contract`；完整业务流程仍为 `environment-required`，没有真实主机证据时不得写成已验证通过。
- 最后同步：2026-07-28；详见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
<!-- current-implementation:end -->

> 当前状态：已接入远程桌面（appKey: `k8s-manager`），实现入口为 `src/components/remote-desktop/RemoteK8sManager.tsx`。

## 定位

通过远端已有的 `kubectl` 管理 Kubernetes 集群，复用 ShellDesk 的 russh 命令通道和终端窗口，不引入本地 kubeconfig 或新的后端协议实现。

## 当前实现范围

- 探测 `kubectl`、读取当前 context、切换 namespace。
- 浏览 Pod、Deployment、StatefulSet、DaemonSet、节点与命名空间。
- 查看资源详情、事件、容器、日志和 YAML。
- Pod Exec、删除 Pod、调整 Workload 副本数及滚动重启。
- 通过自定义弹窗确认删除、扩缩容和重启等写操作。

## 代码落点

- `src/components/remote-desktop/RemoteK8sManager.tsx`
- `src/components/remote-desktop/k8sCommands.ts`
- `src/components/remote-desktop/k8sParsers.ts`
- `src/components/remote-desktop/k8sTypes.ts`
- `src/styles/remote-desktop/_k8s-manager.scss`
- `src/assets/desktop-icons/k8s-manager.png`

## 设计边界

- 命令在 SSH 目标机执行，使用目标机的 kubeconfig 和 RBAC 权限。
- 不把 kubeconfig 或集群凭据复制到 ShellDesk 本地。
- 大规模集群的服务端分页、Watch 流和 CRD 管理尚未覆盖。

## 后续增强

- Service、Ingress、ConfigMap、Secret 与 CRD 浏览。
- Watch 增量刷新、资源指标和更细粒度的 RBAC 预检。
