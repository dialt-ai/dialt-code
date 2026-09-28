# Converse Code

A voice remote for a normal, visible Pi terminal and a minimal reference implementation of
Dialt background tools and the Browser SDK. Pi uses a ChatGPT Plus/Pro Codex subscription.

```bash
npm install -g @earendil-works/pi-coding-agent
uvx converse-code
```

Resume Pi's most recent session in the current directory with:

```bash
uvx converse-code --continue
```

The browser is voice-only while mirroring live speech, replies, and coding activity; Pi retains
the canonical coding transcript, model state, and tools. Three human-equivalent controls demonstrate
deferred execution, structured partials, constrained interactions, steering, ID-correlated voice approvals,
cancellation, and terminal results through Pi's official extension APIs—without terminal scraping,
menus, or keystroke injection.

Documentation: https://github.com/Trelis-LTD/converse-code

Record an opt-in, locally redacted diagnostic trace with
`converse-code --debug-log ./converse-session.jsonl`. The trace retains transcripts, paths, tool
arguments, command summaries, received-audio timing, and per-turn assistant WAV files in
`converse-session.audio/`. It never captures microphone audio. Redaction cannot recognize every
possible secret format, so the trace and audio directory should be treated as project-sensitive.
