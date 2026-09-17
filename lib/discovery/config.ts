/**
 * Discovery configuration, read from the environment in one place.
 *
 * DISCOVERY_ENABLED stays off by default and keeps the meaning it had: while
 * it is off nothing claims a pincode, nothing reaches any API and nothing is
 * billed. The action refuses, the batch script exits, the probe refuses. What
 * changed is the price of switching it on — the chain below reaches a places
 * API first, and the language model is a floor under the chain rather than the
 * whole of it.
 *
 * Nothing here imports 'server-only': the batch script is a plain node process
 * and needs the same numbers the app uses. Nothing here reads the database or
 * the network either, so it is safe to import from anywhere.
 */

import { isProviderName, type ProviderName } from './types';

const truthy = (v: string | undefined) =>
  v != null && /^(1|true|yes|on)$/i.test(v.trim());

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Default cost per pincode, USD.
 *
 * These are estimates and they will drift, which is why they are overridable
 * rather than compiled in as facts. The llm figure is the measured one — about
 * a dollar and a half a pincode, 310 supply-gap pincodes, four hundred and
 * sixty-five dollars to sweep the backlog once. That number is the entire
 * reason this file exists.
 *
 * Mappls defaults to zero because its free tier covers a sweep of this size;
 * set DISCOVERY_COST_MAPPLS_USD if your plan is metered, or the ledger will
 * under-report.
 */
const DEFAULT_COST_USD: Record<ProviderName, number> = {
  mappls: 0,
  ola: 0.002,
  google: 0.035,
  llm: 1.5,
};

export type DiscoveryConfig = {
  enabled: boolean;
  /** Providers to try, in order, until minLeads is reached. */
  chain: ProviderName[];
  /** Stop walking the chain once this many usable leads are in hand. */
  minLeads: number;
  /** Drop anything the ranking layer scores below this. */
  minScore: number;
  /** How far from the pincode centroid a place may be and still be offered. */
  radiusM: number;
  /** Hard ceiling on one batch run. The script stops rather than overspend. */
  budgetUsd: number;
  /**
   * The model path is opt-in twice: it has to be in the chain AND under this
   * cap. A chain with 'llm' in it and a cap of zero is a chain that never
   * reaches it, which is the safe default for a flag somebody just switched on.
   */
  maxLlmCalls: number;
  /**
   * Whether the button on a request may reach the model path at all.
   *
   * Off by default and separate from maxLlmCalls, because a nightly sweep
   * spending a dollar and a half on a pincode nobody can otherwise serve is a
   * decision somebody made, and a click doing the same thing silently is not.
   */
  llmInApp: boolean;
  costUsd: Record<ProviderName, number>;
  keys: {
    mapplsClientId?: string;
    mapplsClientSecret?: string;
    olaApiKey?: string;
    googleApiKey?: string;
    anthropicKey?: string;
  };
};

export function discoveryConfig(env: NodeJS.ProcessEnv = process.env): DiscoveryConfig {
  const rawChain = (env.DISCOVERY_PROVIDERS ?? 'mappls,ola,google')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  // An unrecognised provider name is dropped rather than thrown on. A typo in
  // a compose file should not take the whole app down at import time — but it
  // must be visible, which is what the probe's `chainIgnored` is for.
  const chain = rawChain.filter(isProviderName);

  return {
    enabled: truthy(env.DISCOVERY_ENABLED),
    chain,
    minLeads: Math.max(1, num(env.DISCOVERY_MIN_LEADS, 2)),
    minScore: num(env.DISCOVERY_MIN_SCORE, 0.25),
    radiusM: num(env.DISCOVERY_RADIUS_M, 6000),
    budgetUsd: num(env.DISCOVERY_BUDGET_USD, 15),
    maxLlmCalls: Math.max(0, Math.floor(num(env.DISCOVERY_MAX_LLM_CALLS, 0))),
    llmInApp: truthy(env.DISCOVERY_LLM_IN_APP),
    costUsd: {
      mappls: num(env.DISCOVERY_COST_MAPPLS_USD, DEFAULT_COST_USD.mappls),
      ola: num(env.DISCOVERY_COST_OLA_USD, DEFAULT_COST_USD.ola),
      google: num(env.DISCOVERY_COST_GOOGLE_USD, DEFAULT_COST_USD.google),
      llm: num(env.DISCOVERY_COST_LLM_USD, DEFAULT_COST_USD.llm),
    },
    keys: {
      mapplsClientId: env.MAPPLS_CLIENT_ID || undefined,
      mapplsClientSecret: env.MAPPLS_CLIENT_SECRET || undefined,
      olaApiKey: env.OLA_MAPS_API_KEY || undefined,
      googleApiKey: env.GOOGLE_PLACES_API_KEY || undefined,
      anthropicKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || undefined,
    },
  };
}

/** The one sentence every refusal says, so they all say the same thing. */
export const DISABLED_MESSAGE =
  'Discovery is switched off (DISCOVERY_ENABLED is not set). ' +
  'Nothing was searched, nothing was billed. Leads already found are still listed.';

/** Ignored entries in DISCOVERY_PROVIDERS — a typo, surfaced rather than swallowed. */
export function chainTypos(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DISCOVERY_PROVIDERS ?? '')
    .split(',').map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && !isProviderName(s));
}
