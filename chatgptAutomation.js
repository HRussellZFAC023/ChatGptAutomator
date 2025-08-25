// ==UserScript==
// @name         ChatGPT Automation Pro
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  Advanced ChatGPT automation with dynamic templating
// @author       Henry Russell
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-end
// @inject-into  auto
// @updateURL    https://raw.githubusercontent.com/HRussellZFAC023/ChatGptAutomator/main/chatgptAutomation.js
// @downloadURL  https://raw.githubusercontent.com/HRussellZFAC023/ChatGptAutomator/main/chatgptAutomation.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    DEBUG_MODE: false,
    RESPONSE_TIMEOUT: 3000000,
    DEFAULT_VISIBLE: false,
    RUN_LOCK_TTL_MS: 15000,
    RUN_LOCK_RENEW_MS: 5000,
    BATCH_WAIT_TIME: 2000,
    AUTO_REMOVE_PROCESSED: false,
    AUTO_SCROLL_LOGS: true,
  };

  const state = {
    isLooping: false,
    dynamicElements: [],
    lastResponseElement: null,
    responseObserver: null,
    isMinimized: false,
    isDarkMode: false,
    uiVisible: CONFIG.DEFAULT_VISIBLE,
    headerObserverStarted: false,
    autoScrollLogs: CONFIG.AUTO_SCROLL_LOGS,
    batchWaitTime: CONFIG.BATCH_WAIT_TIME,
    autoRemoveProcessed: CONFIG.AUTO_REMOVE_PROCESSED,
    isProcessing: false,
    currentBatchIndex: 0,
    processedCount: 0,
    chainDefinition: null,
    runLockId: null,
    runLockTimer: null,
  };

  const STORAGE_KEYS = {
    messageInput: 'messageInput',
    templateInput: 'templateInput',
    dynamicElementsInput: 'dynamicElementsInput',
    customCodeInput: 'customCodeInput',
    loop: 'looping',
    autoRemove: 'autoRemoveProcessed',
    autoScroll: 'autoScrollLogs',
    waitTime: 'batchWaitTime',
    stepWaitTime: 'stepWaitTime',
    activeTab: 'activeTab',
    uiState: 'uiState',
    chainDef: 'chain.definition',
    presetsTemplates: 'presets.templates',
    presetsChains: 'presets.chains',
    presetsResponseJS: 'presets.responseJS',
    presetsSteps: 'presets.steps',
    logHistory: 'log.history',
    logVisible: 'log.visible',
    runLockKey: 'chatgptAutomation.runLock',
    configDebug: 'config.debugMode',
    configTimeout: 'config.responseTimeout',
    configDefaultVisible: 'config.defaultVisible',
  };

  let ui = {
    mainContainer: null,
    statusIndicator: null,
    logContainer: null,
    progressBar: null,
    progressBarSub: null,
    resizeHandle: null,
    miniProgress: null,
    miniFill: null,
    miniLabel: null,
    miniSubProgress: null,
    miniSubFill: null,
    miniSubLabel: null,
  };

  // Small helpers to keep calls consistent
  const saveUIState = (immediate = false) => uiState.save(immediate);

  const utils = {
    log: (message, type = 'info') => {
      const now = new Date();
      const datePart = now.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
      const timePart = now.toLocaleTimeString();
      const timestamp = `${datePart} ${timePart}`;
      const logMessage = `[${timestamp}] ${message}`;

      if (CONFIG.DEBUG_MODE) console.log(logMessage);

      if (ui.logContainer) {
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry log-${type}`;
        logEntry.textContent = logMessage;
        ui.logContainer.appendChild(logEntry);

        if (state.autoScrollLogs) {
          ui.logContainer.scrollTop = ui.logContainer.scrollHeight;
        }

        const entries = Array.from(ui.logContainer.querySelectorAll('.log-entry'));
        while (entries.length > 200) {
          const first = entries.shift();
          if (first?.parentNode) first.parentNode.removeChild(first);
        }
      }

      try {
        let history = GM_getValue(STORAGE_KEYS.logHistory, []);
        if (!Array.isArray(history)) history = [];
        history.push({ t: Date.now(), type, msg: logMessage });
        if (history.length > 300) history = history.slice(-300);
        GM_setValue(STORAGE_KEYS.logHistory, history);
      } catch {}
    },

    clip: (s, n = 300) => {
      try {
        const str = String(s ?? '');
        return str.length > n ? str.slice(0, n) + '…' : str;
      } catch {
        return '';
      }
    },

    detectDarkMode: () => {
      const html = document.documentElement;
      const body = document.body;
      return [
        html.classList.contains('dark'),
        body.classList.contains('dark'),
        html.getAttribute('data-theme') === 'dark',
        body.getAttribute('data-theme') === 'dark',
        getComputedStyle(body).backgroundColor.includes('rgb(0, 0, 0)') ||
          getComputedStyle(body).backgroundColor.includes('rgb(17, 24, 39)') ||
          getComputedStyle(body).backgroundColor.includes('rgb(31, 41, 55)'),
      ].some(Boolean);
    },

    saveToStorage: (key, value) => {
      try {
        GM_setValue(key, value);
      } catch {}
    },

    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

    getByPath: (obj, path) => {
      try {
        return path.split('.').reduce((acc, part) => acc?.[part], obj);
      } catch {
        return undefined;
      }
    },

    queryFirst: (selectors) => {
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    },

    loadFromStorage: (key, def) => {
      try {
        return GM_getValue(key, def);
      } catch {
        return def;
      }
    },
  };

  const http = {
    request: (opts) =>
      new Promise((resolve, reject) => {
        try {
          const {
            method = 'GET',
            url,
            headers = {},
            data,
            responseType = 'text',
            timeout = 30000,
          } = opts || {};
          if (!url) throw new Error('Missing url');
          GM_xmlhttpRequest({
            method,
            url,
            headers,
            data,
            responseType,
            timeout,
            anonymous: false,
            onload: (res) => resolve(res),
            onerror: (err) => {
              try {
                const msg = err?.error || err?.message || 'Network error';
                reject(new Error(msg));
              } catch {
                reject(new Error('Network error'));
              }
            },
            ontimeout: () => reject(new Error('Request timeout')),
          });
        } catch (e) {
          reject(e);
        }
      }),
    postForm: (url, formObj, extraHeaders = {}) => {
      const body = Object.entries(formObj || {})
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
        .join('&');
      return http.request({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          ...extraHeaders,
        },
        data: body,
      });
    },
    postMultipart: (url, formObj, extraHeaders = {}) => {
      return http.postForm(url, formObj, extraHeaders);
    },
  };

  const processors = {
    executeCustomCode: async (code, responseText, templateData = null) => {
      if (!code || code.trim() === '') return;
      try {
        // Resolve context
        let item = templateData?.elementData ?? null;
        let index = templateData?.index ?? null;
        let total = templateData?.total ?? null;
        const stepsCtx = templateData?.steps ?? {};
        const lastResponse = templateData?.lastResponse ?? responseText;

        // Fallback: single dynamic element → provide as item when not in template mode
        if (!item) {
          try {
            const dynInput = document.getElementById('dynamic-elements-input');
            const val = dynInput && typeof dynInput.value === 'string' ? dynInput.value.trim() : '';
            if (val) {
              const arr = await processors.parseDynamicElements(val);
              if (Array.isArray(arr) && arr.length === 1) {
                item = arr[0];
                if (index == null) index = 1;
                if (total == null) total = 1;
                utils.log('Context fallback: using single dynamic element for custom code');
              }
            }
          } catch {}
        }

        if (CONFIG.DEBUG_MODE) {
          utils.log(
            `Custom code context: item=${item ? JSON.stringify(item).slice(0, 100) : 'null'}, index=${index}, total=${total}`
          );
        }

        // Use sandbox-safe Function constructor; await Promise if returned
        const Fn = function () {}.constructor; // constructor of a sandboxed function
        const fn = new Fn(
          'response',
          'log',
          'console',
          'item',
          'index',
          'total',
          'http',
          'steps',
          'lastResponse',
          'GM_getValue',
          'GM_setValue',
          'GM_xmlhttpRequest',
          'unsafeWindow',
          'utils',
          code
        );
        const result = fn(
          responseText,
          (msg, type = 'info') => utils.log(msg, type),
          console,
          item,
          index,
          total,
          http,
          stepsCtx,
          lastResponse,
          GM_getValue,
          GM_setValue,
          GM_xmlhttpRequest,
          unsafeWindow,
          utils
        );
        await Promise.resolve(result);
        utils.log('Custom code executed successfully');
        return result;
      } catch (error) {
        utils.log(`Custom code execution error: ${error.message}`, 'error');
        throw error;
      }
    },

    processDynamicTemplate: (template, dynamicData) => {
      if (!template) return '';
      const regex = /\{\{\s*([\w$.]+)\s*\}\}|\{\s*([\w$.]+)\s*\}/g;
      return template.replace(regex, (_, g1, g2) => {
        const keyPath = g1 || g2;
        let value = utils.getByPath(dynamicData, keyPath);
        if (value === undefined) return '';
        if (typeof value === 'object') {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }
        return String(value);
      });
    },

    parseDynamicElements: async (input) => {
      const raw = (input || '').trim();
      if (!raw) return [];

      if (raw.startsWith('[')) {
        try {
          return JSON.parse(raw);
        } catch (e) {
          utils.log(`Invalid JSON: ${e.message}`, 'error');
          return [];
        }
      }

      if (raw.startsWith('{')) {
        try {
          const obj = JSON.parse(raw);
          return [obj];
        } catch {}
      }

      try {
        const Fn = function () {}.constructor;
        const fn = new Fn('return ( ' + raw + ' )');
        const v = fn();
        const res = typeof v === 'function' ? v() : v;
        if (Array.isArray(res)) return res;
        if (res && typeof res === 'object') return [res];
        if (typeof res === 'string') {
          try {
            const parsed = JSON.parse(res);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && typeof parsed === 'object') return [parsed];
          } catch {}
        }
        throw new Error('Result is not an array/object');
      } catch (error) {
        utils.log(`Error parsing dynamic elements: ${error.message}`, 'error');
        return [];
      }
    },
  };

  const uiState = {
    saveTimeout: null,

    save: (immediate = false) => {
      if (!ui.mainContainer) return;

      const doSave = () => {
        const stateData = {
          left: ui.mainContainer.style.left,
          top: ui.mainContainer.style.top,
          right: ui.mainContainer.style.right,
          minimized: state.isMinimized,
          visible: state.uiVisible,
        };
        utils.saveToStorage(STORAGE_KEYS.uiState, JSON.stringify(stateData));
      };

      if (immediate) {
        clearTimeout(uiState.saveTimeout);
        doSave();
      } else {
        clearTimeout(uiState.saveTimeout);
        uiState.saveTimeout = setTimeout(doSave, 100);
      }
    },

    load: () => {
      try {
        const saved = GM_getValue(STORAGE_KEYS.uiState, null);
        return saved ? JSON.parse(saved) : {};
      } catch {
        return {};
      }
    },
  };

  const chatGPT = {
    getChatInput: () => {
      const selectors = [
        '#prompt-textarea',
        'div[contenteditable="true"]',
        'textarea[placeholder*="Message"]',
        'div.ProseMirror',
      ];
      const el = utils.queryFirst(selectors);
      return el && el.isContentEditable !== false ? el : null;
    },

    getSendButton: () => {
      const selectors = [
        '#composer-submit-button',
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="submit"]',
      ];
      const btn = utils.queryFirst(selectors);
      return btn && !btn.disabled ? btn : null;
    },

    typeMessage: async (message) => {
      const input = chatGPT.getChatInput();
      if (!input) throw new Error('Chat input not found');

      if (input.tagName === 'DIV') {
        input.innerHTML = '';
        input.focus();
        const paragraph = document.createElement('p');
        paragraph.textContent = message;
        input.appendChild(paragraph);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        input.value = message;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      await utils.sleep(100);
      utils.log(`Message typed: "${utils.clip(message, 50)}"`);
    },

    sendMessage: async () => {
      const sendButton = chatGPT.getSendButton();
      if (!sendButton) throw new Error('Send button not available');
      sendButton.click();
      utils.log('Message sent');
      await utils.sleep(500);
    },

    ask: async (message) => {
      await chatGPT.typeMessage(message);
      await utils.sleep(300);
      await chatGPT.sendMessage();
      updateStatus('waiting');
      const el = await chatGPT.waitForResponse();
      return { el, text: chatGPT.extractResponseText(el) };
    },

    // ask with expectation option: { expect: 'image' | 'text' }
    askWith: async (message, options = { expect: 'text' }) => {
      await chatGPT.typeMessage(message);
      await utils.sleep(300);
      await chatGPT.sendMessage();
      updateStatus('waiting');
      const el = await chatGPT.waitForResponse();
      if (options.expect === 'image') {
        // Allow brief time for images to attach
        await utils.sleep(500);
        let images = chatGPT.extractResponseImages(el);
        if (!images || images.length === 0) {
          // Retry scan for late-loading images
          await utils.sleep(800);
          images = chatGPT.extractResponseImages(el);
        }
        return { el, images };
      }
      return { el, text: chatGPT.extractResponseText(el) };
    },

    waitForResponse: async () => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (state.responseObserver) state.responseObserver.disconnect();
          reject(new Error('Response timeout'));
        }, CONFIG.RESPONSE_TIMEOUT);

        const checkForNewResponse = () => {
          const assistantMessages = document.querySelectorAll(
            '[data-message-author-role="assistant"]'
          );
          const latestMessage = assistantMessages[assistantMessages.length - 1];

          if (latestMessage && latestMessage !== state.lastResponseElement) {
            const isGenerating =
              document.querySelector('[data-testid="stop-button"]') ||
              document.querySelector('.result-thinking') ||
              latestMessage.querySelector('.typing-indicator');

            if (!isGenerating) {
              clearTimeout(timeout);
              if (state.responseObserver) state.responseObserver.disconnect();
              // Prefer the full assistant turn container (article) which holds images/content
              const container =
                latestMessage.closest('article[data-turn="assistant"]') || latestMessage;
              state.lastResponseElement = container;
              resolve(container);
            }
          }
        };

        checkForNewResponse();
        state.responseObserver = new MutationObserver(checkForNewResponse);
        state.responseObserver.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
    },

    extractResponseText: (responseElement) => {
      if (!responseElement) return '';
      const contentSelectors = ['.markdown', '.prose', '[data-message-id]', '.whitespace-pre-wrap'];
      for (const selector of contentSelectors) {
        const contentElement = responseElement.querySelector(selector);
        if (contentElement) return contentElement.textContent.trim();
      }
      return responseElement.textContent.trim();
    },

    // Extract image URLs from an assistant response element
    extractResponseImages: (responseElement) => {
      if (!responseElement) return [];
      const urls = new Set();
      try {
        // Search within the assistant article scope
        const scope =
          responseElement.closest && responseElement.closest('article[data-turn="assistant"]')
            ? responseElement.closest('article[data-turn="assistant"]')
            : responseElement;

        // Get all generated images, excluding blurred ones
        scope.querySelectorAll('div[id^="image-"] img[alt="Generated image"]').forEach((img) => {
          const src = img.getAttribute('src');
          // Skip blurred backdrop images (they have blur-2xl or scale-110 in their parent)
          const isBlurred = img.closest('.blur-2xl') || img.closest('.scale-110');
          if (src && !isBlurred) {
            log('🖼️ Found image: ' + src);
            urls.add(src);
          }
        });
      } catch (e) {
        log('❌ Error in extractResponseImages: ' + e.message, 'error');
      }
      return Array.from(urls);
    },
  };

  // UI Creation
  const createUI = () => {
    state.isDarkMode = utils.detectDarkMode();

    // Main container
    ui.mainContainer = document.createElement('div');
    ui.mainContainer.id = 'chatgpt-automation-ui';
    ui.mainContainer.className = state.isDarkMode ? 'dark-mode' : 'light-mode';
    ui.mainContainer.innerHTML = /*html*/ `<div class="automation-header" id="automation-header">
  <h3>ChatGPT Automation Pro</h3>
  <div class="header-controls">
    <div
      class="mini-progress"
      id="mini-progress"
      style="display: none"
      title="Batch progress"
    >
      <div class="mini-bar"><div class="mini-fill" id="mini-fill"></div></div>
      <div class="mini-label" id="mini-label">0/0</div>
    </div>
    <div
      class="mini-progress"
      id="mini-sub-progress"
      style="display: none"
      title="Inner batch progress"
    >
      <div class="mini-bar">
        <div class="mini-fill" id="mini-sub-fill"></div>
      </div>
      <div class="mini-label" id="mini-sub-label">0/0</div>
    </div>
    <div class="status-indicator" id="status-indicator">
      <span class="status-dot"></span>
      <span class="status-text">Ready</span>
    </div>
    <button
      class="header-btn"
      id="header-log-toggle"
      title="Show/Hide Log"
      aria-label="Show/Hide Log"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M4 5h16v2H4V5zm0 6h16v2H4v-2zm0 6h10v2H4v-2z" />
      </svg>
    </button>
    <button
      class="header-btn"
      id="minimize-btn"
      title="Minimize"
      aria-label="Minimize"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6 12h12v2H6z" />
      </svg>
    </button>
    <button class="header-btn" id="close-btn" title="Close" aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path
          d="M18.3 5.71L12 12.01L5.7 5.71L4.29 7.12L10.59 13.42L4.29 19.72L5.7 21.13L12 14.83L18.3 21.13L19.71 19.72L13.41 13.42L19.71 7.12L18.3 5.71Z"
        />
      </svg>
    </button>
  </div>
</div>

<div class="automation-content" id="automation-content">
  <div class="progress-container" id="progress-container" style="display: none">
    <div class="progress-bar">
      <div class="progress-fill"></div>
    </div>
    <div class="progress-text">0/0</div>
    <div
      class="progress-bar sub"
      id="progress-container-sub"
      style="display: none; margin-top: 6px"
    >
      <div class="progress-fill"></div>
    </div>
    <div class="progress-text sub" id="progress-text-sub" style="display: none">
      0/0
    </div>
  </div>

  <div class="automation-form">
    <div class="tab-container">
      <button class="tab-btn active" data-tab="composer">Composer</button>
      <button class="tab-btn" data-tab="settings">Settings</button>
    </div>

    <div class="tab-content active" id="composer-tab">
      <div class="form-group">
        <label>Composer Canvas:</label>
        <div class="composer-presets">
          <div class="preset-row">
            <input
              type="text"
              id="composer-preset-name-input"
              class="settings-input"
              placeholder="Preset name"
              style="flex: 1"
            />
            <select
              id="composer-preset-select"
              class="settings-input"
              style="flex: 2"
            >
              <option value="">Select preset...</option>
            </select>
            <button
              class="btn btn-secondary"
              id="save-composer-preset-btn"
              title="Save current configuration"
            >
              💾
            </button>
            <button
              class="btn btn-primary"
              id="load-composer-preset-btn"
              title="Load selected preset"
            >
              📂
            </button>
            <button
              class="btn btn-danger"
              id="delete-composer-preset-btn"
              title="Delete selected preset"
            >
              🗑️
            </button>
          </div>
        </div>
        <div id="chain-canvas" class="chain-canvas">
          <div class="chain-toolbar">
            <button class="btn btn-secondary" id="add-step-btn">
              Add Step
            </button>
            <button class="btn btn-secondary" id="validate-chain-btn">
              Validate Chain
            </button>
            <button class="btn btn-primary" id="run-chain-btn">
              Run Chain
            </button>
            <button
              class="btn btn-danger"
              id="stop-run-btn"
              style="display: none"
            >
              Stop
            </button>
          </div>
          <div id="chain-cards" class="chain-cards"></div>
        </div>
        <div class="help-text">
          Visual editor for multi-step automation chains. Steps connect in
          sequence; supports templates and custom JavaScript execution.
        </div>
      </div>
      <div class="form-group">
        <label for="dynamic-elements-input"
          >Dynamic Elements (List, JSON, or function)</label
        >
        <div class="code-editor">
          <div class="overlay-field">
            <textarea
              id="dynamic-elements-input"
              rows="4"
              placeholder='["item1", "item2", "item3"] or () => ["generated", "items"]'
            ></textarea>
            <button
              class="tool-btn overlay"
              id="format-dyn-elements-btn"
              title="Format JSON"
            >
              { }
            </button>
            <button
              class="tool-btn overlay"
              id="apply-dyn-elements-btn"
              style="right: 36px;"
              title="Apply dynamic elements to runtime"
            >
              ▶
            </button>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label for="chain-json-input">Chain JSON (advanced):</label>
        <div class="code-editor">
          <textarea
            id="chain-json-input"
            rows="6"
            placeholder='{
    "entryId": "step-1",
    "steps": [
        {
        "id": "step-1",
        "type": "prompt",
        "title": "Create message",
        "template": "Hello {item}",
        "next": "step-2"
        },
        {
        "id": "step-2",
        "type": "js",
        "title": "Process response",
        "code": "utils.log(\"Processing: \" + steps[\"step-1\"].response);"
        }
    ]
    }'
          ></textarea>
          <div class="editor-tools">
            <button
              class="tool-btn"
              id="format-chain-json-btn"
              title="Format JSON"
            >
              { }
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="tab-content" id="settings-tab">
      <div class="form-group">
        <label>Debug mode:</label>
        <label class="checkbox-label">
          <input type="checkbox" id="debug-mode-checkbox" />
          <span class="checkmark"></span>
          Enable debug logging
        </label>
      </div>
      <div class="form-group">
        <label>Batch settings:</label>
        <div class="batch-controls">
          <div class="batch-settings">
            <label class="checkbox-label">
              <input type="checkbox" id="loop-checkbox" />
              <span class="checkmark"></span>
              Process all items in batch
            </label>
            <label class="checkbox-label">
              <input type="checkbox" id="auto-remove-checkbox" checked />
              <span class="checkmark"></span>
              Remove processed items from queue
            </label>
            <div class="wait-time-control">
              <label for="wait-time-input">Wait between items (ms):</label>
              <input
                type="number"
                id="wait-time-input"
                min="100"
                max="30000"
                value="2000"
                step="100"
              />
            </div>
            <div class="wait-time-control">
              <label for="step-wait-input">Wait between steps (ms):</label>
              <input
                type="number"
                id="step-wait-input"
                min="0"
                max="30000"
                value="0"
                step="100"
              />
            </div>
          </div>
          <div class="batch-actions">
            <button
              id="stop-batch-btn"
              class="btn btn-danger"
              style="display: none"
            >
              Stop Batch
            </button>
          </div>
        </div>
      </div>
      <div class="form-group">
        <label for="response-timeout-input">Response timeout (ms):</label>
        <input
          type="number"
          id="response-timeout-input"
          min="10000"
          max="6000000"
          step="1000"
          class="settings-input timeout"
        />
      </div>
      <div class="form-group">
        <label>Panel size limits (px):</label>
        <div class="size-inputs-grid"></div>
      </div>
      <div class="form-group">
        <label>Visibility:</label>
        <label class="checkbox-label">
          <input type="checkbox" id="default-visible-checkbox" />
          <span class="checkmark"></span>
          Show panel by default
        </label>
        <div class="help-text">
          Controls default visibility on page load. You can still toggle from
          the header button.
        </div>
      </div>
    </div>
  </div>

  <div class="automation-log" id="log-container">
    <div class="log-header">
      <span>Activity Log</span>
      <div class="log-header-controls">
        <button class="tool-btn" id="stop-mini-btn" title="Stop" style="display: none">🛑</button>
        <button
          class="tool-btn"
          id="toggle-auto-scroll-btn"
          title="Toggle Auto-scroll"
        >
          📜
        </button>
        <button class="tool-btn" id="clear-log-btn" title="Clear Log">
          🗑️
        </button>
      </div>
    </div>
    <div class="log-content"></div>
  </div>
</div>

<div class="resize-handle" id="resize-handle"></div>

<!-- Modal for editing a chain step -->
<div
  id="chain-step-modal"
  class="chain-modal"
  aria-hidden="true"
  style="display: none"
>
  <div class="chain-modal-backdrop"></div>
  <div
    class="chain-modal-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="chain-step-title"
  >
    <div class="chain-modal-header">
      <h4 id="chain-step-title">Edit Step</h4>
      <div class="step-modal-presets">
        <select
          id="step-preset-select"
          class="settings-input"
          style="min-width: 120px"
        >
          <option value="">Select preset...</option>
        </select>
        <button
          class="tool-btn"
          id="save-step-preset-btn"
          title="Save as preset"
        >
          💾
        </button>
        <button
          class="tool-btn"
          id="delete-step-preset-btn"
          title="Delete preset"
        >
          🗑️
        </button>
      </div>
      <button class="header-btn" id="close-step-modal-btn" aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path
            d="M18.3 5.71L12 12.01L5.7 5.71L4.29 7.12L10.59 13.42L4.29 19.72L5.7 21.13L12 14.83L18.3 21.13L19.71 19.72L13.41 13.42L19.71 7.12L18.3 5.71Z"
          />
        </svg>
      </button>
    </div>
    <div class="chain-modal-body">
      <div class="form-group">
        <label for="step-id-input">ID</label>
        <input id="step-id-input" class="settings-input" placeholder="step-1" />
      </div>
      <div class="form-group">
        <label for="step-title-input">Title</label>
        <input
          id="step-title-input"
          class="settings-input"
          placeholder="Describe the step"
        />
      </div>
      <div class="form-group">
        <label for="step-type-select">Type</label>
        <select id="step-type-select" class="settings-input">
          <option value="prompt">Prompt</option>
          <option value="template">Template (Batch)</option>
          <option value="js">JavaScript</option>
          <option value="http">HTTP Request</option>
        </select>
      </div>
      <div class="form-group" data-field="prompt">
        <label for="step-response-type">Response Type</label>
        <select id="step-response-type" class="settings-input">
          <option value="text">Text</option>
          <option value="image">Image</option>
        </select>
        <label class="checkbox-label" style="margin-top: 6px; display: block">
          <input type="checkbox" id="step-newchat-checkbox" />
          <span class="checkmark"></span>
          Open in new chat before this step
        </label>
      </div>
      <div class="form-group" data-field="prompt">
        <label for="step-prompt-template">Message Template</label>
        <textarea
          id="step-prompt-template"
          rows="4"
          class="settings-input"
          placeholder="Send a message to ChatGPT. Use {steps.stepId.response} to access previous step data."
        ></textarea>
        <div class="help-text">
          Access previous step data: {steps.stepId.response} for prompts,
          {steps.stepId.data} for HTTP, {steps.stepId.status} for HTTP status
        </div>
      </div>
      <div class="form-group" data-field="template">
        <label for="step-template-input">Message Template</label>
        <textarea
          id="step-template-input"
          rows="4"
          class="settings-input"
          placeholder="Template with placeholders like {{item}}, {{index}}, {{total}} or {steps.stepId.data}..."
        ></textarea>
        <label for="step-template-elements" style="margin-top: 8px"
          >Dynamic Elements (JSON/function). Supports {placeholders}.</label
        >
        <div class="overlay-field">
          <textarea
            id="step-template-elements"
            rows="3"
            class="settings-input"
            placeholder='["item1", "item2", "item3"] or () => ["generated", "items"]'
          ></textarea>
          <button
            class="tool-btn overlay"
            id="format-step-elements-btn"
            title="Format JSON"
          >
            { }
          </button>
        </div>
        <label class="checkbox-label" style="margin-top: 6px; display: block">
          <input type="checkbox" id="step-use-dynamicelements-checkbox" />
          <span class="checkmark"></span>
          Use chain.dynamicElements as elements
        </label>
        <div class="help-text">
          Batch processing: {{item}} for current item, {steps.stepId.response}
          for previous step data
        </div>
      </div>
      <div class="form-group" data-field="http">
        <label>HTTP Request</label>
        <input
          id="step-http-url"
          class="settings-input"
          placeholder="https://api.example.com/data or {steps.stepId.data.apiUrl}"
        />
        <div style="display: flex; gap: 8px; margin-top: 6px">
          <select id="step-http-method" class="settings-input">
            <option>GET</option>
            <option>POST</option>
            <option>PUT</option>
            <option>DELETE</option>
          </select>
          <div class="overlay-field">
            <input
              id="step-http-headers"
              class="settings-input"
              placeholder='{"Authorization": "Bearer {steps.authStep.data.token}"}'
            />
            <button
              class="tool-btn overlay"
              id="format-http-headers-btn"
              title="Format JSON"
            >
              { }
            </button>
          </div>
        </div>
        <div class="overlay-field">
          <textarea
            id="step-http-body"
            rows="3"
            class="settings-input"
            placeholder="Request body: {steps.stepId.response} or JSON data"
          ></textarea>
          <button
            class="tool-btn overlay"
            id="format-http-body-btn"
            title="Format JSON"
          >
            { }
          </button>
        </div>
        <div class="help-text">
          Access response with {steps.thisStepId.data} or
          {steps.thisStepId.status}. Use previous step data in URL/headers/body.
        </div>
      </div>
      <div class="form-group" data-field="js">
        <label for="step-js-code">JavaScript Code</label>
        <textarea
          id="step-js-code"
          rows="6"
          class="settings-input"
          placeholder="// Access previous steps with steps.stepId.data or steps.stepId.response
// Available: response, log, console, item, index, total, http, steps, lastResponse
// Example: utils.log('API response:', steps.httpStep.data);"
        ></textarea>
        <div class="help-text">
          Access step data with <code>steps.stepId.data</code> or
          <code>steps.stepId.response</code>. Use <code>http</code> for API
          calls, <code>utils.log()</code> for output.
        </div>
      </div>
      <div class="form-group">
        <label for="step-next-select">Next step</label>
        <select id="step-next-select" class="settings-input"></select>
      </div>
    </div>
    <div class="chain-modal-footer">
      <button class="btn btn-secondary" id="delete-step-btn">Delete</button>
      <button class="btn btn-primary" id="save-step-btn">Save</button>
    </div>
  </div>
</div>
`;

    // Add styles with ChatGPT-inspired design (guard against duplicates)
    let style = document.getElementById('chatgpt-automation-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'chatgpt-automation-style';
      style.textContent = /*css*/ `/* Base styles that adapt to ChatGPT's theme (scoped) */
#chatgpt-automation-ui {
  position: fixed;
  top: 20px;
  right: 20px;
  height: auto;
  width: auto;
  background: var(--main-surface-primary, #ffffff);
  border: 1px solid var(--border-medium, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  font-family: var(
    --font-family,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    sans-serif
  );
  z-index: 10000;
  resize: both;
  overflow: hidden;
  backdrop-filter: blur(10px);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

#chatgpt-automation-ui.dark-mode {
  background: var(--main-surface-primary, #2d2d30);
  border-color: var(--border-medium, rgba(255, 255, 255, 0.1));
  color: var(--text-primary, #ffffff);
}

#chatgpt-automation-ui.minimized {
  resize: both;
  height: 46px;
  width: 600px;
}
#chatgpt-automation-ui.minimized.log-open {
  height: 300px;
}
/* Hide main form when minimized */
#chatgpt-automation-ui.minimized .automation-form {
  display: none;
}
/* Keep progress container visible state-controlled; mini bars appear in header */

/* Base content layout mirrors minimized behavior */
#chatgpt-automation-ui .automation-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: calc(100% - 60px); /* Header height offset */
}

#chatgpt-automation-ui .automation-header {
  background: linear-gradient(
    135deg,
    var(--brand-purple, #6366f1) 0%,
    var(--brand-purple-darker, #4f46e5) 100%
  );
  color: white;
  padding: 12px 16px;
  border-radius: 12px 12px 0 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: move;
  user-select: none;
}

#chatgpt-automation-ui .automation-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  flex: 1;
}

#chatgpt-automation-ui .header-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

#chatgpt-automation-ui .mini-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 80px;
}
#chatgpt-automation-ui .mini-progress .mini-bar {
  width: 60px;
  height: 4px;
  background: rgba(255, 255, 255, 0.3);
  border-radius: 2px;
  overflow: hidden;
}
#chatgpt-automation-ui .mini-progress .mini-fill {
  height: 100%;
  background: #22d3ee;
  width: 0%;
  transition: width 0.3s ease;
}
#chatgpt-automation-ui .mini-progress .mini-label {
  font-size: 10px;
  opacity: 0.85;
}

