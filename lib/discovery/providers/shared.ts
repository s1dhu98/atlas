/**
 * Plumbing every places provider needs, in one place.
 *
 * The three API providers differ in their auth and their JSON and in nothing
 * else that matters, so the timeout policy, the error wording and the query
 * vocabulary live here rather than three times over.
 */

import type { Discipline, DiscoveryTarget } from '../types';

/**
 * Eight seconds, no retry.
 *
 * The app path runs inside a server action, so the browser holds an open HTTP
 * request for the whole call, and a reverse proxy will cut an idle response
 * long before a places API legitimately takes this long. A places lookup that
 * has not answered in eight seconds is not going to answer usefully; failing
 * inside the window with something to read beats exceeding it and hanging.
 */
export const HTTP_TIMEOUT_MS = 8_000;

export async function getJson(
  url: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS,
): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      // The body is where these APIs put the actual reason — a disabled key, a
      // referrer restriction, an exhausted quota. A bare status code reads as a
      // network blip and sends the next person looking in the wrong place.
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`No response within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** What to type into a places search for each kind of centre we might need. */
const QUERY_WORDS: Record<Discipline, string[]> = {
  PATHOLOGY: ['diagnostic laboratory', 'pathology lab', 'blood test collection centre'],
  RADIOLOGY: ['diagnostic imaging centre', 'ultrasound scan centre', 'MRI CT scan centre'],
  CARDIO_DIAGNOSTIC: ['ECG echo test centre', 'cardiac diagnostic centre'],
};

/**
 * The search terms for one target, deduplicated.
 *
 * Capped at three: each term is a billable call on the metered providers, and
 * past three the results are the same places in a different order. A pincode
 * that needs pathology and radiology costs two calls, not six.
 */
export function queriesFor(t: DiscoveryTarget, max = 3): string[] {
  const asked = t.disciplines?.length ? t.disciplines : (['PATHOLOGY'] as Discipline[]);
  const where = [t.city, t.pincode].filter(Boolean).join(' ');
  const terms: string[] = [];
  for (const d of asked) for (const w of QUERY_WORDS[d] ?? QUERY_WORDS.PATHOLOGY) terms.push(w);
  return Array.from(new Set(terms)).slice(0, max).map((w) => `${w} ${where}`.trim());
}

/** Coerce anything into a finite number or null. APIs send ratings as strings. */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

/** First non-empty string among several candidate field names. */
export function pick(o: any, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = strOrNull(o?.[k]);
    if (v) return v;
  }
  return null;
}

export function describeError(e: unknown): string {
  const err = e as { status?: number; message?: string; error?: { error?: { message?: string } } };
  const detail = err?.error?.error?.message ?? err?.message ?? String(e);
  return err?.status ? `HTTP ${err.status}: ${detail}` : detail;
}
