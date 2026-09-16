# appfolio-grokbot-webhook-bridge

Thin HTTPS verify-and-forward for AppFolio webhooks → Grok Bot.

AppFolio signs with detached JWS (`X-JWS-Signature`, PS256). Grok Bot expects `Authorization: Bearer crsr_…`. This service verifies AppFolio, then forwards the raw JSON body to the Bot webhook URL.

Deploy target: Vercel (CI deploys on merge to `main`). Custom domain required so AppFolio’s company-owned-domain rule is satisfied.
