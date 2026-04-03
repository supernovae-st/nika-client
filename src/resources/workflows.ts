import type { WorkflowInfo, ListWorkflowsResponse } from '../types.js';
import type { ApiClient } from '../lib/api-client.js';

export class Workflows {
  constructor(private readonly api: ApiClient) {}

  /** List available workflows on the server. */
  async list(): Promise<WorkflowInfo[]> {
    const res = await this.api.json<ListWorkflowsResponse>('/v1/workflows');
    return res.workflows;
  }

  /** Reload workflows from disk and return the refreshed list. */
  async reload(): Promise<WorkflowInfo[]> {
    const res = await this.api.json<ListWorkflowsResponse>('/v1/reload', {
      method: 'POST',
    });
    return res.workflows;
  }

  /** Get the raw YAML source of a workflow. */
  async source(name: string): Promise<string> {
    const res = await this.api.request(
      `/v1/workflows/${encodeURIComponent(name)}/source`,
    );
    return res.text();
  }
}
