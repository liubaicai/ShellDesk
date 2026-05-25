import { useEffect } from 'react';

export type AppLanguage = ShellDeskAppSettings['language'];

const chineseTextPattern = /[\u3400-\u9fff]/u;
const whitespacePattern = /^(\s*)([\s\S]*?)(\s*)$/u;
const translatableAttributes = ['aria-label', 'placeholder', 'title', 'alt'] as const;
const skippedTextSelector = [
  'script',
  'style',
  'textarea',
  'input',
  'pre',
  'code',
  'webview',
  '[contenteditable="true"]',
  '[data-i18n-skip]',
  '.xterm',
  '.xterm-screen',
  '.xterm-rows',
  '.terminal-screen',
  '.notepad-editor',
  '.settings-output',
].join(',');
const skippedAttributeSelector = [
  'script',
  'style',
  'webview',
  '[contenteditable="true"]',
  '[data-i18n-skip]',
  '.xterm',
  '.xterm-screen',
  '.xterm-rows',
  '.terminal-screen',
  '.notepad-editor',
].join(',');

const exactTranslations = new Map<string, string>(Object.entries({
  'ShellDesk': 'ShellDesk',
  '简体中文': 'Simplified Chinese',
  '常规': 'General',
  '语言、字体、视图': 'Language, fonts, views',
  '外观': 'Appearance',
  '主题、强调色、壁纸': 'Theme, accent, wallpaper',
  '终端': 'Terminal',
  '主题、字体、滚动': 'Theme, fonts, scrolling',
  '安全与存储': 'Security & Storage',
  '凭据与本地仓库': 'Credentials and local vault',
  '备份与导入': 'Backup & Import',
  '配置迁移': 'Configuration transfer',
  '设置': 'Settings',
  '设置分类': 'Settings categories',
  '应用行为': 'App Behavior',
  '语言': 'Language',
  '选择应用界面语言': 'Choose the app interface language',
  '界面字体': 'Interface font',
  '主机页默认视图': 'Default host view',
  '控制主机列表默认使用网格还是列表': 'Choose whether the host list opens as a grid or list',
  '网格': 'Grid',
  '列表': 'List',
  '本地库概览': 'Local Library Overview',
  '主机连接': 'Host connections',
  '当前已保存的 SSH 主机数量': 'Saved SSH hosts',
  'SSH 密钥': 'SSH keys',
  '已导入或生成的密钥对数量': 'Imported or generated key pairs',
  '浏览器书签': 'Browser bookmarks',
  '所有远程浏览器作用域下的书签总数': 'Total bookmarks across remote browser scopes',
  '界面主题': 'Interface Theme',
  '主题': 'Theme',
  '选择浅色、深色或跟随系统主题': 'Choose light, dark, or system theme',
  '☼ 浅色': '☼ Light',
  '▣ 系统': '▣ System',
  '☾ 深色': '☾ Dark',
  '浅色': 'Light',
  '深色': 'Dark',
  '暗色': 'Dark',
  '系统': 'System',
  '强调色': 'Accent Color',
  '主强调色': 'Primary accent color',
  '用于按钮、选中态、焦点边框和终端高亮': 'Used for buttons, selections, focus rings, and terminal highlights',
  '虚拟桌面壁纸': 'Virtual Desktop Wallpaper',
  '连接桌面背景': 'Connection desktop background',
  '作为连接服务器后的虚拟桌面壁纸；不设置时使用默认背景': 'Used as the virtual desktop wallpaper after connecting; the default background is used when unset',
  '自定义壁纸预览': 'Custom wallpaper preview',
  '默认壁纸预览': 'Default wallpaper preview',
  '自定义壁纸': 'Custom wallpaper',
  '默认背景': 'Default background',
  '上传图片': 'Upload image',
  '使用默认': 'Use default',
  '自定义图片': 'Custom image',
  '当前使用 ShellDesk 默认桌面背景': 'Currently using the default ShellDesk desktop background',
  '终端主题': 'Terminal Theme',
  '颜色主题': 'Color theme',
  '终端颜色预览': 'Terminal color preview',
  '字体与排版': 'Fonts & Typography',
  '字体族': 'Font family',
  '终端字号': 'Terminal font size',
  '影响 SSH Shell 中的字符大小': 'Controls character size in SSH shells',
  '行高': 'Line height',
  '行距越大，日志和长命令越容易扫读': 'Larger line spacing makes logs and long commands easier to scan',
  '常规字重': 'Regular weight',
  '控制普通输出的粗细': 'Controls the weight of regular output',
  '粗体字重': 'Bold weight',
  '控制 sudo 提示、强调文本和 ANSI 粗体': 'Controls sudo prompts, emphasized text, and ANSI bold text',
  '字体连字': 'Font ligatures',
  '对 Fira Code、JetBrains Mono 等字体启用编程连字': 'Enable programming ligatures for fonts such as Fira Code and JetBrains Mono',
  '光标与滚动': 'Cursor & Scrolling',
  '光标样式': 'Cursor style',
  '控制终端中的输入光标形态': 'Controls the terminal input cursor shape',
  '块状': 'Block',
  '竖线': 'Bar',
  '下划线': 'Underline',
  '失焦光标': 'Inactive cursor',
  '窗口失去焦点时的光标显示方式': 'Cursor style when the window loses focus',
  '描边': 'Outline',
  '隐藏': 'Hidden',
  '光标闪烁': 'Cursor blink',
  '关闭后光标保持静止，减少视觉干扰': 'Keeps the cursor still to reduce visual distraction',
  '滚动缓冲区': 'Scrollback',
  '保留更多历史输出会占用更多内存': 'Keeping more history uses more memory',
  '滚轮速度': 'Wheel speed',
  '控制普通滚动的速度倍率': 'Controls the normal scroll speed multiplier',
  '快速滚动速度': 'Fast scroll speed',
  '按住 Alt 滚轮时使用的速度倍率': 'Speed multiplier used while scrolling with Alt held',
  '输入时滚到底部': 'Scroll to bottom on input',
  '在查看历史输出时输入命令会自动回到最新位置': 'Typing while viewing history returns to the latest output',
  '清屏保留历史': 'Keep history on clear',
  '让 clear 等清屏动作把旧内容推入滚动历史': 'Moves cleared content into scrollback for commands like clear',
  '输入与辅助': 'Input & Accessibility',
  '选中即复制': 'Copy on select',
  '右键仍然保留粘贴 / 复制行为': 'Right click keeps paste/copy behavior',
  '右键粘贴': 'Right-click paste',
  '没有选中文本时，右键直接粘贴剪贴板内容': 'Paste clipboard content on right click when no text is selected',
  'Alt 单击移动光标': 'Alt-click moves cursor',
  '在支持的 Shell 编辑模式中快速定位输入光标': 'Quickly place the cursor in supported shell editing modes',
  '括号粘贴保护': 'Bracketed paste protection',
  '让支持的 Shell 能识别一次性粘贴内容，降低误执行风险': 'Lets supported shells recognize pasted blocks and reduce accidental execution',
  '最小对比度': 'Minimum contrast',
  '自动增强低对比输出文本': 'Automatically enhances low-contrast output text',
  '屏幕阅读器支持': 'Screen reader support',
  '启用后会增加辅助 DOM，可能略微影响高频输出性能': 'Adds accessibility DOM and may slightly affect high-frequency output',
  '敏感信息': 'Sensitive Information',
  '默认记住 SSH 密码': 'Remember SSH passwords by default',
  '影响连接弹窗里“连接成功后保存到此主机配置”的默认勾选': 'Controls the default save checkbox in the connection dialog',
  '默认记住密钥口令': 'Remember key passphrases by default',
  '影响密钥登录弹窗的默认保存行为': 'Controls the default save behavior for key logins',
  '存储状态': 'Storage Status',
  '本地保护方式': 'Local protection',
  '正在读取...': 'Reading...',
  '受保护': 'Protected',
  '文件权限保护': 'File-permission protection',
  '数据目录': 'Data directory',
  '普通配置与敏感 vault 统一放在同一目录，便于后续同步': 'Regular config and the sensitive vault share one directory for easier sync',
  '普通配置文件': 'Regular config file',
  '主机元数据、设置和书签': 'Host metadata, settings, and bookmarks',
  '敏感 vault 文件': 'Sensitive vault file',
  'SSH 密码、密钥口令和私钥内容': 'SSH passwords, key passphrases, and private keys',
  '私钥、密码和口令只写入敏感 vault；普通配置文件不包含这些字段，后续可单独作为云同步配置源。': 'Private keys, passwords, and passphrases are written only to the sensitive vault. The regular config file does not contain those fields and can later be used as a cloud-sync source.',
  '配置备份': 'Configuration Backup',
  '完整导出': 'Full export',
  '导出主机、密钥、设置和浏览器书签，包含密码、私钥内容与密钥口令。': 'Export hosts, keys, settings, and browser bookmarks, including passwords, private keys, and key passphrases.',
  '导出配置': 'Export config',
  '导入配置': 'Import config',
  '从完整备份恢复本地仓库，当前主机、密钥和书签会被导入内容替换。': 'Restore the local library from a full backup. Current hosts, keys, and bookmarks will be replaced.',
  '导出的 JSON 属于明文高敏备份，只适合放在你完全信任的位置；日常使用请依赖应用自身的本地加密仓库。': 'The exported JSON is a highly sensitive plaintext backup. Store it only in locations you fully trust; for daily use, rely on the app-local encrypted vault.',
  '处理中...': 'Processing...',
  '处理中': 'Processing',

  '主机': 'Hosts',
  '密钥': 'Keys',
  '日志': 'Logs',
  '功能导航': 'Feature navigation',
  '视图切换': 'View mode',
  '查找主机或快速连接（例如：ssh user@hostname -p 2222）': 'Search hosts or quick connect, for example: ssh user@hostname -p 2222',
  '连接中...': 'Connecting...',
  '连接': 'Connect',
  '+ 新建主机': '+ New Host',
  '全部主机': 'All Hosts',
  '共': 'Total',
  '分组': 'Groups',
  '新建主机': 'New Host',
  '正在读取主机分组...': 'Loading host groups...',
  '添加主机后会自动生成分组。': 'Groups will appear automatically after you add hosts.',
  '显示主机分组': 'Show host groups',
  '隐藏主机分组': 'Hide host groups',
  '刷新主机列表': 'Refresh host list',
  '正在读取主机列表': 'Loading host list',
  '正在从本地安全库载入已保存的 SSH 主机。': 'Loading saved SSH hosts from the local secure vault.',
  '请输入该主机的 SSH 密码后连接。': 'Enter this host\'s SSH password to connect.',
  '未分组': 'Ungrouped',
  '无标签': 'No tags',
  '就绪': 'Ready',
  '密钥登录': 'Key login',
  '密码已保存': 'Password saved',
  '主机操作': 'Host actions',
  '编辑': 'Edit',
  '删除': 'Delete',
  '没有匹配的主机': 'No matching hosts',
  '主机列表为空': 'Host list is empty',
  '清空搜索或切换分组后再试。': 'Clear the search or switch groups and try again.',
  '点击“新建主机”添加第一台 SSH 主机。': 'Click "New Host" to add your first SSH host.',
  '编辑主机': 'Edit Host',
  '保存到本地 Vault': 'Save to local vault',
  '关闭表单': 'Close form',
  '主机名称': 'Host name',
  '例如：Production Web': 'Example: Production Web',
  '地址': 'Address',
  '192.168.100.21 或 github.com': '192.168.100.21 or github.com',
  '用户名': 'Username',
  '端口': 'Port',
  '登录方式': 'Login method',
  '密码登录': 'Password login',
  '保存密码到主机信息': 'Save the password with this host',
  '选择密钥库中的已有密钥': 'Choose an existing key from the key vault',
  '选择密钥': 'Select key',
  '请选择已有密钥': 'Choose an existing key',
  '请先到“密钥”页面新建或导入密钥。': 'Create or import a key on the Keys page first.',
  '密码': 'Password',
  '输入并保存该主机密码': 'Enter and save this host password',
  '标签': 'Tags',
  '备注': 'Notes',
  '用途、跳板机、维护窗口等': 'Purpose, jump host, maintenance window, etc.',
  '保存修改': 'Save Changes',
  '添加主机': 'Add Host',
  '清空': 'Clear',
  '新建密钥': 'New Key',
  '新建 RSA 密钥': 'New RSA Key',
  '导入密钥对': 'Import Key Pair',
  '生成并保存到本地加密密钥库': 'Generate and save to the local encrypted key vault',
  '读取现有密钥文件并复制到本地加密密钥库': 'Read existing key files and copy them into the local encrypted key vault',
  '关闭密钥表单': 'Close key form',
  '密钥名称': 'Key name',
  '例如：Production Key': 'Example: Production Key',
  'RSA 位数': 'RSA bits',
  '私钥文件': 'Private key file',
  '请选择 SSH 私钥文件': 'Choose an SSH private key file',
  '选择文件': 'Choose File',
  '公钥文件（可选）': 'Public key file (optional)',
  '可选，默认尝试使用同名 .pub 文件': 'Optional. A same-name .pub file is tried by default',
  '算法': 'Algorithm',
  '指纹': 'Fingerprint',
  '未生成': 'Not generated',
  '保存的解锁口令（可选）': 'Saved unlock passphrase (optional)',
  '密钥口令（可选）': 'Key passphrase (optional)',
  '更新保存的解锁口令，不会重写私钥文件': 'Update the saved unlock passphrase without rewriting the private key file',
  '私钥加密时填写': 'Use when the private key is encrypted',
  '生成并保存': 'Generate and Save',
  '导入并保存': 'Import and Save',
  '连接凭据': 'Connection Credentials',
  '关闭连接凭据': 'Close connection credentials',
  '认证方式': 'Authentication method',
  '输入 SSH 登录密码': 'Enter the SSH login password',
  '使用密钥库中的私钥': 'Use a private key from the key vault',
  'SSH 密码': 'SSH password',
  '输入该主机的 SSH 密码': 'Enter this host\'s SSH password',
  '密钥口令（私钥加密时填写）': 'Key passphrase (for encrypted private keys)',
  '没有口令可留空': 'Leave blank if there is no passphrase',
  '连接成功后保存到此主机配置': 'Save to this host after connecting',
  '连接成功后保存密钥口令': 'Save key passphrase after connecting',
  '连接成功后记住本次密码': 'Remember this password after connecting',
  '取消': 'Cancel',
  '确认删除': 'Confirm Delete',

  '查找': 'Find',
  '查找密钥名称、算法或指纹': 'Search key name, algorithm, or fingerprint',
  '密钥列表': 'Key List',
  '本地生成': 'Generated locally',
  '导入复制': 'Imported copy',
  '已载入公钥': 'Public key loaded',
  '未提供公钥': 'No public key',
  '复制公钥': 'Copy public key',
  '没有匹配的密钥': 'No matching keys',
  '密钥列表为空': 'Key list is empty',
  '清空搜索后再试。': 'Clear the search and try again.',
  '点击“新建 RSA 密钥”或“导入密钥对”添加第一把 SSH 密钥。': 'Click "New RSA Key" or "Import Key Pair" to add your first SSH key.',

  '搜索': 'Search',
  '搜索日志内容...': 'Search log content...',
  '清空日志': 'Clear Logs',
  '类别': 'Category',
  '级别': 'Level',
  '全部': 'All',
  '成功': 'Success',
  '警告': 'Warning',
  '错误': 'Error',
  '没有匹配的日志': 'No matching logs',
  '暂无日志': 'No logs yet',
  '清空搜索条件或切换筛选器后再试。': 'Clear the search or switch filters and try again.',
  '连接、密钥和操作日志会自动记录在这里。': 'Connection, key, and operation logs are recorded here automatically.',

  '文件管理': 'File Manager',
  'Windows 风格 SFTP 资源管理器': 'Windows-style SFTP explorer',
  '交互式 SSH Shell': 'Interactive SSH shell',
  '记事本': 'Notepad',
  '远程文件编辑器': 'Remote file editor',
  '浏览器': 'Browser',
  '远程源请求': 'Remote-origin requests',
  '连接本机或内网 VNC 桌面': 'Connect to local or intranet VNC desktops',
  '日志查看': 'Log Viewer',
  '系统监视器': 'System Monitor',
  '服务器状态': 'Server status',
  'MySQL 数据库管理': 'MySQL database management',
  'Redis 数据库管理': 'Redis database management',
  '服务管理': 'Service Manager',
  '容器管理': 'Container Manager',
  'Docker / Podman 容器与镜像': 'Docker / Podman containers and images',
  '端口监听': 'Port Listener',
  '端口占用与连接状态': 'Port usage and connection status',
  '防火墙': 'Firewall',
  '网络诊断': 'Network Diagnostics',
  '磁盘分析': 'Disk Analyzer',
  '空间占用与大文件定位': 'Space usage and large-file discovery',
  '包管理器': 'Package Manager',
  '系统软件包查询与更新': 'System package search and updates',
  '计划任务': 'Scheduled Tasks',
  'Cron / systemd timer / Task Scheduler': 'Cron / systemd timer / Task Scheduler',
  'PostgreSQL 数据库管理': 'PostgreSQL database management',
  '安全巡检': 'Security Audit',
  'SSH、端口、登录与权限检查': 'SSH, port, login, and permission checks',
  '登录会话': 'Login Sessions',
  '在线用户、成功与失败登录': 'Online users, successful logins, and failed logins',
  'API 调试': 'API Debugger',
  '从远程主机发起 HTTP 请求': 'Send HTTP requests from the remote host',
  '进程管理': 'Process Manager',
  '进程查看、搜索和终止': 'View, search, and terminate processes',
  '系统设置': 'System Settings',
  '网络、镜像源、更新、Hosts、路由、磁盘': 'Network, mirrors, updates, Hosts, routes, disks',
  'SQLite 数据库查看与编辑': 'View and edit SQLite databases',
  '自定义': 'Custom',
  '名称 A-Z': 'Name A-Z',
  '名称 Z-A': 'Name Z-A',
  '桌面应用': 'Desktop apps',
  '窗口控制': 'Window controls',
  '终端工具': 'Terminal tools',
  '最小化窗口': 'Minimize window',
  '最小化': 'Minimize',
  '还原窗口': 'Restore window',
  '最大化窗口': 'Maximize window',
  '还原': 'Restore',
  '最大化': 'Maximize',
  '关闭窗口': 'Close window',
  '关闭': 'Close',
  '远程桌面 Dock': 'Remote desktop Dock',
  '全部应用': 'All Apps',
  '关闭全部应用': 'Close all apps',
  '重命名文件夹': 'Rename Folder',
  '关闭文件夹': 'Close folder',
  '将组件拖到这里': 'Drag components here',
  '发送到桌面': 'Send to Desktop',
  '删除文件夹': 'Delete Folder',
  '新建文件夹': 'New Folder',
  '排序': 'Sort',
  '桌面排序方式': 'Desktop sort order',
  '新建终端窗口': 'New terminal window',
  '搜索输出': 'Search output',
  '清屏': 'Clear screen',
  '切换自动跟随': 'Toggle auto-follow',
  '滚动到底部': 'Scroll to bottom',
  '重新创建会话': 'Recreate session',
  '终端设置': 'Terminal Settings',
  '关闭终端窗口': 'Close Terminal Window',
  '该终端会话仍在运行，关闭窗口会结束当前 Shell。': 'This terminal session is still running. Closing the window will end the current shell.',

  '文件': 'File',
  '文件夹': 'Folder',
  '新建文件': 'New File',
  '上传': 'Upload',
  '下载': 'Download',
  '另存为': 'Save As',
  '复制路径': 'Copy Path',
  '在终端中打开': 'Open in Terminal',
  '返回上级目录': 'Go to Parent',
  '根目录': 'Root',
  '大小': 'Size',
  '修改时间': 'Modified',
  '访问时间': 'Accessed',
  '类型': 'Type',
  '路径': 'Path',
  '只读': 'Read-only',
  '打开地址': 'Open Address',
  '后退': 'Back',
  '前进': 'Forward',
  '首页': 'Home',
  '收藏当前页': 'Bookmark Current Page',
  '编辑当前页书签': 'Edit Current Bookmark',
  '浏览器菜单': 'Browser menu',
  '空白页': 'Blank Page',
  '查询': 'Query',
  '查询历史': 'Query History',
  '对象浏览': 'Object Browser',
  '数据库管理': 'Database Management',
  '执行': 'Run',
  '执行中...': 'Running...',
  '执行中': 'Running',
  '结果': 'Results',
  '状态': 'Status',
  '操作': 'Actions',
  '命令': 'Command',
  '命令行': 'Command line',
  '复制命令': 'Copy Command',
  '已复制命令。': 'Command copied.',
  '格式化 JSON': 'Format JSON',
  '该语句没有返回表格数据。': 'This statement did not return tabular data.',
  '空查询': 'Empty Query',
  '刷新中': 'Refreshing',
  '未知': 'Unknown',
  '未知系统': 'Unknown system',
  '不支持': 'Unsupported',
  '未就绪': 'Not ready',
  '未就绪。': 'Not ready.',
  '读取中': 'Reading',
  '加载中...': 'Loading...',
  '检测': 'Check',
  '检测中': 'Checking',
  '检测中...': 'Checking...',
  '启用': 'Enable',
  '禁用': 'Disable',
  '启动': 'Start',
  '停止': 'Stop',
  '已停止': 'Stopped',
  '已断开': 'Disconnected',
  '已连接': 'Connected',
  '运行': 'Run',
  '运行中': 'Running',
  '失败': 'Failed',
  '拒绝': 'Reject',
  '拒收': 'Reject',
  '允许': 'Allow',
  '监听': 'Listening',
  '监听端口': 'Listening port',
  '用户': 'User',
  '主机名': 'Hostname',
  '网络': 'Network',
  '系统信息': 'System Information',
  '网络信息': 'Network Information',
  'DNS 配置': 'DNS Configuration',
  '网络接口': 'Network Interfaces',
  '系统语言': 'System language',
  '时区': 'Time zone',
  '系统架构': 'Architecture',
  '内核版本': 'Kernel version',
  '运行时间': 'Uptime',
  '系统负载': 'System load',
  '当前用户': 'Current user',
  '操作系统': 'Operating system',
  '内存': 'Memory',
  '可用': 'Available',
  '空闲': 'Free',
  '缓存': 'Cache',
  '共享': 'Shared',
  '逻辑 CPU': 'Logical CPU',
  '物理核心': 'Physical cores',
  '线程 / 核心': 'Threads / core',
  'CPU 插槽': 'CPU sockets',
  'CPU 信息': 'CPU information',
  '远程主机': 'Remote host',
  'Windows 主机': 'Windows host',
  '磁盘和挂载点': 'Disks and Mount Points',
  '磁盘和卷': 'Disks and Volumes',
  '磁盘使用情况': 'Disk usage',
  '块设备信息': 'Block devices',
  '挂载点': 'Mount points',
  '本地磁盘': 'Local disks',
  '卷信息': 'Volume information',
  '路由管理': 'Route Management',
  '路由表': 'Routing Table',
  '添加路由': 'Add Route',
  '删除路由': 'Delete Route',
  '目标网段 (如 10.0.0.0/8)': 'Destination network (for example 10.0.0.0/8)',
  '网关 (可选)': 'Gateway (optional)',
  '接口 (可选)': 'Interface (optional)',
  '预览添加': 'Preview Add',
  '预览删除': 'Preview Delete',
  '预览并应用': 'Preview and Apply',
  '预览并保存': 'Preview and Save',
  '变更预览': 'Change Preview',
  'Hosts 管理': 'Hosts Management',
  '快速添加': 'Quick Add',
  '新增映射': 'New Mapping',
  'IP 地址': 'IP address',
  '添加': 'Add',
  '/etc/hosts 内容': '/etc/hosts content',
  '编辑 /etc/hosts': 'Edit /etc/hosts',
  '编辑 hosts': 'Edit hosts',
  '保存 hosts': 'Save hosts',
  '刷新': 'Refresh',
  '保存中...': 'Saving...',
  '应用中...': 'Applying...',
  '清除草稿': 'Clear Draft',
  '系统更新': 'System Updates',
  '检查更新': 'Check Updates',
  '一键升级': 'Upgrade All',
  '可升级软件包': 'Upgradeable Packages',
  '执行输出': 'Run Output',
  '包安装': 'Package installation',
  '安装': 'Install',
  '可升级': 'Upgradeable',
  '服务': 'Services',
  '进程': 'Processes',
  '进程详情': 'Process Details',
  '结束进程': 'End Process',
  '结束任务': 'End Task',
  '连接失败': 'Connection Failed',
  '连接窗口不可用': 'Connection window unavailable',
  '正在打开连接窗口': 'Opening connection window',
  '正在读取 SSH 连接信息。': 'Reading SSH connection information.',
}));

