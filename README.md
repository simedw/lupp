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

Use **⌘K** (Ctrl+K on Linux) to find changed files or search code in the displayed diff. Arrow keys navigate; Enter opens a match.

**Show changes** defaults to committed branch changes. Choose Staged, Unstaged, or Untracked to review local work separately. Search and line totals follow that view. Local edits refresh automatically, keeping your place and showing an Updated indicator. Updates wait while you're speaking, searching, or the window is hidden. Lupp uses filesystem notifications, with a 30-second fallback if watching is unavailable. Notes keep their original code context; changing branch or HEAD requires reopening the repository.

Check a file in the sidebar when you're happy with it. Checks are saved per branch and change view, and changed diffs become unchecked on refresh. Space toggles the focused file's check; Enter opens it. Checking a file doesn't dismiss its recommended actions.

Notes stay in `.lupp/` inside the reviewed repo; keep that folder out of Git. Recordings stay on your computer, but audio is sent to OpenAI for transcription, and the selected agent receives your notes and relevant code.

Investigated notes distinguish answers, recommended actions, and decisions still needed. Copy individual actions or **Copy all actions** for an implementation brief to paste into your coding agent. Dismiss actions to exclude them; Restore brings them back. These choices are saved with the review. Older notes keep their original findings and aren't automatically converted to actions.

To update: `npm install -g @simedw/lupp@latest`.

For development: clone this repo, run `npm install`, then `npm start`. Checks: `npm run check && npm test`.

MIT licensed. Dependencies and model providers have their own licenses and terms.
