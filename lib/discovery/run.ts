/**
 * Walk the chain, rank what comes back, write it down, and say what it cost.
 *
 * This is the only place that knows discovery has more than one source, and it
 * is the only place that spends money. Everything above it (the server action,
 * the batch script, the probe) asks this for a pincode and gets the same shape
 * of answer whichever provider actually produced it.
 *
 * The flag is enforced here as well as at every call site. A refusal writes
 * nothing at all — not a run row, not an error row — because a run row is a
 * claim that we looked, and while discovery is off we did not.
 *
 * Deliberately not 'server-only': the batch script is a plain node process and
 * has to run exactly this code, or the two paths drift and the nightly sweep
 * stops matching the button.
 */

import { DISABLED_MESSAGE, discoveryConfig } from './config';
import { dedupe, rankAll } from './rank';
import { PROVIDERS } from './providers';
import type {
  Discipline, DiscoveryTarget, ProviderName, ProviderOutcome, RankedLead,
} from './types';

/**
 * The narrow slice of a database both callers can supply.
 *
 * The app has a pooled `query` from lib/db; the script has its own pg Pool.
 * Rather than have one import the other's connection handling, they each pass
 * this in. It is two lines on each side and it keeps this file runnable from
 * either.
 */
export type Db = { query<T = any>(text: string, params?: any[]): Promise<T[]> };

export type DiscoveryResult = {
  ok: boolean;
  /** Leads kept after ranking and dedupe. What the user will see. */
  found: number;
  /** Raw hits before ranking, for the log — a big gap here means bad queries. */
  raw: number;
  providersTried: ProviderName[];
  providersSkipped: { provider: ProviderName; why: string }[];
  calls: number;
  costUsd: number;
  llmCallsUsed: number;
  error?: string;
};

const EMPTY: Omit<DiscoveryResult, 'ok' | 'error'> = {
  found: 0, raw: 0, providersTried: [], providersSkipped: [], calls: 0, costUsd: 0, llmCallsUsed: 0,
};

/** Centroid and place names for a pincode, from the India Post directory. */
export async function resolveTarget(
  db: Db, pincode: string,
  city?: string | null, state?: string | null, disciplines?: string[] | null,
): Promise<DiscoveryTarget> {
  const rows = await db.query<{ city: string | null; state: string | null; lat: number | null; lng: number | null }>(
    `SELECT city, state, latitude AS lat, longitude AS lng
       FROM atlas.pincode_directory WHERE pincode = $1`, [pincode]);
  const d = rows[0];
  const known: Discipline[] = (disciplines ?? [])
    .filter((x): x is Discipline =>
      x === 'PATHOLOGY' || x === 'RADIOLOGY' || x === 'CARDIO_DIAGNOSTIC');
  return {
    pincode,
    city: city ?? d?.city ?? null,
    state: state ?? d?.state ?? null,
    disciplines: known.length ? known : null,
    lat: d?.lat ?? null,
    lng: d?.lng ?? null,
  };
}

export type RunOpts = {
  /** Stop before a provider whose cost would take the run past this. */
  budgetUsd?: number;
  /** Model calls still allowed in this run. Zero means the model is off. */
  llmCallsLeft?: number;
  /** Search even if this pincode was searched recently. The button does this. */
  force?: boolean;
  /**
   * Override the provider registry.
   *
   * Only the self-test passes this. It exists because the alternative — a test
   * that reaches a live API — is a test that costs money, needs credentials and
   * fails for reasons that have nothing to do with the code, which is to say a
   * test nobody runs. With this, the chain, the budget, the dedupe and every
   * line of the persistence SQL can be exercised against a scratch database for
   * nothing.
   */
  providers?: Partial<Record<ProviderName, import('./types').DiscoveryProvider>>;
};

/**
 * Search one pincode.
 *
 * Walks the configured chain and stops at the first point where it has enough
 * leads, so a pincode a free Indian directory can answer never reaches the
 * metered providers, and almost none of them reach the model.
 */
