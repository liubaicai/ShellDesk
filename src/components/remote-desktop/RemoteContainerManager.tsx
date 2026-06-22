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
  buildDockerDaemonRestartCommand,
  buildImagePruneArgs,
  createContainerTroubleshooting,
  createDockerNetworkTroubleshooting,
  formatRuntimeCommand,
  getContainerActionCommand,
  getContainerConfigUpdateCommand,
  getContainerDetailCommand,
  getContainerExecCommand,
  getContainerListCommand,
  getDetectRuntimeCommand,
  getImageListCommand,
  getImagePullCommand,
  getImageReference,
  getImageRemoveCommand,
  getRuntimeCliCommand,
  getRuntimeLabel,
  isDockerNetworkTrouble,
  matchesContainerQuery,
  matchesImageQuery,
} from './containerCommands';
import { formatShortId, getStateLabel, parseContainerDetailOutput, parseContainerSummary, parseImageSummary, parseJsonLines } from './containerParsers';
import type {
  ContainerAction,
  ContainerConfigForm,
  ContainerFilter,
  ContainerRuntime,
  ContainerRunForm as ContainerRunFormState,
  ContainerSummary,
  ContainerTroubleshooting,
  ImagePruneMode,
  ImageSummary,
  ManagerTab,
  PendingAction,
  RemoteContainerManagerProps,
} from './containerTypes';

