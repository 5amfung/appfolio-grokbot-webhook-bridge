import type { IncomingMessage } from "node:http";

/**
 * Buffer the Node request stream into a Uint8Array.
 * Used when Vercel bodyParser is disabled so verify + forward see identical bytes.
 */
export async function readRawBody(
  req: IncomingMessage,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
