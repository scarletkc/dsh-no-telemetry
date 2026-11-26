// dsh-no-telemetry verification.
//
// Boots the DSH CLI that ships inside DeepSeek Harness Desktop against a
// throwaway DSH_HOME, points every outbound telemetry endpoint and the
// DeepSeek API at a local recorder, and compares what leaves the process
// before and after this bundle is installed. Nothing is sent to the internet
// and your real ~/.dsh is never touched.
//
// Run it through verify/run.ps1 (Windows) or verify/run.sh (macOS), which use
// the Electron runtime bundled with DeepSeek Harness; no separate Node.js is
// needed. Environment overrides:
//   DSH_APP_RESOURCES  DeepSeek Harness "resources" directory
//   DSH_KEEP_TEMP=1    keep the temporary home and captured requests

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── Locate DeepSeek Harness ─────────────────────────────────────────────────
function locateApp() {
  const resources = process.env.DSH_APP_RESOURCES
    ?? (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources')
      : '/Applications/DeepSeek Harness.app/Contents/Resources')
  const exe = process.platform === 'win32'
    ? join(resources, '..', 'DeepSeek Harness.exe')
    : join(resources, '..', 'MacOS', 'DeepSeek Harness')
  const cli = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
  if (!existsSync(exe)) throw new Error(`DeepSeek Harness not found at ${exe}; set DSH_APP_RESOURCES`)
  return { exe, cli }
}

// ── Local recorder ──────────────────────────────────────────────────────────
const captured = []
let phase = 'setup'

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}
function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  return (message?.content ?? []).map(block => block.text ?? '').join('')
}

