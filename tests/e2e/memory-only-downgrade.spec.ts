/**
 * Real E2E: downgrade /home/csy to memory-only through the production HTTP route.
 *
 * Route under test: POST /api/vectr/downgrade { workspace }  (src/bridge/routes.ts:168-201)
 * Host under test:   the live DSH web host, http://127.0.0.1:3080 (same origin as the GUI).
 *
 * /home/csy MUST STAY memory_only after this spec — the user explicitly requires it.
 * Do NOT add a restore-to-full step. Re-running is safe and expected: the route
 * re-persists memory-only and still returns a decidable success (idempotent).
 *
 * The self-skips (like tests/live-e2e.spec.ts) so other machines / CI do not fail
 * on an environment they cannot provide — and so a routine `pnpm test` on a machine
 * that DOES have a live host does not restart that host's daemons. See LIVE_OPT_IN.
 */
import { describe, expect, it } from 'vitest'

const HOST = process.env.VECTR_E2E_HOST ?? 'http://127.0.0.1:3080'
/**
 * Second gate: a reachable host is not a licence to mutate it. The downgrade route
 * restarts a real daemon and rewrites the real ~/.vectr/instances.json, which is
 * what the route is for — and what makes `pnpm test` non-hermetic. So the live
 * assertions run only when explicitly asked for:
 *   VECTR_E2E_LIVE=1 pnpm vitest run tests/e2e/memory-only-downgrade.spec.ts
 * The state this spec enforces (memory_only for /home/csy) lives in the registry,
 * not in this file, so skipping it neither hides a regression nor undoes it.
 */
const LIVE_OPT_IN = process.env.VECTR_E2E_LIVE === '1'
const WORKSPACE = '/home/csy'
const TEST_TIMEOUT = 60_000

interface SessionStatus {
  workspace: string
  live: boolean
  mode: string
  port?: number
  status?: { mode?: string; indexed_files?: number } | null
  codebases?: Array<{ slug?: string; isPrimary?: boolean; target?: string }>
  canReindex?: boolean
  reindexDisabledReason?: string
  error?: string
}

/** `memory-only` and `memory_only` are the same mode; compare normalized. */
function normMode(mode: unknown): string {
  return String(mode ?? '').trim().toLowerCase().replace(/-/g, '_')
}

/**
 * Decide whether the live host can serve this spec.
 *
 * An authenticated deployment answers 401/403 to every unauthenticated route:
 * the environment cannot provide an unauthenticated host, so the spec skips
 * instead of reporting an authorization failure as a vectr regression. Any
 * other reachable response keeps the spec running so real breakage fails.
 *
 * @returns true when the vectr route answers without auth.
 */
async function hostReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${HOST}/api/vectr/session-status?workspace=${encodeURIComponent(WORKSPACE)}`, {
      signal: AbortSignal.timeout(3_000),
    })
    await res.text()
    if (res.status === 401 || res.status === 403) {
      console.warn(`Skipping live host e2e: ${HOST} requires authentication (HTTP ${res.status})`)
      return false
    }
    return true
  } catch {
    return false
  }
}

const hostUp = await hostReachable()

async function getSessionStatus(): Promise<SessionStatus> {
  const res = await fetch(
    `${HOST}/api/vectr/session-status?workspace=${encodeURIComponent(WORKSPACE)}`,
    { signal: AbortSignal.timeout(30_000) },
  )
  expect(res.status).toBe(200)
  return (await res.json()) as SessionStatus
}

async function postDowngrade(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${HOST}/api/vectr/downgrade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TEST_TIMEOUT),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

if (!LIVE_OPT_IN && hostUp) {
  console.log(
    'vectr e2e: skipping the live downgrade spec — it restarts a real daemon on the running host. ' +
    'Run it on purpose with VECTR_E2E_LIVE=1.',
  )
}

describe.skipIf(!LIVE_OPT_IN || !hostUp)('live host: memory-only downgrade for /home/csy', () => {
  it('downgrades /home/csy to memory_only and keeps working memory readable', async () => {
    const before = await getSessionStatus()
    expect(before.workspace).toBe(WORKSPACE)
    console.log(
      '[e2e] before:',
      JSON.stringify({
        mode: before.mode,
        live: before.live,
        indexed_files: before.status?.indexed_files ?? null,
        canReindex: before.canReindex,
      }),
    )

    const res = await postDowngrade({ workspace: WORKSPACE })
    console.log('[e2e] downgrade response:', res.status, JSON.stringify(res.json).slice(0, 400))
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(normMode(res.json.mode)).toBe('memory_only')

    const after = await getSessionStatus()
    console.log(
      '[e2e] after:',
      JSON.stringify({
        mode: after.mode,
        live: after.live,
        port: after.port,
        canReindex: after.canReindex,
        reindexDisabledReason: after.reindexDisabledReason,
        daemon: after.status
          ? { mode: after.status.mode, indexed_files: after.status.indexed_files ?? null }
          : null,
      }),
    )

    // The host's own admin view now reports the workspace as memory-only.
    expect(normMode(after.mode)).toBe('memory_only')
    expect(after.live).toBe(true)
    expect(after.port).toBeTypeOf('number')

    // No persistent index store is advertised anymore: re-index is refused
    // because the daemon is memory-only (src/domain/rules.ts canReindex), and
    // no primary codebase entry is listed for this workspace
    // (src/bridge/session-service.ts buildCodebases suppresses it in memory_only).
    expect(after.canReindex).toBe(false)
    expect(String(after.reindexDisabledReason ?? '')).toMatch(/memory[-_ ]only/i)
    expect((after.codebases ?? []).filter(cb => cb.isPrimary)).toHaveLength(0)
    expect(Number(after.status?.indexed_files ?? 0)).toBe(0)

    // Working memory is the surviving capability: a real, read-only recall path
    // must still answer ok and return formatted content.
    const resumeRes = await fetch(
      `${HOST}/api/vectr/notes/resume?workspace=${encodeURIComponent(WORKSPACE)}`,
      { signal: AbortSignal.timeout(30_000) },
    )
    const resume = (await resumeRes.json()) as {
      ok?: boolean
      data?: { formatted?: string; gotchas?: unknown[] }
    }
    console.log(
      '[e2e] notes/resume:',
      resumeRes.status,
      JSON.stringify({ ok: resume.ok, gotchas: resume.data?.gotchas?.length ?? null }),
    )
    expect(resumeRes.status).toBe(200)
    expect(resume.ok).toBe(true)
    // Real memory content, not an empty envelope: the resume formatter produced
    // text and the workspace's gotcha notes are readable in memory-only mode.
    expect(typeof resume.data?.formatted).toBe('string')
    expect((resume.data?.formatted ?? '').length).toBeGreaterThan(0)
    expect((resume.data?.gotchas ?? []).length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  it('rejects a downgrade without a workspace and changes no state', async () => {
    const before = await getSessionStatus()
    const res = await postDowngrade({})
    console.log('[e2e] negative response:', res.status, JSON.stringify(res.json).slice(0, 200))
    expect(res.status).toBe(400)
    expect(typeof res.json.error).toBe('string')
    const after = await getSessionStatus()
    expect(normMode(after.mode)).toBe(normMode(before.mode))
  }, TEST_TIMEOUT)
})