const patternTranslations: Array<[RegExp, (...matches: string[]) => string]> = [
  [/^(\d+) 项$/u, (count) => `${count} items`],
  [/^(\d+) 个组件$/u, (count) => `${count} components`],
  [/^(\d+) 个密钥$/u, (count) => `${count} keys`],
  [/^共 (\d+) 个主机$/u, (count) => `${count} hosts total`],
  [/^(\d+) 行$/u, (count) => `${Number(count).toLocaleString('en-US')} lines`],
  [/^打开(.+)$/u, (name) => `Open ${name}`],
  [/^切换到(.+)$/u, (name) => `Switch to ${name}`],
  [/^还原(.+)$/u, (name) => `Restore ${name}`],
  [/^连接失败：(.+)$/u, (name) => `Connection failed: ${name}`],
  [/^读取本地凭据失败：(.+)$/u, (message) => `Failed to read local credentials: ${translateText(message, 'en-US')}`],
  [/^读取本地数据失败：(.+)$/u, (message) => `Failed to read local data: ${translateText(message, 'en-US')}`],
  [/^保存本地数据失败：(.+)$/u, (message) => `Failed to save local data: ${translateText(message, 'en-US')}`],
  [/^刷新主机列表失败：(.+)$/u, (message) => `Failed to refresh hosts: ${translateText(message, 'en-US')}`],
  [/^已刷新 (\d+) 台主机。$/u, (count) => `Refreshed ${count} hosts.`],
  [/^正在连接 (.+)\.\.\.$/u, (name) => `Connecting to ${name}...`],
  [/^已连接：(.+)$/u, (name) => `Connected: ${name}`],
  [/^已打开连接窗口：(.+)$/u, (name) => `Opened connection window: ${name}`],
  [/^连接断开：(.+)$/u, (name) => `Disconnected: ${name}`],
  [/^连接成功：(.+)$/u, (name) => `Connection succeeded: ${name}`],
  [/^连接失败：(.+)$/u, (name) => `Connection failed: ${name}`],
  [/^已添加主机：(.+)$/u, (name) => `Added host: ${name}`],
  [/^已更新主机：(.+)$/u, (name) => `Updated host: ${name}`],
  [/^已删除主机：(.+)$/u, (name) => `Deleted host: ${name}`],
  [/^添加主机：(.+)$/u, (name) => `Add host: ${name}`],
  [/^更新主机：(.+)$/u, (name) => `Update host: ${name}`],
  [/^删除主机：(.+)$/u, (name) => `Delete host: ${name}`],
  [/^已生成密钥：(.+)$/u, (name) => `Generated key: ${name}`],
  [/^已导入密钥：(.+)$/u, (name) => `Imported key: ${name}`],
  [/^已更新密钥：(.+)$/u, (name) => `Updated key: ${name}`],
  [/^已删除密钥：(.+)$/u, (name) => `Deleted key: ${name}`],
  [/^生成密钥：(.+)$/u, (name) => `Generate key: ${name}`],
  [/^导入密钥：(.+)$/u, (name) => `Import key: ${name}`],
  [/^更新密钥：(.+)$/u, (name) => `Update key: ${name}`],
  [/^删除密钥：(.+)$/u, (name) => `Delete key: ${name}`],
  [/^已复制公钥：(.+)$/u, (name) => `Copied public key: ${name}`],
  [/^复制失败：(.+)$/u, (message) => `Copy failed: ${translateText(message, 'en-US')}`],
  [/^密钥「(.+)」当前没有可复制的公钥。$/u, (name) => `Key "${name}" has no public key to copy.`],
  [/^确认删除主机「(.+)」？$/u, (name) => `Delete host "${name}"?`],
  [/^确认删除密钥「(.+)」？$/u, (name) => `Delete key "${name}"?`],
  [/^确认删除密钥「(.+)」？(\d+) 台主机正在使用该密钥，删除后会切换为密码登录。$/u, (name, count) => `Delete key "${name}"? ${count} hosts use this key and will switch to password login.`],
  [/^当前使用密钥登录：(.+)$/u, (name) => `Using key login: ${name}`],
  [/^当前使用私钥文件：(.+)$/u, (path) => `Using private key file: ${path}`],
  [/^已导出 (\d+) 台主机、(\d+) 把密钥和 (\d+) 条书签。$/u, (hosts, keys, bookmarks) => `Exported ${hosts} hosts, ${keys} keys, and ${bookmarks} bookmarks.`],
  [/^已导入 (\d+) 台主机、(\d+) 把密钥和 (\d+) 条书签。$/u, (hosts, keys, bookmarks) => `Imported ${hosts} hosts, ${keys} keys, and ${bookmarks} bookmarks.`],
  [/^(\d+) 台主机、(\d+) 把密钥、(\d+) 条书签$/u, (hosts, keys, bookmarks) => `${hosts} hosts, ${keys} keys, ${bookmarks} bookmarks`],
  [/^(\d+) 台主机、(\d+) 把密钥$/u, (hosts, keys) => `${hosts} hosts, ${keys} keys`],
  [/^导出失败：(.+)$/u, (message) => `Export failed: ${translateText(message, 'en-US')}`],
  [/^导入失败：(.+)$/u, (message) => `Import failed: ${translateText(message, 'en-US')}`],
  [/^(.+) 台主机已切换为密码登录$/u, (count) => `${count} hosts switched to password login`],
  [/^已读取 (\d+) 个系统字体$/u, (count) => `Loaded ${count} system fonts`],
  [/^使用备用字体列表：(.+)$/u, (message) => `Using fallback font list: ${translateText(message, 'en-US')}`],
  [/^选择颜色 (.+)$/u, (color) => `Choose color ${color}`],
  [/^已用 (.+)%$/u, (value) => `${value}% used`],
  [/^已添加：(.+)$/u, (value) => `Added: ${value}`],
  [/^已添加 (.+)，点击保存后生效。$/u, (value) => `Added ${value}; save to apply.`],
  [/^已添加路由：(.+)$/u, (value) => `Added route: ${value}`],
  [/^已删除路由：(.+)$/u, (value) => `Deleted route: ${value}`],
];

