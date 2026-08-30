// ntfy.sh status pings. Published as JSON to the base URL rather than via
// X-Title/X-Tags headers: header values must be ASCII, and notification copy
// routinely contains emoji and typographic punctuation.

type Level = "ok" | "fail" | "info";

const BASE = (process.env.NTFY_BASE || "https://ntfy.sh").replace(/\/$/, "");
const TOPIC_OK = process.env.NTFY_TOPIC_OK || "";
const TOPIC_FAIL = process.env.NTFY_TOPIC_FAIL || "";
const TOKEN = process.env.NTFY_TOKEN || "";

/**
 * Where a page should send you to act on it. Was a link to the GitHub run;
 * there is no run any more, and the dashboard is the place where a stuck slot
 * can actually be resolved.
 */
const LINK = (process.env.DASHBOARD_URL || "").replace(/\/$/, "");

export async function notify(
  level: Level,
  title: string,
  message: string,
  tags: string[] = [],
): Promise<void> {
  const topic = level === "fail" ? TOPIC_FAIL : TOPIC_OK;
  if (!topic) {
    console.warn(
      `[ntfy] no topic configured for level=${level}; skipping ping`,
    );
    return;
  }
  const body: Record<string, unknown> = {
    topic,
    title,
    message: LINK ? `${message}\n\n${LINK}` : message,
    tags: tags.length
      ? tags
      : [level === "fail" ? "rotating_light" : "white_check_mark"],
    priority: level === "fail" ? 4 : 3,
  };
  if (LINK) body.click = LINK;

  try {
    const res = await fetch(`${BASE}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok)
      console.warn(
        `[ntfy] publish failed: HTTP ${res.status} ${await res.text()}`,
      );
  } catch (e) {
    // A dead status channel must never fail a run that otherwise succeeded.
    console.warn(`[ntfy] publish error: ${(e as Error).message}`);
  }
}
