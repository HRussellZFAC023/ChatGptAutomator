
// ==UserScript==
// @name         ChatGPT Automation Pro
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Advanced ChatGPT automation with dynamic templating
// @author       Henry Russell
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @inject-into  content
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
    RUN_LOCK_RENEW_MS: 5000
    };

    // State management
    let isProcessing = false;
    let isLooping = false;
    let currentBatchIndex = 0;
    let dynamicElements = [];
    let lastResponseElement = null;
    let responseObserver = null;
    let isMinimized = false;
    let isDarkMode = false;
    let uiVisible = CONFIG.DEFAULT_VISIBLE;
    let headerObserverStarted = false;
    let batchWaitTime = 2000; // Default wait time between batch items
    let autoRemoveProcessed = true; // Whether to remove processed items from textbox
    let autoScrollLogs = true; // Whether to auto-scroll logs
    let newChatPerItem = false; // Whether to start new chat for each item
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
    let messageInput = null;
    let customCodeInput = null;
    let templateInput = null;
    let dynamicElementsInput = null;
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

            // Fallback: if item is missing and the Dynamic Elements input contains exactly one element,
            // use it so custom code depending on { item } can still run outside Template mode.
            if (!item && dynamicElementsInput && typeof dynamicElementsInput.value === 'string' && dynamicElementsInput.value.trim()) {
                try {
                    const arr = await parseDynamicElements(dynamicElementsInput.value.trim());
                    if (Array.isArray(arr) && arr.length === 1) {
                        item = arr[0];
                        if (index == null) index = 1;
                        if (total == null) total = 1;
                        log('Context fallback applied: using single dynamic element for custom code');
                    } else if (Array.isArray(arr) && arr.length > 1 && CONFIG.DEBUG_MODE) {
                        log('Context note: multiple dynamic elements detected but Template mode is off; no auto-selection applied', 'warning');
                    }
                } catch { /* ignore fallback errors */ }
            }

            // Debug logging to help troubleshoot
            if (CONFIG.DEBUG_MODE) {
                log(`Custom code context: item=${item ? JSON.stringify(item).slice(0, 100) : 'null'}, index=${index}, total=${total}`);
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
                const fn = new Function('response', 'log', 'console', 'item', 'index', 'total', 'http', `return ${code}`);
                result = fn(
                    responseText,
                    (msg, type = 'info') => log(msg, type),
                    console,
                    item,
                    index,
                    total,
                    http
                );
            } else {
                // For regular code, wrap in function as before
                const fn = new Function('response', 'log', 'console', 'item', 'index', 'total', 'http', code);
                result = fn(
                    responseText,
                    (msg, type = 'info') => log(msg, type),
                    console,
                    item,
                    index,
                    total,
                    http
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
        if (dynamicElementsInput && autoRemoveProcessed) {
            try {
                const newValue = JSON.stringify(remainingElements, null, 2);
                dynamicElementsInput.value = newValue;
                // Persist queue text so we can resume after refresh
                GM_setValue(STORAGE_KEYS.dynamicElementsInput, newValue);
                log(`Updated queue: ${remainingElements.length} items remaining`);
            } catch (error) {
                log(`Error updating display: ${error.message}`, 'warning');
            }
        }
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

    // Main automation function with batch processing
    const processMessage = async (message, customCode = '', isTemplate = false) => {
        if (isProcessing && !isLooping) {
            log('⚠️ Already processing a message', 'warning');
            return;
        }

        if (!isLooping) {
            isProcessing = true;
            currentBatchIndex = 0;
        }

        updateStatus('processing');

        try {
            // Build a lightweight queue that can react to mid-batch template edits
            let messagesToProcess = [];
            if (isTemplate && dynamicElements.length > 0) {
                messagesToProcess = dynamicElements.map((element, index) => ({
                    elementData: element,
                    index: index + 1,
                    customCode
                }));
                if (CONFIG.DEBUG_MODE) {
                    log(`🧮 Queue initialized with ${messagesToProcess.length} items`);
                }
            } else {
                messagesToProcess = [{ message, customCode }];
            }

            for (let i = 0; i < messagesToProcess.length; i++) {
                let processedMessage = message;
                const { customCode: code, elementData, index } = messagesToProcess[i];

                updateProgress(i + 1, messagesToProcess.length);

                if (isTemplate) {
                    // Re-read current template so edits mid-batch take effect
                    const currentTemplate = (templateInput && typeof templateInput.value === 'string') ? templateInput.value.trim() : message;
                    processedMessage = processDynamicTemplate(currentTemplate || message, {
                        item: elementData,
                        index: index,
                        total: messagesToProcess.length
                    });
                    log(`📦 Item ${index}/${messagesToProcess.length}`);
                    // Prompt preview
                    log(`📝 Prompt ${index}/${messagesToProcess.length}: ${clip(processedMessage, 300)}`);
                } else {
                    processedMessage = messagesToProcess[i].message;
                    log(`📝 Prompt: ${clip(processedMessage, 300)}`);
                }

                let success = false;
                let retryCount = 0;
                const maxRetries = 3;

                while (!success && retryCount <= maxRetries) {
                    try {
                        if (retryCount > 0) {
                            log(`🔁 Retry attempt ${retryCount}/${maxRetries}${isTemplate ? ` for item ${index}` : ''}`);
                            await sleep(batchWaitTime); // Wait before retry
                        }

                        // Start new chat if option is enabled and not the first item
                        if (newChatPerItem && (i > 0 || retryCount > 0)) {
                            log('🆕 Starting new chat for next item…');
                            const chatSuccess = await startNewChat();
                            if (!chatSuccess) {
                                log('⚠️ Failed to start new chat, continuing in current chat', 'warning');
                            }
                            await sleep(1000); // Additional wait after new chat
                        }

                        // Type the message
                        await typeMessage(processedMessage);
                        await sleep(500);

                        // Send the message
                        await sendMessage();
                        updateStatus('waiting');

                        // Wait for response
                        log('⏳ Waiting for ChatGPT response…');
                        const responseElement = await waitForResponse();
                        const responseText = extractResponseText(responseElement);
                        log(`📩 Response received (${responseText.length} chars)`);
                        log(`📄 ${clip(responseText, 500)}`);

                        // Execute custom code if provided
                        if (code && code.trim() !== '') {
                            if (CONFIG.DEBUG_MODE && isTemplate) {
                                try { log(`🧪 Custom code context i=${index}/${messagesToProcess.length}`); } catch {}
                            }
                            log('⚙️ Executing custom code…');
                            await executeCustomCode(code, responseText, {
                                elementData,
                                index,
                                total: messagesToProcess.length
                            });
                        }

                        // Item processed successfully - remove from queue text if auto-remove is enabled
                        if (isTemplate && autoRemoveProcessed) {
                            const idx = dynamicElements.indexOf(elementData);
                            if (idx >= 0) {
                                dynamicElements.splice(idx, 1);
                                updateDynamicElementsDisplay(dynamicElements);
                            }
                        }

                        log(`${isTemplate ? `✅ Item ${index}` : '✅ Message'} processed successfully`);
                        success = true;

                    } catch (itemError) {
                        retryCount++;
                        const at = isTemplate ? `item ${index} ` : '';
                        log(`❌ Error processing ${at}(attempt ${retryCount}): ${itemError.message}`, 'error');

                        if (retryCount > maxRetries) {
                            if (isTemplate) log(`⏭️ Item ${index} failed after ${maxRetries} retries, skipping…`, 'error');
                        }
                    }
                }

                // Add delay between batch items (user configurable)
                if (i < messagesToProcess.length - 1) {
                    log(`⏱️ Waiting ${batchWaitTime}ms before next item…`);
                    await sleep(batchWaitTime);
                }

                // Check if loop should continue
                if (!isLooping) break;
            }

            updateStatus('complete');
            log('🏁 Batch processing completed');
            updateProgress(0, 0); // Reset progress

        } catch (error) {
            log(`💥 Batch error: ${error.message}`, 'error');
            updateStatus('error');
            updateProgress(0, 0);
        } finally {
            if (!isLooping) {
                isProcessing = false;
                currentBatchIndex = 0;
            }
            setTimeout(() => updateStatus('idle'), 2000);
        }
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
                        <button class="tab-btn active" data-tab="chain">Composer</button>
                        <button class="tab-btn" data-tab="settings">Settings</button>
                    </div>

                    <div class="tab-content active" id="chain-tab">
                        <div class="form-group">
                            <label>Composer Canvas:</label>
                            <div id="chain-canvas" class="chain-canvas">
                                <div class="chain-toolbar">
                                    <button class="btn btn-secondary" id="add-step-btn">Add Step</button>
                                    <button class="btn btn-secondary" id="validate-chain-btn">Validate Chain</button>
                                    <button class="btn btn-primary" id="run-chain-btn">Run Chain</button>
                                </div>
                                <div id="chain-cards" class="chain-cards"></div>
                            </div>
                            <div class="help-text">Visual editor for multi-step workflows. Create templates, automation chains, and custom responses.</div>
                        </div>
                        <div class="form-group">
                            <label for="chain-json-input">Chain JSON (advanced):</label>
                            <div class="code-editor">
                                <textarea id="chain-json-input" rows="6" placeholder='{"entryId":"step-1","steps":[{"id":"step-1","type":"prompt","title":"Create mnemonic","template":"...","next":"step-2"},{"id":"step-2","type":"prompt","title":"Create image prompt","template":"...","next":"step-3"},{"id":"step-3","type":"js","title":"Send to server","code":"// use http.postForm(...)"}]}'></textarea>
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
                        <div class="form-group">
                            <label>Presets:</label>
                            <div class="presets-grid">
                                <div class="preset-block">
                                    <div class="preset-row">
                                        <input type="text" id="preset-name-input" class="settings-input" placeholder="Preset name">
                                    </div>
                                    <div class="preset-row">
                                        <button class="btn btn-secondary" id="save-template-preset-btn">Save Template</button>
                                        <select id="load-template-select" class="settings-input"></select>
                                        <button class="btn btn-primary" id="load-template-preset-btn">Load</button>
                                        <button class="btn btn-danger" id="delete-template-preset-btn">Delete</button>
                                    </div>
                                    <div class="preset-row">
                                        <button class="btn btn-secondary" id="save-chain-preset-btn">Save Chain</button>
                                        <select id="load-chain-select" class="settings-input"></select>
                                        <button class="btn btn-primary" id="load-chain-preset-btn">Load</button>
                                        <button class="btn btn-danger" id="delete-chain-preset-btn">Delete</button>
                                    </div>
                                    <div class="preset-row">
                                        <button class="btn btn-secondary" id="save-js-preset-btn">Save Response JS</button>
                                        <select id="load-js-select" class="settings-input"></select>
                                        <button class="btn btn-primary" id="load-js-preset-btn">Load</button>
                                        <button class="btn btn-danger" id="delete-js-preset-btn">Delete</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="form-actions">
                        <button id="send-btn" class="btn btn-primary">
                            <span class="btn-text">Send Message</span>
                            <span class="btn-loader" style="display: none;">
                                <div class="spinner"></div>
                            </span>
                        </button>
                        <button id="clear-btn" class="btn btn-secondary">Clear</button>
                        <button id="toggle-log-btn" class="btn btn-secondary">Toggle Log</button>
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
                        <button class="header-btn" id="close-step-modal-btn" aria-label="Close">✕</button>
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
                                <option value="prompt">prompt</option>
                                <option value="http">http</option>
                                <option value="js">js</option>
                                <option value="subbatch">subbatch</option>
                            </select>
                        </div>
                        <div class="form-group" data-field="template">
                            <label for="step-template-input">Template</label>
                            <textarea id="step-template-input" rows="4" class="settings-input" placeholder="Message template (supports {item.*})"></textarea>
                        </div>
                        <div class="form-group" data-field="http">
                            <label>HTTP</label>
                            <input id="step-http-url" class="settings-input" placeholder="https://...">
                            <div style="display:flex; gap:8px; margin-top:6px;">
                                <select id="step-http-method" class="settings-input"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>
                                <input id="step-http-headers" class="settings-input" placeholder='{"Content-Type":"application/json"}'>
                            </div>
                            <textarea id="step-http-body" rows="3" class="settings-input" placeholder="Body template (optional)"></textarea>
                        </div>
                        <div class="form-group" data-field="code">
                            <label for="step-js-code">JS Code</label>
                            <textarea id="step-js-code" rows="6" class="settings-input" placeholder="// code has access to response, item, index, total, http, log"></textarea>
                        </div>
                        <div class="form-group" data-field="subbatch">
                            <label for="step-subbatch-path">Sub-batch source path (in context)</label>
                            <input id="step-subbatch-path" class="settings-input" placeholder="e.g., item.parts or results[]">
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
                /* Fill space under header and allow log to manage its own scrolling */
                height: calc(100% - 60px);
                display: flex;
                flex-direction: column;
            }
            #chatgpt-automation-ui.minimized .progress-container,
            #chatgpt-automation-ui.minimized .automation-form {
                display: none;
            }
            #chatgpt-automation-ui.minimized .automation-log {
                display: flex !important;
                flex-direction: column;
                height: 100%;
            }
            #chatgpt-automation-ui.minimized #log-container {
                max-height: 48px;
                overflow: hidden;
            }
            #chatgpt-automation-ui.minimized .log-content {
                /* Let logs fill available space and scroll internally */
                flex: 1 1 auto;
                overflow-y: auto;
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
                max-height: calc(100% - 60px);
                display: flex;
                flex-direction: column;
                overflow: hidden;
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
                flex: 1 1 auto;
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
                max-height: 220px;
                min-height: 120px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
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
                padding: 16px 16px 36px; /* extra bottom padding so last line stays visible */
                overflow-y: auto;
                scroll-behavior: smooth;
                flex: 1 1 auto;
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
            }
            #chatgpt-automation-ui .chain-toolbar { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
            #chatgpt-automation-ui .chain-cards { display:flex; gap:8px; flex-wrap:wrap; align-items:flex-start; }
            #chatgpt-automation-ui .chain-card { background: var(--surface-secondary, #f8fafc); border:1px solid var(--border-light, rgba(0,0,0,0.06)); border-radius:8px; padding:8px; min-width:140px; max-width:200px; position:relative; }
            #chatgpt-automation-ui.dark-mode .chain-card { background: var(--surface-secondary, #1e1e20); border-color: var(--border-light, rgba(255,255,255,0.06)); }
            #chatgpt-automation-ui .chain-card .title { font-weight:600; font-size:12px; margin-bottom:4px; }
            #chatgpt-automation-ui .chain-card .meta { font-size:11px; opacity:0.8; margin-bottom:6px; }
            #chatgpt-automation-ui .chain-card .actions { display:flex; gap:6px; }

            /* Empty state for chain cards */
            #chatgpt-automation-ui .chain-empty-state {
                border: 2px dashed var(--border-light, rgba(0,0,0,0.2));
                border-radius: 8px;
                padding: 32px 16px;
                margin: 8px 0;
                text-align: center;
                background: var(--input-background, rgba(0,0,0,0.02));
                min-height: 120px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #chatgpt-automation-ui.dark-mode .chain-empty-state {
                border-color: var(--border-light, rgba(255,255,255,0.2));
                background: var(--input-background, rgba(255,255,255,0.02));
            }
            #chatgpt-automation-ui .empty-content {
                max-width: 240px;
            }
            #chatgpt-automation-ui .empty-icon {
                font-size: 28px;
                margin-bottom: 12px;
                opacity: 0.6;
            }
            #chatgpt-automation-ui .empty-title {
                font-size: 16px;
                font-weight: 600;
                margin-bottom: 8px;
                color: var(--text-primary, #374151);
            }
            #chatgpt-automation-ui.dark-mode .empty-title {
                color: var(--text-primary, #f9fafb);
            }
            #chatgpt-automation-ui .empty-description {
                font-size: 13px;
                color: var(--text-secondary, #6b7280);
                margin-bottom: 16px;
                line-height: 1.4;
            }

            /* Modal */
            #chatgpt-automation-ui .chain-modal { position: fixed; inset:0; z-index:10001; }
            #chatgpt-automation-ui .chain-modal-backdrop { position:absolute; inset:0; background: rgba(0,0,0,0.3); }
            #chatgpt-automation-ui .chain-modal-dialog { position:relative; background: var(--main-surface-primary, #fff); width: 520px; max-width: calc(100% - 32px); margin: 40px auto; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.2); overflow:hidden; }
            #chatgpt-automation-ui.dark-mode .chain-modal-dialog { background: var(--main-surface-primary, #2d2d30); }
            #chatgpt-automation-ui .chain-modal-header { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid var(--border-light, rgba(0,0,0,0.06)); }
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
        messageInput = document.getElementById('message-input');
        customCodeInput = document.getElementById('custom-code-input');
        templateInput = document.getElementById('template-input');
        dynamicElementsInput = document.getElementById('dynamic-elements-input');
        statusIndicator = document.getElementById('status-indicator');
    logContainer = document.querySelector('.log-content');
        progressBar = document.getElementById('progress-container');
        resizeHandle = document.getElementById('resize-handle');

    // Restore saved inputs, toggles and config
        try {
            // Textareas
            messageInput.value = GM_getValue(STORAGE_KEYS.messageInput, '') || '';
            templateInput.value = GM_getValue(STORAGE_KEYS.templateInput, '') || '';
            const savedDyn = GM_getValue(STORAGE_KEYS.dynamicElementsInput, '');
            if (typeof savedDyn === 'string') dynamicElementsInput.value = savedDyn;
            customCodeInput.value = GM_getValue(STORAGE_KEYS.customCodeInput, '') || '';

            // Checkboxes and switches
            const loopEl = document.getElementById('loop-checkbox');
            const autoRemoveEl = document.getElementById('auto-remove-checkbox');
            const newChatEl = document.getElementById('new-chat-checkbox');

            if (loopEl) {
                loopEl.checked = !!GM_getValue(STORAGE_KEYS.loop, false);
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
            const savedTab = GM_getValue(STORAGE_KEYS.activeTab, 'chain');
            const tabBtn = document.querySelector(`.tab-btn[data-tab="${savedTab}"]`);
            if (tabBtn) tabBtn.click();

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
        if (typeof savedState.visible === 'boolean') {
            uiVisible = savedState.visible;
        }
        // Default hidden based on persisted/CONFIG
        if (!uiVisible) {
            mainContainer.style.display = 'none';
        }

        // Restore persisted log history
        try {
            const hist = GM_getValue(STORAGE_KEYS.logHistory, []);
            if (Array.isArray(hist) && hist.length && logContainer) {
                hist.slice(-200).forEach(h => {
                    const div = document.createElement('div');
                    div.className = `log-entry log-${h.type||'info'}`;
                    div.textContent = h.msg;
                    logContainer.appendChild(div);
                });
                logContainer.scrollTop = logContainer.scrollHeight;
            }
        } catch {}

        // Bind events
        bindEvents();

        // Initialize auto-scroll button state
        const autoScrollBtn = document.getElementById('toggle-auto-scroll-btn');
        if (autoScrollBtn) {
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
        const shouldShow = savedState.visible === true || CONFIG.DEFAULT_VISIBLE;
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
                const shouldShow = savedState.visible === true || CONFIG.DEFAULT_VISIBLE;
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

        try {
            // Get the automation content container
            const contentContainer = document.querySelector('#automation-content');
            if (!contentContainer) return;

            // Temporarily remove height constraints to measure natural height
            const originalHeight = mainContainer.style.height;
            const originalMaxHeight = mainContainer.style.maxHeight;

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

    // Send button
        document.getElementById('send-btn').addEventListener('click', async () => {
            const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
            const sendBtn = document.getElementById('send-btn');
            const btnText = sendBtn.querySelector('.btn-text');
            const btnLoader = sendBtn.querySelector('.btn-loader');

            let message = '';
            let customCode = customCodeInput.value.trim();
            let isTemplate = false;

            if (activeTab === 'simple') {
                message = messageInput.value.trim();
            } else if (activeTab === 'template') {
                message = templateInput.value.trim();
                isTemplate = true;

                // Parse dynamic elements
                const elementsInput = dynamicElementsInput.value.trim();
                if (elementsInput) {
                    dynamicElements = await parseDynamicElements(elementsInput);
                    if (!Array.isArray(dynamicElements) || dynamicElements.length === 0) {
                        log('No valid dynamic elements found', 'warning');
                        return;
                    }
                }

                // Check if batch processing is enabled
                isLooping = document.getElementById('loop-checkbox').checked;
                if (isLooping) {
                    document.getElementById('stop-batch-btn').style.display = 'inline-block';
                }
            } else if (activeTab === 'chain') {
                // Run the chain using dynamic elements as batch context
                const chainInput = document.getElementById('chain-json-input');
                try {
                    const chain = JSON.parse(chainInput.value.trim());
                    chainDefinition = chain;
                    saveToStorage(STORAGE_KEYS.chainDef, chainInput.value.trim());
                } catch (e) {
                    log('Invalid Chain JSON: ' + e.message, 'error');
                    return;
                }

                // Parse dynamic elements
                const elementsInput = dynamicElementsInput.value.trim();
                if (elementsInput) {
                    dynamicElements = await parseDynamicElements(elementsInput);
                } else {
                    dynamicElements = [];
                }

                await runChainWithBatch();
                return; // handled by chain engine
            } else {
                message = messageInput.value.trim() || templateInput.value.trim();
            }

            if (!message) {
                log('Please enter a message', 'warning');
                return;
            }

            // Update button state
            sendBtn.disabled = true;
            btnText.style.display = 'none';
            btnLoader.style.display = 'inline-flex';

            try {
                await processMessage(message, customCode, isTemplate);
            } finally {
                sendBtn.disabled = false;
                btnText.style.display = 'inline';
                btnLoader.style.display = 'none';

                if (!isLooping) {
                    document.getElementById('stop-batch-btn').style.display = 'none';
                }
            }
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

        // Clear button
        document.getElementById('clear-btn').addEventListener('click', () => {
            messageInput.value = '';
            customCodeInput.value = '';
            templateInput.value = '';
            dynamicElementsInput.value = '';
            document.getElementById('loop-checkbox').checked = false;
            log('Form cleared');

            // Persist cleared state
            try {
                GM_setValue(STORAGE_KEYS.messageInput, '');
                GM_setValue(STORAGE_KEYS.customCodeInput, '');
                GM_setValue(STORAGE_KEYS.templateInput, '');
                GM_setValue(STORAGE_KEYS.dynamicElementsInput, '');
                GM_setValue(STORAGE_KEYS.loop, false);
            } catch { }
        });

        // Toggle log button
        document.getElementById('toggle-log-btn').addEventListener('click', () => {
            const logElement = document.getElementById('log-container');
            // Instead of fully hiding, toggle between compact and expanded heights
            const compact = logElement.dataset.compact === 'true';
            logElement.dataset.compact = (!compact).toString();
            if (compact) {
                logElement.style.maxHeight = '220px';
                log('Log expanded');
            } else {
                logElement.style.maxHeight = '120px';
                log('Log compact');
            }

            // Auto-resize container after log visibility change
            setTimeout(() => autoResizeContainer(), 100);
        });

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

    // Minimize button: compact the panel's height when minimized and restore on un-minimize
        let _previousHeight = null;
        document.getElementById('minimize-btn').addEventListener('click', () => {
            isMinimized = !isMinimized;
            if (isMinimized) {
                // Save previous explicit height if present
                _previousHeight = mainContainer.style.height || null;
                mainContainer.classList.add('minimized');
                // Set a compact height so logs become smaller
                mainContainer.style.height = '120px';
                // Ensure log area remains usable but small
                const logCont = document.querySelector('#log-container');
                if (logCont) logCont.style.maxHeight = '48px';
            } else {
                mainContainer.classList.remove('minimized');
                // Restore previous height or auto-resize
                if (_previousHeight) {
                    mainContainer.style.height = _previousHeight;
                } else {
                    mainContainer.style.height = '';
                    setTimeout(() => autoResizeContainer(), 100);
                }
                const logCont = document.querySelector('#log-container');
                if (logCont) logCont.style.maxHeight = '';
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

        // Tool buttons
        document.getElementById('format-json-btn').addEventListener('click', () => {
            try {
                const input = dynamicElementsInput.value.trim();
                if (input.startsWith('[')) {
                    const parsed = JSON.parse(input);
                    dynamicElementsInput.value = JSON.stringify(parsed, null, 2);
                    log('JSON formatted');
                    saveToStorage(STORAGE_KEYS.dynamicElementsInput, dynamicElementsInput.value);
                }
            } catch (error) {
                log('Invalid JSON format', 'warning');
            }
        });

        document.getElementById('validate-elements-btn').addEventListener('click', async () => {
            const elements = await parseDynamicElements(dynamicElementsInput.value.trim());
            if (Array.isArray(elements) && elements.length > 0) {
                log(`Valid! Found ${elements.length} elements: ${JSON.stringify(elements.slice(0, 3))}${elements.length > 3 ? '...' : ''}`, 'info');
            } else {
                log('No valid elements found', 'warning');
            }
        });

        // Template tab JS check and snippet
        const elSyntaxBtn = document.getElementById('elements-syntax-check-btn');
        if (elSyntaxBtn) {
            elSyntaxBtn.addEventListener('click', async () => {
                const code = dynamicElementsInput.value.trim();
                if (!code) return log('Nothing to check', 'warning');
                try {
                    // Attempt to parse expression in userscript context
                    new Function('return ( ' + code + ' )');
                    log('Dynamic elements JS syntax is valid', 'info');
                } catch (err) {
                    log(`Syntax error: ${err.message}`, 'error');
                }
            });
        }
        const elSnippetBtn = document.getElementById('elements-insert-fn-btn');
        if (elSnippetBtn) {
            elSnippetBtn.addEventListener('click', () => {
                const sample = `() => [
  { name: "soup", orderId: "123" },
  { name: "salad", orderId: "124" }
]`;
                dynamicElementsInput.value = sample;
                log('Inserted sample dynamic elements function');
            });
        }

        document.getElementById('syntax-check-btn').addEventListener('click', async () => {
            try {
                new Function(customCodeInput.value);
                log('Syntax is valid', 'info');
            } catch (error) {
                log(`Syntax error: ${error.message}`, 'error');
            }
        });

        document.getElementById('insert-template-btn').addEventListener('click', () => {
            const template = `// Example custom code template
if (response.includes('error')) {
    log('Detected error in response', 'warning');
} else {
    log('Response looks good: ' + response.length + ' characters');

    // Extract specific information
    const matches = response.match(/\\d+/g);
    if (matches) {
        log('Found numbers: ' + matches.join(', '));
    }
}`;
            customCodeInput.value = template;
            try { GM_setValue(STORAGE_KEYS.customCodeInput, customCodeInput.value); } catch { }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + Enter to send
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                if ([messageInput, customCodeInput, templateInput, dynamicElementsInput].includes(document.activeElement)) {
                    document.getElementById('send-btn').click();
                    e.preventDefault();
                }
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

        // Consolidated input persistence
        const persistInputs = [
            { element: messageInput, key: STORAGE_KEYS.messageInput },
            { element: templateInput, key: STORAGE_KEYS.templateInput },
            { element: dynamicElementsInput, key: STORAGE_KEYS.dynamicElementsInput },
            { element: customCodeInput, key: STORAGE_KEYS.customCodeInput }
        ];

        persistInputs.forEach(({ element, key }) => {
            element.addEventListener('input', () => saveToStorage(key, element.value));
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
            log(`Default visibility ${CONFIG.DEFAULT_VISIBLE ? 'ON' : 'OFF'}`);
        });

        // Chain UI: basic actions
        const chainInput = document.getElementById('chain-json-input');
        const chainCards = document.getElementById('chain-cards');
        const refreshChainCards = () => {
            if (!chainCards) return;
            chainCards.innerHTML = '';
            let chain;
            try { chain = JSON.parse(chainInput.value || '{}'); } catch { chain = null; }
            if (!chain || !Array.isArray(chain.steps) || chain.steps.length === 0) {
                // Show empty state with dotted border and prominent add button
                const emptyState = document.createElement('div');
                emptyState.className = 'chain-empty-state';
                emptyState.innerHTML = `
                    <div class="empty-content">
                        <div class="empty-icon">📝</div>
                        <div class="empty-title">Start building your workflow</div>
                        <div class="empty-description">Create templates, automation chains, and custom responses</div>
                        <button class="btn btn-primary" id="add-first-step-btn">Add First Step</button>
                    </div>
                `;
                emptyState.querySelector('#add-first-step-btn').addEventListener('click', () => {
                    let chain;
                    try { chain = JSON.parse(chainInput.value || '{}'); } catch { chain = {}; }
                    if (!chain.steps) chain.steps = [];
                    const id = `step-${(chain.steps.length||0)+1}`;
                    chain.steps.push({ id, title: `Step ${chain.steps.length+1}`, type: 'prompt', template: '' });
                    if (!chain.entryId) chain.entryId = id;
                    chainInput.value = JSON.stringify(chain, null, 2);
                    saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
                    refreshChainCards();
                    openStepEditor(id);
                });
                chainCards.appendChild(emptyState);
                return;
            }
            chain.steps.forEach(step => {
                const card = document.createElement('div');
                card.className = 'chain-card';
                card.dataset.stepId = step.id;
                card.innerHTML = `
                    <div class="title">${step.title || step.id || '(untitled)'} </div>
                    <div class="meta">type: ${step.type}${step.next ? ` → ${step.next}` : ''}</div>
                    <div class="actions">
                        <button class="btn btn-secondary btn-sm" data-action="edit">Edit</button>
                        <button class="btn btn-danger btn-sm" data-action="delete">Delete</button>
                    </div>
                `;
                card.querySelector('[data-action="edit"]').addEventListener('click', () => openStepEditor(step.id));
                card.querySelector('[data-action="delete"]').addEventListener('click', () => {
                    if (confirm(`Delete step "${step.title || step.id}"?`)) {
                        chain.steps = chain.steps.filter(s => s.id !== step.id);
                        // Remove references
                        chain.steps.forEach(s => { if (s.next === step.id) s.next = ''; });
                        chainInput.value = JSON.stringify(chain, null, 2);
                        saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
                        refreshChainCards();
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
            document.getElementById('step-template-input').value = step.template || '';
            document.getElementById('step-http-url').value = step.url || '';
            document.getElementById('step-http-method').value = (step.method || 'GET').toUpperCase();
            document.getElementById('step-http-headers').value = step.headers ? JSON.stringify(step.headers) : '';
            document.getElementById('step-http-body').value = step.bodyTemplate || '';
            document.getElementById('step-js-code').value = step.code || '';
            document.getElementById('step-subbatch-path').value = step.path || '';
            const nextSel = document.getElementById('step-next-select');
            nextSel.innerHTML = '<option value="">(end)</option>';
            (chain.steps||[]).forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id; opt.textContent = s.id; if (step.next === s.id) opt.selected = true; nextSel.appendChild(opt);
            });

            const onTypeChange = () => {
                const type = document.getElementById('step-type-select').value;
                // Toggle field groups
                modal.querySelectorAll('[data-field="template"]').forEach(el => el.style.display = type === 'prompt' ? 'block' : 'none');
                modal.querySelectorAll('[data-field="http"]').forEach(el => el.style.display = type === 'http' ? 'block' : 'none');
                modal.querySelectorAll('[data-field="code"]').forEach(el => el.style.display = type === 'js' ? 'block' : 'none');
                modal.querySelectorAll('[data-field="subbatch"]').forEach(el => el.style.display = type === 'subbatch' ? 'block' : 'none');
            };
            document.getElementById('step-type-select').onchange = onTypeChange;
            onTypeChange();

            const saveBtn = document.getElementById('save-step-btn');
            const deleteBtn = document.getElementById('delete-step-btn');
            const closeBtn = document.getElementById('close-step-modal-btn');

            const closeModal = () => { modal.style.display = 'none'; modal.setAttribute('aria-hidden','true'); };
            closeBtn.onclick = closeModal;

            deleteBtn.onclick = () => {
                chain.steps = chain.steps.filter(s => s.id !== step.id);
                // Remove references
                chain.steps.forEach(s => { if (s.next === step.id) s.next = ''; });
                chainInput.value = JSON.stringify(chain, null, 2);
                saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
                refreshChainCards();
                closeModal();
            };

            saveBtn.onclick = () => {
                const newId = document.getElementById('step-id-input').value.trim() || step.id;
                step.id = newId;
                step.title = document.getElementById('step-title-input').value.trim();
                step.type = document.getElementById('step-type-select').value;
                step.template = document.getElementById('step-template-input').value;
                step.url = document.getElementById('step-http-url').value.trim();
                step.method = document.getElementById('step-http-method').value.trim();
                step.headers = (()=>{ try{ const v = document.getElementById('step-http-headers').value.trim(); return v? JSON.parse(v): undefined;}catch{return undefined;}})();
                step.bodyTemplate = document.getElementById('step-http-body').value;
                step.code = document.getElementById('step-js-code').value;
                step.path = document.getElementById('step-subbatch-path').value.trim();
                step.next = document.getElementById('step-next-select').value;
                chainInput.value = JSON.stringify(chain, null, 2);
                saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
                refreshChainCards();
                closeModal();
            };
        };

        const addStepBtn = document.getElementById('add-step-btn');
        if (addStepBtn) addStepBtn.addEventListener('click', () => {
            let chain;
            try { chain = JSON.parse(chainInput.value || '{}'); } catch { chain = {}; }
            if (!chain.steps) chain.steps = [];
            const id = `step-${(chain.steps.length||0)+1}`;
            chain.steps.push({ id, title: `Step ${chain.steps.length+1}`, type: 'prompt', template: '' });
            if (!chain.entryId) chain.entryId = id;
            chainInput.value = JSON.stringify(chain, null, 2);
            saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);
            refreshChainCards();
            openStepEditor(id);
        });

        const validateChainBtn = document.getElementById('validate-chain-btn');
        if (validateChainBtn) validateChainBtn.addEventListener('click', () => {
            try {
                const c = JSON.parse(chainInput.value || '{}');
                if (!c.entryId) throw new Error('Missing entryId');
                if (!Array.isArray(c.steps) || !c.steps.length) throw new Error('No steps');
                const ids = new Set(c.steps.map(s=>s.id));
                if (!ids.has(c.entryId)) throw new Error('entryId not found among steps');
                c.steps.forEach(s=>{ if (s.next && !ids.has(s.next)) throw new Error(`Step ${s.id} next '${s.next}' not found`); });
                log('Chain valid');
            } catch (e) { log('Chain invalid: ' + e.message, 'error'); }
        });

        const runChainBtn = document.getElementById('run-chain-btn');
        if (runChainBtn) runChainBtn.addEventListener('click', async () => {
            // Mirror Send button behavior for chain
            const elementsInput = dynamicElementsInput.value.trim();
            if (elementsInput) dynamicElements = await parseDynamicElements(elementsInput);
            else dynamicElements = [];
            await runChainWithBatch();
        });

        const formatChainBtn = document.getElementById('format-chain-json-btn');
        if (formatChainBtn) formatChainBtn.addEventListener('click', () => {
            try { const obj = JSON.parse(chainInput.value); chainInput.value = JSON.stringify(obj, null, 2); log('Chain JSON formatted'); saveToStorage(STORAGE_KEYS.chainDef, chainInput.value);} catch(e){ log('Invalid JSON: ' + e.message, 'error'); }
        });

        // Change events to keep cards in sync
        if (chainInput) chainInput.addEventListener('input', () => { refreshChainCards(); });
        refreshChainCards();

        // Presets: populate selects and wire buttons
        const loadPresetSelects = () => {
            const fill = (id, map) => { const sel = document.getElementById(id); if (!sel) return; sel.innerHTML = ''; Object.keys(map||{}).sort().forEach(name=>{ const o=document.createElement('option'); o.value=name; o.textContent=name; sel.appendChild(o); }); };
            try {
                fill('load-template-select', GM_getValue(STORAGE_KEYS.presetsTemplates, {}));
                fill('load-chain-select', GM_getValue(STORAGE_KEYS.presetsChains, {}));
                fill('load-js-select', GM_getValue(STORAGE_KEYS.presetsResponseJS, {}));
            } catch { }
        };
        const getPresetName = () => (document.getElementById('preset-name-input')?.value||'').trim();
        const savePreset = (storeKey, name, value) => {
            if (!name) return log('Enter a preset name', 'warning');
            try { const map = GM_getValue(storeKey, {}) || {}; map[name] = value; GM_setValue(storeKey, map); loadPresetSelects(); log('Preset saved'); } catch(e){ log('Save failed: '+e.message, 'error'); }
        };
        const deletePreset = (storeKey, selId) => {
            try { const sel = document.getElementById(selId); if(!sel||!sel.value) return; const map = GM_getValue(storeKey, {}) || {}; delete map[sel.value]; GM_setValue(storeKey, map); loadPresetSelects(); log('Preset deleted'); } catch(e){ log('Delete failed: '+e.message, 'error'); }
        };
        const loadPreset = (storeKey, selId, apply) => {
            try { const sel = document.getElementById(selId); const map = GM_getValue(storeKey, {}) || {}; const v = map[sel.value]; if (v==null) return; apply(v); log('Preset loaded'); } catch(e){ log('Load failed: '+e.message, 'error'); }
        };
        loadPresetSelects();
        document.getElementById('save-template-preset-btn')?.addEventListener('click', ()=> savePreset(STORAGE_KEYS.presetsTemplates, getPresetName(), templateInput.value||''));
        document.getElementById('load-template-preset-btn')?.addEventListener('click', ()=> loadPreset(STORAGE_KEYS.presetsTemplates, 'load-template-select', v=>{ templateInput.value=v; saveToStorage(STORAGE_KEYS.templateInput, v);}));
        document.getElementById('delete-template-preset-btn')?.addEventListener('click', ()=> deletePreset(STORAGE_KEYS.presetsTemplates, 'load-template-select'));
        document.getElementById('save-chain-preset-btn')?.addEventListener('click', ()=> savePreset(STORAGE_KEYS.presetsChains, getPresetName(), document.getElementById('chain-json-input').value||''));
        document.getElementById('load-chain-preset-btn')?.addEventListener('click', ()=> loadPreset(STORAGE_KEYS.presetsChains, 'load-chain-select', v=>{ document.getElementById('chain-json-input').value=v; saveToStorage(STORAGE_KEYS.chainDef, v); }));
        document.getElementById('delete-chain-preset-btn')?.addEventListener('click', ()=> deletePreset(STORAGE_KEYS.presetsChains, 'load-chain-select'));
        document.getElementById('save-js-preset-btn')?.addEventListener('click', ()=> savePreset(STORAGE_KEYS.presetsResponseJS, getPresetName(), customCodeInput.value||''));
        document.getElementById('load-js-preset-btn')?.addEventListener('click', ()=> loadPreset(STORAGE_KEYS.presetsResponseJS, 'load-js-select', v=>{ customCodeInput.value=v; saveToStorage(STORAGE_KEYS.customCodeInput, v);}));
        document.getElementById('delete-js-preset-btn')?.addEventListener('click', ()=> deletePreset(STORAGE_KEYS.presetsResponseJS, 'load-js-select'));
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
                try { localStorage.setItem(key, JSON.stringify({ id: selfId, ts: Date.now() })); } catch {}
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
            try { chainDefinition = JSON.parse(document.getElementById('chain-json-input').value||'{}'); } catch { chainDefinition = null; }
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
                    updateProgress(i+1, items.length);
                    log(`🔗 Chain run for item ${i+1}/${items.length}`);
                    await processChain(chainDefinition, { item, index: i+1, total: items.length });
                    if (i < items.length - 1) { log(`⏱️ Waiting ${batchWaitTime}ms before next item…`); await sleep(batchWaitTime); }
                }
            }
            log('🏁 Chain batch completed');
        } catch (e) {
            log('Chain error: ' + e.message, 'error');
        } finally {
            releaseRunLock();
            isProcessing = false; updateStatus('idle'); updateProgress(0,0);
        }
    };

    const resolveEntryStep = (chain) => {
        if (!chain) return null;
        if (chain.entryId) return (chain.steps||[]).find(s=>s.id===chain.entryId) || null;
        const steps = chain.steps||[]; if (!steps.length) return null;
        const referenced = new Set(steps.map(s=>s.next).filter(Boolean));
        const first = steps.find(s=>!referenced.has(s.id));
        return first || steps[0];
    };

    const processChain = async (chain, baseContext) => {
        const entry = resolveEntryStep(chain);
        if (!entry) throw new Error('Empty chain');
        let step = entry;
        let context = { ...baseContext, lastResponseText: '', chain: { } };

        while (step) {
            log(`➡️ Step ${step.id} (${step.type})`);
            if (step.type === 'prompt') {
                // Render template and send
                const msg = processDynamicTemplate(step.template||'', { ...context, item: context.item, index: context.index, total: context.total });
                await typeMessage(msg);
                await sleep(300);
                await sendMessage();
                updateStatus('waiting');
                const respEl = await waitForResponse();
                const resp = extractResponseText(respEl);
                context.lastResponseText = resp;
                context.chain[step.id] = { response: resp };
                log(`📩 Step ${step.id} response (${resp.length} chars)`);
            } else if (step.type === 'http') {
                const url = processDynamicTemplate(step.url||'', context);
                const method = (step.method||'GET').toUpperCase();
                let headers = step.headers || {};
                try { if (typeof headers === 'string') headers = JSON.parse(headers); } catch {}
                const body = step.bodyTemplate ? processDynamicTemplate(step.bodyTemplate, context) : undefined;
                const res = await http.request({ method, url, headers, data: body });
                let payload = res.responseText || res.response || '';
                try { const j = JSON.parse(payload); payload = j; } catch { /* keep as text */ }
                context.chain[step.id] = { http: { status: res.status, data: payload } };
                log(`🌐 HTTP ${method} ${url} → ${res.status}`);
            } else if (step.type === 'js') {
                await executeCustomCode(step.code||'', context.lastResponseText || '', { elementData: context.item, index: context.index, total: context.total });
            } else if (step.type === 'subbatch') {
                // Expand items from a path in context
                const getByPath = (obj, path) => { try { return path.split('.').reduce((a,p)=> a!=null ? a[p.replace(/\[|\]/g,'')] : undefined, obj); } catch { return undefined; } };
                const arr = getByPath(context, step.path||'') || [];
                if (Array.isArray(arr) && arr.length) {
                    for (let i=0;i<arr.length;i++) {
                        const child = arr[i];
                        log(`🧩 Sub-batch ${i+1}/${arr.length} via ${step.path}`);
                        await processChain({ entryId: chain.entryId, steps: chain.steps }, { ...context, item: child, index: i+1, total: arr.length });
                    }
                } else {
                    log(`Sub-batch path yielded no items: ${step.path||'(none)'}
                    `,'warning');
                }
            } else {
                log(`Unknown step type: ${step.type}`, 'warning');
            }
            step = step.next ? (chain.steps||[]).find(s=>s.id===step.next) : null;
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

    // Export for external access
    window.ChatGPTAutomation = {
        processMessage,
        stopBatchProcessing,
        log,
        updateStatus,
        CONFIG,
        toggleUI: () => {
            if (mainContainer) {
                const show = mainContainer.style.display === 'none';
                mainContainer.style.display = show ? 'block' : 'none';
                uiVisible = show;
                saveUIState(true); // Immediate save for user action
            }
        },
        show: () => {
            if (mainContainer) {
                mainContainer.style.display = 'block';
                uiVisible = true;
                saveUIState(true); // Immediate save for user action
            }
        },
        hide: () => {
            if (mainContainer) {
                mainContainer.style.display = 'none';
                uiVisible = false;
                saveUIState(true); // Immediate save for user action
            }
        }
    };

})();
