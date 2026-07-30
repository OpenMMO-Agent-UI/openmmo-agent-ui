# Redesign onboarding around connection profiles and manual/AI play modes

## Problem Statement

The desktop flow puts connection configuration behind Google sign-in even though the game server, terrain origin, and OAuth2 credentials form one inseparable **connection profile**. Players can begin authenticating against the wrong server before they can correct it. The character screen then mixes character management, LLM configuration, and connection fields, and entering the game requires a redundant Play action.

The game screen is AI-only: it renders a spectator view of `agent-client` and cannot hand control to the player. Timing controls expose raw seconds without explaining their effect, LLM changes apply piecemeal, and restart behavior is scattered across the UI.

Release construction has the same ownership problem. The desktop repository expects an external OpenMMO checkout on the correct spectator branch while injecting additional spectator sources from an overlay. A release tag therefore does not identify one reproducible OpenMMO dependency.

## Solution

Replace the entry flow with four clear stages:

1. Select and validate a connection profile.
2. Complete Google OAuth2 only when that profile lacks a valid credential.
3. Select or create a character through the Electron-owned **pre-flight session**.
4. Enter the game immediately, defaulting to AI automatic play when the global LLM configuration is valid and falling back to manual play when it is not.

Ship an immutable `openmmo.to.nexus` profile and support full CRUD for custom profiles. Isolate profile credentials, accounts, and last-character state. Add a real manual controller to the embedded OpenMMO client and a top-right hand/robot mode switch. Treat each mode change as a transactional session handoff with exactly one controller.

Consolidate LLM controls into one global configuration with staged validation and human-readable cadence sliders. Make the customized public OpenMMO fork an exact, pinned submodule dependency and build unsigned artifacts from it in GitHub Actions.

## User Stories

1. As a player, I want to select a server before signing in, so that authentication uses the matching connection profile.
2. As a player, I want `openmmo.to.nexus` available as a built-in profile, so that the official server works without setup.
3. As a player, I want the built-in profile immutable, so that I cannot destroy the known-good configuration.
4. As a player, I want to duplicate the built-in profile, so that I can use it as a custom-server starting point.
5. As a player, I want full CRUD for custom connection profiles, so that I can use multiple OpenMMO servers.
6. As a server operator, I want the WebSocket endpoint and Google OAuth2 credentials stored together, so that incompatible values cannot be mixed accidentally.
7. As a player, I want terrain origin derived from the WebSocket URL, so that normal setup does not require two related URLs.
8. As a server operator, I want an advanced terrain-origin override, so that nonstandard deployments remain supported.
9. As a player, I want to save an offline or unverified profile, so that temporary server downtime does not discard setup.
10. As a player, I want Test Connection and its last result visible, so that endpoint, terrain, and protocol failures are understandable.
11. As a player, I want live validation before continuing, so that I never enter OAuth against an unusable server.
12. As a returning player, I want server selection on every cold launch with the last profile preselected, so that reconnecting is quick but explicit.
13. As a player, I want credentials isolated per connection profile, so that one server cannot overwrite another server's login.
14. As a player, I want the last account and character isolated per profile, so that state does not leak between worlds.
15. As a player, I want profile deletion to remove its credentials and preferences after confirmation, so that abandoned private data is cleaned up.
16. As a player, I want profile duplication to omit login tokens, so that copies do not silently reuse an account.
17. As a returning player, I want valid cached OAuth to skip Welcome Back/Continue, so that I go directly to characters.
18. As a player, I want to cancel device login and return to server selection, so that I can correct a mistaken profile.
19. As a player, I want late results from canceled OAuth ignored, so that an abandoned flow cannot pull me back.
20. As a player, I want account identity and account switching on the character page, so that account and server changes remain distinct.
21. As a player, I want the roster shown after every sign-in, so that I can deliberately select a character.
22. As a player, I want my last character listed first and identified, so that the common choice remains fast.
23. As a player, I want clicking a character to enter immediately, so that a redundant Play button disappears.
24. As a player, I want successful character creation to enter immediately, so that creation flows into play.
25. As a player, I want character creation to retain the server's single stat roll, so that an LLM is not required.
26. As a manual player, I want to play without configuring an LLM, so that AI remains optional.
27. As a player, I want AI automatic attempted by default, so that the app remains agent-first.
28. As a player, I want invalid LLM setup to fall back to manual during entry, so that it never locks me out.
29. As a player, I want one global LLM configuration, so that I only maintain one provider setup.
30. As a player, I want the No LLM backend removed, so that automatic mode never appears active while idling.
31. As a player, I want new LLM settings validated before replacing working settings, so that typos do not break an agent.
32. As a player, I want model and provider controls together in an LLM tab, so that configuration has one home.
33. As a player, I want behavior controls in an Automatic Play tab, so that they use game language.
34. As a player, I want active cadence presets of Very Fast (3s), Fast (5s), Balanced (10s), Relaxed (20s), and Economical (30s), so that response frequency is understandable.
35. As a player, I want idle presets of Frequent (30s), Normal (1m), Occasional (5m), Rare (15m), and Minimum (60m), so that quiet-time usage is understandable.
36. As an advanced player, I want exact-second overrides, so that presets do not remove precision.
37. As a player, I want a maximum calls-per-minute estimate, so that I understand the usage effect.
38. As a player, I want “Continue adventuring while alone” enabled by default with a cost explanation, so that automatic characters do not unexpectedly stop.
39. As a player, I want settings staged until one Apply action, so that moving a slider does not restart repeatedly.
40. As an AI-mode player, I want Apply to validate and reconnect once, so that all runtime settings take effect together.
41. As a manual player, I want LLM changes saved without reconnecting the game, so that unrelated settings do not interrupt play.
42. As a player, I want accessible hand and robot SVG controls, so that manual and AI modes are compact and clear.
43. As a player, I want mode switching to retain the selected character, so that it does not restart onboarding.
44. As a player, I want switching progress and locked repeat input, so that controllers cannot race.
45. As a player, I want failed switching to restore the prior mode, so that the UI never claims a dead controller.
46. As a player, I want AI work canceled when taking manual control, so that stale actions cannot execute afterward.
47. As a manual player, I want the embedded client to reuse desktop auth and character selection, so that switching does not repeat login.
48. As a manual player, I want all agent chrome hidden except mode and settings controls, so that the game is unobstructed.
49. As an AI player, I want the spectator, Directive, Thoughts, logs, inventory, equipment, and personality tools retained, so that I can observe and steer the agent.
50. As an AI player, I want failures retried indefinitely with capped backoff and a countdown, so that temporary outages recover.
51. As a player, I want choosing manual to cancel automatic retry, so that my choice takes effect immediately.
52. As a player, I want Change Character and Change Server actions, so that navigation no longer depends on an ambiguous Stop.
53. As a player, I want closing the window to stop every controller and agent, so that nothing remains connected or consuming LLM quota.
54. As an existing user, I want official settings mapped to the built-in profile, so that upgrading needs no reconfiguration.
55. As an existing custom-server user, I want an Imported Server profile, so that upgrading preserves my configuration and login.
56. As an existing user, I want migration committed transactionally, so that an interrupted upgrade cannot lose settings.
57. As a player, I want personality keyed by connection profile and stable character ID, so that same-named characters cannot collide.
58. As a maintainer, I want all customized OpenMMO web-client code in one fork branch, so that source is not split across commits and overlays.
59. As a maintainer, I want an exact OpenMMO submodule commit, so that release source is reproducible.
60. As a maintainer, I want CI to build the agent and web client from that pin, so that stale local resources cannot ship.
61. As a maintainer, I want macOS arm64, Windows x64, and Linux x64 artifacts, so that initial CI matches current targets.
62. As a maintainer, I want CI to skip Git LFS assets, so that builds and downloads remain small.
63. As a maintainer, I want tags to create unsigned draft releases with checksums and warnings, so that artifacts can be inspected before publication.