export async function runDiscovery(
  db: Db, t: DiscoveryTarget, opts: RunOpts = {},
): Promise<DiscoveryResult> {
  const cfg = discoveryConfig();
  if (!cfg.enabled) return { ok: false, ...EMPTY, error: DISABLED_MESSAGE };
  if (!/^\d{6}$/.test(t.pincode)) return { ok: false, ...EMPTY, error: 'Bad pincode' };
  if (cfg.chain.length === 0) {
    return { ok: false, ...EMPTY, error: 'DISCOVERY_PROVIDERS is empty — no source to search.' };
  }

  let budgetLeft = opts.budgetUsd ?? cfg.budgetUsd;
  let llmLeft = opts.llmCallsLeft ?? cfg.maxLlmCalls;

  const tried: ProviderName[] = [];
  const skipped: { provider: ProviderName; why: string }[] = [];
  const outcomes: ProviderOutcome[] = [];
  let leads: RankedLead[] = [];
  let raw = 0;
  let calls = 0;
  let costUsd = 0;
  let llmUsed = 0;

  for (const name of cfg.chain) {
    if (leads.length >= cfg.minLeads) break;

    const provider = opts.providers?.[name] ?? PROVIDERS[name];
    const why = provider.unavailable(t);
    if (why) { skipped.push({ provider: name, why }); continue; }

    if (name === 'llm' && llmLeft <= 0) {
      skipped.push({ provider: name, why: 'model-call budget for this run is used up' });
      continue;
    }
    const price = provider.costPerPincodeUsd();
    if (price > budgetLeft) {
      skipped.push({
        provider: name,
        why: `would cost $${price.toFixed(2)}, only $${budgetLeft.toFixed(2)} left in this run's budget`,
      });
      continue;
    }

    tried.push(name);
    const outcome = await provider.search(t);
    outcomes.push(outcome);
    calls += outcome.calls;
    costUsd += outcome.costUsd;
    budgetLeft -= outcome.costUsd;
    if (name === 'llm') { llmUsed += outcome.calls; llmLeft -= outcome.calls; }
    raw += outcome.hits.length;

    if (outcome.hits.length) {
      leads = dedupe([...leads, ...rankAll(outcome.hits, name, t, cfg.minScore)]);
      leads.sort((a, b) => b.score - a.score);
    }
  }

  // Every provider we actually reached failed, and we have nothing. That is an
  // error worth showing. A provider failing while another succeeded is not.
  const allFailed = tried.length > 0 && outcomes.every((o) => o.error) && leads.length === 0;
  const error = allFailed
    ? outcomes.map((o) => `${o.provider}: ${o.error}`).join(' · ')
    : tried.length === 0
      ? `No usable source. ${skipped.map((s) => `${s.provider}: ${s.why}`).join(' · ')}`
      : undefined;

  await persist(db, t, leads, {
    tried, calls, costUsd, error: error ?? null,
    primary: leads[0]?.provider ?? tried[tried.length - 1] ?? null,
  });

  return {
    ok: !error,
    found: leads.length,
    raw,
    providersTried: tried,
    providersSkipped: skipped,
    calls,
    costUsd: Math.round(costUsd * 10000) / 10000,
    llmCallsUsed: llmUsed,
    error,
  };
}

/**
 * Write the leads and the run.
 *
 * Unchanged in the two ways that matter: a row a human has already verified is
 * never overwritten, and nothing here is merged into the lab directory. What is
 * new is that every row now records which source produced it, what the ranking
 * layer scored it and why — so a lead can be argued with instead of taken on
 * faith.
 */