#chatgpt-automation-ui .status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  opacity: 0.9;
}

#chatgpt-automation-ui .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
  animation: pulse-idle 2s infinite;
}

#chatgpt-automation-ui .header-btn {
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 4px;
  padding: 4px;
  color: white;
  cursor: pointer;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

#chatgpt-automation-ui .header-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

#chatgpt-automation-ui .automation-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* Allow children to shrink/scroll correctly inside flex */
  min-height: 0;
  -webkit-overflow-scrolling: touch;
}

#chatgpt-automation-ui .progress-container {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-light, rgba(0, 0, 0, 0.06));
  background: var(--surface-secondary, #f8fafc);
}
/* Hide main progress container when minimized (header mini bars take over) */
#chatgpt-automation-ui.minimized .progress-container {
  display: none !important;
}

#chatgpt-automation-ui.dark-mode .progress-container {
  background: var(--surface-secondary, #1e1e20);
  border-color: var(--border-light, rgba(255, 255, 255, 0.06));
}

#chatgpt-automation-ui .progress-bar {
  width: 100%;
  height: 4px;
  background: var(--border-light, rgba(0, 0, 0, 0.1));
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 4px;
}
#chatgpt-automation-ui .progress-bar.sub {
  background: var(--border-light, rgba(0, 0, 0, 0.1));
}

