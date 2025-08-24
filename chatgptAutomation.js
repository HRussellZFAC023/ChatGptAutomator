// ==UserScript==
// @name         ChatGPT Automation Pro
// @namespace    http://tampermonkey.net/
// @version      2.0
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
// @updateURL    https://raw.githubusercontent.com/HRussellZFAC023/ChatGptAutomator/main/chatgptAutomation.js
// @downloadURL  https://raw.githubusercontent.com/HRussellZFAC023/ChatGptAutomator/main/chatgptAutomation.js
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // Configuration
    const CONFIG = {
        DEBUG_MODE: false,
        RESPONSE_TIMEOUT: 3000000, // 5 minutes
        MIN_WIDTH: 300,
        MIN_HEIGHT: 200,
        MAX_WIDTH: 1000,
        MAX_HEIGHT: 1200,
        DEFAULT_VISIBLE: false,
        RUN_LOCK_TTL_MS: 15000,
        RUN_LOCK_RENEW_MS: 5000,
        // Batch processing settings
        BATCH_WAIT_TIME: 2000, // Default wait time between batch items
        AUTO_REMOVE_PROCESSED: true, // Whether to remove processed items from textbox
        AUTO_SCROLL_LOGS: true, // Whether to auto-scroll logs
        NEW_CHAT_PER_ITEM: false // Whether to start new chat for each item
    };

    // State management
    let isLooping = false;
    let dynamicElements = [];
    let lastResponseElement = null;
    let responseObserver = null;
    let isMinimized = false;
    let isDarkMode = false;
    let uiVisible = CONFIG.DEFAULT_VISIBLE;
    let headerObserverStarted = false;
    // Batch / UI runtime flags (previously moved into CONFIG constants)
    let autoScrollLogs = CONFIG.AUTO_SCROLL_LOGS;
    let batchWaitTime = CONFIG.BATCH_WAIT_TIME;
    let autoRemoveProcessed = CONFIG.AUTO_REMOVE_PROCESSED;
    let newChatPerItem = CONFIG.NEW_CHAT_PER_ITEM;
    let isProcessing = false;
    let currentBatchIndex = 0;
    // Chain state
    let chainDefinition = null;
    let runLockId = null;
    let runLockTimer = null;

    // Storage keys
    const STORAGE_KEYS = {
        messageInput: 'messageInput',
        templateInput: 'templateInput',
        dynamicElementsInput: 'dynamicElementsInput',
        customCodeInput: 'customCodeInput',
        loop: 'looping',
        autoRemove: 'autoRemoveProcessed',
        newChat: 'newChatPerItem',
        autoScroll: 'autoScrollLogs',
        waitTime: 'batchWaitTime',
        activeTab: 'activeTab',
        uiState: 'uiState',
        chainDef: 'chain.definition',
        // presets
        presetsTemplates: 'presets.templates', // object map name->template string
        presetsChains: 'presets.chains',       // object map name->chain json
        presetsResponseJS: 'presets.responseJS', // object map name->js string
        presetsSteps: 'presets.steps',           // object map name->saved step JSON
        logHistory: 'log.history',
        runLockKey: 'chatgptAutomation.runLock',
        // Config keys
        configDebug: 'config.debugMode',
        configTimeout: 'config.responseTimeout',
        configMinWidth: 'config.minWidth',
        configMinHeight: 'config.minHeight',
        configMaxWidth: 'config.maxWidth',
        configMaxHeight: 'config.maxHeight',
        configDefaultVisible: 'config.defaultVisible'
    };

    // UI Elements
    let mainContainer = null;
    let statusIndicator = null;
    let logContainer = null;
    let progressBar = null;
    let resizeHandle = null;

    // Utility functions
    const log = (message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        const logMessage = `[${timestamp}] ${message}`;

        if (CONFIG.DEBUG_MODE) {
            console.log(logMessage);
        }

        if (logContainer) {
            const logEntry = document.createElement('div');
            logEntry.className = `log-entry log-${type}`;
            logEntry.textContent = logMessage;
            logContainer.appendChild(logEntry);

            // Maintain a small spacer at the end for visibility
            let spacer = logContainer.querySelector('.log-spacer');
            if (!spacer) {
                spacer = document.createElement('div');
                spacer.className = 'log-spacer';
                spacer.style.height = '10px';
                spacer.style.flex = '0 0 auto';
                logContainer.appendChild(spacer);
            } else {
                logContainer.appendChild(spacer); // move to bottom
            }

            // Auto-scroll logs if enabled
            if (autoScrollLogs) {
                logContainer.scrollTop = logContainer.scrollHeight;
            }

            // Keep only last 200 log entries
            const maxEntries = 200;
            const entries = Array.from(logContainer.querySelectorAll('.log-entry'));
            while (entries.length > maxEntries) {
                const first = entries.shift();
                if (first && first.parentNode) first.parentNode.removeChild(first);
            }
        }

        // Persist a rolling history so logs survive reloads
        try {
            const maxPersist = 300;
            let history = GM_getValue(STORAGE_KEYS.logHistory, []);
            if (!Array.isArray(history)) history = [];
            history.push({ t: Date.now(), type, msg: logMessage });
            if (history.length > maxPersist) history = history.slice(history.length - maxPersist);
            GM_setValue(STORAGE_KEYS.logHistory, history);
        } catch { /* ignore */ }
    };

    // Small helper to clip long strings for logging
    const clip = (s, n = 300) => {
        try {
            const str = String(s ?? '');
            return str.length > n ? str.slice(0, n) + '…' : str;
        } catch { return ''; }
    };

    // Detect dark mode
    const detectDarkMode = () => {
        const htmlElement = document.documentElement;
        const bodyElement = document.body;

        // Check various indicators for dark mode
        const darkIndicators = [
            htmlElement.classList.contains('dark'),
            bodyElement.classList.contains('dark'),
            htmlElement.getAttribute('data-theme') === 'dark',
            bodyElement.getAttribute('data-theme') === 'dark',
            getComputedStyle(bodyElement).backgroundColor.includes('rgb(0, 0, 0)') ||
            getComputedStyle(bodyElement).backgroundColor.includes('rgb(17, 24, 39)') ||
            getComputedStyle(bodyElement).backgroundColor.includes('rgb(31, 41, 55)')
        ];

        return darkIndicators.some(indicator => indicator);
    };

    // Cross-origin HTTP helper using GM_xmlhttpRequest
    const http = {
        request: (opts) => new Promise((resolve, reject) => {
            try {
                const {
                    method = 'GET', url, headers = {}, data,
                    responseType = 'text', timeout = 30000
                } = opts || {};
                if (!url) throw new Error('Missing url');
                GM_xmlhttpRequest({
                    method, url, headers, data, responseType, timeout, anonymous: false,
                    onload: (res) => resolve(res),
                    onerror: (err) => reject(err),
                    ontimeout: () => reject(new Error('Request timeout'))
                });
            } catch (e) { reject(e); }
        }),
        postForm: (url, formObj, extraHeaders = {}) => {
            const body = Object.entries(formObj || {})
                .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
                .join('&');
            return http.request({
                method: 'POST', url,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', ...extraHeaders },
                data: body
            });
        },
        postMultipart: (url, formObj, extraHeaders = {}) => {
            return http.postForm(url, formObj, extraHeaders);
        }
    };

    const executeCustomCode = async (code, responseText, templateData = null) => {
        if (!code || code.trim() === '') return;
        try {
            // Resolve context from templateData first
            let item = templateData?.elementData ?? null;
            let index = templateData?.index ?? null;
            let total = templateData?.total ?? null;
            let steps = templateData?.steps ?? {};
            let lastResponse = templateData?.lastResponse ?? responseText;

            // Fallback removed: dynamicElementsInput is no longer part of the UI.

            // Debug logging to help troubleshoot
            if (CONFIG.DEBUG_MODE) {
                log(`Custom code context: item=${item ? JSON.stringify(item).slice(0, 100) : 'null'}, index=${index}, total=${total}, steps=${Object.keys(steps).join(',')}`);
            }

            // Create and execute the user function, properly awaiting any returned promise
            // Handle both regular code and async IIFE patterns
            let result;

            // Check if the code is wrapped in an async IIFE pattern
            const asyncIIFEPattern = /^\s*\(\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]*\}\s*\)\s*\(\s*\)\s*;?\s*$/;
            const isAsyncIIFE = asyncIIFEPattern.test(code.trim());

            if (isAsyncIIFE) {
                // For async IIFE, execute directly and the result will be a Promise
                log('Detected async IIFE pattern, executing with proper await...');
                const fn = new Function('response', 'log', 'console', 'item', 'index', 'total', 'http', 'steps', 'lastResponse', `return ${code}`);
                result = fn(
                    responseText,
                    (msg, type = 'info') => log(msg, type),
                    console,
                    item,
                    index,
                    total,
                    http,
                    steps,
                    lastResponse
                );
            } else {
                // For regular code, wrap in function as before
                const fn = new Function('response', 'log', 'console', 'item', 'index', 'total', 'http', 'steps', 'lastResponse', code);
                result = fn(
                    responseText,
                    (msg, type = 'info') => log(msg, type),
                    console,
                    item,
                    index,
                    total,
                    http,
                    steps,
                    lastResponse
                );
            }

            // Properly await the result whether it's a promise or not
            await Promise.resolve(result);
            log('Custom code executed successfully');
        } catch (error) {
            log(`Custom code execution error: ${error.message}`, 'error');
            // Re-throw the error so the calling code can handle retries
            throw error;
        }
    };

    // Note: executeCustomCode is the primary API used throughout this script.

    // Template processing
    const processDynamicTemplate = (template, dynamicData) => {
        if (!template) return '';
        const getByPath = (obj, path) => {
            try {
                return path.split('.').reduce((acc, part) => acc != null ? acc[part] : undefined, obj);
            } catch { return undefined; }
        };
        const regex = /\{\{\s*([\w$.]+)\s*\}\}|\{\s*([\w$.]+)\s*\}/g;
        return template.replace(regex, (_, g1, g2) => {
            const keyPath = g1 || g2;
            let value = getByPath(dynamicData, keyPath);
            if (value === undefined) return '';
            if (typeof value === 'object') {
                try { return JSON.stringify(value); } catch { return String(value); }
            }
            return String(value);
        });
    };

    // Parse dynamic elements (can be array or function)
    const parseDynamicElements = async (input) => {
        const raw = (input || '').trim();
        if (!raw) return [];
        // Strict array JSON
        if (raw.startsWith('[')) {
            try { return JSON.parse(raw); } catch (e) { log(`Invalid JSON: ${e.message}`, 'error'); return []; }
        }
        // Support single-object JSON
        if (raw.startsWith('{')) {
            try { const obj = JSON.parse(raw); return [obj]; } catch (e) { /* fall through to eval */ }
        }
        // Evaluate expression or function in userscript context
        try {
            const fn = new Function('return ( ' + raw + ' )');
            const v = fn();
            const res = (typeof v === 'function') ? v() : v;
            if (Array.isArray(res)) return res;
            if (res && typeof res === 'object') return [res];
            if (typeof res === 'string') {
                try {
                    const parsed = JSON.parse(res);
                    if (Array.isArray(parsed)) return parsed;
                    if (parsed && typeof parsed === 'object') return [parsed];
                } catch { /* ignore */ }
            }
            throw new Error('Result is not an array/object');
        } catch (error) {
            log(`Error parsing dynamic elements: ${error.message}`, 'error');
            return [];
        }
    };

    // Storage helper to reduce repetitive try-catch blocks
    const saveToStorage = (key, value) => {
        try { GM_setValue(key, value); } catch { }
    };

    // Save UI state (simplified with debouncing)
    let saveTimeout;
    const saveUIState = (immediate = false) => {
        if (!mainContainer) return;

        const doSave = () => {
            const state = {
                left: mainContainer.style.left,
                top: mainContainer.style.top,
                right: mainContainer.style.right,
                width: mainContainer.style.width,
                height: mainContainer.style.height,
                minimized: isMinimized,
                visible: uiVisible
            };
            GM_setValue(STORAGE_KEYS.uiState, JSON.stringify(state));
        };

        if (immediate) {
            clearTimeout(saveTimeout);
            doSave();
        } else {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(doSave, 100); // Debounce saves
        }
    };

    // Load UI state (simplified)
    const loadUIState = () => {
        try {
            const saved = GM_getValue(STORAGE_KEYS.uiState, null);
            return saved ? JSON.parse(saved) : {};
        } catch {
            return {};
        }
    };



    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Function to start a new chat
    const startNewChat = async () => {
        try {
            log('Starting new chat...');

            // Method 1: Try the "New chat" button (language independent, uses data-testid)
            const newChatButton = document.querySelector('a[data-testid="create-new-chat-button"]');
            if (newChatButton) {
                log('Using new chat button...');
                newChatButton.click();
                await sleep(1000);
                return true;
            }

            const homeLink = document.querySelector('a[href="/"]');
            if (homeLink && homeLink.textContent.trim() !== '') {
                log('Using home link...');
                homeLink.click();
                await sleep(1000);
                return true;
            }

            log('Using programmatic navigation...');
            const currentUrl = window.location.href;
            const baseUrl = window.location.origin;

            // Only navigate if we're not already on the home page
            if (currentUrl !== baseUrl && currentUrl !== baseUrl + '/') {
                // Use history.pushState to avoid full page reload
                window.history.pushState({}, '', '/');

                // Trigger a popstate event to simulate navigation
                window.dispatchEvent(new PopStateEvent('popstate'));
                await sleep(1500);
                return true;
            }

            log('Already on home page or all methods failed', 'warning');
            return false;

        } catch (error) {
            log(`Error starting new chat: ${error.message}`, 'error');
            return false;
        }
    };

    // Function to update dynamic elements in real-time
    const updateDynamicElementsDisplay = (remainingElements) => {
        // UI dynamic elements textbox has been removed; keep storage sync for compatibility
        try {
            const newValue = JSON.stringify(remainingElements, null, 2);
            GM_setValue(STORAGE_KEYS.dynamicElementsInput, newValue);
        } catch { /* noop */ }
    };

    // ChatGPT interaction functions
    const getChatInput = () => {
        const selectors = [
            '#prompt-textarea',
            'div[contenteditable="true"]',
            'textarea[placeholder*="Message"]',
            'div.ProseMirror'
        ];

        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element && element.isContentEditable !== false) {
                return element;
            }
        }
        return null;
    };

    const getSendButton = () => {
        const selectors = [
            '#composer-submit-button',
            'button[data-testid="send-button"]',
            'button[aria-label*="Send"]',
            'button[aria-label*="submit"]'
        ];

        for (const selector of selectors) {
            const button = document.querySelector(selector);
            if (button && !button.disabled) {
                return button;
            }
        }
        return null;
    };

    const typeMessage = async (message) => {
        const input = getChatInput();
        if (!input) {
            throw new Error('Chat input not found');
        }

        // Clear existing content
        if (input.tagName === 'DIV') {
            input.innerHTML = '';
            input.focus();

            // For contenteditable divs, we need to insert text properly
            const paragraph = document.createElement('p');
            paragraph.textContent = message;
            input.appendChild(paragraph);

            // Trigger input events
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            input.value = message;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        await sleep(100);
        log(`Message typed: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);
    };

    const sendMessage = async () => {
        const sendButton = getSendButton();
        if (!sendButton || sendButton.disabled) {
            throw new Error('Send button not available');
        }

        sendButton.click();
        log('Message sent');
        await sleep(500);
    };

    const waitForResponse = async () => {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (responseObserver) {
                    responseObserver.disconnect();
                }
                reject(new Error('Response timeout'));
            }, CONFIG.RESPONSE_TIMEOUT);

            const checkForNewResponse = () => {
                // Look for the latest assistant message
                const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
                const latestMessage = assistantMessages[assistantMessages.length - 1];

                if (latestMessage && latestMessage !== lastResponseElement) {
                    // Check if the message is complete (not generating)
                    const isGenerating = document.querySelector('[data-testid="stop-button"]') ||
                        document.querySelector('.result-thinking') ||
                        latestMessage.querySelector('.typing-indicator');

                    if (!isGenerating) {
                        clearTimeout(timeout);
                        if (responseObserver) {
                            responseObserver.disconnect();
                        }
                        lastResponseElement = latestMessage;
                        resolve(latestMessage);
                    }
                }
            };

            // Initial check
            checkForNewResponse();

            // Set up observer for DOM changes
            responseObserver = new MutationObserver(() => {
                checkForNewResponse();
            });

            responseObserver.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });
        });
    };

    const extractResponseText = (responseElement) => {
        if (!responseElement) return '';

        // Try different selectors for response content
        const contentSelectors = [
            '.markdown',
            '.prose',
            '[data-message-id]',
            '.whitespace-pre-wrap'
        ];

        for (const selector of contentSelectors) {
            const contentElement = responseElement.querySelector(selector);
            if (contentElement) {
                return contentElement.textContent.trim();
            }
        }

        return responseElement.textContent.trim();
    };

    // Stop batch processing
    const stopBatchProcessing = () => {
        isLooping = false;
        isProcessing = false;
        currentBatchIndex = 0;
        updateStatus('idle');
        updateProgress(0, 0);
        log('Batch processing stopped');
    };

    // Update progress bar
    const updateProgress = (current, total) => {
        if (!progressBar) return;

        if (total === 0) {
            progressBar.style.display = 'none';
            return;
        }

        progressBar.style.display = 'block';
        const percentage = (current / total) * 100;
        progressBar.querySelector('.progress-fill').style.width = `${percentage}%`;
        progressBar.querySelector('.progress-text').textContent = `${current}/${total}`;
    };

    // UI Creation
    const createUI = () => {
        isDarkMode = detectDarkMode();

        // Main container
        mainContainer = document.createElement('div');
        mainContainer.id = 'chatgpt-automation-ui';
        mainContainer.className = isDarkMode ? 'dark-mode' : 'light-mode';
        mainContainer.innerHTML = `
            <div class="automation-header" id="automation-header">
                <h3>ChatGPT Automation Pro</h3>
                <div class="header-controls">
                    <div class="status-indicator" id="status-indicator">
                        <span class="status-dot"></span>
                        <span class="status-text">Ready</span>
                    </div>
                    <button class="header-btn" id="header-log-toggle" title="Show/Hide Log" aria-label="Show/Hide Log">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M4 5h16v2H4V5zm0 6h16v2H4v-2zm0 6h10v2H4v-2z"/>
                        </svg>
                    </button>
                    <button class="header-btn" id="minimize-btn" title="Minimize" aria-label="Minimize">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 12h12v2H6z"/>
                        </svg>
                    </button>
                    <button class="header-btn" id="close-btn" title="Close" aria-label="Close">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M18.3 5.71L12 12.01L5.7 5.71L4.29 7.12L10.59 13.42L4.29 19.72L5.7 21.13L12 14.83L18.3 21.13L19.71 19.72L13.41 13.42L19.71 7.12L18.3 5.71Z"/>
                        </svg>
                    </button>
                </div>
            </div>

            <div class="automation-content" id="automation-content">
                <div class="progress-container" id="progress-container" style="display: none;">
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                    <div class="progress-text">0/0</div>
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
                                    <input type="text" id="composer-preset-name-input" class="settings-input" placeholder="Preset name" style="flex: 1;">
                                    <select id="composer-preset-select" class="settings-input" style="flex: 2;">
                                        <option value="">Select preset...</option>
                                    </select>
                                    <button class="btn btn-secondary" id="save-composer-preset-btn" title="Save current configuration">💾</button>
                                    <button class="btn btn-primary" id="load-composer-preset-btn" title="Load selected preset">📂</button>
                                    <button class="btn btn-danger" id="delete-composer-preset-btn" title="Delete selected preset">🗑️</button>
                                </div>
                            </div>
                            <div id="chain-canvas" class="chain-canvas">
                                <div class="chain-toolbar">
                                    <button class="btn btn-secondary" id="add-step-btn">Add Step</button>
                                    <button class="btn btn-secondary" id="validate-chain-btn">Validate Chain</button>
                                    <button class="btn btn-primary" id="run-chain-btn">Run Chain</button>
                                </div>
                                <div id="chain-cards" class="chain-cards"></div>
                            </div>
                            <div class="help-text">Visual editor for multi-step automation chains. Steps connect in sequence; supports templates and custom JavaScript execution.</div>
                        </div>
                        <div class="form-group">
                            <label for="chain-json-input">Chain JSON (advanced):</label>
                            <div class="code-editor">
                                <textarea id="chain-json-input" rows="6" placeholder='{
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
      "code": "log(\"Processing: \" + steps[\"step-1\"].response);"
    }
  ]
}'></textarea>
                                <div class="editor-tools">
                                    <button class="tool-btn" id="format-chain-json-btn" title="Format JSON">{ }</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="tab-content" id="settings-tab">
                        <div class="form-group">
                            <label>Debug mode:</label>
                            <label class="checkbox-label">
                                <input type="checkbox" id="debug-mode-checkbox">
                                <span class="checkmark"></span>
                                Enable debug logging
                            </label>
                        </div>
                        <div class="form-group">
                            <label>Batch settings:</label>
                            <div class="batch-controls">
                                <div class="batch-settings">
                                    <label class="checkbox-label">
                                        <input type="checkbox" id="loop-checkbox">
                                        <span class="checkmark"></span>
                                        Process all items in batch
                                    </label>
                                    <label class="checkbox-label">
                                        <input type="checkbox" id="auto-remove-checkbox" checked>
                                        <span class="checkmark"></span>
                                        Remove processed items from queue
                                    </label>
                                    <label class="checkbox-label">
                                        <input type="checkbox" id="new-chat-checkbox">
                                        <span class="checkmark"></span>
                                        Start new chat for each item
                                    </label>
                                    <div class="wait-time-control">
                                        <label for="wait-time-input">Wait between items (ms):</label>
                                        <input type="number" id="wait-time-input" min="100" max="30000" value="2000" step="100">
                                    </div>
                                </div>
                                <div class="batch-actions">
                                    <button id="stop-batch-btn" class="btn btn-danger" style="display: none;">Stop Batch</button>
                                </div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="response-timeout-input">Response timeout (ms):</label>
                            <input type="number" id="response-timeout-input" min="10000" max="6000000" step="1000" class="settings-input timeout">
                        </div>
                        <div class="form-group">
                            <label>Panel size limits (px):</label>
                            <div class="size-inputs-grid">
                                <div class="size-input-group">
                                    <label for="min-width-input">Min width</label>
                                    <input type="number" id="min-width-input" min="200" max="1200" step="10" class="settings-input size">
                                </div>
                                <div class="size-input-group">
                                    <label for="min-height-input">Min height</label>
                                    <input type="number" id="min-height-input" min="120" max="1200" step="10" class="settings-input size">
                                </div>
                                <div class="size-input-group">
                                    <label for="max-width-input">Max width</label>
                                    <input type="number" id="max-width-input" min="200" max="2000" step="10" class="settings-input size">
                                </div>
                                <div class="size-input-group">
                                    <label for="max-height-input">Max height</label>
                                    <input type="number" id="max-height-input" min="120" max="2000" step="10" class="settings-input size">
                                </div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>Visibility:</label>
                            <label class="checkbox-label">
                                <input type="checkbox" id="default-visible-checkbox">
                                <span class="checkmark"></span>
                                Show panel by default
                            </label>
                            <div class="help-text">Controls default visibility on page load. You can still toggle from the header button.</div>
                        </div>
                    </div>

                </div>

                <div class="automation-log" id="log-container">
                    <div class="log-header">
                        <span>Activity Log</span>
                        <div class="log-header-controls">
                            <button class="tool-btn" id="toggle-auto-scroll-btn" title="Toggle Auto-scroll">📜</button>
                            <button class="tool-btn" id="clear-log-btn" title="Clear Log">🗑️</button>
                        </div>
                    </div>
                    <div class="log-content"></div>
                </div>
            </div>

            <div class="resize-handle" id="resize-handle"></div>

            <!-- Modal for editing a chain step -->
            <div id="chain-step-modal" class="chain-modal" aria-hidden="true" style="display:none;">
                <div class="chain-modal-backdrop"></div>
                <div class="chain-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="chain-step-title">
                    <div class="chain-modal-header">
                        <h4 id="chain-step-title">Edit Step</h4>
                        <div class="step-modal-presets">
                            <select id="step-preset-select" class="settings-input" style="min-width: 120px;">
                                <option value="">Select preset...</option>
                            </select>
                            <button class="tool-btn" id="save-step-preset-btn" title="Save as preset">💾</button>
                            <button class="tool-btn" id="delete-step-preset-btn" title="Delete preset">🗑️</button>
                        </div>
                        <button class="header-btn" id="close-step-modal-btn" aria-label="Close">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M18.3 5.71L12 12.01L5.7 5.71L4.29 7.12L10.59 13.42L4.29 19.72L5.7 21.13L12 14.83L18.3 21.13L19.71 19.72L13.41 13.42L19.71 7.12L18.3 5.71Z"/>
                        </svg>
                        </button>
                    </div>
                    <div class="chain-modal-body">
                        <div class="form-group">
                            <label for="step-id-input">ID</label>
                            <input id="step-id-input" class="settings-input" placeholder="step-1">
                        </div>
                        <div class="form-group">
                            <label for="step-title-input">Title</label>
                            <input id="step-title-input" class="settings-input" placeholder="Describe the step">
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
                            <label for="step-prompt-template">Message Template</label>
                            <textarea id="step-prompt-template" rows="4" class="settings-input" placeholder="Send a message to ChatGPT. Use {steps.stepId.response} to access previous step data."></textarea>
                            <div class="help-text">Access previous step data: {steps.stepId.response} for prompts, {steps.stepId.data} for HTTP, {steps.stepId.status} for HTTP status</div>
                        </div>
                        <div class="form-group" data-field="template">
                            <label for="step-template-input">Message Template</label>
                            <textarea id="step-template-input" rows="4" class="settings-input" placeholder="Template with placeholders like {{item}}, {{index}}, {{total}} or {steps.stepId.data}..."></textarea>
                            <label for="step-template-elements" style="margin-top: 8px;">Dynamic Elements (JSON array or function)</label>
                            <textarea id="step-template-elements" rows="3" class="settings-input" placeholder='["item1", "item2", "item3"] or () => ["generated", "items"]'></textarea>
                            <div class="help-text">Batch processing: {{item}} for current item, {steps.stepId.response} for previous step data</div>
                        </div>
                        <div class="form-group" data-field="http">
                            <label>HTTP Request</label>
                            <input id="step-http-url" class="settings-input" placeholder="https://api.example.com/data or {steps.stepId.data.apiUrl}">
                            <div style="display:flex; gap:8px; margin-top:6px;">
                                <select id="step-http-method" class="settings-input"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>
                                <input id="step-http-headers" class="settings-input" placeholder='{"Authorization": "Bearer {steps.authStep.data.token}"}'>
                            </div>
                            <textarea id="step-http-body" rows="3" class="settings-input" placeholder="Request body: {steps.stepId.response} or JSON data"></textarea>
                            <div class="help-text">Access response with {steps.thisStepId.data} or {steps.thisStepId.status}. Use previous step data in URL/headers/body.</div>
                        </div>
                        <div class="form-group" data-field="js">
                            <label for="step-js-code">JavaScript Code</label>
                            <textarea id="step-js-code" rows="6" class="settings-input" placeholder="// Access previous steps with steps.stepId.data or steps.stepId.response
