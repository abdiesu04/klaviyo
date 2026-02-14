// =============================================================================
// Klaviyo Flow Builder — Type Definitions
// =============================================================================
// Covers: Flow definitions, API payloads, browser selectors, config
// =============================================================================

// -----------------------------------------------------------------------------
// Flow Definition Types (user-facing input schema)
// -----------------------------------------------------------------------------

/** Supported flow trigger types */
export type TriggerType =
  | 'metric'          // e.g., "Started Checkout", "Added to Cart"
  | 'list'            // Added to list
  | 'segment'         // Added to segment
  | 'date-property'   // e.g., birthday
  | 'price-drop';     // Price drop on viewed product

/** Supported flow action types */
export type ActionType =
  | 'send-email'
  | 'send-sms'
  | 'time-delay'
  | 'conditional-split'
  | 'trigger-split'
  | 'ab-split'
  | 'webhook'
  | 'update-profile';

/** Time delay units */
export type DelayUnit = 'minutes' | 'hours' | 'days' | 'weeks';

/** Days of the week */
export type Weekday =
  | 'monday' | 'tuesday' | 'wednesday' | 'thursday'
  | 'friday' | 'saturday' | 'sunday';

/** Conditional split condition types */
export type ConditionType =
  | 'has-opened-email'
  | 'has-clicked-email'
  | 'has-received-email'
  | 'has-been-in-flow'
  | 'profile-property'
  | 'profile-marketing-consent'
  | 'metric-property'
  | 'custom';

// --- Re-entry Configuration ---

/** Re-entry: how many times a profile can enter this flow */
export type ReentryMode = 'once' | 'multiple' | 'time-based';

export interface ReentryConfig {
  /** once = one time ever, multiple = every trigger, time-based = once per time window */
  mode: ReentryMode;
  /** Only used when mode is 'time-based' — the cooldown value */
  value?: number;
  /** Only used when mode is 'time-based' — the cooldown unit */
  unit?: 'hours' | 'days' | 'weeks';
}

// --- Flow-level Settings ---

export interface FlowSettings {
  /** Default smart sending for all email/SMS actions (default: true) */
  smart_sending?: boolean;
  /** Default UTM tracking for all email/SMS actions (default: false) */
  utm_tracking?: boolean;
  /** Re-entry configuration (default: not set — uses Klaviyo default) */
  reentry?: ReentryConfig;
}

// --- Trigger ---

export interface MetricTrigger {
  type: 'metric';
  metric_name: string;        // Human-readable name, e.g. "Started Checkout"
  metric_id?: string;         // Klaviyo metric ID (resolved at runtime if not provided)
  trigger_filter?: TriggerFilter;
}

export interface ListTrigger {
  type: 'list';
  list_name: string;
  list_id?: string;
}

export interface DateTrigger {
  type: 'date-property';
  property_name: string;      // e.g., "birthday"
  offset_days?: number;       // Days before/after the date
}

export type FlowTrigger = MetricTrigger | ListTrigger | DateTrigger;

export interface TriggerFilter {
  condition_groups: ConditionGroup[];
}

export interface ConditionGroup {
  conditions: FilterCondition[];
}

export interface FilterCondition {
  type: string;
  [key: string]: unknown;
}

// --- Email Content (sliced image emails) ---

/** A single section in a sliced email — image, text, button, or spacer */
export type EmailSection =
  | ImageSection
  | TextSection
  | ButtonSection
  | SpacerSection;

export interface ImageSection {
  type: 'image';
  /** URL or local file path (e.g., "./images/header.jpg") */
  src: string;
  /** Alt text for accessibility and fallback */
  alt?: string;
  /** Optional click-through URL for the image */
  link?: string;
  /** Display width in px (default: 600) — images should be exported at 2x for retina */
  width?: number;
}

export interface TextSection {
  type: 'text';
  /** HTML content — headlines, body copy, links. Kept live (not baked into images). */
  html: string;
  /** Text alignment (default: 'center') */
  align?: 'left' | 'center' | 'right';
  /** Padding around the text block in px (default: 20) */
  padding?: number;
}

