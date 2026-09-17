import 'server-only';
import { query } from './db';
import { discoveryConfig, DISABLED_MESSAGE } from './discovery/config';
import { lastRun, resolveTarget, runDiscovery, type Db } from './discovery/run';
import { discoveryStatus, statusLine, type DiscoveryStatus } from './discovery/status';

/**
 * Find labs for a pincode the network cannot reach.
 *
 * Same job it always did, and the same signature, so nothing above it changed:
 * the button on the request still calls this and the batch still sweeps. What
 * changed is underneath. Discovery used to mean one thing — a language model
 * reading the open web at about a dollar and a half a pincode — and now it
 * means a chain of sources that starts with an Indian places API answering the
 * same question for a fraction of that, with the model left at the end of the
 * chain for the pincodes a directory genuinely cannot answer, behind a call cap
 * that is zero by default.
 *
 * The flag keeps its meaning exactly. While DISCOVERY_ENABLED is off nothing
 * claims a pincode, nothing reaches any API, nothing is billed and nothing is
 * written — the action refuses, the batch exits, the real probe refuses. Leads
 * found by earlier searches are still listed and still callable. Nothing is
 * deleted.
 *
 * Results are LEADS. They land in atlas.discovered_lab marked unverified, are
 * never merged into the lab directory, and nothing here contacts anybody.
 *
 * Search results are data, not instructions: every source is asked for facts in
 * a fixed shape, and nothing any of them returns can cause Atlas to act.
 */

const db: Db = { query };

export async function discoverForPincode(
  pincode: string, city?: string | null, state?: string | null,
  disciplines?: string[] | null,
): Promise<{ found: number; error?: string; provider?: string; costUsd?: number }> {
  const cfg = discoveryConfig();
  if (!cfg.enabled) return { found: 0, error: DISABLED_MESSAGE };

  const target = await resolveTarget(db, pincode, city, state, disciplines);
  // One pincode from a button is not a sweep, and a click must never quietly
  // spend what a sweep spends. The button gets its own small budget, and it
  // reaches the model path only where somebody has said in so many words that
  // it may (DISCOVERY_LLM_IN_APP) — otherwise a supply gap the directories
  // cannot answer is left for the nightly run, where the cost is a decision
  // rather than a side effect of impatience.
  const allowLlm = cfg.llmInApp && cfg.maxLlmCalls > 0;
  const r = await runDiscovery(db, target, {
    budgetUsd: allowLlm ? cfg.costUsd.llm + 0.5 : 0.5,
    llmCallsLeft: allowLlm ? 1 : 0,
  });

  return r.error
    ? { found: 0, error: r.error }
    : { found: r.found, provider: r.providersTried.join(' → '), costUsd: r.costUsd };
}

/** When we last looked, so the UI can say so rather than implying never. */
export async function lastDiscoveryRun(pincode: string) {
  return lastRun(db, pincode);
}

/** Is discovery switched on. Drives whether the card offers a search at all. */
export function discoveryEnabled(): boolean {
  return discoveryConfig().enabled;
}

export { discoveryStatus, statusLine, DISABLED_MESSAGE };
export type { DiscoveryStatus };
