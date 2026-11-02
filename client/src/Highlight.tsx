import { searchTerms } from "./search";

const escaped = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with every case-insensitive occurrence of a word of `query` marked. */
export function Highlight({ text, query }: { text: string; query: string }) {
  const terms = searchTerms(query);
  if (!terms.length) return text;
  // Longest first, so that a word is not cut short by another that starts it.
  const pattern = [...terms].sort((a, b) => b.length - a.length).map(escaped);
  const parts = [];
  let from = 0;
  for (const match of text.matchAll(new RegExp(pattern.join("|"), "gi"))) {
    const at = match.index;
    parts.push(text.slice(from, at), <mark key={at}>{match[0]}</mark>);
    from = at + match[0].length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