const phraseTranslations: Array<[string, string]> = Object.entries({
  '请输入合法 SSH 命令，例如 ssh user@host、ssh -p 2222 user@host 或 user@host。': 'Enter a valid SSH command, such as ssh user@host, ssh -p 2222 user@host, or user@host.',
  '当前运行环境不支持连接窗口。': 'The current runtime does not support connection windows.',
  '当前运行环境不支持 SSH 连接。': 'The current runtime does not support SSH connections.',
  '当前运行环境不支持导出配置。': 'The current runtime does not support config export.',
  '当前运行环境不支持导入配置。': 'The current runtime does not support config import.',
  '当前运行环境不支持安全密钥库。': 'The current runtime does not support the secure key vault.',
  '该主机未选择有效密钥。': 'This host does not have a valid key selected.',
  '请输入 SSH 密码。': 'Enter the SSH password.',
  '请选择 SSH 密钥。': 'Choose an SSH key.',
  '导入文件中没有可用配置。': 'The imported file contains no usable configuration.',
  '操作失败。': 'Operation failed.',
  '请输入密钥名称。': 'Enter a key name.',
  '密钥信息长度超出限制。': 'Key information exceeds the length limit.',
  '请选择私钥文件。': 'Choose a private key file.',
  '密钥文件路径过长。': 'The key file path is too long.',
  'RSA 位数无效。': 'RSA bit length is invalid.',
  '请输入主机名称。': 'Enter a host name.',
  '请输入主机地址。': 'Enter a host address.',
  '请输入用户名。': 'Enter a username.',
  '端口必须是 1 到 65535 之间的整数。': 'Port must be an integer from 1 to 65535.',
  '主机名称不能超过 80 个字符。': 'Host name cannot exceed 80 characters.',
  '主机地址不能超过 255 个字符。': 'Host address cannot exceed 255 characters.',
  '用户名不能超过 128 个字符。': 'Username cannot exceed 128 characters.',
  '选择密钥登录时需要选择已有密钥。': 'Choose an existing key when using key login.',
  '密码长度不能超过 4096 个字符。': 'Password cannot exceed 4096 characters.',
  '图片不能超过 5 MB。': 'Image size cannot exceed 5 MB.',
  '请选择 PNG、JPG、WebP 或 GIF 图片。': 'Choose a PNG, JPG, WebP, or GIF image.',
  '图片读取失败。': 'Failed to read image.',
  '当前运行环境未提供系统字体接口。': 'The current runtime does not provide the system font API.',
  '系统未返回可用字体。': 'The system returned no available fonts.',
  '正在读取系统字体列表': 'Reading system font list',
  '备份文件为空或超过大小限制。': 'The backup file is empty or exceeds the size limit.',
  '普通配置写入 config.json，密码和私钥已使用系统凭据加密保存到 vault.json': 'Regular config is written to config.json. Passwords and private keys are encrypted with system credentials and saved to vault.json.',
  '普通配置写入 config.json，当前系统不支持加密，敏感 vault 改为本地文件权限保护': 'Regular config is written to config.json. This system does not support encryption, so the sensitive vault falls back to local file-permission protection.',
  'systemd / Windows Services': 'systemd / Windows Services',
  'ufw / firewalld / Windows Firewall': 'ufw / firewalld / Windows Firewall',
  'Ping / DNS / HTTP / TCP': 'Ping / DNS / HTTP / TCP',
  'journalctl / /var/log / Event Log': 'journalctl / /var/log / Event Log',
  '名称': 'Name',
  '主机地址': 'Host address',
  '主机名称': 'Host name',
  '主机分组': 'Host groups',
  '主机列表': 'Host list',
  '主机信息': 'Host information',
  '主机标签': 'Host tags',
  '主机连接': 'Host connections',
  '主机登录方式': 'Host login method',
  '密钥口令': 'Key passphrase',
  '密钥名称': 'Key name',
  '密钥指纹': 'Key fingerprint',
  '密钥算法': 'Key algorithm',
  '密钥登录': 'Key login',
  '密码登录': 'Password login',
  '密码已保存': 'Password saved',
  '口令已保存': 'Passphrase saved',
  '连接失败': 'Connection failed',
  '连接成功': 'Connection succeeded',
  '连接断开': 'Connection closed',
  '连接窗口': 'Connection window',
  '配置文件': 'Config file',
  '导出配置': 'Export config',
  '导入配置': 'Import config',
  '生成密钥': 'Generate key',
  '导入密钥': 'Import key',
  '更新密钥': 'Update key',
  '删除密钥': 'Delete key',
  '添加主机': 'Add host',
  '更新主机': 'Update host',
  '删除主机': 'Delete host',
  '远程主机': 'Remote host',
  '远程桌面': 'Remote desktop',
  '远程文件': 'Remote file',
  '本地': 'Local',
  '普通': 'Regular',
  '敏感': 'Sensitive',
  '保存': 'Save',
  '取消': 'Cancel',
  '关闭': 'Close',
  '打开': 'Open',
  '删除': 'Delete',
  '编辑': 'Edit',
  '刷新': 'Refresh',
  '搜索': 'Search',
  '查找': 'Find',
  '复制': 'Copy',
  '下载': 'Download',
  '上传': 'Upload',
  '启动': 'Start',
  '停止': 'Stop',
  '禁用': 'Disable',
  '启用': 'Enable',
  '执行': 'Run',
  '检测': 'Check',
  '加载中': 'Loading',
  '处理中': 'Processing',
  '正在读取': 'Reading',
  '正在': '',
  '已': '',
  '未': 'Not ',
  '无': 'No',
  '未知': 'Unknown',
  '失败': 'failed',
  '成功': 'succeeded',
  '警告': 'Warning',
  '错误': 'Error',
  '信息': 'Info',
  '系统': 'System',
  '网络': 'Network',
  '文件夹': 'Folder',
  '文件': 'File',
  '目录': 'Directory',
  '路径': 'Path',
  '大小': 'Size',
  '类型': 'Type',
  '状态': 'Status',
  '用户': 'User',
  '端口': 'Port',
  '地址': 'Address',
  '服务': 'Service',
  '进程': 'Process',
  '命令': 'Command',
  '结果': 'Result',
  '操作': 'Action',
  '来源': 'Source',
  '目标': 'Target',
  '时间': 'Time',
  '标签': 'Tags',
  '备注': 'Notes',
  '分组': 'Group',
  '条书签': 'bookmarks',
  '把密钥': 'keys',
  '台主机': 'hosts',
  '个主机': 'hosts',
  '个密钥': 'keys',
  '个项目': 'items',
  '个字符': 'characters',
  '个': '',
  '项': 'items',
  '行': 'lines',
}).sort((left, right) => right[0].length - left[0].length);

