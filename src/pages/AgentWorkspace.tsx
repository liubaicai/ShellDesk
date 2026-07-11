import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import {
  Bot,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Circle,
  Command,
  Laptop,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  SendHorizontal,
  Settings,
  SquarePen,
  TerminalSquare,
  Wrench,
  X,
} from 'lucide-react';

import { completeAiRequest, createSharedTools, getDefaultChatPrompt, usePiAgent, type AiMessage } from '../ai';
import { createAgentWorkspaceTools, type AgentWorkspaceConnectionResult, type AgentWorkspaceHost } from '../ai/agentWorkspaceTools';
import { MarkdownMessage } from '../components/remote-desktop/RemoteAiChat';
import { getErrorMessage } from '../components/remote-desktop/desktopUtils';
import type { AppLanguage } from '../i18n';

interface AgentWorkspaceProps {
  hosts: AgentWorkspaceHost[];
  settings: ShellDeskAppSettings;
  language: AppLanguage;
  onOpenSettings: () => void;
  onReturnToHostManagement: () => void;
}

interface AgentConversationSession {
  id: string;
  title: string;
  messages: AiMessage[];
  createdAt: string;
  updatedAt: string;
}

interface AgentModelOption {
  id: string;
  name: string;
}

function getBuiltinAgentModelOptions(settings: ShellDeskAppSettings): AgentModelOption[] {
  const providerId = settings.aiProvider === 'anthropic' || settings.aiApiFormat === 'anthropic'
    ? 'anthropic'
    : settings.aiProvider === 'openai' ? 'openai' : undefined;
  return builtinModels().getModels(providerId).map((model) => ({ id: model.id, name: model.name || model.id }));
}

