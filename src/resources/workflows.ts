import type { WorkflowInfo, ListWorkflowsResponse } from '../types.js';
import type { ApiClient } from '../lib/api-client.js';

export interface ListPageOptions {
  /** Max workflows to return per page. */
  limit?: number;
  /** Cursor: return workflows after this name (from previous page's last item). */
  after?: string;
}

export class Workflows {
  constructor(private readonly api: ApiClient) {}

  /**
   * List all workflows. Auto-paginates if server supports it.
   * For large lists, use `listPage()` for manual pagination.
   */
  async list(): Promise<WorkflowInfo[]> {
    const all: WorkflowInfo[] = [];
    let after: string | undefined;
    const MAX_PAGES = 1000;

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (after) params.set('after', after);

      const res = await this.api.json<ListWorkflowsResponse>(
        `/v1/workflows?${params}`,
      );
      all.push(...res.workflows);

      if (!res.has_more || res.workflows.length === 0) break;
      after = res.workflows[res.workflows.length - 1].name;
    }

    return all;
  }

  /** List a single page of workflows (manual pagination). */
  async listPage(options?: ListPageOptions): Promise<ListWorkflowsResponse> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.after) params.set('after', options.after);

    const qs = params.toString();
    return this.api.json<ListWorkflowsResponse>(
      `/v1/workflows${qs ? `?${qs}` : ''}`,
    );
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
