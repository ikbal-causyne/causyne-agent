/**
 * Causyne Agent — word-level relevance for tool and skill discovery.
 *
 * Substring matching made short query words hit unrelated entries ("and"
 * inside "command", "kill" inside "skill", "git" inside "digit"), so one
 * capability search could unlock a dozen irrelevant tool schemas. Matching is
 * done on whole words with a bounded prefix rule instead. Deterministic,
 * synchronous, linear-time, and never compiles user-supplied patterns.
 */

/** English function words and search meta-words that carry no capability signal. */
const STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'these', 'those',
  'using', 'use', 'via', 'any', 'all', 'are', 'was', 'were', 'can', 'how', 'what', 'which',
  'when', 'where', 'who', 'why', 'you', 'your', 'our', 'its', 'not', 'but', 'has', 'have',
  'should', 'would', 'could', 'please', 'about', 'also', 'then', 'than', 'them', 'they',
  'there', 'some', 'more', 'most', 'each', 'other', 'only', 'own', 'same', 'such', 'very',
  'just', 'like', 'need', 'want', 'help', 'let', 'get', 'take', 'out', 'over', 'under', 'per',
  'capability', 'capabilities', 'matching'
]);

/** Upper bound on distinct query terms, so scoring cost stays constant. */
export const MAX_RELEVANCE_TERMS = 16;

/**
 * Lower-case text and fold British -ise/-isation spellings onto -ize/-ization
 * so "optimisation" and "optimization" compare equal. Applied identically to
 * queries and catalog text.
 */
export function normalizeSpelling(text: string): string {
  return text.toLowerCase().replace(/is(ations?|ing|ed|es|e)\b/g, 'iz$1');
}

/** Distinct meaningful query terms: alphanumeric words longer than two characters. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const word of normalizeSpelling(String(query || '')).split(/[^a-z0-9]+/)) {
    if (word.length <= 2 || STOPWORDS.has(word) || terms.includes(word)) continue;
    terms.push(word);
    if (terms.length >= MAX_RELEVANCE_TERMS) break;
  }
  return terms;
}

/** Whole words of catalog text, splitting snake_case, kebab-case and camelCase names. */
export function wordsOf(text: string): Set<string> {
  const spaced = String(text || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return new Set(normalizeSpelling(spaced).split(/[^a-z0-9]+/).filter(word => word.length > 0));
}

/**
 * A term matches a word exactly, or as a bounded stem: "build" matches
 * "builds"/"builder", and "screenshots" matches "screenshot". Short words
 * never match as a fragment of a longer one.
 */
export function termMatches(term: string, words: Set<string>): boolean {
  if (words.has(term)) return true;
  for (const word of words) {
    if (term.length >= 4 && word.startsWith(term)) return true;
    if (word.length >= 4 && term.startsWith(word) && term.length - word.length <= 3) return true;
  }
  return false;
}

/**
 * Minimum number of distinct query terms an entry must match. A multi-word
 * capability description is not satisfied by an entry that shares only one
 * generic word with it (for example "build" in "android build optimization").
 */
export function requiredCoverage(termCount: number): number {
  return termCount >= 3 ? 2 : 1;
}
