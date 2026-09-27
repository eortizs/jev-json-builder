/**
 * NestJS entry point (`jev-json-builder/nest`).
 *
 * Importing this module requires `@nestjs/common` (optional peer).
 * Schema/field constructors come from the root entry point; only the
 * decorator glue lives here so Express-only consumers never load Nest.
 */

export { JevBody, JevPayload, type JevNestOptions, type JevHttpRequest } from "./jevNest.js";
