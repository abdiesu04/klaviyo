// =============================================================================
// Klaviyo Flow Builder — Email HTML Builder
// =============================================================================
// Generates responsive, sliced email HTML from section definitions.
//
// Follows email best practices per the SOP:
//   - Table-based layout (Outlook compatibility)
//   - Inline CSS (email clients strip <style> blocks)
//   - 600px content width, images at 2x for retina
//   - Image blocks as full-width <img> in table cells
//   - Live text (not baked into images)
//   - Bulletproof CTA buttons (VML fallback for Outlook)
//   - Mobile-responsive via media queries where supported
// =============================================================================

import {
  EmailContent,
  EmailSection,
  ImageSection,
  TextSection,
  ButtonSection,
  SpacerSection,
} from '../types';

/**
 * Build a complete email HTML document from section definitions.
 * Returns a self-contained HTML string ready for Klaviyo's template API.
 */
export function buildEmailHtml(content: EmailContent): string {
  const width = content.width || 600;
  const bgColor = content.background_color || '#ffffff';

  const sectionRows = content.sections
    .map((section) => renderSection(section, width))
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title></title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    /* Reset */
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }

    /* Mobile */
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .fluid-image { width: 100% !important; max-width: 100% !important; height: auto !important; }
      .stack-column { display: block !important; width: 100% !important; max-width: 100% !important; }
      .mobile-padding { padding-left: 16px !important; padding-right: 16px !important; }
      .mobile-center { text-align: center !important; }
      .mobile-button { width: 100% !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <!-- Preheader (hidden) -->
  <div style="display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    &#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </div>

  <!-- Email wrapper -->
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f4f4f4;">
    <tr>
      <td align="center" valign="top" style="padding:20px 0;">

        <!-- Email container -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="${width}" class="email-container" style="max-width:${width}px;background-color:${bgColor};">
${sectionRows}
        </table>
        <!-- /Email container -->

      </td>
    </tr>
  </table>
  <!-- /Email wrapper -->

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Section Renderers
// ---------------------------------------------------------------------------

function renderSection(section: EmailSection, width: number): string {
  switch (section.type) {
    case 'image':
      return renderImageSection(section, width);
    case 'text':
      return renderTextSection(section, width);
    case 'button':
      return renderButtonSection(section, width);
    case 'spacer':
      return renderSpacerSection(section);
    default:
      return `<!-- Unknown section type -->`;
  }
}

/**
 * Render a full-width image block.
 * Per the SOP: images are sliced sections, full width, with optional link.
 */
function renderImageSection(section: ImageSection, containerWidth: number): string {
  const imgWidth = section.width || containerWidth;
  const alt = escapeAttr(section.alt || '');

  const imgTag = `<img src="${escapeAttr(section.src)}" alt="${alt}" width="${imgWidth}" class="fluid-image" style="display:block;width:100%;max-width:${imgWidth}px;height:auto;border:0;" />`;

  const content = section.link
    ? `<a href="${escapeAttr(section.link)}" target="_blank" style="display:block;">${imgTag}</a>`
    : imgTag;

  return `          <!-- Image Block -->
          <tr>
            <td align="center" valign="top" style="padding:0;line-height:0;font-size:0;">
              ${content}
            </td>
          </tr>`;
}

/**
 * Render a live text block.
 * Per the SOP: keep copy live in Klaviyo, not baked into images.
 */
function renderTextSection(section: TextSection, _width: number): string {
  const align = section.align || 'center';
  const padding = section.padding !== undefined ? section.padding : 20;

  return `          <!-- Text Block -->
          <tr>
            <td align="${align}" valign="top" class="mobile-padding" style="padding:${padding}px ${padding + 10}px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#333333;">
              ${section.html}
            </td>
          </tr>`;
}

/**
 * Render a bulletproof CTA button.
 * Per the SOP: real HTML buttons, not image buttons. Large enough to tap on mobile.
 * Uses the "padding + link" method for broad email client support.
 */
function renderButtonSection(section: ButtonSection, _width: number): string {
  const bg = section.background || '#000000';
  const color = section.color || '#ffffff';
  const radius = section.border_radius !== undefined ? section.border_radius : 4;
  const padding = section.padding !== undefined ? section.padding : 20;
  const text = escapeHtml(section.text);
  const url = escapeAttr(section.url);

  return `          <!-- CTA Button -->
          <tr>
            <td align="center" valign="top" style="padding:${padding}px ${padding + 10}px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:250px;" arcsize="${Math.round((radius / 48) * 100)}%" strokecolor="${bg}" fillcolor="${bg}">
                <w:anchorlock/>
                <center style="color:${color};font-family:sans-serif;font-size:16px;font-weight:bold;">${text}</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${url}" target="_blank" style="display:inline-block;background-color:${bg};color:${color};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;line-height:48px;text-align:center;text-decoration:none;border-radius:${radius}px;padding:0 32px;min-width:200px;-webkit-text-size-adjust:none;mso-hide:all;" class="mobile-button">
                ${text}
              </a>
              <!--<![endif]-->
            </td>
          </tr>`;
}

/**
 * Render a spacer (empty space between sections).
 */
function renderSpacerSection(section: SpacerSection): string {
  const height = section.height || 20;

  return `          <!-- Spacer -->
          <tr>
            <td style="padding:0;height:${height}px;line-height:${height}px;font-size:1px;">&nbsp;</td>
          </tr>`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape for use inside HTML attribute values (e.g., src="...", href="...").
 * Only escapes double quotes — preserves & and other URL characters intact.
 */
function escapeAttr(str: string): string {
  return str.replace(/"/g, '&quot;');
}

/**
 * Check if a source path is a local file (vs. a URL).
 * Local paths start with "./" or "../" or are absolute paths without "://".
 */
export function isLocalFile(src: string): boolean {
  if (!src || src.trim() === '') return false;
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return false;
  }
  return true;
}

/**
 * Extract all image sources from an EmailContent definition.
 * Returns { local: string[], remote: string[] } for upload planning.
 */
export function extractImageSources(content: EmailContent): { local: string[]; remote: string[] } {
  const local: string[] = [];
  const remote: string[] = [];

  for (const section of content.sections) {
    if (section.type === 'image') {
      if (isLocalFile(section.src)) {
        local.push(section.src);
      } else {
        remote.push(section.src);
      }
    }
  }

  return { local, remote };
}
