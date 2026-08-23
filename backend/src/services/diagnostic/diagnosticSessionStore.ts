/**
 * In-memory diagnostic session store (Decision 2).
 *
 * This is the ONLY module that touches the session Map. The diagnostic service
 * and controller go through these functions, so swapping to a persisted store
 * later (MongoDB, Redis) means reimplementing this one file — no change to the
 * service, controller, or types. No MongoDB model is added for diagnosis yet.
 *
 * Lifetime management:
 *   - each session has a TTL (DIAGNOSTIC_SESSION_TTL_MS, default 30 min);
 *   - expired sessions are swept lazily on every access and never returned;
 *   - a hard cap (DIAGNOSTIC_SESSION_MAX, default 500) evicts the oldest
 *     sessions so a long-running process cannot grow this Map without bound.
 *
 * State is process-local and lost on restart — acceptable for this phase and
 * called out in the limitations section of the report.
 */

import { randomUUID } from 'crypto';
import { DiagnosisSession } from '../../types/diagnostic';

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_SESSIONS = 500;

/** The single owned store. Keyed by sessionId. */
const sessions = new Map<string, DiagnosisSession>();

/**
 * TTL is read once and cached, but overridable via a test hook so the TTL test
 * does not have to wait 30 real minutes.
 */
let ttlMs: number | null = null;

const resolveTtlMs = (): number => {
  if (ttlMs !== null) return ttlMs;
  const configured = Number(process.env.DIAGNOSTIC_SESSION_TTL_MS);
  ttlMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
  return ttlMs;
};

const resolveMaxSessions = (): number => {
  const configured = Number(process.env.DIAGNOSTIC_SESSION_MAX);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_SESSIONS;
};

/** Test hook: set the TTL directly (ms). Pass null to fall back to the env/default. */
export const setSessionTtlMsForTests = (ms: number | null): void => {
  ttlMs = ms;
};

/** Current TTL in ms (after env/override resolution). */
export const getSessionTtlMs = (): number => resolveTtlMs();

const isExpired = (session: DiagnosisSession, now: number): boolean =>
  now - session.updatedAt > resolveTtlMs();

/**
 * Remove every expired session. Returns the number removed.
 * `now` is injectable so tests can advance time deterministically.
 */
export const sweepExpired = (now: number = Date.now()): number => {
  let removed = 0;
  for (const [id, session] of sessions) {
    if (isExpired(session, now)) {
      sessions.delete(id);
      removed++;
    }
  }
  return removed;
};

/**
 * Evict oldest sessions (by updatedAt) until the store is within the cap.
 * Runs after an insert so the Map size is bounded regardless of TTL.
 */
const enforceCap = (): void => {
  const max = resolveMaxSessions();
  if (sessions.size <= max) return;
  const ordered = [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  for (const session of ordered) {
    if (sessions.size <= max) break;
    sessions.delete(session.sessionId);
  }
};

/**
 * Create a new session from a partial seed. Generates the id and timestamps;
 * the caller supplies the initial diagnostic fields.
 */
export const createSession = (
  seed: Omit<DiagnosisSession, 'sessionId' | 'createdAt' | 'updatedAt'>
): DiagnosisSession => {
  const now = Date.now();
  sweepExpired(now);
  const session: DiagnosisSession = {
    ...seed,
    sessionId: randomUUID(),
    createdAt: now,
    updatedAt: now
  };
  sessions.set(session.sessionId, session);
  enforceCap();
  return session;
};

/**
 * Fetch a live session. Returns null (and deletes) if it has expired, so an
 * expired id is indistinguishable from an unknown id to callers.
 */
export const getSession = (sessionId: string): DiagnosisSession | null => {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (isExpired(session, Date.now())) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
};

/**
 * Persist an updated session, refreshing `updatedAt` (which also renews TTL).
 * The session must already exist (created via createSession).
 */
export const saveSession = (session: DiagnosisSession): DiagnosisSession => {
  session.updatedAt = Date.now();
  sessions.set(session.sessionId, session);
  enforceCap();
  return session;
};

export const deleteSession = (sessionId: string): void => {
  sessions.delete(sessionId);
};

/** Number of live (not-yet-swept) sessions. Mainly for tests/metrics. */
export const sessionCount = (): number => sessions.size;

/** Test hook: clear everything and reset the cached TTL. */
export const resetStoreForTests = (): void => {
  sessions.clear();
  ttlMs = null;
};
