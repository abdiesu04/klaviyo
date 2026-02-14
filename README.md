# Klaviyo Flow Builder — Browser Automation + API

**Automated Klaviyo flow skeleton builder** for ZHS Ecom.  
Creates complete flow structures in Klaviyo — triggers, emails, delays, conditional splits, and A/B tests — from a simple JSON definition.

---

## Architecture

This tool uses a **dual-mode approach** for maximum reliability:

| Mode | Method | Best For | A/B Tests |
|------|--------|----------|-----------|
| `api` (default) | Klaviyo Flows REST API | Speed, reliability, CI/CD | Not supported by API |
| `browser` | Playwright browser automation | A/B tests, API fallback | Supported |
| `hybrid` | API first, browser fallback | Best of both worlds | Auto-switches to browser |

### Why Dual-Mode?

**API mode** is the primary approach because:
- Faster (no browser overhead, ~2-5s per flow)
- More reliable (no DOM changes to break it)
- Works headless in CI/CD pipelines
- Klaviyo's Flows API (beta) supports creating complete flow definitions

**Browser mode** exists because:
- A/B test creation is **not supported** by Klaviyo's API (as of 2026)
- Acts as a fallback if the API is unavailable or limited
- Enables visual verification with screenshots

### Tech Stack

- **TypeScript** — Full type safety for flow definitions and API payloads
- **Playwright** — Browser automation (Chromium) with auto-waiting, resilient selectors
- **Axios** — HTTP client for Klaviyo REST API
- **Commander** — CLI framework
- **Winston** — Structured logging with file + console output

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
npx playwright install chromium   # Required for browser mode only
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your Klaviyo credentials:

```env
# For API mode (recommended)
KLAVIYO_API_KEY=pk_your_private_api_key_here

# For browser mode (required for A/B tests)
KLAVIYO_EMAIL=your-email@example.com
KLAVIYO_PASSWORD=your-password-here
```

**Where to find your API key:**  
Klaviyo → Settings → API Keys → Private API Keys

### 3. Build a Flow

```bash
# API mode (default) — fastest, most reliable
npm run test:abandoned-cart

# Browser mode — required for A/B tests
npm run test:abandoned-cart:ab

# Explicit mode selection
npx ts-node src/index.ts build --flow flows/abandoned-cart.json --mode api
npx ts-node src/index.ts build --flow flows/abandoned-cart.json --mode browser
npx ts-node src/index.ts build --flow flows/abandoned-cart.json --mode hybrid
```

---

## CLI Commands

### `build` — Create a flow

```bash
npx ts-node src/index.ts build \
  --flow <path-to-json> \
  --mode <api|browser|hybrid> \
  --api-key <key> \
  --headless \
  --verbose
```

| Flag | Description | Default |
|------|-------------|---------|
| `-f, --flow` | Path to flow definition JSON | **required** |
| `-m, --mode` | Build mode: `api`, `browser`, `hybrid` | `api` |
| `-k, --api-key` | Klaviyo API key (overrides .env) | from .env |
| `--headless` / `--no-headless` | Show/hide browser window | `true` |
| `--slow-mo <ms>` | Slow down browser actions (debugging) | `0` |
| `-v, --verbose` | Enable debug logging | `false` |

### `verify` — Verify a created flow

```bash
npx ts-node src/index.ts verify --flow-id <FLOW_ID>
```

### `test-connection` — Test API connectivity

```bash
npx ts-node src/index.ts test-connection
```

### `list-flows` — List all flows in your account

```bash
npx ts-node src/index.ts list-flows --status draft
```

---

## Flow Definition Schema

Flows are defined as JSON files. Here's the structure:

```json
{
  "name": "Flow Name",
  "trigger": {
    "type": "metric",
    "metric_name": "Started Checkout"
  },
  "entry_action_id": "first-action-id",
  "actions": [
    {
      "id": "delay-1",
      "type": "time-delay",
      "delay_value": 1,
      "delay_unit": "days",
      "next": "email-1"
    },
    {
      "id": "email-1",
      "type": "send-email",
      "name": "Email #1",
      "subject_line": "Subject here",
      "next": "split-1"
    },
    {
      "id": "split-1",
      "type": "conditional-split",
      "condition_type": "has-opened-email",
      "condition_label": "Has Opened Email",
      "next_if_true": "email-yes",
      "next_if_false": "email-no"
    }
  ]
}
```

### Supported Action Types

| Type | Description | Key Fields |
|------|-------------|------------|
| `time-delay` | Wait before next action | `delay_value`, `delay_unit` (minutes/hours/days/weeks) |
| `send-email` | Email action (skeleton) | `name`, `subject_line`, `preview_text` |
| `send-sms` | SMS action (skeleton) | `name`, `body` |
| `conditional-split` | YES/NO branch | `condition_type`, `next_if_true`, `next_if_false` |
| `ab-split` | A/B test (browser only) | `split_percentage`, `next_variant_a`, `next_variant_b` |

### Supported Trigger Types

| Type | Description | Key Fields |
|------|-------------|------------|
| `metric` | Event-based (e.g., Started Checkout) | `metric_name` |
| `list` | Added to list | `list_name` |
| `date-property` | Date-based (e.g., birthday) | `property_name` |

### Supported Condition Types (for `conditional-split`)

- `has-opened-email` — Profile opened an email recently
- `has-clicked-email` — Profile clicked a link in an email
- `has-received-email` — Profile received an email
- `profile-marketing-consent` — Profile has consented to marketing
- `custom` — Pass a raw Klaviyo filter object

---

## Included Flow Templates