const textOriginals = new WeakMap<Text, string>();
const attributeOriginals = new WeakMap<Element, Map<string, string>>();
let sortedReplacementTranslations: Array<[string, string]> | null = null;

export function getSystemLanguage(): AppLanguage {
  const locales = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ].filter(Boolean);

  return locales.some((locale) => /^zh\b|^zh-/i.test(locale)) ? 'zh-CN' : 'en-US';
}

export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === 'zh-CN' || value === 'en-US' ? value : getSystemLanguage();
}

export function getAppLocale(language: AppLanguage) {
  return language === 'zh-CN' ? 'zh-CN' : 'en-US';
}

function getSortedReplacementTranslations() {
  if (sortedReplacementTranslations) {
    return sortedReplacementTranslations;
  }

  const replacements = new Map<string, string>();

  for (const [source, target] of exactTranslations) {
    replacements.set(source, target);
  }

  for (const [source, target] of phraseTranslations) {
    replacements.set(source, target);
  }

  sortedReplacementTranslations = Array.from(replacements.entries()).sort((left, right) => right[0].length - left[0].length);
  return sortedReplacementTranslations;
}

export function translateText(value: string, language: AppLanguage) {
  if (language === 'zh-CN' || !chineseTextPattern.test(value)) {
    return value;
  }

  const match = whitespacePattern.exec(value);
  const leading = match?.[1] ?? '';
  const content = match?.[2] ?? value;
  const trailing = match?.[3] ?? '';

  if (!content) {
    return value;
  }

  const exact = exactTranslations.get(content);
  if (exact) {
    return `${leading}${exact}${trailing}`;
  }

  for (const [pattern, translate] of patternTranslations) {
    const patternMatch = pattern.exec(content);

    if (patternMatch) {
      return `${leading}${translate(...patternMatch.slice(1))}${trailing}`;
    }
  }

  let translated = content;

  for (const [source, target] of getSortedReplacementTranslations()) {
    translated = translated.split(source).join(target);
  }

  return `${leading}${translated}${trailing}`;
}

