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

const MISSING_WEBHOOK_URL = "GROK_BOT_WEBHOOK_URL is required";
const MISSING_BEARER_TOKEN = "GROK_BOT_BEARER_TOKEN is required";
const MISCONFIGURED = "misconfigured";

export type ConfigReason =
  | "config_missing_webhook_url"
  | "config_missing_bearer_token"
  | "config_invalid_url"
  | "config_misconfigured";

export function classifyConfigError(err: unknown): {
  message: string;
  reason: ConfigReason;
} {
  if (err instanceof Error && err.message === MISSING_WEBHOOK_URL) {
    return { message: err.message, reason: "config_missing_webhook_url" };
  }
  if (err instanceof Error && err.message === MISSING_BEARER_TOKEN) {
    return { message: err.message, reason: "config_missing_bearer_token" };
  }
  if (err instanceof TypeError) {
    return { message: err.message, reason: "config_invalid_url" };
  }
  if (err instanceof Error) {
    return { message: err.message, reason: "config_misconfigured" };
  }
  return { message: MISCONFIGURED, reason: "config_misconfigured" };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const webhook = env.GROK_BOT_WEBHOOK_URL;
  const token = env.GROK_BOT_BEARER_TOKEN;
  if (!webhook) {
    throw new Error(MISSING_WEBHOOK_URL);
  }
  if (!token) {
    throw new Error(MISSING_BEARER_TOKEN);
  }
  return {
    grokBotWebhookUrl: new URL(webhook),
    grokBotBearerToken: token,
    appfolioJwksUrl: new URL(
      env.APPFOLIO_JWKS_URL ?? DEFAULT_APPFOLIO_JWKS_URL,
    ),
  };
}
