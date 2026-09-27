/**
 * Free-text span candidate extraction.
 *
 * Jev's Choice primitive selects between named alternatives — it cannot
 * verbatim-copy arbitrary text. Instead we find candidate spans with regex
 * and let Jev select which one (if more than one), then code normalizes the
 * verbatim span into the payload.
 *
 * Pool construction, in priority order, deduped, document order preserved:
 *   1. Quoted spans:  "..." '...' «...» “...” ‘...’
 *   2. Standalone email addresses
 *   3. Trigger captures (ES/EN): "name is John", "se llama Ana",
 *      "description: ...", "nota: ..." etc.
 *   4. Key–value pairs: "word: value" / "word = value"
 *   5. Clause segments: the input split on commas, semicolons and common
 *      ES/EN connectors (y/e/pero/but/and/then).
 */

const MAX_SPAN_CANDIDATES = 10;

const QUOTED_SPAN_REGEX =
  /"([^"\n]{1,200})"|'([^'\n]{1,200})'|«([^»\n]{1,200})»|“([^”\n]{1,200})”|‘([^’\n]{1,200})’/g;

// Direcciones de correo como candidatas de primera prioridad: sin esta
// captura, un email solo viaja dentro de la cláusula entera y los campos
// `para` de prefill reciben frases completas.
const EMAIL_SPAN_REGEX = /\b([^\s@"'“‘«]+@[^\s@"'“‘«]+\.[^\s@"'“‘«,;:!?!\n]+)\b/g;

// Los triggers de media (película/movie/...) NO disparan cuando el título
// ya va entrecomillado: los quoted spans ya lo capturan, y un candidato
// extra con la cola «'El padrino' de 1972» dispersa el selector.
const TRIGGER_SPAN_REGEX =
  /(mi nombre es|name is|se llama|named|called|description|comment|title|título|titulo|subject|nota|asunto|(?:película|pelicula|movie|film|serie)(?!\s*['"“‘«]))\s*[:=]?\s*([^,;.!?!\n]{1,200}?)(?=\s+(?:y|e|pero|but|and|then)\b\s+|[,;.!?!\n]|$)/gi;

const KEY_VALUE_SPAN_REGEX =
  /\b([A-Za-z_][A-Za-z0-9_]{0,30})\s*[:=]\s*([^,;.!?!\n]{1,200})/g;

const CLAUSE_SPLIT_REGEX = /[,;]|\s+(?:y|e|pero|but|and|then)\s+/gi;

const SURROUNDING_QUOTES: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["«", "»"],
  ["“", "”"],
  ["‘", "’"],
];

/** Strip one surrounding quote pair and trim the result. */
function unwrapQuotes(raw: string): string {
  const s = raw.trim();
  for (const [open, close] of SURROUNDING_QUOTES) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

/** Ordered candidate with its document position for stable dedupe. */
type SpanHit = { index: number; text: string };

function collect(
  regex: RegExp,
  text: string,
  pick: (m: RegExpExecArray) => string | undefined,
): SpanHit[] {
  const hits: SpanHit[] = [];
  for (const m of text.matchAll(regex)) {
    const raw = pick(m);
    if (raw === undefined) continue;
    const cleaned = unwrapQuotes(raw);
    if (cleaned === "") continue;
    hits.push({ index: m.index ?? 0, text: cleaned });
  }
  return hits;
}

/** First defined capture group (quoted-span alternatives, one group each). */
function firstDefined(m: RegExpExecArray): string | undefined {
  return m.slice(1).find((g) => g !== undefined);
}

/**
 * Returns ordered free-text candidates as cleaned verbatim spans, deduped,
 * document order preserved, capped at a safe pool size.
 */
export function spanCandidates(text: string): string[] {
  const hits: SpanHit[] = [
    ...collect(QUOTED_SPAN_REGEX, text, firstDefined),
    ...collect(EMAIL_SPAN_REGEX, text, firstDefined),
    ...collect(TRIGGER_SPAN_REGEX, text, (m) => m[2]),
    ...collect(KEY_VALUE_SPAN_REGEX, text, (m) => m[2]),
  ];

  const separator = new RegExp(CLAUSE_SPLIT_REGEX.source, CLAUSE_SPLIT_REGEX.flags);
  let last = 0;
  for (const m of text.matchAll(separator)) {
    const clause = text.slice(last, m.index);
    const cleaned = clause.trim();
    if (cleaned !== "") hits.push({ index: last, text: cleaned });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  const tailCleaned = tail.trim();
  if (tailCleaned !== "") hits.push({ index: last, text: tailCleaned });

  hits.sort((a, b) => a.index - b.index);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.text)) continue;
    seen.add(hit.text);
    out.push(hit.text);
    if (out.length >= MAX_SPAN_CANDIDATES) break;
  }
  return out;
}
