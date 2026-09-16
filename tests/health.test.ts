import { describe, expect, it } from "vitest";
import handler from "../api/health.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";

function mockRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as VercelResponse;
  return { res, state };
}

describe("GET /api/health", () => {
  it("returns 200 { ok: true }", () => {
    const { res, state } = mockRes();
    handler({} as VercelRequest, res);
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({ ok: true });
  });
});
