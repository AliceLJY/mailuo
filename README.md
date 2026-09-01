# Mailuo

Chinese Version: [README_CN.md](README_CN.md)

Mailuo turns chat screenshots into structured action cards, contact memory, and grounded relationship insights.

v3 separates reading from understanding: Android native BYOK mode uses on-device OCR to read screenshots, then sends annotated text to the configured text model for structured understanding; the vision model is a fallback unless cloud vision is explicitly forced.

Current item workflows support independent items without contacts or a meeting time, conservative duplicate prompts before user-confirmed updates, progress fragments attached to existing items, and relative dates anchored only by explicit absolute timestamps visible in the screenshot.

| Upload | Contacts | Schedule |
|---|---|---|
| ![Upload](docs/screenshots/web-upload.png) | ![Contacts](docs/screenshots/web-contacts.png) | ![Meetings](docs/screenshots/web-meetings.png) |

> Screenshots show the web build (Expo web output); the Android native UI is identical. All people and companies shown are synthetic test data.

**Native dual-mode UI on a real device** (Android, BYOK standalone):

| First-launch chooser | Model key management | Settings |
|---|---|---|
| ![Onboarding](docs/screenshots/device-onboarding.jpg) | ![Key management](docs/screenshots/device-api-key.jpg) | ![Settings](docs/screenshots/device-settings.jpg) |

## Architecture

```text
Android BYOK local mode (default)

screenshot
  -> on-device ML Kit OCR
  -> annotated text (speaker side + timestamp anchors)
  -> configured text model
  -> structured people / items / facts / quotes
  -> resolution + editable proposals
  -> human confirmation
  -> local SQLite + grounded insights
```

If local OCR cannot produce reliable text, if text interpretation fails, or if cloud vision is explicitly forced, the screenshot takes the Qwen-VL visual fallback and then rejoins the same resolution and proposal loop. Screenshot uploads in web and self-hosted server modes still use server-side Qwen-VL perception.

In the healthy Android local path, the raw screenshot stays on the phone: the configured text model receives annotated OCR text, not the image. DeepSeek is optional; when it is not configured, text tasks use Qwen through DashScope.

## Agent Loop

1. Recognition: Android local mode reads screenshots with ML Kit OCR and falls back to Qwen-VL only when the text path is unusable or cloud vision is forced. Pasted text skips image recognition; web and server screenshot uploads use Qwen-VL perception.
2. Understanding: the configured text model turns annotated OCR or pasted text into structured people, items, facts, and quotes.
3. Resolution: match people against canonical names and aliases first, then ask the text model to decide `same_as`, `new`, or `unsure` only when exact matching fails. Confirmed name variants are written back as aliases for later local matches.
4. Proposal: create editable cards for contact changes, meetings, appointments, independent items, item updates, and interactions. Similar existing items prompt a user-confirmed update instead of automatic deduplication.
5. Human confirmation: let the user edit fields, resolve ambiguities, confirm, or reject each card.
6. Execution: write confirmed contacts, meetings and items, aliases, and observations back to SQLite.
7. Grounded insights: generate relationship reads, suggested actions, and conversation hooks that must cite `based_on` observation evidence.

Three signals that this is not a thin wrapper:

- The system returns structured, executable cards instead of a free-form paragraph.
- Entity resolution writes back alias decisions, so the contact memory becomes more accurate over time.
- Every insight is grounded in stored observations instead of being generated from the screenshot alone.

## Memory Model

Mailuo maps its memory stack to the Atkinson-Shiffrin model: sensory memory, working memory, and long-term memory.

| Layer | Storage units | Lifecycle | Mapping |
| --- | --- | --- | --- |
| Sensory layer | `screenshots.raw_extraction` | Kept mainly for traceability after perception | Sensory memory |
| Working layer | `action_cards` rows in `pending` state | Waits for user confirmation or rejection | Working memory |
| Long-term layer | `contacts`, `observations`, `meetings` (meetings, appointments, and independent items), and `insights` rows | Persists and accumulates | Long-term memory |

Long-term memory has two update semantics:

- Profile fields: structured `Contact` columns change slowly and only after user confirmation. Confirmed changes also leave an `Observation` trail.
- Stream facts: `Observation` rows are append-only, each anchored to source text and time.

That split lets the model use profile fields for "who this person is" and observation timelines for "how the relationship is changing."

## Engineering Story

The project is hardened through automated suites, live-provider checks, and device testing.

- Automated coverage spans schema migrations, OCR and visual fallback, ordered batches, proposal and resolution, independent items, duplicate updates, timestamp anchors, route behavior, and grounded insights.
- Live-provider checks exposed prompt-layer failures that mocks had not covered, including self-side messages becoming contacts, company changes falling into notes, vague time phrases becoming meetings, and truncated insight JSON.
- iOS and Android testing exposed platform issues in native file uploads and OCR runtime loading; web testing also caught cross-origin and same-origin deployment differences.

