# Changelog

## [1.6.0](https://github.com/databricks-solutions/mason/compare/v1.5.1...v1.6.0) (2026-09-23)


### Features

* add ask_user built-in tool for inline clarification ([98fa81c](https://github.com/databricks-solutions/mason/commit/98fa81cbd104f0391a91053e2d7fdee6e5c9ccb4))
* add ask_user built-in tool for inline clarification ([0881e34](https://github.com/databricks-solutions/mason/commit/0881e341088fd333a908ecb19e00e16be1c06c67))
* add one-line installer script for macOS ([6f8e832](https://github.com/databricks-solutions/mason/commit/6f8e832ada34f8175e592655d00311d8fc691e71))
* **ask_user:** batch multiple questions; fix Gemini array content ([0a89880](https://github.com/databricks-solutions/mason/commit/0a898806907fbb7741c1e424591c4473429d95a4))
* auto-launch OAuth login on profile switch when token is missing ([be0f762](https://github.com/databricks-solutions/mason/commit/be0f762b9ef269fa5f48ab4f2483f64ce8d8eb6a))
* auto-launch OAuth login on profile switch when token is missing ([e8141e3](https://github.com/databricks-solutions/mason/commit/e8141e353b7128e397aa80409f01d5e2977f4510))
* **chat:** Anthropic prompt caching for tools + system messages ([015c140](https://github.com/databricks-solutions/mason/commit/015c140273ed5e074d5b55fa45742ed06ef4a3be))
* **chat:** random "thinking" phrases; hide label once streaming starts ([773efaf](https://github.com/databricks-solutions/mason/commit/773efafc77aa0d2c3cbc57e7b21cf980c2b6a19b))
* **chat:** render markdown progressively during streaming ([2021a0e](https://github.com/databricks-solutions/mason/commit/2021a0e33ffe16834ee5d6cb888651b911242067))
* **chat:** render markdown progressively during streaming ([2542a7c](https://github.com/databricks-solutions/mason/commit/2542a7cdc3bc0ac7510c7465ba02ee2aadede5c3))
* **chat:** stream responses even when tools are attached ([c09d287](https://github.com/databricks-solutions/mason/commit/c09d28719fc7b9de14cdf28410c960457b9080f1))
* **chat:** stream responses even when tools are attached ([8ffc2a7](https://github.com/databricks-solutions/mason/commit/8ffc2a79a4c3622679ca1effc941a2652f09755f))
* convert settings modal to full-pane view ([f9f5bbe](https://github.com/databricks-solutions/mason/commit/f9f5bbe06d185617098fdf02570c31ea2e112c68))
* dark mode toggle in Settings, aligned with Auto-load MCP tools ([afe8240](https://github.com/databricks-solutions/mason/commit/afe8240d4c35170430fb43915cf68362f8d6de54))
* derive AI Gateway from workspace host, drop config field ([5c0f88a](https://github.com/databricks-solutions/mason/commit/5c0f88a3e628843b289b41357b1939cb134c3a24))
* **designer:** Agentic Workflow Designer ([f071835](https://github.com/databricks-solutions/mason/commit/f071835bf0624d3ca9c9035e0d2c91cfffc8f894))
* **designer:** agentic workflow designer — canvas, cells, edges, engine ([3d7c441](https://github.com/databricks-solutions/mason/commit/3d7c44192edff88c23f6b1f04fd303533f2456b3))
* **designer:** visible, configurable feedback-loop caps + convergence pressure ([dab9a1a](https://github.com/databricks-solutions/mason/commit/dab9a1adcd67f538a4b98a681d94c5a3d00e2356))
* **devkit:** tag MCP spawn env with Mason upstream attribution ([a5bd1ef](https://github.com/databricks-solutions/mason/commit/a5bd1ef0a04cc20e177007d4c39ff01163f19195))
* global system prompt in Settings ([1a10229](https://github.com/databricks-solutions/mason/commit/1a1022927a54c6b27750457d7af6259e72968a7f))
* hide OS title bar, render window controls inline (mac + win) ([df3a9c2](https://github.com/databricks-solutions/mason/commit/df3a9c28001a2536fbd4709d3a316f4f8f9d8782))
* hide OS title bar, render window controls inline (mac + win) ([9c6f9b2](https://github.com/databricks-solutions/mason/commit/9c6f9b2d600a97e92de3c00d459eda4c173f7bbd))
* in-app "Update now" button — installer runs detached, app relaunches ([d0c1946](https://github.com/databricks-solutions/mason/commit/d0c19461b6758537cfb95eb1847780a806fcc271))
* in-app update checker + sidebar version label ([62fdc73](https://github.com/databricks-solutions/mason/commit/62fdc736f41054a56541241398ac94f3e793b17e))
* **mcp:** respawn profile-bound stdio servers on profile switch ([c524582](https://github.com/databricks-solutions/mason/commit/c524582a1c20f6f62247ea60322026609d5d4369))
* messages ([3814204](https://github.com/databricks-solutions/mason/commit/38142044a3e333b23550b391ab0d3e1ff40f5e22))
* optional Databricks AI Dev Kit MCP integration ([a309154](https://github.com/databricks-solutions/mason/commit/a309154b1135ed145427c7e49cec543fc856ff35))
* skills — user-authored on-demand instruction bundles ([8c4716f](https://github.com/databricks-solutions/mason/commit/8c4716f47ca8c19bdbc081ffec23358b29e49cb7))
* skills — user-authored on-demand instruction bundles, model-agnostic ([8d658ec](https://github.com/databricks-solutions/mason/commit/8d658ec775b3b2629a267ac9f208f409a14652b8))
* **sync:** automate app schema grant as a postdeploy bundle hook ([ff66e95](https://github.com/databricks-solutions/mason/commit/ff66e959851af2eb9028dbc560a7c5fbb9cb4546))
* **sync:** phase 2 — server-side turns, web composer, turn lock, desktop merge ([4aff44c](https://github.com/databricks-solutions/mason/commit/4aff44caf4681e6d9a0acf174a912d9455d8c03b))
* **sync:** session sync phase 1 — mason-sync server, desktop mirror mode, mobile viewer ([ff2e5b1](https://github.com/databricks-solutions/mason/commit/ff2e5b1b8ce8951b44836ab2e82419823a0d2233))
* zero-touch onboarding — auto-install CLI, URL-only profile setup ([3f21369](https://github.com/databricks-solutions/mason/commit/3f213697354e138c94635a04c0601b3dadf5502f))


### Bug Fixes

* atomic app swap during update; relaunch via absolute path ([a176708](https://github.com/databricks-solutions/mason/commit/a176708e5feae66987b953c531acee83152932cf))
* atomic app swap during update; relaunch via absolute path ([3a8dc06](https://github.com/databricks-solutions/mason/commit/3a8dc0626c011097c720b917afc8ff9f3580dbc9))
* **chat:** cross-model compatibility + add model-sweep regression suite ([1c9e0d6](https://github.com/databricks-solutions/mason/commit/1c9e0d6020545a828527adabc82472e9530b750f))
* **chat:** drop orphan tool results from trimHistory output ([48574a6](https://github.com/databricks-solutions/mason/commit/48574a68f619818b66b97d63e842857cc3127ceb))
* **chat:** flatten array-shaped delta.content in SSE stream ([4082ec8](https://github.com/databricks-solutions/mason/commit/4082ec8998413e4daaea2cd2e9897ebc1aa164ee))
* **chat:** keep "Building…" visible below streaming text ([1d2dbd9](https://github.com/databricks-solutions/mason/commit/1d2dbd9c3c80713934df5c4cc8de539e499db8a8))
* **chat:** log streamed usage once (final), not per chunk ([2d27179](https://github.com/databricks-solutions/mason/commit/2d27179f7940445dd5e619121eb585f4192209fc))
* **chat:** normalize empty streamed tool_call arguments to "{}" ([c33723e](https://github.com/databricks-solutions/mason/commit/c33723eb6ccdae6954f1bfa4830e5b82b6469a59))
* **chat:** raise agent-loop budget 10 -&gt; 40 + surface clear stop reason ([a9c4921](https://github.com/databricks-solutions/mason/commit/a9c4921e0c15d21cdcb6e8e6e162710362b1d7f1))
* **chat:** sanitize truncated/malformed tool_call arguments to "{}" ([f645360](https://github.com/databricks-solutions/mason/commit/f645360b239ed3486211a8ab29a10df013f70571))
* **chat:** surface streaming usage so cache hits are visible in logs ([e01789f](https://github.com/databricks-solutions/mason/commit/e01789fbdf38fcc7701be0e7ed46422323917679))
* **chat:** token-aware holdback eliminates raw-markdown blip ([3cd47dc](https://github.com/databricks-solutions/mason/commit/3cd47dccb1348809528932a28bd1d36a22a51dee))
* clearer error when AI Gateway isn't enabled ([3c8f031](https://github.com/databricks-solutions/mason/commit/3c8f031fe4889c95addd18bc5df6edb189eb2940))
* **devkit:** restore profile pinning, use shellEnv for stdio spawn ([ede7c04](https://github.com/databricks-solutions/mason/commit/ede7c043768ad8105fb483f83200a4cfcaa65ca7))
* hide unenabled endpoints; tolerate stale saved-model in history ([0669e5a](https://github.com/databricks-solutions/mason/commit/0669e5a16154bc5dadad02294d1806f3055230bf))
* **install:** don't killall Dock during install ([56391f4](https://github.com/databricks-solutions/mason/commit/56391f489f7726aba62fc5337c4917c40d6567db))
* keep "Building…" indicator visible during tool calls + recover from empty responses ([bae87bf](https://github.com/databricks-solutions/mason/commit/bae87bfc47b6f76c3eb00611e2769c4d0d3d8391))
* keep "Building…" visible during tool calls + recover from empty responses ([c1fda4c](https://github.com/databricks-solutions/mason/commit/c1fda4ce97bd6bb4e4540e7a12618636b30bea5b))
* **mcp:** auto-authorize UC connections when proxy returns JSON-RPC auth error ([45b83eb](https://github.com/databricks-solutions/mason/commit/45b83eb2f4ed90a052ca62d2babaf8b7da2d82d7))
* **mcp:** auto-authorize UC connections when proxy returns JSON-RPC auth error ([4875a44](https://github.com/databricks-solutions/mason/commit/4875a4485af22bc3d52769c0c45594d13219cbd4))
* **mcp:** only list UC HTTP connections where is_mcp_connection=true ([34c5399](https://github.com/databricks-solutions/mason/commit/34c539953e2ee59a30b73018aae7d046e16865c3))
* **mcp:** only use directHost shortcut for Databricks App hosts ([a65a4d0](https://github.com/databricks-solutions/mason/commit/a65a4d00ba1b79c92d5f2c4a4b833390f541ef3c))
* **mcp:** self-heal stale UC URLs from workspace config ([d99030e](https://github.com/databricks-solutions/mason/commit/d99030e995e0f04bcc2a17996799257e63276d11))
* **mcp:** split saveMcpConfig so HTTP add doesn't clobber stdio entries ([12252dd](https://github.com/databricks-solutions/mason/commit/12252dd98bfb147cf144c1891ebc8b28884e2d4e))
* persist app preferences to ~/.mason/config/settings.json ([bc1731c](https://github.com/databricks-solutions/mason/commit/bc1731c0101381b66a4d744934004d8ee5ca7508))
* refresh icon cache after install ([a358f23](https://github.com/databricks-solutions/mason/commit/a358f23eb9bca7da8c5c60ba977f7c46d33d2fc0))
* render sidebar version before profile/MCP boot ([df9a353](https://github.com/databricks-solutions/mason/commit/df9a353eb31809293a2dabb05f5e3b37f1f7341d))
* robust DMG mount/detach in install.sh ([4bfe54c](https://github.com/databricks-solutions/mason/commit/4bfe54cbd9d5be1844a1a7524bddb1d1b99e0f79))
* route each model to its supported API (chat vs responses) ([4766dc1](https://github.com/databricks-solutions/mason/commit/4766dc1805c866ee5fc23c833dcea4c52fe4db62))
* support tool calling across both Chat and Responses APIs ([2e1db3d](https://github.com/databricks-solutions/mason/commit/2e1db3ddd27065dc93bc278e29b5a6cffa2b0e86))
* **sync:** app-runtime fixes from live deploy — host scheme, bootstrap retry ([7cecf11](https://github.com/databricks-solutions/mason/commit/7cecf113dddb0534ace6b937e5d1ed28e8e47e36))
* **sync:** deploy config — app-only bundle, sync excludes, control-plane db id ([624b7e7](https://github.com/databricks-solutions/mason/commit/624b7e74d2dd6bd8c8c6f7a0b065d26667e01874))
* **version:** use document.getElementById, not the closure-scoped el ([05bd1fa](https://github.com/databricks-solutions/mason/commit/05bd1fa5db03f9a821232cd05ffe5284a2d6616c))
* **win:** lazy-load pdf-parse to avoid DOMMatrix crash at startup ([3b754d8](https://github.com/databricks-solutions/mason/commit/3b754d8456d92116466c247655821f41eeebde78))
* **win:** lazy-load pdf-parse to avoid DOMMatrix crash at startup ([713bb2c](https://github.com/databricks-solutions/mason/commit/713bb2c2ef7348928319ed93230307edef814aaf))


### Refactoring

* **chat:** extract shared agent-loop primitives into agent-runner.ts ([d9406fd](https://github.com/databricks-solutions/mason/commit/d9406fdcd7bc319af4e5c62c0f7f6e9808d69738))


### Documentation

* add model-selection demo gif to README ([32080e1](https://github.com/databricks-solutions/mason/commit/32080e1fad16b082da3097144057ab9c83c26221))
* add Workflow Designer section + screenshot to README ([c68449d](https://github.com/databricks-solutions/mason/commit/c68449d6c8dca018a58d6285927a63636dbb14d2))
* **spec:** session sync phase 1 — Databricks App server, desktop mirror mode, mobile viewer ([cc25488](https://github.com/databricks-solutions/mason/commit/cc2548845f1466ab91988b860fcac6a7b97a4731))
* **spec:** session sync phases 2 and 3 — server-side turns, runner tier (laptop + lakebox) ([3dfdb18](https://github.com/databricks-solutions/mason/commit/3dfdb18ea789c0f123a2668ee3d20e760facbd9b))
* swap README demo gif to higher-resolution capture ([be9d15a](https://github.com/databricks-solutions/mason/commit/be9d15a2ae4a5c9abf213efe330b43836b69b0c6))
* **win:** one-line PowerShell installer + README section ([c75f8bd](https://github.com/databricks-solutions/mason/commit/c75f8bd348e6fcede1c3f176cb521b5ffd89b402))