#chatgpt-automation-ui .progress-fill {
  height: 100%;
  background: var(--brand-purple, #6366f1);
  transition: width 0.3s ease;
}

#chatgpt-automation-ui .progress-text {
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
  text-align: center;
}
#chatgpt-automation-ui .progress-text.sub {
  opacity: 0.8;
}

#chatgpt-automation-ui .automation-form {
  padding: 16px;
  /* Keep natural height so logs fill remaining space */
  flex: 0 0 auto;
  overflow: auto;
}

#chatgpt-automation-ui .tab-container {
  display: flex;
  border-bottom: 1px solid var(--border-light, rgba(0, 0, 0, 0.06));
  margin-bottom: 16px;
}

#chatgpt-automation-ui.dark-mode .tab-container {
  border-color: var(--border-light, rgba(255, 255, 255, 0.06));
}

#chatgpt-automation-ui .tab-btn {
  background: none;
  border: none;
  padding: 8px 16px;
  cursor: pointer;
  color: var(--text-secondary, #6b7280);
  font-size: 13px;
  font-weight: 500;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}

#chatgpt-automation-ui .tab-btn.active {
  color: var(--brand-purple, #6366f1);
  border-color: var(--brand-purple, #6366f1);
}

#chatgpt-automation-ui .tab-content {
  display: none;
}

#chatgpt-automation-ui .tab-content.active {
  display: block;
}

#chatgpt-automation-ui .form-group {
  margin-bottom: 16px;
}

#chatgpt-automation-ui .form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  color: var(--text-primary, #374151);
  font-size: 13px;
}

#chatgpt-automation-ui.dark-mode .form-group label {
  color: var(--text-primary, #f3f4f6);
}

#chatgpt-automation-ui .form-group textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-medium, rgba(0, 0, 0, 0.1));
  border-radius: 8px;
  font-size: 13px;
  resize: vertical;
  font-family: "SF Mono", "Monaco", "Menlo", "Ubuntu Mono", monospace;
  box-sizing: border-box;
  background: var(--input-background, #ffffff);
  color: var(--text-primary, #374151);
  transition: border-color 0.2s, box-shadow 0.2s;
}

#chatgpt-automation-ui.dark-mode .form-group textarea {
  background: var(--input-background, #1e1e20);
  color: var(--text-primary, #f3f4f6);
  border-color: var(--border-medium, rgba(255, 255, 255, 0.1));
}

#chatgpt-automation-ui .form-group textarea:focus {
  outline: none;
  border-color: var(--brand-purple, #6366f1);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

#chatgpt-automation-ui .code-editor {
  position: relative;
}

#chatgpt-automation-ui .editor-tools {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

#chatgpt-automation-ui .code-editor:hover .editor-tools {
  opacity: 1;
}

#chatgpt-automation-ui .tool-btn {
  background: var(--surface-secondary, rgba(0, 0, 0, 0.05));
  border: none;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 10px;
  cursor: pointer;
  color: var(--text-secondary, #6b7280);
  transition: background 0.2s;
}

#chatgpt-automation-ui .tool-btn:hover {
  background: var(--surface-secondary, rgba(0, 0, 0, 0.1));
}

#chatgpt-automation-ui .help-text {
  font-size: 11px;
  color: var(--text-secondary, #6b7280);
  margin-top: 4px;
  font-style: italic;
}

#chatgpt-automation-ui .batch-controls {
  margin-top: 12px;
  padding: 12px;
  background: var(--surface-secondary, #f8fafc);
  border-radius: 6px;
}

#chatgpt-automation-ui.dark-mode .batch-controls {
  background: var(--surface-secondary, #1e1e20);
}

#chatgpt-automation-ui .batch-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

#chatgpt-automation-ui .batch-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

#chatgpt-automation-ui .wait-time-control {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

#chatgpt-automation-ui .wait-time-control label {
  font-size: 12px;
  margin: 0;
  white-space: nowrap;
  color: var(--text-primary, #374151);
}

#chatgpt-automation-ui.dark-mode .wait-time-control label {
  color: var(--text-primary, #f3f4f6);
}

#chatgpt-automation-ui .wait-time-control input[type="number"] {
  width: 80px;
  padding: 4px 8px;
  border: 1px solid var(--border-medium, rgba(0, 0, 0, 0.1));
  border-radius: 4px;
  font-size: 12px;
  background: var(--input-background, #ffffff);
  color: var(--text-primary, #374151);
}

#chatgpt-automation-ui.dark-mode .wait-time-control input[type="number"] {
  background: var(--input-background, #1e1e20);
  color: var(--text-primary, #f3f4f6);
  border-color: var(--border-medium, rgba(255, 255, 255, 0.1));
}

#chatgpt-automation-ui .wait-time-control input[type="number"]:focus {
  outline: none;
  border-color: var(--brand-purple, #6366f1);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

/* Settings input styles */
#chatgpt-automation-ui .settings-input {
  padding: 6px 8px;
  border: 1px solid var(--border-medium, rgba(0, 0, 0, 0.1));
  border-radius: 6px;
  font-size: 13px;
  background: var(--input-background, #ffffff);
  color: var(--text-primary, #374151);
}

#chatgpt-automation-ui.dark-mode .settings-input {
  background: var(--input-background, #1e1e20);
  color: var(--text-primary, #f3f4f6);
  border-color: var(--border-medium, rgba(255, 255, 255, 0.1));
}

#chatgpt-automation-ui .settings-input:focus {
  outline: none;
  border-color: var(--brand-purple, #6366f1);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
}

#chatgpt-automation-ui .settings-input.timeout {
  width: 140px;
}

/* Overlay format button on hover */
#chatgpt-automation-ui .overlay-field {
  position: relative;
}
#chatgpt-automation-ui .overlay-field .overlay {
  position: absolute;
  right: 6px;
  top: 6px;
  opacity: 0;
  transition: opacity 0.15s ease;
}
#chatgpt-automation-ui .overlay-field:hover .overlay {
  opacity: 1;
}

#chatgpt-automation-ui .size-inputs-grid {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

#chatgpt-automation-ui .size-input-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

#chatgpt-automation-ui .size-input-group label {
  font-size: 12px;
  margin: 0;
  color: var(--text-primary, #374151);
}

#chatgpt-automation-ui.dark-mode .size-input-group label {
  color: var(--text-primary, #f3f4f6);
}

#chatgpt-automation-ui .settings-input.size {
  width: 120px;
}

#chatgpt-automation-ui .checkbox-label {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #374151);
}

#chatgpt-automation-ui.dark-mode .checkbox-label {
  color: var(--text-primary, #f3f4f6);
}

#chatgpt-automation-ui .checkbox-label input[type="checkbox"] {
  margin-right: 8px;
}

#chatgpt-automation-ui .form-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}

#chatgpt-automation-ui .btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}

#chatgpt-automation-ui .btn-primary {
  background: var(--brand-purple, #6366f1);
  color: white;
}

#chatgpt-automation-ui .btn-primary:hover {
  background: var(--brand-purple-darker, #4f46e5);
}

#chatgpt-automation-ui .btn-secondary {
  background: var(--surface-secondary, #f3f4f6);
  color: var(--text-primary, #374151);
  border: 1px solid var(--border-light, rgba(0, 0, 0, 0.06));
}

#chatgpt-automation-ui.dark-mode .btn-secondary {
  background: var(--surface-secondary, #1e1e20);
  color: var(--text-primary, #f3f4f6);
  border-color: var(--border-light, rgba(255, 255, 255, 0.06));
}

#chatgpt-automation-ui .btn-secondary:hover {
  background: var(--surface-secondary, #e5e7eb);
}

#chatgpt-automation-ui.dark-mode .btn-secondary:hover {
  background: var(--surface-secondary, #2a2a2d);
}

#chatgpt-automation-ui .btn-danger {
  background: #ef4444;
  color: white;
}

#chatgpt-automation-ui .btn-danger:hover {
  background: #dc2626;
}

#chatgpt-automation-ui .btn-warning {
  background: #f59e0b;
  color: white;
}

#chatgpt-automation-ui .btn-warning:hover {
  background: #d97706;
}

#chatgpt-automation-ui .btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

#chatgpt-automation-ui .spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid white;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

#chatgpt-automation-ui .automation-log {
  border-top: 1px solid var(--border-light, rgba(0, 0, 0, 0.06));
  /* Base height when expanded; can be resized */
  height: 150px;
  flex: 1 1 auto;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

#chatgpt-automation-ui.dark-mode .automation-log {
  border-color: var(--border-light, rgba(255, 255, 255, 0.06));
}

#chatgpt-automation-ui .log-header {
  padding: 12px 16px;
  background: var(--surface-secondary, #f8fafc);
  font-weight: 500;
  font-size: 13px;
  color: var(--text-primary, #374151);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

#chatgpt-automation-ui.dark-mode .log-header {
  background: var(--surface-secondary, #1e1e20);
  color: var(--text-primary, #f3f4f6);
}

#chatgpt-automation-ui .log-header-controls {
  display: flex;
  gap: 4px;
}

#chatgpt-automation-ui .log-content {
  padding: 16px;
  overflow-y: auto;
  scroll-behavior: smooth;
  flex: 1 1 auto;
  min-height: 0;
}

#chatgpt-automation-ui #step-next-select {
  width: 100%;
}

#chatgpt-automation-ui .log-entry {
  padding: 6px 0;
  font-size: 11px;
  font-family: "SF Mono", "Monaco", "Menlo", "Ubuntu Mono", monospace;
  border-bottom: 1px solid var(--border-light, rgba(0, 0, 0, 0.03));
  line-height: 1.4;
}

#chatgpt-automation-ui .log-entry:last-child {
  border-bottom: none;
  margin-bottom: 6px; /* extra space below last entry */
}

#chatgpt-automation-ui .log-info {
  color: var(--text-primary, #374151);
}

#chatgpt-automation-ui.dark-mode .log-info {
  color: var(--text-primary, #d1d5db);
}

#chatgpt-automation-ui .log-warning {
  color: #f59e0b;
}

#chatgpt-automation-ui .log-error {
  color: #ef4444;
}

#chatgpt-automation-ui .resize-handle {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 20px;
  height: 20px;
  cursor: nw-resize;
  background: linear-gradient(
    -45deg,
    transparent 0%,
    transparent 40%,
    var(--border-medium, rgba(0, 0, 0, 0.1)) 40%,
    var(--border-medium, rgba(0, 0, 0, 0.1)) 60%,
    transparent 60%,
    transparent 100%
  );
}

/* Chain canvas styles */
#chatgpt-automation-ui .chain-canvas {
  border: 1px dashed var(--border-light, rgba(0, 0, 0, 0.1));
  border-radius: 8px;
  padding: 8px;
  min-height: 120px;
}
#chatgpt-automation-ui .chain-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
#chatgpt-automation-ui .chain-cards {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: flex-start;
  min-height: 80px;
}

/* Empty chain cards container */
#chatgpt-automation-ui .chain-cards:empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-secondary, #f8fafc);
  border: 2px dashed var(--border-medium, rgba(0, 0, 0, 0.15));
  border-radius: 12px;
  padding: 32px 16px;
  text-align: center;
  color: var(--text-secondary, #6b7280);
  font-size: 14px;
  transition: all 0.2s ease;
}
#chatgpt-automation-ui.dark-mode .chain-cards:empty {
  background: var(--surface-secondary, #1e1e20);
  border-color: var(--border-medium, rgba(255, 255, 255, 0.15));
  color: var(--text-secondary, #9ca3af);
}
#chatgpt-automation-ui .chain-cards:empty::before {
  content: "🔗 No steps yet. Click 'Add Step' to start building your automation chain.";
  font-weight: 500;
}

#chatgpt-automation-ui .chain-card {
  background: var(--surface-secondary, #f8fafc);
  border: 1px solid var(--border-light, rgba(0, 0, 0, 0.06));
  border-radius: 8px;
  padding: 8px;
  min-width: 140px;
  max-width: 200px;
  position: relative;
  transition: all 0.2s ease;
}
#chatgpt-automation-ui .chain-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  transform: translateY(-1px);
}
#chatgpt-automation-ui.dark-mode .chain-card {
  background: var(--surface-secondary, #1e1e20);
  border-color: var(--border-light, rgba(255, 255, 255, 0.06));
}
#chatgpt-automation-ui.dark-mode .chain-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
#chatgpt-automation-ui .chain-card .title {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 4px;
}
#chatgpt-automation-ui .chain-card .meta {
  font-size: 11px;
  opacity: 0.8;
  margin-bottom: 6px;
}
#chatgpt-automation-ui .chain-card .actions {
  display: flex;
  gap: 6px;
}

/* Composer presets */
#chatgpt-automation-ui .composer-presets {
  margin-bottom: 12px;
  padding: 8px;
  background: var(--surface-secondary, #f8fafc);
  border-radius: 8px;
  border: 1px solid var(--border-light, rgba(0, 0, 0, 0.06));
}
#chatgpt-automation-ui.dark-mode .composer-presets {
  background: var(--surface-secondary, #1e1e20);
  border-color: var(--border-light, rgba(255, 255, 255, 0.06));
}
#chatgpt-automation-ui .composer-presets .preset-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* Modal */
#chatgpt-automation-ui .chain-modal {
  position: fixed;
  inset: 0;
  z-index: 10001;
}
#chatgpt-automation-ui .chain-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
}
#chatgpt-automation-ui .chain-modal-dialog {
  position: relative;
  background: var(--main-surface-primary, #fff);
  width: 520px;
  max-width: calc(100% - 32px);
  margin: 40px auto;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
#chatgpt-automation-ui.dark-mode .chain-modal-dialog {
  background: var(--main-surface-primary, #2d2d30);
}
#chatgpt-automation-ui .chain-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-light, rgba(0, 0, 0, 0.06));
  gap: 12px;
}
#chatgpt-automation-ui .step-modal-presets {
  display: flex;
  gap: 8px;
  align-items: center;
}
#chatgpt-automation-ui .chain-modal-body {
  padding: 12px 16px;
  max-height: 60vh;
  overflow: auto;
}
#chatgpt-automation-ui .chain-modal-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--border-light, rgba(0, 0, 0, 0.06));
}

