#!/usr/bin/env node
// =============================================================================
// Klaviyo Flow Builder — CLI Entry Point
// =============================================================================
// Dual-mode flow builder: API-first with Playwright browser automation fallback.
//
// Usage:
//   npx ts-node src/index.ts build --flow flows/abandoned-cart.json
//   npx ts-node src/index.ts build --flow flows/abandoned-cart.json --mode browser
//   npx ts-node src/index.ts build --flow flows/abandoned-cart.json --mode api
//   npx ts-node src/index.ts verify --flow-id <FLOW_ID>
//   npx ts-node src/index.ts test-connection
// =============================================================================

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { loadConfig, validateConfig } from './config';
import { FlowDefinition, BuildMode, BuildResult } from './types';
import { APIFlowCreator } from './api/flow-creator';
import { BrowserFlowBuilder } from './browser/flow-builder';
import { BrowserFlowConfigurator } from './browser/flow-configurator';
import { KlaviyoAPIClient } from './api/client';
import { createLogger } from './utils/logger';
import { validateFlowDefinition } from './utils/validator';

const program = new Command();

program
  .name('klaviyo-flow-builder')
  .description('Automated Klaviyo flow builder — API + Browser Automation')
  .version('1.0.0');

// =============================================================================
// BUILD Command
// =============================================================================
program
  .command('build')
  .description('Build a flow in Klaviyo from a JSON definition')
  .requiredOption('-f, --flow <path>', 'Path to flow definition JSON file')
  .option('-m, --mode <mode>', 'Build mode: api, browser, or hybrid', 'api')
  .option('-k, --api-key <key>', 'Klaviyo API key (overrides .env)')
  .option('--headless', 'Run browser in headless mode', true)
  .option('--no-headless', 'Show browser window')
  .option('--slow-mo <ms>', 'Slow down browser actions (ms)')
  .option('-v, --verbose', 'Enable verbose logging')
  .action(async (options) => {
    const log = createLogger(options.verbose ? 'debug' : 'info');

    printBanner();

    // Load flow definition
    const flowPath = path.resolve(options.flow);
    if (!fs.existsSync(flowPath)) {
      log.error(`Flow definition not found: ${flowPath}`);
      process.exit(1);
    }

    let definition: FlowDefinition;
    try {
      const raw = fs.readFileSync(flowPath, 'utf-8');
      definition = JSON.parse(raw) as FlowDefinition;
      log.info(`Loaded flow definition: "${definition.name}" (${definition.actions.length} actions)`);
    } catch (error) {
      log.error(`Failed to parse flow definition: ${error}`);
      process.exit(1);
    }

    // Load config
    const config = loadConfig({
      mode: options.mode as BuildMode,
      apiKey: options.apiKey,
      headless: options.headless,
      slowMo: options.slowMo ? parseInt(options.slowMo) : undefined,
    });

    const configErrors = validateConfig(config);
    if (configErrors.length > 0) {
      log.error('Configuration errors:');
      configErrors.forEach((e) => log.error(`  - ${e}`));
      process.exit(1);
    }

    // Validate the flow definition
    log.info('Validating flow definition...');
    const validation = validateFlowDefinition(definition);
    if (!validation.valid) {
      log.error('Validation failed:');
      validation.errors.forEach((e) => log.error(`  ✗ ${e}`));
      process.exit(1);
    }
    validation.warnings.forEach((w) => log.warn(`  ⚠ ${w}`));
    log.info('Validation passed.');

    // Phase 1: Build the flow
    let result: BuildResult;

    switch (config.mode) {
      case 'api':
        result = await buildViaAPI(definition, config);
        break;
      case 'browser':
        result = await buildViaBrowser(definition, config);
        break;
      case 'hybrid':
        result = await buildHybrid(definition, config);
        break;
      default:
        log.error(`Unknown mode: ${config.mode}`);
        process.exit(1);
    }

    // Phase 2: Browser-based configuration (re-entry) if needed
    if (result.success && result.flowId && definition.settings?.reentry) {
      await runPhase2(result, definition, config);
    }

    // Print results
    printResult(result);
    process.exit(result.success ? 0 : 1);
  });

