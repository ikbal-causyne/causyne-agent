/*
 * Copyright (c) 2026 Causyne.
 * SPDX-License-Identifier: BUSL-1.1
 *
 * Anti-AI Slop & Humanization Compliance Auditor.
 * Enforces authentic human cadence, strict hyphenation rules, and zero ungrounded placeholders.
 */

export interface SlopAuditFinding {
  rule: string;
  severity: 'error' | 'warning';
  match: string;
  line?: number;
  message: string;
}

export interface ArithmeticItem {
  name: string;
  volume: number;
  frequency: number;
  unitPrice: number;
  total: number;
}

export interface ArithmeticCategory {
  code: string;
  name: string;
  items: ArithmeticItem[];
  subtotal?: number;
}

export interface ArithmeticBudgetSpec {
  categories: ArithmeticCategory[];
  grossUpTaxRate?: number; // e.g. 0.025 for 2.5% PPh 21
  targetGross?: number;
}

const BANNED_LONG_DASHES = /[—–]/g;

const AI_SLOP_CLICHES_ID = [
  /\bsangatlah\b/i,
  /\btak terbantahkan\b/i,
  /\brevolusioner\b/i,
  /\bgame[- ]?changer\b/i,
  /\bdi era yang serba\b/i,
  /\bmari kita\b/i,
  /\btidak dapat dipungkiri\b/i,
  /\bperlu diingat bahwa\b/i,
  /\bdalam lanskap modern\b/i,
  /\bmerupakan sebuah bukti nyata\b/i
];

const AI_SLOP_CLICHES_EN = [
  /\bdelve(?:s|d|ing)?\b/i,
  /\bcrucial(?:ly)?\b/i,
  /\btestament\b/i,
  /\btapestry\b/i,
  /\bgame[- ]?changer\b/i,
  /\brevolutionize(?:d|s|ing)?\b/i,
  /\bin conclusion\b/i,
  /\bit is important to remember\b/i,
  /\bbeacon\b/i,
  /\bfoster(?:s|ing)?\b/i,
  /\bunderscore(?:s|d|ing)?\b/i,
  /\bspearhead(?:ed|ing)?\b/i,
  /\brealm\b/i,
  /\bparamount\b/i,
  /\bholistic approach\b/i
];

const PLACEHOLDER_BRACKETS = [
  /\[(?:insert|masukkan|isi|tbd|todo|placeholder|nama|tanggal|lokasi)[^\]]*\]/i,
  /<(?:insert|masukkan|isi|tbd|todo|placeholder)[^>]*>/i
];

/**
 * Scan raw text or HTML content for AI slop, long em-dashes, and placeholder tokens.
 */
export function auditTextContent(content: string, options: { language?: 'id' | 'en' | 'both'; strictDashes?: boolean } = {}): {
  clean: boolean;
  findings: SlopAuditFinding[];
} {
  const findings: SlopAuditFinding[] = [];
  const lines = (content || '').split(/\r?\n/);
  const lang = options.language || 'both';
  const strictDashes = options.strictDashes !== false;

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    // 1. Long em-dash check (enforce short hyphen -)
    if (strictDashes) {
      const dashMatches = line.match(BANNED_LONG_DASHES);
      if (dashMatches) {
        findings.push({
          rule: 'no_long_em_dash',
          severity: 'error',
          match: dashMatches[0] || '—',
          line: lineNum,
          message: 'Found long em-dash (—/–). Use standard short hyphen (-) to preserve natural human typing rhythm.'
        });
      }
    }

    // 2. Placeholder checks
    for (const pat of PLACEHOLDER_BRACKETS) {
      const m = line.match(pat);
      if (m) {
        findings.push({
          rule: 'no_ungrounded_placeholders',
          severity: 'error',
          match: m[0],
          line: lineNum,
          message: `Found ungrounded template placeholder "${m[0]}". Must be replaced with verified real data.`
        });
      }
    }

    // 3. AI Slop Cliches (ID)
    if (lang === 'id' || lang === 'both') {
      for (const pat of AI_SLOP_CLICHES_ID) {
        const m = line.match(pat);
        if (m) {
          findings.push({
            rule: 'anti_ai_slop_phrase_id',
            severity: 'warning',
            match: m[0],
            line: lineNum,
            message: `Found formulaic AI phrase "${m[0]}". Rewrite in authentic, direct human voice.`
          });
        }
      }
    }

    // 4. AI Slop Cliches (EN)
    if (lang === 'en' || lang === 'both') {
      for (const pat of AI_SLOP_CLICHES_EN) {
        const m = line.match(pat);
        if (m) {
          findings.push({
            rule: 'anti_ai_slop_phrase_en',
            severity: 'warning',
            match: m[0],
            line: lineNum,
            message: `Found generic AI trope "${m[0]}". Replace with concrete, factual language.`
          });
        }
      }
    }
  });

  return {
    clean: findings.filter((f) => f.severity === 'error').length === 0,
    findings
  };
}

/**
 * Audit arithmetic integrity across line items, category subtotals, and gross-up taxes.
 */
export function auditBudgetArithmetic(spec: ArithmeticBudgetSpec): {
  valid: boolean;
  itemErrors: string[];
  categoryErrors: string[];
  totalCalculated: number;
  grossCalculated?: number | undefined;
  taxCalculated?: number | undefined;
  differenceFromTarget?: number | undefined;
} {
  const itemErrors: string[] = [];
  const categoryErrors: string[] = [];
  let grandTotal = 0;

  for (const cat of spec.categories) {
    let catComputedSubtotal = 0;

    for (const item of cat.items) {
      const expectedItemTotal = item.volume * item.frequency * item.unitPrice;
      if (Math.round(expectedItemTotal) !== Math.round(item.total)) {
        itemErrors.push(
          `Item "${item.name}" math mismatch: ${item.volume} * ${item.frequency} * ${item.unitPrice} = ${expectedItemTotal}, but recorded total is ${item.total}`
        );
      }
      catComputedSubtotal += item.total;
    }

    if (cat.subtotal !== undefined && Math.round(cat.subtotal) !== Math.round(catComputedSubtotal)) {
      categoryErrors.push(
        `Category "${cat.name}" subtotal mismatch: items sum to ${catComputedSubtotal}, but recorded subtotal is ${cat.subtotal}`
      );
    }

    grandTotal += catComputedSubtotal;
  }

  let grossCalculated: number | undefined;
  let taxCalculated: number | undefined;
  let differenceFromTarget: number | undefined;

  if (spec.grossUpTaxRate !== undefined) {
    const divisor = 1 - spec.grossUpTaxRate;
    grossCalculated = Math.round(grandTotal / divisor);
    taxCalculated = grossCalculated - grandTotal;

    if (spec.targetGross !== undefined) {
      differenceFromTarget = grossCalculated - spec.targetGross;
    }
  }

  const valid = itemErrors.length === 0 && categoryErrors.length === 0 && (differenceFromTarget === undefined || differenceFromTarget === 0);

  return {
    valid,
    itemErrors,
    categoryErrors,
    totalCalculated: grandTotal,
    grossCalculated,
    taxCalculated,
    differenceFromTarget
  };
}
