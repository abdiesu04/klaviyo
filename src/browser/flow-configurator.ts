// =============================================================================
// Klaviyo Flow Builder — Browser Flow Configurator
// =============================================================================
// Targeted browser automation for post-creation flow configuration.
// Handles settings that the Klaviyo API does not support (e.g., re-entry)
// and settings that browser-built flows miss (e.g., profile filters).
// =============================================================================

import { Page } from 'playwright';
import { ReentryConfig, TriggerFilter, AppConfig } from '../types';
import { KlaviyoAuth } from './auth';
import { SELECTORS, URLS } from './selectors';
import { getLogger } from '../utils/logger';
import { sleep } from '../utils/retry';

export interface ConfigureResult {
  success: boolean;
  reentrySet: boolean;
  profileFilterSet: boolean;
  templatesLinked: number;
  errors: string[];
  screenshots: string[];
  duration: number;
}

export class BrowserFlowConfigurator {
  private log = getLogger();
  private auth: KlaviyoAuth;
  private page: Page | null = null;

  constructor(private config: AppConfig) {
    this.auth = new KlaviyoAuth(config);
  }

  /**
   * Configure post-creation settings on an existing flow.
   * Handles re-entry criteria and profile filters via browser automation.
   */
  async configure(
    flowId: string,
    options: {
      reentry?: ReentryConfig;
      profileFilter?: TriggerFilter | null;
      /** Map of email action names → pre-created template names to link */
      templateMap?: Record<string, string>;
    },
  ): Promise<ConfigureResult> {
    const startTime = Date.now();
    const result: ConfigureResult = {
      success: false,
      reentrySet: false,
      profileFilterSet: false,
      templatesLinked: 0,
      errors: [],
      screenshots: [],
      duration: 0,
    };

    try {
      this.log.info(`Phase 2: Browser configuration...`);
      this.log.info(`  Flow ID: ${flowId}`);

      this.page = await this.auth.authenticate();

      // Navigate to the flow editor
      const flowUrl = URLS.flowEdit(flowId);
      this.log.info(`  Navigating to: ${flowUrl}`);
      await this.page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(5000);

      // Wait for canvas to fully load
      const rfWrapper = this.page.locator('[data-testid="rf__wrapper"]');
      await rfWrapper.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
        this.log.warn('  Canvas wrapper not found, waiting more...');
      });
      await sleep(5000); // Extra wait for all nodes to render

      // Click the trigger node to open config panel
      this.log.info('  Opening trigger configuration...');
      const triggerNode = this.page.locator(SELECTORS.canvas.triggerNode).first();
      await triggerNode.waitFor({ state: 'visible', timeout: 30000 });
      await triggerNode.click();
      await sleep(2000);

      // Wait for config panel
      const configPanel = this.page.locator(SELECTORS.configPanel.content);
      await configPanel.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

      // Configure re-entry if requested
      if (options.reentry) {
        const reentryOk = await this.setReentry(options.reentry);
        result.reentrySet = reentryOk;
        if (!reentryOk) {
          result.errors.push('Re-entry could not be set automatically. Configure manually.');
        }
      }

      // Configure profile filter if requested
      if (options.profileFilter && options.profileFilter.condition_groups?.length > 0) {
        const filterOk = await this.setProfileFilter(options.profileFilter);
        result.profileFilterSet = filterOk;
        if (!filterOk) {
          result.errors.push('Profile filter could not be set automatically. Configure manually.');
        }
      }