// =============================================================================
// VERIFY Command
// =============================================================================
program
  .command('verify')
  .description('Verify a flow was created correctly')
  .requiredOption('--flow-id <id>', 'Klaviyo flow ID to verify')
  .option('-k, --api-key <key>', 'Klaviyo API key (overrides .env)')
  .action(async (options) => {
    const log = createLogger('info');
    printBanner();

    const config = loadConfig({ apiKey: options.apiKey });

    if (!config.apiKey) {
      log.error('KLAVIYO_API_KEY is required for verification.');
      process.exit(1);
    }

    const client = new KlaviyoAPIClient(config);

    try {
      const flow = await client.getFlow(options.flowId, true);
      const attrs = flow.data.attributes;

      console.log(chalk.green('\n  Flow Verified Successfully\n'));
      console.log(`  Name:    ${attrs.name}`);
      console.log(`  Status:  ${attrs.status}`);
      console.log(`  ID:      ${flow.data.id}`);
      console.log(`  Created: ${attrs.created}`);

      if (attrs.definition) {
        const actions = attrs.definition.actions || [];
        console.log(`  Actions: ${actions.length}`);
        actions.forEach((a, i) => {
          console.log(`    ${i + 1}. ${a.type} (ID: ${a.temporary_id || 'N/A'})`);
        });
      }

      console.log(`\n  URL: https://www.klaviyo.com/flow/${flow.data.id}/edit\n`);
    } catch (error) {
      log.error(`Failed to verify flow: ${error}`);
      process.exit(1);
    }
  });

// =============================================================================
// TEST-CONNECTION Command
// =============================================================================
program
  .command('test-connection')
  .description('Test the Klaviyo API connection')
  .option('-k, --api-key <key>', 'Klaviyo API key (overrides .env)')
  .action(async (options) => {
    const log = createLogger('info');
    printBanner();

    const config = loadConfig({ apiKey: options.apiKey });

    if (!config.apiKey) {
      log.error('KLAVIYO_API_KEY is required. Set it in .env or pass --api-key.');
      process.exit(1);
    }

    const client = new KlaviyoAPIClient(config);
    const connected = await client.testConnection();

    if (connected) {
      console.log(chalk.green('\n  Klaviyo API connection successful!\n'));
    } else {
      console.log(chalk.red('\n  Klaviyo API connection failed. Check your API key.\n'));
      process.exit(1);
    }
  });

// =============================================================================
// LIST-FLOWS Command
// =============================================================================
program
  .command('list-flows')
  .description('List all flows in your Klaviyo account')
  .option('-k, --api-key <key>', 'Klaviyo API key (overrides .env)')
  .option('-s, --status <status>', 'Filter by status: draft, manual, live')
  .action(async (options) => {
    const log = createLogger('info');
    printBanner();

    const config = loadConfig({ apiKey: options.apiKey });

    if (!config.apiKey) {
      log.error('KLAVIYO_API_KEY is required.');
      process.exit(1);
    }

    const client = new KlaviyoAPIClient(config);

    try {
      const flows = await client.getFlows(options.status);
      console.log(chalk.cyan(`\n  Found ${(flows as unknown[]).length} flow(s):\n`));

      (flows as unknown as Array<{ data: { id: string; attributes: { name: string; status: string; trigger_type: string } } }>).forEach((flow, i) => {
        const attrs = flow.data.attributes;
        console.log(`  ${i + 1}. ${attrs.name}`);
        console.log(`     ID: ${flow.data.id} | Status: ${attrs.status} | Trigger: ${attrs.trigger_type}`);
      });
      console.log('');
    } catch (error) {
      log.error(`Failed to list flows: ${error}`);
      process.exit(1);
    }
  });

// =============================================================================
// Phase 2: Browser-based Configuration
// =============================================================================

