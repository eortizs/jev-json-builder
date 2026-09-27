/**
 * NestJS glue for the shared JJB pipeline (`jev-json-builder/nest`).
 *
 * `@JevBody(spec, options)` is a method decorator backed by a Nest
 * interceptor that runs `runJevPipeline` on the request's natural-language
 * input and exposes the typed payload on `req.jev` / `req.jevMeta`.
 * `@JevPayload(spec?)` is a parameter decorator that injects the typed
 * payload into your handler.
 *
 * `JevBodyError`s are rethrown as `HttpException(err.body, err.status)` so
 * Nest's exception layer renders the JSON diagnostics body. This module is
 * only reachable via the `jev-json-builder/nest` subpath — Express-only
 * consumers never load `@nestjs/*`.
 *
 * Requires standard Nest compiler options in your tsconfig:
 * `experimentalDecorators` + `emitDecoratorMetadata`.
 */

import {
  applyDecorators,
  createParamDecorator,
  HttpException,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";

import { JevBodyError } from "../core/errors.js";
import { runJevPipeline, type JevPipelineOptions } from "../core/pipeline.js";
import type { PayloadOf, Schema } from "../core/schema.js";

/** Minimal structural view of the HTTP request we need (Express or Fastify). */
export type JevHttpRequest = {
  body?: unknown;
  jev?: unknown;
  jevMeta?: unknown;
};

export type JevNestOptions = Omit<JevPipelineOptions, "onGateReject"> & {
  /** Custom input extractor. Default: req.body?.prompt || req.body?.text. */
  input?: (req: JevHttpRequest) => string | undefined;
};

function defaultInput(req: JevHttpRequest): string | undefined {
  const body = req.body as { prompt?: unknown; text?: unknown } | undefined;
  if (!body) return undefined;
  if (typeof body.prompt === "string") return body.prompt;
  if (typeof body.text === "string") return body.text;
  return undefined;
}

function toHttpException(err: unknown): unknown {
  if (err instanceof JevBodyError) {
    return new HttpException(err.body, err.status);
  }
  return err;
}

class JevBodyInterceptor<S extends Schema> implements NestInterceptor {
  constructor(
    private readonly spec: S,
    private readonly options: JevNestOptions,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<JevHttpRequest>();
    try {
      const text = (this.options.input ?? defaultInput)(req);
      const { payload, meta } = await runJevPipeline(text ?? "", this.spec, {
        ...this.options,
      });
      req.jev = payload;
      req.jevMeta = meta;
      return next.handle();
    } catch (err) {
      throw toHttpException(err);
    }
  }
}

/**
 * Method decorator: runs the JJB pipeline before the route handler and
 * stores the typed payload on the request for `@JevPayload()`.
 */
export function JevBody<const S extends Schema>(spec: S, options: JevNestOptions = {}) {
  return applyDecorators(UseInterceptors(new JevBodyInterceptor(spec, options)));
}

/**
 * Parameter decorator: injects the typed payload built by `@JevBody`.
 * The optional `spec` argument is purely for type inference.
 */
export function JevPayload<const S extends Schema>(_spec?: S) {
  return createParamDecorator((_data: unknown, ctx: ExecutionContext): PayloadOf<S> => {
    const req = ctx.switchToHttp().getRequest<JevHttpRequest>();
    if (req.jev === undefined) {
      throw new Error("JevPayload used before the JevBody interceptor ran.");
    }
    return req.jev as PayloadOf<S>;
  })();
}