## Implementation Decisions

- Make a **connection profile** a persisted entity with stable ID, display name, WebSocket endpoint, derived or overridden terrain origin, Google OAuth2 client ID, encrypted client secret, built-in/custom kind, validation status, and profile-scoped preferences.
- Ship one immutable built-in `openmmo.to.nexus` profile. Allow selection and duplication but not editing or deletion. Custom profiles support full CRUD.
- Keep NPC-token authentication out of the player-facing editor. Existing operator support may remain in developer/manual configuration.
- Permit offline saves, but require live WebSocket, **protocol guard**, and terrain validation before OAuth.
- Derive `https://host` from `wss://host/ws`; store an override only when necessary.
- Store Google credentials, account identity, last character, and test metadata per profile. Materialize only the selected credential for legacy components. Keep LLM configuration global.
- Replace login-first routing with server, OAuth, character, and game states. Refresh cached credentials automatically and only show device login when necessary.
- Preserve ADR-0001: Electron owns Google sign-in and character CRUD through the **pre-flight session**. Manual mode receives short-lived auth and an already-selected character; it does not add another selection flow.
- Preserve ADR-0002: the pre-flight protocol guard fails closed. Custom servers must match the packaged protocol.
- Remove LLM and connection tabs from the character screen and remove Play. Selecting or creating a character enters the game.
- Keep the server's one-roll character-creation behavior; do not evaluate stats with an LLM.
- Maintain one global LLM record with backend, model, credentials, Base URL, temperature, token limit, reasoning, cadence, alone behavior, concurrency, timeout, watch port, and log level.
- Remove No LLM. Use an explicit unconfigured/invalid state that disables AI but never manual play.
- Validate staged changes before replacing a valid configuration. CLI providers verify executable and authentication; HTTP providers perform a clearly disclosed minimal request. An unverified draft cannot start AI.
- Divide the modal into LLM, Automatic Play, and Advanced tabs. Profile CRUD only exists on server selection.
- Use the agreed cadence presets, show effective time and an upper-bound call estimate, and retain exact values under Advanced.
- Present `alwaysActive` as “Continue adventuring while alone,” enabled by default.
- Stage edits. In AI mode, commit and reconnect once after validation. In manual mode, commit without reconnecting the game.
- Introduce a play-mode/session coordinator with stopped, starting AI, AI active, retrying AI, switching to manual, manual active, switching to AI, and disconnected states.
- Default new sessions to AI. If initial AI cannot start because LLM configuration is unavailable, enter manual with an actionable explanation.
- Treat mode changes as reconnecting handoffs. Stop the current controller, confirm target authentication/world entry, then commit UI state. Roll back on failure; expose disconnected recovery only if rollback also fails.
- Cancel in-flight LLM calls, queued actions, and retry timers before manual handoff.
- Extend the customized OpenMMO client with a manual startup contract carrying profile endpoints, a fresh short-lived token, stable character identity, and interactive mode. It enters the world without login or selection.
- Guarantee one controlling session. The existing spectator mirror remains AI-only; the manual client is interactive and never coexists with the agent controller.
- In manual mode, retain only the game and a compact mode/settings overlay. In AI mode, retain existing agent tooling.
- Preserve ADR-0003: a **Directive** remains a best-effort whisper in AI mode and is hidden in manual mode.
- Retry unexpected AI failure forever at 2s, 5s, 10s, then 30s for every later attempt. Show status/countdown; manual selection or exit cancels retry.
- Replace Stop with Change Character and Change Server. Both terminate the active controller before navigation.
- Closing the window always stops the controller and agent. There is no background mode or tray.
- Migrate legacy settings transactionally: official values map to built-in; others create Imported Server; credential and last character follow the profile; LLM values become global.
- Key personality data by profile ID and stable character ID, migrating unambiguous legacy name-based content.
- Update the glossary because connection profiles are no longer popup fields. Add ADRs for dual-controller handoff and the pinned dependency/release boundary.
- Add the public `tpai/OpenMMO` fork as an HTTPS submodule pinned to one exact commit. Use one long-lived integration branch rather than protocol-numbered branches.
- Consolidate spectator and manual web-client changes in the fork. Keep desktop-owned prompts/templates in this repository and stage them explicitly.
- Make the pin the only normal build input. Stamp artifacts with its commit/protocol and fail stale or mismatched resources.
- On tags, build unsigned macOS arm64 ZIP, Windows x64 NSIS, and Linux x64 AppImage artifacts, generate checksums, and attach them to a draft GitHub Release. Publication is manual.
- Do not fetch Git LFS in CI; retain runtime terrain-origin proxying and caching.

