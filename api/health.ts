import type { VercelRequest, VercelResponse } from "@vercel/node";
import { classifyConfigError, loadConfig } from "../src/config.js";

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
