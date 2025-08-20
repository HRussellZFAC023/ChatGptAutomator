# ChatGPT Automation Pro

Supercharge ChatGPT with a beautiful floating control panel, batch templating, and one-click post-processing hooks. Type → Send → Wait → Run your code. Publish results anywhere via built-in CORS-safe HTTP.

[![Hero Banner](.github/images/hero-placeholder.png)](#)

## Highlights
- Type and send messages automatically on chatgpt.com
- Wait for completion reliably, then run your JavaScript on the response
- Batch processing with powerful templating: {item.foo}, {{index}}, nested paths
- Polished UI: docked panel, tabs, progress, logs, dark mode, persistence
- CORS-safe HTTP helper for direct API calls (works from Tampermonkey)
- Works with any site/API. Example: publish mnemonics to Uchisen with image generation

[![UI Panel](.github/images/ui-placeholder.png)](#)

## Quick install
1) Install Tampermonkey.
2) Open this script URL (raw):
   - https://raw.githubusercontent.com/HRussellZFAC023/ChatGptAutomator/main/chatgptAutomation.js
3) Tampermonkey will prompt to install. Accept. Visit chatgpt.com and click “Automation”.

[![Install](.github/images/install-placeholder.png)](#)

## What you get
- Simple tab: paste a one-off message and click Send
- Template tab: generate messages per item with dynamic placeholders
- Response (JS) tab: run code on the response with provided context

### Context available to your JS
- response: string (ChatGPT response text)
- log: function (msg, type?)
- console: console
- item: current item (Template mode), or single fallback
- index: 1-based index
- total: batch size
- http: CORS-safe helper (GM_xmlhttpRequest wrapper)

```js
// Example: POST response to your server
const payload = { text: response, item, index, total };
await http.postForm('https://example.com/ingest', { data: JSON.stringify(payload) });
```

## Powerful templating
Use {{item}}, {{index}}, {{total}}, or nested paths like {item.kanji}.

```json
// Dynamic Elements
[
  { "kanji": "四", "keyword": "Four", "kanji_id": "43" },
  { "kanji": "三", "keyword": "Three", "kanji_id": "42" }
]
```

```text
// Message Template
You are an expert mnemonic writer. For the kanji {item.kanji} (keyword: {item.keyword}), output strict JSON with fields mnemonic and image_prompt.
```

The tool will produce one message per item.

## Viral-ready prompts and examples
- JSON-only output prompt
```
You are an expert mnemonic writer using the field-tested Uchisen style.
Output JSON only with fields: mnemonic, image_prompt. No prose.
Kanji: {item.kanji}
Keyword: {item.keyword}
Components: {item.components}
Style: 1970s Japanese children's storybook, pastel colors, vintage textures
```

- Minimal helper
```
Summarize the following into 3 bullets. Output plain text only.
{item.text}
```

- Batch transform
```
Rewrite the following marketing headline in 5 variations. Output as numbered lines.
{item.headline}
```

[![Templates](.github/images/template-placeholder.png)](#)

## Direct API calls (CORS-safe)
Use the provided `http` to call any API directly from the userscript.

```js
// POST form-encoded
await http.postForm('https://api.example.com/submit', {
  foo: 'bar',
  json: JSON.stringify({ response, item })
});
```

## Advanced example: Publish to Uchisen
This snippet generates an image and publishes a mnemonic for the current item.

```js
(async () => {
  const data = JSON.parse(response);
  if (!item?.kanji || !item?.kanji_id) { log('Missing kanji or kanji_id', 'error'); return; }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#039;'}[c]||c));
  const promptEscaped = escapeHtml((data.image_prompt||'').trim());
  // Generate
  await http.postForm('https://uchisen.com/generateimage', {
    prompt: promptEscaped,
    kanji_id: String(item.kanji_id)
  }, { 'X-Requested-With': 'XMLHttpRequest' });
  // Publish
  await http.postForm('https://uchisen.com/save_mnemonic.php', {
    img_src: 'FILENAME_FROM_PREV_STEP',
    kanji_id: String(item.kanji_id),
    formatted_mnemonic: data.mnemonic,
    current_image_prompt: data.image_prompt,
    redirect: `/kanji/${encodeURIComponent(item.kanji)}`,
    mnemonic: data.mnemonic,
    image_prompt: data.image_prompt,
    start_blurred: 'no'
  });
})();
```

[![Uchisen](.github/images/uchisen-placeholder.png)](#)

## How to use
1) Open ChatGPT
2) Click “Automation” in the header
3) Pick a tab
   - Simple: Enter a message → Send
   - Template: Paste JSON array in Dynamic Elements, write your template, enable batch
   - Response (JS): Paste code that runs after the response (see examples)
4) Watch logs and progress. Toggle Log to expand/collapse.

## Tips
- UI remembers position/size/visibility between reloads
- Use Template mode for batches; each item provides item/index/total
- Keep response parsing resilient when expecting JSON from ChatGPT
- Use log('text', 'error') for red log lines

## Install on Greasy Fork
- Create a new script entry and link the Raw URL as the update/download source
- Fill out the description with the Highlights and screenshots above

## Permissions
- @match: chatgpt.com and chat.openai.com
- @grant: GM_setValue, GM_getValue, GM_xmlhttpRequest
- @connect: * (to allow API calls you choose)

## Changelog
- v1.0: Initial release with UI, templating, response hooks, CORS HTTP

## License
MIT
