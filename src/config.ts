// =============================================================================
// Klaviyo Flow Builder — Configuration
// =============================================================================

import * as dotenv from 'dotenv';
import * as path from 'path';
import { AppConfig, BuildMode } from './types';

// Load .env from project root (use cwd for reliable resolution)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Load and validate configuration from environment variables.
 */
export function loadConfig(overrides?: Partial<AppConfig>): AppConfig {
  // Filter out undefined values from overrides so they don't overwrite env values
  const cleanOverrides: Partial<AppConfig> = {};
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        (cleanOverrides as Record<string, unknown>)[key] = value;
      }
    }
  }

  const config: AppConfig = {
    mode: (process.env.BUILD_MODE as BuildMode) || 'api',
    apiKey: process.env.KLAVIYO_API_KEY || '',
    apiRevision: process.env.KLAVIYO_API_REVISION || '2024-10-15.pre',
    email: process.env.KLAVIYO_EMAIL || '',
    password: process.env.KLAVIYO_PASSWORD || '',
    headless: process.env.HEADLESS !== 'false',
    slowMo: parseInt(process.env.SLOW_MO || '0', 10),
    screenshotDir: process.env.SCREENSHOT_DIR || './screenshots',
    logLevel: process.env.LOG_LEVEL || 'info',
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    pageTimeout: parseInt(process.env.PAGE_TIMEOUT || '30000', 10),
    ...cleanOverrides,
  };

  return config;
}

/**
 * Validate that required config values are present for the given mode.
 */
export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  if (config.mode === 'api' || config.mode === 'hybrid') {
    if (!config.apiKey) {
      errors.push('KLAVIYO_API_KEY is required for API mode. Set it in .env or pass --api-key.');
    }
  }

  if (config.mode === 'browser' || config.mode === 'hybrid') {
    if (!config.email) {
      errors.push('KLAVIYO_EMAIL is required for browser mode. Set it in .env.');
    }
    if (!config.password) {
      errors.push('KLAVIYO_PASSWORD is required for browser mode. Set it in .env.');
    }
  }

  return errors;
}
