# dsh-no-telemetry

**English** | [中文](https://github.com/scarletkc/dsh-no-telemetry/blob/main/README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that turns off every telemetry and session-log upload path I could find in DSH. It also strips the identity headers DSH adds to DeepSeek API requests. It ships with a verify script that captures packets in a sandbox, so you can check the result yourself instead of taking my word for it.

> Tested against DeepSeek Harness **0.2.2-rc.5** (Windows). Not affiliated with DeepSeek.

## What stock DSH sends

All of these are on by default. Each was confirmed by reading the source shipped in `app.asar` and capturing traffic.

| Path | What leaves your machine | In-app switch |
|---|---|---|
| `dsh_session_log` field on official DeepSeek API requests | The full session log: your messages, model replies, system prompt, tool calls and results (file contents, command output), and the absolute working-directory path | A toggle exists, but switching it **off only pauses uploads**. Everything written while it is off is backfilled once it is back on, and a forked session re-uploads its inherited history from event 0 |
| The same field, in mixed sessions | Earlier turns run on third-party models (Claude, GPT, …) in the same session | – |
| The same field, with a custom base URL | Sent to whatever base URL the DeepSeek adapter uses, relays included | – |
| `dsh_plugin_packages` field | Every installed plugin with its version, third-party plugins included | none |
| `x-deepseek-harness-user-id` / `-session-id` headers | A persistent anonymous id (`~/.dsh/.anonymous-user-id`) and the session id, on every DeepSeek request | none |
| Feedback → OTLP (`dsh-otel-collector.deepseeksvc.com`) | The whole session, whatever model provider it used, plus `user.id` | `DSH_TELEMETRY_DISABLED` env var only |
| Desktop product analytics (same collector) | Usage events, model names (third-party ones too), CPU, memory, OS build, account `user_id` and `device_id` | none (the source says "no user settings surface") |

## What this bundle does

`cordis.patch.yml` is a bundle layer applied after the shipped bundles. It disables these rows:

| Row | Effect |
|---|---|
| `deepseek-llm-api-extensions` | Removes the registry that adds extra top-level fields to DeepSeek requests. With it gone, the adapter sends no `dsh_*` fields at all |
| `session-log-deepseek`, `plugin-package-inventory-deepseek` | The two field producers, disabled by name as well |
| `session-telemetry-otel` | Feedback session upload |
| `product-analytics`, `desktop-product-telemetry` | Desktop analytics |
| `otel` | The shared OTLP service; its only consumers are the two telemetry rows above |

It also inserts a small **fetch guard** (`index.js`) into the Host process as a second line of defense. It:

- removes every `x-deepseek-harness-*` request header (these are hard-coded, with no config switch);
- removes every top-level `dsh_*` field from JSON request bodies, which covers fields a future release might add;
- rejects `fetch` requests to `*.deepseeksvc.com`.

Requests that carry none of these pass through unchanged. Your messages, API key and model choice reach the model as usual.

The settings page only edits a row's `config`, never its `disabled` flag, so no in-app toggle can switch these rows back on.

## Verified result

From `verify/run.ps1` on 0.2.2-rc.5:

| Check | Stock DSH | With this bundle |
|---|---|---|
| `dsh_*` request fields | `dsh_plugin_packages`, `dsh_session_log` | none |
| `x-deepseek-harness-*` headers | `-session-id`, `-user-id` | none |
| Backlog written while the upload toggle was off is uploaded later | yes | no |
| Fork re-uploads inherited history | yes | no |
| Feedback OTLP upload (whole session, 81 KB in the test) | yes | no |
| Model requests still work | ✔ | ✔ |

## Install

1. In DeepSeek Harness open **Plugins** → **Add plugin**, paste `https://github.com/ScarletKc/dsh-no-telemetry` and install.
2. Fully quit and restart DeepSeek Harness.
3. Optional but recommended: also leave **Settings → General → Upload Session Log** off. If you ever remove this bundle, the shipped uploader comes back, and with the toggle on it would backfill your old sessions.

CLI (headless or custom profiles): `dsh plugin --profile <name> add github:ScarletKc/dsh-no-telemetry`

## Verify it yourself

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File verify\run.ps1
```
```sh
# macOS (paths not yet tested; set DSH_APP_RESOURCES if needed)
sh verify/run.sh
```

The script uses the Electron runtime bundled with DeepSeek Harness, so you do not need Node.js. It boots the DSH CLI with a throwaway `DSH_HOME`, points the DeepSeek API and every telemetry endpoint at a local recorder, and runs the same scenarios before and after installing this bundle into that temporary profile. **Nothing goes to the internet, and your real `~/.dsh` is never touched.** Set `DSH_KEEP_TEMP=1` to keep the captured requests.

Please re-run it after every DSH update. A renamed or newly added row is not covered until this bundle is updated. If verify fails, open an issue and attach `captured.json`.

## Not covered

- Desktop auto-update checks (`download.deepseek.com`) run in the Electron main process, which plugins cannot reach.
- Signing in with a DeepSeek account sends a device id, device model and OS version as part of sign-in. Use an API key instead to avoid it.
- Anything a server sees anyway: your IP address, your API key, the `User-Agent`, and of course the conversation you send to the model.
- Data that was already uploaded. You can ask for deletion at `harness-privacy@deepseek.com` (GDPR Art. 15/17 for EU users).

## Uninstall

Remove it in **Plugins**, then restart. This restores the shipped behavior, **including any pending session-log backlog** (see Install step 3).

## License

MIT