const managerTabs: Array<{ key: ManagerTab; labelId: MessageId }> = [
  { key: 'containers', labelId: 'container.tab.containers' },
  { key: 'images', labelId: 'container.tab.images' },
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
  const [selectedContainerId, setSelectedContainerId] = useState('');
  const [detail, setDetail] = useState<ReturnType<typeof parseContainerDetailOutput> | null>(null);
  const [containerSearch, setContainerSearch] = useState('');
  const [containerFilter, setContainerFilter] = useState<ContainerFilter>('all');
  const [imageSearch, setImageSearch] = useState('');
  const [pullImageName, setPullImageName] = useState('');
  const [imagePruneMode, setImagePruneMode] = useState<ImagePruneMode>('dangling');
  const [imagePruneDialogOpen, setImagePruneDialogOpen] = useState(false);
  const [imagePruneError, setImagePruneError] = useState('');
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [runInitialImage, setRunInitialImage] = useState('');
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [containersLoading, setContainersLoading] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imagesLoaded, setImagesLoaded] = useState(false);
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
    setDetail(null);
    setSelectedContainerId('');
    setRunError('');
    setRunTroubleshooting(null);
    setRunPanelOpen(false);
    setRunInitialImage('');
    setImagePruneMode('dangling');
    setImagePruneDialogOpen(false);
    setImagePruneError('');
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

  const selectedContainer = useMemo(() => containers.find((container) => container.id === selectedContainerId) ?? null, [containers, selectedContainerId]);
  const selectedDetail = detail?.id === selectedContainerId ? detail : null;
  const visibleContainers = useMemo(() => {
    const query = containerSearch.trim();
    return containers.filter((container) => (containerFilter === 'all' || container.state === containerFilter) && matchesContainerQuery(container, query));
  }, [containerFilter, containerSearch, containers]);
  const visibleImages = useMemo(() => images.filter((image) => matchesImageQuery(image, imageSearch.trim())), [imageSearch, images]);
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

  const refreshCurrentContainer = async () => {
    const nextSelectedContainerId = await refreshContainers({ silent: true, preferredContainerId: selectedContainerId });
    if (nextSelectedContainerId) await loadContainerDetail(nextSelectedContainerId);
  };

  const renderToolbarRight = () => activeTab === 'images' ? (
    <>
      <input type="search" className="container-search" placeholder={t('container.ui.searchImages', language)} value={imageSearch} onChange={(event) => setImageSearch(event.target.value)} />
      <input type="text" className="container-pull-input" placeholder="nginx:latest" value={pullImageName} onChange={(event) => setPullImageName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void executeImagePull(); }} aria-label={t('container.ui.pullImageAria', language)} />
      <button type="button" className="container-tool-button primary" onClick={() => void executeImagePull()} disabled={pulling}>{pulling ? t('container.ui.pulling', language) : 'Pull'}</button>
      <button type="button" className="container-tool-button danger" onClick={() => { setImagePruneError(''); setPendingAction(null); setImagePruneDialogOpen(true); }} disabled={pruningImages}>{pruningImages ? t('container.ui.pruning', language) : t('container.ui.pruneImages', language)}</button>
    </>
  ) : (
    <>
      <select className="container-select" value={containerFilter} onChange={(event) => setContainerFilter(event.target.value as ContainerFilter)} aria-label={t('container.ui.filterAria', language)}>{containerFilters.map((item) => <option key={item.key} value={item.key}>{t(item.labelId, language)}</option>)}</select>
      <input type="search" className="container-search" placeholder={t('container.ui.searchContainers', language)} value={containerSearch} onChange={(event) => setContainerSearch(event.target.value)} />
    </>
  );

  const imagePruneCommandPreview = formatRuntimeCommand(runtime ?? 'docker', buildImagePruneArgs(imagePruneMode));

  return (
    <div className="container-manager">
      <div className="container-toolbar">
        <div className="container-toolbar-left">
          <button type="button" className="container-tool-button primary" onClick={() => activeTab === 'images' ? void refreshImages() : void refreshContainers()} disabled={runtimeLoading || containersLoading || imagesLoading}>{runtimeLoading || containersLoading || imagesLoading ? t('container.ui.refreshing', language) : t('container.ui.refresh', language)}</button>
          <button type="button" className="container-tool-button" onClick={() => void refreshCurrentContainer()} disabled={!selectedContainer || detailLoading}>{detailLoading ? t('container.ui.reading', language) : t('container.ui.refreshCurrent', language)}</button>
          <button type="button" className="container-tool-button primary" onClick={openRunDialog}>{t('container.ui.newContainer', language)}</button>
          <span className="container-runtime-pill">{getRuntimeLabel(runtime, language)}</span>
          <span className="container-summary"><strong>{activeTab === 'images' ? visibleImages.length : visibleContainers.length}</strong> / {activeTab === 'images' ? images.length : containers.length}</span>
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
          <ContainerDetailPanel container={selectedContainer} detail={selectedDetail} detailLoading={detailLoading} containersLoading={containersLoading} actingKey={actingKey} savingConfig={savingConfig} onAction={requestContainerAction} onReload={loadContainerDetail} onCopy={copyToClipboard} onConfigSubmit={executeConfigUpdate} onExec={executeContainerExec} />
        </div>
      ) : null}

      {activeTab === 'images' ? (
        <div className="container-images-panel" aria-label={t('container.ui.imageListAria', language)}>
          <div className="container-image-table-wrap"><table className="container-image-table"><thead><tr><th className="container-image-repo">{t('container.ui.repository', language)}</th><th className="container-image-tag">{t('container.ui.tag', language)}</th><th className="container-image-id">ID</th><th className="container-image-size">{t('container.ui.size', language)}</th><th className="container-image-created">{t('container.ui.createdAt', language)}</th><th className="container-image-actions">{t('container.ui.operations', language)}</th></tr></thead><tbody>{visibleImages.length === 0 ? <tr><td colSpan={6} className="container-table-empty">{imagesLoading ? t('container.ui.loadingImages', language) : t('container.ui.noImages', language)}</td></tr> : visibleImages.map((image) => <tr key={`${image.id}:${image.repository}:${image.tag}`}><td title={image.repository}>{image.repository}</td><td title={image.tag}>{image.tag}</td><td title={image.id}><code>{formatShortId(image.id)}</code></td><td>{image.size}</td><td title={image.createdAt}>{image.createdAt || '-'}</td><td><div className="container-image-actions-cell"><button type="button" className="container-table-action" onClick={() => prepareRunFromImage(image)}>{t('container.ui.run', language)}</button><button type="button" className="container-table-danger" disabled={Boolean(actingKey)} onClick={() => setPendingAction({ kind: 'image', action: 'remove', image })}>{actingKey === `image-remove:${image.id}` ? t('container.ui.removing', language) : t('container.action.remove', language)}</button></div></td></tr>)}</tbody></table></div>
        </div>
      ) : null}

      {imagePruneDialogOpen ? createPortal(<div className="container-modal-overlay" role="presentation" onClick={() => { if (!pruningImages) setImagePruneDialogOpen(false); }}><div className="container-modal container-prune-modal" role="alertdialog" aria-modal="true" aria-labelledby="container-image-prune-title" onClick={(event) => event.stopPropagation()}><div id="container-image-prune-title" className="container-modal-title">{t('container.modal.pruneImages', language)}</div><div className="container-modal-message"><p>{t('container.modal.pruneImagesDescription', language)}</p></div>{imagePruneError ? <DismissibleAlert className="container-alert danger container-prune-alert" onDismiss={() => setImagePruneError('')} role="alert">{imagePruneError}</DismissibleAlert> : null}<div className="container-prune-options" role="radiogroup" aria-label={t('container.modal.pruneImages', language)}>{imagePruneOptions.map((option) => <label key={option.value} className={`container-prune-option ${imagePruneMode === option.value ? 'selected' : ''}`}><input type="radio" name="container-image-prune-mode" value={option.value} checked={imagePruneMode === option.value} disabled={pruningImages} onChange={() => { setImagePruneError(''); setImagePruneMode(option.value); }} /><span><strong>{t(option.labelId, language)}</strong><small>{t(option.descriptionId, language)}</small></span></label>)}</div><div className="container-command-preview container-prune-preview"><header><span>{t('container.ui.commandPreview', language)}</span><button type="button" className="container-copy-btn" onClick={() => void copyToClipboard(imagePruneCommandPreview, t('container.ui.commandPreview', language))}>{t('container.ui.copy', language)}</button></header><pre>{imagePruneCommandPreview}</pre></div><div className="container-modal-actions"><button type="button" className="container-modal-btn" onClick={() => setImagePruneDialogOpen(false)} disabled={pruningImages}>{t('common.cancel', language)}</button><button type="button" className="container-modal-btn danger" onClick={() => void executeImagePrune()} disabled={pruningImages}>{pruningImages ? t('container.ui.pruning', language) : t('container.modal.confirmPrune', language)}</button></div></div></div>, document.body) : null}

      {pendingAction ? createPortal(<div className="container-modal-overlay" role="presentation" onClick={() => setPendingAction(null)}><div className="container-modal" role="alertdialog" aria-modal="true" aria-labelledby="container-action-confirm-title" onClick={(event) => event.stopPropagation()}><div id="container-action-confirm-title" className="container-modal-title">{pendingAction.kind === 'container' ? t('container.modal.removeContainer', language) : t('container.modal.removeImage', language)}</div><div className="container-modal-message">{pendingAction.kind === 'container' ? <><p>{t('container.modal.targetContainer', language)}<strong>{pendingAction.container.name}</strong></p><p>{t('container.modal.containerDeleteWarning', language)}</p><code>{pendingAction.container.id}</code></> : <><p>{t('container.modal.targetImage', language)}<strong>{getImageReference(pendingAction.image)}</strong></p><p>{t('container.modal.imageDeleteWarning', language)}</p><code>{pendingAction.image.id}</code></>}</div><div className="container-modal-actions"><button type="button" className="container-modal-btn" onClick={() => setPendingAction(null)}>{t('common.cancel', language)}</button><button type="button" className="container-modal-btn danger" onClick={() => { if (pendingAction.kind === 'container') void executeContainerAction(pendingAction.action, pendingAction.container); else void executeImageRemove(pendingAction.image); }}>{t('container.modal.confirmRemove', language)}</button></div></div></div>, document.body) : null}
      {sudoPrompt}
    </div>
  );
}

export default RemoteContainerManager;