async function persist(
  db: Db, t: DiscoveryTarget, leads: RankedLead[],
  run: { tried: ProviderName[]; calls: number; costUsd: number; error: string | null; primary: ProviderName | null },
): Promise<void> {
  for (const l of leads) {
    await db.query(`
      INSERT INTO atlas.discovered_lab
        (pincode, name, address, phone, source_url, city, state, confidence, model,
         source, external_id, rating, review_count, lat, lng,
         kinds, pincode_match, distance_km, rank_score, reasons, caveats)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (pincode, lower(name)) DO UPDATE SET
        address       = COALESCE(EXCLUDED.address, atlas.discovered_lab.address),
        phone         = COALESCE(EXCLUDED.phone, atlas.discovered_lab.phone),
        source_url    = EXCLUDED.source_url,
        confidence    = EXCLUDED.confidence,
        source        = EXCLUDED.source,
        external_id   = COALESCE(EXCLUDED.external_id, atlas.discovered_lab.external_id),
        rating        = COALESCE(EXCLUDED.rating, atlas.discovered_lab.rating),
        review_count  = COALESCE(EXCLUDED.review_count, atlas.discovered_lab.review_count),
        lat           = COALESCE(EXCLUDED.lat, atlas.discovered_lab.lat),
        lng           = COALESCE(EXCLUDED.lng, atlas.discovered_lab.lng),
        kinds         = EXCLUDED.kinds,
        pincode_match = EXCLUDED.pincode_match,
        distance_km   = EXCLUDED.distance_km,
        rank_score    = EXCLUDED.rank_score,
        reasons       = EXCLUDED.reasons,
        caveats       = EXCLUDED.caveats,
        retrieved_at  = now()
      -- Never overwrite something a human has already checked.
      WHERE atlas.discovered_lab.verified_at IS NULL
    `, [
      t.pincode, l.name, l.address, l.phone, l.sourceUrl, t.city, t.state,
      l.score, l.provider === 'llm' ? 'claude-opus-5' : null,
      l.provider, l.externalId, l.rating, l.reviewCount, l.lat, l.lng,
      l.kinds, l.pincodeMatch, l.distanceKm, l.score, l.reasons, l.caveats,
    ]);
  }

  await db.query(`
    INSERT INTO atlas.discovery_run
      (pincode, found, model, error, provider, providers_tried, calls, cost_usd)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (pincode) DO UPDATE SET
      ran_at = now(), found = EXCLUDED.found, model = EXCLUDED.model,
      error = EXCLUDED.error, provider = EXCLUDED.provider,
      providers_tried = EXCLUDED.providers_tried,
      calls = EXCLUDED.calls, cost_usd = EXCLUDED.cost_usd
  `, [
    t.pincode, leads.length,
    run.tried.includes('llm') ? 'claude-opus-5' : null,
    run.error, run.primary, run.tried, run.calls, run.costUsd,
  ]);

  // Append-only, because discovery_run only ever holds the latest attempt and
  // "what has this cost us so far" is a question about all of them.
  await db.query(`
    INSERT INTO atlas.discovery_run_log
      (pincode, providers_tried, calls, cost_usd, found, error)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [t.pincode, run.tried, run.calls, run.costUsd, leads.length, run.error]);
}

/** When we last looked, so the UI can say so rather than implying never. */
export async function lastRun(db: Db, pincode: string) {
  const rows = await db.query<{
    ran_at: string; found: number; error: string | null;
    provider: string | null; cost_usd: string | null;
  }>(`SELECT ran_at, found, error, provider, cost_usd
        FROM atlas.discovery_run WHERE pincode = $1`, [pincode]);
  return rows[0] ?? null;
}

/** What a sweep of n pincodes would cost, per provider, before spending any of it. */
export function estimate(n: number): { provider: ProviderName; perPincode: number; total: number }[] {
  const cfg = discoveryConfig();
  return cfg.chain.map((p) => ({
    provider: p,
    perPincode: cfg.costUsd[p],
    total: Math.round(cfg.costUsd[p] * n * 100) / 100,
  }));
}
