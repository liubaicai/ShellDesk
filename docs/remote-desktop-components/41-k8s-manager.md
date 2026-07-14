# Kubernetes 管理器

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
