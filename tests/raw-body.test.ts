import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readRawBody } from "../src/raw-body.js";

/**
 * Mirrors @vercel/node's dev-server restoreBody: the helper consumes the
 * request, then replays the buffer through data/end only.
 */
function restoreLikeVercelDev(req: Readable, body: Buffer): void {
  const replicateBody = new PassThrough();
  const on = replicateBody.on.bind(replicateBody);
  const originalOn = req.on.bind(req);
  req.read = replicateBody.read.bind(replicateBody) as typeof req.read;
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "data" || event === "end") {
      return on(event, listener);
    }
    return originalOn(event, listener);
  }) as typeof req.on;
  replicateBody.write(body);
  replicateBody.end();
}

describe("readRawBody", () => {
  it("reads a stream that has not been consumed", async () => {
    const payload = Buffer.from('{"a":1, "b":2}');
    const req = Readable.from([payload]);
    const raw = await readRawBody(req as unknown as IncomingMessage);
    expect(Buffer.from(raw)).toEqual(payload);
  });

  it("reads bytes replayed on data/end after vercel dev consumed the stream", async () => {
    const payload = Buffer.from(
      '{"client_id":"verify-client", "event_id":"x"}',
    );
    const req = Readable.from([payload]);
    const drained: Buffer[] = [];
    for await (const chunk of req) {
      drained.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(drained)).toEqual(payload);

    restoreLikeVercelDev(req, payload);
    const raw = await readRawBody(req as unknown as IncomingMessage);
    expect(Buffer.from(raw)).toEqual(payload);
  });
});
