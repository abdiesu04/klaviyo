// =============================================================================
// Klaviyo Flow Builder — Flow Definition Validator
// =============================================================================
// Validates flow JSON before sending to the API. Catches errors early with
// clear, human-readable messages.
// =============================================================================

import {
  FlowDefinition,
  FlowAction,
  SendEmailAction,
  SendSmsAction,
  ConditionalSplitAction,
  ABSplitAction,
  TimeDelayAction,
  ReentryConfig,
} from '../types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a flow definition. Returns errors (must fix) and warnings (should fix).
 */
export function validateFlowDefinition(definition: FlowDefinition): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Required fields ---
  if (!definition.name || definition.name.trim() === '') {
    errors.push('Flow name is required.');
  }

  if (!definition.trigger) {
    errors.push('Flow trigger is required.');
  } else {
    validateTrigger(definition, errors);
  }

  if (!definition.actions || definition.actions.length === 0) {
    errors.push('Flow must have at least one action.');
  }

  if (!definition.entry_action_id) {
    errors.push('entry_action_id is required — it must reference the first action.');
  }

  // --- Action link validation ---
  if (definition.actions && definition.actions.length > 0) {
    const actionIds = new Set(definition.actions.map(a => a.id));

    // entry_action_id must exist
    if (definition.entry_action_id && !actionIds.has(definition.entry_action_id)) {
      errors.push(`entry_action_id "${definition.entry_action_id}" does not match any action ID.`);
    }

    // Check all action IDs are unique
    const idCounts: Record<string, number> = {};
    for (const action of definition.actions) {
      idCounts[action.id] = (idCounts[action.id] || 0) + 1;
    }
    for (const [id, count] of Object.entries(idCounts)) {
      if (count > 1) {
        errors.push(`Duplicate action ID: "${id}" appears ${count} times.`);
      }
    }

    // Validate each action's links
    for (const action of definition.actions) {
      validateActionLinks(action, actionIds, errors);
    }
  }

  // --- Settings validation ---
  if (definition.settings) {
    if (definition.settings.reentry) {
      validateReentry(definition.settings.reentry, errors);
    }
  }

  // --- Filter structure validation ---
  if (definition.profile_filter) {
    if (!definition.profile_filter.condition_groups || !Array.isArray(definition.profile_filter.condition_groups)) {
      errors.push('profile_filter must have a "condition_groups" array.');
    } else if (definition.profile_filter.condition_groups.length === 0) {
      warnings.push('profile_filter has empty condition_groups — it will have no effect.');
    }
  }

  if (definition.trigger?.type === 'metric' && definition.trigger.trigger_filter) {
    const tf = definition.trigger.trigger_filter;
    if (!tf.condition_groups || !Array.isArray(tf.condition_groups)) {
      errors.push('trigger_filter must have a "condition_groups" array.');
    } else if (tf.condition_groups.length === 0) {
      warnings.push('trigger_filter has empty condition_groups — it will have no effect.');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateTrigger(definition: FlowDefinition, errors: string[]): void {
  const trigger = definition.trigger;

  switch (trigger.type) {
    case 'metric':
      if (!trigger.metric_name && !trigger.metric_id) {
        errors.push('Metric trigger requires either metric_name or metric_id.');
      }
      break;
    case 'list':
      if (!trigger.list_name && !trigger.list_id) {
        errors.push('List trigger requires either list_name or list_id.');
      }
      break;
    case 'date-property':
      if (!trigger.property_name) {
        errors.push('Date trigger requires property_name.');
      }
      break;
    default:
      errors.push(`Unknown trigger type: "${(trigger as { type: string }).type}".`);
  }
}

function validateActionLinks(action: FlowAction, validIds: Set<string>, errors: string[]): void {
  switch (action.type) {
    case 'time-delay':
    case 'send-email':
    case 'send-sms': {
      const a = action as TimeDelayAction | SendEmailAction | SendSmsAction;
      if (a.next && !validIds.has(a.next)) {
        errors.push(`Action "${a.id}" has next="${a.next}" which doesn't exist.`);
      }
      break;
    }
    case 'conditional-split': {
      const cs = action as ConditionalSplitAction;
      if (cs.next_if_true && !validIds.has(cs.next_if_true)) {
        errors.push(`Action "${cs.id}" has next_if_true="${cs.next_if_true}" which doesn't exist.`);
      }
      if (cs.next_if_false && !validIds.has(cs.next_if_false)) {
        errors.push(`Action "${cs.id}" has next_if_false="${cs.next_if_false}" which doesn't exist.`);
      }
      break;
    }
    case 'ab-split': {
      const ab = action as ABSplitAction;
      if (ab.next_variant_a && !validIds.has(ab.next_variant_a)) {
        errors.push(`Action "${ab.id}" has next_variant_a="${ab.next_variant_a}" which doesn't exist.`);
      }
      if (ab.next_variant_b && !validIds.has(ab.next_variant_b)) {
        errors.push(`Action "${ab.id}" has next_variant_b="${ab.next_variant_b}" which doesn't exist.`);
      }
      break;
    }
  }
}

function validateReentry(reentry: ReentryConfig, errors: string[]): void {
  const validModes = ['once', 'multiple', 'time-based'];
  if (!validModes.includes(reentry.mode)) {
    errors.push(`settings.reentry.mode must be one of: ${validModes.join(', ')}. Got: "${reentry.mode}".`);
    return;
  }

  if (reentry.mode === 'time-based') {
    if (!reentry.value || reentry.value <= 0) {
      errors.push('settings.reentry with mode "time-based" requires a positive "value".');
    }
    const validUnits = ['hours', 'days', 'weeks'];
    if (!reentry.unit || !validUnits.includes(reentry.unit)) {
      errors.push(`settings.reentry.unit must be one of: ${validUnits.join(', ')}. Got: "${reentry.unit}".`);
    }
  }
}
