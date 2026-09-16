/**
 * Env config parsed once at cold start (module load).
 * Secrets stay in Vercel env — never commit them.
 */
export type BridgeConfig = {
  grokBotWebhookUrl: URL;
  grokBotBearerToken: string;
  appfolioJwksUrl: URL;
};

const DEFAULT_APPFOLIO_JWKS_URL =
  "https://api.appfolio.com/.well-known/jwks.json";

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const webhook = env.GROK_BOT_WEBHOOK_URL;
  const token = env.GROK_BOT_BEARER_TOKEN;
  if (!webhook) {
    throw new Error("GROK_BOT_WEBHOOK_URL is required");
  }
  if (!token) {
    throw new Error("GROK_BOT_BEARER_TOKEN is required");
  }
  return {
    grokBotWebhookUrl: new URL(webhook),
    grokBotBearerToken: token,
    appfolioJwksUrl: new URL(
      env.APPFOLIO_JWKS_URL ?? DEFAULT_APPFOLIO_JWKS_URL,
    ),
  };
}
