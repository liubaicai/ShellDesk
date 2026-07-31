declare global {
  interface ShellDeskPluginPermissionGrant {
    permission: string;
    scopes?: string[];
  }

  interface ShellDeskPluginManifestReviewInput {
    id: string;
    version: string;
    permissions: ShellDeskPluginPermissionGrant[];
  }

  interface ShellDeskPluginPermissionDecision {
    permission: string;
    decision: 'allow' | 'deny';
    reason: 'declared-and-scoped' | 'not-declared';
    scopes: string[];
  }

  interface ShellDeskPluginSecurityPolicy {
    policyVersion: number;
    defaultDecision: 'deny';
    capabilityIssuedByReview: false;
    auditFailureBehavior: 'deny';
    permissions: Array<{
      permission: string;
      risk: 'low' | 'medium' | 'high' | 'critical';
      scopeKind: 'none' | 'https-origin' | 'plugin-path' | 'host-id' | 'setting-key';
      scopeRequired: boolean;
    }>;
    isolationDefaults: {
      workerProcess: 'required';
      environment: 'empty';
      hostFilesystem: 'denied';
      pluginStorage: 'plugin-private';
      network: 'denied';
    };
  }

  interface ShellDeskPluginManifestReview {
    valid: true;
    policyVersion: number;
    pluginId: string;
    version: string;
    capabilityIssued: false;
    decisions: ShellDeskPluginPermissionDecision[];
    isolation: {
      namespace: string;
      storageRoot: string;
      workerProcess: 'required';
      environment: 'empty';
      hostFilesystem: 'denied';
      network: 'denied' | 'declared-https-origins-only';
    };
  }

  interface ShellDeskPluginSecurityAuditEntry {
    timestamp: string;
    pluginId: string;
    operation: 'manifest.review';
    decision: 'allowed' | 'denied';
    reason: string;
  }

}

export {};