      // Link pre-created templates to flow emails
      if (options.templateMap && Object.keys(options.templateMap).length > 0) {
        this.log.info(`\n  Phase 3: Linking ${Object.keys(options.templateMap).length} template(s) to flow emails...`);

        // Close any open panel first by pressing Escape
        await this.page.keyboard.press('Escape');
        await sleep(1000);

        for (const [emailName, templateName] of Object.entries(options.templateMap)) {
          try {
            // Navigate fresh to flow editor before each email (clean state)
            const flowUrl = URLS.flowEdit(flowId);
            await this.page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(8000); // Wait for canvas to fully render all nodes

            // Zoom out to see all nodes (press Ctrl+- a few times or use fit-to-view)
            await this.zoomOutCanvas();

            const linked = await this.linkTemplateToEmail(emailName, templateName);
            if (linked) {
              result.templatesLinked++;
              this.log.info(`  ✓ Linked template to "${emailName}"`);
            } else {
              this.log.warn(`  Could not link template to "${emailName}" — link manually.`);
              result.errors.push(`Template for "${emailName}" needs manual linking.`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(`  Error linking "${emailName}": ${msg}`);
            result.errors.push(`Template for "${emailName}" needs manual linking.`);
          }
        }

        this.log.info(`  Linked ${result.templatesLinked}/${Object.keys(options.templateMap).length} template(s)`);
      }

      const ss = await this.auth.takeScreenshot('browser-config-done');
      if (ss) result.screenshots.push(ss);

      result.success = true;

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Browser configuration failed: ${msg}`);
      this.log.error(`  Phase 2 failed: ${msg}`);
      const ss = await this.auth.takeScreenshot('browser-config-error');
      if (ss) result.screenshots.push(ss);
    } finally {
      result.duration = Date.now() - startTime;
      if (this.config.headless) {
        await this.auth.close();
      }
    }

    return result;
  }

  /**
   * Legacy method — calls configure() with just reentry.
   */
  async configureReentry(flowId: string, reentry: ReentryConfig): Promise<ConfigureResult> {
    return this.configure(flowId, { reentry });
  }

  // ---------------------------------------------------------------------------
  // Re-entry Configuration
  // ---------------------------------------------------------------------------

  private async setReentry(reentry: ReentryConfig): Promise<boolean> {
    if (!this.page) return false;

    this.log.info(`  Configuring re-entry: ${reentry.mode}${reentry.mode === 'time-based' ? ` (${reentry.value} ${reentry.unit})` : ''}`);

    // Find the re-entry section in the panel
    const reentryVisible = await this.page.locator(':text("Re-entry criteria")').first().isVisible().catch(() => false);
    if (!reentryVisible) {
      // Try scrolling down to find it
      const panelBody = this.page.locator(SELECTORS.configPanel.body);
      if (await panelBody.isVisible().catch(() => false)) {
        const box = await panelBody.boundingBox();
        if (box) {
          await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (let i = 0; i < 5; i++) {
            await this.page.mouse.wheel(0, 200);
            await sleep(300);
          }
          await sleep(500);
        }
      }
    }

    const foundReentry = await this.page.locator(':text("Re-entry criteria")').first().isVisible().catch(() => false);
    if (!foundReentry) {
      this.log.warn('  Re-entry criteria section not found in panel.');
      return false;
    }

    // Click the correct radio button based on mode
    // Klaviyo's exact labels:
    //   "No re-entry"
    //   "Allow re-entry"
    //   "Allow re-entry after a time period"
    let targetLabel: string;
    switch (reentry.mode) {
      case 'once':
        targetLabel = 'No re-entry';
        break;
      case 'multiple':
        targetLabel = 'Allow re-entry';
        break;
      case 'time-based':
        targetLabel = 'Allow re-entry after a time period';
        break;
      default:
        return false;
    }

    const clicked = await this.clickRadioByLabel(targetLabel);
    if (!clicked) {
      this.log.warn(`  Could not click re-entry option: "${targetLabel}"`);
      return false;
    }

    this.log.info(`  Selected: "${targetLabel}"`);

    // For time-based: fill in the value and unit BEFORE saving
    if (reentry.mode === 'time-based' && reentry.value && reentry.unit) {
      await sleep(2000); // Wait for time inputs to appear after radio click

      // Take a screenshot to see what inputs are available
      await this.auth.takeScreenshot('reentry-time-inputs');

      // Find the time value input — try multiple selector strategies
      // Klaviyo's input could be type="number", type="text", or a custom component
      let valueSet = false;

      const inputStrategies = [
        // Near "Time period" text
        'input:near(:text("Time period"), 150)',
        // Any input[type="number"] 
        'input[type="number"]',
        // Any input near re-entry section
        'input:near(:text("re-entry"), 300)',
        // Generic text input that might contain a number
        'input[inputmode="numeric"]',
        // Any visible input in the config panel (not search)
        `${SELECTORS.configPanel.body} input:not([placeholder*="Search"])`,
      ];

      for (const sel of inputStrategies) {
        try {
          const inputs = this.page.locator(sel);
          const count = await inputs.count().catch(() => 0);
          if (count > 0) {
            const valueInput = inputs.last();
            if (await valueInput.isVisible().catch(() => false)) {
              this.log.info(`  Found time input via: ${sel}`);
              await valueInput.click({ clickCount: 3 });
              await sleep(200);
              await this.page.keyboard.press('Control+a');
              await sleep(100);
              await this.page.keyboard.type(reentry.value.toString(), { delay: 50 });
              await sleep(300);
              this.log.info(`  Set time value: ${reentry.value}`);
              valueSet = true;
              break;
            }
          }
        } catch {
          // Some selectors might not be supported, continue
        }
      }

      if (!valueSet) {
        this.log.warn('  Could not find time value input.');
      }

      // Set the unit via the dropdown
      const unitCapitalized = reentry.unit.charAt(0).toUpperCase() + reentry.unit.slice(1);
      
      // Try <select> element first
      const selectEl = this.page.locator('select').last();
      if (await selectEl.isVisible().catch(() => false)) {
        await selectEl.selectOption({ label: unitCapitalized });
        this.log.info(`  Set time unit via select: ${unitCapitalized}`);
        await sleep(300);
      } else {
        // Try dropdown button
        const unitDropdown = this.page.locator(`button:has-text("Days"), button:has-text("Hours"), button:has-text("Weeks")`).last();
        if (await unitDropdown.isVisible().catch(() => false)) {
          await unitDropdown.click();
          await sleep(500);
          const unitOption = this.page.locator(`[role="option"]:has-text("${unitCapitalized}")`).first();
          if (await unitOption.isVisible().catch(() => false)) {
            await unitOption.click();
            await sleep(300);
            this.log.info(`  Set time unit via dropdown: ${unitCapitalized}`);
          }
        }
      }

      await this.auth.takeScreenshot('reentry-time-filled');
    }

    // NOW save after everything is filled
    await this.savePanel();
    return true;
  }

  /**
   * Click a radio button by its label text.
   */
  private async clickRadioByLabel(label: string): Promise<boolean> {
    if (!this.page) return false;

    // Strategy 1: label element with radio input
    const radioInput = this.page.locator(`label:has-text("${label}") input[type="radio"]`).first();
    if (await radioInput.isVisible().catch(() => false)) {
      await radioInput.click({ force: true });
      await sleep(500);
      return true;
    }

    // Strategy 2: label element itself
    const labelEl = this.page.locator(`label:has-text("${label}")`).first();
    if (await labelEl.isVisible().catch(() => false)) {
      await labelEl.click();
      await sleep(500);
      return true;
    }

    // Strategy 3: role="radio"
    const roleRadio = this.page.locator(`[role="radio"]:has-text("${label}")`).first();
    if (await roleRadio.isVisible().catch(() => false)) {
      await roleRadio.click();
      await sleep(500);
      return true;
    }

    // Strategy 4: text match
    const textEl = this.page.locator(`text="${label}"`).first();
    if (await textEl.isVisible().catch(() => false)) {
      await textEl.click();
      await sleep(500);
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Profile Filter Configuration
  // ---------------------------------------------------------------------------

  private async setProfileFilter(filter: TriggerFilter): Promise<boolean> {
    if (!this.page) return false;

    this.log.info('  Configuring profile filter via browser...');

    // The trigger panel shows "Profile filters" with an "Add" button.
    // We need to click "Add" to open the filter builder.
    const addBtn = this.page.locator('button:has-text("Add")').last();
    if (!await addBtn.isVisible().catch(() => false)) {
      // Try scrolling down to find it
      const panelBody = this.page.locator(SELECTORS.configPanel.body);
      if (await panelBody.isVisible().catch(() => false)) {
        const box = await panelBody.boundingBox();
        if (box) {
          await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (let i = 0; i < 5; i++) {
            await this.page.mouse.wheel(0, 200);
            await sleep(300);
          }
          await sleep(500);
        }
      }
    }

    // Look for "Add profile filter" or "Add" button near profile filters
    const addProfileBtn = this.page.locator('button:has-text("Add profile filter")').first();
    if (await addProfileBtn.isVisible().catch(() => false)) {
      await addProfileBtn.click();
      await sleep(2000);
      this.log.info('  Clicked "Add profile filter"');
    } else {
      // Try the "Add" button near "Profile filters" text
      const addNearProfile = this.page.locator('button:has-text("Add")').last();
      if (await addNearProfile.isVisible().catch(() => false)) {
        await addNearProfile.click();
        await sleep(2000);
        this.log.info('  Clicked "Add" button');
      } else {
        this.log.warn('  Could not find "Add profile filter" button.');
        return false;
      }
    }

    // Now we should be in the profile filter editor.
    // The filter builder in Klaviyo is complex. For the common case
    // (marketing consent), we look for the consent options.

    // Check what type of filter we're adding
    const condition = filter.condition_groups?.[0]?.conditions?.[0];
    if (!condition) return false;

    if (condition.type === 'profile-marketing-consent') {
      const consent = condition.consent as { channel: string } | undefined;
      const channel = consent?.channel || 'email';

      this.log.info(`  Setting profile filter: ${channel} marketing consent`);

      // In the filter builder, look for consent-related options
      // This varies by Klaviyo version — take a screenshot for debugging
      await this.auth.takeScreenshot('profile-filter-builder');
      this.log.info('  Screenshot taken: profile-filter-builder');
      this.log.warn('  Profile filter UI builder is complex — manual configuration recommended.');
      this.log.warn(`  Add condition: "Properties about someone" → "Consent" → "${channel}" → "can receive marketing"`);
      return false;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Template Linking — click email node, select template
  // ---------------------------------------------------------------------------

  /**
   * Link a pre-created template to a flow email by:
   * 1. Finding and clicking the email node on the canvas
   * 2. Clicking the content/design button
   * 3. Selecting "Saved templates" or "HTML" option
   * 4. Finding the template by name
   * 5. Selecting it
   */
  /**
   * Zoom out the canvas to see all flow nodes, including ones below the fold.
   */
  private async zoomOutCanvas(): Promise<void> {
    if (!this.page) return;

    // Method 1: Try the "fit to view" keyboard shortcut (Ctrl+Shift+1 in React Flow)
    // Method 2: Use Ctrl+- to zoom out multiple times
    // Method 3: Use the zoom controls on the canvas toolbar

    // Try zoom-out button on the toolbar
    const zoomOut = this.page.locator('[data-testid="canvas-toolbar-zoom-out"], button[aria-label*="zoom out" i], button[aria-label*="Zoom out" i]').first();
    if (await zoomOut.isVisible().catch(() => false)) {
      for (let i = 0; i < 5; i++) {
        await zoomOut.click();
        await sleep(200);
      }
      this.log.debug('  Zoomed out via toolbar');
      return;
    }

    // Fallback: keyboard zoom out (Ctrl+-)
    for (let i = 0; i < 5; i++) {
      await this.page.keyboard.press('Control+-');
      await sleep(200);
    }
    this.log.debug('  Zoomed out via keyboard');
  }

  private async linkTemplateToEmail(emailName: string, templateName: string): Promise<boolean> {
    if (!this.page) return false;

    this.log.info(`  Linking template to "${emailName}"...`);

    // Step 1: Find and click the email node on the canvas
    // Try multiple strategies — the canvas may show full or truncated names
    let found = false;

    // Strategy A: Exact match on node wrappers
    const selectors = [
      `[data-testid*="node-wrapper"]:has-text("${emailName}")`,
      `[data-testid*="flow-node"]:has-text("${emailName}")`,
      `text="${emailName}"`,
    ];

    for (const sel of selectors) {
      const node = this.page.locator(sel).first();
      if (await node.isVisible().catch(() => false)) {
        await node.click();
        found = true;
        break;
      }
    }

    // Strategy B: Partial match — the canvas might truncate long names
    if (!found) {
      // Try first 25 chars of the name
      const shortName = emailName.length > 25 ? emailName.substring(0, 25) : emailName;
      const partialNode = this.page.locator(`text=/${shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i`).first();
      if (await partialNode.isVisible().catch(() => false)) {
        await partialNode.click();
        found = true;
        this.log.debug(`  Found via partial match: "${shortName}..."`);
      }
    }

    // Strategy C: Scroll the canvas in multiple directions and retry
    if (!found) {
      this.log.debug(`  Node not visible, scrolling canvas...`);
      const canvas = this.page.locator('[data-testid="rf__wrapper"]');
      if (await canvas.isVisible().catch(() => false)) {
        const box = await canvas.boundingBox();
        if (box) {
          const centerX = box.x + box.width / 2;
          const centerY = box.y + box.height / 2;

          // Scroll down, right, and check each time
          const scrollDirections = [
            [0, 400], [0, 400], [0, 400],  // down
            [400, 0], [-400, 0],            // right, left
            [0, -800],                       // back up
          ];

          for (const [dx, dy] of scrollDirections) {
            await this.page.mouse.move(centerX, centerY);
            await this.page.mouse.wheel(dx, dy);
            await sleep(800);

            // Check for the node
            const retryNode = this.page.locator(`text="${emailName}"`).first();
            if (await retryNode.isVisible().catch(() => false)) {
              await retryNode.click();
              found = true;
              this.log.debug(`  Found after scrolling`);
              break;
            }

            // Partial match
            const shortName = emailName.length > 25 ? emailName.substring(0, 25) : emailName;
            const partialRetry = this.page.locator(`text=/${shortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i`).first();
            if (await partialRetry.isVisible().catch(() => false)) {
              await partialRetry.click();
              found = true;
              this.log.debug(`  Found partial match after scrolling`);
              break;
            }
          }
        }
      }
    }

    if (!found) {
      this.log.warn(`  Email node "${emailName}" not found on canvas`);
      await this.auth.takeScreenshot(`node-not-found-${emailName.replace(/\s+/g, '-').substring(0, 30)}`);
      return false;
    }

    await sleep(2000);

    // Step 2: Look for "Edit content", "Design email", "Edit email" button in the config panel
    const editButtons = [
      'button:has-text("Edit content")',
      'button:has-text("Design email")',
      'button:has-text("Edit email")',
      'button:has-text("Edit")',
      'a:has-text("Edit content")',
      'a:has-text("Design email")',
    ];

    let editClicked = false;
    for (const sel of editButtons) {
      const btn = this.page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        editClicked = true;
        this.log.info(`  Clicked "${await btn.textContent().catch(() => 'edit')}"`);
        break;
      }
    }

    if (!editClicked) {
      this.log.warn(`  No "Edit content" button found for "${emailName}"`);
      await this.auth.takeScreenshot(`template-link-no-edit-${emailName.replace(/\s+/g, '-')}`);
      await this.page.keyboard.press('Escape');
      await sleep(500);
      return false;
    }

    await sleep(3000);

    // Step 3: We should now be in the content type selector or email editor
    // Look for "Saved templates", "Template", "HTML", or similar options
    const templateOptions = [
      'button:has-text("Saved templates")',
      'button:has-text("Template")',
      ':text("Saved templates")',
      ':text("Use saved template")',
      'a:has-text("Saved templates")',
      'a:has-text("Template")',
    ];

    let templateTabClicked = false;
    for (const sel of templateOptions) {
      const opt = this.page.locator(sel).first();
      if (await opt.isVisible().catch(() => false)) {
        await opt.click();
        templateTabClicked = true;
        this.log.info(`  Selected template option`);
        break;
      }
    }

    if (!templateTabClicked) {
      // Maybe we're already in a template picker or HTML editor
      // Try looking for the template name directly
      this.log.info(`  No template tab found, looking for template name directly...`);
    }

    await sleep(2000);

    // Step 4: Find the template by name in the list
    // First try search if available
    const searchInput = this.page.locator('input[placeholder*="Search" i], input[placeholder*="search" i]').first();
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.click();
      await searchInput.fill(templateName);
      await sleep(2000);
      this.log.info(`  Searched for template: "${templateName}"`);
    }

    // Click the template by name
    const templateEl = this.page.locator(`text="${templateName}"`).first();
    if (await templateEl.isVisible().catch(() => false)) {
      await templateEl.click();
      await sleep(1000);
      this.log.info(`  Selected template: "${templateName}"`);

      // Look for a "Use template" or "Select" confirmation button
      const useButtons = [
        'button:has-text("Use template")',
        'button:has-text("Select")',
        'button:has-text("Use")',
        'button:has-text("Apply")',
        'button:has-text("Save")',
      ];

      for (const sel of useButtons) {
        const btn = this.page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await sleep(2000);
          this.log.info(`  Confirmed template selection`);
          break;
        }
      }

      // Take screenshot for verification
      await this.auth.takeScreenshot(`template-linked-${emailName.replace(/\s+/g, '-')}`);

      // Go back to the flow editor
      const backButtons = [
        'a:has-text("Exit")',
        'a:has-text("Back")',
        'button:has-text("Back to flow")',
        'a:has-text("Back to flow")',
      ];
      for (const sel of backButtons) {
        const btn = this.page.locator(sel).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await sleep(3000);
          break;
        }
      }

      // If still not on flow page, navigate back
      if (!this.page.url().includes('/flow/')) {
        const flowUrl = this.page.url().match(/flow\/([^/]+)/)?.[0];
        if (flowUrl) {
          await this.page.goto(`https://www.klaviyo.com/${flowUrl}/edit`, { waitUntil: 'domcontentloaded' });
          await sleep(3000);
        }
      }

      return true;
    }

    this.log.warn(`  Template "${templateName}" not found in the list`);
    await this.auth.takeScreenshot(`template-link-not-found-${emailName.replace(/\s+/g, '-')}`);

    // Close/go back
    await this.page.keyboard.press('Escape');
    await sleep(1000);

    return false;
  }

  // ---------------------------------------------------------------------------
  // Shared Helpers
  // ---------------------------------------------------------------------------

  /**
   * Save the current panel (click Save, handle confirmation).
   */
  private async savePanel(): Promise<void> {
    if (!this.page) return;
    await sleep(500);

    const saveBtn = this.page.locator('button:has-text("Save")').last();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await sleep(2000);
      this.log.info('  Saved settings.');

      // Handle confirmation dialog
      const confirmBtn = this.page.locator('button:has-text("Confirm"), button:has-text("Confirm and save")').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        await sleep(2000);
        this.log.info('  Confirmed settings.');
      }
    }
  }

  async close(): Promise<void> {
    await this.auth.close();
  }
}
