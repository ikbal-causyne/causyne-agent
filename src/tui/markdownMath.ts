/**
 * Terminal LaTeX Math Normalizer.
 *
 * Converts inline (`$...$`, `\(...\)`) and display (`$$...$$`, `\[...\]`) LaTeX
 * math notation into clean, human-readable Unicode mathematical notation for
 * terminal rendering, while preserving currency (`$100`), shell variables
 * (`$HOME`), and code spans untouched.
 */

const GREEK_AND_SYMBOLS: Readonly<Record<string, string>> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'π',
  rho: 'ρ',
  varrho: 'ρ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  varnothing: '∅',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  simeq: '≃',
  cong: '≅',
  propto: '∝',
  times: '×',
  cdot: '·',
  cdots: '⋯',
  ldots: '…',
  dots: '…',
  pm: '±',
  mp: '∓',
  div: '÷',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  iff: '⇔',
  implies: '⇒',
  mapsto: '↦',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  sum: '∑',
  prod: '∏',
  int: '∫',
  oint: '∮',
  oplus: '⊕',
  otimes: '⊗',
  perp: '⊥',
  parallel: '∥',
  angle: '∠',
  circ: '∘',
  degree: '°',
  ell: 'ℓ',
  hbar: 'ℏ',
  Re: 'ℜ',
  Im: 'ℑ'
};

const FUNCTION_MACROS = new Set([
  'min', 'max', 'sup', 'inf', 'lim', 'limsup', 'liminf',
  'log', 'ln', 'lg', 'exp',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth',
  'det', 'dim', 'ker', 'deg', 'gcd', 'Pr', 'arg', 'bmod', 'mod',
  'argmin', 'argmax', 'tr', 'rank', 'diag', 'cov', 'var'
]);

const SUPERSCRIPT_DIGITS: Readonly<Record<string, string>> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹'
};

/**
 * Convert the interior of a LaTeX math expression into readable terminal text.
 */
export function renderLatexExpression(rawExpr: string): string {
  if (typeof rawExpr !== 'string') return '';
  let out = rawExpr.trim();
  if (!out) return '';

  // 1. Unwrap text/font macros (\text{...}, \mathrm{...}, \operatorname{...}, etc.)
  const textMacroRe = /\\(?:text|textbf|textit|textrm|texttt|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|operatorname)\*?\s*\{([^{}]*)\}/g;
  for (let pass = 0; pass < 4 && textMacroRe.test(out); pass++) {
    out = out.replace(textMacroRe, '$1');
  }

  // 2. Convert \frac{a}{b} and \sqrt{x}
  const fracRe = /\\(?:d|t)?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g;
  for (let pass = 0; pass < 3 && fracRe.test(out); pass++) {
    out = out.replace(fracRe, (_m, num: string, den: string) => {
      const n = num.trim();
      const d = den.trim();
      const nSimple = /^[a-zA-Z0-9_α-ωΑ-Ω]+$/.test(n);
      const dSimple = /^[a-zA-Z0-9_α-ωΑ-Ω]+$/.test(d);
      return `${nSimple ? n : `(${n})`}/${dSimple ? d : `(${d})`}`;
    });
  }

  const sqrtRe = /\\sqrt\s*\{([^{}]+)\}/g;
  for (let pass = 0; pass < 3 && sqrtRe.test(out); pass++) {
    out = out.replace(sqrtRe, (_m, inner: string) => {
      const trimmed = inner.trim();
      return /^[a-zA-Z0-9_α-ωΑ-Ω]+$/.test(trimmed) ? `√${trimmed}` : `√(${trimmed})`;
    });
  }

  // 3. Strip sizing and spacing directives
  out = out
    .replace(/\\(?:left|right|big|Big|bigg|Bigg|[bB]igl|[bB]igr|limits|nolimits|displaystyle|textstyle)\b\s*/g, '')
    .replace(/\\(?:quad|qquad)\b/g, ' ')
    .replace(/\\[,;:!]/g, ' ')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}')
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_');

  // 4. Replace named functions and Greek/math symbols
  out = out.replace(/\\([a-zA-Z]+)(\s*)/g, (full, name: string, trailingSpace: string) => {
    if (FUNCTION_MACROS.has(name)) {
      return name + (trailingSpace || '');
    }
    const sym = Object.hasOwn(GREEK_AND_SYMBOLS, name) ? GREEK_AND_SYMBOLS[name] : undefined;
    if (sym !== undefined) {
      // Preserve a space if the symbol is a binary relation/operator and had trailing space,
      // or if the next character would otherwise run into an operator.
      return sym + (trailingSpace.length > 0 && /^[∈∉⊂⊆⊃⊇∪∩≤≥≠≈≡∼≃≅∝×·±∓÷→←↔⇒⇐⇔↦]$/.test(sym) ? ' ' : '');
    }
    return full;
  });

  // 5. Simplify braced subscripts and superscripts
  out = out
    .replace(/_\{([a-zA-Z0-9α-ωΑ-Ω+-]+)\}/g, '_$1')
    .replace(/_\{([^{}]+)\}/g, '_($1)')
    .replace(/\^\{([0-9])\}/g, (_m, d: string) => SUPERSCRIPT_DIGITS[d] ?? `^${d}`)
    .replace(/\^([23])(?![0-9])/g, (_m, d: string) => SUPERSCRIPT_DIGITS[d] ?? `^${d}`)
    .replace(/\^\{([a-zA-Z0-9α-ωΑ-Ω+-]+)\}/g, '^$1')
    .replace(/\^\{([^{}]+)\}/g, '^($1)');

  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Determine whether the content between single `$ ... $` delimiters is genuine
 * mathematical notation rather than currency or prose between two prices.
 */
