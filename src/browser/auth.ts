// =============================================================================
// Klaviyo Flow Builder — Browser Authentication
// =============================================================================
// Handles login to Klaviyo via Playwright.
//
// STRATEGY for reCAPTCHA:
//   Klaviyo's login page has a reCAPTCHA. Automated browsers can't solve it.
//   Solution: "Login once, reuse forever."
//     1. First run: visible browser, pre-fill creds, user solves CAPTCHA manually
//     2. Save authenticated session cookies to disk
//     3. Subsequent runs: load cookies, skip login, run headless
//   This is the standard production pattern for CAPTCHA-protected automation.
// =============================================================================

import { Page, Browser, BrowserContext, chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig } from '../types';
import { URLS } from './selectors';
import { getLogger } from '../utils/logger';

const SESSION_FILE = '.klaviyo-session.json';

export class KlaviyoAuth {
  private log = getLogger();
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private config: AppConfig) {}

  /**
   * Launch browser, log in, and return the authenticated page.
   *
   * Auth flow:
   *   1. Check for saved session → if valid, use it (headless OK)
   *   2. If no session → open visible browser, pre-fill creds, wait for user
   *      to solve CAPTCHA, then save session for future headless runs
   */
  async authenticate(): Promise<Page> {
    const sessionPath = path.resolve(SESSION_FILE);

    // ------------------------------------------------------------------
    // Try to restore a saved session first
    // ------------------------------------------------------------------
    if (fs.existsSync(sessionPath)) {
      this.log.info('Found saved session. Attempting to restore...');

      this.browser = await chromium.launch({
        headless: this.config.headless,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
      });

      try {
        const storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        this.context = await this.browser.newContext({
          storageState,
          viewport: { width: 1920, height: 1080 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        this.page = await this.context.newPage();
        this.page.setDefaultTimeout(this.config.pageTimeout);

        // Test if session is still valid
        const isValid = await this.checkSessionValid();
        if (isValid) {
          this.log.info('Saved session is valid. Skipping login.');
          return this.page;
        }

        this.log.warn('Saved session expired. Deleting old session and starting fresh login...');
        await this.page.close();
        await this.context.close();
        await this.browser.close();

        // Delete the expired session file so we don't try it again
        try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }
      } catch (error) {
        this.log.warn(`Failed to restore session: ${error}`);
        await this.browser?.close();

        // Delete the corrupt session file
        try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }
      }
    }

    // ------------------------------------------------------------------
    // Fresh login: visible browser, user solves CAPTCHA
    // ------------------------------------------------------------------

    // On production (no display), skip login — can't solve CAPTCHA on a server
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Re-entry config skipped (server environment). Set it manually: Open flow → Click Trigger → Re-entry criteria → Save.');
    }

    this.log.info('Opening visible browser for login (reCAPTCHA requires manual solve)...');
    this.log.info('>>> Please solve the CAPTCHA in the browser window, then login will complete automatically. <<<');

    this.browser = await chromium.launch({
      headless: false,  // MUST be visible for CAPTCHA
      slowMo: 100,      // Slight slowdown so user can see what's happening
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--start-maximized',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(60000); // Longer timeout for manual CAPTCHA

    // Navigate to login (longer timeout for slow connections)
    await this.page.goto(URLS.login, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Pre-fill credentials using real Klaviyo data-testid selectors
    this.log.info('Pre-filling login credentials...');

    const emailInput = this.page.locator('[data-testid="email"]');
    await emailInput.waitFor({ state: 'visible' });
    await emailInput.fill(this.config.email);

    const passwordInput = this.page.locator('[data-testid="password-PasswordInput"]');
    await passwordInput.waitFor({ state: 'visible' });
    await passwordInput.fill(this.config.password);

    this.log.info('Credentials pre-filled. Waiting for you to solve the CAPTCHA and click "Log in"...');
    this.log.info('(The browser will detect when login succeeds and continue automatically.)');

    // Wait for the user to solve CAPTCHA and login to succeed
    // We detect success by waiting for the URL to change away from /login
    try {
      await this.page.waitForURL((url) => {
        const path = url.pathname;
        return !path.includes('/login') && !path.includes('/signin');
      }, { timeout: 300000 }); // 5 minutes for user to solve CAPTCHA
    } catch {
      this.log.error('Login timed out. Please try again and solve the CAPTCHA faster.');
      await this.takeScreenshot('login-timeout');
      throw new Error('Login timed out waiting for CAPTCHA.');
    }

    await this.page.waitForLoadState('domcontentloaded');
    await new Promise(r => setTimeout(r, 8000)); // Wait for SPA auth tokens to finalize
    this.log.info(`Login successful! Redirected to: ${this.page.url()}`);

    // Navigate to a real Klaviyo page to ensure all cookies are set
    try {
      await this.page.goto(URLS.flows, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 3000));
      this.log.info(`Post-login navigation settled at: ${this.page.url()}`);
    } catch {
      this.log.warn('Post-login navigation to flows page failed, saving session anyway.');
    }

    // Save session for future headless runs
    await this.saveSession(sessionPath);
    this.log.info('Session saved. Future runs will skip login and CAPTCHA.');

    // Take a confirmation screenshot
    await this.takeScreenshot('login-success');

    return this.page;
  }

  /**
   * Check if the current session is still valid by navigating to flows page.
   * Waits for the page to settle and checks for delayed redirects to login.
   */
  private async checkSessionValid(): Promise<boolean> {
    if (!this.page) return false;

    try {
      await this.page.goto(URLS.flows, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Wait for any client-side redirects to settle
      await new Promise(r => setTimeout(r, 4000));

      // Check URL after settling
      let url = this.page.url();
      this.log.debug(`Session check — URL after load: ${url}`);

      if (url.includes('login') || url.includes('signin')) {
        this.log.debug('Session expired (redirected to login after load).');
        return false;
      }

      // Double-check: wait a bit more and verify we're still not on login
      await new Promise(r => setTimeout(r, 2000));
      url = this.page.url();
      if (url.includes('login') || url.includes('signin')) {
        this.log.debug('Session expired (late redirect to login).');
        return false;
      }

      // If we landed on any Klaviyo page that isn't login, the session is valid.
      // This includes /flows, /onboarding, /dashboard, /settings, etc.
      if (url.includes('klaviyo.com') && !url.includes('login') && !url.includes('signin')) {
        this.log.debug(`Session valid. Current URL: ${url}`);
        return true;
      }

      // Fallback: look for any logged-in UI element
      const loggedIn = await this.page.locator('nav, [data-testid*="header"], [data-testid*="nav"], button:has-text("Create"), .kl-header, #app').first()
        .isVisible().catch(() => false);

      if (!loggedIn) {
        this.log.debug('Session expired (no logged-in UI elements found).');
        return false;
      }

      this.log.debug(`Session valid (UI check). Current URL: ${url}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save session cookies for future headless runs.
   */
  private async saveSession(sessionPath: string): Promise<void> {
    if (!this.context) return;

    try {
      const storageState = await this.context.storageState();
      fs.writeFileSync(sessionPath, JSON.stringify(storageState, null, 2));
      this.log.info(`Session saved to: ${sessionPath}`);
    } catch (error) {
      this.log.warn(`Failed to save session: ${error}`);
    }
  }

  /**
   * Take a screenshot for debugging.
   */
  async takeScreenshot(name: string): Promise<string | null> {
    if (!this.page) return null;

    try {
      const dir = this.config.screenshotDir;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const filepath = path.join(dir, `${name}-${Date.now()}.png`);
      await this.page.screenshot({ path: filepath, fullPage: true });
      this.log.debug(`Screenshot saved: ${filepath}`);
      return filepath;
    } catch (error) {
      this.log.warn(`Failed to take screenshot: ${error}`);
      return null;
    }
  }

  /**
   * Get the current authenticated page.
   */
  getPage(): Page | null {
    return this.page;
  }

  /**
   * Clean up browser resources.
   */
  async close(): Promise<void> {
    if (this.page) await this.page.close().catch(() => {});
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.log.debug('Browser closed.');
  }
}
