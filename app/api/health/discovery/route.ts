import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { canManage } from '@/lib/access';
import { discoveryStatus, statusLine } from '@/lib/discoverLabs';

/**
 * The free probe: what discovery would do, without doing any of it.
 *
 * The old probe could only answer by running a real search, so the single
 * command for "is this wired up correctly" was also a command that spent money
 * — and was therefore refused while the flag was off, which is precisely when
 * you want to check. This answers from configuration alone. It reaches no API,
 * writes no row and costs nothing, so it works identically with the flag on or
 * off, and the difference between the two is visible in its first field.
 *
 * The probe that performs a real search still exists and still refuses while
 * the flag is off: `npm run labs:discover -- --probe <pincode>`.
 *
 * Explicitly gated rather than leaning on the middleware's /api/health
 * allowance: this says which credentials are present and what a sweep would
 * cost, which is nobody's business but the network team's. It reports presence,
 * never a value — no key or fragment of one appears in the response.
 */
export async function GET() {
  const me = await getSessionUser();
  if (!me) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!canManage(me, 'commitments')) {
    return NextResponse.json({ error: 'needs the network or admin role' }, { status: 403 });
  }

  const status = discoveryStatus();
  return NextResponse.json({
    summary: statusLine(status),
    ...status,
    note: 'Configuration only. No search was performed and nothing was billed.',
  });
}
