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

Notes stay in `.lupp/` inside the reviewed repo; keep that folder out of Git. Recordings stay on your computer, but audio is sent to OpenAI for transcription, and the selected agent receives your notes and relevant code.

To update: `npm install -g @simedw/lupp@latest`.

For development: clone this repo, run `npm install`, then `npm start`. Checks: `npm run check && npm test`.

MIT licensed. Dependencies and model providers have their own licenses and terms.
