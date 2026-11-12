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

Open **SET**, choose Codex or Claude, and add an OpenAI API key for transcription. Then read your diff and talk.

There is one microphone control. Hold **V** to talk and release to send. Tap **V** (or click the button) to keep listening hands-free, where a pause ends each note; press **V** again to stop. **Esc** discards what is being recorded. The microphone opens the first time you use it and is released after five idle minutes.

**N** types a note instead, anchored to the code on screen, and needs no transcription key. **J** and **K** move to the next and previous file. These keys work whenever you aren't typing.

Use **⌘K** (Ctrl+K on Linux) to find changed files or search code in the displayed diff. Arrow keys navigate; Enter opens a match.

**Show changes** opens on committed branch changes, or on **Local** when the branch has none. Local shows everything uncommitted in one view; choose Staged, Unstaged, or Untracked to review those separately. Search and line totals follow that view. Local edits refresh automatically, keeping your place and showing an Updated indicator. Updates wait while you're speaking, searching, or the window is hidden. Lupp uses filesystem notifications, with a 30-second fallback if watching is unavailable. Notes keep their original code context. Committing keeps the review open against the new HEAD; checking out another branch stops the microphone and loads that branch's changes and notes.

Check a file in the sidebar when you're happy with it. Checks are saved per branch and change view, and changed diffs become unchecked on refresh. Space toggles the focused file's check; Enter opens it. Checking a file doesn't dismiss its recommended actions.

Notes stay in `.lupp/` inside the reviewed repo; keep that folder out of Git. Recordings stay on your computer, but audio is sent to OpenAI for transcription, and the selected agent receives your notes and relevant code.

Each note first gets a **quick answer**: a short reply from the code that was on screen, usually within a few seconds, while the full investigation searches the repository and has the final word. Choose who gives quick answers in **SET**. Both agents stay running between notes and stream the reply as they write it; expect two to three seconds, a little more for the first note. A finished note's status line shows how long hearing, the quick answer and the investigation each took.

Investigated notes distinguish answers, recommended actions, and decisions still needed. Reply under any finding, typed or with **Speak**, to answer a decision or ask a follow-up; the agent investigates again and replaces the finding. **↻** investigates a note again after a failure, an interrupted session, or an edit to its transcript.

**Fix with Codex/Claude** on an action lets the agent edit your checkout to make that change. It has no shell or network access under Claude, a workspace-only sandbox under Codex, and never commits; the result appears in the Local view for you to review. Applied actions drop out of Copy all actions. Copy individual actions or **Copy all actions** for an implementation brief to paste into your coding agent. Dismiss actions to exclude them; Restore brings them back. These choices are saved with the review. Older notes keep their original findings and aren't automatically converted to actions.

To update: `npm install -g @simedw/lupp@latest`.

For development: clone this repo, run `npm install`, then `npm start`. Checks: `npm run check && npm test`.

MIT licensed. Dependencies and model providers have their own licenses and terms.
