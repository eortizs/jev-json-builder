export {
  defineSchema,
  resolveDefined,
  enumField,
  scoreField,
  intField,
  numberField,
  DEFAULT_AMBIGUITY_THRESHOLD,
  DEFAULT_HAZARD_THRESHOLD,
  DEFAULT_HAZARD_QUESTION,
  DEFAULT_STATED_THRESHOLD,
  type Criteria,
  type Field,
  type FieldOptions,
  type Schema,
  type DefinedSchema,
  type SchemaConfig,
  type PayloadOf,
  type EnumField,
  type ScoreField,
  type IntField,
  type NumberField,
  type HazardConfig,
} from "./core/schema.js";

export {
  numericCandidates,
  candidateIndexFromKey,
} from "./core/candidates.js";

export {
  buildQuestions,
  isValidCandidateKey,
  type BuiltQuestions,
  type BuildQuestionsInput,
} from "./core/questions.js";

export {
  assemble,
  type AssembleOptions,
} from "./core/assemble.js";

export {
  evaluateGates,
  defaultGateOptions,
  type GateOptions,
} from "./core/gates.js";

export {
  JevBodyError,
  type JevErrorBody,
  type JevErrorCode,
  type GateKind,
  type FieldDiagnostic,
} from "./core/errors.js";

export type { AnswerMap, Answer, JevUsage, JevMeta } from "./core/types.js";

export {
  jevBody,
  getPayload,
  type JevBodyOptions,
} from "./express/jevBody.js";
