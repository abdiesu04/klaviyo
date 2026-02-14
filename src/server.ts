// =============================================================================
// Klaviyo Flow Builder — Web Server
// =============================================================================
// Express server with frontend UI and API endpoints for flow builds.
// Supports real-time log streaming via Server-Sent Events.
// =============================================================================

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, validateConfig } from './config';
import { FlowDefinition, BuildMode, BuildResult, FlowSettings, ReentryConfig, SendEmailAction, SendSmsAction } from './types';
import { APIFlowCreator } from './api/flow-creator';
import { KlaviyoAPIClient } from './api/client';
import { BrowserFlowBuilder } from './browser/flow-builder';
import { BrowserFlowConfigurator } from './browser/flow-configurator';
import { validateFlowDefinition } from './utils/validator';
import { createLogger, getLogger } from './utils/logger';
import { buildEmailHtml } from './utils/email-builder';
const Transport = require('winston-transport');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Multer config: store uploads in a temp folder, accept images only
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — Klaviyo's max
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and GIF images are allowed.'));
    }
  },
});

app.use(cors());
app.use(express.json());
// Serve static files (works from both src/ and dist/)
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// ---------------------------------------------------------------------------
// API Key Resolution — from request header or env fallback
// ---------------------------------------------------------------------------

/**
 * Get the Klaviyo API key from the request header (user-provided) or env fallback.
 * Header: x-klaviyo-api-key
 */
function getApiKey(req: express.Request): string {
  return (req.headers['x-klaviyo-api-key'] as string) || process.env.KLAVIYO_API_KEY || '';
}

// Store active SSE connections for log streaming
const sseClients: Map<string, express.Response> = new Map();

// Custom winston transport that sends logs to SSE clients
class SSETransport extends Transport {
  private buildId: string;

  constructor(buildId: string) {
    super({});
    this.buildId = buildId;
  }

  log(info: { level: string; message: string; timestamp?: string }, callback: () => void) {
    const client = sseClients.get(this.buildId);
    if (client && !client.writableEnded) {
      client.write(`data: ${JSON.stringify({
        type: 'log',
        level: info.level,
        message: info.message,
        timestamp: info.timestamp || new Date().toISOString(),
      })}\n\n`);
    }
    callback();
  }
}

// ---------------------------------------------------------------------------
// Connect — validate a user's API key
// ---------------------------------------------------------------------------

/**
 * Test a Klaviyo API key. Returns account info if valid.
 * The UI calls this when the user enters their key.
 */
app.post('/api/connect', async (req, res) => {
  const apiKey = req.body.apiKey || getApiKey(req);
  if (!apiKey) {
    return res.status(400).json({ success: false, error: 'No API key provided.' });
  }

  try {
    const config = loadConfig({ mode: 'api' as BuildMode });
    config.apiKey = apiKey;
    const client = new KlaviyoAPIClient(config);
    const connected = await client.testConnection();

    if (connected) {
      res.json({ success: true, message: 'Connected to Klaviyo successfully.' });
    } else {
      res.status(401).json({ success: false, error: 'Invalid API key. Check your key and try again.' });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, error: 'Connection failed: ' + msg });
  }
});

// ---------------------------------------------------------------------------
// API Endpoints
// ---------------------------------------------------------------------------

// List available flow templates
app.get('/api/flows', (_req, res) => {
  const flowsDir = path.join(__dirname, '..', 'flows');
  const files = fs.readdirSync(flowsDir).filter(f => f.endsWith('.json'));

  const flows = files.map(file => {
    const content = JSON.parse(fs.readFileSync(path.join(flowsDir, file), 'utf-8')) as FlowDefinition;
    return {
      filename: file,
      name: content.name,
      triggerType: content.trigger?.type,
      triggerName: (content.trigger as { metric_name?: string; list_name?: string }).metric_name
        || (content.trigger as { list_name?: string }).list_name || '',
      actionCount: content.actions?.length || 0,
      settings: content.settings || null,
      hasProfileFilter: !!content.profile_filter,
      hasTriggerFilter: content.trigger?.type === 'metric' && !!(content.trigger as { trigger_filter?: unknown }).trigger_filter,
    };
  });

  res.json(flows);
});

