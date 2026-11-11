# Lupp

Review your code with your voice. Lupp pairs your questions with the code you’re looking at and asks Codex or Claude to investigate.

## Install

You'll need Node.js 22.12+, Git, and a logged-in Codex or Claude Code installation. Supports macOS and Linux.

```sh
npm install -g @simedw/lupp
```

Then, from a checkout you want to review:

```sh
cd /path/to/your/repo
lupp
```

Open **SET**, choose Codex or Claude, and add an OpenAI API key for transcription. Start a review and talk as you read your branch's diff. Mute whenever you like.

Prefer to choose what gets recorded? Mute with **M**, then hold **V** to talk and release to send; Lupp remembers which way you left the microphone. **Esc** discards what is being recorded. **N** types a note instead, anchored to the code on screen, and works without a review session or a transcription key. **J** and **K** move to the next and previous file. These keys work whenever you aren't typing.

Use **⌘K** (Ctrl+K on Linux) to find changed files or search code in the displayed diff. Arrow keys navigate; Enter opens a match.

**Show changes** opens on committed branch changes, or on **Local** when the branch has none. Local shows everything uncommitted in one view; choose Staged, Unstaged, or Untracked to review those separately. Search and line totals follow that view. Local edits refresh automatically, keeping your place and showing an Updated indicator. Updates wait while you're speaking, searching, or the window is hidden. Lupp uses filesystem notifications, with a 30-second fallback if watching is unavailable. Notes keep their original code context. Committing keeps the review open against the new HEAD; checking out another branch ends the session and loads that branch's changes and notes.

Check a file in the sidebar when you're happy with it. Checks are saved per branch and change view, and changed diffs become unchecked on refresh. Space toggles the focused file's check; Enter opens it. Checking a file doesn't dismiss its recommended actions.

Notes stay in `.lupp/` inside the reviewed repo; keep that folder out of Git. Recordings stay on your computer, but audio is sent to OpenAI for transcription, and the selected agent receives your notes and relevant code.

Investigated notes distinguish answers, recommended actions, and decisions still needed. Reply under any finding, typed or with **Speak**, to answer a decision or ask a follow-up; the agent investigates again and replaces the finding. **↻** investigates a note again after a failure, an interrupted session, or an edit to its transcript.

**Fix with Codex/Claude** on an action lets the agent edit your checkout to make that change. It has no shell or network access under Claude, a workspace-only sandbox under Codex, and never commits; the result appears in the Local view for you to review. Applied actions drop out of Copy all actions. Copy individual actions or **Copy all actions** for an implementation brief to paste into your coding agent. Dismiss actions to exclude them; Restore brings them back. These choices are saved with the review. Older notes keep their original findings and aren't automatically converted to actions.

To update: `npm install -g @simedw/lupp@latest`.

For development: clone this repo, run `npm install`, then `npm start`. Checks: `npm run check && npm test`.

MIT licensed. Dependencies and model providers have their own licenses and terms.
