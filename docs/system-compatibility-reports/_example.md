# xxxx 兼容性报告

## 测试方式

xx  

## 组件兼容性

✅ 已支持 Supported
ℹ️ 未测试 Untested
⚠️ 有限支持 Limited support
❌ 不支持 Unsupported

| 组件名 | 英文名 | 是否支持 |
| :--- | :--- | :---: |
| 文件管理 | File Manager | ℹ️ |
| 终端 | Terminal | ℹ️ |
| 浏览器 | Browser | ℹ️ |
| 系统设置 | System Settings | ℹ️ |
| 记事本 | Notepad | ℹ️ |
| 安全巡检 | Security Audit | ℹ️ |
| 包管理器 | Package Manager | ℹ️ |
| 磁盘分析 | Disk Analyzer | ℹ️ |
| 登录会话 | Login Sessions | ℹ️ |
| 端口监听 | Port Listener Manager | ℹ️ |
| 防火墙 | Firewall Manager | ℹ️ |
| 服务管理 | Service Manager | ℹ️ |
| 计划任务 | Scheduled Tasks | ℹ️ |
| 进程管理 | Process Manager | ℹ️ |
| 日志查看 | Log Viewer | ℹ️ |
| 容器管理 | Container Manager | ℹ️ |
| 搜索集群 | Search Cluster | ℹ️ |
| 网络诊断 | Network Diagnostics | ℹ️ |
| 系统监视器 | System Monitor | ℹ️ |
| 消息队列 | Message Queue | ℹ️ |
| API 调试 | API Debugger | ℹ️ |
| Git 仓库 | Git Repository Manager | ℹ️ |
| iptables 管理 | iptables Manager | ℹ️ |
| MinIO / S3 | MinIO / S3 Browser | ℹ️ |
| MongoDB | MongoDB Manager | ℹ️ |
| MySQL | MySQL Manager | ℹ️ |
| PostgreSQL | PostgreSQL Manager | ℹ️ |
| Redis | Redis Manager | ℹ️ |
| SQLite | SQLite Manager | ℹ️ |
| VNC Viewer | VNC Viewer | ℹ️ |
| Web 服务 | Web Server Manager | ℹ️ |

## 部分组件安装方案

``` shell
# elasticsearch
podman run -d \ 
   --name elasticsearch \ 
   -p 9200:9200 -p 9300:9300 \ 
   -e "discovery.type=single-node"  \ 
   -e "ES_JAVA_OPTS=-Xms1g -Xmx1g" \ 
   -v es_data:/usr/share/elasticsearch/data \ 
   docker.elastic.co/elasticsearch/elasticsearch:8.17.4
podman exec -it elasticsearch /usr/share/elasticsearch/bin/elasticsearch-reset-password -u elastic
```

``` shell
# rabbitmq
podman run -d \ 
  --name my-rabbitmq \ 
  -p 5672:5672 \ 
  -p 15672:15672 \ 
  -e RABBITMQ_DEFAULT_USER=admin \ 
  -e RABBITMQ_DEFAULT_PASS=admin \ 
  rabbitmq:management
```

``` shell
# vnc-server
podman run -d \ 
  --name my-vnc-container \ 
  -p 5900:5901 \ 
  -p 6900:6901 \ 
  -e VNC_PW=password \ 
  docker.io/accetto/ubuntu-vnc-xfce-g3
```
