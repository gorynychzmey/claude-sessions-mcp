---
allowed-tools: Bash(npm run release*), Bash(git status --short), Bash(git push*), Bash(git log --oneline*), Bash(git describe*), Bash(gh run list*), Bash(gh run watch*), Bash(gh run view*), Bash(gh release view*), Bash(gh release edit*), Bash(systemctl --user is-active claude-sessions-mcp), Bash(systemctl --user restart claude-sessions-mcp), Bash(curl -s -X POST http://127.0.0.1:*)
description: Cut a release — bump, tag, push, watch CI, then hand over the draft release notes
---

## Your task

Cut a release of this project: bump the version, push the tag, watch the checks,
and leave the release page ready for a human to publish.

`$ARGUMENTS` is the bump: `patch`, `minor`, `major`, or an exact `X.Y.Z`.
If it is empty, use `patch`. Choose nothing on the user's behalf beyond that
default — if the change deserves a `minor` and they said nothing, say so and
ask before bumping.

## Execution note

If subagents are available, hand the workflow watching (`gh run watch`) to one
so the main agent stays free; do the local steps, the tag push, and the final
report yourself. Waiting inline is fine when the result blocks the next step.

**Steps:**

1. Run `git status --short`. If anything is uncommitted, show it, tell the user,
   and stop — a release must describe a tree that exists in git.
2. Run `npm run release -- <bump>`. The script does its own checks (branch,
   clean tree, tag free, `origin` not ahead), runs the build and the tests, then
   bumps `package.json`, commits, and tags `vX.Y.Z`. If it refuses, relay its
   message and stop: every one of its refusals is a real reason not to release.
3. Read the new version from the script's output and push both the commit and
   the tag: `git push` then `git push origin v<version>`.
4. Watch CI: `gh run list --workflow=ci.yml --limit=1` (retry once if the run
   has not registered yet), then `gh run watch <run-id> --exit-status`.
   - If it fails, show the failing step with `gh run view <run-id> --log-failed`,
     summarise the error, and say plainly that the tag is already pushed and the
     draft may already exist — the release is not finished, and the fix ships as
     a new version rather than by moving the tag.
5. Watch the draft job: `gh run list --workflow=release-draft.yml --limit=1`,
   then `gh run watch <run-id> --exit-status`. It opens a draft release with
   generated notes.
6. Show the draft with `gh release view v<version>`. Its generated notes are a
   list of commit subjects — useful as raw material, not as the release page.
   Offer to rewrite them into notes worth reading: what changed for someone
   using the server, and anything that changes a tool's contract.
   **Do not publish.** Publishing is the user's call: only when they say so, run
   `gh release edit v<version> --draft=false` (with `--notes-file` if the notes
   were rewritten).
7. If this machine runs the server as a user service, restart it so it reports
   the new version: check `systemctl --user is-active claude-sessions-mcp`, and
   only if that prints `active`, run `systemctl --user restart claude-sessions-mcp`.
   Then confirm the handshake reports the new version:

   ```
   curl -s -X POST http://127.0.0.1:8765/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"build","version":"1"}}}'
   ```

   If the unit is not installed here, skip this step without comment.
8. Report: the version, the tag, whether CI passed, the draft release URL, and
   whether the local service was restarted.

Do not bump the version by hand, do not edit `package.json` yourself, and do not
move or delete an existing tag.
