// =============================================================================
// Klaviyo Flow Builder — API Client
// =============================================================================
// Wraps Klaviyo's REST API for flow creation and retrieval.
// Uses the beta Flows API (revision: 2024-10-15.pre).
// =============================================================================

import axios, { AxiosInstance, AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import {
  AppConfig,
  KlaviyoFlowResponse,
  KlaviyoImageResponse,
  KlaviyoTemplateResponse,
  KlaviyoFlowActionResponse,
  KlaviyoFlowMessageResponse,
} from '../types';
import { getLogger } from '../utils/logger';

const KLAVIYO_BASE_URL = 'https://a.klaviyo.com/api';

export class KlaviyoAPIClient {
  private client: AxiosInstance;
  private log = getLogger();

  constructor(private config: AppConfig) {
    this.client = axios.create({
      baseURL: KLAVIYO_BASE_URL,
      headers: {
        'Authorization': `Klaviyo-API-Key ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'revision': config.apiRevision,
      },
      timeout: config.pageTimeout,
    });

    // Request/response logging
    this.client.interceptors.request.use((req) => {
      this.log.debug(`API Request: ${req.method?.toUpperCase()} ${req.url}`);
      return req;
    });

    this.client.interceptors.response.use(
      (res) => {
        this.log.debug(`API Response: ${res.status} ${res.config.url}`);
        return res;
      },
      (error: AxiosError) => {
        const status = error.response?.status;
        const data = error.response?.data;
        this.log.error(`API Error: ${status} ${error.config?.url}`, { data });
        throw error;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Flows
  // ---------------------------------------------------------------------------

  /**
   * Create a new flow via the Flows API.
   * Returns the created flow with its Klaviyo-generated ID.
   */
  async createFlow(payload: Record<string, unknown>): Promise<KlaviyoFlowResponse> {
    this.log.info('Creating flow via Klaviyo API...');

    const response = await this.client.post<KlaviyoFlowResponse>('/flows/', payload);
    const flow = response.data;

    this.log.info(`Flow created: ${flow.data.id} (${flow.data.attributes.name})`);
    return flow;
  }

  /**
   * Get a flow by ID, optionally including its definition.
   */
  async getFlow(flowId: string, includeDefinition: boolean = true): Promise<KlaviyoFlowResponse> {
    const params: Record<string, string> = {};
    if (includeDefinition) {
      params['additional-fields[flow]'] = 'definition';
    }

    const response = await this.client.get<KlaviyoFlowResponse>(`/flows/${flowId}/`, { params });
    return response.data;
  }

  /**
   * Get all flows, optionally filtered by status.
   */
  async getFlows(status?: string): Promise<KlaviyoFlowResponse[]> {
    const params: Record<string, string> = {};
    if (status) {
      params['filter'] = `equals(status,"${status}")`;
    }

    const response = await this.client.get('/flows/', { params });
    return response.data.data || [];
  }

  /**
   * Update a flow's status (draft, manual, live).
   */
  async updateFlowStatus(flowId: string, status: 'draft' | 'manual' | 'live'): Promise<void> {
    await this.client.patch(`/flows/${flowId}/`, {
      data: {
        type: 'flow',
        id: flowId,
        attributes: { status },
      },
    });
    this.log.info(`Flow ${flowId} status updated to: ${status}`);
  }

  // ---------------------------------------------------------------------------
  // Metrics (for resolving trigger metric IDs)
  // ---------------------------------------------------------------------------

  /**
   * Get all metrics from the account.
   */
  async getAllMetrics(): Promise<Array<{ id: string; name: string }>> {
    const response = await this.client.get('/metrics/', {
      headers: { revision: '2024-10-15' },
    });

    const metrics = response.data?.data || [];
    return metrics.map((m: Record<string, unknown>) => ({
      id: m.id as string,
      name: (m.attributes as Record<string, unknown>)?.name as string,
    }));
  }

  /**
   * Look up a metric by name to get its ID.
   * Used to resolve trigger metric names to IDs for flow creation.
   */
  async findMetricByName(name: string): Promise<string | null> {
    this.log.debug(`Looking up metric: "${name}"`);

    try {
      const response = await this.client.get('/metrics/', {
        headers: { revision: '2024-10-15' }, // Use stable revision for metrics
      });

      const metrics = response.data?.data || [];
      const match = metrics.find(
        (m: Record<string, unknown>) =>
          (m.attributes as Record<string, unknown>)?.name === name,
      );

      if (match) {
        this.log.debug(`Found metric "${name}" with ID: ${match.id}`);
        return match.id;
      }

      this.log.warn(`Metric "${name}" not found. Available metrics listed in debug log.`);
      return null;
    } catch (error) {
      this.log.warn(`Failed to look up metric "${name}": ${error}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Lists (for resolving list trigger IDs)
  // ---------------------------------------------------------------------------

  /**
   * Look up a list by name to get its ID.
   */
  async findListByName(name: string): Promise<string | null> {
    this.log.debug(`Looking up list: "${name}"`);

    try {
      const response = await this.client.get('/lists/', {
        headers: { revision: '2024-10-15' },
      });

      const lists = response.data?.data || [];
      const match = lists.find(
        (l: Record<string, unknown>) =>
          (l.attributes as Record<string, unknown>)?.name === name,
      );

      if (match) {
        this.log.debug(`Found list "${name}" with ID: ${match.id}`);
        return match.id;
      }

      this.log.warn(`List "${name}" not found.`);
      return null;
    } catch (error) {
      this.log.warn(`Failed to look up list "${name}": ${error}`);
      return null;
    }
  }

  /**
   * Test the API connection by fetching account info.
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.client.get('/flows/', {
        params: { 'page[size]': 1 },
      });
      this.log.info('Klaviyo API connection successful.');
      return true;
    } catch (error) {
      this.log.error('Klaviyo API connection failed. Check your API key.');
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Images API — upload sliced email images to Klaviyo
  // ---------------------------------------------------------------------------

  /**
   * Upload an image from a URL (or data URI) to Klaviyo's asset library.
   * Rate limit: 3/s burst, 100/m steady, 100/day.
   */
  async uploadImageFromUrl(imageUrl: string, name?: string): Promise<KlaviyoImageResponse> {
    this.log.info(`Uploading image from URL: ${name || imageUrl}`);

    const response = await this.client.post<KlaviyoImageResponse>(
      '/images/',
      {
        data: {
          type: 'image',
          attributes: {
            import_from_url: imageUrl,
            name: name || 'flow-email-image',
            hidden: false,
          },
        },
      },
      { headers: { revision: '2024-10-15' } },
    );

    const hosted = response.data.data.attributes.image_url;
    this.log.info(`Image uploaded: ${name || 'image'} → ${hosted}`);
    return response.data;
  }

  /**
   * Upload an image from a local file to Klaviyo's asset library.
   * Rate limit: 3/s burst, 100/m steady, 100/day.
   */
  async uploadImageFromFile(filePath: string, name?: string): Promise<KlaviyoImageResponse> {
    const resolvedPath = path.resolve(filePath);
    const fileName = name || path.basename(resolvedPath);
    this.log.info(`Uploading image from file: ${fileName}`);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Image file not found: ${resolvedPath}`);
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(resolvedPath));
    form.append('name', fileName);
    form.append('hidden', 'false');

    const response = await axios.post<KlaviyoImageResponse>(
      `${KLAVIYO_BASE_URL}/image-upload/`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Klaviyo-API-Key ${this.config.apiKey}`,
          'revision': '2024-10-15',
        },
        timeout: this.config.pageTimeout,
      },
    );

    const hosted = response.data.data.attributes.image_url;
    this.log.info(`Image uploaded: ${fileName} → ${hosted}`);
    return response.data;
  }

  // ---------------------------------------------------------------------------
  // Flow Actions & Messages — walk the chain to find templates
  // ---------------------------------------------------------------------------

  /**
   * Get all flow actions for a given flow.
   * Returns action IDs + types so we can match them to our definition.
   */
  async getFlowActions(flowId: string): Promise<KlaviyoFlowActionResponse> {
    this.log.debug(`Fetching flow actions for flow: ${flowId}`);

    const response = await this.client.get<KlaviyoFlowActionResponse>(
      `/flows/${flowId}/flow-actions/`,
      { headers: { revision: '2024-10-15' } },
    );

    const count = response.data.data?.length || 0;
    this.log.debug(`Found ${count} flow actions`);
    return response.data;
  }

  /**
   * Get flow messages for a given flow action.
   * Each email action has one message; each message has one template.
   */
  async getFlowActionMessages(actionId: string): Promise<KlaviyoFlowMessageResponse> {
    this.log.debug(`Fetching messages for flow action: ${actionId}`);

    const response = await this.client.get<KlaviyoFlowMessageResponse>(
      `/flow-actions/${actionId}/flow-messages/`,
      { headers: { revision: '2024-10-15' } },
    );

    return response.data;
  }

  /**
   * Get the template associated with a flow message.
   * Tries multiple API revisions since flow-created messages may need the beta revision.
   */
  async getTemplateForMessage(messageId: string): Promise<KlaviyoTemplateResponse | null> {
    this.log.debug(`Fetching template for flow message: ${messageId}`);

    // Try multiple revisions — flow messages created via beta API may need beta revision
    const revisions = [this.config.apiRevision, '2024-10-15', '2025-01-15', '2024-10-15.pre'];

    for (const rev of revisions) {
      try {
        const response = await this.client.get<KlaviyoTemplateResponse>(
          `/flow-messages/${messageId}/template/`,
          { headers: { revision: rev } },
        );

        // Check if we got a valid template back
        if (response.data?.data?.id) {
          this.log.debug(`Got template via revision ${rev}`);
          return response.data;
        }
      } catch (err) {
        this.log.debug(`Template fetch failed with revision ${rev}, trying next...`);
      }
    }

    this.log.debug(`No template found for message ${messageId} across all revisions`);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Templates API — create and update email templates
  // ---------------------------------------------------------------------------

  /**
   * Create a new CODE-type email template with HTML content.
   */
  async createTemplate(name: string, html: string): Promise<KlaviyoTemplateResponse> {
    this.log.info(`Creating template: ${name}`);

    const response = await this.client.post<KlaviyoTemplateResponse>(
      '/templates/',
      {
        data: {
          type: 'template',
          attributes: {
            name,
            editor_type: 'CODE',
            html,
          },
        },
      },
      { headers: { revision: '2024-10-15' } },
    );

    this.log.info(`Template created: ${response.data.data.id} (${name})`);
    return response.data;
  }

  /**
   * Update an existing template's HTML content.
   * NOTE: Only works on CODE-type templates, not drag-and-drop.
   */
  async updateTemplate(templateId: string, html: string, name?: string): Promise<KlaviyoTemplateResponse> {
    this.log.info(`Updating template: ${templateId}`);

    const attributes: Record<string, string> = { html };
    if (name) attributes.name = name;

    const response = await this.client.patch<KlaviyoTemplateResponse>(
      `/templates/${templateId}/`,
      {
        data: {
          type: 'template',
          id: templateId,
          attributes,
        },
      },
      { headers: { revision: '2024-10-15' } },
    );

    this.log.info(`Template updated: ${templateId}`);
    return response.data;
  }

  /**
   * Get a template by ID (to check its editor_type before updating).
   */
  async getTemplate(templateId: string): Promise<KlaviyoTemplateResponse> {
    const response = await this.client.get<KlaviyoTemplateResponse>(
      `/templates/${templateId}/`,
      { headers: { revision: '2024-10-15' } },
    );
    return response.data;
  }
}
