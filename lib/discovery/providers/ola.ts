/**
 * Ola Maps — the second Indian source.
 *
 * Here mainly so that a lead can be corroborated by a source that is not the
 * first one. Two independent directories naming the same lab at the same
 * coordinates is the strongest cheap signal available, and the ranking layer
 * pays for it: a merged lead gains score and says which sources agreed.
 *
 * Takes free text, so unlike Mappls it still works for the pincodes India Post
 * gives us no centroid for.
 */

import type { DiscoveryProvider, DiscoveryTarget, PlaceHit, ProviderOutcome } from '../types';
import { emptyHit } from '../types';
import { discoveryConfig } from '../config';
import { getJson, numOrNull, pick, queriesFor, describeError } from './shared';

const TEXT_SEARCH_URL = 'https://api.olamaps.io/places/v1/textsearch';

function toHit(r: any): PlaceHit | null {
  const name =
    pick(r, 'name', 'description') ??
    pick(r?.structured_formatting ?? {}, 'main_text');
  if (!name) return null;
  const hit = emptyHit(name);
  hit.address =
    pick(r, 'formatted_address', 'vicinity', 'description') ??
    pick(r?.structured_formatting ?? {}, 'secondary_text');
  hit.phone = pick(r, 'formatted_phone_number', 'international_phone_number', 'phone');
  hit.lat = numOrNull(r?.geometry?.location?.lat ?? r?.location?.lat ?? r?.lat);
  hit.lng = numOrNull(r?.geometry?.location?.lng ?? r?.location?.lng ?? r?.lng);
  hit.externalId = pick(r, 'place_id', 'id');
  hit.categories = Array.isArray(r?.types) ? r.types.filter((x: unknown) => typeof x === 'string') : [];
  hit.rating = numOrNull(r?.rating);
  hit.reviewCount = numOrNull(r?.user_ratings_total ?? r?.userRatingCount);
  hit.sourceUrl = 'https://maps.olakrutrim.com/';
  const status = pick(r, 'business_status');
  hit.businessStatus =
    status === 'OPERATIONAL' || status === 'CLOSED_TEMPORARILY' || status === 'CLOSED_PERMANENTLY'
      ? status : null;
  return hit;
}

export const olaProvider: DiscoveryProvider = {
  name: 'ola',

  unavailable(): string | null {
    return discoveryConfig().keys.olaApiKey ? null : 'OLA_MAPS_API_KEY not set';
  },

  costPerPincodeUsd() { return discoveryConfig().costUsd.ola; },

  async search(t: DiscoveryTarget): Promise<ProviderOutcome> {
    const cfg = discoveryConfig();
    const out: ProviderOutcome = { provider: 'ola', hits: [], calls: 0, costUsd: 0 };
    const queries = queriesFor(t);
    try {
      for (const q of queries) {
        const loc = t.lat != null && t.lng != null
          ? `&location=${t.lat},${t.lng}&radius=${Math.round(cfg.radiusM)}` : '';
        const url =
          `${TEXT_SEARCH_URL}?input=${encodeURIComponent(q)}${loc}` +
          `&api_key=${encodeURIComponent(cfg.keys.olaApiKey!)}`;
        const json = await getJson(url);
        out.calls += 1;
        const rows: any[] = json?.predictions ?? json?.results ?? [];
        for (const r of rows) {
          const hit = toHit(r);
          if (hit) out.hits.push(hit);
        }
      }
      out.costUsd = out.calls * (cfg.costUsd.ola / Math.max(1, queries.length));
      return out;
    } catch (e) {
      out.error = describeError(e);
      return out;
    }
  },
};
