# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Documentation

- `stringField`: new "Pool truncation caveat" note — the span pool caps at 10 candidates in document order, so trailing fragments of long, noisy texts never reach the `<name>_candidates` choice question; includes mitigation guidance (quoted spans / explicit `key: value` phrasing, splitting long texts).
- `jevRouter`: "Planned: `singleCall: true`" design sketch added to the latency note — feasibility (valid merged question map), answers-level assembly refactor, hazard policy merge (single `_hazard` at the stricter threshold), `RouteDecision` contract preservation, COMPLEX token trade-off, and opt-in rollout plan.

## [0.2.1] - 2026-09-27

### Fixed

- **Gates: candidate selectors are now gated.** `evaluateGates` ignored the `<name>_candidates` choice answers that carry the real value for `int`/`number`/`string`/`date` fields with 2+ candidates — a selector with confidence 0.35 sailed into assembly below the schema threshold. Candidate selectors are now gated with the same per-field threshold (`fieldThresholds[field] ?? ambiguityThreshold`) and reported in `jev_ambiguous` diagnostics as `<name>_candidates`.
- **`jevRouter`: construction-time validation of `fastDestination`/`fallbackDestination`.** Passing custom `destinations` without the `FAST_JSON_PAYLOAD` label (and without an explicit `fastDestination`) previously made every request fall through to `onComplex` silently; the middleware now throws at construction when either resolved label is not a key of `destinations` (same style as the `semanticRouter` `fallbackDestination` check).
- `semanticRouter`: removed the dead `fastDestination` local computed from `destinations` (only `jevRouter` resolves the fast label, from options).
- `prepare: "tsc"` script — installing from git now compiles `dist/` automatically.

## [0.2.0] - 2026-09-27

### Added

- **Free-text fields — `stringField`.** Shared span pool extracted from the input (quoted spans `" ' « “ ‘`, ES/EN trigger phrases such as *se llama / mi nombre es / description / nota*, key–value pairs, clause segments), deduped and capped at 10. One candidate is used verbatim; two or more generate a `<name>_candidates` `choice` selector.
- **Date/time fields — `dateField`.** Regex candidates for ISO (`2026-09-27`, `2026-09-27T15:00`, `2026-09-27 15:00`), numeric (`27/09/2026`, `27-09-26`), times (`15:00`, `3pm`, `3:30 pm`), relative days (`hoy`/`today`, `mañana`/`tomorrow`, `pasado mañana`, `next monday`/`próximo lunes`, bare weekdays) and combined forms (`mañana a las 3pm`, `next monday 10:00`). Deterministic ISO-8601 normalizer (`YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` when a time is present) with an injectable `now` clock (new `now` option on `jevBody` / `runJevPipeline`). Weekday rules: `next X` = strictly after today; bare `X` = nearest upcoming (today counts). Out-of-range calendar/clock parts raise the new `422 jev_invalid_date` error code.
- **NestJS decorators** behind the new `jev-json-builder/nest` subpath: `@JevBody(spec, options)` (interceptor running the same pipeline) and `@JevPayload(spec?)` (typed parameter decorator). `JevBodyError`s rethrow as `HttpException(err.body, err.status)`. `@nestjs/common` is an **optional** peer dependency (`>=9`); Express-only consumers never load it. Decorators require the standard Nest compiler options (`experimentalDecorators` + `emitDecoratorMetadata`), and `@JevPayload` must always be used with parentheses.
- **`runJevPipeline(text, spec, options)`** — transport-agnostic core extracted from `jevBody` and shared with the Nest interceptor; usable directly from workers/CLIs. Returns `{ payload, meta }`, throws `JevBodyError` on every failure path.
- **Ingest mapping**: free-text `string` (OpenAPI/JSON Schema) and Prisma `String` now map to `stringField`; `format: "date-time" | "date" | "time"` and Prisma `DateTime` map to `dateField` (taking precedence over the string mapping). Diagnostics report the heuristics; arrays/objects/`Json` scalars remain skipped.
- **Demo**: `POST /api/leads` route (`leadSchema`: `name`/`complaint` as `stringField`, `followUpAt` as `dateField`) plus a leads block in `demo/smoke.ts`.
- **Exports**: `spanCandidates`, `extractDateCandidates`, `normalizeDate`, `validateDateParts`, `runJevPipeline`, `stringField`, `dateField` (and the `StringField` / `DateField` types).

### Changed

- `jevBody` is now thin Express glue over `runJevPipeline`; middleware behavior is unchanged (all pre-existing tests pass untouched).
- `BuiltQuestions` gains `spanCandidates` and `dateCandidates` pools; `AssembleOptions` gains optional `spanCandidates`, `dateCandidates` and `now`.

### Test suite

- 82 → 124 tests: new `tests/spans.test.ts`, `tests/dates.test.ts`, `tests/fields.test.ts` and a full `@nestjs/testing` + supertest roundtrip in `tests/nest.test.ts`; ingest and CLI expectations updated for the new mappings.

## [0.1.0] - 2026-09-26

### Added

- Express middleware `jevBody(spec)` + `getPayload(req, spec)` with dual gates (hazard `noul` + confidence ambiguity), schema DSL with `PayloadOf<S>` inference, pre-parsed numeric candidates, optional-field `*_stated` omission, `onReject` fallback, `req.jevMeta`, interactive playground, three demo domains, and a benchmark harness (JJB vs generative LLM, mock + live modes).
- Semantic router `jevRouter` / `semanticRouter` with `FAST_JSON_PAYLOAD` / `COMPLEX_LLM_AGENT` destinations, confidence fallback, perimeter hazard gate, and System Two `onComplex` handoff.
- Schema ingestion CLI `jjb-ingest` from OpenAPI 3.x / Swagger 2.0 / JSON Schema / Prisma (Zod via JSON Schema conversion), with `x-jev-*` vendor extensions and diagnostics.
