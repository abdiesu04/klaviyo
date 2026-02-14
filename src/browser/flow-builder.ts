// =============================================================================
// Klaviyo Flow Builder — Browser Automation (CALIBRATED)
// =============================================================================
// Uses Playwright to build flows in Klaviyo's UI.
// All selectors calibrated against real Klaviyo DOM as of 2026-02-10.
//
// UI Flow:
//   1. Login (saved session or manual CAPTCHA)
//   2. /flows → Click "Create flow"
//   3. Click "Build your own"
//   4. Enter name, click "Create flow" in dialog
//   5. On canvas: click trigger node → select trigger from config panel
//   6. Click "+" to add actions → select type → configure
// =============================================================================

import { Page } from 'playwright';
import {
  FlowDefinition,
  FlowAction,
  TimeDelayAction,
  SendEmailAction,
  SendSmsAction,
  ConditionalSplitAction,
  ABSplitAction,
  AppConfig,
  BuildResult,
} from '../types';
import { KlaviyoAuth } from './auth';
import { SELECTORS, URLS, TRIGGER_LABELS } from './selectors';
import { getLogger } from '../utils/logger';
import { sleep } from '../utils/retry';

export class BrowserFlowBuilder {
  private log = getLogger();
  private auth: KlaviyoAuth;
  private page: Page | null = null;

  constructor(private config: AppConfig) {
    this.auth = new KlaviyoAuth(config);
  }

