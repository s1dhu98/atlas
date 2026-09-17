'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { queryOne } from '@/lib/db';
import { canManage } from '@/lib/access';
import { discoverForPincode, discoveryEnabled, DISABLED_MESSAGE } from '@/lib/discoverLabs';

type R = { ok: boolean; error?: string; id?: number };

/**
 * Promote a web-search lead into CRM.
 *
 * The lead itself is unverified third-party data, so this is deliberately a
 * human action rather than something the discovery job does on its own —
 * clicking it is the record that a person looked at it and thinks it is real.
 * The CRM note carries that caveat forward so it is not lost the moment the
 * row leaves this screen.
 */
export async function promoteDiscoveredLab(leadId: number): Promise<R> {
  const me = await getSessionUser();
  if (!me) return { ok: false, error: 'unauthenticated' };
  if (!canManage(me, 'commitments')) {
    return { ok: false, error: 'Promoting a lead needs the network or admin role' };
  }
  if (!Number.isFinite(leadId)) return { ok: false, error: 'Bad lead id' };

  try {
    const row = await queryOne<{ id: number }>(
      `SELECT atlas.promote_discovered_lab($1, $2) AS id`, [leadId, me.id]);
    revalidatePath('/commitments');
    return { ok: true, id: row?.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Dismiss a lead that turned out to be wrong, without deleting the evidence. */
export async function dismissDiscoveredLab(leadId: number): Promise<R> {
  const me = await getSessionUser();
  if (!me) return { ok: false, error: 'unauthenticated' };
  if (!canManage(me, 'commitments')) {
    return { ok: false, error: 'Dismissing a lead needs the network or admin role' };
  }
  await queryOne(`UPDATE atlas.discovered_lab SET dismissed = true WHERE id = $1`, [leadId]);
  revalidatePath('/commitments');
  return { ok: true };
}

/**
 * Reconcile the ledger against the console on demand.
 *
 * The poller runs every few minutes anyway; this exists so somebody who has
 * just moved an order in the console can see it reflected without waiting,
 * which is the moment they are most likely to distrust the screen.
 */
export async function syncCommitments(): Promise<R & { opened?: number; closed?: number }> {
  const me = await getSessionUser();
  if (!me) return { ok: false, error: 'unauthenticated' };
  if (!canManage(me, 'commitments')) {
    return { ok: false, error: 'Needs the network or admin role' };
  }
  const row = await queryOne<{ opened: number; closed: number; expired: number; crm_created: number }>(
    `SELECT * FROM atlas.sync_commitments_full()`);
  revalidatePath('/commitments');
  return { ok: true, opened: row?.opened, closed: row?.closed };
}

/**
 * Look for labs in a pincode we cannot reach.
 *
 * Triggered from the request the network team is looking at, rather than only
 * by the nightly batch — when someone is working a supply gap now, "run the
 * script and come back tomorrow" is not an answer.
 *
 * The flag is checked here as well as inside the search. Two checks for one
 * condition looks redundant and is not: this one refuses before the action
 * touches the database at all, so while discovery is off a click cannot write
 * a run row claiming we looked. The one underneath is what protects the batch
 * script and anything else that calls the same function later.
 */
export async function findLabsForPincode(
  pincode: string, city?: string | null, state?: string | null,
  disciplines?: string[] | null,
): Promise<R & { found?: number; provider?: string; costUsd?: number }> {
  const me = await getSessionUser();
  if (!me) return { ok: false, error: 'unauthenticated' };
  if (!canManage(me, 'commitments')) {
    return { ok: false, error: 'Searching for labs needs the network or admin role' };
  }
  if (!discoveryEnabled()) return { ok: false, error: DISABLED_MESSAGE, found: 0 };
  if (!/^\d{6}$/.test(pincode)) return { ok: false, error: 'Bad pincode' };

  const r = await discoverForPincode(pincode, city, state, disciplines);
  revalidatePath(`/requests`);
  return r.error
    ? { ok: false, error: r.error, found: 0 }
    : { ok: true, found: r.found, provider: r.provider, costUsd: r.costUsd };
}

/**
 * Record that a lab does not serve a pincode, whatever its mapping says.
 *
 * LabStack's serviceability is Lab."pincodesServiced", and Atlas reads it
 * faithfully — but the console applies a further rule that is not in the
 * database, so Atlas can offer a lab the console will refuse. Rather than
 * guess at that rule, this lets the person who can see both systems record the
 * truth once, for everyone.
 *
 * Takes effect on the labs list immediately; the state chip follows the next
 * time mv_lab_pincode_home is refreshed, which the block does itself.
 */
export async function blockLabForPincode(
  labId: number, pincode: string, reason?: string,
): Promise<R> {
  const me = await getSessionUser();
  if (!me) return { ok: false, error: 'unauthenticated' };
  if (!canManage(me, 'commitments')) {
    return { ok: false, error: 'Marking a lab needs the network or admin role' };
  }
  if (!Number.isFinite(labId) || !/^\d{6}$/.test(pincode)) {
    return { ok: false, error: 'Bad lab or pincode' };
  }

  try {
    await queryOne(`
      INSERT INTO atlas.lab_pincode_block (lab_id, pincode, reason, blocked_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (lab_id, pincode) DO UPDATE
        SET reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by
    `, [labId, pincode, reason ?? null, me.id]);
    // Coverage is a materialized view, so the exclusion is not visible to the
    // classification until it is rebuilt. Cheap enough to do inline.
    await queryOne(`REFRESH MATERIALIZED VIEW analytics.mv_lab_pincode_home`);
    revalidatePath(`/requests`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Undo a block, for when it was recorded in error. */
export async function unblockLabForPincode(labId: number, pincode: string): Promise<R> {
  const me = await getSessionUser();
  if (!me) return { ok: false, error: 'unauthenticated' };
  if (!canManage(me, 'commitments')) return { ok: false, error: 'Needs the network or admin role' };
  await queryOne(`DELETE FROM atlas.lab_pincode_block WHERE lab_id = $1 AND pincode = $2`,
                 [labId, pincode]);
  await queryOne(`REFRESH MATERIALIZED VIEW analytics.mv_lab_pincode_home`);
  revalidatePath(`/requests`);
  return { ok: true };
}

/**
 * Pull anything new from LabStack, now.
 *
 * The poller already does this every ten minutes, so this exists for the
 * minute after somebody creates a request in the console and comes here
 * expecting to see it. Waiting ten minutes to be believed is how a queue stops
 * being trusted as the live view.
 *
 * Deliberately narrow: a six-hour lookback and a concurrent refresh, roughly
 * six seconds. A wider sync would hold the HTTP request long enough for a
 * proxy to cut it, and the client would get nothing at all.
 */
export async function refreshRequests(): Promise<
  R & { synced?: number; newestId?: number; newestAt?: string | null }
> {
  const me = await getSessionUser();
  if (!me) return { ok: false, error: 'unauthenticated' };

  try {
    const synced = await queryOne<{ requests: number }>(
      `SELECT requests FROM atlas.sync_recent_requests(6)`);
    // CONCURRENTLY so nobody else's page blocks while this runs.
    await queryOne(`REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_request_state`);

    const newest = await queryOne<{ id: number; at: string }>(
      `SELECT MAX(request_id) AS id, MAX(created_at)::text AS at
         FROM analytics.mv_request_state`);

    revalidatePath('/requests');
    return {
      ok: true,
      synced: synced?.requests ?? 0,
      newestId: newest?.id,
      newestAt: newest?.at ?? null,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
