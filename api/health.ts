import type { VercelRequest, VercelResponse } from "@vercel/node";
import { classifyConfigError, loadConfig } from "../src/config.js";

/**
 * GET /api/health
 * 200 { ok: true } when webhook config loads.
 * 500 { ok: false, reason } when it does not. The reason is a config token.
 */
export default function handler(
  _req: VercelRequest,
  res: VercelResponse,
): void {
  try {
    loadConfig();
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: classifyConfigError(err).reason,
    });
    return;
  }
  res.status(200).json({ ok: true });
}
