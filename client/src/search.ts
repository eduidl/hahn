/** The lowercase words of a search. Empty for a blank search. */
export const searchTerms = (search: string) => search.toLowerCase().split(/\s+/).filter(Boolean);

/** Whether `text` contains every term, in any order. */
export function matchesTerms(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
}
