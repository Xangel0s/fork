interface Application {
  uuid: string;
  name: string;
  status: string;
  git_branch: string;
  git_commit_sha: string;
  destination_type: string;
  fqdn: string;
  git_repository: string;
  updated_at: string;
  description: string;
  build_pack?: string;
}

interface Deployment {
  id: string;
  application_id: string;
  application_name: string;
  status: string;
  commit: string;
  created_at: string;
  deployment_url: string;
  commit_message: string;
}

export class CoolifyService {
  constructor(private baseUrl: string, private token: string) {}

  private async fetchWithAuth<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data as T;
  }

  async getApplications(): Promise<Application[]> {
    return this.fetchWithAuth<Application[]>('/api/v1/applications');
  }

  async verifyRealStatus(uuid: string): Promise<string> {
    const data = await this.fetchWithAuth<{ status: string }>(
      `/api/v1/applications/${uuid}`
    );
    return data.status;
  }

  async isContainerAlive(uuid: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api/v1/applications/${uuid}/logs?tail=1`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getApplicationDetail(uuid: string): Promise<{ status: string; build_pack?: string }> {
    return this.fetchWithAuth<{ status: string; build_pack?: string }>(
      `/api/v1/applications/${uuid}`
    );
  }

  async getDeployments(): Promise<Deployment[]> {
    return this.fetchWithAuth<Deployment[]>('/api/v1/deployments');
  }

  async startDeployment(uuid: string): Promise<{ deployment_uuid?: string }> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/deploy?uuid=${uuid}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to start deployment: ${response.statusText}`);
    }

    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  async getDeploymentStatus(
    appUuid: string,
    deploymentUuid: string
  ): Promise<Record<string, unknown>> {
    return this.fetchWithAuth<Record<string, unknown>>(
      `/api/v1/applications/${appUuid}/deployments/${deploymentUuid}`
    );
  }

  async getApplicationLogs(uuid: string, lines: string = '100'): Promise<string> {
    const url = `${this.baseUrl}/api/v1/applications/${uuid}/logs?tail=${lines}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    }

    const jsonResponse = (await response.json()) as { logs?: string };
    return jsonResponse.logs || '[No logs registered for this application]';
  }

  async getDeploymentLogs(
    appUuid: string,
    deploymentUuid: string
  ): Promise<string> {
    const url = `${this.baseUrl}/api/v1/applications/${appUuid}/deployments/${deploymentUuid}/logs`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
    });

    if (response.status === 400) {
      return '[No logs available for this deployment]';
    }
    if (!response.ok) {
      throw new Error(
        `Failed to fetch deployment logs: ${response.statusText}`
      );
    }

    try {
      const json = (await response.json()) as { logs?: string };
      return json.logs || '(empty logs)';
    } catch {
      return await response.text();
    }
  }

  /**
   * Verifies if the token is valid by making a test API call
   * @returns true if token is valid, false otherwise
   */
  async verifyToken(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/version`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      });

      return response.ok;
    } catch (error) {
      console.error('Error verifying token:', error);
      return false;
    }
  }

  /**
   * Tests the connection to the Coolify server
   * @returns true if server is reachable, false otherwise
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`);
      return response.ok;
    } catch (error) {
      console.error('Error testing connection:', error);
      return false;
    }
  }
}
