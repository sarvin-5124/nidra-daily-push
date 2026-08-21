// Nidra backend client: public catalog reads + the admin broadcast endpoints.

export type CatalogKind = 'sessions' | 'soundscapes' | 'stories' | 'meditations';

export interface CatalogItem {
  id: string;
  title?: string;
  durationMin?: number;
}

export interface SendResult {
  campaignId: string;
  targetedCount: number;
  audienceDesc?: string;
  status?: string;
}

export interface Campaign {
  status: string; // queued | sending | completed | partial | failed
  targetedCount: number;
  sentCount: number;
  failedCount: number;
}

const BASE = (process.env.NIDRA_API_URL || '').replace(/\/$/, '');
const USER = process.env.NIDRA_ADMIN_USER || '';
const PASS = process.env.NIDRA_ADMIN_PASS || '';

function requireBase(): string {
  if (!BASE) throw new Error('NIDRA_API_URL is not set');
  return BASE;
}

function adminHeaders(): Record<string, string> {
  if (!USER || !PASS) throw new Error('NIDRA_ADMIN_USER / NIDRA_ADMIN_PASS are not set');
  return {
    Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    // Truncated: an admin 4xx echoes the request, which can be long.
    throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${what}: response was not JSON: ${text.slice(0, 200)}`);
  }
}

export async function fetchCatalog(kind: CatalogKind): Promise<CatalogItem[]> {
  const res = await fetch(`${requireBase()}/v1/catalog/${kind}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const data = await json<{ items?: CatalogItem[] }>(res, `catalog ${kind}`);
  return data.items ?? [];
}

export interface SendPayload {
  audience: { mode: string; segment?: Record<string, unknown> };
  title: string;
  body: string;
  imageUrl?: string;
  route?: string;
  data?: Record<string, string>;
  sentBy?: string;
}

export async function sendCampaign(payload: SendPayload): Promise<SendResult> {
  const res = await fetch(`${requireBase()}/admin/notifications/send`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  return json<SendResult>(res, 'admin send');
}

export async function getCampaign(id: string): Promise<Campaign> {
  const res = await fetch(
    `${requireBase()}/admin/notifications/campaign/${encodeURIComponent(id)}`,
    { headers: adminHeaders(), signal: AbortSignal.timeout(30_000) },
  );
  return json<Campaign>(res, 'admin campaign');
}

/**
 * Polls a campaign to a terminal status. The backend fans out in a background
 * goroutine, so an accepted send says nothing about delivery — only the
 * campaign doc does.
 */
export async function waitForCampaign(
  id: string,
  { timeoutMs = 10 * 60_000, intervalMs = 5_000 } = {},
): Promise<Campaign> {
  const terminal = new Set(['completed', 'partial', 'failed']);
  const deadline = Date.now() + timeoutMs;
  let last: Campaign | null = null;
  while (Date.now() < deadline) {
    try {
      last = await getCampaign(id);
      console.log(
        `[campaign ${id}] status=${last.status} sent=${last.sentCount} failed=${last.failedCount} of ${last.targetedCount}`,
      );
      if (terminal.has(last.status)) return last;
    } catch (e) {
      // A transient poll failure is not a send failure — keep polling.
      console.warn(`[campaign ${id}] poll error: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `campaign ${id} did not reach a terminal status within ${Math.round(timeoutMs / 60_000)} min` +
      (last ? ` (last: ${last.status}, ${last.sentCount} sent, ${last.failedCount} failed)` : ''),
  );
}
