#!/usr/bin/env bun
/**
 * Service entry point. One process holds all three jobs, which is what makes
 * the locking trivial: the tick that sends and the HTTP route that sends share
 * an in-memory lock instead of coordinating through a distributed guard.
 *
 *   scheduler  — plans days, fires slots on time
 *   server     — dashboard + read API + guarded actions
 *   mirror     — nightly copy of the volume back into git
 */
import { captureConsole } from "./runlog.ts";
import { ensureDataDir } from "./paths.ts";
import { maybeMirror } from "./mirror.ts";
import { schedulerHealth, startScheduler } from "./scheduler.ts";
import { startServer } from "./server.ts";

/** How often to ask the mirror whether it is due. Cheap: two comparisons. */
const MIRROR_CHECK_MS = 5 * 60_000;
/** How long a shutdown waits for an in-flight broadcast to finish recording. */
const DRAIN_TIMEOUT_MS = 2 * 60_000;

captureConsole();
ensureDataDir();

// Bind the port BEFORE anything that touches state. The scheduler's startup
// sweep rewrites schedule files, and when that ran first a second copy of the
// service would mutate the volume and only then discover the port was taken.
const server = startServer();
const stopScheduler = startScheduler();

const mirrorTimer = setInterval(() => void maybeMirror(), MIRROR_CHECK_MS);
void maybeMirror();

/**
 * Stop cleanly, and actually EXIT.
 *
 * Docker sends SIGTERM on `stop` and on every redeploy. An earlier version
 * cleared the timers and returned, which left Bun.serve holding the process
 * open: the container went on answering HTTP and passing as reachable while the
 * tick loop was dead and no push would ever fire again. `docker stop` then had
 * to wait out its grace period, and `restart: unless-stopped` never fired
 * because nothing had exited. Exiting is the behaviour that lets the restart
 * policy do its job.
 *
 * An in-flight send is drained first, not killed. The campaign poll is what
 * writes the delivery record, and losing it strands the slot at "sending" for
 * recovery to puzzle over.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[main] ${signal} — draining`);
  stopScheduler();
  clearInterval(mirrorTimer);

  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (schedulerHealth().sending.length > 0 && Date.now() < deadline) {
    console.log(
      `[main] waiting on in-flight send: ${schedulerHealth().sending.join(", ")}`,
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
  const stranded = schedulerHealth().sending;
  if (stranded.length)
    console.error(
      `[main] shutting down with ${stranded.join(", ")} still in flight`,
    );

  await server.stop(true);
  console.log("[main] stopped");
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on("unhandledRejection", (reason) => {
  console.error(
    `[main] unhandled rejection: ${reason instanceof Error ? reason.message : reason}`,
  );
});
