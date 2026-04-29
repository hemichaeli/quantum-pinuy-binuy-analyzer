/**
 * Yad1 handler — STUB (Day 10).
 *
 * TODO: implement after running Chrome DevTools on a yad1 listing's contact
 * form to capture the exact selectors. Pattern is the same as madlan.js.
 *
 * Suggested selectors to try (untested):
 *   - 'button[data-action="contact"]'
 *   - 'button:has-text("השאר פרטים")'
 *   - 'input[name="contactPhone"]'
 *   - 'textarea[name="message"]'
 */
module.exports = async function yad1Handler(page, input) {
  return {
    success: false,
    error: 'yad1 handler not implemented yet',
    detail: 'Reverse-engineer contact form selectors from a real yad1 listing and replicate the madlan handler pattern.',
  };
};