export interface ButtonSection {
  type: 'button';
  /** Button label text */
  text: string;
  /** Click-through URL — supports Klaviyo variables like {{ event.extra.checkout_url }} */
  url: string;
  /** Button background color (default: '#000000') */
  background?: string;
  /** Button text color (default: '#ffffff') */
  color?: string;
  /** Border radius in px (default: 4) */
  border_radius?: number;
  /** Padding around the button in px (default: 20) */
  padding?: number;
}

export interface SpacerSection {
  type: 'spacer';
  /** Height in px (default: 20) */
  height?: number;
}

/** Email body content — an ordered list of sliced sections */
export interface EmailContent {
  /** Ordered sections: images, text blocks, CTA buttons, spacers */
  sections: EmailSection[];
  /** Email background color (default: '#ffffff') */
  background_color?: string;
  /** Content area width in px (default: 600) */
  width?: number;
}

// --- Actions ---

export interface TimeDelayAction {
  id: string;
  type: 'time-delay';
  delay_value: number;
  delay_unit: DelayUnit;
  next?: string;              // ID of next action
}

export interface SendEmailAction {
  id: string;
  type: 'send-email';
  name: string;               // e.g., "Abandoned Cart Email #1"
  subject_line?: string;
  preview_text?: string;
  /** Per-action override: true/false overrides flow default, undefined = inherit */
  smart_sending?: boolean;
  /** Per-action override: true/false overrides flow default, undefined = inherit */
  utm_tracking?: boolean;
  /** Email body content — sliced images, text blocks, CTA buttons */
  content?: EmailContent;
  next?: string;
}

export interface SendSmsAction {
  id: string;
  type: 'send-sms';
  name: string;
  body?: string;
  /** Per-action override: true/false overrides flow default, undefined = inherit */
  smart_sending?: boolean;
  /** Per-action override: true/false overrides flow default, undefined = inherit */
  utm_tracking?: boolean;
  next?: string;
}

export interface ConditionalSplitAction {
  id: string;
  type: 'conditional-split';
  condition_type: ConditionType;
  condition_label: string;    // Human-readable, e.g. "Has Opened Email"
  condition_config?: Record<string, unknown>;
  next_if_true?: string;      // ID of action if condition is true
  next_if_false?: string;     // ID of action if condition is false
}

export interface ABSplitAction {
  id: string;
  type: 'ab-split';
  variant_a_label?: string;
  variant_b_label?: string;
  split_percentage?: number;  // Percentage for variant A (e.g., 50)
  next_variant_a?: string;
  next_variant_b?: string;
}

export type FlowAction =
  | TimeDelayAction
  | SendEmailAction
  | SendSmsAction
  | ConditionalSplitAction
  | ABSplitAction;

// --- Flow Definition (the main input) ---

export interface FlowDefinition {
  /** Flow name displayed in Klaviyo */
  name: string;
  /** Flow trigger configuration */
  trigger: FlowTrigger;
  /** Ordered list of flow actions (linked via next/next_if_true/next_if_false) */
  actions: FlowAction[];
  /** ID of the first action in the flow */
  entry_action_id: string;
  /** Optional profile filter for flow entry */
  profile_filter?: TriggerFilter | null;
  /** Flow-level settings: smart sending, UTM tracking, re-entry */
  settings?: FlowSettings;
  /** Optional tags */
  tags?: string[];
}

// -----------------------------------------------------------------------------
// Klaviyo API Types (for API mode)
// -----------------------------------------------------------------------------

export interface KlaviyoAPIAction {
  temporary_id: string;
  type: string;
  links: {
    next?: string | null;
    next_if_true?: string | null;
    next_if_false?: string | null;
  };
  data: Record<string, unknown>;
}

export interface KlaviyoAPITrigger {
  type: string;
  id: string;
  trigger_filter?: {
    condition_groups: Array<{
      conditions: Array<Record<string, unknown>>;
    }>;
  };
}

