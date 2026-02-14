// =============================================================================
// Klaviyo Flow Builder — API Flow Creator
// =============================================================================
// Transforms a FlowDefinition into a Klaviyo API payload and creates the flow.
// =============================================================================

import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import {
  FlowDefinition,
  FlowAction,
  FlowTrigger,
  FlowSettings,
  MetricTrigger,
  ListTrigger,
  DateTrigger,
  TimeDelayAction,
  SendEmailAction,
  SendSmsAction,
  ConditionalSplitAction,
  EmailContent,
  ImageSection,
  KlaviyoAPIAction,
  KlaviyoAPITrigger,
  KlaviyoCreateFlowPayload,
  KlaviyoFlowResponse,
  AppConfig,
  BuildResult,
} from '../types';
import { KlaviyoAPIClient } from './client';
import { getLogger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { buildEmailHtml, isLocalFile, extractImageSources } from '../utils/email-builder';

/** Metric name → ID cache (populated from account at runtime) */
let metricIdCache: Record<string, string> = {};

export class APIFlowCreator {
  private client: KlaviyoAPIClient;
  private log = getLogger();
  private defaultFromEmail: string;
  private defaultFromLabel: string;

  constructor(private config: AppConfig) {
    this.client = new KlaviyoAPIClient(config);
    // Use the Klaviyo login email as default sender for flow skeletons
    this.defaultFromEmail = config.email || 'noreply@example.com';
    this.defaultFromLabel = 'Store';
  }

  /**
   * Build a flow using the Klaviyo Flows API.
   * This is the primary (most reliable) method.
   */
  async buildFlow(definition: FlowDefinition): Promise<BuildResult> {
    const startTime = Date.now();
    const result: BuildResult = {
      success: false,
      mode: 'api',
      flowName: definition.name,
      actionsCreated: 0,
      errors: [],
      warnings: [],
      duration: 0,
    };

    try {
      // Step 1: Test connection
      this.log.info(`Building flow: "${definition.name}" via API`);
      const connected = await this.client.testConnection();
      if (!connected) {
        result.errors.push('Failed to connect to Klaviyo API. Check your API key.');
        result.duration = Date.now() - startTime;
        return result;
      }

      // Step 2: Load metric cache (needed for trigger + conditional splits)
      await this.loadMetricCache();

      // Step 3: Resolve trigger
      const trigger = await this.resolveTrigger(definition.trigger);
      if (!trigger) {
        result.errors.push(
          `Could not resolve trigger. Metric/list "${this.getTriggerName(definition.trigger)}" not found in your Klaviyo account.`,
        );
        result.duration = Date.now() - startTime;
        return result;
      }

      // Step 3: Log settings being applied
      const settings = definition.settings;
      if (settings) {
        const smartDefault = settings.smart_sending !== undefined ? settings.smart_sending : true;
        const utmDefault = settings.utm_tracking !== undefined ? settings.utm_tracking : false;
        this.log.info(`  Settings: smart_sending=${smartDefault ? 'ON' : 'OFF'}, utm_tracking=${utmDefault ? 'ON' : 'OFF'}`);

        // Log per-action overrides
        for (const action of definition.actions) {
          if (action.type === 'send-email' || action.type === 'send-sms') {
            const a = action as SendEmailAction | SendSmsAction;
            const overrides: string[] = [];
            if (a.smart_sending !== undefined) overrides.push(`smart_sending=${a.smart_sending ? 'ON' : 'OFF'}`);
            if (a.utm_tracking !== undefined) overrides.push(`utm_tracking=${a.utm_tracking ? 'ON' : 'OFF'}`);
            if (overrides.length > 0) {
              this.log.info(`  Override on "${a.name}": ${overrides.join(', ')}`);
            }
          }
        }

        if (settings.reentry) {
          this.log.info(`  Re-entry: ${settings.reentry.mode}${settings.reentry.mode === 'time-based' ? ` (${settings.reentry.value} ${settings.reentry.unit})` : ''}`);
          this.log.info(`  Note: Re-entry requires browser config (Phase 2)`);
        }
      }

      if (definition.trigger.type === 'metric' && definition.trigger.trigger_filter) {
        this.log.info(`  Trigger filter: applied (${definition.trigger.trigger_filter.condition_groups.length} condition group(s))`);
      }
      if (definition.profile_filter) {
        this.log.info(`  Profile filter: applied (${definition.profile_filter.condition_groups.length} condition group(s))`);
      }

      // -----------------------------------------------------------------
      // Pre-Phase: Create templates for emails with content BEFORE flow
      // -----------------------------------------------------------------
      const preCreatedTemplates: Record<string, string> = {}; // emailId → templateId
      const emailsWithContent = definition.actions.filter(
        (a): a is SendEmailAction => a.type === 'send-email' && !!(a as SendEmailAction).content,
      );

      if (emailsWithContent.length > 0) {
        this.log.info(`\n  Pre-creating ${emailsWithContent.length} email template(s)...`);

        // Upload local images first
        let imagesUploaded = 0;
        const imageUrlCache: Record<string, string> = {};
        for (const email of emailsWithContent) {
          const { local } = extractImageSources(email.content!);
          for (const localPath of local) {
            if (imageUrlCache[localPath]) continue;
            try {
              const fileName = path.basename(localPath);
              const uploadResult = await withRetry(
                () => this.client.uploadImageFromFile(localPath, fileName),
                `Upload image: ${fileName}`,
                { maxAttempts: 2 },
              );
              imageUrlCache[localPath] = uploadResult.data.attributes.image_url;
              imagesUploaded++;
              await this.sleep(400);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              this.log.warn(`  Failed to upload image "${localPath}": ${msg}`);
              result.warnings.push(`Image "${localPath}" could not be uploaded.`);
            }
          }
        }

        // Replace local paths with hosted URLs
        for (const email of emailsWithContent) {
          for (const section of email.content!.sections) {
            if (section.type === 'image' && isLocalFile(section.src)) {
              const hosted = imageUrlCache[section.src];
              if (hosted) (section as ImageSection).src = hosted;
            }
          }
        }

        // Create templates
        for (const email of emailsWithContent) {
          try {
            const html = buildEmailHtml(email.content!);
            this.log.info(`  Creating template for "${email.name}" (${html.length} bytes)...`);
            const tmpl = await this.client.createTemplate(`${email.name}`, html);
            preCreatedTemplates[email.id] = tmpl.data.id;
            this.log.info(`  ✓ Template ${tmpl.data.id} created for "${email.name}"`);
            await this.sleep(300);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(`  Failed to create template for "${email.name}": ${msg}`);
            result.warnings.push(`Template for "${email.name}" could not be pre-created.`);
          }
        }

        result.imagesUploaded = imagesUploaded;
        result.templatesApplied = Object.keys(preCreatedTemplates).length;
        this.log.info(`  Pre-created ${Object.keys(preCreatedTemplates).length} template(s)\n`);
      }

      // Step 3b: Transform actions to API format (with settings + template IDs)
      const apiActions = this.transformActions(definition.actions, settings, preCreatedTemplates);

      // Step 4: Build the payload
      const payload = this.buildPayload(definition, trigger, apiActions);

      // Step 5: Create the flow
      const response = await withRetry(
        () => this.client.createFlow(payload as unknown as Record<string, unknown>),
        'Create flow via API',
        { maxAttempts: this.config.maxRetries },
      );

      // Step 6: Extract results
      result.success = true;
      result.flowId = response.data.id;
      result.flowUrl = `https://www.klaviyo.com/flow/${response.data.id}/edit`;
      result.actionsCreated = definition.actions.length;

      // Build settings summary
      const applied: Record<string, string> = {};
      const ss = definition.settings;
      const smartDefault = ss?.smart_sending !== undefined ? ss.smart_sending : true;
      const utmDefault = ss?.utm_tracking !== undefined ? ss.utm_tracking : false;
      applied['Smart Sending'] = smartDefault ? 'ON' : 'OFF';
      applied['UTM Tracking'] = utmDefault ? 'ON' : 'OFF';

      // Count per-action overrides
      const overrides = definition.actions.filter(a =>
        (a.type === 'send-email' || a.type === 'send-sms') &&
        ((a as SendEmailAction).smart_sending !== undefined || (a as SendEmailAction).utm_tracking !== undefined)
      );
      if (overrides.length > 0) {
        applied['Per-action overrides'] = `${overrides.length} action(s)`;
      }

      if (definition.trigger.type === 'metric' && definition.trigger.trigger_filter) {
        applied['Trigger Filter'] = 'Applied';
      }
      if (definition.profile_filter) {
        applied['Profile Filter'] = 'Applied';
      }
      if (ss?.reentry) {
        applied['Re-entry'] = `${ss.reentry.mode}${ss.reentry.mode === 'time-based' ? ` (${ss.reentry.value} ${ss.reentry.unit})` : ''} (pending Phase 2)`;
      }
      result.settingsApplied = applied;

      this.log.info(`Flow created successfully!`);
      this.log.info(`  Flow ID: ${result.flowId}`);
      this.log.info(`  URL: ${result.flowUrl}`);
      this.log.info(`  Actions: ${result.actionsCreated}`);
      this.log.info(`  Status: Draft (review and activate in Klaviyo)`);

      // Add template results to settings summary
      if (result.templatesApplied && result.templatesApplied > 0) {
        applied['Email Content'] = `${result.templatesApplied} template(s) created`;
      }
      if (result.imagesUploaded && result.imagesUploaded > 0) {
        applied['Images Uploaded'] = `${result.imagesUploaded} image(s)`;
      }

      // Store pre-created template mapping for browser linking
      if (Object.keys(preCreatedTemplates).length > 0) {
        result.preCreatedTemplates = preCreatedTemplates;
        this.log.info(`  Templates ready for browser linking: ${Object.keys(preCreatedTemplates).length}`);
      }

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`API flow creation failed: ${msg}`);
      this.log.error(`Flow creation failed: ${msg}`);

      // Provide helpful error messages
      if (msg.includes('401') || msg.includes('403')) {
        result.errors.push('Authentication failed. Verify your KLAVIYO_API_KEY is correct and has write permissions.');
      }
      if (msg.includes('422')) {
        result.errors.push('Validation error. The flow definition may have invalid fields. Check the Klaviyo API docs.');
      }
      if (msg.includes('429')) {
        result.errors.push('Rate limited. Wait a moment and try again.');
      }
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Trigger Resolution
  // ---------------------------------------------------------------------------

  private async resolveTrigger(trigger: FlowTrigger): Promise<KlaviyoAPITrigger | null> {
    switch (trigger.type) {
      case 'metric':
        return this.resolveMetricTrigger(trigger);
      case 'list':
        return this.resolveListTrigger(trigger);
      case 'date-property':
        return this.resolveDateTrigger(trigger);
      default:
        this.log.error(`Unsupported trigger type: ${(trigger as FlowTrigger).type}`);
        return null;
    }
  }

  /**
   * Load all metrics from the account and cache them for ID lookups.
   */
  private async loadMetricCache(): Promise<void> {
    if (Object.keys(metricIdCache).length > 0) return;

    this.log.info('Loading account metrics...');
    try {
      const metrics = await this.client.getAllMetrics();
      for (const m of metrics) {
        metricIdCache[m.name] = m.id;
      }
      this.log.info(`Loaded ${Object.keys(metricIdCache).length} metrics from account.`);
    } catch (error) {
      this.log.warn(`Failed to load metrics: ${error}`);
    }
  }

  private async resolveMetricTrigger(trigger: MetricTrigger): Promise<KlaviyoAPITrigger | null> {
    let metricId = trigger.metric_id;

    if (!metricId) {
      // Load all metrics and find by name
      await this.loadMetricCache();
      this.log.info(`Resolving metric ID for: "${trigger.metric_name}"`);
      metricId = metricIdCache[trigger.metric_name];
    }

    if (!metricId) {
      // Try a fuzzy match (case-insensitive, partial match)
      const lowerName = trigger.metric_name.toLowerCase();
      for (const [name, id] of Object.entries(metricIdCache)) {
        if (name.toLowerCase().includes(lowerName) || lowerName.includes(name.toLowerCase())) {
          this.log.info(`Fuzzy matched "${trigger.metric_name}" to "${name}" (${id})`);
          metricId = id;
          break;
        }
      }
    }

    if (!metricId) {
      this.log.error(
        `Cannot resolve metric: "${trigger.metric_name}". ` +
        `Available metrics: ${Object.keys(metricIdCache).join(', ')}`,
      );
      return null;
    }

    this.log.info(`Resolved trigger metric: "${trigger.metric_name}" → ${metricId}`);

    return {
      type: 'metric',
      id: metricId,
      trigger_filter: trigger.trigger_filter || undefined,
    };
  }

  private async resolveListTrigger(trigger: ListTrigger): Promise<KlaviyoAPITrigger | null> {
    let listId = trigger.list_id;

    if (!listId) {
      listId = await this.client.findListByName(trigger.list_name) || undefined;
    }

    if (!listId) {
      this.log.error(`Cannot resolve list: "${trigger.list_name}"`);
      return null;
    }

    return {
      type: 'list',
      id: listId,
    };
  }

  private async resolveDateTrigger(trigger: DateTrigger): Promise<KlaviyoAPITrigger> {
    return {
      type: 'date-property',
      id: trigger.property_name,
    };
  }

  private getTriggerName(trigger: FlowTrigger): string {
    switch (trigger.type) {
      case 'metric': return trigger.metric_name;
      case 'list': return trigger.list_name;
      case 'date-property': return trigger.property_name;
      default: return 'Unknown';
    }
  }

  // ---------------------------------------------------------------------------
  // Action Transformation
  // ---------------------------------------------------------------------------

  /**
   * Transform user-friendly FlowActions into Klaviyo API action format.
   * Accepts flow-level settings and pre-created template IDs.
   */
  private transformActions(actions: FlowAction[], settings?: FlowSettings, templateIds?: Record<string, string>): KlaviyoAPIAction[] {
    return actions.map((action) => this.transformAction(action, settings, templateIds));
  }

  private transformAction(action: FlowAction, settings?: FlowSettings, templateIds?: Record<string, string>): KlaviyoAPIAction {
    switch (action.type) {
      case 'time-delay':
        return this.transformTimeDelay(action);
      case 'send-email':
        return this.transformSendEmail(action, settings, templateIds);
      case 'send-sms':
        return this.transformSendSms(action, settings);
      case 'conditional-split':
        return this.transformConditionalSplit(action);
      case 'ab-split':
        throw new Error(
          'A/B splits are not supported by the Klaviyo API. ' +
          'Use browser mode or remove the A/B split from this flow.',
        );
      default:
        throw new Error(`Unsupported action type: ${(action as FlowAction).type}`);
    }
  }

  private transformTimeDelay(action: TimeDelayAction): KlaviyoAPIAction {
    // Klaviyo only allows delay_until_time and delay_until_weekdays when unit is 'days'
    const isDays = action.delay_unit === 'days';

    return {
      temporary_id: action.id,
      type: 'time-delay',
      links: {
        next: action.next || null,
      },
      data: {
        unit: action.delay_unit,
        value: action.delay_value,
        secondary_value: 0,
        timezone: 'profile',
        delay_until_time: null,
        delay_until_weekdays: isDays
          ? ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
          : null,
      },
    };
  }

  /**
   * Resolve a boolean setting with per-action override > flow default > fallback.
   */
  private resolveSetting(
    perAction: boolean | undefined,
    flowDefault: boolean | undefined,
    fallback: boolean,
  ): boolean {
    if (perAction !== undefined) return perAction;
    if (flowDefault !== undefined) return flowDefault;
    return fallback;
  }

  private transformSendEmail(action: SendEmailAction, settings?: FlowSettings, templateIds?: Record<string, string>): KlaviyoAPIAction {
    const smartSending = this.resolveSetting(action.smart_sending, settings?.smart_sending, true);
    const utmTracking = this.resolveSetting(action.utm_tracking, settings?.utm_tracking, false);

    // Build message payload
    const message: Record<string, unknown> = {
      name: action.name,
      subject_line: action.subject_line || `${action.name} Subject`,
      preview_text: action.preview_text || '',
      from_email: this.defaultFromEmail,
      from_label: this.defaultFromLabel,
      reply_to_email: this.defaultFromEmail,
      cc_email: null,
      bcc_email: null,
      smart_sending_enabled: smartSending,
      transactional: false,
      add_tracking_params: utmTracking,
      custom_tracking_params: null,
      additional_filters: null,
    };

    // Include pre-created template_id if available (per Klaviyo API docs)
    const templateId = templateIds?.[action.id];
    if (templateId) {
      message.template_id = templateId;
      this.log.info(`  Linking template ${templateId} to "${action.name}"`);
    }

    return {
      temporary_id: action.id,
      type: 'send-email',
      links: {
        next: action.next || null,
      },
      data: {
        message,
        status: 'draft',
      },
    };
  }

  private transformSendSms(action: SendSmsAction, settings?: FlowSettings): KlaviyoAPIAction {
    const smartSending = this.resolveSetting(action.smart_sending, settings?.smart_sending, true);
    const utmTracking = this.resolveSetting(action.utm_tracking, settings?.utm_tracking, false);

    return {
      temporary_id: action.id,
      type: 'send-sms',
      links: {
        next: action.next || null,
      },
      data: {
        message: {
          name: action.name,
          body: action.body || '',
          smart_sending_enabled: smartSending,
          transactional: false,
          add_tracking_params: utmTracking,
          respecting_sms_quiet_hours: true,
          custom_tracking_params: null,
          additional_filters: null,
        },
        status: 'draft',
      },
    };
  }

  private transformConditionalSplit(action: ConditionalSplitAction): KlaviyoAPIAction {
    // Build the condition filter based on condition_type
    const profileFilter = this.buildConditionFilter(action);

    return {
      temporary_id: action.id,
      type: 'conditional-split',
      links: {
        next_if_true: action.next_if_true || null,
        next_if_false: action.next_if_false || null,
      },
      data: {
        profile_filter: profileFilter,
      },
    };
  }

  /**
   * Build a Klaviyo profile_filter from a human-readable condition type.
   *
   * NOTE: Klaviyo's beta Flows API does not fully document the `profile-metric`
   * condition schema (specifically `timeframe_filter`). For metric-based conditions
   * like "has opened email", we create the split structure using a consent
   * placeholder condition that produces the correct YES/NO branching, then log
   * a message indicating the condition should be updated in the Klaviyo UI.
   *
   * This is the pragmatic approach: the tool builds the SKELETON (structure,
   * branching, delays, emails) — condition fine-tuning is done in the UI.
   */
  private buildConditionFilter(action: ConditionalSplitAction): Record<string, unknown> {
    switch (action.condition_type) {
      case 'has-opened-email':
      case 'has-clicked-email':
      case 'has-received-email':
        // Metric-based conditions: use consent placeholder for structure,
        // log a note to adjust in the UI
        this.log.warn(
          `Conditional split "${action.condition_label}" uses a placeholder condition. ` +
          `After flow creation, update this split in the Klaviyo UI to: ` +
          `"What someone has done" → "${this.getMetricLabel(action.condition_type)}".`,
        );
        return {
          condition_groups: [{
            conditions: [{
              type: 'profile-marketing-consent',
              consent: {
                channel: 'email',
                can_receive_marketing: true,
                consent_status: {
                  subscription: 'subscribed',
                  filters: null,
                },
              },
            }],
          }],
        };

      case 'profile-marketing-consent':
        return {
          condition_groups: [{
            conditions: [{
              type: 'profile-marketing-consent',
              consent: {
                channel: action.condition_config?.channel || 'email',
                can_receive_marketing: true,
                consent_status: {
                  subscription: 'subscribed',
                  filters: null,
                },
              },
            }],
          }],
        };

      case 'custom':
        // Pass through custom filter config directly
        return action.condition_config?.profile_filter as Record<string, unknown> || {
          condition_groups: [],
        };

      default:
        this.log.warn(`Unknown condition type: ${action.condition_type}. Using consent placeholder.`);
        return {
          condition_groups: [{
            conditions: [{
              type: 'profile-marketing-consent',
              consent: {
                channel: 'email',
                can_receive_marketing: true,
                consent_status: {
                  subscription: 'subscribed',
                  filters: null,
                },
              },
            }],
          }],
        };
    }
  }

  private getMetricLabel(conditionType: string): string {
    switch (conditionType) {
      case 'has-opened-email': return 'Opened Email';
      case 'has-clicked-email': return 'Clicked Email';
      case 'has-received-email': return 'Received Email';
      default: return conditionType;
    }
  }

  // ---------------------------------------------------------------------------
  // Payload Assembly
  // ---------------------------------------------------------------------------

  private buildPayload(
    definition: FlowDefinition,
    trigger: KlaviyoAPITrigger,
    actions: KlaviyoAPIAction[],
  ): KlaviyoCreateFlowPayload {
    return {
      data: {
        type: 'flow',
        attributes: {
          name: definition.name,
          definition: {
            triggers: [trigger],
            profile_filter: definition.profile_filter || null,
            actions,
            entry_action_id: definition.entry_action_id,
          },
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Email Content — upload images + generate HTML + apply to templates
  // ---------------------------------------------------------------------------

  /**
   * After flow creation, walk the action→message→template chain and apply
   * generated HTML to each email that has content defined.
   *
   * Pipeline:
   *   1. Upload local images to Klaviyo → get hosted URLs
   *   2. Replace local paths with hosted URLs in content
   *   3. Generate HTML from content sections
   *   4. Get flow actions → match to our definition by order + type
   *   5. Get flow messages → get templates
   *   6. Update templates with generated HTML (or create new CODE templates)
   */
  private async applyEmailContent(
    flowId: string,
    definition: FlowDefinition,
    emailsWithContent: SendEmailAction[],
  ): Promise<{ templatesApplied: number; imagesUploaded: number; warnings: string[] }> {
    let templatesApplied = 0;
    let imagesUploaded = 0;
    const warnings: string[] = [];

    // --- Step 1: Upload all local images across all emails ---
    const imageUrlCache: Record<string, string> = {};
    for (const email of emailsWithContent) {
      const { local } = extractImageSources(email.content!);
      for (const localPath of local) {
        if (imageUrlCache[localPath]) continue; // Already uploaded

        try {
          const fileName = path.basename(localPath);
          const result = await withRetry(
            () => this.client.uploadImageFromFile(localPath, fileName),
            `Upload image: ${fileName}`,
            { maxAttempts: 2 },
          );
          imageUrlCache[localPath] = result.data.attributes.image_url;
          imagesUploaded++;
          // Small delay to respect rate limits (3/s burst)
          await this.sleep(400);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`Failed to upload image "${localPath}": ${msg}`);
          warnings.push(`Image "${localPath}" could not be uploaded. Add it manually in Klaviyo.`);
        }
      }
    }

    // --- Step 2: Replace local paths with hosted URLs in content ---
    for (const email of emailsWithContent) {
      for (const section of email.content!.sections) {
        if (section.type === 'image' && isLocalFile(section.src)) {
          const hosted = imageUrlCache[section.src];
          if (hosted) {
            (section as ImageSection).src = hosted;
          }
        }
      }
    }

    // --- Step 3: Generate HTML for each email ---
    const htmlByEmailId: Record<string, string> = {};
    for (const email of emailsWithContent) {
      const html = buildEmailHtml(email.content!);
      htmlByEmailId[email.id] = html;
      this.log.info(`  Generated HTML for "${email.name}" (${html.length} bytes)`);
    }

    // --- Step 4: Walk the action→message→template chain ---
    this.log.info('  Waiting for Klaviyo to finalize flow actions...');
    await this.sleep(5000); // Klaviyo needs time to create templates for new email actions
    this.log.info('  Fetching flow actions from Klaviyo...');

    const flowActionsResponse = await withRetry(
      () => this.client.getFlowActions(flowId),
      'Fetch flow actions',
      { maxAttempts: 3 },
    );

    const flowActions = flowActionsResponse.data || [];
    this.log.info(`  Found ${flowActions.length} flow actions`);

    // Log all action types so we can see what Klaviyo returns
    for (const a of flowActions) {
      this.log.info(`    Action ${a.id}: type="${a.attributes.action_type}" status="${a.attributes.status}"`);
    }

    // Filter to email actions — Klaviyo may use different names across API versions
    // Match broadly: send-email, send_email, EMAIL, email, SEND_EMAIL, etc.
    const emailFlowActions = flowActions.filter((a) => {
      const t = (a.attributes.action_type || '').toLowerCase().replace(/[-_\s]/g, '');
      return t === 'sendemail' || t === 'email';
    });
    this.log.info(`  Found ${emailFlowActions.length} email actions`);

    // Match Klaviyo flow actions to our definition's email actions by order.
    // The Flows API creates actions in the order they appear in the definition,
    // so we match by index among email-type actions.
    const allEmailActions = definition.actions.filter(
      (a) => a.type === 'send-email',
    ) as SendEmailAction[];

    for (let i = 0; i < emailFlowActions.length && i < allEmailActions.length; i++) {
      const defEmail = allEmailActions[i];
      const klaviyoAction = emailFlowActions[i];

      // Skip emails without content
      if (!htmlByEmailId[defEmail.id]) continue;

      try {
        // Get the flow message for this action
        const messagesResponse = await this.client.getFlowActionMessages(klaviyoAction.id);
        const messages = messagesResponse.data || [];

        if (messages.length === 0) {
          this.log.warn(`  No messages found for action "${defEmail.name}" — skipping content.`);
          warnings.push(`No message found for "${defEmail.name}". Apply template manually.`);
          continue;
        }

        const messageId = messages[0].id;
        this.log.info(`  Action "${defEmail.name}" → Message ${messageId}`);

        const html = htmlByEmailId[defEmail.id];

        // Try to get the existing template for this message
        let templateId: string | null = null;
        let editorType: string | null = null;

        // First attempt
        try {
          const templateResponse = await this.client.getTemplateForMessage(messageId);
          if (templateResponse?.data?.id) {
            templateId = templateResponse.data.id;
            editorType = templateResponse.data.attributes?.editor_type || 'UNKNOWN';
            this.log.info(`  Message ${messageId} → Template ${templateId} (${editorType})`);
          }
        } catch (tmplErr) {
          // ignore, will retry
        }

        // Retry after delay if first attempt failed (template may still be generating)
        if (!templateId) {
          this.log.info(`  Message ${messageId} → No template yet, waiting 3s and retrying...`);
          await this.sleep(3000);
          try {
            const templateResponse = await this.client.getTemplateForMessage(messageId);
            if (templateResponse?.data?.id) {
              templateId = templateResponse.data.id;
              editorType = templateResponse.data.attributes?.editor_type || 'UNKNOWN';
              this.log.info(`  Message ${messageId} → Template ${templateId} (${editorType}) [retry]`);
            } else {
              this.log.info(`  Message ${messageId} → No template assigned (will create new)`);
            }
          } catch (tmplErr) {
            this.log.info(`  Message ${messageId} → Could not retrieve template (will create new)`);
          }
        }

        // Strategy 1: Update existing template if it's CODE type
        if (templateId && (editorType === 'CODE' || editorType === 'HTML')) {
          try {
            await this.client.updateTemplate(templateId, html);
            this.log.info(`  ✓ Template updated for "${defEmail.name}"`);
            templatesApplied++;
            await this.sleep(300);
            continue;
          } catch (updateErr) {
            this.log.warn(`  Could not update existing template, trying alternatives...`);
          }
        }

        // Strategy 2: Try updating even if type is unknown (might work)
        if (templateId && editorType !== 'CODE' && editorType !== 'HTML') {
          try {
            await this.client.updateTemplate(templateId, html);
            this.log.info(`  ✓ Template updated for "${defEmail.name}" (was ${editorType})`);
            templatesApplied++;
            await this.sleep(300);
            continue;
          } catch (updateErr) {
            this.log.warn(`  Template ${templateId} (${editorType}) cannot be updated via API.`);
          }
        }

        // Strategy 3: Create a new CODE template as fallback
        this.log.info(`  Creating new CODE template for "${defEmail.name}"...`);
        try {
          const newTemplate = await this.client.createTemplate(
            `${defEmail.name} — Generated`,
            html,
          );
          this.log.info(`  ✓ Created template ${newTemplate.data.id} for "${defEmail.name}"`);
          this.log.warn(
            `  Note: New template created but needs to be manually linked to the flow email ` +
            `in Klaviyo. Open the email action and select this template from the library.`,
          );
          warnings.push(
            `Template for "${defEmail.name}" was created separately (${newTemplate.data.id}). ` +
            `Link it to the flow email manually in Klaviyo's editor.`,
          );
          templatesApplied++;
        } catch (createErr) {
          const msg = createErr instanceof Error ? createErr.message : String(createErr);
          this.log.warn(`  Failed to create template for "${defEmail.name}": ${msg}`);
          warnings.push(`Template for "${defEmail.name}" could not be applied. Design it manually.`);
        }

        // Rate limit courtesy
        await this.sleep(300);

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`  Failed to apply content to "${defEmail.name}": ${msg}`);
        warnings.push(`Content for "${defEmail.name}" could not be applied: ${msg}`);
      }
    }

    this.log.info(`\n  Email content phase complete: ${templatesApplied} template(s), ${imagesUploaded} image(s) uploaded`);
    return { templatesApplied, imagesUploaded, warnings };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
