/**
 * Internal typed views over Jev's response. We keep the casts confined
 * to the assemble boundary (and this file) so the rest of the code can
 * use typed records.
 */

export type AnswerMap = Record<string, Answer>;

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> }
  | { type: "noul"; noul: number };

export type JevUsage = {
  input_tokens: number;
  output_tokens: number;
};

export type JevMeta = {
  model: string;
  answers: AnswerMap;
  usage: JevUsage | undefined;
  elapsedMs: number;
};
