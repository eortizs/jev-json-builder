import express from "express";
import request from "supertest";

import {
  JevBodyError,
  getPayload,
  jevBody,
} from "../src/index.js";
import { ans, createMockClient } from "../src/testing/mockClient.js";
import { animationSchema, buildDemoApp, orderSchema, triageSchema } from "./server.js";

const app = express();
app.use(express.json());

app.post(
  "/api/animation",
  jevBody(animationSchema, {
    client: createMockClient({
      effect: ans.choice("fadein"),
      shape: ans.choice("square"),
      color: ans.choice("red"),
      sizePx_stated: ans.noul(0.95),
      _hazard: ans.noul(0.05),
    }),
  }),
  (req, res) => {
    res.json({ payload: getPayload(req, animationSchema), meta: req.jevMeta });
  },
);

app.post(
  "/api/triage",
  jevBody(triageSchema, {
    client: createMockClient({
      category: ans.choice("billing"),
      severity: ans.score(1.43, 1),
      frustration: ans.score(0.74, 1),
      refundRequested: ans.choice("yes"),
      amount_candidates: ans.choice("n1"),
      amount_stated: ans.noul(0.9),
      _hazard: ans.noul(0.05),
    }),
  }),
  (req, res) => {
    res.json({ payload: getPayload(req, triageSchema), meta: req.jevMeta });
  },
);

app.post(
  "/api/orders",
  jevBody(orderSchema, {
    client: createMockClient({
      product: ans.choice("laptop"),
      shipping: ans.choice("express"),
      giftWrap: ans.choice("yes"),
      giftWrap_stated: ans.noul(0.95),
      _hazard: ans.noul(0.05),
    }),
  }),
  (req, res) => {
    res.json({ payload: getPayload(req, orderSchema), meta: req.jevMeta });
  },
);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof JevBodyError) {
    return res.status(err.status).json(err.body);
  }
  return res.status(500).json({ error: "internal_error", message: (err as Error).message });
});

const anim = await request(app)
  .post("/api/animation")
  .send({
    prompt:
      "Dame la animación de un cuadrado que aparezca por fading de color rojo y que tenga un tamaño de 1200 píxeles.",
  });
console.log("ANIMATION", anim.status, anim.body.payload, `(${anim.body.meta.elapsedMs}ms)`);

const triage = await request(app)
  .post("/api/triage")
  .send({
    prompt:
      "I was charged twice for order #98423 and I want a refund of 49 dollars. This is the third time I'm writing in.",
  });
console.log("TRIAGE", triage.status, triage.body.payload, `(${triage.body.meta.elapsedMs}ms)`);

const orders = await request(app)
  .post("/api/orders")
  .send({
    prompt: "Quiero pedir 2 laptops con envío express y que venga envuelto para regalo",
  });
console.log("ORDERS", orders.status, orders.body.payload, `(${orders.body.meta.elapsedMs}ms)`);

const demoApp = buildDemoApp();
const health = await request(demoApp).get("/healthz");
const playground = await request(demoApp).get("/playground");
console.log(
  "PLAYGROUND",
  health.status,
  playground.status,
  playground.text.includes("Jev JSON Builder") ? "html ok" : "html missing",
);