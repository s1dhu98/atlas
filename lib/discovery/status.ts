/**
 * What discovery would do, without doing any of it.
 *
 * The old debug probe had to run a real search to tell you anything, which
 * meant the one command for "is this configured correctly" was also a command
 * that spent money and was therefore refused while the flag was off — exactly
 * when you most want to check. This answers from configuration alone: free,
 * safe while off, and honest about the difference between "ready" and "would
 * find something".
 *
 * There is still a probe that performs a real search (`npm run labs:discover --
 * --probe <pincode>`), and it still refuses while the flag is off. This is the
 * one you reach for first.
 */

import { chainTypos, discoveryConfig } from './config';
import { PROVIDERS } from './providers';
import type { DiscoveryTarget, ProviderName } from './types';

export type DiscoveryStatus = {
  enabled: boolean;
  chain: ProviderName[];
  chainIgnored: string[];
  minLeads: number;
  minScore: number;
  radiusM: number;
  budgetUsd: number;
  maxLlmCalls: number;
  llmInApp: boolean;
  providers: {
    provider: ProviderName;
    ready: boolean;
    why: string | null;
    costPerPincodeUsd: number;
  }[];
  /** Cost of sweeping this many pincodes if every one fell through to each provider. */
  worstCaseSweepUsd: number;
  /** Cost if the first ready provider answers every pincode, which is the usual case. */
  expectedSweepUsd: number;
  sweepSize: number;
};

/**
 * A stand-in target for readiness checks.
 *
 * Carries a centroid because a provider that needs one (Mappls) would
 * otherwise report itself unavailable for reasons that have nothing to do with
 * configuration, and the probe would blame the wrong thing.
 */
const SAMPLE: DiscoveryTarget = {
  pincode: '000000', city: null, state: null, disciplines: null, lat: 19.076, lng: 72.877,
};

export function discoveryStatus(sweepSize = 310): DiscoveryStatus {
  const cfg = discoveryConfig();
  const providers = cfg.chain.map((name) => {
    const p = PROVIDERS[name];
    const why = p.unavailable(SAMPLE);
    return { provider: name, ready: why === null, why, costPerPincodeUsd: p.costPerPincodeUsd() };
  });

  const ready = providers.filter((p) => p.ready);
  const worst = providers.reduce((sum, p) => sum + p.costPerPincodeUsd * sweepSize, 0);
  const expected = (ready[0]?.costPerPincodeUsd ?? 0) * sweepSize;

  return {
    enabled: cfg.enabled,
    chain: cfg.chain,
    chainIgnored: chainTypos(),
    minLeads: cfg.minLeads,
    minScore: cfg.minScore,
    radiusM: cfg.radiusM,
    budgetUsd: cfg.budgetUsd,
    maxLlmCalls: cfg.maxLlmCalls,
    llmInApp: cfg.llmInApp,
    providers,
    worstCaseSweepUsd: Math.round(worst * 100) / 100,
    expectedSweepUsd: Math.round(expected * 100) / 100,
    sweepSize,
  };
}

/** One line for a console or a card. */
export function statusLine(s: DiscoveryStatus): string {
  if (!s.enabled) return 'Discovery is off. Nothing is searched and nothing is billed.';
  const ready = s.providers.filter((p) => p.ready).map((p) => p.provider);
  if (!ready.length) return 'Discovery is on but no source is configured — every search will refuse.';
  return `Discovery is on via ${ready.join(' → ')}; a ${s.sweepSize}-pincode sweep costs about $${s.expectedSweepUsd.toFixed(2)}.`;
}
