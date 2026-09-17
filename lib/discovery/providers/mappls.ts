/**
 * Mappls (MapmyIndia) — the primary source.
 *
 * First in the chain for two reasons, one commercial and one legal. It is an
 * Indian directory of Indian businesses, so its coverage of a 413xxx pincode
 * is better than a global provider's and its free tier covers a sweep of three
 * hundred pincodes outright. And unlike Google, its terms do not forbid
 * retaining the name, address and phone of a place past a caching window —
 * which matters because promoting a lead into CRM is exactly that retention,
 * and a source we have to purge in thirty days is not a source we can build a
 * network on.
 *
 * It publishes no ratings. That is fine: the ranking layer treats a missing
 * rating as missing evidence and says so in a caveat rather than pretending.
 */

import type { DiscoveryProvider, DiscoveryTarget, PlaceHit, ProviderOutcome } from '../types';
import { emptyHit } from '../types';
import { discoveryConfig } from '../config';
import { getJson, numOrNull, pick, queriesFor, strOrNull, describeError } from './shared';

const TOKEN_URL = 'https://outpost.mappls.com/api/security/oauth/token';
const NEARBY_URL = 'https://atlas.mappls.com/api/places/nearby/json';

/**
 * The OAuth token, cached for the process.
 *
 * Mappls issues a bearer token valid for hours and rate-limits the token
 * endpoint harder than the search endpoint, so fetching one per search is the
 * quickest way to turn a working integration into a 429. Refreshed a minute
 * early to avoid racing the expiry.
 */
let token: { value: string; expiresAt: number } | null = null;

async function bearer(id: string, secret: string): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: id, client_secret: secret,
  });
  const json = await getJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const value = strOrNull(json?.access_token);
  if (!value) throw new Error('Mappls returned no access_token');
  const ttl = numOrNull(json?.expires_in) ?? 3600;
  token = { value, expiresAt: Date.now() + Math.max(60, ttl - 60) * 1000 };
  return value;
}

/** Forget the cached token. Used by the probe so it tests the real handshake. */
export function resetMapplsToken(): void { token = null; }

/**
 * Read one result row.
 *
 * Written defensively on purpose: Mappls has shipped more than one response
 * shape for nearby search and the field names differ between the suggest and
 * the nearby endpoints. Reading whichever of the plausible names is present
 * costs nothing and survives the next rename; assuming one shape produces an
 * empty result set that looks exactly like a barren pincode.
 */
function toHit(r: any): PlaceHit | null {
  const name = pick(r, 'placeName', 'poi', 'name', 'placeAddress');
  if (!name) return null;
  const hit = emptyHit(name);
  hit.address = pick(r, 'placeAddress', 'address', 'formattedAddress');
  hit.phone = pick(r, 'tel', 'phone', 'mobileNo', 'contactNumber');
  hit.lat = numOrNull(r?.latitude ?? r?.lat ?? r?.entryLatitude);
  hit.lng = numOrNull(r?.longitude ?? r?.lng ?? r?.entryLongitude);
  hit.externalId = pick(r, 'eLoc', 'placeId', 'id');
  const cat = pick(r, 'type', 'categoryName', 'keywords', 'richInfo');
  hit.categories = cat ? [cat] : [];
  hit.sourceUrl = hit.externalId ? `https://maps.mappls.com/${hit.externalId}` : null;
  // Mappls does not publish a status field; absence is not "closed".
  hit.businessStatus = null;
  return hit;
}

export const mapplsProvider: DiscoveryProvider = {
  name: 'mappls',

  unavailable(t: DiscoveryTarget): string | null {
    const { keys } = discoveryConfig();
    if (!keys.mapplsClientId || !keys.mapplsClientSecret) {
      return 'MAPPLS_CLIENT_ID / MAPPLS_CLIENT_SECRET not set';
    }
    // Nearby search is anchored on a point. Without a centroid there is nothing
    // to anchor it to, and the ~1% of pincodes India Post gives us no fix for
    // should fall through to a provider that takes free text.
    if (t.lat == null || t.lng == null) return 'no centroid for this pincode';
    return null;
  },

  costPerPincodeUsd() { return discoveryConfig().costUsd.mappls; },

  async search(t: DiscoveryTarget): Promise<ProviderOutcome> {
    const cfg = discoveryConfig();
    const out: ProviderOutcome = { provider: 'mappls', hits: [], calls: 0, costUsd: 0 };
    try {
      const auth = await bearer(cfg.keys.mapplsClientId!, cfg.keys.mapplsClientSecret!);
      for (const q of queriesFor(t)) {
        const url =
          `${NEARBY_URL}?keywords=${encodeURIComponent(q)}` +
          `&refLocation=${t.lat},${t.lng}&radius=${Math.round(cfg.radiusM)}&page=1`;
        const json = await getJson(url, { headers: { Authorization: `Bearer ${auth}` } });
        out.calls += 1;
        const rows: any[] = json?.suggestedLocations ?? json?.results ?? json?.data ?? [];
        for (const r of rows) {
          const hit = toHit(r);
          if (hit) out.hits.push(hit);
        }
      }
      out.costUsd = out.calls * (cfg.costUsd.mappls / Math.max(1, queriesFor(t).length));
      return out;
    } catch (e) {
      out.error = describeError(e);
      return out;
    }
  },
};
