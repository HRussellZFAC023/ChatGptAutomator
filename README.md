# ChatGPT Automation Pro

Automate ChatGPT in your browser. Type → send → wait → run your code. Batch‑friendly. Zero copy‑paste.

![alt text](image.png)

> **Why this exists** — Prompting is easy. Repeating it 100× with clean logs, templating, and API glue isn’t. This gives you an on‑page automation panel that behaves like a tiny orchestration tool.

---

## Highlights

* **On‑page automation panel** — compose multi‑step chains (Prompt → JS → HTTP → Prompt).
* **Batch mode** — JSON arrays, objects, or generator functions. `{item}`, `{index}`, `{steps.id.response}` supported.
* **JS sandbox** — post‑reply JavaScript with `response`, `steps`, `http`, `utils.log`.
* **HTTP proxy** — background service worker makes cross‑origin calls (GM‑style).
* **Image capture** — auto‑extract generated image URLs.
* **Theme‑aware UI** — dark/light, draggable, resizable, persistent state.

---

New! Firefox addon:
https://addons.mozilla.org/en-US/firefox/addon/chatgpt-automation-pro/

1) Install Tampermonkey
2) Open the raw script URL and accept install:
   - https://raw.githubusercontent.com/HRussellZFAC023/ChatGptAutomator/main/chatgptAutomation.js
3) Go to chatgpt.com → click “Automation” in the header

## What it does
- Types and sends your message automatically
- Waits for ChatGPT to finish, then runs your JavaScript
- Batch mode with templates: {item.foo}, {{index}}, nested paths
- Polished panel: tabs, progress, logs, dark mode, saved position
- CORS-safe HTTP helper to call any API from your code
- Auto-detects your ChatGPT interface language via `<html lang>` and applies built-in translations to the automation panel (supports 30 languages: Albanian, Amharic, Arabic, Armenian, Bengali, Bosnian, Bulgarian, Burmese, Catalan, Chinese, Croatian, Czech, Danish, Dutch, Estonian, Finnish, French, Georgian, German, Greek, Gujarati, Hindi, Hungarian, Icelandic, Indonesian, Italian, Japanese, Kannada, Kazakh, Korean). All strings are bundled locally—no external translation services.
- Every panel label, help tip, and log message is translated, so the interface is fully localized in your language of choice.

## Quick start
1) Simple tab: paste a message → Send
2) Template tab: add Dynamic Elements (JSON array) and a message template → Send
3) Response (JS) tab: paste code that runs after the reply

Context available to your JS: response, log, console, item, index, total, http

4. Run. Watch it process all cities.

---

## Core concepts

* **Chain steps**: `prompt`, `template` (batch), `js`, `http`.
* **Templating**: `{item}`, `{index}`, `{total}`, `{steps.stepId.response}`, `{steps.httpId.data}`.
* **Context for JS**: `response, item, index, total, steps, http, utils.log`.

Example: API → JS → Prompt

```json
{
  "dynamicElements": ["Tokyo","London"],
  "entryId": "weather",
  "steps": [
    { "id": "weather", "type": "http", "url": "https://wttr.in/{item}?format=j1", "method": "GET", "next": "extract" },
    { "id": "extract", "type": "js", "code": "const d=JSON.parse(steps.weather.rawText); return d.current_condition[0].temp_C + '°C';", "next": "chat" },
    { "id": "chat", "type": "prompt", "template": "In {item} it\u2019s {steps.extract.response}. What should I wear?" }
  ]
}
```

---

## Contribute

Issues and PRs welcome. If this saves you time, **⭐️ star the repo** — it helps others find it.

