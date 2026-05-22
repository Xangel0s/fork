import * as vscode from 'vscode';
import { ConfigurationManager } from '../managers/ConfigurationManager';
import { CoolifyService } from '../services/CoolifyService';

// Types and Interfaces
interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

interface WebViewMessage {
  type: 'refresh' | 'deploy' | 'configure' | 'reconfigure' | 'view-logs' | 'check-status' | 'clear-history';
  applicationId?: string;
  lines?: string;
}

interface SnapshotApp {
  id: string;
  name: string;
  status: string;
  displayStatus: string;
  fqdn: string;
  git_repository: string;
  git_branch: string;
  updated_at: string;
}

interface StateSnapshotMessage {
  type: 'state-snapshot';
  apps: SnapshotApp[];
  depHistory: any[];
}

// Constants
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

const REFRESH_INTERVAL = 5000;

export class CoolifyWebViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private outputChannel = vscode.window.createOutputChannel('Coolify Deployments');
  private refreshInterval?: ReturnType<typeof setTimeout>;
  private messageHandler?: vscode.Disposable;
  private retryCount = 0;
  private isDisposed = false;
  private pendingRefresh?: ReturnType<typeof setTimeout>;
  private logChannels: Map<string, vscode.OutputChannel> = new Map();
  private isVerifying = false;
  private disposables: vscode.Disposable[] = [];
  private verifiedStatuses: Record<string, string> = {};
  private depHistory: any[] = [];
  private rawApps: any[] = [];
  private isDeploying = new Set<string>();
  private deploymentTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly DEPLOY_TIMEOUT = 300_000; // 5 min safety break

  private restoreState(): void {
    const saved = this.context.workspaceState.get<{
      verifiedStatuses: Record<string, string>;
      depHistory: any[];
    }>('coolify.state');
    if (saved) {
      this.verifiedStatuses = saved.verifiedStatuses || {};
      this.depHistory = saved.depHistory || [];
      // Zombie detection: mark any in_progress as unknown
      for (const dep of this.depHistory) {
        if (dep.status === 'in_progress') {
          dep.status = 'unknown';
        }
      }
    }
  }

  private async saveState(): Promise<void> {
    await this.context.workspaceState.update('coolify.state', {
      verifiedStatuses: this.verifiedStatuses,
      depHistory: this.depHistory,
    });
  }

  private getEffectiveStatus(appId: string): string {
    const app = this.rawApps.find((a: any) => a.uuid === appId);
    if (!app) { return 'unknown'; }

    if (this.isDeploying.has(appId)) { return 'in_progress'; }

    if (appId in this.verifiedStatuses) {
      return this.verifiedStatuses[appId];
    }

    return (app.status || 'unknown').toLowerCase();
  }

  private emitState(): void {
    if (!this.isViewValid()) { return; }

    const apps = this.rawApps.map((a: any) => ({
      id: a.uuid,
      name: a.name,
      status: a.status,
      displayStatus: this.getEffectiveStatus(a.uuid),
      fqdn: a.fqdn,
      git_repository: a.git_repository,
      git_branch: a.git_branch,
      updated_at: a.updated_at,
    }));

    this._view!.webview.postMessage({
      type: 'state-snapshot',
      apps,
      depHistory: this.depHistory,
    } as StateSnapshotMessage);
  }

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private configManager: ConfigurationManager,
    private context: vscode.ExtensionContext
  ) {
    this.initializeConfigurationListener();
    this.restoreState();
  }

  // Initialization Methods
  private initializeConfigurationListener(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('coolify')) {
          await this.handleConfigurationChange();
        }
      })
    );
  }

  private async handleConfigurationChange(): Promise<void> {
    const isConfigured = await this.configManager.isConfigured();
    if (!isConfigured) {
      this.stopRefreshInterval();
    }
    await this.updateView();
  }

  // View Management Methods
  private isViewValid(): boolean {
    return !!this._view && !this.isDisposed;
  }

  public async updateView(): Promise<void> {
    if (this.pendingRefresh) {
      clearTimeout(this.pendingRefresh);
    }

    this.pendingRefresh = setTimeout(async () => {
      if (!this.isViewValid()) {
        return;
      }

      try {
        this._view!.webview.html = '';
        await this.resolveWebviewView(
          this._view!,
          { state: undefined },
          new vscode.CancellationTokenSource().token
        );
      } catch (error) {
        this.handleError('Failed to update view', error);
      }
    }, 100);
  }

  // Retry Logic
  private async withRetry<T>(
    operation: () => Promise<T>,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === retryConfig.maxAttempts) {
          throw lastError;
        }

        const delay = Math.min(
          retryConfig.baseDelay * Math.pow(2, attempt - 1),
          retryConfig.maxDelay
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  // Refresh Management
  private stopRefreshInterval(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  private startRefreshInterval(): void {
    this.stopRefreshInterval();
    this.retryCount = 0;

    this.refreshInterval = setInterval(async () => {
      try {
        await this.refreshData();
        this.retryCount = 0;
      } catch (error) {
        this.retryCount++;
        console.error('Refresh failed:', error);

        if (this.retryCount >= DEFAULT_RETRY_CONFIG.maxAttempts) {
          this.stopRefreshInterval();
          if (this.isViewValid()) {
            vscode.window.showErrorMessage(
              'Auto-refresh stopped due to repeated errors. Click refresh to try again.'
            );
          }
        }
      }
    }, REFRESH_INTERVAL);
  }

  // Data Management
  public async refreshData(): Promise<void> {
    if (!this.isViewValid()) { return; }

    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      await this.handleUnconfiguredState();
      return;
    }

    try {
      const service = new CoolifyService(serverUrl, token);
      const applications = await service.getApplications();

      this.rawApps = this.mergeAppsWithInvalidation(applications);

      // Resolve deployments for apps that reached terminal state
      for (const appId of Array.from(this.isDeploying)) {
        const app = this.rawApps.find((a: any) => a.uuid === appId);
        if (app) {
          const status = (app.status || '').toLowerCase();
          if (!status.includes('starting') && !status.includes('in_progress')) {
            const resolved =
              status.includes('exited') || status.includes('stopped') || status === 'failed'
                ? 'failed'
                : 'success';
            this.outputChannel.appendLine(
              `[Refresh] ${appId} reached terminal state: ${resolved}`
            );
            this.cleanupDeployment(appId, resolved, service);
          }
        }
      }

      this.emitState();
      await this.saveState();

      // Validate any stale in_progress history entries
      await this.validateHistory(service);

      if (!this.isVerifying) {
        this.runHealthCheckBatch(applications, service);
      }
    } catch (error) {
      await this.handleRefreshError(error);
    }
  }

  private mergeAppsWithInvalidation(newApps: any[]): any[] {
    const oldMap = new Map<string, any>();
    for (const a of this.rawApps) { oldMap.set(a.uuid, a); }

    for (const app of newApps) {
      const old = oldMap.get(app.uuid);
      if (old && old.status !== app.status && app.uuid in this.verifiedStatuses) {
        delete this.verifiedStatuses[app.uuid];
      }
    }
    return newApps;
  }

  private async validateHistory(service: CoolifyService): Promise<void> {
    const staleEntries = this.depHistory.filter(
      (d) => d.status === 'in_progress' && d.depUuid
    );
    if (staleEntries.length === 0) { return; }

    this.outputChannel.appendLine(
      `[Validator] Checking ${staleEntries.length} stale deployment(s)`
    );

    let changed = false;
    for (const entry of staleEntries) {
      try {
        const result = await service.getDeploymentStatus(
          entry.appUuid,
          entry.depUuid
        );
        const rawStatus = String(
          result.status || result.state || ''
        ).toLowerCase();
        this.outputChannel.appendLine(
          `[Validator] ${entry.appName} (${entry.depUuid.slice(0, 8)}): status=${rawStatus || '(empty)'}`
        );
        this.outputChannel.appendLine(
          `[Validator] Full result: ${JSON.stringify(result)}`
        );
        const terminalStatuses = [
          'success', 'failed', 'cancelled', 'error',
          'finished', 'completed', 'done', 'successful',
        ];
        if (terminalStatuses.includes(rawStatus)) {
          entry.status =
            rawStatus === 'finished' ||
            rawStatus === 'completed' ||
            rawStatus === 'done' ||
            rawStatus === 'successful'
              ? 'success'
              : rawStatus;
          this.outputChannel.appendLine(
            `[Validator] Resolved ${entry.appName} → ${entry.status}`
          );
          changed = true;
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        // Deployment status endpoint failed — try to infer from app status regardless of error
        try {
          const detail = await service.getApplicationDetail(entry.appUuid);
          const appStatus = (detail.status || '').toLowerCase();
          entry.status =
            appStatus.includes('exited') || appStatus.includes('stopped') || appStatus === 'failed'
              ? 'failed'
              : 'success';
          this.outputChannel.appendLine(
            `[Validator] ${entry.appName} status endpoint failed (${errMsg}). App status: ${appStatus} → ${entry.status}`
          );
        } catch {
          entry.status = 'unknown';
          this.outputChannel.appendLine(
            `[Validator] ${entry.appName} status endpoint failed (${errMsg}). App status unavailable → unknown`
          );
        }
        changed = true;
      }
    }

    if (changed) {
      this.emitState();
      await this.saveState();
    }
  }

  private async handleUnconfiguredState(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'coolify.isConfigured',
      false
    );
  }

  private async runHealthCheckBatch(
    applications: any[],
    service: CoolifyService
  ): Promise<void> {
    this.isVerifying = true;
    const toCheck = applications
      .filter((a: any) => a.status === 'running' || a.status === 'healthy')
      .slice(0, 5);

    for (const app of toCheck) {
      try {
        const isAlive = await service.isContainerAlive(app.uuid);
        if (!isAlive) {
          this.verifiedStatuses[app.uuid] = 'exited';
          this.emitState();
          await this.saveState();
        }
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        // Skip silently
      }
    }
    this.isVerifying = false;
  }

  // Deployment Management
  public async deployApplication(applicationId: string): Promise<void> {
    if (this.isDeploying.has(applicationId)) {
      vscode.window.showInformationMessage('Deployment already in progress');
      return;
    }

    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const deployResult = await service.startDeployment(applicationId);

      const app =
        this.rawApps.find((a: any) => a.uuid === applicationId);
      const appName = app?.name || applicationId;

      const depUuid = deployResult.deployment_uuid || '';
      this.outputChannel.appendLine(
        `[Deploy] Started for ${appName}. depUuid=${depUuid || '(none)'}`
      );

      this.depHistory.unshift({
        appUuid: applicationId,
        depUuid,
        appName,
        status: 'in_progress',
      });
      this.emitState();
      await this.saveState();

      vscode.window.showInformationMessage(`Deploy started: ${appName}`);

      if (depUuid) {
        this.pollDeployment(applicationId, depUuid, service);
      } else {
        this.outputChannel.appendLine(
          `[Deploy] No depUuid returned. Watching app status instead.`
        );
        this.pollAppStatus(applicationId, service);
      }
    } catch (error) {
      this.handleError('Failed to start deployment', error);
    }
  }

  private pollDeployment(
    appId: string,
    depUuid: string,
    service: CoolifyService
  ): void {
    this.outputChannel.show();
    this.outputChannel.appendLine(
      `[Watcher] Started for ${appId} (Deploy: ${depUuid})`
    );

    this.isDeploying.add(appId);
    this.emitState();

    // Safety timeout: force-fail after 5 min
    const timeout = setTimeout(() => {
      if (this.isDeploying.has(appId)) {
        this.outputChannel.appendLine(
          `[Watcher] Timeout reached for ${appId}. Forcing failed state.`
        );
        this.cleanupDeployment(appId, 'failed', service, depUuid);
      }
    }, this.DEPLOY_TIMEOUT);
    this.deploymentTimeouts.set(appId, timeout);

    let pollCount = 0;
    const MAX_POLL_RETRIES = 20; // ~1 min with 3s interval

    const runPoll = async () => {
      if (!this.isViewValid()) {
        this.cleanupDeployment(appId, 'unknown', service, depUuid);
        return;
      }

      pollCount++;
      if (pollCount > MAX_POLL_RETRIES) {
        this.outputChannel.appendLine(
          `[Watcher] Max retries (${MAX_POLL_RETRIES}) reached for ${appId}. Forcing failed.`
        );
        this.cleanupDeployment(appId, 'failed', service, depUuid);
        return;
      }

      try {
        const result = await service.getDeploymentStatus(appId, depUuid);
        const rawStatus = String(
          result.status || result.state || ''
        ).toLowerCase();

        this.outputChannel.appendLine(`[Watcher] Raw response for ${appId}: status=${rawStatus || '(empty)'}`);
        this.outputChannel.appendLine(`[Watcher] Full result: ${JSON.stringify(result)}`);

        const terminalStatuses = [
          'success', 'failed', 'cancelled', 'error',
          'finished', 'completed', 'done', 'successful',
        ];
        if (terminalStatuses.includes(rawStatus)) {
          const normalizedStatus =
            rawStatus === 'finished' ||
            rawStatus === 'completed' ||
            rawStatus === 'done' ||
            rawStatus === 'successful'
              ? 'success'
              : rawStatus;
          this.outputChannel.appendLine(
            `[Watcher] ✅ Terminal status detected: ${normalizedStatus}`
          );
          this.cleanupDeployment(appId, normalizedStatus, service, depUuid);
          return;
        }

        this.outputChannel.appendLine(
          `[Watcher] ⏳ Non-terminal status: ${rawStatus}. Continuing poll (${pollCount}/${MAX_POLL_RETRIES})`
        );
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.outputChannel.appendLine(`[Watcher] ❌ Poll error: ${errMsg}`);

        // Fallback: try to resolve from app status regardless of error type
        try {
          const detail = await service.getApplicationDetail(appId);
          const appStatus = (detail.status || '').toLowerCase();
          const resolved =
            appStatus.includes('exited') || appStatus.includes('stopped') || appStatus === 'failed'
              ? 'failed'
              : 'success';
          this.outputChannel.appendLine(
            `[Watcher] 🔍 App status fallback: ${appStatus} → ${resolved}`
          );
          this.cleanupDeployment(appId, resolved, service, depUuid);
          return;
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          this.outputChannel.appendLine(
            `[Watcher] ❌ App status also failed: ${fallbackMsg}. Retry ${pollCount}/${MAX_POLL_RETRIES}`
          );
        }
      }

      setTimeout(runPoll, 3000);
    };

    runPoll();
  }

  // Watch app status when deployment endpoint doesn't return depUuid
  private pollAppStatus(appId: string, service: CoolifyService): void {
    this.outputChannel.appendLine(
      `[AppWatcher] Started for ${appId}`
    );

    this.isDeploying.add(appId);
    this.emitState();

    // Safety timeout: force-fail after 5 min
    const timeout = setTimeout(() => {
      if (this.isDeploying.has(appId)) {
        this.outputChannel.appendLine(
          `[AppWatcher] Timeout reached for ${appId}. Forcing failed.`
        );
        this.cleanupDeployment(appId, 'failed', service);
      }
    }, this.DEPLOY_TIMEOUT);
    this.deploymentTimeouts.set(appId, timeout);

    let pollCount = 0;
    const MAX_RETRIES = 20;

    const runPoll = async () => {
      if (!this.isViewValid()) {
        this.cleanupDeployment(appId, 'unknown', service);
        return;
      }

      pollCount++;
      if (pollCount > MAX_RETRIES) {
        this.outputChannel.appendLine(
          `[AppWatcher] Max retries reached for ${appId}. Forcing failed.`
        );
        this.cleanupDeployment(appId, 'failed', service);
        return;
      }

      try {
        const detail = await service.getApplicationDetail(appId);
        const appStatus = (detail.status || '').toLowerCase();
        this.outputChannel.appendLine(
          `[AppWatcher] ${appId} status: ${appStatus}`
        );

        // Terminal states for app
        const terminal =
          appStatus.includes('running') ||
          appStatus.includes('exited') ||
          appStatus.includes('stopped') ||
          appStatus === 'failed';

        if (terminal) {
          const resolved =
            appStatus.includes('exited') || appStatus.includes('stopped') || appStatus === 'failed'
              ? 'failed'
              : 'success';
          this.outputChannel.appendLine(
            `[AppWatcher] ${appId} reached terminal state: ${resolved}`
          );
          this.cleanupDeployment(appId, resolved, service);
          return;
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this.outputChannel.appendLine(
          `[AppWatcher] Error checking ${appId}: ${errMsg}`
        );
      }

      setTimeout(runPoll, 3000);
    };

    runPoll();
  }

  private async cleanupDeployment(
    appId: string,
    finalStatus: string | undefined,
    service: CoolifyService,
    depUuid?: string
  ): Promise<void> {
    // Clear safety timeout
    const to = this.deploymentTimeouts.get(appId);
    if (to) { clearTimeout(to); this.deploymentTimeouts.delete(appId); }

    this.isDeploying.delete(appId);

    if (finalStatus) {
      // Try to find the exact entry by depUuid, or the most recent in_progress one
      let target = this.depHistory.find(
        (d) => depUuid && d.depUuid === depUuid
      );
      if (!target) {
        target = this.depHistory.find(
          (d) => d.appUuid === appId && d.status === 'in_progress'
        );
      }
      if (target) {
        target.status = finalStatus;
      } else {
        // Fallback: update first match (should not happen)
        const first = this.depHistory.find((d) => d.appUuid === appId);
        if (first) { first.status = finalStatus; }
      }

      if (finalStatus === 'success') {
        vscode.window.showInformationMessage(
          `Deployment completed: ${appId}`
        );
      } else if (finalStatus === 'failed' || finalStatus === 'error') {
        try {
          const depLogs = await service.getDeploymentLogs(appId, depUuid || '');
          this.outputChannel.appendLine('--- Deployment Logs ---');
          this.outputChannel.appendLine(depLogs);
        } catch {
          this.outputChannel.appendLine('(could not fetch deployment logs)');
        }
        vscode.window.showErrorMessage(
          `Deployment failed: ${appId}. Check the Output channel for details.`
        );
      }
    }

    this.emitState();
    await this.saveState();
    await this.refreshData();
  }

  // Log Streaming
  private async streamApplicationLogs(applicationId: string, lines: string): Promise<void> {
    let channel = this.logChannels.get(applicationId);
    if (!channel) {
      channel = vscode.window.createOutputChannel(
        `Coolify Logs: ${applicationId}`
      );
      this.logChannels.set(applicationId, channel);
    }

    channel.show();
    channel.clear();
    channel.appendLine(
      `[Requesting the latest ${lines} lines for: ${applicationId}...]`
    );

    const serverUrl = await this.configManager.getServerUrl();
    const token = await this.configManager.getToken();

    if (!serverUrl || !token) {
      channel.appendLine('[Error] Missing Coolify credentials.');
      return;
    }

    const service = new CoolifyService(serverUrl, token);

    try {
      const rawLogs = await service.getApplicationLogs(applicationId, lines);
      channel.appendLine(rawLogs);
      channel.appendLine('\n[--- End of logs ---]');

      if ((rawLogs.includes('No hay logs registrados') || rawLogs.includes('No logs registered')) && this.isViewValid()) {
        const detail = await service.getApplicationDetail(applicationId);
        if (
          detail.status &&
          !detail.status.toLowerCase().includes('running') &&
          !detail.status.toLowerCase().includes('healthy')
        ) {
          this.verifiedStatuses[applicationId] = 'exited';
          this.emitState();
          await this.saveState();
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      channel.appendLine(`\n[Error retrieving logs]: ${msg}`);

      if (this.isViewValid()) {
        try {
          const detail = await service.getApplicationDetail(applicationId);
          if (
            detail.status &&
            !detail.status.toLowerCase().includes('running') &&
            !detail.status.toLowerCase().includes('healthy')
          ) {
            this.verifiedStatuses[applicationId] = 'exited';
            this.emitState();
            await this.saveState();
          }
        } catch {
          // Silently fail on the secondary check
        }
      }
    }
  }

  // Clear History
  private async handleClearHistory(): Promise<void> {
    this.depHistory = [];
    this.emitState();
    await this.saveState();
  }

  // Check Status
  private async handleCheckStatus(applicationId: string): Promise<void> {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) { return; }

      const service = new CoolifyService(serverUrl, token);
      const isAlive = await service.isContainerAlive(applicationId);

      if (isAlive) {
        delete this.verifiedStatuses[applicationId];
      } else {
        this.verifiedStatuses[applicationId] = 'exited';
      }
      this.emitState();
      await this.saveState();
    } catch {
      this.verifiedStatuses[applicationId] = 'exited';
      this.emitState();
      await this.saveState();
    }
  }

  // WebView Resolution
  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.cleanupExistingView();
    this.initializeNewView(webviewView);

    try {
      await this.setupWebView(webviewView);
    } catch (error) {
      this.handleError('Error initializing webview', error);
    }
  }

  private cleanupExistingView(): void {
    if (this.messageHandler) {
      this.messageHandler.dispose();
      this.messageHandler = undefined;
    }
  }

  private initializeNewView(webviewView: vscode.WebviewView): void {
    this.isDisposed = false;
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
      enableCommandUris: false,
    };
  }

  private async setupWebView(webviewView: vscode.WebviewView): Promise<void> {
    this.setupMessageHandler(webviewView);
    this.setupVisibilityHandler(webviewView);
    this.setupDisposalHandler(webviewView);

    const isConfigured = await this.configManager.isConfigured();
    if (!isConfigured) {
      this.handleUnconfiguredWebView(webviewView);
      return;
    }

    await this.initializeConfiguredWebView(webviewView);
  }

  private setupMessageHandler(webviewView: vscode.WebviewView): void {
    this.messageHandler = webviewView.webview.onDidReceiveMessage(
      async (data: WebViewMessage) => {
        if (!this.isViewValid()) {
          return;
        }

        try {
          await this.handleWebViewMessage(data);
        } catch (error) {
          console.error('Error handling webview message:', error);
        }
      }
    );
  }

  private async handleWebViewMessage(message: WebViewMessage): Promise<void> {
    switch (message.type) {
      case 'refresh':
        await this.refreshData();
        break;
      case 'deploy':
        if (message.applicationId) {
          await this.deployApplication(message.applicationId);
        }
        break;
      case 'configure':
        await vscode.commands.executeCommand('coolify.configure');
        break;
      case 'reconfigure':
        await vscode.commands.executeCommand('coolify.reconfigure');
        break;
      case 'view-logs':
        if (!message.applicationId) { break; }
        await this.streamApplicationLogs(message.applicationId, message.lines || '100');
        break;
      case 'check-status':
        if (!message.applicationId) { break; }
        await this.handleCheckStatus(message.applicationId);
        break;
      case 'clear-history':
        await this.handleClearHistory();
        break;
    }
  }

  private setupVisibilityHandler(webviewView: vscode.WebviewView): void {
    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.refreshData().catch(console.error);
          this.startRefreshInterval();
        } else {
          this.stopRefreshInterval();
        }
      })
    );
  }

  private setupDisposalHandler(webviewView: vscode.WebviewView): void {
    this.disposables.push(
      webviewView.onDidDispose(() => {
        this.dispose();
      })
    );
  }

  private async handleUnconfiguredWebView(
    webviewView: vscode.WebviewView
  ): Promise<void> {
    this.stopRefreshInterval();
    if (this.isViewValid()) {
      webviewView.webview.html = await this.getWelcomeHtml();
    }
  }

  private async initializeConfiguredWebView(
    webviewView: vscode.WebviewView
  ): Promise<void> {
    if (this.isViewValid()) {
      webviewView.webview.html = await this.getWebViewHtml();
      if (webviewView.visible) {
        this.startRefreshInterval();
      }
      await this.refreshData();
    }
  }

  // HTML Generation
  private async getWebViewHtml(): Promise<string> {
    const htmlPath = vscode.Uri.joinPath(
      this._extensionUri,
      'dist',
      'templates',
      'webview.html'
    );
    const decoder = new TextDecoder('utf-8');
    const fileData = await vscode.workspace.fs.readFile(htmlPath);
    return decoder.decode(fileData);
  }

  private async getWelcomeHtml(): Promise<string> {
    const logoUri = this._view?.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'public', 'logo.svg')
    );

    // Load welcome template and replace logo URI
    const welcomePath = vscode.Uri.joinPath(
      this._extensionUri,
      'dist',
      'templates',
      'welcome.html'
    );
    const decoder = new TextDecoder('utf-8');
    const fileData = await vscode.workspace.fs.readFile(welcomePath);
    let html = decoder.decode(fileData);
    html = html.replace('${logoUri}', logoUri?.toString() || '');

    return html;
  }

  // Error Handling
  private handleError(message: string, error: unknown): void {
    console.error(`${message}:`, error);
    if (this.isViewValid()) {
      if (error instanceof Error && error.message.includes('401')) {
        this.handleAuthenticationError();
      } else {
        vscode.window.showErrorMessage(`${message}. Please try again.`);
      }
    }
  }

  private async handleAuthenticationError(): Promise<void> {
    await this.configManager.clearConfiguration();
    await vscode.commands.executeCommand(
      'setContext',
      'coolify.isConfigured',
      false
    );
    if (this.isViewValid()) {
      vscode.window.showErrorMessage(
        'Authentication failed. Please reconfigure the extension.'
      );
    }
  }

  private async handleRefreshError(error: unknown): Promise<void> {
    if (error instanceof Error && error.message.includes('401')) {
      await this.handleAuthenticationError();
    } else {
      if (this.isViewValid()) {
        vscode.window.showErrorMessage(
          'Failed to refresh data. Please try again.'
        );
      }
    }
    throw error;
  }

  public async getApplications() {
    try {
      const serverUrl = await this.configManager.getServerUrl();
      const token = await this.configManager.getToken();

      if (!serverUrl || !token) {
        throw new Error('Extension not configured properly');
      }

      const service = new CoolifyService(serverUrl, token);
      const applications = await service.getApplications();

      return applications.map((app) => ({
        id: app.uuid,
        name: app.name,
        status: app.status,
        label: `${app.name} (${app.git_repository}:${app.git_branch})`,
      }));
    } catch (error) {
      console.error('Failed to get applications:', error);
      throw error;
    }
  }

  // Cleanup
  public dispose(): void {
    this.isDisposed = true;
    this.stopRefreshInterval();

    if (this.pendingRefresh) {
      clearTimeout(this.pendingRefresh);
      this.pendingRefresh = undefined;
    }

    if (this.messageHandler) {
      this.messageHandler.dispose();
      this.messageHandler = undefined;
    }

    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];

    this._view = undefined;
    this.isDeploying.clear();
    this.deploymentTimeouts.forEach((t) => clearTimeout(t));
    this.deploymentTimeouts.clear();
    this.logChannels.forEach((channel) => channel.dispose());
    this.logChannels.clear();
    this.outputChannel.dispose();
  }
}
