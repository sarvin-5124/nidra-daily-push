# GitHub Actions YAML gotchas hit in this repo

## `: ` inside an unquoted `run:` value breaks the whole file
```yaml
# BROKEN — YAML reads the colon-space inside the message as a mapping separator
run: bash .github/scripts/commit-schedules.sh "plan: add next-day push schedule"
```
- The shell quotes do **not** help: the YAML scalar started unquoted at `bash`, and a
  plain scalar may not contain `": "` anywhere. Error: `bad indentation of a mapping entry`,
  with the column pointing at that colon.
- Fix used here — a block scalar, which has no such rule and survives reformatting:
  ```yaml
  run: |
    bash .github/scripts/commit-schedules.sh "plan: add next-day push schedule"
  ```
- **Any** commit message, log line, or `echo` containing `: ` in a one-line `run:` is the
  same bug. Default to `run: |` for anything with punctuation.

## How an invalid workflow presents in the UI (do not chase the wrong thing)
- The run shows **event `push`** even when the workflow has no `push` trigger, **0s duration**,
  `conclusion: failure`, and **`jobs: []`**. No logs exist to read, because nothing ever started.
- `gh api repos/{o}/{r}/actions/workflows` shows the workflow **`name` as its file path**
  (`.github/workflows/execute.yml`) instead of the declared name (`execute-slot`) — GitHub could
  not parse the file far enough to read `name:`. That mismatch is the quickest tell.
- It looks exactly like "my secrets are missing". It is not; the job never ran.

## Reproducing the parse locally
`bunx --yes js-yaml <file>` prints the same class of error with a line:column, and dumping the
parsed JSON confirms `name`, triggers, and each `run` survived intact. Python's `yaml` module is
not installed on this machine.

## Red herring: `sed -n l`
`sed -n l` wraps its own output and marks the wrap with a trailing `\`, which reads exactly like
a shell line-continuation in the file. It sent this investigation down a wrong path once. Use
`cat`, `od -c`, or `grep -n '\\$'` to check for real trailing backslashes.

## `git diff` cannot see a brand-new schedule file
`commit-schedules.sh` checked `git diff --quiet -- schedules/` before staging. A new
`schedules/<date>.json` is **untracked**, and `git diff` ignores untracked paths, so the planner's
first file for any date was never committed — and the 10:00 executor then failed with
"no schedule for <date>". Stage first (`git add -A schedules/`), then test with
`git diff --cached --quiet`.