#chatgpt-automation-ui .presets-grid .preset-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

/* Responsive design */
@media (max-width: 768px) {
  #chatgpt-automation-ui {
    width: 320px;
    right: 10px;
    top: 10px;
  }
}

/* Animation keyframes */
@keyframes pulse-idle {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

@keyframes pulse-processing {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(1.2);
  }
}

#chatgpt-automation-ui .status-processing .status-dot {
  background: #f59e0b;
  animation: pulse-processing 1s infinite;
}

#chatgpt-automation-ui .status-waiting .status-dot {
  background: #3b82f6;
  animation: pulse-processing 1.5s infinite;
}

#chatgpt-automation-ui .status-complete .status-dot {
  background: #10b981;
  animation: none;
}

#chatgpt-automation-ui .status-error .status-dot {
  background: #ef4444;
  animation: pulse-processing 0.5s infinite;
}
`;
      document.head.appendChild(style);
    }
    document.body.appendChild(ui.mainContainer);

    // Get UI elements
    ui.statusIndicator = document.getElementById('status-indicator');
    ui.logContainer = document.querySelector('.log-content');
    ui.progressBar = document.getElementById('progress-container');
    ui.progressBarSub = document.getElementById('progress-container-sub');
    ui.miniProgress = document.getElementById('mini-progress');
    ui.miniFill = document.getElementById('mini-fill');
    ui.miniLabel = document.getElementById('mini-label');
    ui.miniSubProgress = document.getElementById('mini-sub-progress');
    ui.miniSubFill = document.getElementById('mini-sub-fill');
    ui.miniSubLabel = document.getElementById('mini-sub-label');
    ui.resizeHandle = document.getElementById('resize-handle');

    // Restore saved inputs, toggles and config
    try {
      // Chain JSON restored later with parsing

      // Checkboxes and switches
      const loopEl = document.getElementById('loop-checkbox');
      const autoRemoveEl = document.getElementById('auto-remove-checkbox');

      if (loopEl) {
        loopEl.checked = !!GM_getValue(STORAGE_KEYS.loop, true);
        state.isLooping = loopEl.checked;
      }
      if (autoRemoveEl) {
        autoRemoveEl.checked = GM_getValue(STORAGE_KEYS.autoRemove, true);
        state.autoRemoveProcessed = autoRemoveEl.checked;
      }

      // Auto-scroll state (button only, no checkbox)
      state.autoScrollLogs = GM_getValue(STORAGE_KEYS.autoScroll, true);

      // Wait time
      const waitInput = document.getElementById('wait-time-input');
      const savedWait = parseInt(GM_getValue(STORAGE_KEYS.waitTime, state.batchWaitTime));
      if (!Number.isNaN(savedWait)) {
        state.batchWaitTime = savedWait;
        if (waitInput) waitInput.value = String(savedWait);
      }
      // Per-step wait time
      const stepWaitInput = document.getElementById('step-wait-input');
      const savedStepWait = parseInt(GM_getValue(STORAGE_KEYS.stepWaitTime, 0));
      if (stepWaitInput && !Number.isNaN(savedStepWait)) {
        stepWaitInput.value = String(savedStepWait);
      }

      // Active tab
      const savedTab = GM_getValue(STORAGE_KEYS.activeTab, 'composer');
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${savedTab}"]`);
      if (tabBtn) {
        tabBtn.click();
      } else {
        // Fallback to composer if saved tab doesn't exist
        const composerBtn = document.querySelector(`.tab-btn[data-tab="composer"]`);
        if (composerBtn) composerBtn.click();
      }

      // Config - apply saved values and reflect in UI
      const dbgVal = !!GM_getValue(STORAGE_KEYS.configDebug, CONFIG.DEBUG_MODE);
      CONFIG.DEBUG_MODE = dbgVal;
      const dbgEl = document.getElementById('debug-mode-checkbox');
      if (dbgEl) dbgEl.checked = dbgVal;

      const toVal = parseInt(GM_getValue(STORAGE_KEYS.configTimeout, CONFIG.RESPONSE_TIMEOUT));
      if (!Number.isNaN(toVal)) CONFIG.RESPONSE_TIMEOUT = toVal;
      const toEl = document.getElementById('response-timeout-input');
      if (toEl) toEl.value = String(CONFIG.RESPONSE_TIMEOUT);

      const defVis = !!GM_getValue(STORAGE_KEYS.configDefaultVisible, CONFIG.DEFAULT_VISIBLE);
      CONFIG.DEFAULT_VISIBLE = defVis;
      const dvEl = document.getElementById('default-visible-checkbox');
      if (dvEl) dvEl.checked = defVis;

      // Chain definition
      const savedChain = GM_getValue(STORAGE_KEYS.chainDef, '');
      const chainInput = document.getElementById('chain-json-input');
      if (savedChain && chainInput) {
        chainInput.value =
          typeof savedChain === 'string' ? savedChain : JSON.stringify(savedChain, null, 2);
        try {
          state.chainDefinition = JSON.parse(chainInput.value);
        } catch {
          state.chainDefinition = null;
        }
      }
    } catch {}

    // Load saved state
    const savedState = uiState.load();
    if (savedState.left) {
      ui.mainContainer.style.left = savedState.left;
      ui.mainContainer.style.right = 'auto';
    }
    if (savedState.top) {
      ui.mainContainer.style.top = savedState.top;
    }
    if (savedState.minimized) {
      state.isMinimized = true;
      ui.mainContainer.classList.add('minimized');
    }
    // Respect explicit persisted visibility over default
    if (typeof savedState.visible === 'boolean') {
      state.uiVisible = savedState.visible;
    } else {
      state.uiVisible = !!CONFIG.DEFAULT_VISIBLE;
    }
    ui.mainContainer.style.display = state.uiVisible ? 'block' : 'none';

    // Restore persisted log history
    try {
      const hist = GM_getValue(STORAGE_KEYS.logHistory, []);
      if (Array.isArray(hist) && hist.length && ui.logContainer) {
        hist.slice(-200).forEach((h) => {
          const div = document.createElement('div');
          div.className = `log-entry log-${h.type || 'info'}`;
          div.textContent = h.msg;
          ui.logContainer.appendChild(div);
        });
        ui.logContainer.scrollTop = ui.logContainer.scrollHeight;
      }
    } catch {}

    // Bind events
    bindEvents();

    // Initialize auto-scroll button state
    const autoScrollBtn = document.getElementById('toggle-auto-scroll-btn');
    if (autoScrollBtn && typeof state.autoScrollLogs === 'boolean') {
      autoScrollBtn.style.opacity = state.autoScrollLogs ? '1' : '0.5';
      autoScrollBtn.title = state.autoScrollLogs ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
    }

    // Watch for theme changes
    const observer = new MutationObserver(() => {
      const newDarkMode = utils.detectDarkMode();
      if (newDarkMode !== state.isDarkMode) {
        state.isDarkMode = newDarkMode;
        ui.mainContainer.className = state.isDarkMode ? 'dark-mode' : 'light-mode';
        if (state.isMinimized) ui.mainContainer.classList.add('minimized');
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });

    // Add persistent header launcher
    mountHeaderLauncher();
    startHeaderObserver();
    utils.log('UI initialized successfully');
  };

  // Header launcher utilities
  const createLauncherButton = () => {
    const btn = document.createElement('button');
    btn.id = 'chatgpt-automation-launcher';
    btn.type = 'button';
    btn.title = 'Open Automation';
    btn.setAttribute('aria-label', 'Open Automation');
    btn.className = 'btn relative btn-ghost text-token-text-primary';
    btn.innerHTML = `<div class="flex w-full items-center justify-center gap-1.5"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" width="20" height="20" fill="currentColor" class="icon"><path d="M273 151.1L288 171.8L303 151.1C328 116.5 368.2 96 410.9 96C484.4 96 544 155.6 544 229.1L544 231.7C544 249.3 540.6 267.3 534.5 285.4C512.7 276.8 488.9 272 464 272C358 272 272 358 272 464C272 492.5 278.2 519.6 289.4 544C288.9 544 288.5 544 288 544C272.5 544 257.2 539.4 244.9 529.9C171.9 474.2 32 343.9 32 231.7L32 229.1C32 155.6 91.6 96 165.1 96C207.8 96 248 116.5 273 151.1zM320 464C320 384.5 384.5 320 464 320C543.5 320 608 384.5 608 464C608 543.5 543.5 608 464 608C384.5 608 320 543.5 320 464zM497.4 387C491.6 382.8 483.6 383 478 387.5L398 451.5C392.7 455.7 390.6 462.9 392.9 469.3C395.2 475.7 401.2 480 408 480L440.9 480L425 522.4C422.5 529.1 424.8 536.7 430.6 541C436.4 545.3 444.4 545 450 540.5L530 476.5C535.3 472.3 537.4 465.1 535.1 458.7C532.8 452.3 526.8 448 520 448L487.1 448L503 405.6C505.5 398.9 503.2 391.3 497.4 387z"/></svg><span class="max-md:hidden">Automation</span></div>`;
    btn.addEventListener('click', () => {
      // If UI was removed by a re-render, recreate it
      let panel = document.getElementById('chatgpt-automation-ui');
      if (!panel) {
        createUI();
        panel = document.getElementById('chatgpt-automation-ui');
      }
      if (!panel) return;
      const show = panel.style.display === 'none';
      panel.style.display = show ? 'block' : 'none';
      ui.mainContainer = panel;
      state.uiVisible = show;
      saveUIState();
    });
    return btn;
  };

  const mountHeaderLauncher = () => {
    const header = document.getElementById('page-header');
    if (!header) return false;
    let target = header.querySelector('#conversation-header-actions');
    if (!target) target = header;
    if (!target.querySelector('#chatgpt-automation-launcher')) {
      const btn = createLauncherButton();
      target.appendChild(btn);
    }
    // Also ensure the UI exists if it should be visible
    const savedState = uiState.load();
    const shouldShow =
      savedState.visible === true || (savedState.visible == null && CONFIG.DEFAULT_VISIBLE);
    if (shouldShow && !document.getElementById('chatgpt-automation-ui')) {
      createUI();
    }
    return true;
  };

  const startHeaderObserver = () => {
    if (state.headerObserverStarted) return;
    state.headerObserverStarted = true;
    const ensure = () => {
      try {
        // Recreate launcher if missing
        mountHeaderLauncher();
        // Ensure UI matches persisted visibility
        const savedState = uiState.load();
        const panel = document.getElementById('chatgpt-automation-ui');
        const shouldShow =
          savedState.visible === true || (savedState.visible == null && CONFIG.DEFAULT_VISIBLE);
        if (panel) {
          panel.style.display = shouldShow ? 'block' : 'none';
        } else if (shouldShow) {
          createUI();
        }
      } catch (e) {
        /* noop */
      }
    };
    ensure();
    const obs = new MutationObserver(() => ensure());
    obs.observe(document.body, { childList: true, subtree: true });
  };

  const updateStatus = (status) => {
    if (!ui.statusIndicator) return;
    const statusTexts = {
      idle: 'Ready',
      processing: 'Typing...',
      waiting: 'Waiting for response...',
      complete: 'Complete',
      error: 'Error',
    };
    ui.statusIndicator.className = `status-indicator status-${status}`;
    const textEl = ui.statusIndicator.querySelector('.status-text');
    if (textEl) textEl.textContent = statusTexts[status] || 'Unknown';
  };

  const updateProgress = (done, total) => {
    // Use header mini progress as single source of truth. Keep in-panel progress hidden.
    if (!ui.miniProgress || !ui.miniFill || !ui.miniLabel) return;
    const show = total > 0;
    // Hide the in-panel progress container entirely (not used)
    try {
      if (ui.progressBar) ui.progressBar.style.display = 'none';
    } catch {}
    ui.miniProgress.style.display = show ? 'flex' : 'none';
    if (!show) {
      ui.miniFill.style.width = '0%';
      ui.miniLabel.textContent = '0/0';
      return;
    }
    const pct = total ? Math.round((done / total) * 100) : 0;
    ui.miniFill.style.width = pct + '%';
    ui.miniLabel.textContent = `${done}/${total}`;
  };

  const updateSubProgress = (done, total) => {
    // Use header mini sub-progress as single source of truth. Keep in-panel sub progress hidden.
    if (!ui.miniSubProgress || !ui.miniSubFill || !ui.miniSubLabel) return;
    const show = total > 0;
    try {
      if (ui.progressBarSub) ui.progressBarSub.style.display = 'none';
      const subText = document.getElementById('progress-text-sub');
      if (subText) subText.style.display = 'none';
    } catch {}
    ui.miniSubProgress.style.display = show ? 'flex' : 'none';
    if (!show) {
      ui.miniSubFill.style.width = '0%';
      ui.miniSubLabel.textContent = '0/0';
      return;
    }
    const pct = total ? Math.round((done / total) * 100) : 0;
    ui.miniSubFill.style.width = pct + '%';
    ui.miniSubLabel.textContent = `${done}/${total}`;
  };

  // Unified progress helper that clamps values and drives header mini bars
  const refreshBatchProgress = (doneLike, totalLike) => {
    const total = Math.max(0, Number(totalLike || 0));
    const done = Math.max(0, Math.min(Number(doneLike || 0), total));
    updateProgress(done, total);
    return { done, total };
  };

  // Safely remove N items from the head of dynamicElements, keep JSON/textarea in sync
  const removeHeadItems = (count = 1) => {
    if (!Array.isArray(state.dynamicElements) || count <= 0) return;
    try {
      state.dynamicElements.splice(0, count);
    } catch {}
    try {
      if (!state.chainDefinition) {
        const txt = document.getElementById('chain-json-input')?.value || '{}';
        state.chainDefinition = JSON.parse(txt);
      }
      state.chainDefinition.dynamicElements = state.dynamicElements;
      const chainInput = document.getElementById('chain-json-input');
      if (chainInput) chainInput.value = JSON.stringify(state.chainDefinition, null, 2);
    } catch {}
    try {
      const dynEl = document.getElementById('dynamic-elements-input');
      if (dynEl) dynEl.value = JSON.stringify(state.dynamicElements, null, 2);
    } catch {}
  };

  // Allow canceling long runs
  const stopBatchProcessing = () => {
    state.cancelRequested = true;
    utils.log('Stop requested');
  };

  // Function to start a new chat (language independent, uses data-testid)
  const startNewChat = async () => {
    utils.log('Starting new chat...');
    const btn = document.querySelector('a[data-testid="create-new-chat-button"]');
    if (btn) {
      utils.log('Using new chat button...');
      btn.click();
      await utils.sleep(1000);
      return true;
    }
    const homeLink = document.querySelector('a[href="/"]');
    if (homeLink && (homeLink.textContent || '').trim() !== '') {
      utils.log('Using home link...');
      homeLink.click();
      await utils.sleep(1000);
      return true;
    }
    utils.log('Failed to start a new chat', 'warning');
    return false;
  };

  const bindEvents = () => {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;

        // Update active tab button
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        // Update active tab content
        document
          .querySelectorAll('.tab-content')
          .forEach((content) => content.classList.remove('active'));
        document.getElementById(`${tabName}-tab`).classList.add('active');

        // Persist active tab
        utils.saveToStorage(STORAGE_KEYS.activeTab, tabName);
      });
    });

    // Stop batch button
    document.getElementById('stop-batch-btn').addEventListener('click', () => {
      stopBatchProcessing();
      document.getElementById('stop-batch-btn').style.display = 'none';
    });

    // Auto-remove processed items checkbox
    document.getElementById('auto-remove-checkbox').addEventListener('change', (e) => {
      state.autoRemoveProcessed = e.target.checked;
      utils.log(
        `Auto-remove processed items: ${state.autoRemoveProcessed ? 'enabled' : 'disabled'}`
      );
      utils.saveToStorage(STORAGE_KEYS.autoRemove, state.autoRemoveProcessed);
    });

    // Wait time input
    document.getElementById('wait-time-input').addEventListener('change', (e) => {
      const value = parseInt(e.target.value);
      if (value >= 0 && value <= 30000) {
        state.batchWaitTime = value;
        utils.log(`Wait time between items set to ${value}ms`);
        utils.saveToStorage(STORAGE_KEYS.waitTime, state.batchWaitTime);
      } else {
        e.target.value = state.batchWaitTime;
        utils.log('Invalid wait time, keeping current value', 'warning');
      }
    });

    // Per-step wait time input
    const stepWaitEl = document.getElementById('step-wait-input');
    if (stepWaitEl) {
      stepWaitEl.addEventListener('change', (e) => {
        const value = parseInt(e.target.value);
        if (value >= 0 && value <= 30000) {
          utils.saveToStorage(STORAGE_KEYS.stepWaitTime, value);
          utils.log(`Wait time between steps set to ${value}ms`);
        } else {
          const saved = parseInt(GM_getValue(STORAGE_KEYS.stepWaitTime, 0));
          e.target.value = String(!Number.isNaN(saved) ? saved : 0);
          utils.log('Invalid per-step wait time, keeping current value', 'warning');
        }
      });
    }

    const toggleLogVisibility = () => {
      const logWrap = document.getElementById('log-container');
      if (!logWrap) return;
      const currentlyHidden = logWrap.style.display === 'none';
      const willShow = currentlyHidden;
      logWrap.style.display = willShow ? 'flex' : 'none';
      // Toggle class on main container so CSS can adapt minimized height
      if (ui.mainContainer) {
        ui.mainContainer.classList.toggle('log-open', willShow);
      }
      utils.saveToStorage(STORAGE_KEYS.logVisible, willShow);
    };
    document.getElementById('header-log-toggle').addEventListener('click', toggleLogVisibility);

    // Clear log button
    document.getElementById('clear-log-btn').addEventListener('click', () => {
      if (ui.logContainer) ui.logContainer.innerHTML = '';
      utils.saveToStorage(STORAGE_KEYS.logHistory, []);
      utils.log('Log cleared');
    });

    // Stop button in minimized header
    document.getElementById('stop-mini-btn').addEventListener('click', () => {
      stopBatchProcessing();
      const stopRunBtn = document.getElementById('stop-run-btn');
      if (stopRunBtn) stopRunBtn.style.display = 'none';
      const stopBtn = document.getElementById('stop-batch-btn');
      if (stopBtn) stopBtn.style.display = 'none';
      const stopMini = document.getElementById('stop-mini-btn');
      if (stopMini) stopMini.style.display = 'none';
    });

    // Toggle auto-scroll button
    document.getElementById('toggle-auto-scroll-btn').addEventListener('click', () => {
      state.autoScrollLogs = !state.autoScrollLogs;
      const btn = document.getElementById('toggle-auto-scroll-btn');
      btn.style.opacity = state.autoScrollLogs ? '1' : '0.5';
      btn.title = state.autoScrollLogs ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
      utils.log(`Auto-scroll logs: ${state.autoScrollLogs ? 'enabled' : 'disabled'}`);
      if (state.autoScrollLogs && ui.logContainer)
        ui.logContainer.scrollTop = ui.logContainer.scrollHeight;
      utils.saveToStorage(STORAGE_KEYS.autoScroll, state.autoScrollLogs);
    });

    document.getElementById('minimize-btn').addEventListener('click', () => {
      state.isMinimized = !state.isMinimized;
      if (state.isMinimized) {
        // Save previous explicit height if present
        ui.mainContainer.classList.add('minimized');
      } else {
        ui.mainContainer.classList.remove('minimized');

        ui.mainContainer.style.height = '';
        // after finishing resize and saving state
        isResizing = false;
        // allow CSS/auto layout to reclaim sizing by removing inline size overrides
        if (ui.mainContainer) {
          ui.mainContainer.style.removeProperty('width');
          ui.mainContainer.style.removeProperty('height');
        }
        saveUIState(true);
      }
      saveUIState(true); // Immediate save for user action
    });

    // Close button
    document.getElementById('close-btn').addEventListener('click', () => {
      ui.mainContainer.style.display = 'none';
      state.uiVisible = false;
      saveUIState(true); // Immediate save for user action
      utils.log('UI closed');
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Ctrl/Cmd + Enter to send
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const sendBtn = document.getElementById('send-btn');
        if (sendBtn) sendBtn.click();
        e.preventDefault();
      }

      // Escape to minimize
      if (e.key === 'Escape') {
        document.getElementById('minimize-btn').click();
        e.preventDefault();
      }
    });

    // Dragging functionality
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    // Resizing functionality
    let isResizing = false;
    let resizeStartX, resizeStartY, resizeStartWidth, resizeStartHeight;

    const header = document.getElementById('automation-header');

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.header-btn')) return; // Don't drag when clicking buttons

      isDragging = true;
      const rect = ui.mainContainer.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      header.style.userSelect = 'none';
      e.preventDefault();
    });

    ui.resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartWidth = ui.mainContainer.offsetWidth;
      resizeStartHeight = ui.mainContainer.offsetHeight;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        const x = e.clientX - dragOffset.x;
        const y = e.clientY - dragOffset.y;

        ui.mainContainer.style.left = `${Math.max(0, Math.min(x, window.innerWidth - ui.mainContainer.offsetWidth))}px`;
        ui.mainContainer.style.top = `${Math.max(0, Math.min(y, window.innerHeight - ui.mainContainer.offsetHeight))}px`;
        ui.mainContainer.style.right = 'auto';

        saveUIState(); // Debounced for drag operations
      } else if (isResizing) {
        // Clamp resizing to reasonable window bounds (sizes are automatic)
        const rawWidth = resizeStartWidth + (e.clientX - resizeStartX);
        const rawHeight = resizeStartHeight + (e.clientY - resizeStartY);
        const newWidth = Math.max(200, Math.min(window.innerWidth, rawWidth));
        const newHeight = Math.max(120, Math.min(window.innerHeight, rawHeight));

        ui.mainContainer.style.width = `${newWidth}px`;
        ui.mainContainer.style.height = `${newHeight}px`;

        saveUIState(); // Debounced for resize operations
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        saveUIState(true); // Immediate save when drag ends
        isDragging = false;
        header.style.userSelect = '';
      }
      if (isResizing) {
        saveUIState(true); // Immediate save when resize ends
        isResizing = false;
      }
    });

    // Persist loop checkbox when used
    const loopEl = document.getElementById('loop-checkbox');
    loopEl.addEventListener('change', (e) => {
      state.isLooping = e.target.checked;
      utils.saveToStorage(STORAGE_KEYS.loop, state.isLooping);
    });

    // Settings: Debug mode
    const debugEl = document.getElementById('debug-mode-checkbox');
    if (debugEl) {
      debugEl.addEventListener('change', (e) => {
        CONFIG.DEBUG_MODE = !!e.target.checked;
        utils.saveToStorage(STORAGE_KEYS.configDebug, CONFIG.DEBUG_MODE);
        utils.log(`Debug mode ${CONFIG.DEBUG_MODE ? 'enabled' : 'disabled'}`);
      });
    }

    // Settings: Response timeout
    const timeoutEl = document.getElementById('response-timeout-input');
    if (timeoutEl) {
      timeoutEl.addEventListener('change', (e) => {
        const v = parseInt(e.target.value);
        if (!Number.isNaN(v) && v >= 10000 && v <= 6000000) {
          CONFIG.RESPONSE_TIMEOUT = v;
          utils.saveToStorage(STORAGE_KEYS.configTimeout, v);
          utils.log(`Response timeout set to ${v}ms`);
        } else {
          e.target.value = String(CONFIG.RESPONSE_TIMEOUT);
          utils.log('Invalid response timeout', 'warning');
        }
      });
    }

    // Settings: default visible
    const defVisEl = document.getElementById('default-visible-checkbox');
    if (defVisEl)
      defVisEl.addEventListener('change', (e) => {
        CONFIG.DEFAULT_VISIBLE = !!e.target.checked;
        try {
          GM_setValue(STORAGE_KEYS.configDefaultVisible, CONFIG.DEFAULT_VISIBLE);
        } catch {}
        // If user disables default visibility and UI wasn't explicitly opened, keep current visibility but don't force-open later
        utils.log(`Default visibility ${CONFIG.DEFAULT_VISIBLE ? 'ON' : 'OFF'}`);
      });

    // Restore log visibility
    try {
      const logWrap = document.getElementById('log-container');
      const vis = GM_getValue(STORAGE_KEYS.logVisible, false);
      if (logWrap) {
        logWrap.style.display = vis ? 'flex' : 'none';
      }
      if (ui.mainContainer) {
        ui.mainContainer.classList.toggle('log-open', !!vis);
      }
    } catch {}

    // Chain UI: basic actions
    const chainInput = document.getElementById('chain-json-input');
    const sampleItemsEl = document.getElementById('dynamic-elements-input');
    const chainCards = document.getElementById('chain-cards');
    const refreshChainCards = () => {
      if (!chainCards) return;
      chainCards.innerHTML = '';
      let chain;
      try {
        chain = JSON.parse(chainInput.value || '{}');
        // Update global state.chainDefinition when parsing JSON
        state.chainDefinition = chain;
      } catch {
        chain = null;
        state.chainDefinition = null;
      }
      // Reflect dynamicElements in the dedicated textarea
      if (
        chain &&
        (Array.isArray(chain.dynamicElements) || typeof chain.dynamicElements === 'string') &&
        sampleItemsEl
      ) {
        try {
          sampleItemsEl.value = JSON.stringify(chain.dynamicElements, null, 2);
        } catch {
          // if dynamicElements is a function string, show raw
          try {
            sampleItemsEl.value = String(chain.dynamicElements);
          } catch {}
        }
      }
      if (!chain || !Array.isArray(chain.steps) || chain.steps.length === 0) {
        // Chain cards will show empty state due to CSS :empty selector
        return;
      }
      chain.steps.forEach((step) => {
        const card = document.createElement('div');
        card.className = 'chain-card';
        card.dataset.stepId = step.id;

        const typeDisplay =
          step.type === 'template'
            ? 'Template (Batch)'
            : step.type === 'js'
              ? 'JavaScript'
              : step.type === 'prompt'
                ? 'Prompt'
                : step.type === 'http'
                  ? 'HTTP Request'
                  : step.type;

        card.innerHTML = `
                        <div class="title">${step.title || step.id || '(untitled)'}</div>
                        <div class="meta">type: ${typeDisplay}${step.next ? ` → ${step.next}` : ''}</div>
                        <div class="actions">
                            <button class="btn btn-secondary btn-sm" data-action="edit" title="Edit step">✏️</button>
                            <button class="btn btn-danger btn-sm" data-action="delete" title="Delete step">🗑️</button>
                        </div>
                    `;

        card
          .querySelector('[data-action="edit"]')
          .addEventListener('click', () => openStepEditor(step.id));
        card.querySelector('[data-action="delete"]').addEventListener('click', () => {
          if (confirm(`Delete step "${step.title || step.id}"?`)) {
            chain.steps = chain.steps.filter((s) => s.id !== step.id);
            // Remove references to this step
            chain.steps.forEach((s) => {
              if (s.next === step.id) s.next = '';
            });
            // Update entry point if needed
            if (chain.entryId === step.id) {
              chain.entryId = chain.steps.length > 0 ? chain.steps[0].id : '';
            }
            chainInput.value = JSON.stringify(chain, null, 2);
            utils.saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
            refreshChainCards();
            utils.log(`Step "${step.title || step.id}" deleted`);
          }
        });

        chainCards.appendChild(card);
      });
    };

    const openStepEditor = (stepId) => {
      let chain;
      try {
        chain = JSON.parse(chainInput.value || '{}');
      } catch {
        chain = { steps: [] };
      }
      if (!Array.isArray(chain.steps)) chain.steps = [];
      let step = chain.steps.find((s) => s.id === stepId);
      if (!step) {
        step = { id: stepId || `step-${Date.now()}`, type: 'prompt', title: '', template: '' };
        chain.steps.push(step);
      }
      const modal = document.getElementById('chain-step-modal');
      modal.style.display = 'block';
      modal.setAttribute('aria-hidden', 'false');

      // Populate fields
      document.getElementById('step-id-input').value = step.id || '';
      document.getElementById('step-title-input').value = step.title || '';
      document.getElementById('step-type-select').value = step.type || 'prompt';
      // Per-step options
      const respTypeSel = document.getElementById('step-response-type');
      if (respTypeSel) respTypeSel.value = step.responseType || 'text';
      const newChatCb = document.getElementById('step-newchat-checkbox');
      if (newChatCb) newChatCb.checked = !!step.newChat;

      // Prompt content
      const promptEl = document.getElementById('step-prompt-template');
      if (promptEl) promptEl.value = step.template || step.content || step.message || '';

      // Template fields
      document.getElementById('step-template-input').value = step.template || '';
      const stepElementsEl = document.getElementById('step-template-elements');
      stepElementsEl.value = step.elements || '';
      const useSamplesCb = document.getElementById('step-use-dynamicelements-checkbox');
      // Override-but-restore: when checked, populate the step elements from chain.dynamicElements
      // and disable editing; when unchecked, restore the previous per-step value.
      if (useSamplesCb) {
        useSamplesCb.checked = !!step.useDynamicElements;
        // Replace any existing handler to avoid duplicates
        useSamplesCb.onchange = (e) => {
          try {
            if (e.target.checked) {
              // Backup current step value so it can be restored later
              try {
                modal.dataset.backupStepElements = stepElementsEl.value || '';
              } catch {}
              // Populate from chain.dynamicElements (prefer chain parsed from editor)
              try {
                if (
                  chain &&
                  (Array.isArray(chain.dynamicElements) ||
                    typeof chain.dynamicElements === 'string')
                ) {
                  try {
                    stepElementsEl.value = JSON.stringify(chain.dynamicElements, null, 2);
                  } catch {
                    stepElementsEl.value = String(chain.dynamicElements);
                  }
                } else {
                  stepElementsEl.value = '';
                }
              } catch {}
              stepElementsEl.disabled = true;
            } else {
              // Restore backed-up value (if any) and re-enable editing
              try {
                const bak = modal.dataset.backupStepElements;
                stepElementsEl.value = bak != null ? bak : step.elements || '';
                delete modal.dataset.backupStepElements;
              } catch {
                stepElementsEl.value = step.elements || '';
              }
              stepElementsEl.disabled = false;
            }
          } catch (err) {
            utils.log('Failed to toggle useDynamicElements: ' + err.message, 'error');
          }
        };
        // Initialize UI state according to the checkbox
        if (useSamplesCb.checked) {
          // Trigger handler to populate from chain
          useSamplesCb.dispatchEvent(new Event('change'));
        } else {
          stepElementsEl.disabled = false;
        }
      }

      // Prompt
      document.getElementById('step-prompt-template').value = step.template || '';

      // HTTP fields
      document.getElementById('step-http-url').value = step.url || '';
      document.getElementById('step-http-method').value = (step.method || 'GET').toUpperCase();
      document.getElementById('step-http-headers').value = step.headers
        ? JSON.stringify(step.headers)
        : '';
      document.getElementById('step-http-body').value = step.bodyTemplate || '';

      // JavaScript
      document.getElementById('step-js-code').value = step.code || '';

      // Populate next step selector with auto-suggestion
      const nextSel = document.getElementById('step-next-select');
      nextSel.innerHTML = '<option value="">(end)</option>';
      const currentIndex = chain.steps.findIndex((s) => s.id === step.id);

      chain.steps.forEach((s, index) => {
        if (s.id !== step.id) {
          // Don't include self
          const opt = document.createElement('option');
          opt.value = s.id;
          const labelParts = [s.id];
          if (s.title) labelParts.push('— ' + s.title);
          if (s.type) labelParts.push('(' + s.type + ')');
          opt.textContent = labelParts.join(' ');
          if (step.next === s.id) {
            opt.selected = true;
          } else if (!step.next && index === currentIndex + 1) {
            // Auto-suggest next sequential step
            opt.selected = true;
            step.next = s.id;
          }
          nextSel.appendChild(opt);
        }
      });

      const onTypeChange = () => {
        const type = document.getElementById('step-type-select').value;

        // Clear all fields first when type changes to prevent contamination
        if (step.type && step.type !== type) {
          // Clear previous type's fields from the step object and UI
          delete step.template;
          delete step.elements;
          delete step.code;
          delete step.url;
          delete step.method;
          delete step.headers;
          delete step.bodyTemplate;
          delete step.message;
          // Clear form inputs
          const clear = (id) => {
            const el = document.getElementById(id);
            if (el) el.value = id === 'step-http-method' ? 'GET' : '';
          };
          [
            'step-prompt-template',
            'step-template-input',
            'step-template-elements',
            'step-js-code',
            'step-http-url',
            'step-http-headers',
            'step-http-body',
            'step-http-method',
          ].forEach(clear);

          // Clear form inputs
          document.getElementById('step-prompt-template').value = '';
          document.getElementById('step-template-input').value = '';
          document.getElementById('step-template-elements').value = '';
          document.getElementById('step-js-code').value = '';
          document.getElementById('step-http-url').value = '';
          document.getElementById('step-http-method').value = 'GET';
          document.getElementById('step-http-headers').value = '';
          document.getElementById('step-http-body').value = '';
        }

        // Update step type
        step.type = type;

        // Toggle field groups based on step type
        modal
          .querySelectorAll('[data-field="prompt"]')
          .forEach((el) => (el.style.display = type === 'prompt' ? 'block' : 'none'));
        modal
          .querySelectorAll('[data-field="template"]')
          .forEach((el) => (el.style.display = type === 'template' ? 'block' : 'none'));
        modal
          .querySelectorAll('[data-field="http"]')
          .forEach((el) => (el.style.display = type === 'http' ? 'block' : 'none'));
        modal
          .querySelectorAll('[data-field="js"]')
          .forEach((el) => (el.style.display = type === 'js' ? 'block' : 'none'));
      };
      document.getElementById('step-type-select').onchange = onTypeChange;
      onTypeChange();

      const saveBtn = document.getElementById('save-step-btn');
      const deleteBtn = document.getElementById('delete-step-btn');
      const closeBtn = document.getElementById('close-step-modal-btn');

      const closeModal = () => {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
      };
      closeBtn.onclick = closeModal;

      deleteBtn.onclick = () => {
        if (confirm(`Delete step "${step.title || step.id}"?`)) {
          chain.steps = chain.steps.filter((s) => s.id !== step.id);
          // Remove references
          chain.steps.forEach((s) => {
            if (s.next === step.id) s.next = '';
          });
          // Update entry point if needed
          if (chain.entryId === step.id) {
            chain.entryId = chain.steps.length > 0 ? chain.steps[0].id : '';
          }
          chainInput.value = JSON.stringify(chain, null, 2);
          utils.saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
          refreshChainCards();
          closeModal();
          utils.log(`Step "${step.title || step.id}" deleted`);
        }
      };

      saveBtn.onclick = () => {
        const newId = document.getElementById('step-id-input').value.trim() || step.id;
        const oldId = step.id;
        step.id = newId;
        step.title = document.getElementById('step-title-input').value.trim();
        step.type = document.getElementById('step-type-select').value;
        step.next = document.getElementById('step-next-select').value;

        // Clear all type-specific fields first
        delete step.template;
        delete step.elements;
        delete step.code;
        delete step.url;
        delete step.method;
        delete step.headers;
        delete step.bodyTemplate;
        delete step.message;
        delete step.responseType;
        delete step.newChat;
        delete step.useDynamicElements;

        // Save type-specific fields based on current type
        if (step.type === 'template') {
          step.template = document.getElementById('step-template-input').value;
          step.elements = document.getElementById('step-template-elements').value;
          step.useDynamicElements = !!document.getElementById('step-use-dynamicelements-checkbox')
            ?.checked;
        } else if (step.type === 'prompt') {
          step.template = document.getElementById('step-prompt-template').value;
          step.responseType = document.getElementById('step-response-type')?.value || 'text';
          step.newChat = !!document.getElementById('step-newchat-checkbox')?.checked;
        } else if (step.type === 'http') {
          step.url = document.getElementById('step-http-url').value.trim();
          step.method = document.getElementById('step-http-method').value.trim();
          try {
            const headerText = document.getElementById('step-http-headers').value.trim();
            step.headers = headerText ? JSON.parse(headerText) : {};
          } catch {
            step.headers = {};
          }
          step.bodyTemplate = document.getElementById('step-http-body').value;
        } else if (step.type === 'js') {
          step.code = document.getElementById('step-js-code').value;
        }

        // If ID changed, update references
        if (oldId !== newId) {
          chain.steps.forEach((s) => {
            if (s.next === oldId) s.next = newId;
          });
          if (chain.entryId === oldId) chain.entryId = newId;
        }

        chainInput.value = JSON.stringify(chain, null, 2);
        utils.saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
        refreshChainCards();
        closeModal();
        utils.log(`Step "${step.title || step.id}" saved`);

        // Note: preset save is handled by the dedicated icon in the popup
      };
    };

    const addStepBtn = document.getElementById('add-step-btn');
    if (addStepBtn)
      addStepBtn.addEventListener('click', () => {
        let chain;
        try {
          chain = JSON.parse(chainInput.value || '{}');
        } catch {
          chain = {};
        }
        if (!chain.steps) chain.steps = [];

        const id = `step-${(chain.steps.length || 0) + 1}`;
        const newStep = {
          id,
          title: `Step ${chain.steps.length + 1}`,
          type: 'prompt',
          template: '',
        };

        // Auto-link the previous step if it doesn't have a next
        if (chain.steps.length > 0) {
          const lastStep = chain.steps[chain.steps.length - 1];
          if (!lastStep.next) {
            lastStep.next = id;
          }
        }

        chain.steps.push(newStep);
        if (!chain.entryId) chain.entryId = id;
        chainInput.value = JSON.stringify(chain, null, 2);
        utils.saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
        refreshChainCards();

        // Open editor and default to "Select preset"
        openStepEditor(id);
        // Reset the preset selector to show "Select preset..."
        setTimeout(() => {
          const presetSelect = document.getElementById('step-preset-select');
          if (presetSelect) presetSelect.value = '';
        }, 100);
      });

    const validateChainBtn = document.getElementById('validate-chain-btn');
    if (validateChainBtn)
      validateChainBtn.addEventListener('click', () => {
        // Ensure log is visible when validating for better feedback
        try {
          const logWrap = document.getElementById('log-container');
          if (logWrap && logWrap.style.display === 'none') {
            logWrap.style.display = 'flex';
            if (ui.mainContainer) ui.mainContainer.classList.add('log-open');
            utils.saveToStorage(STORAGE_KEYS.logVisible, true);
          }
        } catch {}
        try {
          const c = JSON.parse(chainInput.value || '{}');
          if (!c.entryId) throw new Error('Missing entryId');
          if (!Array.isArray(c.steps) || !c.steps.length) throw new Error('No steps');
          const ids = new Set(c.steps.map((s) => s.id));
          if (!ids.has(c.entryId)) throw new Error('entryId not found among steps');
          c.steps.forEach((s) => {
            if (s.next && !ids.has(s.next))
              throw new Error(`Step ${s.id} next '${s.next}' not found`);
          });
          utils.log('Chain valid');
        } catch (e) {
          utils.log('Chain invalid: ' + e.message, 'error');
        }
      });

    const runChainBtn = document.getElementById('run-chain-btn');
    const stopRunBtn = document.getElementById('stop-run-btn');
    if (stopRunBtn) {
      stopRunBtn.addEventListener('click', () => {
        stopBatchProcessing();
        stopRunBtn.style.display = 'none';
      });
    }
    if (runChainBtn)
      runChainBtn.addEventListener('click', async () => {
        // When running, load whatever is currently in the dynamic elements textarea
        try {
          const dynEl = document.getElementById('dynamic-elements-input');
          let items = [];
          if (dynEl) {
            const raw = (dynEl.value || '').trim();
            if (raw) {
              if (raw.startsWith('[') || raw.startsWith('{')) {
                try {
                  const parsed = JSON.parse(raw);
                  items = Array.isArray(parsed) ? parsed : [parsed];
                } catch (e) {
                  // fallback to processor for function-style inputs
                  try {
                    const parsed = await processors.parseDynamicElements(raw);
                    items = Array.isArray(parsed) ? parsed : [parsed];
                  } catch {}
                }
              } else {
                try {
                  const parsed = await processors.parseDynamicElements(raw);
                  items = Array.isArray(parsed) ? parsed : [parsed];
                } catch {}
              }
            }
          }
          state.dynamicElements = items;
          // If the new list is shorter than what we've already processed, clamp the current index
          try {
            if (
              typeof state.currentBatchIndex === 'number' &&
              state.currentBatchIndex > items.length
            ) {
              state.currentBatchIndex = Math.max(0, items.length);
            }
          } catch {}
          // Keep chainDefinition in sync so the JSON reflects the runtime items
          try {
            if (!state.chainDefinition) {
              state.chainDefinition = JSON.parse(
                document.getElementById('chain-json-input').value || '{}'
              );
            }
            state.chainDefinition.dynamicElements = items;
            const chainInput = document.getElementById('chain-json-input');
            if (chainInput) chainInput.value = JSON.stringify(state.chainDefinition, null, 2);
          } catch {}
        } catch (e) {
          utils.log('Failed to read dynamic elements before run: ' + e.message, 'warning');
        }

        if (stopRunBtn) stopRunBtn.style.display = 'inline-flex';
        await runChainWithBatch();
        if (stopRunBtn) stopRunBtn.style.display = 'none';
      });

    // Generic JSON formatter for overlay buttons
    const registerJsonFormatter = (btnId, inputId, opts = {}) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        try {
          const src = document.getElementById(inputId);
          if (!src) return;
          const val = (src.value || '').trim();
          if (!val) return;
          let parsed;
          if (!opts.allowFunction && (val.startsWith('[') || val.startsWith('{')))
            parsed = JSON.parse(val);
          else parsed = await processors.parseDynamicElements(val);
          src.value = JSON.stringify(parsed, null, 2);
          utils.log(`${opts.label || 'JSON'} formatted`);
        } catch (e) {
          utils.log(`Invalid ${opts.label || 'value'}: ${e.message}`, 'error');
        }
      });
    };

    registerJsonFormatter('format-chain-json-btn', 'chain-json-input', {
      label: 'Chain JSON',
      allowFunction: false,
    });
    registerJsonFormatter('format-dyn-elements-btn', 'dynamic-elements-input', {
      label: 'Dynamic elements',
      allowFunction: true,
    });
    registerJsonFormatter('format-step-elements-btn', 'step-template-elements', {
      label: 'Step elements',
      allowFunction: true,
    });
    registerJsonFormatter('format-http-headers-btn', 'step-http-headers', {
      label: 'HTTP headers',
      allowFunction: false,
    });
    registerJsonFormatter('format-http-body-btn', 'step-http-body', {
      label: 'HTTP body',
      allowFunction: false,
    });

    // Change events to keep cards in sync and persist data
    if (chainInput) {
      chainInput.addEventListener('input', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(chainInput.value || '{}');
        } catch {
          /* ignore parse errors during typing */
        }
        if (parsed) {
          state.chainDefinition = parsed;
          refreshChainCards();
        } else {
          // if invalid, still clear cards to reflect invalid state
          refreshChainCards();
        }
        utils.saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
      });
    }
    // Stop auto-syncing dynamic elements on input; apply explicitly via button
    const applyDynBtn = document.getElementById('apply-dyn-elements-btn');
    if (applyDynBtn) {
      applyDynBtn.addEventListener('click', async () => {
        try {
          const src = document.getElementById('dynamic-elements-input');
          const raw = (src?.value || '').trim();
          if (!raw) {
            state.dynamicElements = [];
            utils.log('Dynamic elements cleared');
            try {
              if (!state.chainDefinition) {
                const txt = document.getElementById('chain-json-input')?.value || '{}';
                state.chainDefinition = JSON.parse(txt);
              }
              state.chainDefinition.dynamicElements = [];
              const chainInput = document.getElementById('chain-json-input');
              if (chainInput) chainInput.value = JSON.stringify(state.chainDefinition, null, 2);
            } catch {}
            refreshBatchProgress(0, 0);
            return;
          }
          let items;
          if (raw.startsWith('[') || raw.startsWith('{')) items = JSON.parse(raw);
          else items = await processors.parseDynamicElements(raw);
          if (!Array.isArray(items)) items = [items];
          state.dynamicElements = items;
          utils.log(`Applied ${items.length} dynamic element(s) to runtime`);
          try {
            if (!state.chainDefinition) {
              const txt = document.getElementById('chain-json-input')?.value || '{}';
              state.chainDefinition = JSON.parse(txt);
            }
            state.chainDefinition.dynamicElements = items;
            const chainInput = document.getElementById('chain-json-input');
            if (chainInput) chainInput.value = JSON.stringify(state.chainDefinition, null, 2);
          } catch {}
          if (!state.isProcessing) refreshBatchProgress(0, items.length);
        } catch (e) {
          utils.log('Invalid dynamic elements: ' + e.message, 'error');
        }
      });
    }
    // Live-sync dynamic elements while running: when user edits the textarea during a run,
    // parse and update state.dynamicElements and the chain JSON so the running batch reflects changes.
    const dynInputEl = document.getElementById('dynamic-elements-input');
    if (dynInputEl) {
      dynInputEl.addEventListener('input', async (e) => {
        // If not processing, do nothing — user must press Apply to change runtime by default.
        if (!state.isProcessing) return;
        try {
          const raw = (e.target.value || '').trim();
          let items = [];
          if (raw) {
            if (raw.startsWith('[') || raw.startsWith('{')) {
              try {
                const parsed = JSON.parse(raw);
                items = Array.isArray(parsed) ? parsed : [parsed];
              } catch {
                try {
                  const parsed = await processors.parseDynamicElements(raw);
                  items = Array.isArray(parsed) ? parsed : [parsed];
                } catch {}
              }
            } else {
              try {
                const parsed = await processors.parseDynamicElements(raw);
                items = Array.isArray(parsed) ? parsed : [parsed];
              } catch {}
            }
          }
          // Replace live items but preserve already-processed count by removing leading items
          // that were already processed when appropriate. Simpler approach: replace full list.
          state.dynamicElements = items;
          // Update chain JSON representation for visibility
          try {
            if (!state.chainDefinition)
              state.chainDefinition = JSON.parse(
                document.getElementById('chain-json-input').value || '{}'
              );
            state.chainDefinition.dynamicElements = items;
            const chainInput = document.getElementById('chain-json-input');
            if (chainInput) chainInput.value = JSON.stringify(state.chainDefinition, null, 2);
          } catch {}
          utils.log(`Runtime dynamic elements updated (${items.length} items) while running`);
          // Refresh header progress: denominator = processed so far + remaining items
          const done = Math.max(0, Number(state.processedCount || 0));
          refreshBatchProgress(Math.min(done, done + items.length), done + items.length);
        } catch (err) {
          utils.log('Failed to live-apply dynamic elements: ' + err.message, 'error');
        }
      });
    }
    refreshChainCards();

    // Presets: populate selects and wire buttons (normalized storage)
    const loadPresetSelects = () => {
      // Steps presets
      let stepsMapRaw = GM_getValue(STORAGE_KEYS.presetsSteps, {});
      let stepsMap = {};
      try {
        stepsMap = typeof stepsMapRaw === 'string' ? JSON.parse(stepsMapRaw) : stepsMapRaw || {};
      } catch {
        stepsMap = {};
      }

      const defaultSteps = {
        'Get Weather': {
          type: 'http',
          url: 'https://wttr.in/{item}?format=j1',
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        },
        'Extract Data': {
          type: 'js',
          code: 'const raw = steps.weather?.rawText ?? steps.weather?.data;\nconst data = typeof raw === "string" ? JSON.parse(raw) : raw;\nconst tempC = Number(data?.current_condition?.[0]?.temp_C);\nutils.log("Temperature °C:", tempC);\nreturn isNaN(tempC) ? null : tempC;',
        },
        'Ask ChatGPT': {
          type: 'prompt',
          template: 'Explain the implications of the temperature {steps.extractData.response} K.',
        },
        'Basic Prompt': {
          type: 'prompt',
          template: 'Please analyze {item} and provide 3 key insights.',
        },
        'API Call': {
          type: 'http',
          url: 'https://jsonplaceholder.typicode.com/posts/{item}',
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        },
        'Reddit .json': {
          type: 'http',
          url: 'https://www.reddit.com/.json',
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        },
        'Process JSON': {
          type: 'js',
          code: 'const raw = steps.apiCall?.rawText ?? steps.apiCall?.data;\nconst data = typeof raw === "string" ? JSON.parse(raw) : raw;\nutils.log("Post title:", data?.title);\nreturn data?.title;',
        },
      };

      Object.entries(defaultSteps).forEach(([name, preset]) => {
        if (!Object.prototype.hasOwnProperty.call(stepsMap, name)) stepsMap[name] = preset;
      });
      try {
        GM_setValue(STORAGE_KEYS.presetsSteps, stepsMap);
      } catch {}

      // Chains presets
      let chainsMapRaw = GM_getValue(STORAGE_KEYS.presetsChains, {});
      let chainsMap = {};
      try {
        chainsMap =
          typeof chainsMapRaw === 'string' ? JSON.parse(chainsMapRaw) : chainsMapRaw || {};
      } catch {
        chainsMap = {};
      }

      const defaultChains = {
        'Weather Analysis': JSON.stringify(
          {
            dynamicElements: ['London', 'Tokyo', 'New York'],
            entryId: 'weather',
            steps: [
              {
                id: 'weather',
                type: 'http',
                url: 'https://wttr.in/{item}?format=j1',
                method: 'GET',
                next: 'extract',
              },
              {
                id: 'extract',
                type: 'js',
                code: 'const raw = steps.weather?.rawText ?? steps.weather?.data;\nconst data = typeof raw === "string" ? JSON.parse(raw) : raw;\nconst tempC = Number(data?.current_condition?.[0]?.temp_C);\nutils.log(`Weather for {item}: ${isNaN(tempC)?"n/a":tempC+"°C"}`);\nreturn isNaN(tempC) ? "Unknown" : tempC + "°C";',
                next: 'chat',
              },
              {
                id: 'chat',
                type: 'prompt',
                template:
                  'In {item}, the current temperature is {steps.extract.response}. Share a fun fact about this city.',
              },
            ],
          },
          null,
          2
        ),
        'Content Research': JSON.stringify(
          {
            dynamicElements: ['JavaScript', 'TypeScript', 'WebAssembly'],
            entryId: 'search',
            steps: [
              {
                id: 'search',
                type: 'prompt',
                template: 'Research {item} and provide 3 key facts',
                next: 'summarize',
              },
              {
                id: 'summarize',
                type: 'js',
                code: 'const text = steps.search.response || "";\nreturn text.slice(0,200) + (text.length>200?"...":"");',
                next: 'expand',
              },
              {
                id: 'expand',
                type: 'prompt',
                template:
                  'Using this summary: {steps.summarize.response}, write a short article about {item}',
              },
            ],
          },
          null,
          2
        ),
        'Simple Chain': JSON.stringify(
          {
            dynamicElements: ['London', 'Tokyo', 'New York'],
            entryId: 'step1',
            steps: [
              { id: 'step1', type: 'prompt', template: 'Tell me about {item}', next: 'step2' },
              { id: 'step2', type: 'template', template: 'Summary: {steps.step1.response}' },
            ],
          },
          null,
          2
        ),
        'Reddit JSON': JSON.stringify(
          {
            dynamicElements: ['javascript'],
            entryId: 'redditGet',
            steps: [
              {
                id: 'redditGet',
                type: 'http',
                url: 'https://www.reddit.com/.json',
                method: 'GET',
                next: 'logJson',
              },
              {
                id: 'logJson',
                type: 'js',
                code:
                  'const raw = steps.redditGet?.rawText ?? steps.redditGet?.data;\n' +
                  'const data = typeof raw === "string" ? (function(){ try { return JSON.parse(raw); } catch(e){ return raw; } })() : raw;\n' +
                  'const children = Array.isArray(data?.data?.children) ? data.data.children : [];\n' +
                  'const posts = children.slice(0,10).map(c => { const d = c.data || {}; return { title: d.title, author: d.author, subreddit: d.subreddit, score: d.score, num_comments: d.num_comments, id: d.id, url: d.url }; });\n' +
                  'const summary = { kind: data?.kind || "Listing", topPosts: posts };\n' +
                  'log(`Prepared reddit summary with ${posts.length} posts`);\n' +
                  'return JSON.stringify(summary);',
                next: 'summarize',
              },
              {
                id: 'summarize',
                type: 'prompt',
                template:
                  'I have a compact reddit summary: {steps.logJson.response}\n\nBased on this summary, what interesting insights or patterns do you observe about trending topics, engagement (score vs comments), or subreddit activity?',
              },
            ],
          },
          null,
          2
        ),
        'Kanji Mnemonics': JSON.stringify(
          {
            dynamicElements: [
              { index: 1, kanji: '一', keyword: 'One', kanji_id: '40' },
              { index: 2, kanji: '二', keyword: 'Two', kanji_id: '41' },
              { index: 3, kanji: '三', keyword: 'Three', kanji_id: '42' },
              { index: 4, kanji: '口', keyword: 'Mouth, Entrance', kanji_id: '83' },
              {
                index: 6,
                kanji: '四',
                keyword: 'Four',
                components: ['legs', 'Mouth, Entrance'],
                kanji_id: '43',
              },
            ],
            entryId: 'mnemonic',
            steps: [
              {
                id: 'mnemonic',
                type: 'prompt',
                template:
                  'Create a vivid mnemonic story for the kanji {item.kanji} meaning {item.keyword}. Components (if any): {item.components}. Respond in 1-2 lines.',
                newChat: true,
                next: 'imgPrompt',
              },
              {
                id: 'imgPrompt',
                type: 'prompt',
                template:
                  'Based on this mnemonic: {steps.mnemonic.response}\\nWrite a concise visual image prompt (no prefatory text).',
                newChat: true,
                next: 'genImage',
              },
              {
                id: 'genImage',
                type: 'prompt',
                template:
                  'Generate an image for this prompt: {steps.imgPrompt.response}. Return the image here in chat.',
                responseType: 'image',
                newChat: true,
                next: 'sendToServer',
              },
              {
                id: 'sendToServer',
                type: 'http',
                method: 'POST',
                url: 'https://postman-echo.com/post',
                headers: { 'Content-Type': 'application/json' },
                bodyTemplate:
                  '{"kanjiId": "{item.kanji_id}", "kanji": "{item.kanji}", "mnemonic": "{steps.mnemonic.response}", "imagePrompt": "{steps.imgPrompt.response}", "imageUrl": "{steps.genImage.images[0]}"}',
              },
            ],
          },
          null,
          2
        ),
      };

      Object.entries(defaultChains).forEach(([name, preset]) => {
        if (!Object.prototype.hasOwnProperty.call(chainsMap, name))
          chainsMap[name] = typeof preset === 'string' ? preset : JSON.stringify(preset, null, 2);
      });
      try {
        GM_setValue(STORAGE_KEYS.presetsChains, chainsMap);
      } catch {}

      const fill = (id, map) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">Select preset...</option>';
        Object.keys(map || {})
          .sort()
          .forEach((name) => {
            const o = document.createElement('option');
            o.value = name;
            o.textContent = name;
            sel.appendChild(o);
          });
      };
      fill('composer-preset-select', chainsMap);
      fill('step-preset-select', stepsMap);
    };

    const getComposerPresetName = () =>
      (document.getElementById('composer-preset-name-input')?.value || '').trim();

    const savePreset = (storeKey, name, value) => {
      if (!name) return utils.log('Enter a preset name', 'warning');
      try {
        const raw = GM_getValue(storeKey, {}) || {};
        const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
        map[name] = value;
        GM_setValue(storeKey, map);
        loadPresetSelects();
        utils.log(`Preset "${name}" saved`);
      } catch (e) {
        utils.log('Save failed: ' + e.message, 'error');
      }
    };

    const deletePreset = (storeKey, selId) => {
      try {
        const sel = document.getElementById(selId);
        if (!sel || !sel.value) return utils.log('Select a preset to delete', 'warning');
        const name = sel.value;
        // Confirm with the user before deleting the selected preset/chain
        if (!confirm(`Delete preset/chain "${name}"? This action cannot be undone.`)) {
          utils.log(`Delete cancelled for "${name}"`, 'info');
          return;
        }
        const raw = GM_getValue(storeKey, {}) || {};
        const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
        delete map[name];
        GM_setValue(storeKey, map);
        loadPresetSelects();
        utils.log(`Preset "${name}" deleted`);
      } catch (e) {
        utils.log('Delete failed: ' + e.message, 'error');
      }
    };

    const loadPreset = (storeKey, selId, apply) => {
      try {
        const sel = document.getElementById(selId);
        if (!sel || !sel.value) return utils.log('Select a preset to load', 'warning');
        const raw = GM_getValue(storeKey, {}) || {};
        const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const v = map[sel.value];
        if (v == null) return utils.log('Preset not found', 'warning');
        apply(v);
        utils.log(`Preset "${sel.value}" loaded`);
      } catch (e) {
        utils.log('Load failed: ' + e.message, 'error');
      }
    };

    loadPresetSelects();

    // Composer preset handlers
    document.getElementById('save-composer-preset-btn')?.addEventListener('click', () => {
      const name = getComposerPresetName();
      const chainValue = document.getElementById('chain-json-input')?.value || '';
      savePreset(STORAGE_KEYS.presetsChains, name, chainValue);
    });

    document.getElementById('load-composer-preset-btn')?.addEventListener('click', () => {
      const sel = document.getElementById('composer-preset-select');
      if (sel && (!sel.value || sel.value.trim() === '')) {
        const chainInput = document.getElementById('chain-json-input');
        if (chainInput) {
          chainInput.value = '';
          state.chainDefinition = null;
          utils.saveToStorage(STORAGE_KEYS.chainDef, '');
          refreshChainCards();
          utils.log('Cleared chain definition');
        }
        return;
      }
      loadPreset(STORAGE_KEYS.presetsChains, 'composer-preset-select', (v) => {
        const chainInput = document.getElementById('chain-json-input');
        if (chainInput) {
          const str = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
          chainInput.value = str;
          try {
            state.chainDefinition = JSON.parse(str);
          } catch {
            state.chainDefinition = null;
          }
          utils.saveToStorage(STORAGE_KEYS.chainDef, str);
          // Clear dynamic items when switching presets
          state.dynamicElements = [];
          const dynEl = document.getElementById('dynamic-elements-input');
          if (dynEl) dynEl.value = '';
          // Refresh chain cards to show the loaded chain
          refreshChainCards();
        }
      });
    });

    document.getElementById('delete-composer-preset-btn')?.addEventListener('click', () => {
      deletePreset(STORAGE_KEYS.presetsChains, 'composer-preset-select');
    });

    // Step modal preset handlers
    document.getElementById('save-step-preset-btn')?.addEventListener('click', () => {
      const modal = document.getElementById('chain-step-modal');
      if (!modal || modal.style.display === 'none') return;

      // Collect current step data
      const stepData = {
        type: document.getElementById('step-type-select')?.value || '',
        title: document.getElementById('step-title-input')?.value || '',
        template:
          document.getElementById('step-template-input')?.value ||
          document.getElementById('step-prompt-template')?.value ||
          '',
        elements: document.getElementById('step-template-elements')?.value || '',
        code: document.getElementById('step-js-code')?.value || '',
        url: document.getElementById('step-http-url')?.value || '',
        method: document.getElementById('step-http-method')?.value || 'GET',
        headers: document.getElementById('step-http-headers')?.value || '',
        bodyTemplate: document.getElementById('step-http-body')?.value || '',
      };

      const name = prompt('Enter preset name:');
      if (name) {
        try {
          const raw = GM_getValue(STORAGE_KEYS.presetsSteps, {}) || {};
          const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
          map[name] = stepData;
          GM_setValue(STORAGE_KEYS.presetsSteps, map);
        } catch (e) {
          utils.log('Failed saving step preset: ' + e.message, 'error');
        }
        loadPresetSelects();
      }
    });

    document.getElementById('step-preset-select')?.addEventListener('change', (e) => {
      if (!e.target.value) return;
      try {
        const raw = GM_getValue(STORAGE_KEYS.presetsSteps, {}) || {};
        const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
        let stepData = map[e.target.value];
        if (typeof stepData === 'string') {
          try {
            stepData = JSON.parse(stepData);
          } catch {}
        }
        if (!stepData) return;
        if (stepData.type) {
          const typeSel = document.getElementById('step-type-select');
          typeSel.value = stepData.type;
          typeSel.dispatchEvent(new Event('change'));
        }
        if (stepData.title) document.getElementById('step-title-input').value = stepData.title;
        if (stepData.template) {
          // Apply to both prompt/template fields as applicable
          const promptEl = document.getElementById('step-prompt-template');
          const tmplEl = document.getElementById('step-template-input');
          if (promptEl) promptEl.value = stepData.template;
          if (tmplEl) tmplEl.value = stepData.template;
        }
        if (stepData.elements)
          document.getElementById('step-template-elements').value = stepData.elements;
        if (stepData.responseType) {
          const r = document.getElementById('step-response-type');
          if (r) r.value = stepData.responseType;
        }
        if (typeof stepData.newChat === 'boolean') {
          const nc = document.getElementById('step-newchat-checkbox');
          if (nc) nc.checked = !!stepData.newChat;
        }
        if (stepData.code) document.getElementById('step-js-code').value = stepData.code;
        if (stepData.url) document.getElementById('step-http-url').value = stepData.url;
        if (stepData.method) document.getElementById('step-http-method').value = stepData.method;
        if (stepData.headers)
          document.getElementById('step-http-headers').value =
            typeof stepData.headers === 'string'
              ? stepData.headers
              : JSON.stringify(stepData.headers);
        if (stepData.bodyTemplate)
          document.getElementById('step-http-body').value = stepData.bodyTemplate;
      } catch (err) {
        utils.log('Failed to load step preset: ' + err.message, 'error');
      }
    });

    // Add delete step preset button handler
    document.getElementById('delete-step-preset-btn')?.addEventListener('click', () => {
      const select = document.getElementById('step-preset-select');
      if (!select || !select.value) {
        utils.log('Select a preset to delete', 'warning');
        return;
      }

      if (confirm(`Delete preset "${select.value}"?`)) {
        try {
          const raw = GM_getValue(STORAGE_KEYS.presetsSteps, {}) || {};
          const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
          delete map[select.value];
          GM_setValue(STORAGE_KEYS.presetsSteps, map);
          loadPresetSelects();
          utils.log(`Preset "${select.value}" deleted`);
        } catch (e) {
          utils.log('Delete failed: ' + e.message, 'error');
        }
      }
    });
  };

  // Run-lock utilities to avoid cross-tab collisions
  const acquireRunLock = () => {
    try {
      const key = STORAGE_KEYS.runLockKey;
      const now = Date.now();
      const existing = localStorage.getItem(key);
      const selfId =
        state.runLockId || (state.runLockId = `${now}-${Math.random().toString(36).slice(2)}`);
      if (existing) {
        try {
          const obj = JSON.parse(existing);
          if (obj && obj.id && obj.ts && now - obj.ts < CONFIG.RUN_LOCK_TTL_MS) {
            return false; // another tab active
          }
        } catch {
          /* treat as stale */
        }
      }
      localStorage.setItem(key, JSON.stringify({ id: selfId, ts: now }));
      // heartbeat
      clearInterval(state.runLockTimer);
      state.runLockTimer = setInterval(() => {
        try {
          localStorage.setItem(key, JSON.stringify({ id: selfId, ts: Date.now() }));
        } catch (e) {
          /* ignore */
        }
      }, CONFIG.RUN_LOCK_RENEW_MS);
      window.addEventListener('beforeunload', releaseRunLock);
      return true;
    } catch {
      return true;
    }
  };
  const releaseRunLock = () => {
    try {
      clearInterval(state.runLockTimer);
      state.runLockTimer = null;
      const key = STORAGE_KEYS.runLockKey;
      const existing = localStorage.getItem(key);
      if (existing) {
        const obj = JSON.parse(existing);
        if (!obj || obj.id === state.runLockId) localStorage.removeItem(key);
      }
    } catch (e) {
      /* ignore */
    }
  };

  const runChainWithBatch = async () => {
    if (!state.chainDefinition) {
      try {
        state.chainDefinition = JSON.parse(
          document.getElementById('chain-json-input').value || '{}'
        );
      } catch {
        state.chainDefinition = null;
      }
    }
    if (!state.chainDefinition) {
      utils.log('No chain defined', 'warning');
      return;
    }

    if (!acquireRunLock()) {
      utils.log('Another tab is running automation - aborting to prevent collision', 'error');
      return;
    }

    state.isProcessing = true;
    updateStatus('processing');
    try {
      // Prefer runtime batch; if none, allow chain to provide sample items
      let items = Array.isArray(state.dynamicElements) ? state.dynamicElements : [];
      if (
        (!items || items.length === 0) &&
        (Array.isArray(state.chainDefinition?.dynamicElements) ||
          typeof state.chainDefinition?.dynamicElements === 'string')
      ) {
        items = state.chainDefinition.dynamicElements;
        // If dynamicElements is a string (JSON/function), attempt to parse/execute
        if (typeof items === 'string') {
          try {
            const parsed = await processors.parseDynamicElements(items);
            if (Array.isArray(parsed)) items = parsed;
          } catch {}
        }
      }
      // Fallback: if still empty but chain references {item}, seed with sample cities
      if (!items || items.length === 0) {
        const usesItem = Array.isArray(state.chainDefinition?.steps)
          ? state.chainDefinition.steps.some((s) =>
              ['url', 'template', 'bodyTemplate'].some(
                (k) => typeof s?.[k] === 'string' && s[k].includes('{item')
              )
            )
          : false;
        if (usesItem) {
          utils.log('No dynamic elements provided; using sample items for this chain.', 'warning');
          items = ['London', 'Tokyo', 'New York'];
        }
      }
      // Use live state.dynamicElements so runtime edits affect the remaining items.
      const stopBtn = document.getElementById('stop-batch-btn');
      if (stopBtn) stopBtn.style.display = 'inline-flex';
      const stopRunBtn = document.getElementById('stop-run-btn');
      if (stopRunBtn) stopRunBtn.style.display = 'inline-flex';
      const stopMini = document.getElementById('stop-mini-btn');
      if (stopMini) stopMini.style.display = 'inline-flex';
      state.cancelRequested = false;
      state.currentBatchIndex = 0;
      state.processedCount = 0;
      updateSubProgress(0, 0);

      // If there are no dynamic elements, allow a single run with null item
      const liveItems = Array.isArray(state.dynamicElements) ? state.dynamicElements : [];
      if (!liveItems || liveItems.length === 0) {
        // Single run with empty item
        refreshBatchProgress(0, 0);
        await processChain(state.chainDefinition, { item: null, index: 1, total: 1 });
      } else {
        let processed = 0;
        // Loop until we've processed all available items or cancel is requested
        while (true) {
          if (state.cancelRequested) {
            utils.log('Run canceled');
            break;
          }

          const itemsNow = Array.isArray(state.dynamicElements) ? state.dynamicElements : [];
          const totalNow = Math.max(0, itemsNow.length);

          // If no items remain, we're done
          if (totalNow === 0) {
            break;
          }

          // Update progress using processed count and dynamic total (processed + remaining)
          // Ensure currentBatchIndex reflects what we've processed so far for live updates
          state.currentBatchIndex = processed;
          state.processedCount = processed;
          refreshBatchProgress(processed, processed + totalNow);

          // Determine the next item to process
          let itemToProcess;
          if (state.autoRemoveProcessed) {
            // Always take the first item
            itemToProcess = itemsNow[0];
            if (typeof state.dynamicElements.shift === 'function') {
              // We'll remove after processing to avoid racing with input handlers
            }
          } else {
            // Use processed as index; if out of range, break (may happen if list shrank)
            if (processed >= itemsNow.length) break;
            itemToProcess = itemsNow[processed];
          }

          utils.log(`🔗 Chain run for item ${processed + 1}/${processed + totalNow}`);
          await processChain(state.chainDefinition, {
            item: itemToProcess,
            index: processed + 1,
            total: totalNow,
          });

          if (state.cancelRequested) {
            utils.log('Run canceled');
            break;
          }

          // After processing, update the runtime list according to auto-remove
          if (state.autoRemoveProcessed) {
            removeHeadItems(1);
            processed += 1;
            state.currentBatchIndex = processed;
            state.processedCount = processed;
          } else {
            processed += 1;
            state.processedCount = processed;
          }

          // Sync chain JSON so edits are reflected
          try {
            if (!state.chainDefinition)
              state.chainDefinition = JSON.parse(
                document.getElementById('chain-json-input').value || '{}'
              );
            state.chainDefinition.dynamicElements = state.dynamicElements;
            const chainInput = document.getElementById('chain-json-input');
            if (chainInput) chainInput.value = JSON.stringify(state.chainDefinition, null, 2);
          } catch {}

          // Update progress after completion of this item; denominator = processed + remaining
          const remainingNow = Array.isArray(state.dynamicElements)
            ? state.dynamicElements.length
            : 0;
          refreshBatchProgress(processed, processed + remainingNow);

          // Wait between items when there are still items left
          const remaining = Array.isArray(state.dynamicElements) ? state.dynamicElements.length : 0;
          if (remaining > 0) {
            utils.log(`⏱️ Waiting ${state.batchWaitTime}ms before next item…`);
            await utils.sleep(state.batchWaitTime);
            continue;
          }
          break;
        }
      }
      utils.log('🏁 Chain batch completed');
    } catch (e) {
      utils.log('Chain error: ' + e.message, 'error');
    } finally {
      releaseRunLock();
      state.isProcessing = false;
      updateStatus('idle');
      refreshBatchProgress(0, 0);
      updateSubProgress(0, 0);
      const stopBtn = document.getElementById('stop-batch-btn');
      if (stopBtn) stopBtn.style.display = 'none';
      const stopRunBtn = document.getElementById('stop-run-btn');
      if (stopRunBtn) stopRunBtn.style.display = 'none';
      const stopMini = document.getElementById('stop-mini-btn');
      if (stopMini) stopMini.style.display = 'none';
    }
  };

  const resolveEntryStep = (chain) => {
    if (!chain) return null;
    if (chain.entryId) return (chain.steps || []).find((s) => s.id === chain.entryId) || null;
    const steps = chain.steps || [];
    if (!steps.length) return null;
    const referenced = new Set(steps.map((s) => s.next).filter(Boolean));
    const first = steps.find((s) => !referenced.has(s.id));
    return first || steps[0];
  };

  // Helper: create a per-step context that exposes previous steps and chain data
  const createStepContext = (context) => ({
    ...context,
    item: context.item,
    index: context.index,
    total: context.total,
    steps: context.steps,
    chain: context.chain,
  });

  const handlePromptStep = async (step, stepContext, context) => {
    const msg = processors.processDynamicTemplate(step.template || '', stepContext);
    // Per-step new chat option
    if (step.newChat) {
      await startNewChat();
    }

    const expect = step.responseType === 'image' ? 'image' : 'text';
    if (expect === 'image') {
      const { el: respEl, images } = await chatGPT.askWith(msg, { expect: 'image' });
      const imgs = images || [];
      context.lastResponseText = imgs[0] || '';
      context.chain[step.id] = { images: imgs };
      context.steps[step.id] = { type: 'prompt', responseType: 'image', images: imgs };
      utils.log(`🖼️ Step ${step.id} returned ${imgs.length} image(s)`);
      utils.log(`💡 Access first image: {steps.${step.id}.images[0]}`);
    } else {
      const { el: respEl, text: resp } = await chatGPT.ask(msg);
      context.lastResponseText = resp;
      context.chain[step.id] = { response: resp };
      context.steps[step.id] = { type: 'prompt', response: resp, responseText: resp };
      utils.log(`📩 Step ${step.id} response (${resp.length} chars)`);
      utils.log(
        `💡 Access this data in next steps with: {steps.${step.id}.response} or {steps.${step.id}.responseText}`
      );
    }
  };

  const handleHttpStep = async (step, stepContext, context) => {
    const url = processors.processDynamicTemplate(step.url || '', stepContext);
    const method = (step.method || 'GET').toUpperCase();
    let headers = step.headers || {};
    try {
      if (typeof headers === 'string') headers = JSON.parse(headers);
    } catch {}
    const body = step.bodyTemplate
      ? processors.processDynamicTemplate(step.bodyTemplate, stepContext)
      : undefined;

    // Basic retry for transient failures
    let res;
    let attempt = 0;
    let lastErr = null;
    while (attempt < 3) {
      try {
        res = await http.request({ method, url, headers, data: body });
        break;
      } catch (e) {
        lastErr = e;
        attempt++;
        if (attempt < 3) {
          utils.log(`HTTP attempt ${attempt} failed (${e?.message || e}). Retrying...`, 'warning');
          await utils.sleep(500 * attempt);
        }
      }
    }
    if (!res) throw lastErr || new Error('Network error');
    const payload = res.responseText || res.response || '';
    let parsedData = payload;
    try {
      parsedData = JSON.parse(payload);
    } catch {}

    const httpData = {
      status: res.status,
      statusText: res.statusText || '',
      data: parsedData,
      rawText: payload,
      headers: res.responseHeaders || {},
      url,
      method,
    };

    context.chain[step.id] = { http: httpData };
    context.steps[step.id] = { type: 'http', ...httpData };
    utils.log(`🌐 HTTP ${method} ${url} → ${res.status}`);
    utils.log(
      `💡 Access this data with: {steps.${step.id}.data} or {steps.${step.id}.rawText} or {steps.${step.id}.status}`
    );
  };

  const handleJsStep = async (step, stepContext, context) => {
    const jsContext = {
      elementData: context.item,
      index: context.index,
      total: context.total,
      steps: context.steps,
      lastResponse: context.lastResponseText,
    };
    const ret = await processors.executeCustomCode(
      step.code || '',
      context.lastResponseText || '',
      jsContext
    );
    context.steps[step.id] = { type: 'js', executed: true, response: ret };
  };

  const handleTemplateStep = async (step, stepContext, context) => {
    let arr = [];
    try {
      // Allow templating inside elements definition
      const elemsSrc = processors.processDynamicTemplate(step.elements || '[]', stepContext);
      arr = await processors.parseDynamicElements(elemsSrc || '[]');
    } catch {
      arr = [];
    }

    // Optionally use chain-level dynamicElements for nested batching
    if (
      (!arr || arr.length === 0) &&
      step.useDynamicElements &&
      (Array.isArray(context.chain?.dynamicElements) ||
        typeof context.chain?.dynamicElements === 'string')
    ) {
      arr = context.chain.dynamicElements;
    }

    if (!Array.isArray(arr) || arr.length === 0) {
      utils.log('Template step has no elements; sending one prompt with current context');
      const msg = processors.processDynamicTemplate(step.template || '', stepContext);
      const { text: resp } = await chatGPT.ask(msg);
      context.lastResponseText = resp;
      context.chain[step.id] = { response: resp };
      context.steps[step.id] = {
        type: 'template',
        response: resp,
        responseText: resp,
        itemCount: 0,
      };
      utils.log(
        `💡 Access template data with: {steps.${step.id}.responses} or {steps.${step.id}.lastResponse}`
      );
      return;
    }

    utils.log(`🧩 Template step expanding ${arr.length} items`);
    updateSubProgress(0, arr.length);
    const responses = [];
    for (let i = 0; i < arr.length; i++) {
      updateSubProgress(i + 1, arr.length);
      if (state.cancelRequested) {
        utils.log('Run canceled');
        break;
      }
      const child = arr[i];
      const itemContext = { ...stepContext, item: child, index: i + 1, total: arr.length };
      const msg = processors.processDynamicTemplate(step.template || '', itemContext);
      utils.log(`📝 Template item ${i + 1}/${arr.length}: ${utils.clip(msg, 200)}`);
      if (step.newChat) {
        await startNewChat();
      }
      const expect = step.responseType === 'image' ? 'image' : 'text';
      if (expect === 'image') {
        const { images } = await chatGPT.askWith(msg, { expect: 'image' });
        responses.push({ item: child, images: images || [] });
        context.lastResponseText = (images && images[0]) || '';
      } else {
        const { text: resp } = await chatGPT.ask(msg);
        responses.push({ item: child, response: resp });
        context.lastResponseText = resp;
      }
      if (state.cancelRequested) {
        utils.log('Run canceled');
        break;
      }
      if (i < arr.length - 1) {
        utils.log(`⏱️ Waiting ${state.batchWaitTime}ms before next template item…`);
        await utils.sleep(state.batchWaitTime);
      }
    }

    context.chain[step.id] = { responses };
    context.steps[step.id] = {
      type: 'template',
      responses,
      itemCount: responses.length,
      lastResponse: responses[responses.length - 1]?.response || '',
    };
    updateSubProgress(0, 0);
    utils.log(
      `💡 Access template data with: {steps.${step.id}.responses} or {steps.${step.id}.lastResponse}`
    );
  };

  const processChain = async (chain, baseContext) => {
    const entry = resolveEntryStep(chain);
    if (!entry) throw new Error('Empty chain');
    let step = entry;
    let context = {
      ...baseContext,
      lastResponseText: '',
      chain: { dynamicElements: chain.dynamicElements || [] },
      steps: {},
    };
    const perStepWait = parseInt(document.getElementById('step-wait-input')?.value || '0') || 0;

    while (step) {
      utils.log(`➡️ Step ${step.id} (${step.type})`);
      const stepContext = createStepContext(context);

      try {
        if (step.type === 'prompt') await handlePromptStep(step, stepContext, context);
        else if (step.type === 'http') await handleHttpStep(step, stepContext, context);
        else if (step.type === 'js') await handleJsStep(step, stepContext, context);
        else if (step.type === 'template') await handleTemplateStep(step, stepContext, context);
        else utils.log(`Unknown step type: ${step.type}`, 'warning');
      } catch (err) {
        const msg = err?.message || String(err || 'Unknown error');
        utils.log(`Step ${step.id} error: ${msg}`, 'error');
        throw new Error(msg);
      }

      step = step.next ? (chain.steps || []).find((s) => s.id === step.next) : null;
      if (step && perStepWait > 0) {
        utils.log(`⏱️ Waiting ${perStepWait}ms before next step…`);
        await utils.sleep(perStepWait);
      }
    }
  };

  // Initialize the script
  const init = () => {
    if (document.getElementById('chatgpt-automation-ui')) {
      return; // Already initialized
    }

    utils.log('Initializing ChatGPT Automation Pro...');

    // Wait for page to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createUI);
    } else {
      createUI();
    }
  };

  // Auto-start
  init();
})();
