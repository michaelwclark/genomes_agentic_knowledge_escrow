/**
 * Write-time redaction of lending PII so teammates can paste Jira/Slack/email
 * content into memory without leaking borrower SSNs, card numbers, routing
 * numbers, account numbers, or dates of birth into the ledger or any
 * downstream substrate.
 *
 * Detectors run in a fixed order: unambiguous formatted patterns (card,
 * routing-by-checksum, EIN, dashed SSN) before context-gated bare-digit
 * patterns (account, bare SSN). Each replacement is `[REDACTED:<name>]`,
 * which contains no digits, so a later detector can never re-match text an
 * earlier detector already redacted.
 */

export interface RedactionPattern {
  name: string;
  pattern: RegExp;
}

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

const CONTEXT_WINDOW = 25;

function hasContextKeyword(text: string, matchStart: number, keywords: RegExp): boolean {
  const windowStart = Math.max(0, matchStart - CONTEXT_WINDOW);
  return keywords.test(text.slice(windowStart, matchStart));
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (alternate) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    alternate = !alternate;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const ABA_WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7, 1];

function abaChecksumValid(digits: string): boolean {
  if (digits.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(digits[i]) * ABA_WEIGHTS[i]!;
  return sum % 10 === 0;
}

/** Not preceded or followed by another digit/letter/hyphen — guards against
 * matching inside a longer hex token (UUID) or an adjacent longer number. */
const NOT_ADJACENT_TO_ALNUM_BEFORE = '(?<![0-9A-Za-z])';
const NOT_ADJACENT_TO_ALNUM_AFTER = '(?![0-9A-Za-z])';

function redactCard(text: string, counts: Record<string, number>): string {
  const pattern = new RegExp(`${NOT_ADJACENT_TO_ALNUM_BEFORE}(?:\\d[ -]?){13,19}${NOT_ADJACENT_TO_ALNUM_AFTER}`, 'g');
  return text.replace(pattern, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnValid(digits)) return match;
    counts['card'] = (counts['card'] ?? 0) + 1;
    return '[REDACTED:card]';
  });
}

const ROUTING_KEYWORDS = /routing|\baba\b|\brtn\b/i;

function redactRouting(text: string, counts: Record<string, number>): string {
  const pattern = new RegExp(`${NOT_ADJACENT_TO_ALNUM_BEFORE}\\d{9}${NOT_ADJACENT_TO_ALNUM_AFTER}`, 'g');
  return text.replace(pattern, (match, offset: number) => {
    if (!abaChecksumValid(match)) return match;
    if (!hasContextKeyword(text, offset, ROUTING_KEYWORDS)) return match;
    counts['routing'] = (counts['routing'] ?? 0) + 1;
    return '[REDACTED:routing]';
  });
}

function redactEin(text: string, counts: Record<string, number>): string {
  const pattern = new RegExp(`${NOT_ADJACENT_TO_ALNUM_BEFORE}\\d{2}-\\d{7}${NOT_ADJACENT_TO_ALNUM_AFTER}`, 'g');
  return text.replace(pattern, () => {
    counts['ein'] = (counts['ein'] ?? 0) + 1;
    return '[REDACTED:ein]';
  });
}

function redactSsnDashed(text: string, counts: Record<string, number>): string {
  const pattern = new RegExp(`${NOT_ADJACENT_TO_ALNUM_BEFORE}\\d{3}-\\d{2}-\\d{4}${NOT_ADJACENT_TO_ALNUM_AFTER}`, 'g');
  return text.replace(pattern, () => {
    counts['ssn'] = (counts['ssn'] ?? 0) + 1;
    return '[REDACTED:ssn]';
  });
}

const ACCOUNT_KEYWORDS = /acct|account|\ba\/c\b|\ba\.c\.?\b/i;
// Cloud/technical account identifiers ("AWS account 123456789012", "GCP
// service account", "Azure account") are not lending PII and must not be
// redacted — they're routine in engineering chat and tickets.
const CLOUD_ACCOUNT_KEYWORDS = /\b(?:aws|gcp|azure|service)\b/i;

function redactAccount(text: string, counts: Record<string, number>): string {
  const pattern = new RegExp(`${NOT_ADJACENT_TO_ALNUM_BEFORE}\\d{6,17}${NOT_ADJACENT_TO_ALNUM_AFTER}`, 'g');
  return text.replace(pattern, (match, offset: number) => {
    // Skip "123456.7" shaped version-number-like text: a bare digit run
    // immediately followed by a dot and another digit.
    const after = text.slice(offset + match.length, offset + match.length + 2);
    if (/^\.\d/.test(after)) return match;
    if (!hasContextKeyword(text, offset, ACCOUNT_KEYWORDS)) return match;
    if (hasContextKeyword(text, offset, CLOUD_ACCOUNT_KEYWORDS)) return match;
    counts['account'] = (counts['account'] ?? 0) + 1;
    return '[REDACTED:account]';
  });
}

const SSN_KEYWORDS = /ssn|social/i;

function redactSsnBare(text: string, counts: Record<string, number>): string {
  const pattern = new RegExp(`${NOT_ADJACENT_TO_ALNUM_BEFORE}\\d{9}${NOT_ADJACENT_TO_ALNUM_AFTER}`, 'g');
  return text.replace(pattern, (match, offset: number) => {
    if (!hasContextKeyword(text, offset, SSN_KEYWORDS)) return match;
    counts['ssn'] = (counts['ssn'] ?? 0) + 1;
    return '[REDACTED:ssn]';
  });
}

const DOB_KEYWORDS = /dob|date of birth/i;
const DATE_PATTERN = /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}/g;

function redactDob(text: string, counts: Record<string, number>): string {
  return text.replace(DATE_PATTERN, (match, offset: number) => {
    if (!hasContextKeyword(text, offset, DOB_KEYWORDS)) return match;
    counts['dob'] = (counts['dob'] ?? 0) + 1;
    return '[REDACTED:dob]';
  });
}

export function redactSensitive(text: string, extra: RedactionPattern[] = []): RedactionResult {
  const counts: Record<string, number> = {};
  let result = text;
  result = redactCard(result, counts);
  result = redactRouting(result, counts);
  result = redactEin(result, counts);
  result = redactSsnDashed(result, counts);
  result = redactAccount(result, counts);
  result = redactSsnBare(result, counts);
  result = redactDob(result, counts);
  for (const { name, pattern } of extra) {
    // Rebuild with the global flag: a caller-supplied pattern without `g`
    // would make String#replace substitute only the first match.
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    result = result.replace(globalPattern, () => {
      counts[name] = (counts[name] ?? 0) + 1;
      return `[REDACTED:${name}]`;
    });
  }
  return { text: result, counts };
}
