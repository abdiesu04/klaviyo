// =============================================================================
// Klaviyo Flow Builder — DOM Selectors (CALIBRATED)
// =============================================================================
// Calibrated against the real Klaviyo UI on 2026-02-10.
// All selectors verified via Playwright DOM inspection against live Klaviyo.
//
// MAINTENANCE: This is the SINGLE file to update when Klaviyo changes their UI.
// =============================================================================

export const SELECTORS = {
  // ---------------------------------------------------------------------------
  // Login Page (VERIFIED)
  // ---------------------------------------------------------------------------
  login: {
    emailInput: '[data-testid="email"]',
    passwordInput: '[data-testid="password-PasswordInput"]',
    submitButton: '[data-testid="login"]',
    captchaCheckbox: '.recaptcha-checkbox-border, iframe[title*="reCAPTCHA"]',
  },

  // ---------------------------------------------------------------------------
  // Flows List Page (VERIFIED)
  // ---------------------------------------------------------------------------
  nav: {
    createFlowButton: 'button:has-text("Create flow")',
    flowRow: (id: string) => `[data-testid="flow-row-${id}"]`,
  },

  // ---------------------------------------------------------------------------
  // Create Flow Dialog (VERIFIED)
  // ---------------------------------------------------------------------------
  flowCreation: {
    buildYourOwnButton: '[data-testid="create-flow-from-scratch-button"]',
    nameInput: 'input[placeholder*="Welcome series"]',
    nameInputFallback: 'input[placeholder*="e.g."]',
    createFlowSubmit: 'button:has-text("Create flow")',
    cancelButton: 'button:has-text("Cancel")',
  },

  // ---------------------------------------------------------------------------
  // Flow Builder Canvas (VERIFIED — React Flow based)
  // ---------------------------------------------------------------------------
  canvas: {
    wrapper: '[data-testid="rf__wrapper"]',
    triggerNode: '[data-testid="trigger-node-wrapper"]',
    flowSwitcher: '[data-testid="flow-switcher"]',
    statusBadge: '[data-testid="flow-StatusBadge"]',
    exitButton: 'a:has-text("Exit")',
    zoomIn: '[data-testid="canvas-toolbar-zoom-in"]',
    nodeHeaderText: '[data-testid="flow-node-header-text"]',
    // "+" add action button — appears between nodes on the canvas
    addActionButton: '[data-testid*="add-action"], [data-testid*="insert-node"], button[aria-label*="Add"]',
    // Generic node selector
    flowNode: '[data-testid*="flow-node"], [data-testid*="node-wrapper"]',
  },

  // ---------------------------------------------------------------------------
  // Config Panel (Right Sidebar Drawer) (VERIFIED)
  // ---------------------------------------------------------------------------
  configPanel: {
    drawer: '[data-testid="config-panel-drawer"]',
    header: '[data-testid="config-panel-drawer-DrawerPanelHeader"]',
    body: '[data-testid="config-panel-drawer-DrawerPanelBody"]',
    content: '[data-testid="config-panel-drawer-DrawerPanelBody-content"]',
    // Tabs in the config panel
    tabList: '[role="tablist"]',
    tab: (name: string) => `[role="tab"]:has-text("${name}")`,
  },

  // ---------------------------------------------------------------------------
  // Trigger Selection (VERIFIED — shown in config panel after clicking trigger)
  // ---------------------------------------------------------------------------
  triggers: {
    // Tab options
    recommendedTab: '[role="tab"]:has-text("Recommended")',
    yourMetricsTab: '[role="tab"]:has-text("Your metrics")',
    allTriggersTab: '[role="tab"]:has-text("All triggers")',
    // Trigger cards (use text matching for flexibility)
    checkoutStarted: ':text("Checkout started")',
    addedToList: ':text("Added to list")',
    viewedProduct: ':text("Viewed product")',
    placedOrder: ':text("Placed order")',
    addedToCart: ':text("Added to cart")',
    addedToSegment: ':text("Added to segment")',
    // Generic trigger option by name
    triggerOption: (name: string) => `:text("${name}")`,
    // Search in triggers
    searchInput: 'input[placeholder*="Search" i]',
  },

  // ---------------------------------------------------------------------------
  // Action Types (in "add action" picker)
  // These appear when clicking the "+" button on the canvas
  // ---------------------------------------------------------------------------
  actionPicker: {
    emailAction: ':text("Email"), button:has-text("Email")',
    smsAction: ':text("SMS"), button:has-text("SMS")',
    timeDelayAction: ':text("Time delay"), button:has-text("Time delay")',
    conditionalSplitAction: ':text("Conditional split"), button:has-text("Conditional split")',
    triggerSplitAction: ':text("Trigger split"), button:has-text("Trigger split")',
    webhookAction: ':text("Webhook"), button:has-text("Webhook")',
    updateProfileAction: ':text("Update profile property"), button:has-text("Update profile")',
    // Generic by name
    action: (name: string) => `:text("${name}"), button:has-text("${name}")`,
  },

  // ---------------------------------------------------------------------------
  // Time Delay Config
  // ---------------------------------------------------------------------------
  timeDelay: {
    valueInput: 'input[type="number"]',
    unitSelect: 'select, [role="listbox"], button:has-text("hours"), button:has-text("days")',
    unitOption: (unit: string) => `[role="option"]:has-text("${unit}"), option:has-text("${unit}")`,
    doneButton: 'button:has-text("Done"), button:has-text("Save")',
  },

  // ---------------------------------------------------------------------------
  // Email Config
  // ---------------------------------------------------------------------------
  email: {
    nameInput: 'input[placeholder*="name" i], input[aria-label*="name" i]',
    doneButton: 'button:has-text("Done"), button:has-text("Save")',
  },

  // ---------------------------------------------------------------------------
  // Conditional Split Config
  // ---------------------------------------------------------------------------
  conditionalSplit: {
    doneButton: 'button:has-text("Done"), button:has-text("Save")',
  },

  // ---------------------------------------------------------------------------
  // Re-entry / Flow Filter Settings (in trigger config panel)
  // ---------------------------------------------------------------------------
  reentry: {
    // Common text patterns for re-entry section
    sectionLabels: [
      ':text("re-entry")',
      ':text("Re-entry")',
      ':text("Flow filters")',
      ':text("flow filters")',
    ],
    // Options
    onceOption: 'label:has-text("Once"), [role="radio"]:has-text("Once"), [role="option"]:has-text("Once")',
    multipleOption: 'label:has-text("Multiple"), [role="radio"]:has-text("Multiple"), [role="option"]:has-text("Multiple")',
    timeBasedOption: 'label:has-text("Time-based"), [role="radio"]:has-text("Time-based"), [role="option"]:has-text("Time-based")',
    timeValueInput: 'input[type="number"]',
  },

  // ---------------------------------------------------------------------------
  // General / Shared
  // ---------------------------------------------------------------------------
  general: {
    modal: '[role="dialog"]',
    closeModal: 'button[aria-label="Close"], button:has-text("Close")',
    loadingSpinner: '[data-testid*="loading"], [data-testid*="spinner"]',
    toast: '[role="alert"]',
    doneButton: 'button:has-text("Done")',
    saveButton: 'button:has-text("Save")',
    cancelButton: 'button:has-text("Cancel")',
  },
} as const;

// ---------------------------------------------------------------------------
// URL Patterns
// ---------------------------------------------------------------------------
export const URLS = {
  login: 'https://www.klaviyo.com/login',
  dashboard: 'https://www.klaviyo.com/dashboard',
  flows: 'https://www.klaviyo.com/flows',
  flowEdit: (id: string) => `https://www.klaviyo.com/flow/${id}/edit`,
} as const;

// ---------------------------------------------------------------------------
// Trigger Name Mapping (user-friendly → Klaviyo UI label)
// ---------------------------------------------------------------------------
export const TRIGGER_LABELS: Record<string, string> = {
  'Started Checkout': 'Checkout started',
  'Checkout Started': 'Checkout started',
  'Added to Cart': 'Added to cart',
  'Placed Order': 'Placed order',
  'Viewed Product': 'Viewed product',
  'Added to List': 'Added to list',
  'Added to Segment': 'Added to segment',
  'Active on Site': 'Active on Site',
};
