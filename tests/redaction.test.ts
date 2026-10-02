import { describe, expect, it } from 'vitest';
import { redactSensitive } from '../src/redaction.js';

describe('redactSensitive', () => {
  it('redacts a dashed SSN', () => {
    const result = redactSensitive('Borrower SSN 123-45-6789 on file.');
    expect(result.text).toBe('Borrower SSN [REDACTED:ssn] on file.');
    expect(result.counts['ssn']).toBe(1);
  });

  it('redacts a bare 9-digit SSN only when ssn/social context is nearby', () => {
    const withContext = redactSensitive("Applicant's SSN is 123456789 for the loan.");
    expect(withContext.text).toContain('[REDACTED:ssn]');

    const withoutContext = redactSensitive('The warehouse processed 123456789 units last quarter.');
    expect(withoutContext.text).toContain('123456789');
    expect(withoutContext.counts['ssn'] ?? 0).toBe(0);
  });

  it('redacts an EIN', () => {
    const result = redactSensitive('Employer EIN 12-3456789 for tax filing.');
    expect(result.text).toBe('Employer EIN [REDACTED:ein] for tax filing.');
    expect(result.counts['ein']).toBe(1);
  });

  it('redacts a Luhn-valid card number with separators', () => {
    const result = redactSensitive('Card on file: 4000-0000-0000-0002 expires soon.');
    expect(result.text).toBe('Card on file: [REDACTED:card] expires soon.');
    expect(result.counts['card']).toBe(1);
  });

  it('does not redact a Luhn-invalid digit run of card length', () => {
    const result = redactSensitive('Reference number 4000000000000099 was logged.');
    expect(result.text).toContain('4000000000000099');
    expect(result.counts['card'] ?? 0).toBe(0);
  });

  it('redacts a checksum-valid routing number near routing context', () => {
    const result = redactSensitive('Please wire to routing number 021000021 today.');
    expect(result.text).toBe('Please wire to routing number [REDACTED:routing] today.');
    expect(result.counts['routing']).toBe(1);
  });

  it('does not redact a 9-digit number that fails the ABA checksum even with routing context', () => {
    const result = redactSensitive('The routing number 123456789 was rejected.');
    expect(result.text).toContain('123456789');
    expect(result.counts['routing'] ?? 0).toBe(0);
  });

  it('redacts an account number near account context', () => {
    const result = redactSensitive('Please debit account 5551234567 for the fee.');
    expect(result.text).toBe('Please debit account [REDACTED:account] for the fee.');
    expect(result.counts['account']).toBe(1);
  });

  it('does not redact a bare digit run with no account/ssn/routing context', () => {
    const result = redactSensitive('We shipped 5551234567 widgets this year.');
    expect(result.text).toContain('5551234567');
  });

  it('does not redact an AWS account id', () => {
    const result = redactSensitive('AWS account 123456789012 owns that bucket.');
    expect(result.text).toContain('123456789012');
    expect(result.counts['account'] ?? 0).toBe(0);
  });

  it('does not redact a GCP account id', () => {
    const result = redactSensitive('The GCP account 987654321098 was suspended.');
    expect(result.text).toContain('987654321098');
    expect(result.counts['account'] ?? 0).toBe(0);
  });

  it('does not redact an Azure account id', () => {
    const result = redactSensitive('Azure account 112233445566 billing alert.');
    expect(result.text).toContain('112233445566');
    expect(result.counts['account'] ?? 0).toBe(0);
  });

  it('does not redact a service account id', () => {
    const result = redactSensitive('The service account 556677889900 was rotated.');
    expect(result.text).toContain('556677889900');
    expect(result.counts['account'] ?? 0).toBe(0);
  });

  it('does not treat "laws" as an "aws" cloud-account false negative', () => {
    // "laws" contains the substring "aws" but must not suppress redaction of
    // a genuine lending account number near "account" context.
    const result = redactSensitive('Per the laws governing this account 5551234567.');
    expect(result.text).toBe('Per the laws governing this account [REDACTED:account].');
    expect(result.counts['account']).toBe(1);
  });

  it('still redacts a plain lending account number (positive control)', () => {
    const result = redactSensitive('Please update account 12345678 on the loan file.');
    expect(result.text).toBe('Please update account [REDACTED:account] on the loan file.');
    expect(result.counts['account']).toBe(1);
  });

  it('redacts a date of birth near DOB context', () => {
    const result = redactSensitive('DOB: 01/02/1990 for the applicant.');
    expect(result.text).toBe('DOB: [REDACTED:dob] for the applicant.');
    expect(result.counts['dob']).toBe(1);
  });

  it('redacts a date of birth written as "date of birth"', () => {
    const result = redactSensitive('Applicant date of birth is 1990-01-02.');
    expect(result.text).toBe('Applicant date of birth is [REDACTED:dob].');
    expect(result.counts['dob']).toBe(1);
  });

  it('does not redact an ISO date with no DOB context', () => {
    const result = redactSensitive('Deployed on 2026-10-01 to production.');
    expect(result.text).toContain('2026-10-01');
    expect(result.counts['dob'] ?? 0).toBe(0);
  });

  it('does not redact a UUID', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const result = redactSensitive(`Trace id ${uuid} for the request.`);
    expect(result.text).toContain(uuid);
  });

  it('does not redact a semantic version number', () => {
    const result = redactSensitive('Upgraded to version 1.2.3456789 of the library.');
    expect(result.text).toContain('1.2.3456789');
  });

  it('does not redact a Jira-style ticket key', () => {
    const result = redactSensitive('See ACME-1234 for the related ticket.');
    expect(result.text).toContain('ACME-1234');
  });

  it('applies org-specific extra patterns and counts every match', () => {
    const result = redactSensitive('Loan LN-12345678 and loan LN-87654321 were linked.', [
      { name: 'loan_number', pattern: /LN-\d{8}/ }
    ]);
    expect(result.text).toBe('Loan [REDACTED:loan_number] and loan [REDACTED:loan_number] were linked.');
    expect(result.counts['loan_number']).toBe(2);
  });
});