// Available: response, log, console, item, index, total, http, steps, lastResponse
// Example: log('API response:', steps.httpStep.data);"></textarea>
                            <div class="help-text">Access step data with <code>steps.stepId.data</code> or <code>steps.stepId.response</code>. Use <code>http</code> for API calls, <code>log()</code> for output.</div>
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
            style.textContent = `
            /* Base styles that adapt to ChatGPT's theme (scoped) */
            #chatgpt-automation-ui {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 380px;
                min-width: ${CONFIG.MIN_WIDTH}px;
                max-width: ${CONFIG.MAX_WIDTH}px;
                min-height: ${CONFIG.MIN_HEIGHT}px;
                max-height: ${CONFIG.MAX_HEIGHT}px;
                background: var(--main-surface-primary, #ffffff);
                border: 1px solid var(--border-medium, rgba(0,0,0,0.1));
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
                font-family: var(--font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
                z-index: 10000;
                resize: both;
                overflow: hidden;
                backdrop-filter: blur(10px);
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }

            #chatgpt-automation-ui.dark-mode {
                background: var(--main-surface-primary, #2d2d30);
                border-color: var(--border-medium, rgba(255,255,255,0.1));
                color: var(--text-primary, #ffffff);
            }

            #chatgpt-automation-ui.minimized {
                /* Keep panel fully resizable when minimized */
                resize: both;
                /* Do not override height in minimized mode; user controls size */
            }
            #chatgpt-automation-ui.minimized .automation-content {
                display: flex;
                flex-direction: column;
                min-height: 0;
                height: calc(100% - 60px); /* Account for header height */
            }
            #chatgpt-automation-ui.minimized .progress-container,
            #chatgpt-automation-ui.minimized .automation-form {
                display: none;
            }
            #chatgpt-automation-ui.minimized .automation-log {
                display: flex !important;
                flex-direction: column;
                /* occupy the available area while minimized */
                flex: 1 1 auto;
                min-height: 0;
                height: 100%;
            }
            #chatgpt-automation-ui.minimized #log-container {
                flex: 1 1 auto;
                min-height: 0;
                overflow: hidden;
                height: 100%;
            }
            #chatgpt-automation-ui.minimized .log-content {
                /* Let logs fill available space and scroll internally */
                flex: 1 1 auto;
                min-height: 0;
                overflow-y: auto;
                height: calc(100% - 50px); /* Account for log header */
            }
            #chatgpt-automation-ui.minimized .automation-header {
                position: sticky;
                top: 0;
                z-index: 1;
            }

            #chatgpt-automation-ui .automation-header {
                background: linear-gradient(135deg, var(--brand-purple, #6366f1) 0%, var(--brand-purple-darker, #4f46e5) 100%);
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
                border-bottom: 1px solid var(--border-light, rgba(0,0,0,0.06));
                background: var(--surface-secondary, #f8fafc);
            }

            #chatgpt-automation-ui.dark-mode .progress-container {
                background: var(--surface-secondary, #1e1e20);
                border-color: var(--border-light, rgba(255,255,255,0.06));
            }

            #chatgpt-automation-ui .progress-bar {
                width: 100%;
                height: 4px;
                background: var(--border-light, rgba(0,0,0,0.1));
                border-radius: 2px;
                overflow: hidden;
                margin-bottom: 4px;
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

            #chatgpt-automation-ui .automation-form {
                padding: 16px;
                /* Let the form take its natural height so logs can fill the rest */
                flex: 0 1 auto;
                overflow: auto;
            }

            #chatgpt-automation-ui .tab-container {
                display: flex;
                border-bottom: 1px solid var(--border-light, rgba(0,0,0,0.06));
                margin-bottom: 16px;
            }

            #chatgpt-automation-ui.dark-mode .tab-container {
                border-color: var(--border-light, rgba(255,255,255,0.06));
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
                border: 1px solid var(--border-medium, rgba(0,0,0,0.1));
                border-radius: 8px;
                font-size: 13px;
                resize: vertical;
                font-family: 'SF Mono', 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                box-sizing: border-box;
                background: var(--input-background, #ffffff);
                color: var(--text-primary, #374151);
                transition: border-color 0.2s, box-shadow 0.2s;
            }

            #chatgpt-automation-ui.dark-mode .form-group textarea {
                background: var(--input-background, #1e1e20);
                color: var(--text-primary, #f3f4f6);
                border-color: var(--border-medium, rgba(255,255,255,0.1));
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
                background: var(--surface-secondary, rgba(0,0,0,0.05));
                border: none;
                border-radius: 4px;
                padding: 4px 6px;
                font-size: 10px;
                cursor: pointer;
                color: var(--text-secondary, #6b7280);
                transition: background 0.2s;
            }

            #chatgpt-automation-ui .tool-btn:hover {
                background: var(--surface-secondary, rgba(0,0,0,0.1));
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
                border: 1px solid var(--border-medium, rgba(0,0,0,0.1));
                border-radius: 4px;
                font-size: 12px;
                background: var(--input-background, #ffffff);
                color: var(--text-primary, #374151);
            }

            #chatgpt-automation-ui.dark-mode .wait-time-control input[type="number"] {
                background: var(--input-background, #1e1e20);
                color: var(--text-primary, #f3f4f6);
                border-color: var(--border-medium, rgba(255,255,255,0.1));
            }

            #chatgpt-automation-ui .wait-time-control input[type="number"]:focus {
                outline: none;
                border-color: var(--brand-purple, #6366f1);
                box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
            }

            /* Settings input styles */
            #chatgpt-automation-ui .settings-input {
                padding: 6px 8px;
                border: 1px solid var(--border-medium, rgba(0,0,0,0.1));
                border-radius: 6px;
                font-size: 13px;
                background: var(--input-background, #ffffff);
                color: var(--text-primary, #374151);
            }

            #chatgpt-automation-ui.dark-mode .settings-input {
                background: var(--input-background, #1e1e20);
                color: var(--text-primary, #f3f4f6);
                border-color: var(--border-medium, rgba(255,255,255,0.1));
            }

            #chatgpt-automation-ui .settings-input:focus {
                outline: none;
                border-color: var(--brand-purple, #6366f1);
                box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
            }

            #chatgpt-automation-ui .settings-input.timeout {
                width: 140px;
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
                border: 1px solid var(--border-light, rgba(0,0,0,0.06));
            }

            #chatgpt-automation-ui.dark-mode .btn-secondary {
                background: var(--surface-secondary, #1e1e20);
                color: var(--text-primary, #f3f4f6);
                border-color: var(--border-light, rgba(255,255,255,0.06));
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
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            #chatgpt-automation-ui .automation-log {
                border-top: 1px solid var(--border-light, rgba(0,0,0,0.06));
                /* Fill remaining space under the form */
                flex: 1 1 auto;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                /* allow internal scrolling via .log-content */
                min-height: 0;
            }

            #chatgpt-automation-ui.dark-mode .automation-log {
                border-color: var(--border-light, rgba(255,255,255,0.06));
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
                /* Ensure the content area reserves space under the log header and scrolls correctly */
                height: calc(100% - 50px);
                box-sizing: border-box;
            }

            #chatgpt-automation-ui #step-next-select {
                width: 100%;
            }

            #chatgpt-automation-ui .log-entry {
                padding: 6px 0;
                font-size: 11px;
                font-family: 'SF Mono', 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                border-bottom: 1px solid var(--border-light, rgba(0,0,0,0.03));
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
                background: linear-gradient(-45deg, transparent 0%, transparent 40%, var(--border-medium, rgba(0,0,0,0.1)) 40%, var(--border-medium, rgba(0,0,0,0.1)) 60%, transparent 60%, transparent 100%);
            }

            /* Chain canvas styles */
            #chatgpt-automation-ui .chain-canvas {
                border: 1px dashed var(--border-light, rgba(0,0,0,0.1));
                border-radius: 8px;
                padding: 8px;
                min-height: 120px;
            }
            #chatgpt-automation-ui .chain-toolbar { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
            #chatgpt-automation-ui .chain-cards { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-start; min-height: 80px; }

            /* Empty chain cards container */
            #chatgpt-automation-ui .chain-cards:empty {
                display: flex;
                align-items: center;
                justify-content: center;
                background: var(--surface-secondary, #f8fafc);
                border: 2px dashed var(--border-medium, rgba(0,0,0,0.15));
                border-radius: 12px;
                padding: 32px 16px;
                text-align: center;
                color: var(--text-secondary, #6b7280);
                font-size: 14px;
                transition: all 0.2s ease;
            }
            #chatgpt-automation-ui.dark-mode .chain-cards:empty {
                background: var(--surface-secondary, #1e1e20);
                border-color: var(--border-medium, rgba(255,255,255,0.15));
                color: var(--text-secondary, #9ca3af);
            }
            #chatgpt-automation-ui .chain-cards:empty::before {
                content: "🔗 No steps yet. Click 'Add Step' to start building your automation chain.";
                font-weight: 500;
            }

            #chatgpt-automation-ui .chain-card {
                background: var(--surface-secondary, #f8fafc);
                border: 1px solid var(--border-light, rgba(0,0,0,0.06));
                border-radius: 8px;
                padding: 8px;
                min-width: 140px;
                max-width: 200px;
                position: relative;
                transition: all 0.2s ease;
            }
            #chatgpt-automation-ui .chain-card:hover {
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                transform: translateY(-1px);
            }
            #chatgpt-automation-ui.dark-mode .chain-card { background: var(--surface-secondary, #1e1e20); border-color: var(--border-light, rgba(255,255,255,0.06)); }
            #chatgpt-automation-ui.dark-mode .chain-card:hover {
                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            }
            #chatgpt-automation-ui .chain-card .title { font-weight: 600; font-size: 12px; margin-bottom: 4px; }
            #chatgpt-automation-ui .chain-card .meta { font-size: 11px; opacity: 0.8; margin-bottom: 6px; }
            #chatgpt-automation-ui .chain-card .actions { display: flex; gap: 6px; }

            /* Composer presets */
            #chatgpt-automation-ui .composer-presets {
                margin-bottom: 12px;
                padding: 8px;
                background: var(--surface-secondary, #f8fafc);
                border-radius: 8px;
                border: 1px solid var(--border-light, rgba(0,0,0,0.06));
            }
            #chatgpt-automation-ui.dark-mode .composer-presets {
                background: var(--surface-secondary, #1e1e20);
                border-color: var(--border-light, rgba(255,255,255,0.06));
            }
            #chatgpt-automation-ui .composer-presets .preset-row {
                display: flex;
                gap: 8px;
                align-items: center;
            }

            /* Modal */
            #chatgpt-automation-ui .chain-modal { position: fixed; inset:0; z-index:10001; }
            #chatgpt-automation-ui .chain-modal-backdrop { position:absolute; inset:0; background: rgba(0,0,0,0.3); }
            #chatgpt-automation-ui .chain-modal-dialog { position:relative; background: var(--main-surface-primary, #fff); width: 520px; max-width: calc(100% - 32px); margin: 40px auto; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.2); overflow:hidden; }
            #chatgpt-automation-ui.dark-mode .chain-modal-dialog { background: var(--main-surface-primary, #2d2d30); }
            #chatgpt-automation-ui .chain-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                border-bottom: 1px solid var(--border-light, rgba(0,0,0,0.06));
                gap: 12px;
            }
            #chatgpt-automation-ui .step-modal-presets {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            #chatgpt-automation-ui .chain-modal-body { padding: 12px 16px; max-height:60vh; overflow:auto; }
            #chatgpt-automation-ui .chain-modal-footer { display:flex; gap:8px; justify-content:flex-end; padding:12px 16px; border-top:1px solid var(--border-light, rgba(0,0,0,0.06)); }

            #chatgpt-automation-ui .presets-grid .preset-row { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }

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
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }

            @keyframes pulse-processing {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.7; transform: scale(1.2); }
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
        document.body.appendChild(mainContainer);

        // Get UI elements
        statusIndicator = document.getElementById('status-indicator');
        logContainer = document.querySelector('.log-content');
        progressBar = document.getElementById('progress-container');
        resizeHandle = document.getElementById('resize-handle');

        // Restore saved inputs, toggles and config
        try {
            // Chain JSON
            const savedChain = GM_getValue(STORAGE_KEYS.chainDef, '');
            if (savedChain) {
                const chainInput = document.getElementById('chain-json-input');
                if (chainInput) chainInput.value = savedChain;
            }

            // Checkboxes and switches
            const loopEl = document.getElementById('loop-checkbox');
            const autoRemoveEl = document.getElementById('auto-remove-checkbox');
            const newChatEl = document.getElementById('new-chat-checkbox');

            if (loopEl) {
                loopEl.checked = !!GM_getValue(STORAGE_KEYS.loop, true);
                isLooping = loopEl.checked;
            }
            if (autoRemoveEl) {
                autoRemoveEl.checked = GM_getValue(STORAGE_KEYS.autoRemove, true);
                autoRemoveProcessed = autoRemoveEl.checked;
            }
            if (newChatEl) {
                newChatEl.checked = !!GM_getValue(STORAGE_KEYS.newChat, false);
                newChatPerItem = newChatEl.checked;
            }

            // Auto-scroll state (button only, no checkbox)
            autoScrollLogs = GM_getValue(STORAGE_KEYS.autoScroll, true);

            // Wait time
            const waitInput = document.getElementById('wait-time-input');
            const savedWait = parseInt(GM_getValue(STORAGE_KEYS.waitTime, batchWaitTime));
            if (!Number.isNaN(savedWait)) {
                batchWaitTime = savedWait;
                if (waitInput) waitInput.value = String(savedWait);
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

            const minW = parseInt(GM_getValue(STORAGE_KEYS.configMinWidth, CONFIG.MIN_WIDTH));
            const minH = parseInt(GM_getValue(STORAGE_KEYS.configMinHeight, CONFIG.MIN_HEIGHT));
            const maxW = parseInt(GM_getValue(STORAGE_KEYS.configMaxWidth, CONFIG.MAX_WIDTH));
            const maxH = parseInt(GM_getValue(STORAGE_KEYS.configMaxHeight, CONFIG.MAX_HEIGHT));
            if (!Number.isNaN(minW)) CONFIG.MIN_WIDTH = minW;
            if (!Number.isNaN(minH)) CONFIG.MIN_HEIGHT = minH;
            if (!Number.isNaN(maxW)) CONFIG.MAX_WIDTH = maxW;
            if (!Number.isNaN(maxH)) CONFIG.MAX_HEIGHT = maxH;
            const minWEl = document.getElementById('min-width-input');
            const minHEl = document.getElementById('min-height-input');
            const maxWEl = document.getElementById('max-width-input');
            const maxHEl = document.getElementById('max-height-input');
            if (minWEl) minWEl.value = String(CONFIG.MIN_WIDTH);
            if (minHEl) minHEl.value = String(CONFIG.MIN_HEIGHT);
            if (maxWEl) maxWEl.value = String(CONFIG.MAX_WIDTH);
            if (maxHEl) maxHEl.value = String(CONFIG.MAX_HEIGHT);
            // Override CSS min/max with inline styles so changes take effect immediately
            mainContainer.style.minWidth = CONFIG.MIN_WIDTH + 'px';
            mainContainer.style.minHeight = CONFIG.MIN_HEIGHT + 'px';
            mainContainer.style.maxWidth = CONFIG.MAX_WIDTH + 'px';
            mainContainer.style.maxHeight = CONFIG.MAX_HEIGHT + 'px';

            const defVis = !!GM_getValue(STORAGE_KEYS.configDefaultVisible, CONFIG.DEFAULT_VISIBLE);
            CONFIG.DEFAULT_VISIBLE = defVis;
            const dvEl = document.getElementById('default-visible-checkbox');
            if (dvEl) dvEl.checked = defVis;

            // Chain definition
            try {
                const savedChain = GM_getValue(STORAGE_KEYS.chainDef, '');
                const chainInput = document.getElementById('chain-json-input');
                if (savedChain && chainInput) {
                    chainInput.value = typeof savedChain === 'string' ? savedChain : JSON.stringify(savedChain, null, 2);
                    chainDefinition = JSON.parse(chainInput.value);
                }
            } catch { /* ignore */ }
        } catch { }

        // Load saved state
    const savedState = loadUIState();
    if (savedState.left) {
            mainContainer.style.left = savedState.left;
            mainContainer.style.right = 'auto';
        }
        if (savedState.top) {
            mainContainer.style.top = savedState.top;
        }
        if (savedState.width) {
            mainContainer.style.width = savedState.width;
        }
        if (savedState.height) {
            mainContainer.style.height = savedState.height;
        }
        if (savedState.minimized) {
            isMinimized = true;
            mainContainer.classList.add('minimized');
        }
        // Respect explicit persisted visibility over default
        if (typeof savedState.visible === 'boolean') {
            uiVisible = savedState.visible;
        } else {
            uiVisible = !!CONFIG.DEFAULT_VISIBLE;
        }
        mainContainer.style.display = uiVisible ? 'block' : 'none';

        // Restore persisted log history
        try {
            const hist = GM_getValue(STORAGE_KEYS.logHistory, []);
            if (Array.isArray(hist) && hist.length && logContainer) {
                hist.slice(-200).forEach(h => {
                    const div = document.createElement('div');
                    div.className = `log-entry log-${h.type || 'info'}`;
                    div.textContent = h.msg;
                    logContainer.appendChild(div);
                });
                logContainer.scrollTop = logContainer.scrollHeight;
            }
        } catch { }

        // Bind events
        bindEvents();

        // Initialize auto-scroll button state
        const autoScrollBtn = document.getElementById('toggle-auto-scroll-btn');
        if (autoScrollBtn && typeof autoScrollLogs === 'boolean') {
            autoScrollBtn.style.opacity = autoScrollLogs ? '1' : '0.5';
            autoScrollBtn.title = autoScrollLogs ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
        }

        // Watch for theme changes
        const observer = new MutationObserver(() => {
            const newDarkMode = detectDarkMode();
            if (newDarkMode !== isDarkMode) {
                isDarkMode = newDarkMode;
                mainContainer.className = isDarkMode ? 'dark-mode' : 'light-mode';
                if (isMinimized) mainContainer.classList.add('minimized');
            }
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'data-theme']
        });

        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'data-theme']
        });

        // Add persistent header launcher
        mountHeaderLauncher();
        startHeaderObserver();
        log('UI initialized successfully');

        // Auto-resize container to fit initial content
        setTimeout(() => autoResizeContainer(), 200);
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
            let ui = document.getElementById('chatgpt-automation-ui');
            if (!ui) {
                createUI();
                ui = document.getElementById('chatgpt-automation-ui');
            }
            if (!ui) return;
            const show = ui.style.display === 'none';
            ui.style.display = show ? 'block' : 'none';
            mainContainer = ui;
            uiVisible = show;
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
        const savedState = loadUIState();
    const shouldShow = savedState.visible === true || (savedState.visible == null && CONFIG.DEFAULT_VISIBLE);
        if (shouldShow && !document.getElementById('chatgpt-automation-ui')) {
            createUI();
        }
        return true;
    };

    const startHeaderObserver = () => {
        if (headerObserverStarted) return;
        headerObserverStarted = true;
        const ensure = () => {
            try {
                // Recreate launcher if missing
                mountHeaderLauncher();
                // Ensure UI matches persisted visibility
                const savedState = loadUIState();
                const ui = document.getElementById('chatgpt-automation-ui');
                const shouldShow = savedState.visible === true || (savedState.visible == null && CONFIG.DEFAULT_VISIBLE);
                if (ui) {
                    ui.style.display = shouldShow ? 'block' : 'none';
                } else if (shouldShow) {
                    createUI();
                }
            } catch (e) { /* noop */ }
        };
        ensure();
        const obs = new MutationObserver(() => ensure());
        obs.observe(document.body, { childList: true, subtree: true });
    };

    const updateStatus = (status) => {
        if (!statusIndicator) return;

        const statusTexts = {
            idle: 'Ready',
            processing: 'Typing...',
            waiting: 'Waiting for response...',
            complete: 'Complete',
            error: 'Error'
        };

        statusIndicator.className = `status-indicator status-${status}`;
        statusIndicator.querySelector('.status-text').textContent = statusTexts[status] || 'Unknown';
    };

    // Auto-resize container to fit content
    const autoResizeContainer = () => {
        if (!mainContainer || isMinimized) return;

        // declare here so catch block can restore on error
        let originalHeight = null;
        let originalMaxHeight = null;

        try {
            // Get the automation content container
            const contentContainer = document.querySelector('#automation-content');
            if (!contentContainer) return;

            // Temporarily remove height constraints to measure natural height
            originalHeight = mainContainer.style.height;
            originalMaxHeight = mainContainer.style.maxHeight;

            mainContainer.style.height = 'auto';
            mainContainer.style.maxHeight = 'none';

            // Force layout recalculation
            contentContainer.style.height = 'auto';

            // Wait for next frame to get accurate measurements
            requestAnimationFrame(() => {
                const contentHeight = contentContainer.scrollHeight;
                const headerHeight = 60; // Header height
                const logHeaderHeight = 45; // Log header when visible
                const padding = 20; // Some padding

                let targetHeight = contentHeight + headerHeight + padding;

                // Add log header height if log is visible
                const logContainer = document.getElementById('log-container');
                if (logContainer) {
                    targetHeight += logHeaderHeight;
                }

                // Apply min/max constraints
                targetHeight = Math.max(targetHeight, CONFIG.MIN_HEIGHT);
                targetHeight = Math.min(targetHeight, CONFIG.MAX_HEIGHT);

                // Apply the calculated height
                mainContainer.style.height = `${targetHeight}px`;
                mainContainer.style.maxHeight = `${CONFIG.MAX_HEIGHT}px`;

                // Reset content container height
                contentContainer.style.height = '';

                log(`Container auto-resized to ${targetHeight}px`);
            });

        } catch (error) {
            // Restore original height on error
            if (originalHeight) mainContainer.style.height = originalHeight;
            if (originalMaxHeight) mainContainer.style.maxHeight = originalMaxHeight;
            log(`Auto-resize error: ${error.message}`, 'warning');
        }
    };

    const bindEvents = () => {
        // Tab switching
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tabName = btn.dataset.tab;

                // Update active tab button
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Update active tab content
                document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
                document.getElementById(`${tabName}-tab`).classList.add('active');

                // Auto-resize container to fit new content
                setTimeout(() => autoResizeContainer(), 100);

                // Persist active tab
                saveToStorage(STORAGE_KEYS.activeTab, tabName);
            });
        });

        // Stop batch button
        document.getElementById('stop-batch-btn').addEventListener('click', () => {
            stopBatchProcessing();
            document.getElementById('stop-batch-btn').style.display = 'none';
        });

        // Auto-remove processed items checkbox
        document.getElementById('auto-remove-checkbox').addEventListener('change', (e) => {
            autoRemoveProcessed = e.target.checked;
            log(`Auto-remove processed items: ${autoRemoveProcessed ? 'enabled' : 'disabled'}`);
            saveToStorage(STORAGE_KEYS.autoRemove, autoRemoveProcessed);
        });

        // New chat per item checkbox
        document.getElementById('new-chat-checkbox').addEventListener('change', (e) => {
            newChatPerItem = e.target.checked;
            log(`New chat per item: ${newChatPerItem ? 'enabled' : 'disabled'}`);
            saveToStorage(STORAGE_KEYS.newChat, newChatPerItem);
        });

        // Wait time input
        document.getElementById('wait-time-input').addEventListener('change', (e) => {
            const value = parseInt(e.target.value);
            if (value >= 0 && value <= 30000) {
                batchWaitTime = value;
                log(`Wait time between items set to ${value}ms`);
                saveToStorage(STORAGE_KEYS.waitTime, batchWaitTime);
            } else {
                e.target.value = batchWaitTime;
                log('Invalid wait time, keeping current value', 'warning');
            }
        });

        // Toggle log button (footer)
        const toggleLogVisibility = () => {
            const logWrap = document.getElementById('log-container');
            if (!logWrap) return;
            const isHidden = logWrap.style.display === 'none';
            logWrap.style.display = isHidden ? 'flex' : 'none';
            // Save state
            saveToStorage('log.visible', isHidden);
            setTimeout(() => autoResizeContainer(), 50);
        };
        // Header icon toggles log
        document.getElementById('header-log-toggle').addEventListener('click', toggleLogVisibility);

        // Clear log button
        document.getElementById('clear-log-btn').addEventListener('click', () => {
            logContainer.innerHTML = '';
            log('Log cleared');
        });

        // Toggle auto-scroll button
        document.getElementById('toggle-auto-scroll-btn').addEventListener('click', () => {
            autoScrollLogs = !autoScrollLogs;

            const btn = document.getElementById('toggle-auto-scroll-btn');
            btn.style.opacity = autoScrollLogs ? '1' : '0.5';
            btn.title = autoScrollLogs ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';

            log(`Auto-scroll logs: ${autoScrollLogs ? 'enabled' : 'disabled'}`);

            // If enabling auto-scroll, scroll to bottom immediately
            if (autoScrollLogs && logContainer) {
                logContainer.scrollTop = logContainer.scrollHeight;
            }

            // Save state to storage
            saveToStorage(STORAGE_KEYS.autoScroll, autoScrollLogs);
        });

        // Minimize button toggles compact view without forcing fixed heights
        let _previousHeight = null;
        document.getElementById('minimize-btn').addEventListener('click', () => {
            isMinimized = !isMinimized;
            if (isMinimized) {
                // Save previous explicit height if present
                _previousHeight = mainContainer.style.height || null;
                mainContainer.classList.add('minimized');
            } else {
                mainContainer.classList.remove('minimized');
                // Restore previous height or auto-resize
                if (_previousHeight) {
                    mainContainer.style.height = _previousHeight;
                } else {
                    mainContainer.style.height = '';
                    setTimeout(() => autoResizeContainer(), 100);
                }
            }
            saveUIState(true); // Immediate save for user action
        });

        // Close button
        document.getElementById('close-btn').addEventListener('click', () => {
            mainContainer.style.display = 'none';
            uiVisible = false;
            saveUIState(true); // Immediate save for user action
            log('UI closed');
        });

        // Tool buttons - removed since UI elements no longer exist

        // Template tab JS check and snippet - removed since elements no longer exist

    // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + Enter to send
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const sendBtn = document.getElementById('send-btn');
        if (sendBtn) sendBtn.click();
                e.preventDefault();
            }

            // Escape to minimize
            if (e.key === 'Escape' && mainContainer.contains(document.activeElement)) {
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
            const rect = mainContainer.getBoundingClientRect();
            dragOffset.x = e.clientX - rect.left;
            dragOffset.y = e.clientY - rect.top;
            header.style.userSelect = 'none';
            e.preventDefault();
        });

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            resizeStartWidth = mainContainer.offsetWidth;
            resizeStartHeight = mainContainer.offsetHeight;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                const x = e.clientX - dragOffset.x;
                const y = e.clientY - dragOffset.y;

                mainContainer.style.left = `${Math.max(0, Math.min(x, window.innerWidth - mainContainer.offsetWidth))}px`;
                mainContainer.style.top = `${Math.max(0, Math.min(y, window.innerHeight - mainContainer.offsetHeight))}px`;
                mainContainer.style.right = 'auto';

                saveUIState(); // Debounced for drag operations
            } else if (isResizing) {
                const newWidth = Math.max(CONFIG.MIN_WIDTH, Math.min(CONFIG.MAX_WIDTH, resizeStartWidth + (e.clientX - resizeStartX)));
                const newHeight = Math.max(CONFIG.MIN_HEIGHT, Math.min(CONFIG.MAX_HEIGHT, resizeStartHeight + (e.clientY - resizeStartY)));

                mainContainer.style.width = `${newWidth}px`;
                mainContainer.style.height = `${newHeight}px`;

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
            isLooping = e.target.checked;
            saveToStorage(STORAGE_KEYS.loop, isLooping);
        });

        // Settings: Debug mode
        const debugEl = document.getElementById('debug-mode-checkbox');
        if (debugEl) {
            debugEl.addEventListener('change', (e) => {
                CONFIG.DEBUG_MODE = !!e.target.checked;
                saveToStorage(STORAGE_KEYS.configDebug, CONFIG.DEBUG_MODE);
                log(`Debug mode ${CONFIG.DEBUG_MODE ? 'enabled' : 'disabled'}`);
            });
        }

        // Settings: Response timeout
        const timeoutEl = document.getElementById('response-timeout-input');
        if (timeoutEl) {
            timeoutEl.addEventListener('change', (e) => {
                const v = parseInt(e.target.value);
                if (!Number.isNaN(v) && v >= 10000 && v <= 6000000) {
                    CONFIG.RESPONSE_TIMEOUT = v;
                    saveToStorage(STORAGE_KEYS.configTimeout, v);
                    log(`Response timeout set to ${v}ms`);
                } else {
                    e.target.value = String(CONFIG.RESPONSE_TIMEOUT);
                    log('Invalid response timeout', 'warning');
                }
            });
        }

        // Settings: Size bounds (consolidated)
        const applySizeLimits = () => {
            mainContainer.style.minWidth = CONFIG.MIN_WIDTH + 'px';
            mainContainer.style.minHeight = CONFIG.MIN_HEIGHT + 'px';
            mainContainer.style.maxWidth = CONFIG.MAX_WIDTH + 'px';
            mainContainer.style.maxHeight = CONFIG.MAX_HEIGHT + 'px';
        };

        // Data-driven size input handlers
        const sizeInputs = [
            { id: 'min-width-input', configKey: 'MIN_WIDTH', storageKey: STORAGE_KEYS.configMinWidth, min: 200, max: 1200 },
            { id: 'min-height-input', configKey: 'MIN_HEIGHT', storageKey: STORAGE_KEYS.configMinHeight, min: 120, max: 1200 },
            { id: 'max-width-input', configKey: 'MAX_WIDTH', storageKey: STORAGE_KEYS.configMaxWidth, min: 200, max: 2000 },
            { id: 'max-height-input', configKey: 'MAX_HEIGHT', storageKey: STORAGE_KEYS.configMaxHeight, min: 120, max: 2000 }
        ];

        sizeInputs.forEach(({ id, configKey, storageKey, min, max }) => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('change', (e) => {
                    const v = parseInt(e.target.value);
                    if (!Number.isNaN(v) && v >= min && v <= max) {
                        CONFIG[configKey] = v;
                        saveToStorage(storageKey, v);
                        applySizeLimits();
                    } else {
                        e.target.value = String(CONFIG[configKey]);
                    }
                });
            }
        });

        // Settings: default visible
        const defVisEl = document.getElementById('default-visible-checkbox');
        if (defVisEl) defVisEl.addEventListener('change', (e) => {
            CONFIG.DEFAULT_VISIBLE = !!e.target.checked;
            try { GM_setValue(STORAGE_KEYS.configDefaultVisible, CONFIG.DEFAULT_VISIBLE); } catch { }
            // If user disables default visibility and UI wasn't explicitly opened, keep current visibility but don't force-open later
            log(`Default visibility ${CONFIG.DEFAULT_VISIBLE ? 'ON' : 'OFF'}`);
        });

        // Restore log visibility
        try {
            const logWrap = document.getElementById('log-container');
            const vis = GM_getValue('log.visible', true);
            if (logWrap) logWrap.style.display = vis ? 'flex' : 'none';
        } catch { }

        // Chain UI: basic actions
        const chainInput = document.getElementById('chain-json-input');
        const chainCards = document.getElementById('chain-cards');
        const refreshChainCards = () => {
            if (!chainCards) return;
            chainCards.innerHTML = '';
            let chain;
            try {
                chain = JSON.parse(chainInput.value || '{}');
                // Update global chainDefinition when parsing JSON
                chainDefinition = chain;
            } catch {
                chain = null;
                chainDefinition = null;
            }
            if (!chain || !Array.isArray(chain.steps) || chain.steps.length === 0) {
                // Chain cards will show empty state due to CSS :empty selector
                return;
            }
            chain.steps.forEach(step => {
                const card = document.createElement('div');
                card.className = 'chain-card';
                card.dataset.stepId = step.id;

                const typeDisplay = step.type === 'template' ? 'Template (Batch)' :
                    step.type === 'js' ? 'JavaScript' :
                        step.type === 'prompt' ? 'Prompt' :
                            step.type === 'http' ? 'HTTP Request' : step.type;

                card.innerHTML = `
                    <div class="title">${step.title || step.id || '(untitled)'}</div>
                    <div class="meta">type: ${typeDisplay}${step.next ? ` → ${step.next}` : ''}</div>
                    <div class="actions">
                        <button class="btn btn-secondary btn-sm" data-action="edit" title="Edit step">✏️</button>
                        <button class="btn btn-danger btn-sm" data-action="delete" title="Delete step">🗑️</button>
                    </div>
                `;

                card.querySelector('[data-action="edit"]').addEventListener('click', () => openStepEditor(step.id));
                card.querySelector('[data-action="delete"]').addEventListener('click', () => {
                    if (confirm(`Delete step "${step.title || step.id}"?`)) {
                        chain.steps = chain.steps.filter(s => s.id !== step.id);
                        // Remove references to this step
                        chain.steps.forEach(s => { if (s.next === step.id) s.next = ''; });
                        // Update entry point if needed
                        if (chain.entryId === step.id) {
                            chain.entryId = chain.steps.length > 0 ? chain.steps[0].id : '';
                        }
                        chainInput.value = JSON.stringify(chain, null, 2);
                        saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
                        refreshChainCards();
                        log(`Step "${step.title || step.id}" deleted`);
                    }
                });

                chainCards.appendChild(card);
            });
        };

        const openStepEditor = (stepId) => {
            let chain;
            try { chain = JSON.parse(chainInput.value || '{}'); } catch { chain = { steps: [] }; }
            if (!Array.isArray(chain.steps)) chain.steps = [];
            let step = chain.steps.find(s => s.id === stepId);
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

            // Prompt content
            const promptEl = document.getElementById('step-prompt-template');
            if (promptEl) promptEl.value = step.template || step.content || step.message || '';

            // Template fields
            document.getElementById('step-template-input').value = step.template || '';
            document.getElementById('step-template-elements').value = step.elements || '';

            // Prompt
            document.getElementById('step-prompt-template').value = step.template || '';

            // HTTP fields
            document.getElementById('step-http-url').value = step.url || '';
            document.getElementById('step-http-method').value = (step.method || 'GET').toUpperCase();
            document.getElementById('step-http-headers').value = step.headers ? JSON.stringify(step.headers) : '';
            document.getElementById('step-http-body').value = step.bodyTemplate || '';

            // JavaScript
            document.getElementById('step-js-code').value = step.code || '';

            // Populate next step selector with auto-suggestion
            const nextSel = document.getElementById('step-next-select');
            nextSel.innerHTML = '<option value="">(end)</option>';
            const currentIndex = chain.steps.findIndex(s => s.id === step.id);

            chain.steps.forEach((s, index) => {
                if (s.id !== step.id) { // Don't include self
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
                    const clear = id => { const el = document.getElementById(id); if (el) el.value = id === 'step-http-method' ? 'GET' : ''; };
                    ['step-prompt-template', 'step-template-input', 'step-template-elements', 'step-js-code', 'step-http-url', 'step-http-headers', 'step-http-body', 'step-http-method'].forEach(clear);

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
                modal.querySelectorAll('[data-field="prompt"]').forEach(el => el.style.display = type === 'prompt' ? 'block' : 'none');
                modal.querySelectorAll('[data-field="template"]').forEach(el => el.style.display = type === 'template' ? 'block' : 'none');
                modal.querySelectorAll('[data-field="http"]').forEach(el => el.style.display = type === 'http' ? 'block' : 'none');
                modal.querySelectorAll('[data-field="js"]').forEach(el => el.style.display = type === 'js' ? 'block' : 'none');
            };
            document.getElementById('step-type-select').onchange = onTypeChange;
            onTypeChange();

            const saveBtn = document.getElementById('save-step-btn');
            const deleteBtn = document.getElementById('delete-step-btn');
            const closeBtn = document.getElementById('close-step-modal-btn');

            const closeModal = () => { modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); };
            closeBtn.onclick = closeModal;

            deleteBtn.onclick = () => {
                if (confirm(`Delete step "${step.title || step.id}"?`)) {
                    chain.steps = chain.steps.filter(s => s.id !== step.id);
                    // Remove references
                    chain.steps.forEach(s => { if (s.next === step.id) s.next = ''; });
                    // Update entry point if needed
                    if (chain.entryId === step.id) {
                        chain.entryId = chain.steps.length > 0 ? chain.steps[0].id : '';
                    }
                    chainInput.value = JSON.stringify(chain, null, 2);
                    saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
                    refreshChainCards();
                    // Also delete matching preset by title or id if present
                    try {
                        const map = GM_getValue(STORAGE_KEYS.presetsSteps, {}) || {};
                        const toDelete = step.title && map[step.title] ? step.title : (map[step.id] ? step.id : null);
                        if (toDelete) {
                            delete map[toDelete];
                            GM_setValue(STORAGE_KEYS.presetsSteps, map);
                            log(`Step preset "${toDelete}" deleted`);
                        }
                    } catch { /* ignore */ }
                    closeModal();
                    log(`Step "${step.title || step.id}" deleted`);
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

                // Save type-specific fields based on current type
                if (step.type === 'template') {
                    step.template = document.getElementById('step-template-input').value;
                    step.elements = document.getElementById('step-template-elements').value;
                } else if (step.type === 'prompt') {
                    step.template = document.getElementById('step-prompt-template').value;
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
                    chain.steps.forEach(s => {
                        if (s.next === oldId) s.next = newId;
                    });
                    if (chain.entryId === oldId) chain.entryId = newId;
                }

                chainInput.value = JSON.stringify(chain, null, 2);
                saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
                refreshChainCards();
                closeModal();
                log(`Step "${step.title || step.id}" saved`);

                // Auto-save this step as a reusable preset
                try {
                    const presetName = step.title || step.id;
                    const stepPreset = {
                        type: step.type,
                        title: step.title,
                        template: step.template || '',
                        elements: step.elements || '',
                        code: step.code || '',
                        url: step.url || '',
                        method: step.method || 'GET',
                        headers: step.headers || '',
                        bodyTemplate: step.bodyTemplate || ''
                    };
                    const map = GM_getValue(STORAGE_KEYS.presetsSteps, {}) || {};
                    map[presetName] = stepPreset;
                    GM_setValue(STORAGE_KEYS.presetsSteps, map);
                    loadPresetSelects();
                    log(`Saved step preset: ${presetName}`);
                } catch { /* ignore */ }
            };
        };

        const addStepBtn = document.getElementById('add-step-btn');
        if (addStepBtn) addStepBtn.addEventListener('click', () => {
            let chain;
            try { chain = JSON.parse(chainInput.value || '{}'); } catch { chain = {}; }
            if (!chain.steps) chain.steps = [];

            const id = `step-${(chain.steps.length || 0) + 1}`;
            const newStep = {
                id,
                title: `Step ${chain.steps.length + 1}`,
                type: 'prompt',
                template: ''
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
            saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
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
        if (validateChainBtn) validateChainBtn.addEventListener('click', () => {
            try {
                const c = JSON.parse(chainInput.value || '{}');
                if (!c.entryId) throw new Error('Missing entryId');
                if (!Array.isArray(c.steps) || !c.steps.length) throw new Error('No steps');
                const ids = new Set(c.steps.map(s => s.id));
                if (!ids.has(c.entryId)) throw new Error('entryId not found among steps');
                c.steps.forEach(s => { if (s.next && !ids.has(s.next)) throw new Error(`Step ${s.id} next '${s.next}' not found`); });
                log('Chain valid');
            } catch (e) { log('Chain invalid: ' + e.message, 'error'); }
        });

        const runChainBtn = document.getElementById('run-chain-btn');
        if (runChainBtn) runChainBtn.addEventListener('click', async () => {
            // No UI dynamic elements input; start with empty unless inferred in steps
            dynamicElements = [];
            await runChainWithBatch();
        });

        const formatChainBtn = document.getElementById('format-chain-json-btn');
        if (formatChainBtn) formatChainBtn.addEventListener('click', () => {
            try {
                const obj = JSON.parse(chainInput.value);
                chainInput.value = JSON.stringify(obj, null, 2);
                // keep in-memory def in sync
                chainDefinition = obj;
                refreshChainCards();
                log('Chain JSON formatted');
                saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
            } catch (e) { log('Invalid JSON: ' + e.message, 'error'); }
        });

        // Change events to keep cards in sync and persist data
        if (chainInput) {
            chainInput.addEventListener('input', () => {
                let parsed = null;
                try { parsed = JSON.parse(chainInput.value || '{}'); } catch { /* ignore parse errors during typing */ }
                if (parsed) {
                    chainDefinition = parsed;
                    refreshChainCards();
                } else {
                    // if invalid, still clear cards to reflect invalid state
                    refreshChainCards();
                }
                saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
            });
        }
        refreshChainCards();

        // Presets: populate selects and wire buttons
        const loadPresetSelects = () => {
            // Create example presets if none exist or restore missing defaults
            let stepsMap = GM_getValue(STORAGE_KEYS.presetsSteps, {});
            const defaultSteps = {
                'Get Weather': {
                    type: 'http',
                    url: 'https://api.openweathermap.org/data/2.5/weather?q={item}&appid=YOUR_API_KEY',
                    method: 'get',
                    contentType: 'application/json'
                },
                'Extract Data': {
                    type: 'js',
                    code: '// Extract temperature from weather API\nconst data = JSON.parse(steps.weatherStep.data);\nlog("Temperature: " + data.main.temp + "°K");\nreturn data.main.temp;'
                },
                'Format Response': {
                    type: 'template',
                    template: 'The weather in {item} is {steps.extractData.response}°K ({Math.round((steps.extractData.response - 273.15) * 9/5 + 32)}°F)'
                },
                'Ask ChatGPT': {
                    type: 'prompt',
                    template: 'Explain why the weather is {steps.formatResponse.response} and what activities would be good for this temperature.'
                },
                'Basic Prompt': {
                    type: 'prompt',
                    template: 'Please analyze {item} and provide 3 key insights.'
                },
                'API Call': {
                    type: 'http',
                    url: 'https://jsonplaceholder.typicode.com/posts/{item}',
                    method: 'get',
                    contentType: 'application/json'
                },
                'Process JSON': {
                    type: 'js',
                    code: '// Process API response\nconst data = JSON.parse(steps.apiCall.data);\nlog("Post title:", data.title);\nreturn data.title;'
                }
            };

            // Merge defaults with existing, preserving user presets
            Object.entries(defaultSteps).forEach(([name, preset]) => {
                if (!stepsMap[name]) {
                    stepsMap[name] = preset;
                }
            });
            GM_setValue(STORAGE_KEYS.presetsSteps, stepsMap);


            let chainsMap = GM_getValue(STORAGE_KEYS.presetsChains, {});
            const defaultChains = {
                'Weather Analysis': JSON.stringify({ entryId: 'weather', steps: [
                    { id: 'weather', type: 'http', url: 'https://api.openweathermap.org/data/2.5/weather?q={item}&appid=YOUR_API_KEY', method: 'GET', next: 'extract' },
                    { id: 'extract', type: 'js', code: 'const data = JSON.parse(steps.weather.data);\nreturn data.main.temp;', next: 'chat' },
                    { id: 'chat', type: 'prompt', template: 'The temperature is {steps.extract.response}°K. What activities would you recommend for this weather?' }
                ]}, null, 2),
                'Content Research': JSON.stringify({ entryId: 'search', steps: [
                    { id: 'search', type: 'prompt', template: 'Research {item} and provide 3 key facts', next: 'summarize' },
                    { id: 'summarize', type: 'js', code: 'log("Research complete for: " + item);\nreturn steps.search.response.substring(0, 200) + "...";', next: 'expand' },
                    { id: 'expand', type: 'prompt', template: 'Based on this summary: {steps.summarize.response}, write a detailed article about {item}' }
                ]}, null, 2),
                'Simple Chain': JSON.stringify({ entryId: 'step1', steps: [
                    { id: 'step1', type: 'prompt', template: 'Tell me about {item}', next: 'step2' },
                    { id: 'step2', type: 'template', template: 'Summary: {steps.step1.response}' }
                ]}, null, 2)
            };

            // Merge defaults with existing, preserving user presets
            Object.entries(defaultChains).forEach(([name, preset]) => {
                if (!chainsMap[name]) {
                    chainsMap[name] = preset;
                }
            });
            GM_setValue(STORAGE_KEYS.presetsChains, chainsMap);            const fill = (id, map) => {
                const sel = document.getElementById(id);
                if (!sel) return;
                sel.innerHTML = '<option value="">Select preset...</option>';
                Object.keys(map || {}).sort().forEach(name => {
                    const o = document.createElement('option');
                    o.value = name;
                    o.textContent = name;
                    sel.appendChild(o);
                });
            };
            try {
                // Update composer presets
                fill('composer-preset-select', chainsMap);
                // Update step modal presets (from new steps store)
                fill('step-preset-select', stepsMap);
            } catch { }
        };

        const getComposerPresetName = () => (document.getElementById('composer-preset-name-input')?.value || '').trim();

        const savePreset = (storeKey, name, value) => {
            if (!name) return log('Enter a preset name', 'warning');
            try {
                const map = GM_getValue(storeKey, {}) || {};
                map[name] = value;
                GM_setValue(storeKey, map);
                loadPresetSelects();
                log(`Preset "${name}" saved`);
            } catch (e) {
                log('Save failed: ' + e.message, 'error');
            }
        };

        const deletePreset = (storeKey, selId) => {
            try {
                const sel = document.getElementById(selId);
                if (!sel || !sel.value) return log('Select a preset to delete', 'warning');
                const map = GM_getValue(storeKey, {}) || {};
                const name = sel.value;
                delete map[name];
                GM_setValue(storeKey, map);
                loadPresetSelects();
                log(`Preset "${name}" deleted`);
            } catch (e) {
                log('Delete failed: ' + e.message, 'error');
            }
        };

        const loadPreset = (storeKey, selId, apply) => {
            try {
                const sel = document.getElementById(selId);
                if (!sel || !sel.value) return log('Select a preset to load', 'warning');
                const map = GM_getValue(storeKey, {}) || {};
                const v = map[sel.value];
                if (v == null) return log('Preset not found', 'warning');
                apply(v);
                log(`Preset "${sel.value}" loaded`);
            } catch (e) {
                log('Load failed: ' + e.message, 'error');
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
            loadPreset(STORAGE_KEYS.presetsChains, 'composer-preset-select', v => {
                const chainInput = document.getElementById('chain-json-input');
                if (chainInput) {
                    const str = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
                    chainInput.value = str;
                    try { chainDefinition = JSON.parse(str); } catch { chainDefinition = null; }
                    saveToStorage(STORAGE_KEYS.chainDef, str);
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
                template: (document.getElementById('step-template-input')?.value || document.getElementById('step-prompt-template')?.value || ''),
                elements: document.getElementById('step-template-elements')?.value || '',
                code: document.getElementById('step-js-code')?.value || '',
                url: document.getElementById('step-http-url')?.value || '',
                method: document.getElementById('step-http-method')?.value || 'GET',
                headers: document.getElementById('step-http-headers')?.value || '',
                bodyTemplate: document.getElementById('step-http-body')?.value || ''
            };

            const name = prompt('Enter preset name:');
            if (name) {
                const map = GM_getValue(STORAGE_KEYS.presetsSteps, {}) || {};
                map[name] = stepData;
                GM_setValue(STORAGE_KEYS.presetsSteps, map);
                loadPresetSelects();
            }
        });

        document.getElementById('step-preset-select')?.addEventListener('change', (e) => {
            if (!e.target.value) return;
            try {
                const map = GM_getValue(STORAGE_KEYS.presetsSteps, {}) || {};
                const stepData = map[e.target.value];
                if (!stepData) return;
                if (stepData.type) document.getElementById('step-type-select').value = stepData.type;
                if (stepData.title) document.getElementById('step-title-input').value = stepData.title;
                if (stepData.template) {
                    // Apply to both prompt/template fields as applicable
                    const promptEl = document.getElementById('step-prompt-template');
                    const tmplEl = document.getElementById('step-template-input');
                    if (promptEl) promptEl.value = stepData.template;
                    if (tmplEl) tmplEl.value = stepData.template;
                }
                if (stepData.elements) document.getElementById('step-template-elements').value = stepData.elements;
                if (stepData.code) document.getElementById('step-js-code').value = stepData.code;
                if (stepData.url) document.getElementById('step-http-url').value = stepData.url;
                if (stepData.method) document.getElementById('step-http-method').value = stepData.method;
                if (stepData.headers) document.getElementById('step-http-headers').value = typeof stepData.headers === 'string' ? stepData.headers : JSON.stringify(stepData.headers);
                if (stepData.bodyTemplate) document.getElementById('step-http-body').value = stepData.bodyTemplate;

                // Trigger type change to show/hide appropriate fields
                const typeSelect = document.getElementById('step-type-select');
                if (typeSelect) typeSelect.dispatchEvent(new Event('change'));
            } catch (err) {
                log('Failed to load step preset: ' + err.message, 'error');
            }
        });

        // Add delete step preset button handler
        document.getElementById('delete-step-preset-btn')?.addEventListener('click', () => {
            const select = document.getElementById('step-preset-select');
            if (!select || !select.value) {
                log('Select a preset to delete', 'warning');
                return;
            }

            if (confirm(`Delete preset "${select.value}"?`)) {
                try {
                    const map = GM_getValue(STORAGE_KEYS.presetsSteps, {}) || {};
                    delete map[select.value];
                    GM_setValue(STORAGE_KEYS.presetsSteps, map);
                    loadPresetSelects();
                    log(`Preset "${select.value}" deleted`);
                } catch (e) {
                    log('Delete failed: ' + e.message, 'error');
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
            const selfId = runLockId || (runLockId = `${now}-${Math.random().toString(36).slice(2)}`);
            if (existing) {
                try {
                    const obj = JSON.parse(existing);
                    if (obj && obj.id && obj.ts && now - obj.ts < CONFIG.RUN_LOCK_TTL_MS) {
                        return false; // another tab active
                    }
                } catch { /* treat as stale */ }
            }
            localStorage.setItem(key, JSON.stringify({ id: selfId, ts: now }));
            // heartbeat
            clearInterval(runLockTimer);
            runLockTimer = setInterval(() => {
                try { localStorage.setItem(key, JSON.stringify({ id: selfId, ts: Date.now() })); } catch { }
            }, CONFIG.RUN_LOCK_RENEW_MS);
            window.addEventListener('beforeunload', releaseRunLock);
            return true;
        } catch { return true; }
    };
    const releaseRunLock = () => {
        try { clearInterval(runLockTimer); runLockTimer = null; const key = STORAGE_KEYS.runLockKey; const existing = localStorage.getItem(key); if (existing) { const obj = JSON.parse(existing); if (!obj || obj.id === runLockId) localStorage.removeItem(key); } } catch { }
    };

    const runChainWithBatch = async () => {
        if (!chainDefinition) {
            try { chainDefinition = JSON.parse(document.getElementById('chain-json-input').value || '{}'); } catch { chainDefinition = null; }
        }
        if (!chainDefinition) { log('No chain defined', 'warning'); return; }

        if (!acquireRunLock()) {
            log('Another tab is running automation – aborting to prevent collision', 'error');
            return;
        }

        isProcessing = true; updateStatus('processing');
        try {
            const items = Array.isArray(dynamicElements) ? dynamicElements : [];
            const total = Math.max(1, items.length || 1);
            if (items.length === 0) {
                // Single run with empty item
                await processChain(chainDefinition, { item: null, index: 1, total });
            } else {
                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    updateProgress(i + 1, items.length);
                    log(`🔗 Chain run for item ${i + 1}/${items.length}`);
                    await processChain(chainDefinition, { item, index: i + 1, total: items.length });
                    if (i < items.length - 1) { log(`⏱️ Waiting ${batchWaitTime}ms before next item…`); await sleep(batchWaitTime); }
                }
            }
            log('🏁 Chain batch completed');
        } catch (e) {
            log('Chain error: ' + e.message, 'error');
        } finally {
            releaseRunLock();
            isProcessing = false; updateStatus('idle'); updateProgress(0, 0);
        }
    };

    const resolveEntryStep = (chain) => {
        if (!chain) return null;
        if (chain.entryId) return (chain.steps || []).find(s => s.id === chain.entryId) || null;
        const steps = chain.steps || []; if (!steps.length) return null;
        const referenced = new Set(steps.map(s => s.next).filter(Boolean));
        const first = steps.find(s => !referenced.has(s.id));
        return first || steps[0];
    };

    const processChain = async (chain, baseContext) => {
        const entry = resolveEntryStep(chain);
        if (!entry) throw new Error('Empty chain');
        let step = entry;
        let context = { ...baseContext, lastResponseText: '', chain: {}, steps: {} };

        while (step) {
            log(`➡️ Step ${step.id} (${step.type})`);

            // Create step context with access to all previous step data
            const stepContext = {
                ...context,
                item: context.item,
                index: context.index,
                total: context.total,
                // Add easy access to previous steps via steps.stepId pattern
                steps: context.steps,
                // Legacy compatibility
                chain: context.chain
            };

            if (step.type === 'prompt') {
                // Render template and send
                const msg = processDynamicTemplate(step.template || '', stepContext);
                await typeMessage(msg);
                await sleep(300);
                await sendMessage();
                updateStatus('waiting');
                const respEl = await waitForResponse();
                const resp = extractResponseText(respEl);
                context.lastResponseText = resp;

                // Store step data in multiple formats for easy access
                context.chain[step.id] = { response: resp };
                context.steps[step.id] = {
                    type: 'prompt',
                    response: resp,
                    responseText: resp  // Clear alias
                };

                log(`📩 Step ${step.id} response (${resp.length} chars)`);
                log(`💡 Access this data in next steps with: {steps.${step.id}.response} or {steps.${step.id}.responseText}`);

            } else if (step.type === 'http') {
                const url = processDynamicTemplate(step.url || '', stepContext);
                const method = (step.method || 'GET').toUpperCase();
                let headers = step.headers || {};
                try { if (typeof headers === 'string') headers = JSON.parse(headers); } catch { }
                const body = step.bodyTemplate ? processDynamicTemplate(step.bodyTemplate, stepContext) : undefined;

                const res = await http.request({ method, url, headers, data: body });
                let payload = res.responseText || res.response || '';
                let parsedData = payload;
                try { parsedData = JSON.parse(payload); } catch { /* keep as text */ }

                // Store comprehensive HTTP response data
                const httpData = {
                    status: res.status,
                    statusText: res.statusText || '',
                    data: parsedData,
                    rawText: payload,
                    headers: res.responseHeaders || {},
                    url: url,
                    method: method
                };

                context.chain[step.id] = { http: httpData };
                context.steps[step.id] = {
                    type: 'http',
                    ...httpData
                };

                log(`🌐 HTTP ${method} ${url} → ${res.status}`);
                log(`💡 Access this data with: {steps.${step.id}.data} or {steps.${step.id}.rawText} or {steps.${step.id}.status}`);

            } else if (step.type === 'js') {
                // Make step context available to JavaScript
                const jsContext = {
                    elementData: context.item,
                    index: context.index,
                    total: context.total,
                    steps: context.steps,  // Easy access to all step data
                    lastResponse: context.lastResponseText
                };

                await executeCustomCode(step.code || '', context.lastResponseText || '', jsContext);

                // JS steps don't generate output data by default, but could store in context.steps if needed
                context.steps[step.id] = {
                    type: 'js',
                    executed: true
                };

            } else if (step.type === 'template') {
                // Evaluate elements (JSON array, single object, or function text)
                let arr = [];
                try {
                    arr = await parseDynamicElements(step.elements || '[]');
                } catch { arr = []; }
                if (!Array.isArray(arr) || arr.length === 0) {
                    log('Template step has no elements; sending one prompt with current context');
                    const msg = processDynamicTemplate(step.template || '', stepContext);
                    await typeMessage(msg);
                    await sleep(300);
                    await sendMessage();
                    updateStatus('waiting');
                    const respEl = await waitForResponse();
                    const resp = extractResponseText(respEl);
                    context.lastResponseText = resp;

                    context.chain[step.id] = { response: resp };
                    context.steps[step.id] = {
                        type: 'template',
                        response: resp,
                        responseText: resp,
                        itemCount: 0
                    };
                } else {
                    log(`🧩 Template step expanding ${arr.length} items`);
                    const responses = [];
                    for (let i = 0; i < arr.length; i++) {
                        const child = arr[i];
                        const itemContext = { ...stepContext, item: child, index: i + 1, total: arr.length };
                        const msg = processDynamicTemplate(step.template || '', itemContext);
                        log(`📝 Template item ${i + 1}/${arr.length}: ${clip(msg, 200)}`);
                        await typeMessage(msg);
                        await sleep(300);
                        await sendMessage();
                        updateStatus('waiting');
                        const respEl = await waitForResponse();
                        const resp = extractResponseText(respEl);
                        responses.push({ item: child, response: resp });
                        context.lastResponseText = resp;
                        if (i < arr.length - 1) {
                            log(`⏱️ Waiting ${batchWaitTime}ms before next template item…`);
                            await sleep(batchWaitTime);
                        }
                    }

                    context.chain[step.id] = { responses: responses };
                    context.steps[step.id] = {
                        type: 'template',
                        responses: responses,
                        itemCount: responses.length,
                        lastResponse: responses[responses.length - 1]?.response || ''
                    };
                }

                log(`💡 Access template data with: {steps.${step.id}.responses} or {steps.${step.id}.lastResponse}`);

            } else {
                log(`Unknown step type: ${step.type}`, 'warning');
            }
            step = step.next ? (chain.steps || []).find(s => s.id === step.next) : null;
        }
    };

    // Initialize the script
    const init = () => {
        if (document.getElementById('chatgpt-automation-ui')) {
            return; // Already initialized
        }

        log('Initializing ChatGPT Automation Pro...');

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
