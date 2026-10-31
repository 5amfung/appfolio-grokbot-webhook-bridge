import type { IncomingMessage } from "node:http";

/**
 * Buffer the Node request into a Uint8Array.
 *
 * Listen for `data` and `end` instead of `for await`. `vercel dev` reads the
 * body in its request helper, then replays those same bytes only through
 * those two events. Async iteration sees the already-ended stream and returns
 * nothing, which breaks detached JWS verification locally.
 */
export async function readRawBody(
  req: IncomingMessage,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const fail = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err instanceof Error ? err : new Error("raw body read failed"));
    };
    req.on("end", finish);
    req.on("error", fail);
    req.on("aborted", () => {
      fail(new Error("request aborted while reading the raw body"));
    });
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
  });
  return new Uint8Array(Buffer.concat(chunks));
}
