import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';
import ContainerDetailPanel from './ContainerDetailPanel';
import ContainerRunForm from './ContainerRunForm';
import { t, useCurrentAppLanguage, type MessageId } from '../../i18n';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import { useSudoCommand } from './sudoPrompt';
import {
  buildContainerConfigCommandGroups,
  buildContainerRunArgs,
  buildComposeProjectActionArgs,
  buildComposeUpArgs,
  buildDockerDaemonRestartCommand,
  buildImagePruneArgs,
  buildNetworkCreateArgs,
  buildNetworkInspectArgs,
  buildNetworkPruneArgs,
  buildNetworkRemoveArgs,
  buildVolumeCreateArgs,
  buildVolumeInspectArgs,
  buildVolumePruneArgs,
  buildVolumeRemoveArgs,
  createContainerTroubleshooting,
  createDockerNetworkTroubleshooting,
  formatRuntimeCommand,
  getContainerActionCommand,
  getContainerConfigUpdateCommand,
  getContainerDetailCommand,
  getContainerExecCommand,
  getContainerLogsCommand,
  getContainerListCommand,
  getComposeListCommand,
  getDetectRuntimeCommand,
  getImageListCommand,
  getImagePullCommand,
  getImageReference,
  getImageRemoveCommand,
  getNetworkListCommand,
  getRuntimeCliCommand,
  getRuntimeLabel,
  getVolumeListCommand,
  isDockerNetworkTrouble,
  matchesContainerQuery,
  matchesImageQuery,
} from './containerCommands';
import { formatShortId, getStateLabel, parseComposeProjectSummary, parseContainerDetailOutput, parseContainerNetworkSummary, parseContainerSummary, parseContainerVolumeSummary, parseImageSummary, parseJsonLines } from './containerParsers';
import type {
  ComposeProjectAction,
  ComposeProjectSummary,
  ContainerAction,
  ContainerComposeForm,
  ContainerConfigForm,
  ContainerFilter,
  ContainerNetworkForm,
  ContainerNetworkSummary,
  ContainerRuntime,
  ContainerRunForm as ContainerRunFormState,
  ContainerSummary,
  ContainerTroubleshooting,
  ContainerVolumeForm,
  ContainerVolumeSummary,
  ImagePruneMode,
  ImageSummary,
  ManagerTab,
  PendingAction,
  RemoteContainerManagerProps,
} from './containerTypes';

const managerTabs: Array<{ key: ManagerTab; labelId: MessageId }> = [
  { key: 'containers', labelId: 'container.tab.containers' },
  { key: 'images', labelId: 'container.tab.images' },
  { key: 'compose', labelId: 'container.tab.compose' },
  { key: 'networks', labelId: 'container.tab.networks' },
  { key: 'volumes', labelId: 'container.tab.volumes' },
];

const containerFilters: Array<{ key: ContainerFilter; labelId: MessageId }> = [
  { key: 'all', labelId: 'container.filter.all' },
  { key: 'running', labelId: 'container.state.running' },
  { key: 'exited', labelId: 'container.state.exited' },
  { key: 'paused', labelId: 'container.state.paused' },
  { key: 'created', labelId: 'container.state.created' },
  { key: 'unknown', labelId: 'container.state.unknown' },
];

const containerActionLabels: Record<ContainerAction, { successId: MessageId }> = {
  start: { successId: 'container.action.success.start' },
  stop: { successId: 'container.action.success.stop' },
  restart: { successId: 'container.action.success.restart' },
  pause: { successId: 'container.action.success.pause' },
  unpause: { successId: 'container.action.success.unpause' },
  kill: { successId: 'container.action.success.kill' },
  remove: { successId: 'container.action.success.remove' },
};

const imagePruneOptions: Array<{ value: ImagePruneMode; labelId: MessageId; descriptionId: MessageId }> = [
  { value: 'dangling', labelId: 'container.prune.dangling', descriptionId: 'container.prune.danglingDescription' },
  { value: 'unused', labelId: 'container.prune.unused', descriptionId: 'container.prune.unusedDescription' },
];

const composeProjectActions: Array<{ action: ComposeProjectAction; labelId: MessageId; danger?: boolean }> = [
  { action: 'up', labelId: 'container.compose.up' },
  { action: 'start', labelId: 'container.compose.start' },
  { action: 'stop', labelId: 'container.compose.stop' },
  { action: 'restart', labelId: 'container.compose.restart' },
  { action: 'pull', labelId: 'container.compose.pull' },
  { action: 'down', labelId: 'container.compose.down', danger: true },
];

function createDefaultComposeForm(): ContainerComposeForm {
  return {
    projectName: '',
    workingDir: '',
    configFile: 'docker-compose.yml',
    envFile: '',
    services: '',
    build: false,
    pull: false,
    removeOrphans: true,
  };
}

function createDefaultNetworkForm(): ContainerNetworkForm {
  return {
    name: '',
    driver: 'bridge',
    subnet: '',
    gateway: '',
    ipRange: '',
    labels: '',
    options: '',
    internal: false,
    attachable: false,
    ipv6: false,
  };
}

function createDefaultVolumeForm(): ContainerVolumeForm {
  return {
    name: '',
    driver: 'local',
    labels: '',
    options: '',
  };
}

function isDefaultContainerNetwork(network: ContainerNetworkSummary) {
  return network.name === 'bridge' || network.name === 'host' || network.name === 'none';
}

