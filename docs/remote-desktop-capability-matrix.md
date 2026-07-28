# 远程桌面应用能力与验证矩阵

> 本文档由 `src/remoteDesktopCatalog.ts` 生成。运行 `node scripts/check-desktop-capability-matrix.cjs --write` 更新；CI 使用无参数模式检查漂移。

状态说明：

- `automated-contract`：注册、窗口、图标、i18n 和渲染分支由合同检查覆盖。
- `automated-probe`：Launchpad 会在连接级缓存中自动探测依赖，并覆盖缺失依赖状态。
- `expected-unsupported`：平台不在应用声明范围内，打开入口会被能力门禁阻止。
- `not-applicable`：该平台无需外部命令探测。
- `environment-required`：仍需在对应真实主机上验证完整业务读写流程，不能把缺少环境误报为通过。

当前目录共 44 个应用。

| appKey | 平台 | Linux 依赖 | Windows 依赖 | macOS 依赖 | 模式 | 权限 | 启动合同 | Linux 依赖/不支持 | Windows 依赖/不支持 | macOS 依赖/不支持 | 真实主机 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `files` | linux / windows / macos | — | — | — | workspace | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `terminal` | linux / windows / macos | — | — | — | workspace | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `notepad` | linux / windows / macos | — | — | — | workspace | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `code-editor` | linux / windows / macos | — | — | — | workspace | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `browser` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `vnc` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `rdp-viewer` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `log-viewer` | linux / windows / macos | — | — | — | read-only | sudo-optional | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `monitor` | linux / windows / macos | — | — | — | read-only | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `mysql` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `clickhouse` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `redis` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `service-manager` | linux / windows / macos | systemctl | sc.exe | launchctl | management | sudo-required | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `supervisor-manager` | linux / macos | supervisorctl | supervisorctl | supervisorctl | management | sudo-optional | automated-contract | automated-probe | expected-unsupported | automated-probe | environment-required |
| `backup-manager` | linux / windows / macos | — | — | — | management | sudo-optional | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `container-manager` | linux / windows / macos | docker / podman | docker / podman | docker / podman | management | sudo-optional | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `k8s-manager` | linux / windows / macos | kubectl | kubectl | kubectl | management | user | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `vm-manager` | linux | virsh | virsh | virsh | management | sudo-optional | automated-contract | automated-probe | expected-unsupported | expected-unsupported | environment-required |
| `port-manager` | linux / windows / macos | — | — | — | management | sudo-optional | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `firewall-manager` | linux / windows / macos | — | — | — | management | sudo-required | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `iptables-manager` | linux | iptables | iptables | iptables | management | sudo-required | automated-contract | automated-probe | expected-unsupported | expected-unsupported | environment-required |
| `network-diagnostics` | linux / windows / macos | — | — | — | read-only | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `disk-analyzer` | linux / windows / macos | — | — | — | read-only | sudo-optional | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `disk-manager` | linux / windows / macos | — | — | — | management | sudo-required | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `package-manager` | linux / windows / macos | — | — | — | management | sudo-required | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `git-manager` | linux / windows / macos | git | git | git | management | user | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `cert-manager` | linux / windows / macos | openssl | openssl | openssl | management | sudo-optional | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `nginx-manager` | linux / windows / macos | nginx | nginx | nginx | management | sudo-required | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `caddy-manager` | linux / windows / macos | caddy | caddy | caddy | management | sudo-required | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `apache-manager` | linux / windows / macos | apache2 / httpd | apache2 / httpd | apache2 / httpd | management | sudo-required | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `scheduled-tasks` | linux / windows / macos | crontab | schtasks.exe | launchctl | management | sudo-optional | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `postgres` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `mongo` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `search-cluster` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `message-queue` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `s3-browser` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `frp-manager` | linux / windows / macos | frpc | frpc | frpc | management | sudo-optional | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `frps-manager` | linux / windows / macos | frps | frps | frps | management | sudo-optional | automated-contract | automated-probe | automated-probe | automated-probe | environment-required |
| `security-audit` | linux / windows / macos | — | — | — | read-only | sudo-optional | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `api-debugger` | linux / windows / macos | — | — | — | network-client | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `procmanager` | linux / windows / macos | — | — | — | management | sudo-optional | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `ai-chat` | linux / windows / macos | — | — | — | workspace | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `settings` | linux / windows / macos | — | — | — | management | sudo-optional | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |
| `sqlite` | linux / windows / macos | — | — | — | workspace | user | automated-contract | not-applicable | not-applicable | not-applicable | environment-required |

## 验证边界

- 本矩阵证明应用目录、静态平台门禁和依赖探测契约完整，不把它等同于真实系统上的功能成功。
- 具有写操作的管理组件仍须在兼容性报告中记录成功读流程、权限不足流程、危险操作确认和失败恢复。
- 新增 appKey 时，桌面应用合同会要求同步能力元数据；本脚本随后自动生成对应矩阵行。
