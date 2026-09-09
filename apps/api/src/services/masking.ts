// PII masking service — sanitizes text before sending to external AI APIs

const PII_PATTERNS: Array<{ pattern: RegExp; mask: string }> = [
  // Payment cards (Visa/Mastercard/MIR)
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, mask: '[CARD_NUMBER]' },
  // Russian passport
  { pattern: /\b[А-ЯA-Z]{2}\s?\d{7}\b/g, mask: '[PASSPORT]' },
  // Russian INN (tax ID) 10 or 12 digits
  { pattern: /\bИНН\s*:?\s*\d{10,12}\b/gi, mask: '[TAX_ID]' },
  // Russian SNILS
  { pattern: /\b\d{3}-\d{3}-\d{3}\s\d{2}\b/g, mask: '[SNILS]' },
  // Passwords (spoken phrases)
  { pattern: /\b(пароль|password|passwd)\s*:?\s*\S+/gi, mask: '[PASSWORD]' },
  // Russian phone numbers
  { pattern: /(?:\+7|8)[\s-]?\(?(\d{3})\)?[\s-]?(\d{3})[\s-]?(\d{2})[\s-]?(\d{2})/g, mask: '[PHONE]' },
  // CVV / CVC codes
  { pattern: /\b(?:cvv|cvc|cvv2|cvc2)\s*:?\s*\d{3,4}\b/gi, mask: '[CVV]' },
]

/**
 * Scans text and replaces sensitive data patterns with placeholders.
 * Runs synchronously — no async needed for regex operations.
 */
export function maskPII(text: string): string {
  let masked = text
  for (const { pattern, mask } of PII_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    masked = masked.replace(pattern, mask)
  }
  return masked
}
