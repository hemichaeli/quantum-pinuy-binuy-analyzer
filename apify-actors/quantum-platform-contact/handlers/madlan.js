/**
 * Madlan handler — POC implementation (Day 10).
 *
 * Flow:
 *   1. Navigate to listing URL.
 *   2. If a "צור קשר" / "השאר פרטים" button is visible, click it.
 *   3. Wait for the contact-form modal.
 *   4. Fill name + phone + email + message fields.
 *   5. Click submit.
 *   6. Verify success (toast/banner/URL change).
 *
 * If a Cloudflare challenge appears, the residential proxy + stealth plugin
 * usually clears it within a few seconds. If a hCaptcha appears, fall through
 * to 2Captcha (TODO — most madlan listings don't need this).
 *
 * Selectors will drift; keep them updated.
 */

const SELECTORS = {
  // Buttons that open the contact modal (try in order)
  openModal: [
    'button[data-auto="contact-button"]',
    'button:has-text("צור קשר")',
    'button:has-text("השאר פרטים")',
    'a[href*="contact"]',
  ],

  // Form fields
  nameInput:    'input[name="name"], input[placeholder*="שם"]',
  phoneInput:   'input[name="phone"], input[type="tel"]',
  emailInput:   'input[name="email"], input[type="email"]',
  messageInput: 'textarea[name="message"], textarea[placeholder*="הודעה"]',

  // Submit
  submitButton: [
    'button[type="submit"]',
    'button:has-text("שלח")',
    'button:has-text("שליחה")',
  ],

  // Success indicators
  successToast: '[role="alert"], .toast-success, .success-message',
};

async function clickFirst(page, selectors, timeout = 8000) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: timeout / selectors.length, visible: true });
      if (el) {
        await el.click({ delay: 50 });
        return sel;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function typeIfPresent(page, selector, value) {
  if (!value) return false;
  try {
    const el = await page.$(selector);
    if (!el) return false;
    await el.click({ clickCount: 3 }); // select existing
    await el.type(String(value), { delay: 30 });
    return true;
  } catch { return false; }
}

module.exports = async function madlanHandler(page, input) {
  const { listingUrl, contactName, phone, email, message } = input;

  if (!listingUrl) return { success: false, error: 'No listingUrl' };

  await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Wait briefly for Cloudflare / JS hydration
  await page.waitForTimeout(2500);

  // Open the contact modal
  const opened = await clickFirst(page, SELECTORS.openModal);
  if (!opened) {
    return { success: false, error: 'Could not find contact button on listing page' };
  }

  // Wait for the form to render
  await page.waitForTimeout(1500);

  const filledName    = await typeIfPresent(page, SELECTORS.nameInput, contactName);
  const filledPhone   = await typeIfPresent(page, SELECTORS.phoneInput, phone);
  const filledEmail   = await typeIfPresent(page, SELECTORS.emailInput, email);
  const filledMessage = await typeIfPresent(page, SELECTORS.messageInput, message);

  if (!filledPhone || !filledMessage) {
    return {
      success: false,
      error: 'Could not fill required form fields',
      detail: { filledName, filledPhone, filledEmail, filledMessage },
    };
  }

  // Submit
  const submitted = await clickFirst(page, SELECTORS.submitButton, 5000);
  if (!submitted) {
    return { success: false, error: 'Could not find submit button' };
  }

  // Wait for success indicator (or error)
  await page.waitForTimeout(3000);
  const successEl = await page.$(SELECTORS.successToast);

  return {
    success: !!successEl,
    detail: {
      hadSuccessToast: !!successEl,
      submitClicked: true,
      filledName, filledPhone, filledEmail, filledMessage,
    },
    error: successEl ? null : 'Submit clicked but no success indicator detected within 3s',
  };
};
