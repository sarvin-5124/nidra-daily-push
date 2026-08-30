/**
 * In-memory ring buffer of this process's own log lines, so the dashboard can
 * show what the scheduler has been doing without shelling into the box.
 *
 * Deliberately not a file: the lines are also going to stdout, which Docker
 * already captures and rotates. This buffer exists only to answer "what
 * happened at 14:27?" over HTTP, and losing it on restart is acceptable —
 * the schedule files are the durable record.
 */
import { istISO } from "../scripts/lib/time.ts";

export type Level = "info" | "warn" | "error";
export interface LogLine {
  at: string;
  level: Level;
  msg: string;
}

const MAX_LINES = 1000;
const lines: LogLine[] = [];

export function record(level: Level, msg: string): void {
  lines.push({ at: istISO(new Date()), level, msg });
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

/** Most recent `n` lines, oldest first. */
export function tail(n = 200): LogLine[] {
  return lines.slice(-Math.max(1, Math.min(n, MAX_LINES)));
}

/**
 * Mirror console.* into the buffer. Called once at startup.
 *
 * Wraps rather than replaces: stdout still gets everything, so `docker logs`
 * remains the source of truth and nothing is lost if this process is killed.
 */
export function captureConsole(): void {
  const map: Array<[Level, "log" | "info" | "warn" | "error"]> = [
    ["info", "log"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [level, method] of map) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      try {
        record(level, args.map(stringify).join(" "));
      } catch {
        // Never let logging break the thing being logged.
      }
    };
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