| File | Description | Actions |
|------|-------------|---------|
| `flows/abandoned-cart.json` | **Test case**: 3 emails, 1-day delays, opened/not-opened split | 8 |
| `flows/abandoned-cart-ab.json` | Same + A/B test on first email subject line | 11 |
| `flows/welcome-series.json` | 3-email welcome series with engagement split | 7 |
| `flows/post-purchase.json` | Thank you → tips → review → cross-sell | 7 |

### Abandoned Cart Test Case (Flow Diagram)

```
[Trigger: Started Checkout]
         │
    ┌────▼────┐
    │ 1-Day   │
    │ Delay   │
    └────┬────┘
         │
    ┌────▼─────────────┐
    │ Email #1         │
    │ "You left        │
    │  something..."   │
    └────┬─────────────┘
         │
    ┌────▼────┐
    │ 1-Day   │
    │ Delay   │
    └────┬────┘
         │
    ┌────▼──────────────────┐
    │ Conditional Split:    │
    │ Opened Email #1?      │
    └───┬──────────────┬────┘
        │              │
   YES  │         NO   │
   ┌────▼────┐   ┌────▼──────────┐
   │ Email#2 │   │ Email #2      │
   │(Opened) │   │ (Not Opened)  │
   └─────────┘   └────┬──────────┘
                       │
                  ┌────▼────┐
                  │ 1-Day   │
                  │ Delay   │
                  └────┬────┘
                       │
                  ┌────▼──────────┐
                  │ Email #3      │
                  │ (Final)       │
                  └───────────────┘
```

---

## Error Handling

The tool includes multiple layers of error handling:

1. **Retry logic** — Exponential backoff on transient failures (default: 3 attempts)
2. **Screenshot capture** — Automatic screenshots on browser errors for debugging
3. **Graceful degradation** — Hybrid mode falls back from API → browser automatically
4. **Session persistence** — Saved login cookies to avoid repeated authentication
5. **Structured logging** — File + console logs with timestamps for troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| API 401/403 | Check `KLAVIYO_API_KEY` — needs read/write access |
| API 422 | Flow definition has invalid fields. Check trigger metric ID exists in your account |
| API 429 | Rate limited. Wait 60s and retry |
| Browser login fails | Check `KLAVIYO_EMAIL` / `KLAVIYO_PASSWORD`. May need MFA handling |
| Selector not found | Klaviyo UI may have updated. Update `src/browser/selectors.ts` |
| A/B test fails | Requires browser mode. API does not support A/B tests |

---

## Project Structure

```
klaviyo-flow-builder/
├── src/
│   ├── index.ts              # CLI entry point (Commander)
│   ├── config.ts             # Environment config loader
│   ├── types.ts              # TypeScript types for everything
│   ├── api/
│   │   ├── client.ts         # Klaviyo REST API wrapper
│   │   └── flow-creator.ts   # API-based flow creation logic
│   ├── browser/
│   │   ├── auth.ts           # Playwright login + session mgmt
│   │   ├── flow-builder.ts   # Browser-based flow building
│   │   └── selectors.ts      # Centralized DOM selectors
│   └── utils/
│       ├── logger.ts         # Winston logger
│       └── retry.ts          # Retry with exponential backoff
├── flows/                    # Flow definition JSON files
│   ├── abandoned-cart.json   # Test case (3 emails, splits)
│   ├── abandoned-cart-ab.json # With A/B test (bonus)
│   ├── welcome-series.json   # Welcome flow template
│   └── post-purchase.json    # Post-purchase flow template
├── screenshots/              # Auto-generated debug screenshots
├── .env.example              # Environment config template
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Design Decisions & Rationale

### Why Playwright over Puppeteer?
- **Auto-waiting**: No manual `waitForSelector` + `sleep` chains
- **Resilient locators**: Role-based, text-based, and test-id selectors
- **Cross-browser**: Works with Chromium, Firefox, WebKit
- **Network interception**: Can wait for specific API calls to complete
- **Better debugging**: Trace viewer, screenshot on failure, video recording

### Why API-first?
- Klaviyo's beta Flows API (`POST /api/flows/`) can create complete flow structures
- More reliable than DOM manipulation — immune to UI redesigns
- Faster execution (~2-5s vs ~30-60s for browser)
- Works in headless CI/CD without a browser

### Why centralized selectors?
- `src/browser/selectors.ts` is the single source of truth for all DOM selectors
- When Klaviyo updates their UI (they will), only this one file needs updating
- Uses fallback selector chains (test-id → role → text → class)

### Why JSON flow definitions?
- Declarative, version-controllable, easy to template
- Team members can create flow specs without touching code
- Can be generated from a spreadsheet or form

---

## Extending the Tool

### Adding a New Action Type

1. Add the type to `src/types.ts`
2. Add API transformation in `src/api/flow-creator.ts`
3. Add browser automation in `src/browser/flow-builder.ts`
4. Add DOM selectors in `src/browser/selectors.ts`

### Adding a New Trigger Type

1. Add the trigger type to `src/types.ts`
2. Add resolution logic in `src/api/flow-creator.ts` → `resolveTrigger()`
3. Add browser handling in `src/browser/flow-builder.ts` → `setTrigger()`

### Creating Custom Flow Templates

Create a new JSON file in `flows/` following the schema in this README. The `id` field on each action is a local identifier used to wire actions together via `next`, `next_if_true`, `next_if_false`, etc.

---

## Notes for ZHS Ecom

- All flows are created in **Draft** status. Review in Klaviyo before setting live.
- The tool creates **structure only** (skeleton). Email copy, design, and templates are configured separately in Klaviyo's template editor.
- For production use with client accounts, set `HEADLESS=true` and use API mode.
- The A/B test feature (bonus) requires browser mode since the Klaviyo API doesn't support it.

---

Built for [ZHS Ecom](https://zhs-ecom.com) — Email & SMS for DTC Brands