function createTaskSession(language: AppLanguage): AgentConversationSession {
  const now = new Date().toISOString();
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: language === 'zh-CN' ? '新建任务' : 'New task',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function fromStoredSession(session: ShellDeskAgentSession): AgentConversationSession {
  return {
    id: session.id,
    title: session.title,
    messages: session.messages.map((message) => ({ ...message })),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toStoredSession(session: AgentConversationSession, kind: ShellDeskAgentSession['kind'], hostId?: string): ShellDeskAgentSession {
  return {
    id: session.id,
    kind,
    ...(hostId ? { hostId } : {}),
    title: session.title,
    messages: session.messages
      .filter((message): message is AiMessage & { role: 'user' | 'assistant' } => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ ...message })),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function getSessionTitle(messages: AiMessage[], fallback: string) {
  const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim();
  if (!firstUserMessage) return fallback;
  const normalized = firstUserMessage.replace(/\s+/g, ' ').replace(/[。！？.!?]+$/u, '');
  return normalized.slice(0, 24) || fallback;
}

function getGeneratedTaskTitle(value: string, fallback: string) {
  const title = value
    .split(/\r?\n/u, 1)[0]
    .replace(/^\s*(?:标题|任务标题|task title)\s*[:：-]?\s*/iu, '')
    .replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return title.slice(0, 24) || fallback;
}

function sameMessages(first: AiMessage[], second: AiMessage[]) {
  return first.length === second.length && first.every((message, index) => (
    message.id === second[index]?.id && message.content === second[index]?.content
  ));
}

function getCopy(language: AppLanguage) {
  const zh = language === 'zh-CN';

  return {
    title: 'SD-Agent',
    returnToHostManagement: zh ? '返回主机管理' : 'Back to host management',
    newTask: zh ? '新建任务' : 'New task',
    tasks: zh ? '任务' : 'Tasks',
    showMoreTasks: zh ? '展开更多' : 'Show more',
    showFewerTasks: zh ? '收起' : 'Show fewer',
    hosts: zh ? '主机' : 'Hosts',
    connected: zh ? '已连接' : 'Connected',
    connect: zh ? '连接' : 'Connect',
    connecting: zh ? '正在连接…' : 'Connecting…',
    disconnect: zh ? '断开' : 'Disconnect',
    emptyHosts: zh ? '还没有保存的主机' : 'No saved hosts yet',
    emptyHostsDetail: zh ? '在主窗口添加主机后，它会显示在这里。' : 'Add a host in the main window and it will appear here.',
    welcome: zh ? '今天想完成什么工作？' : 'What would you like to work on?',
    welcomeHost: zh ? '已选择 {host}，我可以在这台主机上协助你。' : '{host} is selected. I can help you work on it.',
    explore: zh ? '巡检主机' : 'Inspect host',
    exploreDetail: zh ? '系统状态、资源与服务' : 'System health, resources, and services',
    build: zh ? '执行运维任务' : 'Run an ops task',
    buildDetail: zh ? '排障、配置与日常维护' : 'Troubleshooting, configuration, and maintenance',
    data: zh ? '处理数据' : 'Work with data',
    dataDetail: zh ? '分析日志、文件和业务数据' : 'Analyze logs, files, and business data',
    chat: zh ? '日常聊天' : 'General chat',
    chatDetail: zh ? '讨论、规划或获取建议' : 'Discuss, plan, or get advice',
    develop: zh ? '开发协助' : 'Development help',
    developDetail: zh ? '设计、实现与代码审查' : 'Design, implementation, and code review',
    prompt: zh ? '告诉 SD-Agent 你想完成什么…' : 'Tell SD-Agent what you want to do…',
    hostContext: zh ? '主机上下文' : 'Host context',
    noHost: zh ? '无主机上下文' : 'No host context',
    tools: zh ? '工具活动' : 'Tool activity',
    settings: zh ? 'AI 设置' : 'AI settings',
    clear: zh ? '清空对话' : 'Clear conversation',
    retryMessage: zh ? '从这里重试' : 'Retry from here',
    notConfigured: zh ? '请先在主窗口的设置中配置 AI 模型。' : 'Configure an AI model in the main window settings first.',
    thinking: zh ? '正在处理任务…' : 'Working on it…',
    activityRunning: zh ? '正在调用' : 'Calling',
    activityCompleted: zh ? '已完成' : 'Completed',
    activityFailed: zh ? '失败' : 'Failed',
    openDesktop: zh ? '打开桌面' : 'Open desktop',
    connectionFailed: zh ? '连接主机失败：' : 'Failed to connect to host: ',
  };
}

function hostLabel(host: AgentWorkspaceHost) {
  return host.name.trim() || `${host.username}@${host.address}`;
}

function toConnectionRequest(host: AgentWorkspaceHost): ShellDeskHostConnectionRequest {
  return {
    id: host.id,
    name: host.name,
    address: host.address,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod,
    password: host.password,
    keyId: host.keyId,
    keyPath: host.keyPath,
    passphrase: host.passphrase,
    privilegeMode: host.privilegeMode,
    rootPassword: host.rootPassword,
    jumpHostId: host.jumpHostId,
    proxyProfileId: host.proxyProfileId,
    keepaliveEnabled: host.keepaliveEnabled,
    keepaliveIntervalMs: host.keepaliveIntervalMs,
    systemType: host.systemType,
    systemName: host.systemName,
  };
}

function AgentWorkspace({ hosts, settings, language, onOpenSettings, onReturnToHostManagement }: AgentWorkspaceProps) {
  const copy = getCopy(language);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const initialTaskRef = useRef<AgentConversationSession | null>(null);
  const [tasks, setTasks] = useState<AgentConversationSession[]>(() => {
    const task = createTaskSession(language);
    initialTaskRef.current = task;
    return [task];
  });
  const [hostSessions, setHostSessions] = useState<Record<string, AgentConversationSession>>({});
  const [activeTaskId, setActiveTaskId] = useState(() => tasks[0]?.id ?? '');
  const [areMoreTasksVisible, setAreMoreTasksVisible] = useState(false);
  const [taskContextMenu, setTaskContextMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<{ messageId: string; x: number; y: number } | null>(null);
  const [areSessionsHydrated, setAreSessionsHydrated] = useState(false);
  const [connection, setConnection] = useState<ShellDeskConnectionInfo | null>(null);
  const [selectedModel, setSelectedModel] = useState(() => settings.aiModel);
  const [modelOptions, setModelOptions] = useState<AgentModelOption[]>([]);
  const [draft, setDraft] = useState('');
  const [pendingMessage, setPendingMessage] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [isHostPaneOpen, setIsHostPaneOpen] = useState(true);
  const messagesRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const hostsRef = useRef(hosts);
  const connectionByHostIdRef = useRef(new Map<string, ShellDeskConnectionInfo>());
  const requestedTaskTitleIdsRef = useRef(new Set<string>());
  const isWorkspaceMountedRef = useRef(true);
  hostsRef.current = hosts;
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? null;
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? tasks[0];
  const conversationId = selectedHost ? `host:${selectedHost.id}` : `task:${activeTask?.id ?? 'new'}`;
  const initialMessages = selectedHost
    ? hostSessions[selectedHost.id]?.messages ?? []
    : activeTask?.messages ?? [];
  const activeHostId = connection?.host.id ?? '';
  const agentSettings = useMemo(() => ({ ...settings, aiModel: selectedModel }), [selectedModel, settings]);
  const visibleModelOptions = useMemo(() => {
    if (!selectedModel || modelOptions.some((model) => model.id === selectedModel)) return modelOptions;
    return [{ id: selectedModel, name: selectedModel }, ...modelOptions];
  }, [modelOptions, selectedModel]);
  const selectedModelLabel = visibleModelOptions.find((model) => model.id === selectedModel)?.name || selectedModel;
  const modelSelectWidth = `${Math.min(32, Math.max(15, Array.from(selectedModelLabel).length + 6))}ch`;

  useEffect(() => {
    setSelectedModel(settings.aiModel);
  }, [settings.aiModel]);

  useEffect(() => {
    let isDisposed = false;
    const isCustomProvider = settings.aiProvider === 'openai-compatible' || settings.aiProvider === 'custom';
    const loadModels = async () => {
      try {
        const options = isCustomProvider
          ? (await window.guiSSH?.ai?.listModels({
            provider: settings.aiProvider,
            apiFormat: settings.aiApiFormat,
            apiBaseUrl: settings.aiApiBaseUrl,
            apiKey: settings.aiApiKey,
          }))?.models.map((model) => ({ id: model.id, name: model.name || model.id })) ?? []
          : getBuiltinAgentModelOptions(settings);
        if (!isDisposed) setModelOptions(options);
      } catch {
        if (!isDisposed) setModelOptions([]);
      }
    };
    void loadModels();
    return () => { isDisposed = true; };
  }, [settings.aiApiBaseUrl, settings.aiApiFormat, settings.aiApiKey, settings.aiProvider]);

  useEffect(() => {
    let isDisposed = false;
    const sessionsApi = window.guiSSH?.agentSessions;
    if (!sessionsApi) {
      setAreSessionsHydrated(true);
      return undefined;
    }

    void sessionsApi.get().then((snapshot) => {
      if (isDisposed) return;
      const restoredTasks = snapshot.tasks.map(fromStoredSession);
      const initialTask = initialTaskRef.current ?? createTaskSession(language);
      const reusableTask = [...restoredTasks]
        .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
        .find((task) => !task.messages.some((message) => message.role === 'user'));
      const nextTasks = restoredTasks.length
        ? (reusableTask ? restoredTasks : [initialTask, ...restoredTasks])
        : [initialTask];
      const restoredHostSessions = Object.fromEntries(Object.entries(snapshot.hostSessions).map(([hostId, session]) => [hostId, fromStoredSession(session)]));
      setTasks(nextTasks);
      setHostSessions(restoredHostSessions);
      setActiveTaskId((reusableTask ?? initialTask).id);
      setSelectedHostId(null);
      setConnection(null);
    }).catch(() => undefined).finally(() => {
      if (!isDisposed) setAreSessionsHydrated(true);
    });

    return () => { isDisposed = true; };
  }, [language]);

  useEffect(() => {
    if (!areSessionsHydrated || !window.guiSSH?.agentSessions) return;
    for (const task of tasks) {
      void window.guiSSH.agentSessions.save(toStoredSession(task, 'task')).catch(() => undefined);
    }
  }, [areSessionsHydrated, tasks]);

  useEffect(() => {
    if (!areSessionsHydrated || !window.guiSSH?.agentSessions) return;
    for (const [hostId, session] of Object.entries(hostSessions)) {
      void window.guiSSH.agentSessions.save(toStoredSession(session, 'host', hostId)).catch(() => undefined);
    }
  }, [areSessionsHydrated, hostSessions]);

  const connectHosts = useCallback(async (hostIds: string[]): Promise<AgentWorkspaceConnectionResult[]> => {
    const api = window.guiSSH?.connections;
    const uniqueIds = [...new Set(hostIds)];
    if (!api?.connect) {
      return uniqueIds.flatMap((hostId) => {
        const host = hostsRef.current.find((candidate) => candidate.id === hostId);
        return host ? [{ host, error: 'ShellDesk connection API is unavailable.' }] : [];
      });
    }

    return Promise.all(uniqueIds.flatMap((hostId) => {
      const host = hostsRef.current.find((candidate) => candidate.id === hostId);
      if (!host) return [];
      const existing = connectionByHostIdRef.current.get(host.id);
      if (existing) return [Promise.resolve({ host, connection: existing })];
      return [api.connect(toConnectionRequest(host))
        .then((nextConnection) => {
          connectionByHostIdRef.current.set(host.id, nextConnection);
          setConnection((current) => current ?? nextConnection);
          return { host, connection: nextConnection };
        })
        .catch((error) => ({ host, error: getErrorMessage(error) }))];
    }));
  }, []);

  const openDesktopApp = useCallback((appKey: ShellDeskDesktopAppKey) => {
    if (!connection?.id) {
      return;
    }

    void window.guiSSH?.app?.openConnectionWindow(connection.id, appKey);
  }, [connection?.id]);

  const workspaceTools = useMemo(() => createAgentWorkspaceTools({
    getHosts: () => hostsRef.current,
    getSelectedHostIds: () => selectedHost ? [selectedHost.id] : [],
    connectHosts,
  }), [connectHosts, selectedHost]);
  const sharedTools = useMemo(() => [...createSharedTools(connection?.id, {
    systemType: connection?.host.systemType,
    settings: agentSettings,
    onOpenApp: connection ? openDesktopApp : undefined,
  }), ...workspaceTools], [agentSettings, connection, openDesktopApp, workspaceTools]);
  const {
    messages,
    isBusy,
    busyText,
    error,
    isConfigured,
    sendMessage,
    clearHistory,
    cancelRequest,
    toolActivities,
    conversationStatuses,
    conversationMessages,
  } = usePiAgent({
    settings: agentSettings,
    language,
    systemPrompt: `${getDefaultChatPrompt()}\n\nYou are also the ShellDesk SD-Agent workspace assistant. Be clear about whether a remote host is selected. Use list_shelldesk_hosts to retrieve saved hosts when none is selected. Use run_command_on_hosts for the same command across one or more hosts; it connects target hosts automatically. Use the regular remote tools for the current primary host.`,
    tools: sharedTools,
    connectionId: connection?.id,
    conversationId,
    initialMessages,
  });

  useEffect(() => {
    const element = messagesRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [busyText, messages, toolActivities]);

  useEffect(() => {
    setTasks((current) => {
      let hasChanges = false;
      const next = current.map((task) => {
        const nextMessages = conversationMessages[`task:${task.id}`];
        if (!nextMessages || sameMessages(task.messages, nextMessages)) return task;
        hasChanges = true;
        return {
          ...task,
          title: task.title,
          messages: nextMessages,
          updatedAt: new Date().toISOString(),
        };
      });
      return hasChanges ? next : current;
    });

    setHostSessions((current) => {
      let hasChanges = false;
      const next = { ...current };
      for (const [key, nextMessages] of Object.entries(conversationMessages)) {
        if (!key.startsWith('host:')) continue;
        const hostId = key.slice('host:'.length);
        const host = hosts.find((candidate) => candidate.id === hostId);
        if (!host || sameMessages(current[hostId]?.messages ?? [], nextMessages)) continue;
        const existing = current[hostId];
        next[hostId] = {
          id: `host:${hostId}`,
          title: hostLabel(host),
          messages: nextMessages,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        hasChanges = true;
      }
      return hasChanges ? next : current;
    });
  }, [conversationMessages, copy.newTask, hosts]);

  const updateTaskTitle = useCallback((taskId: string, title: string) => {
    setTasks((current) => {
      let hasChanges = false;
      const next = current.map((task) => {
        if (task.id !== taskId || task.title === title) return task;
        hasChanges = true;
        return { ...task, title, updatedAt: new Date().toISOString() };
      });
      return hasChanges ? next : current;
    });
  }, []);

  useEffect(() => {
    isWorkspaceMountedRef.current = true;
    return () => { isWorkspaceMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!isConfigured) return;

    for (const task of tasks) {
      const firstUserMessage = task.messages.find((message) => message.role === 'user')?.content.trim();
      if (!firstUserMessage || task.title !== copy.newTask || requestedTaskTitleIdsRef.current.has(task.id)) continue;

      requestedTaskTitleIdsRef.current.add(task.id);
      void completeAiRequest(agentSettings, {
        systemPrompt: 'Generate a concise task title from the user request. Preserve the user\'s language. Return only the title, no quotation marks, no explanation, and no markdown. Keep it under 24 characters for Chinese or 8 words for other languages.',
        messages: [{ role: 'user', content: firstUserMessage.slice(0, 1_000) }],
        temperature: 0.2,
      }).then((response) => {
        if (!isWorkspaceMountedRef.current) return;
        const title = getGeneratedTaskTitle(response, getSessionTitle(task.messages, copy.newTask));
        updateTaskTitle(task.id, title);
      }).catch(() => {
        if (!isWorkspaceMountedRef.current) return;
        const title = getSessionTitle(task.messages, copy.newTask);
        updateTaskTitle(task.id, title);
      });
    }
  }, [agentSettings, copy.newTask, isConfigured, tasks, updateTaskTitle]);

  useEffect(() => {
    if (!pendingMessage || !connection || activeHostId !== selectedHost?.id) {
      return;
    }

    const message = pendingMessage;
    setPendingMessage('');
    void sendMessage(message);
  }, [activeHostId, connection, pendingMessage, selectedHost?.id, sendMessage]);

  const connectSelectedHost = useCallback(async () => {
    if (!selectedHost || isConnecting) {
      return false;
    }

    if (connectionByHostIdRef.current.has(selectedHost.id)) {
      return true;
    }

    setIsConnecting(true);
    setConnectionError('');
    try {
      const results = await connectHosts([selectedHost.id]);
      const primaryResult = results.find((result) => result.host.id === selectedHost.id && result.connection);
      if (!primaryResult?.connection) {
        throw new Error(results.find((result) => result.error)?.error || 'Connection failed.');
      }
      setConnection(primaryResult.connection);
      return true;
    } catch (nextError) {
      setConnectionError(copy.connectionFailed + getErrorMessage(nextError));
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, [connectHosts, copy.connectionFailed, isConnecting, selectedHost]);

  const openSelectedHostDesktop = useCallback(async () => {
    if (!selectedHost || isConnecting) return;

    let targetConnection = connectionByHostIdRef.current.get(selectedHost.id);
    if (!targetConnection) {
      const connected = await connectSelectedHost();
      if (!connected) return;
      targetConnection = connectionByHostIdRef.current.get(selectedHost.id);
    }

    if (targetConnection) {
      void window.guiSSH?.app?.openConnectionWindow(targetConnection.id);
    }
  }, [connectSelectedHost, isConnecting, selectedHost]);

  const disconnectHost = useCallback(() => {
    const connectionId = connection?.id;
    if (activeHostId) {
      connectionByHostIdRef.current.delete(activeHostId);
    }
    setConnection(null);
    setConnectionError('');
    if (connectionId) {
      void window.guiSSH?.connections?.disconnect(connectionId).catch(() => undefined);
    }
  }, [connection?.id]);

  const sendDraft = useCallback(() => {
    const content = draft.trim();
    if (!content || isBusy || isConnecting) {
      return;
    }

    setDraft('');
    if (selectedHost && activeHostId !== selectedHost.id) {
      setPendingMessage(content);
      void connectSelectedHost().then((connected) => {
        if (!connected) {
          setPendingMessage('');
          setDraft(content);
        }
      });
      return;
    }

    void sendMessage(content);
  }, [activeHostId, connectSelectedHost, draft, isBusy, isConnecting, selectedHost, sendMessage]);

  const sendSuggestion = useCallback((message: string) => {
    setDraft(message);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const createNewTask = useCallback(() => {
    const latestTask = [...tasks].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))[0];
    if (latestTask && !latestTask.messages.some((message) => message.role === 'user')) {
      setActiveTaskId(latestTask.id);
      setSelectedHostId(null);
      setConnection(null);
      setConnectionError('');
      return;
    }

    const task = createTaskSession(language);
    setTasks((current) => [task, ...current]);
    setActiveTaskId(task.id);
    setSelectedHostId(null);
    setConnection(null);
    setConnectionError('');
    setDraft('');
  }, [language, tasks]);

  const openTask = useCallback((taskId: string) => {
    setActiveTaskId(taskId);
    setSelectedHostId(null);
    setConnection(null);
    setConnectionError('');
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    const remainingTasks = tasks.filter((task) => task.id !== taskId);
    const nextTasks = remainingTasks.length ? remainingTasks : [createTaskSession(language)];
    setTasks(nextTasks);
    void window.guiSSH?.agentSessions?.delete(taskId).catch(() => undefined);
    if (activeTaskId === taskId) {
      setActiveTaskId(nextTasks[0].id);
      setSelectedHostId(null);
      setConnection(null);
    }
    setTaskContextMenu(null);
  }, [activeTaskId, language, tasks]);

  const retryFromUserMessage = useCallback((messageId: string) => {
    const message = messages.find((candidate) => candidate.id === messageId && candidate.role === 'user');
    setMessageContextMenu(null);
    if (!message || isBusy) return;
    void sendMessage(message.content, { retryFromMessageId: message.id });
  }, [isBusy, messages, sendMessage]);

  useEffect(() => {
    if (!taskContextMenu && !messageContextMenu) return undefined;
    const closeMenu = () => {
      setTaskContextMenu(null);
      setMessageContextMenu(null);
    };
    window.addEventListener('pointerdown', closeMenu);
    return () => window.removeEventListener('pointerdown', closeMenu);
  }, [messageContextMenu, taskContextMenu]);

  const visibleTasks = [...tasks]
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
    .slice(0, areMoreTasksVisible ? tasks.length : 3);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendDraft();
    }
  }, [sendDraft]);

  const suggestions = selectedHost ? [
    { icon: <TerminalSquare />, label: copy.explore, description: copy.exploreDetail, message: language === 'zh-CN' ? '帮我快速巡检这台主机的系统状态、资源使用和异常服务。' : 'Quickly inspect this host for system health, resource use, and unhealthy services.' },
    { icon: <Wrench />, label: copy.build, description: copy.buildDetail, message: language === 'zh-CN' ? '帮我规划并执行这台主机上的日常运维检查。' : 'Plan and perform routine operations checks on this host.' },
    { icon: <Command />, label: copy.data, description: copy.dataDetail, message: language === 'zh-CN' ? '帮我分析主机上的数据和日志，并给出结论。' : 'Help me analyze data and logs on this host, then summarize the findings.' },
    { icon: <Bot />, label: copy.chat, description: copy.chatDetail, message: language === 'zh-CN' ? '我想聊聊今天的工作安排。' : 'I want to talk through today’s work plan.' },
  ] : [
    { icon: <TerminalSquare />, label: copy.explore, description: copy.exploreDetail, message: language === 'zh-CN' ? '帮我制定一份主机巡检方案；如需执行，请先查询并选择目标主机。' : 'Help me create a host inspection plan. If execution is needed, first list and choose the target hosts.' },
    { icon: <Wrench />, label: copy.build, description: copy.buildDetail, message: language === 'zh-CN' ? '我需要处理一项运维任务，请先帮我梳理方案；如需执行，请查询并选择目标主机。' : 'I need to handle an operations task. Help me plan it first, then list and choose target hosts if execution is needed.' },
    { icon: <SquarePen />, label: copy.develop, description: copy.developDetail, message: language === 'zh-CN' ? '帮我设计并实现一个开发任务，给出清晰的技术方案和代码建议。' : 'Help me design and implement a development task with a clear technical approach and code guidance.' },
    { icon: <Command />, label: copy.data, description: copy.dataDetail, message: language === 'zh-CN' ? '帮我分析数据、日志或脚本输出，并给出结论和后续建议。' : 'Help me analyze data, logs, or script output, then provide conclusions and next steps.' },
  ];

  return (
    <main className={`agent-workspace no-drag ${isHostPaneOpen ? '' : 'host-pane-collapsed'}`}>
      <aside className={`agent-host-pane ${isHostPaneOpen ? '' : 'collapsed'}`}>
        {isHostPaneOpen ? <>
          <header className="agent-pane-header">
            <button type="button" className="agent-return-hosts" onClick={onReturnToHostManagement}>
              <Bot aria-hidden="true" /><span>{copy.returnToHostManagement}</span>
            </button>
            <button type="button" onClick={() => setIsHostPaneOpen(false)} aria-label={language === 'zh-CN' ? '收起主机列表' : 'Collapse host list'}><PanelLeftClose aria-hidden="true" /></button>
          </header>
          <button type="button" className="agent-host-row agent-local-row" onClick={createNewTask}>
            <span className="agent-host-icon"><SquarePen aria-hidden="true" /></span>
            <span><strong>{copy.newTask}</strong></span>
          </button>
          <div className="agent-host-list-heading"><span>{copy.tasks}</span><span>{tasks.length}</span></div>
          <div className="agent-task-list">
            {visibleTasks.map((task) => {
              const conversationStatus = conversationStatuses[`task:${task.id}`] ?? 'idle';
              return <button key={task.id} type="button" className={`agent-task-row ${!selectedHost && task.id === activeTask?.id ? 'selected' : ''}`} onClick={() => openTask(task.id)} onContextMenu={(event) => { event.preventDefault(); setTaskContextMenu({ taskId: task.id, x: event.clientX, y: event.clientY }); }}>
                <span>{task.title}</span><i className={conversationStatus} title={conversationStatus} />
              </button>;
            })}
            {tasks.length > 3 ? <button type="button" className="agent-task-expand" onClick={() => setAreMoreTasksVisible((current) => !current)}>{areMoreTasksVisible ? copy.showFewerTasks : copy.showMoreTasks}</button> : null}
          </div>
          <div className="agent-host-list-heading"><span>{copy.hosts}</span><span>{hosts.length}</span></div>
          <div className="agent-host-list">
            {hosts.map((host) => {
              const isSelected = host.id === selectedHostId;
              const conversationStatus = conversationStatuses[`host:${host.id}`] ?? 'idle';
              return (
                <button key={host.id} type="button" className={`agent-host-row ${isSelected ? 'selected' : ''}`} aria-pressed={isSelected} onClick={() => { setSelectedHostId(host.id); setConnection(connectionByHostIdRef.current.get(host.id) ?? null); setConnectionError(''); }}>
                  <span className="agent-host-icon"><TerminalSquare aria-hidden="true" /></span>
                  <span className="agent-host-copy"><strong>{hostLabel(host)}</strong><small>{host.username ? `${host.username}@` : ''}{host.address}:{host.port}</small></span>
                  <i className={conversationStatus} title={conversationStatus} />
                </button>
              );
            })}
            {!hosts.length ? <div className="agent-host-empty"><strong>{copy.emptyHosts}</strong><span>{copy.emptyHostsDetail}</span></div> : null}
          </div>
          <footer className="agent-pane-footer"><button type="button" onClick={onOpenSettings}><Settings aria-hidden="true" />{copy.settings}</button></footer>
        </> : <div className="agent-collapsed-pane-actions">
          <button type="button" onClick={onReturnToHostManagement} aria-label={copy.returnToHostManagement} title={copy.returnToHostManagement}><ArrowLeft aria-hidden="true" /></button>
          <button type="button" onClick={() => setIsHostPaneOpen(true)} aria-label={language === 'zh-CN' ? '展开主机列表' : 'Expand host list'} title={language === 'zh-CN' ? '展开主机列表' : 'Expand host list'}><PanelLeftOpen aria-hidden="true" /></button>
          <button type="button" className="agent-collapsed-settings" onClick={onOpenSettings} aria-label={copy.settings} title={copy.settings}><Settings aria-hidden="true" /></button>
        </div>}
      </aside>

      <section className="agent-canvas">
        <header className="agent-canvas-header">
          <div><Bot aria-hidden="true" /><span>{copy.title}</span></div>
          <div className="agent-header-actions">
            {selectedHost ? <button type="button" onClick={() => void openSelectedHostDesktop()} disabled={isConnecting}><Laptop aria-hidden="true" />{isConnecting ? copy.connecting : copy.openDesktop}</button> : null}
            {messages.length ? <button type="button" onClick={clearHistory} disabled={isBusy}>{copy.clear}</button> : null}
          </div>
        </header>

        {!isConfigured ? <div className="agent-configuration-note"><strong>{copy.notConfigured}</strong><button type="button" onClick={onOpenSettings}>{copy.settings}</button></div> : null}
        {connectionError ? <div className="agent-connection-error" role="alert">{connectionError}</div> : null}

        <section ref={messagesRef} className="agent-conversation" aria-live="polite">
          {!messages.length ? (
            <div className="agent-welcome">
              <span className="agent-welcome-mark"><Bot aria-hidden="true" /></span>
              <h1>{copy.welcome}</h1>
              <p className="agent-welcome-context" aria-hidden={!selectedHost}>
                {selectedHost ? copy.welcomeHost.replace('{host}', hostLabel(selectedHost)) : '\u00a0'}
              </p>
              <div className="agent-suggestions">
                {suggestions.map((suggestion) => <button key={suggestion.label} type="button" onClick={() => sendSuggestion(suggestion.message)} disabled={!isConfigured || isConnecting}>
                  {suggestion.icon}
                  <span className="agent-suggestion-copy"><strong>{suggestion.label}</strong><small>{suggestion.description}</small></span>
                </button>)}
              </div>
            </div>
          ) : null}

          {messages.map((message) => (
            <article key={message.id} className={`agent-message ${message.role}`} onContextMenu={message.role === 'user' ? (event) => { event.preventDefault(); setMessageContextMenu({ messageId: message.id, x: event.clientX, y: event.clientY }); } : undefined}>
              <div className="agent-message-avatar">{message.role === 'user' ? '你' : <Bot aria-hidden="true" />}</div>
              <div className="agent-message-content">
                <small>{message.role === 'user' ? (language === 'zh-CN' ? '你' : 'You') : copy.title}</small>
                {message.role === 'assistant' ? <MarkdownMessage content={message.content} /> : <p>{message.content}</p>}
              </div>
            </article>
          ))}

          {(isBusy || toolActivities.length) ? <section className="agent-activity" aria-label={copy.tools}>
            <div className="agent-activity-title"><ChevronDown aria-hidden="true" />{copy.tools}</div>
            {isBusy && !toolActivities.some((activity) => activity.status === 'running') ? <div className="agent-activity-row running"><LoaderCircle aria-hidden="true" /><span>{busyText || copy.thinking}</span></div> : null}
            {toolActivities.slice(-6).map((activity) => <div className={`agent-activity-row ${activity.status}`} key={activity.id}>
              {activity.status === 'running' ? <LoaderCircle aria-hidden="true" /> : activity.status === 'completed' ? <CheckCircle2 aria-hidden="true" /> : <X aria-hidden="true" />}
              <span>{activity.status === 'running' ? copy.activityRunning : activity.status === 'completed' ? copy.activityCompleted : copy.activityFailed} <code>{activity.name}</code></span>
            </div>)}
          </section> : null}
          {error ? <div className="agent-response-error" role="alert">{error}</div> : null}
        </section>

        <footer className="agent-composer-wrap">
          <div className="agent-context-bar">
            <span><Circle aria-hidden="true" className={connection ? 'online' : ''} />{selectedHost ? `${copy.hostContext}: ${hostLabel(selectedHost)}` : copy.noHost}</span>
            {selectedHost && (!connection || activeHostId !== selectedHost.id) ? <button type="button" onClick={() => void connectSelectedHost()} disabled={isConnecting}>{isConnecting ? copy.connecting : copy.connect}</button> : null}
            {connection ? <button type="button" onClick={disconnectHost}>{copy.disconnect}</button> : null}
          </div>
          <div className="agent-composer">
            <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} placeholder={copy.prompt} disabled={!isConfigured || isConnecting} rows={3} />
            <div className="agent-composer-actions">
              <span className="agent-model-control" style={{ width: modelSelectWidth }}>
                <select className="agent-model-select" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={isBusy || isConnecting || !visibleModelOptions.length} aria-label={language === 'zh-CN' ? '选择 AI 模型' : 'Select AI model'}>
                  {visibleModelOptions.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
                <ChevronDown aria-hidden="true" />
              </span>
              <button type="button" className={isBusy ? 'stop' : ''} onClick={isBusy ? cancelRequest : sendDraft} disabled={!isBusy && (!draft.trim() || !isConfigured || isConnecting)} aria-label={isBusy ? 'Stop' : 'Send'}>{isBusy ? <X aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}</button>
            </div>
          </div>
        </footer>
      </section>
      {taskContextMenu ? createPortal(
        <div className="agent-task-context-menu" role="menu" style={{ left: taskContextMenu.x, top: taskContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => deleteTask(taskContextMenu.taskId)}>{language === 'zh-CN' ? '删除任务' : 'Delete task'}</button>
        </div>,
        document.body,
      ) : null}
      {messageContextMenu ? createPortal(
        <div className="agent-message-context-menu" role="menu" style={{ left: messageContextMenu.x, top: messageContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => retryFromUserMessage(messageContextMenu.messageId)} disabled={isBusy}>{copy.retryMessage}</button>
        </div>,
        document.body,
      ) : null}
    </main>
  );
}

export default AgentWorkspace;