function isLikelyInlineMath(inner: string): boolean {
  const trimmed = inner.trim();
  if (!trimmed || trimmed.length > 160) return false;

  // Plain currency/number ($100, $19.99, $50k) or shell variable ($HOME)
  if (/^\d+(?:[.,]\d+)*[kKmMbB]?$/.test(trimmed)) return false;
  if (/^[A-Z_][A-Z0-9_]{1,30}$/.test(trimmed)) return false;

  // Starts with digits followed by ordinary prose words (e.g. "$100 today and $200")
  if (/^\d+(?:[.,]\d+)?\s+[a-z]{2,}\b/i.test(trimmed) && !/\\[a-zA-Z]+|[=<>≤≥∈]/.test(trimmed)) {
    return false;
  }

  // Contains any LaTeX command, subscript/superscript, or mathematical relation/operator
  if (/\\[a-zA-Z]+/.test(trimmed)) return true;
  if (/[_^]/.test(trimmed)) return true;
  if (/[=<>≤≥≠≈∈±×÷]/.test(trimmed)) return true;

  // Single math variable ($x$, $s$, $N$) or bracketed interval/tuple ($[0, 1]$, $(x, y)$)
  if (/^[a-zA-Z]$/.test(trimmed)) return true;
  if (/^[\[(][0-9a-zA-Z.,\s+-]+[\])]$/.test(trimmed)) return true;
  if (/^[a-zA-Z0-9_]+\s*[+\-*/]\s*[a-zA-Z0-9_]+/.test(trimmed)) return true;

  return false;
}

/**
 * Format LaTeX math spans inside a markdown prose line (after code spans and
 * links have already been stashed).
 */
export function formatMarkdownMath(text: string): string {
  if (typeof text !== 'string' || !text || (!text.includes('$') && !text.includes('\\'))) {
    return typeof text === 'string' ? text : '';
  }

  let out = text;

  // 1. Display math $$...$$ (disjoint alternation prevents polynomial ReDoS)
  out = out.replace(/\$\$((?:[^$\\]|\\[\s\S]|\$(?!\$))+?)\$\$/g, (_m, expr: string) => renderLatexExpression(expr));

  // 2. Explicit LaTeX delimiters \[...\] and \(...\)
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, expr: string) => renderLatexExpression(expr));
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, expr: string) => renderLatexExpression(expr));

  // 3. Inline math $...$
  out = out.replace(/(?<![\\$\w])\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?![$\d])/g, (full, expr: string) => {
    if (!isLikelyInlineMath(expr)) return full;
    return renderLatexExpression(expr);
  });

  // 4. Unescape literal \$ that the author escaped for markdown
  out = out.replace(/\\\$/g, '$');

  return out;
}

