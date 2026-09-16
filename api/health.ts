import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * GET /api/health → 200 { ok: true }
 */
export default function handler(
  _req: VercelRequest,
  res: VercelResponse,
): void {
  res.status(200).json({ ok: true });
}
