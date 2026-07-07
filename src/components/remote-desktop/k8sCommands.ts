import type { RemoteCommandInput } from './remoteSystem';
import { shellSingleQuote } from './shellUtils';

export function getKubectlDetectCommand(): RemoteCommandInput {
  return { command: 'command -v kubectl || which kubectl || echo "KUBECTL_NOT_FOUND"' };
}

export function getKubectlVersionCommand(): RemoteCommandInput {
  return { command: 'kubectl version --client -o json 2>/dev/null || echo "{}"' };
}

export function getConfigViewCommand(): RemoteCommandInput {
  return { command: 'kubectl config view -o json 2>/dev/null || echo "{}"' };
}

export function getNamespaceListCommand(): RemoteCommandInput {
  return { command: 'kubectl get ns -o json 2>/dev/null || echo "{\\"items\\":[]}"' };
}

export function getPodListCommand(namespace?: string): RemoteCommandInput {
  const ns = namespace ? `-n ${shellSingleQuote(namespace)}` : '--all-namespaces';
  return { command: `kubectl get pods ${ns} -o json 2>/dev/null || echo "{\\"items\\":[]}"` };
}

export function getPodDetailCommand(name: string, namespace: string): RemoteCommandInput {
  return {
    command: `kubectl get pod ${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)} -o json 2>/dev/null || echo "{}"`,
  };
}

export function getPodLogsCommand(name: string, namespace: string, container?: string, tail?: number): RemoteCommandInput {
  const containerFlag = container ? `-c ${shellSingleQuote(container)}` : '';
  const tailFlag = tail ? `--tail=${tail}` : '';
  return {
    command: `kubectl logs ${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)} ${containerFlag} ${tailFlag}`.trim(),
  };
}

export function getPodDeleteCommand(name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl delete pod ${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)} --wait=false` };
}

export function getPodEventsCommand(name: string, namespace: string): RemoteCommandInput {
  return {
    command: `kubectl get events -n ${shellSingleQuote(namespace)} --field-selector involvedObject.name=${shellSingleQuote(name)} -o json 2>/dev/null || echo "{\\"items\\":[]}"`,
  };
}

export function getNodeListCommand(): RemoteCommandInput {
  return { command: 'kubectl get nodes -o json 2>/dev/null || echo "{\\"items\\":[]}"' };
}

export function getNodeDetailCommand(name: string): RemoteCommandInput {
  return { command: `kubectl get node ${shellSingleQuote(name)} -o json 2>/dev/null || echo "{}"` };
}

export function getNodeTopCommand(): RemoteCommandInput {
  return { command: 'kubectl top node -o json 2>/dev/null || echo "{}"' };
}

function getWorkloadCommand(kind: string, namespace?: string): RemoteCommandInput {
  const ns = namespace ? `-n ${shellSingleQuote(namespace)}` : '--all-namespaces';
  return { command: `kubectl get ${kind} ${ns} -o json 2>/dev/null || echo "{\\"items\\":[]}"` };
}

export function getDeploymentListCommand(namespace?: string): RemoteCommandInput {
  return getWorkloadCommand('deployments', namespace);
}

export function getStatefulSetListCommand(namespace?: string): RemoteCommandInput {
  return getWorkloadCommand('statefulsets', namespace);
}

export function getDaemonSetListCommand(namespace?: string): RemoteCommandInput {
  return getWorkloadCommand('daemonsets', namespace);
}

export function getWorkloadScaleCommand(kind: string, name: string, namespace: string, replicas: number): RemoteCommandInput {
  return {
    command: `kubectl scale ${kind}/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)} --replicas=${Math.max(0, Math.floor(replicas))}`,
  };
}

export function getWorkloadRolloutRestartCommand(kind: string, name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl rollout restart ${kind}/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)}` };
}

export function getWorkloadRolloutStatusCommand(kind: string, name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl rollout status ${kind}/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)}` };
}

export function getWorkloadGetYamlCommand(kind: string, name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl get ${kind}/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)} -o yaml` };
}

export function getServiceGetYamlCommand(name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl get svc/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)} -o json` };
}

function encodeUtf8Base64(value: string) {
  return btoa(unescape(encodeURIComponent(value)));
}

function getApplyYamlCommand(yamlContent: string): RemoteCommandInput {
  const encodedYaml = encodeUtf8Base64(yamlContent);
  return { command: `echo '${encodedYaml}' | base64 -d | kubectl apply -f -` };
}

export function getServiceEditCommand(_name: string, _namespace: string, yamlContent: string): RemoteCommandInput {
  return getApplyYamlCommand(yamlContent);
}

export function getServiceDeleteCommand(name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl delete svc/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)}` };
}

export function getConfigMapGetYamlCommand(name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl get cm/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)} -o json` };
}

export function getConfigMapEditCommand(_name: string, _namespace: string, yamlContent: string): RemoteCommandInput {
  return getApplyYamlCommand(yamlContent);
}

export function getConfigMapDeleteCommand(name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl delete cm/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)}` };
}

export function getSecretGetYamlCommand(name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl get secret/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)} -o json` };
}

export function getSecretEditCommand(_name: string, _namespace: string, yamlContent: string): RemoteCommandInput {
  return getApplyYamlCommand(yamlContent);
}

export function getSecretDeleteCommand(name: string, namespace: string): RemoteCommandInput {
  return { command: `kubectl delete secret/${shellSingleQuote(name)} -n ${shellSingleQuote(namespace)}` };
}

export function getServiceListCommand(namespace?: string): RemoteCommandInput {
  const ns = namespace ? `-n ${shellSingleQuote(namespace)}` : '--all-namespaces';
  return { command: `kubectl get svc ${ns} -o json 2>/dev/null || echo "{\\"items\\":[]}"` };
}

export function getConfigMapListCommand(namespace?: string): RemoteCommandInput {
  const ns = namespace ? `-n ${shellSingleQuote(namespace)}` : '--all-namespaces';
  return { command: `kubectl get configmaps ${ns} -o json 2>/dev/null || echo "{\\"items\\":[]}"` };
}

export function getSecretListCommand(namespace?: string): RemoteCommandInput {
  const ns = namespace ? `-n ${shellSingleQuote(namespace)}` : '--all-namespaces';
  return { command: `kubectl get secrets ${ns} -o json 2>/dev/null || echo "{\\"items\\":[]}"` };
}
