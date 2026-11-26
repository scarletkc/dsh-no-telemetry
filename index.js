/**
 * dsh-no-telemetry fetch guard.
 *
 * The rows disabled in cordis.patch.yml stop every telemetry producer this
 * bundle knows about. This plugin is the second line of defense, for the parts
 * that are hard-coded or that a later release might add:
 *
 * - removes `x-deepseek-harness-*` request headers (anonymous user id, session id,
 *   compaction flag) that the official DeepSeek adapter always sends;
 * - removes top-level `dsh_*` fields from JSON request bodies;
 * - rejects fetch requests to the configured telemetry hosts.
 *
 * It wraps `globalThis.fetch` in the Host process only. Requests that carry none
 * of the above pass through untouched. OpenTelemetry exporters do not use fetch;
 * they are disabled by the patch rows instead.
 */

const HEADER_PREFIX = 'x-deepseek-harness-'
const FIELD_PREFIX = 'dsh_'
const DEFAULT_BLOCKED_HOSTS = ['deepseeksvc.com']

export const name = 'dsh-no-telemetry'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ blockedHosts?: string[] }} [config]
 */
export function apply(ctx, config) {
  const blockedHosts = normalizeHosts(config?.blockedHosts ?? DEFAULT_BLOCKED_HOSTS)
  const reported = new Set()
  const report = (what) => {
    if (reported.has(what)) return
    reported.add(what)
    ctx.logger.info(`dsh-no-telemetry: removed ${what}`)
  }

  ctx.effect(() => {
    const original = globalThis.fetch
    if (typeof original !== 'function') {
      ctx.logger.warn('dsh-no-telemetry: globalThis.fetch is unavailable; header and field stripping is inactive')
      return () => {}
    }
    const guarded = function fetch(input, init) {
      const url = urlOf(input)
      if (url !== undefined && isBlocked(url.hostname, blockedHosts)) {
        report(`request to ${url.hostname}`)
        return Promise.reject(new TypeError(`dsh-no-telemetry: blocked request to ${url.hostname}`))
      }
      return original.call(this, cleanInput(input, report), cleanInit(init, report))
    }
    globalThis.fetch = guarded
    return () => {
      // Restore only if nobody wrapped fetch after us.
      if (globalThis.fetch === guarded) globalThis.fetch = original
    }
  }, 'dsh-no-telemetry fetch guard')
}

function normalizeHosts(hosts) {
  return (Array.isArray(hosts) ? hosts : [])
    .filter(host => typeof host === 'string' && host.length > 0)
    .map(host => host.toLowerCase().replace(/^\.+/, ''))
}

function isBlocked(hostname, blockedHosts) {
  const host = hostname.toLowerCase()
  return blockedHosts.some(blocked => host === blocked || host.endsWith(`.${blocked}`))
}

function urlOf(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url)
  } catch {
    // A relative or malformed URL is not ours to judge; fetch reports it.
  }
  return undefined
}

/** Strip identifying headers from a Request object input; its body is left as is. */
function cleanInput(input, report) {
  if (typeof Request === 'undefined' || !(input instanceof Request)) return input
  const headers = stripHeaders(input.headers, report)
  return headers === undefined ? input : new Request(input, { headers })
}

/** Strip identifying headers and `dsh_*` body fields from fetch init options. */
function cleanInit(init, report) {
  if (init === undefined || init === null || typeof init !== 'object') return init
  let next = init
  if (init.headers !== undefined) {
    const headers = stripHeaders(init.headers, report)
    if (headers !== undefined) next = { ...next, headers }
  }
  if (typeof init.body === 'string' && init.body.includes(`"${FIELD_PREFIX}`)) {
    const body = stripFields(init.body, report)
    if (body !== undefined) next = { ...next, body }
  }
  return next
}

/** @returns a cleaned Headers object, or undefined when nothing was removed. */
function stripHeaders(source, report) {
  let headers
  try {
    headers = new Headers(source)
  } catch {
    return undefined
  }
  const doomed = []
  for (const key of headers.keys()) if (key.startsWith(HEADER_PREFIX)) doomed.push(key)
  if (doomed.length === 0) return undefined
  for (const key of doomed) {
    headers.delete(key)
    report(`header ${key}`)
  }
  return headers
}

/** @returns the re-serialized body, or undefined when the body is not a JSON object with `dsh_*` keys. */
function stripFields(text, report) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const doomed = Object.keys(value).filter(key => key.startsWith(FIELD_PREFIX))
  if (doomed.length === 0) return undefined
  for (const key of doomed) {
    delete value[key]
    report(`request field ${key}`)
  }
  return JSON.stringify(value)
}