async function runPhase2(
  result: BuildResult,
  definition: FlowDefinition,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const log = createLogger();
  const reentry = definition.settings!.reentry!;

  log.info('');
  log.info('── Phase 2: Browser Configuration ──');

  // Ensure browser credentials are available
  if (!config.email || !config.password) {
    const msg = 'Re-entry config requires browser automation but KLAVIYO_EMAIL/KLAVIYO_PASSWORD are not set.';
    result.warnings.push(msg);
    log.warn(msg);
    log.warn('Set re-entry manually in Klaviyo: ' + result.flowUrl);
    return;
  }

  try {
    const configurator = new BrowserFlowConfigurator(config);
    const configResult = await configurator.configureReentry(result.flowId!, reentry);

    if (configResult.reentrySet) {
      result.warnings.push(`Re-entry set to "${reentry.mode}" via browser automation.`);
    } else {
      result.warnings.push('Re-entry could not be set automatically. Configure manually in Klaviyo.');
    }

    if (configResult.screenshots.length > 0) {
      result.screenshots = [...(result.screenshots || []), ...configResult.screenshots];
    }

    if (configResult.errors.length > 0) {
      result.warnings.push(...configResult.errors);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.warnings.push(`Phase 2 failed: ${msg}. Set re-entry manually.`);
    log.warn(`Phase 2 error: ${msg}`);
  }
}

// =============================================================================
// Build Functions
// =============================================================================

async function buildViaAPI(definition: FlowDefinition, config: ReturnType<typeof loadConfig>): Promise<BuildResult> {
  const creator = new APIFlowCreator(config);
  return creator.buildFlow(definition);
}

async function buildViaBrowser(definition: FlowDefinition, config: ReturnType<typeof loadConfig>): Promise<BuildResult> {
  const builder = new BrowserFlowBuilder(config);
  return builder.buildFlow(definition);
}

async function buildHybrid(definition: FlowDefinition, config: ReturnType<typeof loadConfig>): Promise<BuildResult> {
  const log = createLogger();

  // Check if the flow has A/B splits (requires browser mode)
  const hasABSplit = definition.actions.some((a) => a.type === 'ab-split');

  if (hasABSplit) {
    log.info('Flow contains A/B splits — using browser automation (API does not support A/B tests).');
    return buildViaBrowser(definition, config);
  }

  // Try API first
  log.info('Hybrid mode: attempting API-first...');
  const apiResult = await buildViaAPI(definition, config);

  if (apiResult.success) {
    return apiResult;
  }

  // Fallback to browser
  log.warn('API mode failed. Falling back to browser automation...');
  const browserResult = await buildViaBrowser(definition, config);
  browserResult.warnings.push('Built via browser automation (API fallback).');
  return browserResult;
}

// =============================================================================
// Output Formatting
// =============================================================================

function printBanner(): void {
  console.log('');
  console.log(chalk.cyan('  ╔═══════════════════════════════════════════════╗'));
  console.log(chalk.cyan('  ║') + chalk.white.bold('   Klaviyo Flow Builder') + chalk.gray('  — ZHS Ecom        ') + chalk.cyan('║'));
  console.log(chalk.cyan('  ║') + chalk.gray('   API + Browser Automation • v1.0.0        ') + chalk.cyan('║'));
  console.log(chalk.cyan('  ╚═══════════════════════════════════════════════╝'));
  console.log('');
}

function printResult(result: BuildResult): void {
  console.log('');
  console.log(chalk.cyan('  ═══════════════════════════════════════════════'));
  console.log(chalk.cyan('  Build Result'));
  console.log(chalk.cyan('  ═══════════════════════════════════════════════'));
  console.log('');

  if (result.success) {
    console.log(chalk.green('  ✓ SUCCESS'));
  } else {
    console.log(chalk.red('  ✗ FAILED'));
  }

  console.log('');
  console.log(`  Flow:     ${result.flowName}`);
  console.log(`  Mode:     ${result.mode}`);
  console.log(`  Actions:  ${result.actionsCreated}`);
  console.log(`  Duration: ${(result.duration / 1000).toFixed(1)}s`);

  if (result.flowId) {
    console.log(`  Flow ID:  ${result.flowId}`);
  }
  if (result.flowUrl) {
    console.log(`  URL:      ${result.flowUrl}`);
  }

  // Settings summary
  if (result.settingsApplied) {
    console.log('');
    console.log(chalk.cyan('  Settings Applied:'));
    for (const [key, value] of Object.entries(result.settingsApplied)) {
      console.log(chalk.cyan(`    ✓ ${key}: ${value}`));
    }
  }

  if (result.warnings.length > 0) {
    console.log('');
    console.log(chalk.yellow('  Warnings:'));
    result.warnings.forEach((w) => console.log(chalk.yellow(`    - ${w}`)));
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log(chalk.red('  Errors:'));
    result.errors.forEach((e) => console.log(chalk.red(`    - ${e}`)));
  }

  if (result.screenshots && result.screenshots.length > 0) {
    console.log('');
    console.log(chalk.gray('  Screenshots:'));
    result.screenshots.forEach((s) => console.log(chalk.gray(`    - ${s}`)));
  }

  console.log('');
}

// Run
program.parse();
