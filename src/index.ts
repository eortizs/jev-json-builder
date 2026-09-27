export {
  defineSchema,
  resolveDefined,
  enumField,
  scoreField,
  intField,
  numberField,
  stringField,
  dateField,
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
  type StringField,
  type DateField,
  type HazardConfig,
} from "./core/schema.js";

export {
  numericCandidates,
  candidateIndexFromKey,
} from "./core/candidates.js";

export { spanCandidates } from "./core/spans.js";

export {
  extractDateCandidates,
  normalizeDate,
  validateDateParts,
  type NormalizedDate,
} from "./core/dates.js";

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
  runJevPipeline,
  type JevPipelineOptions,
  type JevPipelineResult,
} from "./core/pipeline.js";

export {
  jevBody,
  getPayload,
  type JevBodyOptions,
} from "./express/jevBody.js";

export {
  jevRouter,
  getRouteDecision,
  type JevRouterOptions,
} from "./express/jevRouter.js";

export {
  semanticRouter,
  isFastRoute,
  DEFAULT_ROUTE_DESTINATIONS,
  DEFAULT_ROUTE_THRESHOLD,
  DEFAULT_FALLBACK_DESTINATION,
  DEFAULT_FAST_DESTINATION,
  type RouteDecision,
  type RouteDestinations,
  type SemanticRouterOptions,
} from "./core/router.js";

export {
  ingest,
  detectFormat,
  ingestOpenApi,
  ingestOpenApiSchema,
  ingestPrisma,
  ingestPrismaModel,
  parsePrisma,
  jsonSchemaToSchema,
  resolveNode,
  resolveJsonPointer,
  renderSchemaSource,
  renderSchemaSources,
  exportNameFor,
  toCamelIdent,
  defaultQuestion,
  type IngestFormat,
  type IngestOptions,
  type IngestDiagnostic,
  type IngestOutput,
  type JsonSchemaNode,
  type JsonSchemaToSchemaOptions,
  type JsonSchemaToSchemaResult,
  type OpenApiIngestOptions,
  type PrismaIngestOptions,
  type RenderOptions,
  type SchemaSource,
} from "./ingest/index.js";
