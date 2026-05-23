# MinIO / S3 浏览器功能设计与开发计划

## 定位

MinIO / S3 浏览器用于浏览对象存储 bucket 和对象，适合管理自建 MinIO、内网 S3 兼容服务或云对象存储。它补充文件管理器，处理对象存储而非传统文件系统。

## 目标用户场景

- 查看 bucket 列表。
- 浏览对象前缀。
- 上传、下载、删除对象。
- 复制对象路径或预签名链接。
- 查看对象大小、修改时间、Content-Type。

## 首版功能范围

- 连接：
  - endpoint、accessKey、secretKey、region、是否 path-style。
- 浏览：
  - bucket 列表。
  - prefix 对象列表。
  - 搜索当前 prefix。
- 操作：
  - 上传本地文件作为后续。
  - 下载对象。
  - 删除对象。
  - 复制对象 URL。

首版如果不新增 S3 SDK，可以先支持远程 `mc` 或 `aws` CLI。

## 交互设计

界面类似文件管理器：

- 左侧 bucket 列表。
- 顶部 prefix 面包屑。
- 主区域对象表格。
- 右侧对象详情。

密钥输入默认遮蔽。删除对象必须确认。

## 数据模型

```ts
interface S3ConnectionConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region?: string;
  pathStyle: boolean;
}

interface S3ObjectEntry {
  key: string;
  name: string;
  size?: number;
  lastModified?: string;
  type: 'prefix' | 'object';
  contentType?: string;
}
```

## 实现方案

方案 A：远程 CLI MVP。

- MinIO Client：`mc ls`、`mc cp`、`mc rm`。
- AWS CLI：`aws s3 ls`、`aws s3 cp`、`aws s3 rm`。
- 优点：不新增本地依赖。
- 缺点：依赖远程工具安装和配置。

方案 B：主进程 S3 SDK。

- 新增 `@aws-sdk/client-s3`。
- 凭证保存在本地 vault。
- 支持直接从本机访问 endpoint，不一定经过远程网络。

首版建议 A，后续 B。

## IPC 与代码落点

首版复用 `runCommand`，通过远程 CLI 操作。若走 SDK，需要新增 vault 凭证保存和主进程 IPC。

文件建议：

- `src/components/remote-desktop/RemoteS3Browser.tsx`
- `src/components/remote-desktop/s3CliParsers.ts`
- `src/styles/remote-desktop/_s3-browser.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现 CLI 模式选择：mc/aws。
2. 实现连接配置和工具检测。
3. 实现 bucket 列表。
4. 实现对象列表和 prefix 导航。
5. 实现删除和复制 URL。
6. 实现下载对象路径到远程临时位置或本地下载方案评估。
7. 评估 SDK 模式。

## 验收标准

- 安装 mc 或 aws 的远程主机能列出 bucket。
- 能浏览 prefix。
- 删除对象前必须确认。
- 凭证输入默认遮蔽。
- CLI 错误能显示原始输出。

## 后续增强

- 本地上传/下载。
- 预签名链接。
- SDK 直连模式。
- 对象元数据编辑。
