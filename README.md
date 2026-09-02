# Lupp

Read code. Think out loud. Lupp turns your spoken thoughts into review notes and asks Codex or Claude to investigate them.

## Install

You'll need Node.js 22.12+, Git, and a logged-in Codex or Claude Code installation. The local launcher supports macOS and Linux.

```sh
git clone https://github.com/simedw/lupp.git
cd lupp
npm install
npm run install:local
```

Make sure `~/.local/bin` is on your PATH. Then, from a checkout you want to review:

```sh
cd /path/to/your/repo
lupp
```

Open **SET**, choose Codex or Claude, and add an OpenAI API key for transcription. Start a review and talk as you read your branch's diff. Mute whenever you like.

Notes stay in `.code-review-voice/` inside the reviewed repo; keep that folder out of Git. Recordings stay on your computer, but audio is sent to OpenAI for transcription, and the selected agent receives your notes and relevant code.

To update, run `git pull && npm install && npm run install:local` in this checkout. Keep the checkout in place—the launcher uses it.

For development: `npm start`. Checks: `npm run check && npm test`.