function RemoteContainerManager({ connectionId, systemType }: RemoteContainerManagerProps) {
  const language = useCurrentAppLanguage();
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const runtimeRef = useRef<ContainerRuntime | null>(null);
  const isMountedRef = useRef(true);
  const selectedContainerIdRef = useRef('');
  const detailRequestIdRef = useRef(0);
  const [runtime, setRuntimeState] = useState<ContainerRuntime | null>(null);
  const [activeTab, setActiveTab] = useState<ManagerTab>('containers');
  const [containers, setContainers] = useState<ContainerSummary[]>([]);
  const [images, setImages] = useState<ImageSummary[]>([]);
  const [composeProjects, setComposeProjects] = useState<ComposeProjectSummary[]>([]);
  const [networks, setNetworks] = useState<ContainerNetworkSummary[]>([]);
  const [volumes, setVolumes] = useState<ContainerVolumeSummary[]>([]);
  const [selectedContainerId, setSelectedContainerId] = useState('');
  const [detail, setDetail] = useState<ReturnType<typeof parseContainerDetailOutput> | null>(null);
  const [containerSearch, setContainerSearch] = useState('');
  const [containerFilter, setContainerFilter] = useState<ContainerFilter>('all');
  const [imageSearch, setImageSearch] = useState('');
  const [composeSearch, setComposeSearch] = useState('');
  const [networkSearch, setNetworkSearch] = useState('');
  const [volumeSearch, setVolumeSearch] = useState('');
  const [pullImageName, setPullImageName] = useState('');
  const [imagePruneMode, setImagePruneMode] = useState<ImagePruneMode>('dangling');
  const [imagePruneDialogOpen, setImagePruneDialogOpen] = useState(false);
  const [imagePruneError, setImagePruneError] = useState('');
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [runInitialImage, setRunInitialImage] = useState('');
  const [composePanelOpen, setComposePanelOpen] = useState(false);
  const [composeForm, setComposeForm] = useState<ContainerComposeForm>(() => createDefaultComposeForm());
  const [networkPanelOpen, setNetworkPanelOpen] = useState(false);
  const [networkForm, setNetworkForm] = useState<ContainerNetworkForm>(() => createDefaultNetworkForm());
  const [volumePanelOpen, setVolumePanelOpen] = useState(false);
  const [volumeForm, setVolumeForm] = useState<ContainerVolumeForm>(() => createDefaultVolumeForm());
  const [resourceOutput, setResourceOutput] = useState<{ title: string; output: string } | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [containersLoading, setContainersLoading] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [composeLoading, setComposeLoading] = useState(false);
  const [composeLoaded, setComposeLoaded] = useState(false);
  const [networksLoading, setNetworksLoading] = useState(false);
  const [networksLoaded, setNetworksLoaded] = useState(false);
  const [volumesLoading, setVolumesLoading] = useState(false);
  const [volumesLoaded, setVolumesLoaded] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actingKey, setActingKey] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pruningImages, setPruningImages] = useState(false);
  const [runningContainer, setRunningContainer] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [troubleshooting, setTroubleshooting] = useState<ContainerTroubleshooting | null>(null);
  const [runError, setRunError] = useState('');
  const [runTroubleshooting, setRunTroubleshooting] = useState<ContainerTroubleshooting | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);

  const setRuntimeValue = useCallback((value: ContainerRuntime | null) => {
    runtimeRef.current = value;
    setRuntimeState(value);
  }, []);

  useEffect(() => {
    selectedContainerIdRef.current = selectedContainerId;
  }, [selectedContainerId]);

  const detectRuntime = useCallback(async (options?: { suppressGlobalError?: boolean }) => {
    if (runtimeRef.current) return runtimeRef.current;
    setRuntimeLoading(true);
    setError('');
    setNotice('');
    setTroubleshooting(null);
    try {
      const result = await runCommand(getDetectRuntimeCommand(isWindowsHost, language));
      const detectedRuntime = (result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find((line) => line === 'docker' || line === 'podman') as ContainerRuntime | undefined;
      if (!detectedRuntime) throw new Error(result.stderr || result.stdout || t('container.error.noRuntime', language));
      if (isMountedRef.current) setRuntimeValue(detectedRuntime);
      return detectedRuntime;
    } catch (err) {
      if (isMountedRef.current) {
        setRuntimeValue(null);
        if (!options?.suppressGlobalError) setError(getErrorMessage(err));
      }
      throw err;
    } finally {
      if (isMountedRef.current) setRuntimeLoading(false);
    }
  }, [isWindowsHost, language, runCommand, setRuntimeValue]);

  const refreshContainers = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean; preferredContainerId?: string; preferredContainerName?: string }) => {
    if (!options?.silent) setContainersLoading(true);
    setError('');
    setNotice('');
    setTroubleshooting(null);
    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCommand(getContainerListCommand(activeRuntime, isWindowsHost));
      const nextContainers = parseJsonLines(result.stdout || '')
        .map(parseContainerSummary)
        .filter((container): container is ContainerSummary => Boolean(container))
        .sort((first, second) => {
          const firstWeight = first.state === 'running' ? 0 : first.state === 'exited' ? 2 : 1;
          const secondWeight = second.state === 'running' ? 0 : second.state === 'exited' ? 2 : 1;
          return firstWeight !== secondWeight ? firstWeight - secondWeight : first.name.localeCompare(second.name, getShellDeskLocale());
        });
      if (result.code !== 0 && nextContainers.length === 0) throw new Error(result.stderr || result.stdout || t('container.error.listContainers', language));
      if (!isMountedRef.current) return selectedContainerIdRef.current;
      setContainers(nextContainers);
      if (result.code !== 0) setNotice(result.stderr || t('container.notice.partialContainers', language));
      const preferredContainerId = options?.preferredContainerId ?? selectedContainerIdRef.current;
      const preferredContainerName = options?.preferredContainerName?.trim();
      const preferredContainer = nextContainers.find((container) => (
        (preferredContainerId && (container.id === preferredContainerId || preferredContainerId.startsWith(container.id) || container.id.startsWith(preferredContainerId))) ||
        (preferredContainerName && container.name === preferredContainerName)
      ));
      const nextSelectedContainerId = preferredContainer?.id ?? nextContainers[0]?.id ?? '';
      setSelectedContainerId(nextSelectedContainerId);
      return nextSelectedContainerId;
    } catch (err) {
      if (isMountedRef.current) setError(getErrorMessage(err));
      return selectedContainerIdRef.current;
    } finally {
      if (isMountedRef.current && !options?.silent) setContainersLoading(false);
    }
  }, [detectRuntime, isWindowsHost, language, runCommand]);

  const refreshImages = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean }) => {
    if (!options?.silent) setImagesLoading(true);
    setError('');
    setNotice('');
    setTroubleshooting(null);
    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCommand(getImageListCommand(activeRuntime, isWindowsHost));
      const nextImages = parseJsonLines(result.stdout || '')
        .map(parseImageSummary)
        .filter((image): image is ImageSummary => Boolean(image))
        .sort((first, second) => getImageReference(first).localeCompare(getImageReference(second), getShellDeskLocale()));
      if (result.code !== 0 && nextImages.length === 0) throw new Error(result.stderr || result.stdout || t('container.error.listImages', language));
      if (!isMountedRef.current) return;
      setImages(nextImages);
      setImagesLoaded(true);
      if (result.code !== 0) setNotice(result.stderr || t('container.notice.partialImages', language));
    } catch (err) {
      if (isMountedRef.current) {
        setImagesLoaded(true);
        setError(getErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current && !options?.silent) setImagesLoading(false);
    }
  }, [detectRuntime, isWindowsHost, language, runCommand]);

  const refreshComposeProjects = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean }) => {
    if (!options?.silent) setComposeLoading(true);
    setError('');
    setNotice('');
    setTroubleshooting(null);
    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCommand(getComposeListCommand(activeRuntime, isWindowsHost));
      const nextProjects = parseJsonLines(result.stdout || '')
        .map(parseComposeProjectSummary)
        .filter((project): project is ComposeProjectSummary => Boolean(project))
        .sort((first, second) => first.name.localeCompare(second.name, getShellDeskLocale()));
      if (result.code !== 0 && nextProjects.length === 0) throw new Error(result.stderr || result.stdout || t('container.error.listCompose', language));
      if (!isMountedRef.current) return;
      setComposeProjects(nextProjects);
      setComposeLoaded(true);
      if (result.code !== 0) setNotice(result.stderr || t('container.notice.partialCompose', language));
    } catch (err) {
      if (isMountedRef.current) {
        setComposeLoaded(true);
        setError(getErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current && !options?.silent) setComposeLoading(false);
    }
  }, [detectRuntime, isWindowsHost, language, runCommand]);

  const refreshNetworks = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean }) => {
    if (!options?.silent) setNetworksLoading(true);
    setError('');
    setNotice('');
    setTroubleshooting(null);
    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCommand(getNetworkListCommand(activeRuntime, isWindowsHost));
      const nextNetworks = parseJsonLines(result.stdout || '')
        .map(parseContainerNetworkSummary)
        .filter((network): network is ContainerNetworkSummary => Boolean(network))
        .sort((first, second) => first.name.localeCompare(second.name, getShellDeskLocale()));
      if (result.code !== 0 && nextNetworks.length === 0) throw new Error(result.stderr || result.stdout || t('container.error.listNetworks', language));
      if (!isMountedRef.current) return;
      setNetworks(nextNetworks);
      setNetworksLoaded(true);
      if (result.code !== 0) setNotice(result.stderr || t('container.notice.partialNetworks', language));
    } catch (err) {
      if (isMountedRef.current) {
        setNetworksLoaded(true);
        setError(getErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current && !options?.silent) setNetworksLoading(false);
    }
  }, [detectRuntime, isWindowsHost, language, runCommand]);

  const refreshVolumes = useCallback(async (options?: { runtimeOverride?: ContainerRuntime; silent?: boolean }) => {
    if (!options?.silent) setVolumesLoading(true);
    setError('');
    setNotice('');
    setTroubleshooting(null);
    try {
      const activeRuntime = options?.runtimeOverride ?? await detectRuntime();
      const result = await runCommand(getVolumeListCommand(activeRuntime, isWindowsHost));
      const nextVolumes = parseJsonLines(result.stdout || '')
        .map(parseContainerVolumeSummary)
        .filter((volume): volume is ContainerVolumeSummary => Boolean(volume))
        .sort((first, second) => first.name.localeCompare(second.name, getShellDeskLocale()));
      if (result.code !== 0 && nextVolumes.length === 0) throw new Error(result.stderr || result.stdout || t('container.error.listVolumes', language));
      if (!isMountedRef.current) return;
      setVolumes(nextVolumes);
      setVolumesLoaded(true);
      if (result.code !== 0) setNotice(result.stderr || t('container.notice.partialVolumes', language));
    } catch (err) {
      if (isMountedRef.current) {
        setVolumesLoaded(true);
        setError(getErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current && !options?.silent) setVolumesLoading(false);
    }
  }, [detectRuntime, isWindowsHost, language, runCommand]);

  const loadContainerDetail = useCallback(async (containerId: string) => {
    const fallback = containers.find((container) => container.id === containerId);
    if (!fallback) {
      setDetail(null);
      return;
    }
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setDetailLoading(true);
    setError('');
    setTroubleshooting(null);
    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getContainerDetailCommand(activeRuntime, containerId, isWindowsHost));
      const nextDetail = parseContainerDetailOutput(result.stdout || '', fallback, language);
      if (result.code !== 0 && !nextDetail.inspectText) throw new Error(result.stderr || result.stdout || t('container.error.detail', language));
      if (isMountedRef.current && requestId === detailRequestIdRef.current) setDetail(nextDetail);
    } catch (err) {
      if (isMountedRef.current && requestId === detailRequestIdRef.current) setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current && requestId === detailRequestIdRef.current) setDetailLoading(false);
    }
  }, [containers, detectRuntime, isWindowsHost, language, runCommand]);

  useEffect(() => {
    isMountedRef.current = true;
    setRuntimeValue(null);
    setContainers([]);
    setImages([]);
    setImagesLoaded(false);
    setComposeProjects([]);
    setComposeLoaded(false);
    setNetworks([]);
    setNetworksLoaded(false);
    setVolumes([]);
    setVolumesLoaded(false);
    setDetail(null);
    setSelectedContainerId('');
    setRunError('');
    setRunTroubleshooting(null);
    setRunPanelOpen(false);
    setRunInitialImage('');
    setImagePruneMode('dangling');
    setImagePruneDialogOpen(false);
    setImagePruneError('');
    setComposePanelOpen(false);
    setComposeForm(createDefaultComposeForm());
    setNetworkPanelOpen(false);
    setNetworkForm(createDefaultNetworkForm());
    setVolumePanelOpen(false);
    setVolumeForm(createDefaultVolumeForm());
    setResourceOutput(null);
    void refreshContainers();
    return () => {
      isMountedRef.current = false;
    };
  }, [connectionId, refreshContainers, setRuntimeValue]);

  useEffect(() => {
    if (!selectedContainerId) {
      setDetail(null);
      return;
    }
    void loadContainerDetail(selectedContainerId);
  }, [loadContainerDetail, selectedContainerId]);

  useEffect(() => {
    if (activeTab === 'images' && !imagesLoaded && !imagesLoading) void refreshImages();
  }, [activeTab, imagesLoaded, imagesLoading, refreshImages]);

  useEffect(() => {
    if (activeTab === 'compose' && !composeLoaded && !composeLoading) void refreshComposeProjects();
  }, [activeTab, composeLoaded, composeLoading, refreshComposeProjects]);

  useEffect(() => {
    if (activeTab === 'networks' && !networksLoaded && !networksLoading) void refreshNetworks();
  }, [activeTab, networksLoaded, networksLoading, refreshNetworks]);

  useEffect(() => {
    if (activeTab === 'volumes' && !volumesLoaded && !volumesLoading) void refreshVolumes();
  }, [activeTab, volumesLoaded, volumesLoading, refreshVolumes]);

  const selectedContainer = useMemo(() => containers.find((container) => container.id === selectedContainerId) ?? null, [containers, selectedContainerId]);
  const selectedDetail = detail?.id === selectedContainerId ? detail : null;
  const visibleContainers = useMemo(() => {
    const query = containerSearch.trim();
    return containers.filter((container) => (containerFilter === 'all' || container.state === containerFilter) && matchesContainerQuery(container, query));
  }, [containerFilter, containerSearch, containers]);
  const visibleImages = useMemo(() => images.filter((image) => matchesImageQuery(image, imageSearch.trim())), [imageSearch, images]);
  const visibleComposeProjects = useMemo(() => {
    const query = composeSearch.trim().toLowerCase();
    if (!query) return composeProjects;
    return composeProjects.filter((project) => [project.name, project.status, project.configFiles, project.workingDir].join(' ').toLowerCase().includes(query));
  }, [composeProjects, composeSearch]);
  const visibleNetworks = useMemo(() => {
    const query = networkSearch.trim().toLowerCase();
    if (!query) return networks;
    return networks.filter((network) => [network.id, network.name, network.driver, network.scope, network.labels].join(' ').toLowerCase().includes(query));
  }, [networkSearch, networks]);
  const visibleVolumes = useMemo(() => {
    const query = volumeSearch.trim().toLowerCase();
    if (!query) return volumes;
    return volumes.filter((volume) => [volume.name, volume.driver, volume.mountpoint, volume.scope, volume.labels].join(' ').toLowerCase().includes(query));
  }, [volumeSearch, volumes]);
  const containerStats = useMemo(() => ({
    running: containers.filter((container) => container.state === 'running').length,
    exited: containers.filter((container) => container.state === 'exited').length,
    paused: containers.filter((container) => container.state === 'paused').length,
    created: containers.filter((container) => container.state === 'created').length,
  }), [containers]);

  const copyToClipboard = async (value: string, label: string) => {
    setError('');
    setSuccess('');
    try {
      await navigator.clipboard.writeText(value);
      setSuccess(t('container.message.copied', language, { label }));
    } catch (err) {
      setError(t('container.error.copyFailed', language, { error: getErrorMessage(err) }));
    }
  };

  const prepareRunFromImage = (image: ImageSummary) => {
    const imageRef = getImageReference(image);
    setRunError('');
    setRunTroubleshooting(null);
    setRunInitialImage(imageRef);
    setActiveTab('containers');
    setRunPanelOpen(true);
  };

  const openRunDialog = () => {
    setActiveTab('containers');
    setRunError('');
    setRunTroubleshooting(null);
    setRunInitialImage('');
    setRunPanelOpen(true);
  };

  const executeRunContainer = async (form: ContainerRunFormState) => {
    let args: string[];
    try {
      args = buildContainerRunArgs(form, language);
    } catch (err) {
      setRunError(getErrorMessage(err));
      setRunTroubleshooting(null);
      return;
    }
    setRunningContainer(true);
    setRunError('');
    setNotice('');
    setSuccess('');
    setRunTroubleshooting(null);
    try {
      const activeRuntime = await detectRuntime({ suppressGlobalError: true });
      const result = await runCommand(getRuntimeCliCommand(activeRuntime, args, isWindowsHost));
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (result.code !== 0) {
        if (isDockerNetworkTrouble(output, activeRuntime)) {
          const repairCommand = [buildDockerDaemonRestartCommand(language), formatRuntimeCommand(activeRuntime, args)].join('\n');
          setRunTroubleshooting(createDockerNetworkTroubleshooting(output, repairCommand, language));
          throw new Error(t('container.error.dockerNetworkTrouble', language));
        }
        throw new Error(output || t('container.error.runFailed', language));
      }
      const preferredContainerName = form.name.trim();
      setSuccess(t(form.createOnly ? 'container.success.containerCreated' : 'container.success.containerStarted', language, { name: preferredContainerName || formatShortId(output) }));
      setActiveTab('containers');
      setRunPanelOpen(false);
      const nextSelectedContainerId = await refreshContainers({ runtimeOverride: activeRuntime, silent: true, preferredContainerId: output, preferredContainerName });
      if (nextSelectedContainerId) {
        setSelectedContainerId(nextSelectedContainerId);
        await loadContainerDetail(nextSelectedContainerId);
      }
    } catch (err) {
      setRunError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setRunningContainer(false);
    }
  };

  const executeConfigUpdate = async (configForm: ContainerConfigForm) => {
    if (!selectedContainer || !selectedDetail) {
      setError(t('container.error.selectContainer', language));
      return;
    }
    let commandGroups: string[][];
    try {
      commandGroups = buildContainerConfigCommandGroups(selectedContainer.id, configForm, selectedDetail, language);
    } catch (err) {
      setError(getErrorMessage(err));
      return;
    }
    setSavingConfig(true);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getContainerConfigUpdateCommand(activeRuntime, commandGroups, isWindowsHost));
      const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      if (result.code !== 0) throw new Error(output || t('container.error.configFailed', language));
      const preferredContainerName = configForm.name.trim();
      setSuccess(t('container.success.configSaved', language, { name: preferredContainerName || selectedContainer.name }));
      const nextSelectedContainerId = await refreshContainers({ runtimeOverride: activeRuntime, silent: true, preferredContainerId: selectedContainer.id, preferredContainerName });
      if (nextSelectedContainerId) await loadContainerDetail(nextSelectedContainerId);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setSavingConfig(false);
    }
  };

  const executeContainerAction = async (action: ContainerAction, container: ContainerSummary) => {
    setActingKey(`${action}:${container.id}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getContainerActionCommand(activeRuntime, action, container.id, isWindowsHost));
      if (result.code !== 0) {
        const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
        const nextTroubleshooting = createContainerTroubleshooting(output, activeRuntime, action, container, language);
        if (nextTroubleshooting) {
          setTroubleshooting(nextTroubleshooting);
          throw new Error(t('container.error.dockerNetworkTrouble', language));
        }
        throw new Error(output || t('container.error.operationFailed', language));
      }
      setSuccess(`${t(containerActionLabels[action].successId, language)}: ${container.name}`);
      const nextSelectedContainerId = await refreshContainers({ runtimeOverride: activeRuntime, silent: true, preferredContainerId: action === 'remove' ? '' : container.id });
      if (action !== 'remove' && nextSelectedContainerId) await loadContainerDetail(nextSelectedContainerId);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const requestContainerAction = (action: ContainerAction) => {
    if (!selectedContainer) return;
    if (action === 'remove') {
      setPendingAction({ kind: 'container', action, container: selectedContainer });
      return;
    }
    void executeContainerAction(action, selectedContainer);
  };

  const executeImagePull = async () => {
    const imageName = pullImageName.trim();
    if (!imageName) {
      setError(t('container.error.imageRequired', language));
      return;
    }
    setPulling(true);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getImagePullCommand(activeRuntime, imageName, isWindowsHost));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || t('container.error.pullFailed', language));
      setSuccess(t('container.success.imagePulled', language, { image: imageName }));
      setPullImageName('');
      await refreshImages({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setPulling(false);
    }
  };

  const executeImagePrune = async () => {
    setPruningImages(true);
    setImagePruneError('');
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    try {
      const activeRuntime = await detectRuntime({ suppressGlobalError: true });
      const result = await runCommand(getRuntimeCliCommand(activeRuntime, buildImagePruneArgs(imagePruneMode), isWindowsHost));
      const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      if (result.code !== 0) throw new Error(output || t('container.error.pruneImagesFailed', language));
      const selectedPruneOption = imagePruneOptions.find((option) => option.value === imagePruneMode) ?? imagePruneOptions[0];
      setSuccess(t('container.success.imagesPruned', language, { scope: t(selectedPruneOption.labelId, language) }));
      setImagePruneDialogOpen(false);
      await refreshImages({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      if (isMountedRef.current) setImagePruneError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setPruningImages(false);
    }
  };

  const executeImageRemove = async (image: ImageSummary) => {
    const imageRef = getImageReference(image);
    setActingKey(`image-remove:${image.id}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getImageRemoveCommand(activeRuntime, imageRef, isWindowsHost));
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || t('container.error.removeImageFailed', language));
      setSuccess(t('container.success.imageRemoved', language, { image: imageRef }));
      await refreshImages({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const runResourceCommand = async (args: string[], fallbackError: string) => {
    const activeRuntime = await detectRuntime();
    const result = await runCommand(getRuntimeCliCommand(activeRuntime, args, isWindowsHost));
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (result.code !== 0) {
      throw new Error(output || fallbackError);
    }
    return { activeRuntime, output };
  };

  const executeComposeCreate = async () => {
    let args: string[];
    try {
      args = buildComposeUpArgs(composeForm, language);
    } catch (err) {
      setError(getErrorMessage(err));
      return;
    }
    setActingKey('compose-create');
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setResourceOutput(null);
    try {
      const { activeRuntime, output } = await runResourceCommand(args, t('container.error.composeUpFailed', language));
      const projectName = composeForm.projectName.trim() || composeForm.workingDir.trim() || composeForm.configFile.trim();
      setSuccess(t('container.success.composeUp', language, { name: projectName }));
      if (output) setResourceOutput({ title: t('container.output.composeUp', language), output });
      setComposePanelOpen(false);
      setComposeForm(createDefaultComposeForm());
      await refreshComposeProjects({ runtimeOverride: activeRuntime, silent: true });
      await refreshContainers({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setActingKey('');
    }
  };

  const executeComposeAction = async (project: ComposeProjectSummary, action: ComposeProjectAction) => {
    setActingKey(`compose-${action}:${project.id}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setResourceOutput(null);
    try {
      const { activeRuntime, output } = await runResourceCommand(buildComposeProjectActionArgs(project, action), t('container.error.composeActionFailed', language));
      setSuccess(t('container.success.composeAction', language, { action: t(`container.compose.${action}` as MessageId, language), name: project.name }));
      if (output) setResourceOutput({ title: t('container.output.composeAction', language, { name: project.name }), output });
      await refreshComposeProjects({ runtimeOverride: activeRuntime, silent: true });
      await refreshContainers({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const executeNetworkCreate = async () => {
    let args: string[];
    try {
      args = buildNetworkCreateArgs(networkForm, language);
    } catch (err) {
      setError(getErrorMessage(err));
      return;
    }
    const networkName = networkForm.name.trim();
    setActingKey('network-create');
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setResourceOutput(null);
    try {
      const { activeRuntime, output } = await runResourceCommand(args, t('container.error.networkCreateFailed', language));
      setSuccess(t('container.success.networkCreated', language, { name: networkName }));
      if (output) setResourceOutput({ title: t('container.output.networkCreate', language), output });
      setNetworkPanelOpen(false);
      setNetworkForm(createDefaultNetworkForm());
      await refreshNetworks({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setActingKey('');
    }
  };

  const executeNetworkRemove = async (network: ContainerNetworkSummary) => {
    setActingKey(`network-remove:${network.id}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setResourceOutput(null);
    try {
      const { activeRuntime, output } = await runResourceCommand(buildNetworkRemoveArgs(network), t('container.error.networkRemoveFailed', language));
      setSuccess(t('container.success.networkRemoved', language, { name: network.name }));
      if (output) setResourceOutput({ title: t('container.output.networkRemove', language), output });
      await refreshNetworks({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const executeNetworkInspect = async (network: ContainerNetworkSummary) => {
    setActingKey(`network-inspect:${network.id}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    try {
      const { output } = await runResourceCommand(buildNetworkInspectArgs(network), t('container.error.networkInspectFailed', language));
      setResourceOutput({ title: t('container.output.networkInspect', language, { name: network.name }), output: output || '-' });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setActingKey('');
    }
  };

  const executeNetworkPrune = async () => {
    setActingKey('network-prune');
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setResourceOutput(null);
    try {
      const { activeRuntime, output } = await runResourceCommand(buildNetworkPruneArgs(), t('container.error.networkPruneFailed', language));
      setSuccess(t('container.success.networksPruned', language));
      if (output) setResourceOutput({ title: t('container.output.networkPrune', language), output });
      await refreshNetworks({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const executeVolumeCreate = async () => {
    let args: string[];
    try {
      args = buildVolumeCreateArgs(volumeForm, language);
    } catch (err) {
      setError(getErrorMessage(err));
      return;
    }
    const volumeName = volumeForm.name.trim();
    setActingKey('volume-create');
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setResourceOutput(null);
    try {
      const { activeRuntime, output } = await runResourceCommand(args, t('container.error.volumeCreateFailed', language));
      setSuccess(t('container.success.volumeCreated', language, { name: volumeName }));
      if (output) setResourceOutput({ title: t('container.output.volumeCreate', language), output });
      setVolumePanelOpen(false);
      setVolumeForm(createDefaultVolumeForm());
      await refreshVolumes({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setActingKey('');
    }
  };

  const executeVolumeRemove = async (volume: ContainerVolumeSummary) => {
    setActingKey(`volume-remove:${volume.name}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setResourceOutput(null);
    try {
      const { activeRuntime, output } = await runResourceCommand(buildVolumeRemoveArgs(volume), t('container.error.volumeRemoveFailed', language));
      setSuccess(t('container.success.volumeRemoved', language, { name: volume.name }));
      if (output) setResourceOutput({ title: t('container.output.volumeRemove', language), output });
      await refreshVolumes({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const executeVolumeInspect = async (volume: ContainerVolumeSummary) => {
    setActingKey(`volume-inspect:${volume.name}`);
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    try {
      const { output } = await runResourceCommand(buildVolumeInspectArgs(volume), t('container.error.volumeInspectFailed', language));
      setResourceOutput({ title: t('container.output.volumeInspect', language, { name: volume.name }), output: output || '-' });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) setActingKey('');
    }
  };

  const executeVolumePrune = async () => {
    setActingKey('volume-prune');
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    setResourceOutput(null);
    try {
      const { activeRuntime, output } = await runResourceCommand(buildVolumePruneArgs(), t('container.error.volumePruneFailed', language));
      setSuccess(t('container.success.volumesPruned', language));
      if (output) setResourceOutput({ title: t('container.output.volumePrune', language), output });
      await refreshVolumes({ runtimeOverride: activeRuntime, silent: true });
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      if (isMountedRef.current) {
        setActingKey('');
        setPendingAction(null);
      }
    }
  };

  const executeContainerExec = async (command: string) => {
    if (!selectedContainer || !command.trim()) {
      setError(selectedContainer ? t('container.error.execRequired', language) : t('container.error.selectContainer', language));
      throw new Error('container exec unavailable');
    }
    setError('');
    setNotice('');
    setSuccess('');
    setTroubleshooting(null);
    try {
      const activeRuntime = await detectRuntime();
      const result = await runCommand(getContainerExecCommand(activeRuntime, selectedContainer.id, command.trim(), isWindowsHost));
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (result.code !== 0) setNotice(t('container.exec.noticeExit', language, { code: result.code }));
      else setSuccess(t('container.exec.success', language, { name: selectedContainer.name }));
      return { output, code: result.code };
    } catch (err) {
      setError(getErrorMessage(err));
      throw err;
    }
  };

  const readContainerLogs = useCallback(async (containerId: string, options?: { tail?: number; sinceSeconds?: number }) => {
    const activeRuntime = await detectRuntime();
    const result = await runCommand(getContainerLogsCommand(activeRuntime, containerId, isWindowsHost, options?.tail ?? 200, options?.sinceSeconds));
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (result.code !== 0) throw new Error(output || t('container.error.logsFailed', language));
    return output;
  }, [detectRuntime, isWindowsHost, language, runCommand]);

  const refreshCurrentContainer = async () => {
    const nextSelectedContainerId = await refreshContainers({ silent: true, preferredContainerId: selectedContainerId });
    if (nextSelectedContainerId) await loadContainerDetail(nextSelectedContainerId);
  };

  const refreshActiveTab = () => {
    if (activeTab === 'images') return refreshImages();
    if (activeTab === 'compose') return refreshComposeProjects();
    if (activeTab === 'networks') return refreshNetworks();
    if (activeTab === 'volumes') return refreshVolumes();
    return refreshContainers();
  };

  const renderToolbarRight = () => {
    if (activeTab === 'images') {
      return (
        <>
          <input type="search" className="container-search" placeholder={t('container.ui.searchImages', language)} value={imageSearch} onChange={(event) => setImageSearch(event.target.value)} />
          <input type="text" className="container-pull-input" placeholder="nginx:latest" value={pullImageName} onChange={(event) => setPullImageName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void executeImagePull(); }} aria-label={t('container.ui.pullImageAria', language)} />
          <button type="button" className="container-tool-button primary" onClick={() => void executeImagePull()} disabled={pulling}>{pulling ? t('container.ui.pulling', language) : 'Pull'}</button>
          <button type="button" className="container-tool-button danger" onClick={() => { setImagePruneError(''); setPendingAction(null); setImagePruneDialogOpen(true); }} disabled={pruningImages}>{pruningImages ? t('container.ui.pruning', language) : t('container.ui.pruneImages', language)}</button>
        </>
      );
    }
    if (activeTab === 'compose') {
      return (
        <>
          <input type="search" className="container-search" placeholder={t('container.ui.searchCompose', language)} value={composeSearch} onChange={(event) => setComposeSearch(event.target.value)} />
          <button type="button" className="container-tool-button primary" onClick={() => setComposePanelOpen(true)}>{t('container.ui.newCompose', language)}</button>
        </>
      );
    }
    if (activeTab === 'networks') {
      return (
        <>
          <input type="search" className="container-search" placeholder={t('container.ui.searchNetworks', language)} value={networkSearch} onChange={(event) => setNetworkSearch(event.target.value)} />
          <button type="button" className="container-tool-button primary" onClick={() => setNetworkPanelOpen(true)}>{t('container.ui.newNetwork', language)}</button>
          <button type="button" className="container-tool-button danger" disabled={actingKey === 'network-prune'} onClick={() => setPendingAction({ kind: 'network-prune' })}>{actingKey === 'network-prune' ? t('container.ui.pruning', language) : t('container.ui.pruneNetworks', language)}</button>
        </>
      );
    }
    if (activeTab === 'volumes') {
      return (
        <>
          <input type="search" className="container-search" placeholder={t('container.ui.searchVolumes', language)} value={volumeSearch} onChange={(event) => setVolumeSearch(event.target.value)} />
          <button type="button" className="container-tool-button primary" onClick={() => setVolumePanelOpen(true)}>{t('container.ui.newVolume', language)}</button>
          <button type="button" className="container-tool-button danger" disabled={actingKey === 'volume-prune'} onClick={() => setPendingAction({ kind: 'volume-prune' })}>{actingKey === 'volume-prune' ? t('container.ui.pruning', language) : t('container.ui.pruneVolumes', language)}</button>
        </>
      );
    }
    return (
      <>
        <select className="container-select" value={containerFilter} onChange={(event) => setContainerFilter(event.target.value as ContainerFilter)} aria-label={t('container.ui.filterAria', language)}>{containerFilters.map((item) => <option key={item.key} value={item.key}>{t(item.labelId, language)}</option>)}</select>
        <input type="search" className="container-search" placeholder={t('container.ui.searchContainers', language)} value={containerSearch} onChange={(event) => setContainerSearch(event.target.value)} />
      </>
    );
  };

  const imagePruneCommandPreview = formatRuntimeCommand(runtime ?? 'docker', buildImagePruneArgs(imagePruneMode));
  const activeLoading = runtimeLoading || containersLoading || imagesLoading || composeLoading || networksLoading || volumesLoading;
  const activeVisibleCount = activeTab === 'images'
    ? visibleImages.length
    : activeTab === 'compose'
      ? visibleComposeProjects.length
      : activeTab === 'networks'
        ? visibleNetworks.length
        : activeTab === 'volumes'
          ? visibleVolumes.length
          : visibleContainers.length;
  const activeTotalCount = activeTab === 'images'
    ? images.length
    : activeTab === 'compose'
      ? composeProjects.length
      : activeTab === 'networks'
        ? networks.length
        : activeTab === 'volumes'
          ? volumes.length
          : containers.length;
  const composeCommandPreview = useMemo(() => {
    try {
      return formatRuntimeCommand(runtime ?? 'docker', buildComposeUpArgs(composeForm, language));
    } catch {
      return '';
    }
  }, [composeForm, language, runtime]);
  const networkCommandPreview = useMemo(() => {
    try {
      return formatRuntimeCommand(runtime ?? 'docker', buildNetworkCreateArgs(networkForm, language));
    } catch {
      return '';
    }
  }, [language, networkForm, runtime]);
  const volumeCommandPreview = useMemo(() => {
    try {
      return formatRuntimeCommand(runtime ?? 'docker', buildVolumeCreateArgs(volumeForm, language));
    } catch {
      return '';
    }
  }, [language, runtime, volumeForm]);

  const renderResourceOutput = () => resourceOutput ? (
    <section className="container-resource-output">
      <header>
        <strong>{resourceOutput.title}</strong>
        <div>
          <button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(resourceOutput.output, resourceOutput.title)}>{t('container.ui.copy', language)}</button>
          <button type="button" className="container-copy-btn" onClick={() => setResourceOutput(null)}>{t('common.close', language)}</button>
        </div>
      </header>
      <pre>{resourceOutput.output}</pre>
    </section>
  ) : null;

  const getPendingActionTitle = () => {
    if (!pendingAction) return '';
    if (pendingAction.kind === 'container') return t('container.modal.removeContainer', language);
    if (pendingAction.kind === 'image') return t('container.modal.removeImage', language);
    if (pendingAction.kind === 'compose') return t('container.modal.composeDown', language);
    if (pendingAction.kind === 'network') return t('container.modal.removeNetwork', language);
    if (pendingAction.kind === 'network-prune') return t('container.modal.pruneNetworks', language);
    if (pendingAction.kind === 'volume') return t('container.modal.removeVolume', language);
    return t('container.modal.pruneVolumes', language);
  };

  const executePendingAction = () => {
    if (!pendingAction) return;
    if (pendingAction.kind === 'container') void executeContainerAction(pendingAction.action, pendingAction.container);
    else if (pendingAction.kind === 'image') void executeImageRemove(pendingAction.image);
    else if (pendingAction.kind === 'compose') void executeComposeAction(pendingAction.project, pendingAction.action);
    else if (pendingAction.kind === 'network') void executeNetworkRemove(pendingAction.network);
    else if (pendingAction.kind === 'network-prune') void executeNetworkPrune();
    else if (pendingAction.kind === 'volume') void executeVolumeRemove(pendingAction.volume);
    else void executeVolumePrune();
  };

  return (
    <div className="container-manager">
      <div className="container-toolbar">
        <div className="container-toolbar-left">
          <button type="button" className="container-tool-button primary" onClick={() => void refreshActiveTab()} disabled={activeLoading}>{activeLoading ? t('container.ui.refreshing', language) : t('container.ui.refresh', language)}</button>
          <button type="button" className="container-tool-button" onClick={() => void refreshCurrentContainer()} disabled={!selectedContainer || detailLoading}>{detailLoading ? t('container.ui.reading', language) : t('container.ui.refreshCurrent', language)}</button>
          <button type="button" className="container-tool-button primary" onClick={openRunDialog}>{t('container.ui.newContainer', language)}</button>
          <span className="container-runtime-pill">{getRuntimeLabel(runtime, language)}</span>
          <span className="container-summary"><strong>{activeVisibleCount}</strong> / {activeTotalCount}</span>
        </div>
        <div className="container-tabs" role="tablist" aria-label={t('container.ui.tabsAria', language)}>{managerTabs.map((tab) => <button key={tab.key} type="button" role="tab" className={activeTab === tab.key ? 'active' : ''} title={t(tab.labelId, language)} onClick={() => setActiveTab(tab.key)}>{t(tab.labelId, language)}</button>)}</div>
        <div className="container-toolbar-right">{renderToolbarRight()}</div>
      </div>

      {error ? <DismissibleAlert className="container-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="container-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}
      {success ? <DismissibleAlert className="container-alert success" onDismiss={() => setSuccess('')}>{success}</DismissibleAlert> : null}
      {troubleshooting ? <section className="container-troubleshooting" aria-label={t('container.ui.troubleshootingAria', language)}><div><strong>{troubleshooting.title}</strong><p>{troubleshooting.message}</p></div><div className="container-troubleshooting-actions"><button type="button" className="container-tool-button" onClick={() => void copyToClipboard(troubleshooting.commands, t('container.ui.copyFixCommandLabel', language))}>{t('container.ui.copyFixCommand', language)}</button><button type="button" className="container-tool-button" onClick={() => void copyToClipboard(troubleshooting.rawOutput, t('container.ui.copyRawErrorLabel', language))}>{t('container.ui.copyRawError', language)}</button></div><pre>{troubleshooting.commands}</pre></section> : null}
      {activeTab === 'containers' && runPanelOpen ? <ContainerRunForm connectionId={connectionId} systemType={systemType} runtime={runtime} initialImage={runInitialImage} running={runningContainer} error={runError} troubleshooting={runTroubleshooting} onSubmit={executeRunContainer} onCancel={() => setRunPanelOpen(false)} onResetError={() => setRunError('')} onCopy={copyToClipboard} /> : null}

      {activeTab === 'containers' ? (
        <div className="container-content">
          <aside className="container-list-panel" aria-label={t('container.ui.containerListAria', language)}>
            <div className="container-stats"><span><strong>{containerStats.running}</strong> {t('container.ui.runningCount', language)}</span><span><strong>{containerStats.exited}</strong> {t('container.ui.exitedCount', language)}</span><span><strong>{containerStats.paused}</strong> {t('container.ui.pausedCount', language)}</span><span><strong>{containerStats.created}</strong> {t('container.ui.createdCount', language)}</span></div>
            <div className="container-list">{visibleContainers.length === 0 ? <div className="container-empty">{containersLoading ? t('container.ui.loadingContainers', language) : t('container.ui.noContainers', language)}</div> : visibleContainers.map((container) => <button key={container.id} type="button" className={`container-list-item ${container.id === selectedContainerId ? 'selected' : ''}`} onClick={() => setSelectedContainerId(container.id)}><span className={`container-state-dot ${container.state}`} /><span className="container-list-main"><strong title={container.name}>{container.name}</strong><small title={container.image}>{container.image}</small></span><span className={`container-state-tag ${container.state}`}>{getStateLabel(container.state, language)}</span></button>)}</div>
          </aside>
          <ContainerDetailPanel container={selectedContainer} detail={selectedDetail} detailLoading={detailLoading} containersLoading={containersLoading} actingKey={actingKey} savingConfig={savingConfig} onAction={requestContainerAction} onReload={loadContainerDetail} onCopy={copyToClipboard} onConfigSubmit={executeConfigUpdate} onExec={executeContainerExec} onReadLogs={readContainerLogs} />
        </div>
      ) : null}

      {activeTab === 'images' ? (
        <div className="container-images-panel" aria-label={t('container.ui.imageListAria', language)}>
          <div className="container-image-table-wrap"><table className="container-image-table"><thead><tr><th className="container-image-repo">{t('container.ui.repository', language)}</th><th className="container-image-tag">{t('container.ui.tag', language)}</th><th className="container-image-id">ID</th><th className="container-image-size">{t('container.ui.size', language)}</th><th className="container-image-created">{t('container.ui.createdAt', language)}</th><th className="container-image-actions">{t('container.ui.operations', language)}</th></tr></thead><tbody>{visibleImages.length === 0 ? <tr><td colSpan={6} className="container-table-empty">{imagesLoading ? t('container.ui.loadingImages', language) : t('container.ui.noImages', language)}</td></tr> : visibleImages.map((image) => <tr key={`${image.id}:${image.repository}:${image.tag}`}><td title={image.repository}>{image.repository}</td><td title={image.tag}>{image.tag}</td><td title={image.id}><code>{formatShortId(image.id)}</code></td><td>{image.size}</td><td title={image.createdAt}>{image.createdAt || '-'}</td><td><div className="container-image-actions-cell"><button type="button" className="container-table-action" onClick={() => prepareRunFromImage(image)}>{t('container.ui.run', language)}</button><button type="button" className="container-table-danger" disabled={Boolean(actingKey)} onClick={() => setPendingAction({ kind: 'image', action: 'remove', image })}>{actingKey === `image-remove:${image.id}` ? t('container.ui.removing', language) : t('container.action.remove', language)}</button></div></td></tr>)}</tbody></table></div>
        </div>
      ) : null}

      {activeTab === 'compose' ? (
        <div className="container-images-panel container-resource-panel" aria-label={t('container.ui.composeListAria', language)}>
          {composePanelOpen ? <section className="container-resource-workbench" aria-label={t('container.ui.composeWorkbenchAria', language)}><header className="container-workbench-header"><div><strong>{t('container.ui.newCompose', language)}</strong><span>{t('container.ui.composeWorkbenchHint', language)}</span></div><button type="button" className="container-tool-button" onClick={() => setComposeForm(createDefaultComposeForm())}>{t('container.ui.reset', language)}</button></header><div className="container-resource-grid"><label><span>{t('container.ui.projectName', language)}</span><input value={composeForm.projectName} onChange={(event) => setComposeForm((form) => ({ ...form, projectName: event.target.value }))} placeholder="webapp" /></label><label><span>{t('container.ui.workingDir', language)}</span><input value={composeForm.workingDir} onChange={(event) => setComposeForm((form) => ({ ...form, workingDir: event.target.value }))} placeholder="/opt/webapp" /></label><label className="wide"><span>{t('container.ui.configFiles', language)}</span><input value={composeForm.configFile} onChange={(event) => setComposeForm((form) => ({ ...form, configFile: event.target.value }))} placeholder="/opt/webapp/docker-compose.yml" /></label><label><span>{t('container.ui.envFile', language)}</span><input value={composeForm.envFile} onChange={(event) => setComposeForm((form) => ({ ...form, envFile: event.target.value }))} placeholder=".env" /></label><label className="wide"><span>{t('container.ui.composeServices', language)}</span><input value={composeForm.services} onChange={(event) => setComposeForm((form) => ({ ...form, services: event.target.value }))} placeholder="api worker" /></label></div><div className="container-run-options"><label><input type="checkbox" checked={composeForm.build} onChange={(event) => setComposeForm((form) => ({ ...form, build: event.target.checked }))} />{t('container.ui.composeBuild', language)}</label><label><input type="checkbox" checked={composeForm.pull} onChange={(event) => setComposeForm((form) => ({ ...form, pull: event.target.checked }))} />{t('container.ui.composePullAlways', language)}</label><label><input type="checkbox" checked={composeForm.removeOrphans} onChange={(event) => setComposeForm((form) => ({ ...form, removeOrphans: event.target.checked }))} />{t('container.ui.removeOrphans', language)}</label></div>{composeCommandPreview ? <div className="container-command-preview"><header><span>{t('container.ui.commandPreview', language)}</span><button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(composeCommandPreview, t('container.ui.commandPreview', language))}>{t('container.ui.copy', language)}</button></header><pre>{composeCommandPreview}</pre></div> : null}<div className="container-workbench-actions"><button type="button" className="container-tool-button" onClick={() => setComposePanelOpen(false)}>{t('common.cancel', language)}</button><button type="button" className="container-tool-button primary" disabled={actingKey === 'compose-create'} onClick={() => void executeComposeCreate()}>{actingKey === 'compose-create' ? t('container.ui.processing', language) : t('container.ui.composeUpDetached', language)}</button></div></section> : null}
          {renderResourceOutput()}
          <div className="container-image-table-wrap"><table className="container-image-table container-resource-table container-compose-table"><thead><tr><th>{t('container.ui.project', language)}</th><th>{t('container.ui.status', language)}</th><th>{t('container.ui.configFiles', language)}</th><th>{t('container.ui.workingDir', language)}</th><th>{t('container.ui.operations', language)}</th></tr></thead><tbody>{visibleComposeProjects.length === 0 ? <tr><td colSpan={5} className="container-table-empty">{composeLoading ? t('container.ui.loadingCompose', language) : t('container.ui.noCompose', language)}</td></tr> : visibleComposeProjects.map((project) => <tr key={project.id}><td title={project.name}><strong>{project.name}</strong></td><td title={project.status}>{project.status}</td><td title={project.configFiles}>{project.configFiles}</td><td title={project.workingDir}>{project.workingDir}</td><td><div className="container-resource-actions">{composeProjectActions.map((item) => <button key={item.action} type="button" className={item.danger ? 'container-table-danger' : 'container-table-action'} disabled={Boolean(actingKey)} onClick={() => { if (item.action === 'down') setPendingAction({ kind: 'compose', action: 'down', project }); else void executeComposeAction(project, item.action); }}>{actingKey === `compose-${item.action}:${project.id}` ? t('container.ui.processing', language) : t(item.labelId, language)}</button>)}</div></td></tr>)}</tbody></table></div>
        </div>
      ) : null}

      {activeTab === 'networks' ? (
        <div className="container-images-panel container-resource-panel" aria-label={t('container.ui.networkListAria', language)}>
          {networkPanelOpen ? <section className="container-resource-workbench" aria-label={t('container.ui.networkWorkbenchAria', language)}><header className="container-workbench-header"><div><strong>{t('container.ui.newNetwork', language)}</strong><span>{t('container.ui.networkWorkbenchHint', language)}</span></div><button type="button" className="container-tool-button" onClick={() => setNetworkForm(createDefaultNetworkForm())}>{t('container.ui.reset', language)}</button></header><div className="container-resource-grid"><label><span>{t('container.ui.networkName', language)}</span><input value={networkForm.name} onChange={(event) => setNetworkForm((form) => ({ ...form, name: event.target.value }))} placeholder="app-net" /></label><label><span>{t('container.ui.driver', language)}</span><input value={networkForm.driver} onChange={(event) => setNetworkForm((form) => ({ ...form, driver: event.target.value }))} placeholder="bridge" /></label><label><span>{t('container.ui.subnet', language)}</span><input value={networkForm.subnet} onChange={(event) => setNetworkForm((form) => ({ ...form, subnet: event.target.value }))} placeholder="172.30.0.0/16" /></label><label><span>{t('container.ui.gateway', language)}</span><input value={networkForm.gateway} onChange={(event) => setNetworkForm((form) => ({ ...form, gateway: event.target.value }))} placeholder="172.30.0.1" /></label><label><span>{t('container.ui.ipRange', language)}</span><input value={networkForm.ipRange} onChange={(event) => setNetworkForm((form) => ({ ...form, ipRange: event.target.value }))} placeholder="172.30.5.0/24" /></label><label className="wide"><span>{t('container.ui.labels', language)}</span><textarea value={networkForm.labels} onChange={(event) => setNetworkForm((form) => ({ ...form, labels: event.target.value }))} placeholder="owner=shelldesk" /></label><label className="wide"><span>{t('container.ui.options', language)}</span><textarea value={networkForm.options} onChange={(event) => setNetworkForm((form) => ({ ...form, options: event.target.value }))} placeholder="com.docker.network.bridge.name=br-app" /></label></div><div className="container-run-options"><label><input type="checkbox" checked={networkForm.internal} onChange={(event) => setNetworkForm((form) => ({ ...form, internal: event.target.checked }))} />{t('container.ui.internal', language)}</label><label><input type="checkbox" checked={networkForm.attachable} onChange={(event) => setNetworkForm((form) => ({ ...form, attachable: event.target.checked }))} />{t('container.ui.attachable', language)}</label><label><input type="checkbox" checked={networkForm.ipv6} onChange={(event) => setNetworkForm((form) => ({ ...form, ipv6: event.target.checked }))} />{t('container.ui.ipv6', language)}</label></div>{networkCommandPreview ? <div className="container-command-preview"><header><span>{t('container.ui.commandPreview', language)}</span><button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(networkCommandPreview, t('container.ui.commandPreview', language))}>{t('container.ui.copy', language)}</button></header><pre>{networkCommandPreview}</pre></div> : null}<div className="container-workbench-actions"><button type="button" className="container-tool-button" onClick={() => setNetworkPanelOpen(false)}>{t('common.cancel', language)}</button><button type="button" className="container-tool-button primary" disabled={actingKey === 'network-create'} onClick={() => void executeNetworkCreate()}>{actingKey === 'network-create' ? t('container.ui.processing', language) : t('container.ui.createNetwork', language)}</button></div></section> : null}
          {renderResourceOutput()}
          <div className="container-image-table-wrap"><table className="container-image-table container-resource-table container-network-table"><thead><tr><th>{t('container.ui.name', language)}</th><th>ID</th><th>{t('container.ui.driver', language)}</th><th>{t('container.ui.scope', language)}</th><th>{t('container.ui.ipv6', language)}</th><th>{t('container.ui.labels', language)}</th><th>{t('container.ui.operations', language)}</th></tr></thead><tbody>{visibleNetworks.length === 0 ? <tr><td colSpan={7} className="container-table-empty">{networksLoading ? t('container.ui.loadingNetworks', language) : t('container.ui.noNetworks', language)}</td></tr> : visibleNetworks.map((network) => <tr key={network.id}><td title={network.name}><strong>{network.name}</strong></td><td title={network.id}><code>{formatShortId(network.id)}</code></td><td>{network.driver}</td><td>{network.scope}</td><td>{network.ipv6}</td><td title={network.labels}>{network.labels}</td><td><div className="container-resource-actions"><button type="button" className="container-table-action" disabled={Boolean(actingKey)} onClick={() => void executeNetworkInspect(network)}>{actingKey === `network-inspect:${network.id}` ? t('container.ui.reading', language) : t('container.ui.inspect', language)}</button><button type="button" className="container-table-danger" disabled={Boolean(actingKey) || isDefaultContainerNetwork(network)} onClick={() => setPendingAction({ kind: 'network', action: 'remove', network })}>{actingKey === `network-remove:${network.id}` ? t('container.ui.removing', language) : t('container.action.remove', language)}</button></div></td></tr>)}</tbody></table></div>
        </div>
      ) : null}

      {activeTab === 'volumes' ? (
        <div className="container-images-panel container-resource-panel" aria-label={t('container.ui.volumeListAria', language)}>
          {volumePanelOpen ? <section className="container-resource-workbench" aria-label={t('container.ui.volumeWorkbenchAria', language)}><header className="container-workbench-header"><div><strong>{t('container.ui.newVolume', language)}</strong><span>{t('container.ui.volumeWorkbenchHint', language)}</span></div><button type="button" className="container-tool-button" onClick={() => setVolumeForm(createDefaultVolumeForm())}>{t('container.ui.reset', language)}</button></header><div className="container-resource-grid"><label><span>{t('container.ui.volumeName', language)}</span><input value={volumeForm.name} onChange={(event) => setVolumeForm((form) => ({ ...form, name: event.target.value }))} placeholder="app-data" /></label><label><span>{t('container.ui.driver', language)}</span><input value={volumeForm.driver} onChange={(event) => setVolumeForm((form) => ({ ...form, driver: event.target.value }))} placeholder="local" /></label><label className="wide"><span>{t('container.ui.labels', language)}</span><textarea value={volumeForm.labels} onChange={(event) => setVolumeForm((form) => ({ ...form, labels: event.target.value }))} placeholder="owner=shelldesk" /></label><label className="wide"><span>{t('container.ui.options', language)}</span><textarea value={volumeForm.options} onChange={(event) => setVolumeForm((form) => ({ ...form, options: event.target.value }))} placeholder="type=nfs" /></label></div>{volumeCommandPreview ? <div className="container-command-preview"><header><span>{t('container.ui.commandPreview', language)}</span><button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(volumeCommandPreview, t('container.ui.commandPreview', language))}>{t('container.ui.copy', language)}</button></header><pre>{volumeCommandPreview}</pre></div> : null}<div className="container-workbench-actions"><button type="button" className="container-tool-button" onClick={() => setVolumePanelOpen(false)}>{t('common.cancel', language)}</button><button type="button" className="container-tool-button primary" disabled={actingKey === 'volume-create'} onClick={() => void executeVolumeCreate()}>{actingKey === 'volume-create' ? t('container.ui.processing', language) : t('container.ui.createVolume', language)}</button></div></section> : null}
          {renderResourceOutput()}
          <div className="container-image-table-wrap"><table className="container-image-table container-resource-table container-volume-table"><thead><tr><th>{t('container.ui.name', language)}</th><th>{t('container.ui.driver', language)}</th><th>{t('container.ui.mountpoint', language)}</th><th>{t('container.ui.scope', language)}</th><th>{t('container.ui.labels', language)}</th><th>{t('container.ui.operations', language)}</th></tr></thead><tbody>{visibleVolumes.length === 0 ? <tr><td colSpan={6} className="container-table-empty">{volumesLoading ? t('container.ui.loadingVolumes', language) : t('container.ui.noVolumes', language)}</td></tr> : visibleVolumes.map((volume) => <tr key={volume.name}><td title={volume.name}><strong>{volume.name}</strong></td><td>{volume.driver}</td><td title={volume.mountpoint}>{volume.mountpoint}</td><td>{volume.scope}</td><td title={volume.labels}>{volume.labels}</td><td><div className="container-resource-actions"><button type="button" className="container-table-action" disabled={Boolean(actingKey)} onClick={() => void executeVolumeInspect(volume)}>{actingKey === `volume-inspect:${volume.name}` ? t('container.ui.reading', language) : t('container.ui.inspect', language)}</button><button type="button" className="container-table-danger" disabled={Boolean(actingKey)} onClick={() => setPendingAction({ kind: 'volume', action: 'remove', volume })}>{actingKey === `volume-remove:${volume.name}` ? t('container.ui.removing', language) : t('container.action.remove', language)}</button></div></td></tr>)}</tbody></table></div>
        </div>
      ) : null}

      {imagePruneDialogOpen ? createPortal(<div className="container-modal-overlay" role="presentation" onClick={() => { if (!pruningImages) setImagePruneDialogOpen(false); }}><div className="container-modal container-prune-modal" role="alertdialog" aria-modal="true" aria-labelledby="container-image-prune-title" onClick={(event) => event.stopPropagation()}><div id="container-image-prune-title" className="container-modal-title">{t('container.modal.pruneImages', language)}</div><div className="container-modal-message"><p>{t('container.modal.pruneImagesDescription', language)}</p></div>{imagePruneError ? <DismissibleAlert className="container-alert danger container-prune-alert" onDismiss={() => setImagePruneError('')} role="alert">{imagePruneError}</DismissibleAlert> : null}<div className="container-prune-options" role="radiogroup" aria-label={t('container.modal.pruneImages', language)}>{imagePruneOptions.map((option) => <label key={option.value} className={`container-prune-option ${imagePruneMode === option.value ? 'selected' : ''}`}><input type="radio" name="container-image-prune-mode" value={option.value} checked={imagePruneMode === option.value} disabled={pruningImages} onChange={() => { setImagePruneError(''); setImagePruneMode(option.value); }} /><span><strong>{t(option.labelId, language)}</strong><small>{t(option.descriptionId, language)}</small></span></label>)}</div><div className="container-command-preview container-prune-preview"><header><span>{t('container.ui.commandPreview', language)}</span><button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(imagePruneCommandPreview, t('container.ui.commandPreview', language))}>{t('container.ui.copy', language)}</button></header><pre>{imagePruneCommandPreview}</pre></div><div className="container-modal-actions"><button type="button" className="container-modal-btn" onClick={() => setImagePruneDialogOpen(false)} disabled={pruningImages}>{t('common.cancel', language)}</button><button type="button" className="container-modal-btn danger" onClick={() => void executeImagePrune()} disabled={pruningImages}>{pruningImages ? t('container.ui.pruning', language) : t('container.modal.confirmPrune', language)}</button></div></div></div>, document.body) : null}

      {pendingAction ? createPortal(<div className="container-modal-overlay" role="presentation" onClick={() => setPendingAction(null)}><div className="container-modal" role="alertdialog" aria-modal="true" aria-labelledby="container-action-confirm-title" onClick={(event) => event.stopPropagation()}><div id="container-action-confirm-title" className="container-modal-title">{getPendingActionTitle()}</div><div className="container-modal-message">{pendingAction.kind === 'container' ? <><p>{t('container.modal.targetContainer', language)}<strong>{pendingAction.container.name}</strong></p><p>{t('container.modal.containerDeleteWarning', language)}</p><code>{pendingAction.container.id}</code></> : pendingAction.kind === 'image' ? <><p>{t('container.modal.targetImage', language)}<strong>{getImageReference(pendingAction.image)}</strong></p><p>{t('container.modal.imageDeleteWarning', language)}</p><code>{pendingAction.image.id}</code></> : pendingAction.kind === 'compose' ? <><p>{t('container.modal.targetCompose', language)}<strong>{pendingAction.project.name}</strong></p><p>{t('container.modal.composeDownWarning', language)}</p><code>{pendingAction.project.configFiles}</code></> : pendingAction.kind === 'network' ? <><p>{t('container.modal.targetNetwork', language)}<strong>{pendingAction.network.name}</strong></p><p>{t('container.modal.networkDeleteWarning', language)}</p><code>{pendingAction.network.id}</code></> : pendingAction.kind === 'network-prune' ? <><p>{t('container.modal.networkPruneWarning', language)}</p><code>{formatRuntimeCommand(runtime ?? 'docker', buildNetworkPruneArgs())}</code></> : pendingAction.kind === 'volume' ? <><p>{t('container.modal.targetVolume', language)}<strong>{pendingAction.volume.name}</strong></p><p>{t('container.modal.volumeDeleteWarning', language)}</p><code>{pendingAction.volume.mountpoint}</code></> : <><p>{t('container.modal.volumePruneWarning', language)}</p><code>{formatRuntimeCommand(runtime ?? 'docker', buildVolumePruneArgs())}</code></>}</div><div className="container-modal-actions"><button type="button" className="container-modal-btn" onClick={() => setPendingAction(null)}>{t('common.cancel', language)}</button><button type="button" className="container-modal-btn danger" disabled={Boolean(actingKey)} onClick={executePendingAction}>{actingKey ? t('container.ui.processing', language) : t('container.modal.confirmRemove', language)}</button></div></div></div>, document.body) : null}
      {sudoPrompt}
    </div>
  );
}

export default RemoteContainerManager;