## Quickstart

Use Node 26 or newer.

1. Install dependencies.

```bash
cd server
npm install
```

```bash
cd app
npm install
```

2. Create the environment files.

```bash
# server/.env
DASHSCOPE_API_KEY=
QWEN_MODEL=qwen-vl-max
QWEN_TEXT_MODEL=qwen-plus
# Optional: when empty, resolution and insights use Qwen through DashScope.
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-v4-flash
PORT=3000
```

Only the DashScope key is required. Add a DeepSeek key if you want resolution and insight generation to use DeepSeek instead of Qwen.

```bash
cp app/.env.example app/.env
```

```bash
# app/.env
EXPO_PUBLIC_API_URL=http://<your-lan-ip>:3000
```

For same-origin web serving, `bash scripts/build-web.sh` forces `EXPO_PUBLIC_API_URL` to empty during export so the bundled client uses `/api`.

3. From the repo root, open two terminals and start the server and app separately.

```bash
# Terminal 1
cd server
npm run dev
```

```bash
# Terminal 2
cd app
npm run start
```

4. Build the web bundle for same-origin serving.

```bash
bash scripts/build-web.sh
```

That exports the web app with a forced same-origin API base and syncs it into `server/public/`.

## Build And Deploy Docs

Build and deployment assets live in [deploy/README.md](deploy/README.md) and [scripts/build-web.sh](scripts/build-web.sh). The repo includes a `launchd` plist, an install script, Tailscale Serve instructions, and an Expo EAS preview APK profile. Running a self-hosted deployment remains a manual step on the target machine.

## Privacy Boundary

- **BYOK local mode**: profiles and imported screenshot files are stored only on the user's phone. During inference, the app connects directly to the model providers, with no Mailuo server in between. Model keys are kept only in the system credential store (iOS Keychain / Android Keystore), and the UI never reveals their full values.
- In the default Android OCR path, the raw screenshot stays on the phone. Annotated recognized text is sent to the configured text model for extraction and resolution.
- If OCR cannot produce reliable text, if text interpretation fails, or if cloud vision is explicitly forced, the raw screenshot is sent to Qwen-VL for visual fallback. It is never sent to DeepSeek.
- In self-hosted server mode, app data is stored in SQLite on the server host and screenshot files are stored under `server/data/screenshots/`; screenshot perception uses Qwen-VL.
- **Text submitted through the paste-text entry is sent verbatim to the configured text model** (DeepSeek, or the DashScope Qwen text model when DeepSeek is not configured) for extraction; no vision model is involved. Whatever you paste is what gets sent — judge the sensitivity of the content yourself.
- DeepSeek receives only the text needed for extraction, entity resolution, or grounded insights, such as `source_quote`, `facts`, `quotes`, `events`, and minimum profile or observation context. When DeepSeek is not configured, these text tasks use the Qwen text model through DashScope instead, and no data is sent to DeepSeek.
- **Plainly put**: storage is local, but during inference OCR-derived or pasted text reaches the configured text provider. Raw screenshots reach Alibaba Cloud only on visual fallback, forced cloud vision, or server-mode visual perception. Provider data policies apply.
- **Fully-local route (already supported by the architecture, env vars only)**: both providers speak the OpenAI-compatible API, so they can point at a local inference service (e.g. Ollama / vLLM) — set `DASHSCOPE_BASE_URL` / `DEEPSEEK_BASE_URL` to a local endpoint and switch `QWEN_MODEL` / `DEEPSEEK_MODEL` to local models (open-weight Qwen-VL works for vision). Data then never leaves the machine. Expect lower extraction/insight quality from small local models; evaluate for your own use.
- The current deployment is single-user and has no app-layer authentication yet.
- The practical access boundary today is the local network or Tailscale exposure chosen by the deployer.
- Future multi-user support and authentication are still pending work.

## Known Limitations

- On-device OCR can still misread characters, so important fields should be checked on the confirmation cards.
- Item duplicate detection is deliberately conservative and may miss matches. Whole-screenshot deduplication is not implemented, so repeated uploads may still duplicate observations.

## Distribution Modes

One package offers (1) **BYOK local mode**, where users enter their own model keys and the pipeline runs in the native app; (2) **self-hosted server mode**, which connects to the user's own Mailuo backend; and (3) a disabled **subscription** placeholder marked “Coming soon.” The web build supports server mode only; local mode is exclusive to the native app.

## Future Work

- iOS native distribution: when the target region's App Store does not offer Expo Go, native iOS distribution needs an Apple Developer account plus EAS and TestFlight.
- Whole-screenshot duplicate detection and merge.
- Insight retry endpoint.
- Scheduled proactive insight delivery.
- System calendar integration.
- Direct messaging app integration.
- Group chat and multi-participant optimization.
- Multi-user support and authentication.
