/**
 * Build a `TypeSafeClient` whose `systemOne` returns a canned answers map.
 *
 * Tests can use this to validate every gate path without making a real
 * network call. The mock intercepts the SDK's internal fetch and resolves
 * with a synthesized response body.
 */

import { TypeSafeClient, type ChoiceQuestion, type NoulQuestion, type ScoreQuestion } from "@typesafe-ai/sdk";

import type { Answer, AnswerMap } from "../core/types.js";

export type MockAnswers = Record<string, Answer | undefined>;

type AnswersInput = MockAnswers | ((questions: Record<string, unknown>, state: unknown) => MockAnswers);

function normalizeToAnswerMap(raw: MockAnswers): AnswerMap {
  const out: AnswerMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v) out[k] = v;
  }
  return out;
}

function pickAnswer(
  questionId: string,
  question: unknown,
  state: unknown,
  script: AnswersInput,
): Answer | undefined {
  const answers = typeof script === "function" ? script({ [questionId]: question }, state) : script;
  return answers[questionId];
}

function findCandidatesById(
  body: unknown,
): { id: string; question: ChoiceQuestion | NoulQuestion | ScoreQuestion | undefined }[] {
  const q = (body as { questions?: Record<string, ChoiceQuestion | NoulQuestion | ScoreQuestion> } | undefined)?.questions;
  if (!q) return [];
  return Object.entries(q).map(([id, question]) => ({ id, question }));
}

export function createMockClient(script: AnswersInput): TypeSafeClient {
  const fetchImpl: typeof fetch = async (_url, init) => {
    let body: unknown = undefined;
    try {
      body = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      body = undefined;
    }
    const state = (body as { state?: unknown } | undefined)?.state;
    const answers: AnswerMap = {};
    for (const { id, question } of findCandidatesById(body)) {
      const a = pickAnswer(id, question, state, script);
      if (a) answers[id] = a;
    }
    const payload = {
      model: "mock-jev",
      answers,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  // TypeSafeClient accepts a custom fetch in its config.
  return new TypeSafeClient({
    apiKey: "mock-key",
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
  });
}

/** Helper constructors for answer objects. */
export const ans = {
  choice: (choice: string, confidence = 1, probabilities?: Record<string, number>): Answer => ({
    type: "choice",
    choice,
    confidence,
    probabilities: probabilities ?? { [choice]: 1 },
  }),
  score: (score: number, confidence = 1, probabilities?: Record<string, number>): Answer => ({
    type: "score",
    score,
    confidence,
    legend: {},
    probabilities: probabilities ?? { "0": 1 },
  }),
  noul: (noul: number): Answer => ({ type: "noul", noul }),
};