function shouldSkipTextElement(element: Element | null) {
  return Boolean(element?.closest(skippedTextSelector));
}

function shouldSkipAttributeElement(element: Element | null) {
  return Boolean(element?.closest(skippedAttributeSelector));
}

function translateTextNode(node: Text, language: AppLanguage) {
  const parent = node.parentElement;

  if (!parent || shouldSkipTextElement(parent)) {
    return;
  }

  const currentValue = node.nodeValue ?? '';
  const storedOriginal = textOriginals.get(node);
  const currentStoredTranslation = storedOriginal ? translateText(storedOriginal, 'en-US') : '';
  let original = storedOriginal;

  if (!original || (language === 'en-US' && currentValue !== currentStoredTranslation && chineseTextPattern.test(currentValue))) {
    original = currentValue;
    textOriginals.set(node, original);
  }

  if (!original) {
    return;
  }

  const nextValue = language === 'zh-CN' ? original : translateText(original, language);

  if (currentValue !== nextValue) {
    node.nodeValue = nextValue;
  }
}

function getElementAttributeOriginals(element: Element) {
  const existing = attributeOriginals.get(element);

  if (existing) {
    return existing;
  }

  const next = new Map<string, string>();
  attributeOriginals.set(element, next);
  return next;
}

function translateElementAttributes(element: Element, language: AppLanguage) {
  if (shouldSkipAttributeElement(element)) {
    return;
  }

  const originals = getElementAttributeOriginals(element);

  for (const attributeName of translatableAttributes) {
    const currentValue = element.getAttribute(attributeName);

    if (!currentValue) {
      originals.delete(attributeName);
      continue;
    }

    const storedOriginal = originals.get(attributeName);
    const currentStoredTranslation = storedOriginal ? translateText(storedOriginal, 'en-US') : '';
    let original = storedOriginal;

    if (!original || (language === 'en-US' && currentValue !== currentStoredTranslation && chineseTextPattern.test(currentValue))) {
      original = currentValue;
      originals.set(attributeName, original);
    }

    if (!original) {
      continue;
    }

    const nextValue = language === 'zh-CN' ? original : translateText(original, language);

    if (currentValue !== nextValue) {
      element.setAttribute(attributeName, nextValue);
    }
  }
}

