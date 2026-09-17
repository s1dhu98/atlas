/**
 * Google Places (New) Text Search — the fallback with the best coverage and
 * the tightest strings attached.
 *
 * Last of the API providers rather than first, deliberately. Its coverage of a
 * small-town Indian pincode is usually the best of the three and it is the only
 * one of them that publishes ratings and review counts. But Google's terms
 * permit indefinite storage of the place id and very little else: name,
 * address and phone are cached content with an expiry, and promoting a lead
 * into CRM is precisely the indefinite retention those terms exclude. So
 * Google is here to fill gaps the Indian directories leave, its rows are
 * marked with their source, and atlas.purge_expired_discovery() clears
 * unpromoted Google rows on the retention window (see 17_discovery_sources.sql).
 * A lead somebody has called, verified and promoted has become our own record
 * of our own relationship, which is a different thing from a cached search
 * result.
 *
 * The field mask is not decoration — it is what you are billed on. Asking for
 * rating and phone moves the call into the Enterprise tier; drop those two and
 * it falls to Pro. Both are still two orders of magnitude under a model reading
 * the web.
 */

import type { DiscoveryProvider, DiscoveryTarget, PlaceHit, ProviderOutcome } from '../types';
import { emptyHit } from '../types';
import { discoveryConfig } from '../config';
import { getJson, numOrNull, queriesFor, strOrNull, describeError } from './shared';

const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

/** Exactly the fields the ranking layer reads. Every extra one costs money. */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.primaryType',
  'places.types',
  'places.businessStatus',
  'places.nationalPhoneNumber',
  'places.rating',
  'places.userRatingCount',
].join(',');

function toHit(p: any): PlaceHit | null {
  const name = strOrNull(p?.displayName?.text ?? p?.displayName);
  if (!name) return null;
  const hit = emptyHit(name);
  hit.address = strOrNull(p?.formattedAddress);
  hit.phone = strOrNull(p?.nationalPhoneNumber);
  hit.lat = numOrNull(p?.location?.latitude);
  hit.lng = numOrNull(p?.location?.longitude);
  hit.rating = numOrNull(p?.rating);
  hit.reviewCount = numOrNull(p?.userRatingCount);
  hit.externalId = strOrNull(p?.id);
  const types: string[] = Array.isArray(p?.types) ? p.types : [];
  const primary = strOrNull(p?.primaryType);
  hit.categories = Array.from(new Set([...(primary ? [primary] : []), ...types]));
  hit.sourceUrl = hit.externalId
    ? `https://www.google.com/maps/place/?q=place_id:${hit.externalId}` : null;
  const status = strOrNull(p?.businessStatus);
  hit.businessStatus =
    status === 'OPERATIONAL' || status === 'CLOSED_TEMPORARILY' || status === 'CLOSED_PERMANENTLY'
      ? status : null;
  return hit;
}

export const googleProvider: DiscoveryProvider = {
  name: 'google',

  unavailable(): string | null {
    return discoveryConfig().keys.googleApiKey ? null : 'GOOGLE_PLACES_API_KEY not set';
  },

  costPerPincodeUsd() { return discoveryConfig().costUsd.google; },

  async search(t: DiscoveryTarget): Promise<ProviderOutcome> {
    const cfg = discoveryConfig();
    const out: ProviderOutcome = { provider: 'google', hits: [], calls: 0, costUsd: 0 };
    const queries = queriesFor(t);
    // Accrued per successful call, not after the loop: a provider that dies
    // partway has still billed for the calls it did answer.
    const perCall = cfg.costUsd.google / Math.max(1, queries.length);
    try {
      for (const q of queries) {
        const body: Record<string, unknown> = {
          textQuery: q,
          regionCode: 'IN',
          languageCode: 'en',
          // Ten is plenty. The ranking layer discards most of a longer page and
          // a second page is a second billable call for worse candidates.
          pageSize: 10,
        };
        if (t.lat != null && t.lng != null) {
          body.locationBias = {
            circle: { center: { latitude: t.lat, longitude: t.lng }, radius: cfg.radiusM },
          };
        }
        const json = await getJson(SEARCH_TEXT_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Goog-Api-Key': cfg.keys.googleApiKey!,
            'X-Goog-FieldMask': FIELD_MASK,
          },
          body: JSON.stringify(body),
        });
        out.calls += 1;
        out.costUsd = out.calls * perCall;
        for (const p of (json?.places ?? []) as any[]) {
          const hit = toHit(p);
          if (hit) out.hits.push(hit);
        }
      }
      return out;
    } catch (e) {
      out.error = describeError(e);
      return out;
    }
  },
};