export interface KlaviyoCreateFlowPayload {
  data: {
    type: 'flow';
    attributes: {
      name: string;
      definition: {
        triggers: KlaviyoAPITrigger[];
        profile_filter: TriggerFilter | null;
        actions: KlaviyoAPIAction[];
        entry_action_id: string;
      };
    };
  };
}

export interface KlaviyoFlowResponse {
  data: {
    type: 'flow';
    id: string;
    attributes: {
      name: string;
      status: string;
      archived: boolean;
      created: string;
      updated: string;
      trigger_type: string;
      definition?: {
        triggers: KlaviyoAPITrigger[];
        profile_filter: TriggerFilter | null;
        actions: KlaviyoAPIAction[];
        entry_action_id: string;
      };
    };
    relationships?: Record<string, unknown>;
    links?: Record<string, unknown>;
  };
}

// -----------------------------------------------------------------------------
// Configuration Types
// -----------------------------------------------------------------------------

export type BuildMode = 'api' | 'browser' | 'hybrid';

export interface AppConfig {
  /** Build mode: api (default), browser, or hybrid */
  mode: BuildMode;
  /** Klaviyo API key */
  apiKey: string;
  /** Klaviyo API revision header */
  apiRevision: string;
  /** Klaviyo login email (for browser mode) */
  email: string;
  /** Klaviyo login password (for browser mode) */
  password: string;
  /** Run browser headless */
  headless: boolean;
  /** Slow down browser actions (ms) */
  slowMo: number;
  /** Screenshot directory */
  screenshotDir: string;
  /** Log level */
  logLevel: string;
  /** Max retries for flaky operations */
  maxRetries: number;
  /** Page timeout in ms */
  pageTimeout: number;
}

// -----------------------------------------------------------------------------
// Build Result Types
// -----------------------------------------------------------------------------

export interface BuildResult {
  success: boolean;
  mode: BuildMode;
  flowId?: string;
  flowName: string;
  flowUrl?: string;
  actionsCreated: number;
  errors: string[];
  warnings: string[];
  screenshots?: string[];
  duration: number;          // ms
  /** Summary of settings that were applied (for display) */
  settingsApplied?: Record<string, string>;
  /** Number of email templates that had content applied */
  templatesApplied?: number;
  /** Number of images uploaded to Klaviyo */
  imagesUploaded?: number;
  /** Pre-created template IDs mapped to email action IDs (for browser linking) */
  preCreatedTemplates?: Record<string, string>;
}

// -----------------------------------------------------------------------------
// Klaviyo Images API Types
// -----------------------------------------------------------------------------

export interface KlaviyoImageResponse {
  data: {
    type: 'image';
    id: string;
    attributes: {
      name: string;
      image_url: string;
      format: string;
      size: number;
      hidden: boolean;
      updated_at: string;
    };
  };
}

// -----------------------------------------------------------------------------
// Klaviyo Templates API Types
// -----------------------------------------------------------------------------

export interface KlaviyoTemplateResponse {
  data: {
    type: 'template';
    id: string;
    attributes: {
      name: string;
      editor_type: string;
      html?: string;
      text?: string;
      created: string;
      updated: string;
    };
  };
}

// -----------------------------------------------------------------------------
// Klaviyo Flow Action / Message Types (for post-creation template chain)
// -----------------------------------------------------------------------------

export interface KlaviyoFlowActionResponse {
  data: Array<{
    type: 'flow-action';
    id: string;
    attributes: {
      action_type: string;
      status: string;
      created: string;
      updated: string;
      settings?: Record<string, unknown>;
    };
    relationships?: Record<string, unknown>;
  }>;
}

export interface KlaviyoFlowMessageResponse {
  data: Array<{
    type: 'flow-message';
    id: string;
    attributes: {
      name: string;
      channel: string;
      content?: Record<string, unknown>;
      created: string;
      updated: string;
    };
  }>;
}

export interface VerifyResult {
  success: boolean;
  flowId: string;
  flowName: string;
  expectedActions: number;
  actualActions: number;
  mismatches: string[];
  screenshot?: string;
}