  /**
   * Build a flow via browser automation. Full lifecycle.
   */
  async buildFlow(definition: FlowDefinition): Promise<BuildResult> {
    const startTime = Date.now();
    const result: BuildResult = {
      success: false,
      mode: 'browser',
      flowName: definition.name,
      actionsCreated: 0,
      errors: [],
      warnings: [],
      screenshots: [],
      duration: 0,
    };

    try {
      // Step 1: Authenticate
      this.log.info(`Building flow: "${definition.name}" via Browser Automation`);
      this.page = await this.auth.authenticate();

      // Step 2: Navigate to flows and create new flow
      await this.navigateAndCreateFlow(definition.name);

      // Step 3: Set the trigger
      await this.selectTrigger(definition);

      // Step 4: Build actions in sequence
      const actions = this.getActionSequence(definition);
      for (const action of actions) {
        try {
          await this.addAction(action);
          result.actionsCreated++;
          this.log.info(`  Added: ${action.type} — "${(action as SendEmailAction).name || action.id}"`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.warnings.push(`Action ${action.id} (${action.type}): ${msg}`);
          this.log.warn(`  Failed: ${action.type} — ${msg}`);
          const ss = await this.auth.takeScreenshot(`fail-${action.id}`);
          if (ss) result.screenshots!.push(ss);
        }
      }

      // Step 5: Final screenshot
      const finalSS = await this.auth.takeScreenshot('flow-complete');
      if (finalSS) result.screenshots!.push(finalSS);

      // Extract flow ID from URL
      if (this.page) {
        const url = this.page.url();
        const match = url.match(/\/flow\/([^/]+)/);
        if (match) {
          result.flowId = match[1];
          result.flowUrl = url;
        }
      }

      result.success = result.actionsCreated > 0;
      this.log.info(`Build complete: ${result.actionsCreated}/${actions.length} actions.`);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Browser automation failed: ${msg}`);
      this.log.error(`Build failed: ${msg}`);
      const ss = await this.auth.takeScreenshot('build-error');
      if (ss) result.screenshots!.push(ss);
    } finally {
      result.duration = Date.now() - startTime;
      // Don't close browser if non-headless (for debugging)
      if (this.config.headless) {
        await this.auth.close();
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Navigate & Create
  // ---------------------------------------------------------------------------

  private async navigateAndCreateFlow(flowName: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    // Go to flows page (use domcontentloaded — networkidle is too strict for Klaviyo's analytics)
    this.log.info('Navigating to Flows page...');
    if (!this.page.url().includes('/flows')) {
      await this.page.goto(URLS.flows, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await this.page.waitForLoadState('domcontentloaded');
    await sleep(3000);

    // Click "Create flow"
    this.log.info('Creating new flow...');
    await this.page.locator(SELECTORS.nav.createFlowButton).first().click();
    await sleep(2000);

    // Click "Build your own"
    await this.page.locator(SELECTORS.flowCreation.buildYourOwnButton).click();
    await sleep(2000);

    // Enter flow name — use keyboard.type to trigger React state updates
    this.log.info(`Setting flow name: "${flowName}"`);
    let nameInput = this.page.locator(SELECTORS.flowCreation.nameInput).first();
    if (!await nameInput.isVisible().catch(() => false)) {
      nameInput = this.page.locator(SELECTORS.flowCreation.nameInputFallback).first();
    }
    await nameInput.click();
    await nameInput.fill('');
    await this.page.keyboard.type(flowName, { delay: 30 });
    await sleep(500);

    // Click "Create flow" in dialog
    const submitBtn = this.page.locator(SELECTORS.flowCreation.createFlowSubmit).last();
    await submitBtn.click();

    // Wait for the canvas to fully load (React Flow needs time to render)
    this.log.info('Waiting for flow builder canvas to load...');
    await this.page.waitForURL('**/flow/**/edit', { timeout: 20000 }).catch(() => {});
    await sleep(3000);

    // Wait for the React Flow wrapper — if it doesn't appear, reload the page
    let canvasLoaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const rfWrapper = this.page.locator('[data-testid="rf__wrapper"]');
      try {
        await rfWrapper.waitFor({ state: 'visible', timeout: 10000 });
        canvasLoaded = true;
        break;
      } catch {
        this.log.warn(`Canvas not loaded (attempt ${attempt}/3). Reloading page...`);
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await sleep(5000);
      }
    }

    if (!canvasLoaded) {
      this.log.warn('Canvas did not load after 3 attempts. Continuing anyway...');
    }
    await sleep(2000);

    this.log.info(`Flow created. URL: ${this.page.url()}`);
  }

  // ---------------------------------------------------------------------------
  // Step 3: Select Trigger
  // ---------------------------------------------------------------------------

  private async selectTrigger(definition: FlowDefinition): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    const trigger = definition.trigger;
    this.log.info(`Setting trigger: ${trigger.type}...`);

    // Click the trigger node on the canvas (wait longer — canvas is a heavy React app)
    const triggerNode = this.page.locator(SELECTORS.canvas.triggerNode).first();
    await triggerNode.waitFor({ state: 'visible', timeout: 20000 });
    await triggerNode.click();
    await sleep(2000);

    // The config panel opens on the right with trigger options
    // Find the right trigger label for the config panel
    let triggerLabel: string;
    let listName: string | null = null;
    switch (trigger.type) {
      case 'metric': {
        triggerLabel = TRIGGER_LABELS[trigger.metric_name] || trigger.metric_name;
        break;
      }
      case 'list':
        triggerLabel = 'Added to list';
        listName = trigger.list_name;
        break;
      case 'date-property':
        triggerLabel = 'Date property';
        break;
      default:
        triggerLabel = 'Added to list';
    }

    this.log.info(`  Selecting trigger: "${triggerLabel}"`);

    // Wait for the config panel to show trigger options
    await this.page.locator(SELECTORS.configPanel.content).waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    // Try to find the trigger in the recommended tab first (the trigger cards)
    // Trigger cards contain the title text — click the card
    const configPanel = this.page.locator(SELECTORS.configPanel.content);
    const triggerCard = configPanel.locator(`text="${triggerLabel}"`).first();

    if (await triggerCard.isVisible().catch(() => false)) {
      await triggerCard.click();
      await sleep(3000);
      this.log.info('  Trigger selected from recommended tab.');
    } else {
      // Try clicking the card that contains the text (click the parent card element)
      const triggerTextEl = this.page.locator(`text=${triggerLabel}`).first();
      if (await triggerTextEl.isVisible().catch(() => false)) {
        await triggerTextEl.click();
        await sleep(3000);
        this.log.info('  Trigger selected.');
      } else {
        // Try "Your metrics" tab for custom metrics
        this.log.info('  Trigger not in recommended. Trying "Your metrics" tab...');
        const metricsTab = this.page.locator(SELECTORS.triggers.yourMetricsTab).first();
        if (await metricsTab.isVisible().catch(() => false)) {
          await metricsTab.click();
          await sleep(1000);

          const metricOption = this.page.locator(`text=${triggerLabel}`).first();
          if (await metricOption.isVisible().catch(() => false)) {
            await metricOption.click();
            await sleep(3000);
            this.log.info('  Trigger selected from "Your metrics" tab.');
          } else {
            this.log.warn(`  Could not find trigger "${triggerLabel}".`);
          }
        }
      }
    }

    // For list triggers: need to select the specific list after clicking "Added to list"
    if (listName) {
      await sleep(1000);
      this.log.info(`  Selecting list: "${listName}"`);
      const listOption = this.page.locator(`text=${listName}`).first();
      if (await listOption.isVisible().catch(() => false)) {
        await listOption.click();
        await sleep(2000);
        this.log.info(`  List "${listName}" selected.`);
      } else {
        this.log.warn(`  List "${listName}" not found. The trigger may need manual configuration.`);
      }
    }

    // IMPORTANT: Click "Save" to confirm the trigger configuration
    this.log.info('  Saving trigger configuration...');
    const saveBtn = this.page.locator('button:has-text("Save")').last();
    await saveBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await sleep(2000);

      // Handle the "Confirm your trigger selection" confirmation dialog
      const confirmBtn = this.page.locator('button:has-text("Confirm and save")').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        this.log.info('  Confirming trigger selection...');
        await confirmBtn.click();
        await sleep(4000); // Wait for canvas to fully update
        this.log.info('  Trigger confirmed and saved.');
      } else {
        this.log.info('  Trigger saved (no confirmation needed).');
        await sleep(2000);
      }
    }

    await this.auth.takeScreenshot('trigger-saved');
  }

  // ---------------------------------------------------------------------------
  // Step 4: Add Actions
  // ---------------------------------------------------------------------------

  private async addAction(action: FlowAction): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    // Klaviyo uses DRAG-AND-DROP from the left sidebar to the canvas.
    // Sidebar labels (from real Klaviyo UI):
    //   Actions: Email, Text message, WhatsApp, Profile property update, List update, Webhook, Internal alert
    //   Timing: Time delay
    //   Logic: Conditional split
    let sidebarLabel: string;
    switch (action.type) {
      case 'time-delay': sidebarLabel = 'Time delay'; break;
      case 'send-email': sidebarLabel = 'Email'; break;
      case 'send-sms': sidebarLabel = 'Text message'; break;
      case 'conditional-split': sidebarLabel = 'Conditional split'; break;
      default: sidebarLabel = 'Email'; break;
    }

    // Step 1: Zoom out canvas to ensure all nodes + "End" are visible
    // React Flow has its own viewport — browser scroll doesn't help
    await this.zoomOutCanvas();

    // Step 2: Drag the action from sidebar to canvas
    await this.dragActionToCanvas(sidebarLabel);
    await sleep(2000);

    // Step 3: Configure the action in the config panel (if needed)
    if (action.type === 'time-delay') {
      await this.configureTimeDelay(action as TimeDelayAction);
    }

    // Step 4: Dismiss the config panel by clicking on empty canvas area
    // This is critical — the config panel must be closed before the next drag
    await this.dismissConfigPanel();
    await sleep(1000);
  }

  /**
   * Zoom out the React Flow canvas so all nodes (including "End") are visible.
   * This is critical before each drag — React Flow has its own viewport
   * that doesn't respond to browser scrollIntoView.
   */
  private async zoomOutCanvas(): Promise<void> {
    if (!this.page) return;

    // Use mouse wheel on the canvas to zoom out.
    // This always works — can't be disabled like the zoom-out button.
    const canvas = this.page.locator('[data-testid="rf__wrapper"]').first();
    if (await canvas.isVisible().catch(() => false)) {
      const box = await canvas.boundingBox();
      if (box) {
        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        // Ctrl + scroll = zoom in React Flow
        await this.page.keyboard.down('Control');
        for (let i = 0; i < 3; i++) {
          await this.page.mouse.wheel(0, 100);
          await sleep(100);
        }
        await this.page.keyboard.up('Control');
        await sleep(500);
      }
    }
  }

  /**
   * Configure a time delay action in the config panel.
   * After dragging, the config panel opens with delay settings.
   */
  private async configureTimeDelay(action: TimeDelayAction): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    this.log.debug(`  Configuring time delay: ${action.delay_value} ${action.delay_unit}`);

    // Look for the delay value input in the config panel
    const valueInput = this.page.locator('input[type="number"]').first();
    if (await valueInput.isVisible().catch(() => false)) {
      await valueInput.click({ clickCount: 3 }); // Select all
      await this.page.keyboard.type(action.delay_value.toString());
      await sleep(500);
    }

    // Try to set the unit (days, hours, etc.)
    // Look for a dropdown/select with the unit options
    const unitDropdown = this.page.locator('button:has-text("hours"), button:has-text("days"), button:has-text("minutes"), select').first();
    if (await unitDropdown.isVisible().catch(() => false)) {
      await unitDropdown.click();
      await sleep(500);
      const unitOption = this.page.locator(`[role="option"]:has-text("${action.delay_unit}"), option:has-text("${action.delay_unit}")`).first();
      if (await unitOption.isVisible().catch(() => false)) {
        await unitOption.click();
        await sleep(500);
      }
    }

    // Click Save/Done if available
    const saveBtn = this.page.locator('button:has-text("Save"), button:has-text("Done")').first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await sleep(1000);
    }
  }

  /**
   * Dismiss the config panel by clicking on empty canvas space.
   * Critical between action additions — the panel must be closed
   * before the next drag-and-drop works.
   */
  private async dismissConfigPanel(): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    // Try pressing Escape first
    await this.page.keyboard.press('Escape');
    await sleep(500);

    // Click on empty canvas area (top-left of the canvas, away from nodes)
    const canvas = this.page.locator('[data-testid="rf__wrapper"]').first();
    if (await canvas.isVisible().catch(() => false)) {
      const box = await canvas.boundingBox();
      if (box) {
        // Click top-left corner of canvas (likely empty space)
        await this.page.mouse.click(box.x + 50, box.y + 50);
        await sleep(500);
      }
    }
  }

  /**
   * Drag an action from the left sidebar onto the canvas.
   * The drop target is the edge between the last node and "End".
   *
   * KEY CHALLENGE: As nodes are added, "End" moves down and can go off-screen.
   * Solution: Scroll "End" into view before each drag, then recalculate coordinates.
   */
  private async dragActionToCanvas(sidebarLabel: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    this.log.debug(`  Dragging "${sidebarLabel}" from sidebar to canvas...`);

    // Find the action in the left sidebar
    const sidebarItem = this.page.locator(`text="${sidebarLabel}"`).first();
    if (!await sidebarItem.isVisible().catch(() => false)) {
      this.log.warn(`  Sidebar item "${sidebarLabel}" not found.`);
      return;
    }

    // Find the "End" node — it should be visible after zoomOutCanvas()
    const endNode = this.page.locator(':text("End")').last();
    await sleep(500);

    if (!await endNode.isVisible().catch(() => false)) {
      this.log.warn('  "End" node not visible. Trying to fit view...');
      await this.zoomOutCanvas();
      await sleep(500);
      if (!await endNode.isVisible().catch(() => false)) {
        this.log.warn('  "End" still not visible. Drag may fail.');
      }
    }

    // Get fresh bounding boxes AFTER scroll
    const sourceBox = await sidebarItem.boundingBox();
    const targetBox = await endNode.boundingBox();

    if (!sourceBox || !targetBox) {
      this.log.warn('  Could not get bounding boxes for drag-and-drop.');
      return;
    }

    // Source: center of the sidebar item
    const sourceX = sourceBox.x + sourceBox.width / 2;
    const sourceY = sourceBox.y + sourceBox.height / 2;
    // Target: just ABOVE the "End" node
    const targetX = targetBox.x + targetBox.width / 2;
    const targetY = targetBox.y - 30;

    // Perform drag-and-drop with gradual mouse movement
    await this.page.mouse.move(sourceX, sourceY);
    await sleep(300);
    await this.page.mouse.down();
    await sleep(300);

    // Move in steps (React DnD / react-beautiful-dnd needs intermediate moves)
    const steps = 15;
    for (let i = 1; i <= steps; i++) {
      const x = sourceX + (targetX - sourceX) * (i / steps);
      const y = sourceY + (targetY - sourceY) * (i / steps);
      await this.page.mouse.move(x, y);
      await sleep(40);
    }

    await sleep(300);
    await this.page.mouse.up();
    await sleep(2000);

    this.log.debug(`  Dragged "${sidebarLabel}" to canvas.`);
  }

  // Legacy method — kept for potential future use
  private async _clickAddButton(): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    // Strategy: The "+" add-action button appears on the edge/line between nodes
    // in Klaviyo's React Flow canvas. It may only appear on hover.
    // Note: The zoom controls (+/-/100%) in bottom-right are NOT the add button.

    // First try: look for explicit add-action data-testid selectors
    const explicitSelectors = [
      '[data-testid*="add-action"]',
      '[data-testid*="add-step"]',
      '[data-testid*="insert-node"]',
      '[data-testid*="insert-action"]',
      'button[aria-label*="Add action" i]',
      'button[aria-label*="Add step" i]',
    ];

    for (const sel of explicitSelectors) {
      const btn = this.page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        this.log.debug(`  Found add button: ${sel}`);
        await btn.click();
        await sleep(1500);
        return;
      }
    }

    // Second try: hover over the edge line between nodes to reveal the "+" button
    this.log.debug('  Trying hover-to-reveal on canvas edge...');
    const triggerNode = this.page.locator(SELECTORS.canvas.triggerNode).first();
    const endNode = this.page.locator(':text("End")').first();

    if (await triggerNode.isVisible().catch(() => false) && await endNode.isVisible().catch(() => false)) {
      const triggerBox = await triggerNode.boundingBox();
      const endBox = await endNode.boundingBox();

      if (triggerBox && endBox) {
        // Calculate midpoint between trigger bottom and End top
        const midX = triggerBox.x + triggerBox.width / 2;
        const midY = triggerBox.y + triggerBox.height + (endBox.y - triggerBox.y - triggerBox.height) / 2;

        // Hover to reveal the "+" button
        await this.page.mouse.move(midX, midY);
        await sleep(1000);

        // Take screenshot to see what appeared
        await this.auth.takeScreenshot('hover-add-button');

        // Try clicking what appeared at that position
        await this.page.mouse.click(midX, midY);
        await sleep(1500);

        // Check if an action picker appeared
        const actionPicker = this.page.locator(SELECTORS.configPanel.content).first();
        if (await actionPicker.isVisible().catch(() => false)) {
          this.log.debug('  Action picker opened via edge hover-click.');
          return;
        }

        // Try looking for a button that appeared after hover
        for (const sel of explicitSelectors) {
          const btn = this.page.locator(sel).first();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click();
            await sleep(1500);
            return;
          }
        }
      }
    }

    this.log.warn('  Could not find add action button. Canvas may need manual interaction.');
  }

  private async addTimeDelay(action: TimeDelayAction): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    // Click "Time delay" in the action picker
    const delayOption = this.page.locator(SELECTORS.actionPicker.timeDelayAction).first();
    await delayOption.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await delayOption.click();
    await sleep(1500);

    // Configure delay value in the config panel
    const valueInput = this.page.locator(SELECTORS.timeDelay.valueInput).first();
    if (await valueInput.isVisible().catch(() => false)) {
      await valueInput.fill(action.delay_value.toString());
    }

    // Select delay unit
    const unitLabel = action.delay_unit.charAt(0).toUpperCase() + action.delay_unit.slice(1);
    const unitBtn = this.page.locator(SELECTORS.timeDelay.unitSelect).first();
    if (await unitBtn.isVisible().catch(() => false)) {
      await unitBtn.click();
      await sleep(500);
      const unitOption = this.page.locator(SELECTORS.timeDelay.unitOption(unitLabel)).first();
      if (await unitOption.isVisible().catch(() => false)) {
        await unitOption.click();
      }
    }

    // Click Done
    await this.clickDone();
    this.log.debug(`  Time delay: ${action.delay_value} ${action.delay_unit}`);
  }

  private async addEmail(action: SendEmailAction): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    // Click "Email" in action picker
    const emailOption = this.page.locator(SELECTORS.actionPicker.emailAction).first();
    await emailOption.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await emailOption.click();
    await sleep(1500);

    // Email name (if input is visible in config panel)
    const nameInput = this.page.locator(SELECTORS.email.nameInput).first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill(action.name);
    }

    await this.clickDone();
    this.log.debug(`  Email: ${action.name}`);
  }

  private async addSms(action: SendSmsAction): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    const smsOption = this.page.locator(SELECTORS.actionPicker.smsAction).first();
    await smsOption.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await smsOption.click();
    await sleep(1500);

    await this.clickDone();
    this.log.debug(`  SMS: ${action.name}`);
  }

  private async addConditionalSplit(action: ConditionalSplitAction): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    const splitOption = this.page.locator(SELECTORS.actionPicker.conditionalSplitAction).first();
    await splitOption.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await splitOption.click();
    await sleep(1500);

    // The conditional split config will appear in the config panel
    // For skeleton builds, we just add the split — condition is configured in Klaviyo UI
    this.log.info(`  Conditional split added: "${action.condition_label}" (configure condition in Klaviyo UI)`);

    await this.clickDone();
  }

  private async addABSplit(action: ABSplitAction): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    this.log.info('  A/B test setup (bonus feature)...');

    // Look for A/B test option in the action picker
    const abOption = this.page.locator(
      SELECTORS.actionPicker.action('A/B test'),
    ).first();

    if (await abOption.isVisible().catch(() => false)) {
      await abOption.click();
      await sleep(1500);
      await this.clickDone();
      this.log.info('  A/B test added.');
    } else {
      this.log.warn('  A/B test action not found in picker. May need manual setup in Klaviyo UI.');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async clickDone(): Promise<void> {
    if (!this.page) return;
    await sleep(500);

    const doneBtn = this.page.locator(SELECTORS.general.doneButton).first();
    if (await doneBtn.isVisible().catch(() => false)) {
      await doneBtn.click();
      await sleep(1000);
      return;
    }

    const saveBtn = this.page.locator(SELECTORS.general.saveButton).first();
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await sleep(1000);
    }
  }

  /**
   * Get actions in build order by following the linked list structure.
   */
  private getActionSequence(definition: FlowDefinition): FlowAction[] {
    const actionMap = new Map<string, FlowAction>();
    definition.actions.forEach((a) => actionMap.set(a.id, a));

    const ordered: FlowAction[] = [];
    const visited = new Set<string>();

    const traverse = (id: string | undefined | null) => {
      if (!id || visited.has(id)) return;
      visited.add(id);
      const action = actionMap.get(id);
      if (!action) return;
      ordered.push(action);

      switch (action.type) {
        case 'time-delay':
        case 'send-email':
        case 'send-sms':
          traverse((action as TimeDelayAction | SendEmailAction | SendSmsAction).next);
          break;
        case 'conditional-split': {
          const cs = action as ConditionalSplitAction;
          traverse(cs.next_if_true);
          traverse(cs.next_if_false);
          break;
        }
        case 'ab-split': {
          const ab = action as ABSplitAction;
          traverse(ab.next_variant_a);
          traverse(ab.next_variant_b);
          break;
        }
      }
    };

    traverse(definition.entry_action_id);

    // Add any unvisited actions
    definition.actions.forEach((a) => {
      if (!visited.has(a.id)) ordered.push(a);
    });

    return ordered;
  }
}