## Testing Decisions

- Use one primary application-workflow seam at the renderer/preload boundary. A fake preload API drives server selection, OAuth, character entry, settings, mode handoff, retries, rollback, and exit. Assert visible state and requested operations, not private functions or DOM structure.
- Build one reusable deterministic harness for asynchronous late OAuth results, controller readiness, process exits, time progression, and restart failures.
- Test the connection-profile store through its public interface: built-in immutability, custom CRUD, derivation, secret round trips, isolation, cleanup, and transactional migration. Do not assert encryption implementation details.
- Test the pre-flight session at its existing WebSocket/message seam, including protocol refusal, roster behavior, one-roll creation, deletion, and close.
- Test the session coordinator with fake manual and AI controllers: exclusive ownership, readiness-before-commit, cancellation, rollback, initial fallback, capped indefinite retry, navigation, and shutdown.
- Add an integration contract test proving the customized web client enters an interactive manual world with injected auth/character and no duplicate onboarding. Preserve a send-silent spectator contract for AI mode.
- Extend existing byte-oriented relay tests where ownership and routing matter.
- Extend the existing fake-agent-process testing style for cancellation, reconnect, and shutdown.
- Add packaging smoke tests for the pinned commit/protocol stamp, manual and spectator capabilities, omitted LFS payloads, native binary, and artifact names.
- Test release planning without publishing from pull requests. Good tests observe player/release outcomes and avoid markup snapshots, CSS details, timer implementations, or private state shapes.

## Out of Scope

- LLM evaluation or rerolling of character attributes.
- Per-character or per-profile LLM settings.
- Player-facing NPC-token/operator login.
- Editing or switching profiles inside a live session.
- Zero-reconnect hot switching.
- Guaranteed Directive execution.
- Background AI, tray/menu-bar behavior, or continuing after window close.
- Signed/notarized artifacts, automatic publication/update, macOS x64, or Linux arm64 in the first workflow.
- Bundling Git LFS assets.
- Authentication beyond Google OAuth2.
- Custom servers that do not match the pinned OpenMMO protocol.

## Further Notes

- Preserve unrelated pre-existing local changes during implementation.
- Correct drift in the connection-profile glossary and protocol-guard history without weakening fail-closed behavior.
- The OpenMMO fork is publicly readable, so an HTTPS submodule needs no cross-repository private token. Revisit credentials if visibility changes.
- Clearly identify unsigned artifacts because macOS Gatekeeper and Windows SmartScreen may warn.
- Do not advance the submodule until the matching desktop workflow, manual startup contract, protocol verification, and packaging checks pass together.
