#!/usr/bin/env bash
# Commits whatever changed under schedules/ and pushes, rebasing on contention.
# Both workflows write to the same directory, so a slow run can race a later one.
set -euo pipefail

msg="${1:-chore: update schedules}"

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

# Stage first: a brand-new schedules/<date>.json is UNTRACKED, and `git diff`
# does not see untracked paths — checking before staging meant the planner's very
# first file for a date was never committed, and the 10:00 executor then failed
# with "no schedule for <date>".
git add -A schedules/

if git diff --cached --quiet -- schedules/; then
  echo "no schedule changes to commit"
  exit 0
fi

git commit -m "${msg} [skip ci]"

for attempt in 1 2 3; do
  if git push; then
    echo "pushed on attempt ${attempt}"
    exit 0
  fi
  echo "push rejected, rebasing (attempt ${attempt})"
  git pull --rebase --autostash
  sleep $((attempt * 5))
done

echo "could not push schedule changes after 3 attempts" >&2
exit 1
