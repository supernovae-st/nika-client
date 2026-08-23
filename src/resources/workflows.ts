import type { ListWorkflowsResponse, WorkflowMetadata } from '../types.js';
import type { ApiClient } from '../lib/api-client.js';
import { NikaUnavailableError } from '../errors.js';

export class Workflows {
  constructor(private readonly api: ApiClient) {}

  /** GET /v1/workflows — contained relative `.nika.yaml` names. */
  async list(): Promise<string[]> {
    const res = await this.api.json<ListWorkflowsResponse>('/v1/workflows');
    return res.workflows;
  }

  /** Same as list(); the live server does not paginate. */
  async listPage(): Promise<ListWorkflowsResponse> {
    return this.api.json<ListWorkflowsResponse>('/v1/workflows');
  }

  /** GET /v1/workflows/{name} — metadata without source bytes. */
  async metadata(name: string): Promise<WorkflowMetadata> {
    return this.api.json<WorkflowMetadata>(
      `/v1/workflows/${encodeURIComponent(name)}`,
    );
  }

  /** Reload is not on the live HTTP surface. */
  async reload(): Promise<never> {
    throw new NikaUnavailableError('POST /v1/reload');
  }

  /** Source bytes are not on the live HTTP surface. */
  async source(_name: string): Promise<never> {
    throw new NikaUnavailableError('GET /v1/workflows/{name}/source');
  }
}