function translateTree(root: Node, language: AppLanguage) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text, language);
    return;
  }

  if (!(root instanceof Element)) {
    return;
  }

  translateElementAttributes(root, language);

  if (shouldSkipTextElement(root)) {
    return;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();

  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      translateTextNode(current as Text, language);
    } else if (current instanceof Element) {
      translateElementAttributes(current, language);
    }

    current = walker.nextNode();
  }
}

export function useShellDeskI18n(language: AppLanguage) {
  useEffect(() => {
    const appLanguage = normalizeAppLanguage(language);
    document.documentElement.lang = getAppLocale(appLanguage);
    document.documentElement.setAttribute('data-language', appLanguage);

    if (document.body) {
      translateTree(document.body, appLanguage);
    }
  });

  useEffect(() => {
    const appLanguage = normalizeAppLanguage(language);
    document.documentElement.lang = getAppLocale(appLanguage);
    document.documentElement.setAttribute('data-language', appLanguage);

    if (!document.body) {
      return undefined;
    }

    translateTree(document.body, appLanguage);

    let flushTimer = 0;
    const pendingNodes = new Set<Node>();

    const flushPendingNodes = () => {
      flushTimer = 0;

      for (const node of pendingNodes) {
        translateTree(node, appLanguage);
      }

      pendingNodes.clear();
    };

    const scheduleNode = (node: Node) => {
      pendingNodes.add(node);

      if (!flushTimer) {
        flushTimer = window.setTimeout(flushPendingNodes, 0);
      }
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          scheduleNode(mutation.target);
          continue;
        }

        if (mutation.type === 'attributes') {
          scheduleNode(mutation.target);
          continue;
        }

        mutation.addedNodes.forEach(scheduleNode);
      }
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: [...translatableAttributes],
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();

      if (flushTimer) {
        window.clearTimeout(flushTimer);
      }
    };
  }, [language]);
}
