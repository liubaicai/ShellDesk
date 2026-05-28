# Ubuntu 24.04 LTS 兼容性报告

## 测试方式

腾讯云 CVM   
Ubuntu Server 24.04 LTS 64位   
Intel(R) Xeon(R) Platinum 8374C CPU @ 2.70GHz   
2C/4G   
用户 ubuntu   
SSH密钥登录   

## 组件兼容性

✅ 已支持 Supported
ℹ️ 未测试 Untested
⚠️ 有限支持 Limited support
❌ 不支持 Unsupported

| 组件名 | 英文名 | 是否支持 |
| :--- | :--- | :---: |
| 文件管理 | File Manager | ✅ |
| 终端 | Terminal | ✅ |
| 浏览器 | Browser | ✅ |
| 系统设置 | System Settings | ✅ |
| 记事本 | Notepad | ✅ |
| 安全巡检 | Security Audit | ✅ |
| 包管理器 | Package Manager | ✅ |
| 磁盘分析 | Disk Analyzer | ✅ |
| 登录会话 | Login Sessions | ✅ |
| 端口监听 | Port Listener Manager | ✅ |
| 防火墙 | Firewall Manager | ✅ |
| 服务管理 | Service Manager | ✅ |
| 计划任务 | Scheduled Tasks | ✅ |
| 进程管理 | Process Manager | ✅ |
| 日志查看 | Log Viewer | ✅ |
| 容器管理 | Container Manager | ✅ |
| 搜索集群 | Search Cluster | ✅ |
| 网络诊断 | Network Diagnostics | ✅ |
| 系统监视器 | System Monitor | ✅ |
| 消息队列 | Message Queue | ✅ |
| API 调试 | API Debugger | ✅ |
| Git 仓库 | Git Repository Manager | ✅ |
| iptables 管理 | iptables Manager | ✅ |
| MinIO / S3 | MinIO / S3 Browser | ✅ |
| MongoDB | MongoDB Manager | ✅ |
| MySQL | MySQL Manager | ✅ |
| PostgreSQL | PostgreSQL Manager | ✅ |
| Redis | Redis Manager | ✅ |
| SQLite | SQLite Manager | ✅ |
| VNC Viewer | VNC Viewer | ✅ |
| Web 服务 | Web Server Manager | ✅ |

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
