# Changelog

## [0.6.1](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.6.0...v0.6.1) (2026-11-06)


### Bug Fixes

* **build:** resolve fetch types in Vercel function builds ([#34](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/34)) ([aee06fa](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/aee06fa9527183bb2100b13033ee12d8d8f2a19c))

## [0.6.0](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.5.1...v0.6.0) (2026-11-06)


### Features

* **webhooks:** measure latency and bound response cleanup ([#32](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/32)) ([5b7a456](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/5b7a456c2dc35d4d985839ff971223892bbf6e92))

## [0.5.1](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.5.0...v0.5.1) (2026-11-05)


### Bug Fixes

* **telemetry:** standardize metadata fields to snake_case ([#30](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/30)) ([acd180d](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/acd180d8599dc39b8fa437347dc633fa578e1728))

## [0.5.0](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.4.0...v0.5.0) (2026-11-03)


### Features

* log webhook payload properties and outbound duration ([#27](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/27)) ([9f39ed8](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/9f39ed8770f48b925e583894b4565edb9d38900b))


### Bug Fixes

* **tests:** remove redundant console evidence output ([#29](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/29)) ([74fda6f](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/74fda6fba3bd57f3948b50535971c0908ac13de6))

## [0.4.0](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.3.2...v0.4.0) (2026-11-03)


### Features

* **posthog:** pass package version to getLogger scope ([#23](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/23)) ([cbbb78e](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/cbbb78eec25d70255cabb8ecac03baeeee612c9b))


### Bug Fixes

* **posthog:** finish telemetry exports with waitUntil ([#25](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/25)) ([dc680d3](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/dc680d37ff390dbea62c6b324bc7d408f07c17d3))

## [0.3.2](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.3.1...v0.3.2) (2026-11-02)


### Bug Fixes

* **posthog:** emit a webhook log and finish the export ([#20](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/20)) ([16f28f0](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/16f28f0e07e5cc02395e8e0b07ae7156e085d8c8))

## [0.3.1](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.3.0...v0.3.1) (2026-11-02)


### Bug Fixes

* satisfy the Vercel node builder typecheck ([#18](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/18)) ([d38181c](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/d38181c8b99034db20d846d520e4f25d0128af34))

## [0.3.0](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.2.1...v0.3.0) (2026-11-02)


### Features

* **posthog:** capture handled webhook exceptions ([#13](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/13)) ([1d0485d](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/1d0485d070fda52aa5787f6f303c0e7cfb5a83d6))
* **webhook:** make webhook telemetry pageable ([#17](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/17)) ([b727d68](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/b727d689f18ae26cdb71b601538044794903a935))
* **webhook:** record webhook_handled with a closed reason ([#16](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/16)) ([cae5867](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/cae58671ca8d17c4ed0f95d98faa3381948504dd))


### Bug Fixes

* add GPT Sol to pstack review panels ([#15](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/15)) ([0915975](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/091597573fe7652adb04ba677764d270a33b038c))

## [0.2.1](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.2.0...v0.2.1) (2026-10-31)


### Bug Fixes

* switch installs from npm to pnpm ([af22bbc](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/af22bbc12dde2ac12747009413589a2f693c0a33))
* switch installs from npm to pnpm ([#11](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/11)) ([af22bbc](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/af22bbc12dde2ac12747009413589a2f693c0a33))

## [0.2.0](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/compare/v0.1.0...v0.2.0) (2026-10-31)


### Features

* add optional PostHog client and Node.js logs setup ([#5](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/5)) ([3e574ce](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/3e574ce4163c085995a39f9c4ea63ff47f647e3f))
* AppFolio → Grok Bot webhook bridge ([#1](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/1)) ([4aacd82](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/4aacd82a4b703841625af8d8070552cafa485892))


### Bug Fixes

* configure Vercel for serverless api/ only ([28a06c9](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/28a06c9ed6ea6708b95169e4212cfd4ea1113f7a))
* Vercel serverless deploy without public/ ([#2](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/issues/2)) ([28a06c9](https://github.com/5amfung/appfolio-grokbot-webhook-bridge/commit/28a06c9ed6ea6708b95169e4212cfd4ea1113f7a))