function startRecorder() {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', async () => {
      let raw = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'gzip') {
        try { raw = gunzipSync(raw) } catch { /* keep raw */ }
      }
      const text = raw.toString('utf8')
      let body
      try { body = JSON.parse(text) } catch { body = undefined }
      const record = { phase, method: req.method, url: req.url, headers: req.headers, body, bytes: raw.length }
      captured.push(record)

      if (req.url.startsWith('/otlp')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{"object":"list","data":[]}')
      }
      const messages = body?.messages ?? []
      const last = messages.at(-1) ?? {}
      const afterToolResult = Array.isArray(last.content) && last.content.some(block => block.type === 'tool_result')
      const fork = Array.isArray(body?.tools) && !afterToolResult && /DO-FORK/.test(textOf(last))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse('message_start', { message: { id: `msg_${captured.length}`, type: 'message', role: 'assistant', model: body?.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }))
      if (fork) {
        res.write(sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${captured.length}`, name: 'subagent_fork', input: {} } }))
        res.write(sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ description: 'verify fork', prompt: 'reply ok' }) } }))
        res.write(sse('content_block_stop', { index: 0 }))
        res.write(sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }))
      } else {
        // Leave a forked child time to send its own first request.
        if (afterToolResult) await new Promise(done => setTimeout(done, 8000))
        res.write(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
        res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }))
        res.write(sse('content_block_stop', { index: 0 }))
        res.write(sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }))
      }
      res.write(sse('message_stop', {}))
      res.end()
    })
  })
  return new Promise(ready => server.listen(0, '127.0.0.1', () => ready(server)))
}

// ── DSH CLI runner ──────────────────────────────────────────────────────────
function runDsh(app, env, cwd, args) {
  return new Promise((done, fail) => {
    const child = spawn(app.exe, ['--expose-internals', app.cli, ...args], {
      cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', fail)
    child.on('close', code => done({ code, stdout, stderr }))
  })
}

function sessionIdOf(result) {
  for (const line of result.stdout.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.sessionId) return event.sessionId
    } catch { /* not JSON */ }
  }
  throw new Error(`no session id in headless output:\n${result.stdout}\n${result.stderr}`)
}

// ── Checks ──────────────────────────────────────────────────────────────────
const isModelRequest = record => record.method === 'POST' && record.url.includes('/messages')
const dshFields = record => Object.keys(record.body ?? {}).filter(key => key.startsWith('dsh_'))
const harnessHeaders = record => Object.keys(record.headers).filter(key => key.startsWith('x-deepseek-harness-'))

function summarize(name) {
  const records = captured.filter(record => record.phase === name)
  const model = records.filter(isModelRequest)
  const fields = new Set(model.flatMap(dshFields))
  const headers = new Set(model.flatMap(harnessHeaders))
  const otlp = records.filter(record => record.url.startsWith('/otlp'))
  const forked = model.filter(record => record.body?.dsh_session_log?.session?.parentSession !== undefined)
  return { model: model.length, fields: [...fields].sort(), headers: [...headers].sort(), otlp: otlp.length, forked: forked.length }
}

/** Whether any request in a phase carried `marker` inside an uploaded session log or an OTLP body. */
function uploaded(name, marker) {
  return captured.some(record => record.phase === name && (
    JSON.stringify(record.body?.dsh_session_log ?? '').includes(marker)
    || (record.url.startsWith('/otlp') && JSON.stringify(record.body ?? '').includes(marker))))
}

// ── Main ────────────────────────────────────────────────────────────────────
const app = locateApp()
const root = mkdtempSync(join(tmpdir(), 'dsh-no-telemetry-verify-'))
const home = join(root, 'home')
const cwd = join(root, 'workspace')
mkdirSync(cwd, { recursive: true })
const uploadOff = join(root, 'upload-off.yml')
writeFileSync(uploadOff, '- id: session-log-deepseek\n  config:\n    enabled: false\n')
// The feedback button in the Desktop UI appends a `feedback/record` event
// (dsh-command-feedback recordFeedback). Headless has no such button, so this
// verify-only plugin appends the same event when a message says DO-FEEDBACK.
const feedbackPatch = join(root, 'feedback.yml')
writeFileSync(join(root, 'feedback-trigger.mjs'), [
  "export const name = 'verify-feedback-trigger'",
  'export function apply(ctx) {',
  "  ctx.on('session/event', (session, event) => {",
  "    if (event.type !== 'user/message' || !JSON.stringify(event.data).includes('DO-FEEDBACK')) return",
  "    setImmediate(() => session.append('feedback/record', { text: 'verify feedback' }))",
  '  })',
  '}',
  '',
].join('\n'))
writeFileSync(feedbackPatch, '- insert:\n    - id: verify-feedback-trigger\n      name: ./feedback-trigger.mjs\n')

const server = await startRecorder()
const base = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^(DSH_|DEEPSEEK_)/.test(key) || /^(https?|all)_proxy$/i.test(key)) delete env[key]
}
Object.assign(env, {
  DSH_HOME: home,
  DEEPSEEK_BASE_URL: `${base}/anthropic`,
  DEEPSEEK_API_KEY: 'sk-verify-not-a-real-key',
  DSH_TELEMETRY_OTLP_URL: `${base}/otlp/v1/logs`,
  DSH_PRODUCT_ANALYTICS_OTLP_URL: `${base}/otlp/v1/logs`,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
})

const headless = (...args) => runDsh(app, env, cwd, ['headless', '--json', ...args])
// Launcher options such as --patch precede the profile name.
const headlessPatched = (patch, ...args) => runDsh(app, env, cwd, ['--profile', 'headless', '--patch', patch, '--json', ...args])
const step = (label) => process.stdout.write(`  - ${label}\n`)
let failed = false

try {
  const dshVersion = (await runDsh(app, env, cwd, ['--version'])).stdout.trim() || 'unknown version'
  console.log(`dsh-no-telemetry verify\n  DeepSeek Harness: ${dshVersion}\n  app: ${app.exe}\n  temp home: ${home}\n  recorder: ${base}\n`)

  console.log('[1/3] Stock DeepSeek Harness')
  phase = 'before'
  step('new session with the official DeepSeek adapter')
  const first = sessionIdOf(await headless('MARKER-BEFORE hello'))
  step('submit feedback on that session')
  await headlessPatched(feedbackPatch, '--session-id', first, 'DO-FEEDBACK')
  step('fork a subagent from it')
  await headless('--session-id', first, 'DO-FORK please')
  step('control: write with the upload toggle OFF, then continue with it ON')
  const control = sessionIdOf(await headlessPatched(uploadOff, 'MARKER-CONTROL written while upload was off'))
  await headless('--session-id', control, 'continue with upload back on')
  step('write another session with the upload toggle OFF (backlog for later)')
  const backlog = sessionIdOf(await headlessPatched(uploadOff, 'MARKER-BACKLOG written while upload was off'))

  console.log('\n[2/3] Installing this bundle into the temporary profile')
  phase = 'install'
  const install = await runDsh(app, env, cwd, ['plugin', '--profile', 'headless', 'add', `file:${repoDir}`])
  if (install.code !== 0) throw new Error(`bundle installation failed:\n${install.stdout}\n${install.stderr}`)

  console.log('\n[3/3] With dsh-no-telemetry')
  phase = 'after'
  step('continue the backlog session (upload toggle back to default ON)')
  await headless('--session-id', backlog, 'continue after install')
  step('fork a subagent from it')
  await headless('--session-id', backlog, 'DO-FORK please')
  step('submit feedback on it')
  await headlessPatched(feedbackPatch, '--session-id', backlog, 'DO-FEEDBACK')

  const before = summarize('before')
  const after = summarize('after')
  const list = (items, prefix = '') => items.map(item => item.slice(prefix.length)).join(', ') || 'none'
  const yesNo = value => (value ? 'yes' : 'no')
  const count = value => (value > 0 ? `yes (${value})` : 'no')
  const rows = [
    ['Model requests still work', `${before.model} requests`, `${after.model} requests`, after.model > 0],
    ['dsh_* request fields', list(before.fields), list(after.fields), after.fields.length === 0],
    ['x-deepseek-harness-* headers', list(before.headers, 'x-deepseek-harness-'), list(after.headers, 'x-deepseek-harness-'), after.headers.length === 0],
    ['Off-period backlog backfilled', yesNo(uploaded('before', 'MARKER-CONTROL')), yesNo(uploaded('after', 'MARKER-BACKLOG')), !uploaded('after', 'MARKER-BACKLOG')],
    ['Fork re-uploads history', count(before.forked), count(after.forked), after.forked === 0],
    ['Feedback uploads session', count(before.otlp), count(after.otlp), after.otlp === 0],
  ].map(([label, was, now, pass]) => [label, String(was), String(now), pass ? 'PASS' : 'FAIL'])
  const header = ['Check', 'Stock DSH', 'With dsh-no-telemetry', 'Result']
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)))
  const line = cells => `  ${cells.map((cell, column) => cell.padEnd(widths[column])).join('  ')}`.trimEnd()
  console.log('\nResult')
  console.log(line(header))
  console.log(line(widths.map(width => '-'.repeat(width))))
  for (const row of rows) {
    console.log(line(row))
    if (row[3] !== 'PASS') failed = true
  }
  const baseline = before.fields.length > 0 && before.headers.length > 0 && before.otlp > 0 && before.forked > 0
    && uploaded('before', 'MARKER-CONTROL')
  if (!baseline) {
    console.log('\n  Note: stock DSH did not reproduce every upload path in this run, so some "with bundle" results')
    console.log('  prove less than they appear to. Your DSH version may differ from the tested one (0.2.2-rc.5).')
  }
  writeFileSync(join(root, 'captured.json'), JSON.stringify(captured, null, 2))
  console.log(failed
    ? '\nFAILED: something still leaves the process. Please open an issue with captured.json.'
    : `\nPASSED: all ${rows.length} checks (DeepSeek Harness ${dshVersion})`)
} catch (error) {
  failed = true
  console.error(`\nverify aborted: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  server.close()
  if (process.env.DSH_KEEP_TEMP !== '1' && !failed) rmSync(root, { recursive: true, force: true })
  else console.log(`Temporary files and captured.json kept at ${root}`)
}
process.exit(failed ? 1 : 0)
