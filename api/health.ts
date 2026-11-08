import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkDependencies } from "../src/check-dependencies.js";
import { classifyConfigError, loadConfig } from "../src/config.js";

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    res.status(500).json({
      ok: false,
      reason: classifyConfigError(err).reason,
    });
    return;
  }
  const checks = await checkDependencies(config);
  if (!checks.appfolio_jwks.ok || !checks.grok_bot.ok) {
    res.status(503).json({
      ok: false,
      reason: "dependency_unavailable",
      checks,
    });
    return;
  }
  res.status(200).json({ ok: true });
}
