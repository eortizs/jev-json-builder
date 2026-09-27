/**
 * Naming and question-text helpers shared by the ingest converters.
 */

export type QuestionKind = "enum" | "boolean" | "int" | "number" | "score" | "string" | "date";

function camelWord(word: string): string {
  return word.charAt(0).toLowerCase() + word.slice(1);
}

function pascalWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** `CreateOrder` / `post_/orders` -> `createOrder` / `postOrders`. */
export function toCamelIdent(raw: string): string {
  const parts = raw
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "schema";
  const [first, ...rest] = parts;
  let out = camelWord(first!) + rest.map(pascalWord).join("");
  if (/^[0-9]/.test(out)) out = `n${out}`;
  return out;
}

/** `CreateOrder` -> `createOrderSchema` (idempotent on the `Schema` suffix). */
export function exportNameFor(raw: string): string {
  const base = toCamelIdent(raw);
  return /Schema$/.test(base) ? base : `${base}Schema`;
}

export function defaultQuestion(name: string, kind: QuestionKind): string {
  switch (kind) {
    case "enum":
      return `Which value of "${name}" does the user specify?`;
    case "boolean":
      return `Does the user want "${name}"?`;
    case "int":
    case "number":
      return `What number does the user specify for "${name}"?`;
    case "score":
      return `What level of "${name}" does the user express?`;
    case "string":
      return `What text does the user specify for "${name}"?`;
    case "date":
      return `What date or time does the user specify for "${name}"?`;
  }
}

export function valueKey(value: unknown): string {
  return String(value);
}