// Get full flow definition (for the UI to populate settings)
app.get('/api/flows/:filename', (req, res) => {
  const flowPath = path.join(__dirname, '..', 'flows', req.params.filename);
  if (!fs.existsSync(flowPath)) {
    return res.status(404).json({ error: 'Flow file not found' });
  }

  const content = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
  res.json(content);
});

// Start a flow build
app.post('/api/build', async (req, res) => {
  const { flowFile, mode = 'api', settingsOverrides, definition: rawDefinition, apiKey: bodyApiKey } = req.body;

  if (!flowFile && !rawDefinition) {
    return res.status(400).json({ error: 'flowFile or definition is required' });
  }

  // Resolve API key: body > header > env
  const userApiKey = bodyApiKey || getApiKey(req);

  // Generate a build ID for this run
  const buildId = `build-${Date.now()}`;

  // Return the build ID immediately so the client can connect to SSE
  res.json({ buildId, status: 'started' });

  // Run the build in the background
  setTimeout(async () => {
    const log = getLogger();

    try {
      let definition: FlowDefinition;

      if (rawDefinition) {
        definition = rawDefinition as FlowDefinition;
      } else {
        const flowPath = path.join(__dirname, '..', 'flows', flowFile);
        if (!fs.existsSync(flowPath)) {
          sendSSE(buildId, 'error', { message: `Flow file not found: ${flowFile}` });
          sendSSE(buildId, 'complete', { success: false, errors: [`Flow file not found: ${flowFile}`] });
          return;
        }
        definition = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
      }

      const config = loadConfig({ mode: mode as BuildMode });

      // Use the user-provided API key if available
      if (userApiKey) {
        config.apiKey = userApiKey;
      }

      // Apply UI settings overrides
      if (settingsOverrides) {
        applySettingsOverrides(definition, settingsOverrides);
      }

      const errors = validateConfig(config);
      if (errors.length > 0) {
        sendSSE(buildId, 'error', { message: errors.join(', ') });
        sendSSE(buildId, 'complete', { success: false, errors });
        return;
      }

      // Validate the flow definition
      const validation = validateFlowDefinition(definition);
      if (!validation.valid) {
        sendSSE(buildId, 'error', { message: 'Validation failed: ' + validation.errors.join('; ') });
        sendSSE(buildId, 'complete', { success: false, errors: validation.errors });
        return;
      }
      for (const w of validation.warnings) {
        sendSSE(buildId, 'log', { level: 'warn', message: w });
      }

      // Add SSE transport to logger for this build
      const sseTransport = new SSETransport(buildId) as any;
      log.add(sseTransport);

      // Check for A/B splits — not supported by API
      const hasABSplit = definition.actions.some(a => a.type === 'ab-split');
      let effectiveMode = mode;

      if (hasABSplit && mode === 'api') {
        sendSSE(buildId, 'log', { level: 'warn', message: 'Flow contains A/B splits — switching to browser mode (API does not support A/B tests).' });
        effectiveMode = 'browser';

        if (!config.email || !config.password) {
          sendSSE(buildId, 'error', { message: 'A/B splits require browser mode, but KLAVIYO_EMAIL/PASSWORD are not set in .env.' });
          sendSSE(buildId, 'complete', { success: false, errors: ['A/B splits require browser mode. Set KLAVIYO_EMAIL and KLAVIYO_PASSWORD in .env, or remove the A/B split.'] });
          return;
        }
      }

      sendSSE(buildId, 'status', { message: `Building "${definition.name}" via ${effectiveMode} mode...` });

      // Phase 1: Build the flow
      let result: BuildResult;

      if (effectiveMode === 'browser') {
        const builder = new BrowserFlowBuilder(config);
        result = await builder.buildFlow(definition);
      } else {
        const creator = new APIFlowCreator(config);
        result = await creator.buildFlow(definition);
      }

      // Phase 2: Browser config if needed (re-entry, profile filter, template linking)
      const needsReentry = definition.settings?.reentry;
      const needsProfileFilter = effectiveMode === 'browser' && definition.profile_filter &&
        definition.profile_filter.condition_groups?.length > 0;
      if (result.success && result.flowId && (needsReentry || needsProfileFilter)) {
        sendSSE(buildId, 'status', { message: 'Phase 2: Browser configuration...' });

        if (config.email && config.password) {
          try {
            const configurator = new BrowserFlowConfigurator(config);
            const configResult = await configurator.configure(result.flowId, {
              reentry: needsReentry ? definition.settings!.reentry : undefined,
              profileFilter: needsProfileFilter ? definition.profile_filter : undefined,
            });

            if (configResult.reentrySet) {
              const re = definition.settings!.reentry!;
              sendSSE(buildId, 'log', { level: 'info', message: `Re-entry set to "${re.mode}".` });
              if (result.settingsApplied) {
                result.settingsApplied['Re-entry'] = re.mode + (re.mode === 'time-based' ? ` (${re.value} ${re.unit})` : '');
              }
            } else if (needsReentry) {
              sendSSE(buildId, 'log', { level: 'warn', message: 'Re-entry could not be set automatically. Configure manually.' });
              result.warnings.push('Re-entry needs manual configuration in Klaviyo.');
            }

            if (configResult.profileFilterSet) {
              sendSSE(buildId, 'log', { level: 'info', message: 'Profile filter configured.' });
              if (result.settingsApplied) {
                result.settingsApplied['Profile Filter'] = 'Applied';
              }
            } else if (needsProfileFilter) {
              sendSSE(buildId, 'log', { level: 'warn', message: 'Profile filter could not be set via browser. Configure manually.' });
              result.warnings.push('Profile filter needs manual configuration in Klaviyo.');
            }

            if (configResult.errors.length > 0) {
              result.warnings.push(...configResult.errors);
            }
            if (configResult.screenshots.length > 0) {
              result.screenshots = [...(result.screenshots || []), ...configResult.screenshots];
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            sendSSE(buildId, 'log', { level: 'warn', message: `Phase 2 failed: ${msg}` });
            result.warnings.push(`Browser config failed: ${msg}. Set manually.`);
          }
        } else {
          sendSSE(buildId, 'log', { level: 'warn', message: 'Browser config requires KLAVIYO_EMAIL/PASSWORD in .env.' });
          if (needsReentry) result.warnings.push('Re-entry needs manual configuration (no browser credentials).');
          if (needsProfileFilter) result.warnings.push('Profile filter needs manual configuration (no browser credentials).');
        }
      }

      // Remove SSE transport
      log.remove(sseTransport as any);

      // Send final result
      sendSSE(buildId, 'complete', result as unknown as Record<string, unknown>);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sendSSE(buildId, 'error', { message: msg });
      sendSSE(buildId, 'complete', {
        success: false,
        errors: [msg],
        flowName: '',
        mode,
        actionsCreated: 0,
        duration: 0,
      });
    }
  }, 100);
});

// SSE endpoint for real-time log streaming
app.get('/api/logs/:buildId', (req, res) => {
  const { buildId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', buildId })}\n\n`);

  // Store the connection
  sseClients.set(buildId, res);

  // Clean up on disconnect
  req.on('close', () => {
    sseClients.delete(buildId);
  });
});

// Helper to send SSE messages
function sendSSE(buildId: string, type: string, data: Record<string, unknown>) {
  const client = sseClients.get(buildId);
  if (client && !client.writableEnded) {
    client.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  }
}

/**
 * Apply settings overrides from the UI onto a flow definition.
 * Only overrides fields that the user explicitly changed.
 */
function applySettingsOverrides(
  definition: FlowDefinition,
  overrides: {
    smart_sending?: boolean;
    utm_tracking?: boolean;
    reentry_mode?: string;
    reentry_value?: number;
    reentry_unit?: string;
    profile_filter_enabled?: boolean;
    profile_filter_type?: string;
    trigger_filter_enabled?: boolean;
    trigger_filter_field?: string;
    trigger_filter_op?: string;
    trigger_filter_value?: number;
    action_overrides?: Record<string, { smart_sending?: boolean; utm_tracking?: boolean }>;
  },
): void {
  // Initialize settings if not present
  if (!definition.settings) {
    definition.settings = {};
  }

  // Flow-level overrides
  if (overrides.smart_sending !== undefined) {
    definition.settings.smart_sending = overrides.smart_sending;
  }
  if (overrides.utm_tracking !== undefined) {
    definition.settings.utm_tracking = overrides.utm_tracking;
  }

  // Profile filter override
  if (overrides.profile_filter_enabled) {
    const channel = overrides.profile_filter_type === 'sms-consent' ? 'sms' : 'email';
    definition.profile_filter = {
      condition_groups: [{
        conditions: [{
          type: 'profile-marketing-consent',
          consent: {
            channel,
            can_receive_marketing: true,
            consent_status: {
              subscription: 'subscribed',
              filters: null,
            },
          },
        }],
      }],
    };
  } else if (overrides.profile_filter_enabled === false) {
    definition.profile_filter = null;
  }

  // Trigger filter override (only for metric triggers)
  if (overrides.trigger_filter_enabled && definition.trigger.type === 'metric') {
    const metricTrigger = definition.trigger;
    metricTrigger.trigger_filter = {
      condition_groups: [{
        conditions: [{
          type: 'metric-property',
          metric_id: metricTrigger.metric_id || '',
          field: overrides.trigger_filter_field || '$value',
          filter: {
            type: 'numeric',
            operator: overrides.trigger_filter_op || 'greater-than',
            value: overrides.trigger_filter_value || 0,
          },
        }],
      }],
    };
  } else if (overrides.trigger_filter_enabled === false && definition.trigger.type === 'metric') {
    definition.trigger.trigger_filter = undefined;
  }

  // Re-entry override
  if (overrides.reentry_mode && overrides.reentry_mode !== 'none') {
    const reentry: ReentryConfig = { mode: overrides.reentry_mode as ReentryConfig['mode'] };
    if (reentry.mode === 'time-based') {
      reentry.value = overrides.reentry_value || 30;
      reentry.unit = (overrides.reentry_unit as ReentryConfig['unit']) || 'days';
    }
    definition.settings.reentry = reentry;
  } else if (overrides.reentry_mode === 'none') {
    delete definition.settings.reentry;
  }

  // Per-action overrides
  if (overrides.action_overrides) {
    for (const action of definition.actions) {
      if (action.type === 'send-email' || action.type === 'send-sms') {
        const override = overrides.action_overrides[action.id];
        if (override) {
          const a = action as SendEmailAction | SendSmsAction;
          if (override.smart_sending !== undefined) a.smart_sending = override.smart_sending;
          if (override.utm_tracking !== undefined) a.utm_tracking = override.utm_tracking;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Image Upload — upload sliced images to Klaviyo via the web UI
// ---------------------------------------------------------------------------

/**
 * Upload an image file to Klaviyo's asset library.
 * Accepts multipart form data with a single 'image' file field.
 * Returns the Klaviyo-hosted URL so the UI can populate the image field.
 *
 * Usage: POST /api/upload-image  (multipart/form-data, field: "image")
 * Returns: { success: true, url: "https://...", name: "header.jpg", id: "abc123" }
 */
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ success: false, error: 'No image file provided.' });
  }

  try {
    // Get API key from header or env
    const config = loadConfig({ mode: 'api' as BuildMode });
    const userApiKey = getApiKey(req);
    if (userApiKey) config.apiKey = userApiKey;

    if (!config.apiKey) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ success: false, error: 'No API key. Connect your Klaviyo account first.' });
    }

    const client = new KlaviyoAPIClient(config);
    const originalName = file.originalname || 'email-image';
    const log = getLogger();

    // ── Sharp Compression ──
    const originalSize = file.size;
    const ext = path.extname(originalName).toLowerCase() || '.jpg';
    const compressedPath = file.path + '-compressed' + ext;
    const IMAGE_MAX_WIDTH = parseInt(process.env.IMAGE_MAX_WIDTH || '1200', 10);
    const IMAGE_QUALITY = parseInt(process.env.IMAGE_QUALITY || '82', 10);

    let finalPath = file.path;
    let compressedSize = originalSize;

    try {
      const metadata = await sharp(file.path).metadata();
      const isGif = metadata.format === 'gif';
      const hasAlpha = metadata.hasAlpha;

      if (isGif) {
        // Skip GIFs (may be animated — Sharp doesn't handle animation well)
        log.info(`Skipping compression for GIF: ${originalName}`);
        const renamedPath = file.path + ext;
        fs.renameSync(file.path, renamedPath);
        finalPath = renamedPath;
      } else if (hasAlpha && (metadata.format === 'png' || metadata.format === 'webp')) {
        // Transparent image — keep as optimized PNG
        await sharp(file.path)
          .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
          .png({ quality: IMAGE_QUALITY, compressionLevel: 9 })
          .toFile(compressedPath);
        compressedSize = fs.statSync(compressedPath).size;

        // Keep compressed only if it's actually smaller
        if (compressedSize < originalSize) {
          finalPath = compressedPath;
          log.info(`Compressed PNG: ${formatBytes(originalSize)} → ${formatBytes(compressedSize)} (${Math.round((1 - compressedSize / originalSize) * 100)}% saved)`);
        } else {
          finalPath = file.path + ext;
          fs.renameSync(file.path, finalPath);
          compressedSize = originalSize;
          try { fs.unlinkSync(compressedPath); } catch (_) {}
          log.info(`PNG already optimal: ${formatBytes(originalSize)}`);
        }
      } else {
        // Photo — convert to optimized JPEG
        await sharp(file.path)
          .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
          .jpeg({ quality: IMAGE_QUALITY, mozjpeg: true })
          .toFile(compressedPath);
        compressedSize = fs.statSync(compressedPath).size;

        // Keep compressed only if smaller
        if (compressedSize < originalSize) {
          finalPath = compressedPath;
          log.info(`Compressed: ${formatBytes(originalSize)} → ${formatBytes(compressedSize)} (${Math.round((1 - compressedSize / originalSize) * 100)}% saved)`);
        } else {
          finalPath = file.path + ext;
          fs.renameSync(file.path, finalPath);
          compressedSize = originalSize;
          try { fs.unlinkSync(compressedPath); } catch (_) {}
          log.info(`Image already optimal: ${formatBytes(originalSize)}`);
        }
      }
    } catch (sharpErr) {
      // If Sharp fails, fall back to uploading the original
      log.warn(`Compression failed, uploading original: ${sharpErr}`);
      const renamedPath = file.path + ext;
      try { fs.renameSync(file.path, renamedPath); } catch (_) {}
      finalPath = renamedPath;
      compressedSize = originalSize;
    }

    // Upload to Klaviyo
    const uploadResult = await client.uploadImageFromFile(finalPath, originalName);

    // Clean up temp files
    try { fs.unlinkSync(finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
    try { fs.unlinkSync(compressedPath); } catch (_) {}

    res.json({
      success: true,
      url: uploadResult.data.attributes.image_url,
      name: uploadResult.data.attributes.name,
      id: uploadResult.data.id,
      format: uploadResult.data.attributes.format,
      size: uploadResult.data.attributes.size,
      originalSize,
      compressedSize,
      saved: originalSize > compressedSize ? Math.round((1 - compressedSize / originalSize) * 100) : 0,
    });

  } catch (error) {
    // Clean up the temp file on error
    try { fs.unlinkSync(file.path); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(file.path + path.extname(file.originalname || '.jpg')); } catch (_) { /* ignore */ }

    const msg = error instanceof Error ? error.message : String(error);
    const log = getLogger();
    log.error(`Image upload failed: ${msg}`);

    // Friendly error messages
    let userMsg = msg;
    if (msg.includes('401') || msg.includes('403')) {
      userMsg = 'API key doesn\'t have permission. Check your KLAVIYO_API_KEY has images:write scope.';
    } else if (msg.includes('429')) {
      userMsg = 'Rate limited — Klaviyo allows 100 image uploads per day. Try again tomorrow.';
    } else if (msg.includes('413') || msg.includes('5 MB')) {
      userMsg = 'Image too large. Klaviyo allows max 5MB. Compress it and try again.';
    }

    res.status(500).json({ success: false, error: userMsg });
  }
});

// ---------------------------------------------------------------------------
// Email Preview — renders generated HTML for testing (no Klaviyo needed)
// ---------------------------------------------------------------------------

/**
 * Preview email HTML from the UI's in-memory content (POST).
 * The UI sends the email content object; we generate and return HTML.
 * This is the primary preview method — uses whatever the user is editing.
 *
 * Usage: POST /api/preview  { content: { sections: [...], ... } }
 * Returns: raw HTML
 */
app.post('/api/preview', (req, res) => {
  const { content } = req.body;

  if (!content || !content.sections || content.sections.length === 0) {
    return res.status(400).json({ error: 'No content sections provided.' });
  }

  const html = buildEmailHtml(content);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

/**
 * Preview email HTML from a flow file on disk (GET — fallback).
 * Usage: GET /api/preview/abandoned-cart.json/email-1
 */
app.get('/api/preview/:filename/:emailId', (req, res) => {
  const flowPath = path.join(__dirname, '..', 'flows', req.params.filename);
  if (!fs.existsSync(flowPath)) {
    return res.status(404).json({ error: 'Flow file not found' });
  }

  const definition = JSON.parse(fs.readFileSync(flowPath, 'utf-8')) as FlowDefinition;
  const emailAction = definition.actions.find(
    (a) => a.id === req.params.emailId && a.type === 'send-email',
  ) as SendEmailAction | undefined;

  if (!emailAction) {
    return res.status(404).json({ error: `Email action "${req.params.emailId}" not found in flow` });
  }

  if (!emailAction.content) {
    return res.status(404).json({ error: `Email "${emailAction.name}" has no content defined` });
  }

  const html = buildEmailHtml(emailAction.content);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

/**
 * List all emails with content in a flow (for the preview picker).
 */
app.get('/api/preview/:filename', (req, res) => {
  const flowPath = path.join(__dirname, '..', 'flows', req.params.filename);
  if (!fs.existsSync(flowPath)) {
    return res.status(404).json({ error: 'Flow file not found' });
  }

  const definition = JSON.parse(fs.readFileSync(flowPath, 'utf-8')) as FlowDefinition;
  const emails = definition.actions
    .filter((a): a is SendEmailAction => a.type === 'send-email')
    .map((a) => ({
      id: a.id,
      name: a.name,
      subject_line: a.subject_line || '',
      has_content: !!a.content,
      section_count: a.content?.sections?.length || 0,
    }));

  res.json(emails);
});

// Serve frontend
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
createLogger('info');

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║   Klaviyo Flow Builder — Web UI               ║');
  console.log(`  ║   Running at http://localhost:${PORT}             ║`);
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');
});
