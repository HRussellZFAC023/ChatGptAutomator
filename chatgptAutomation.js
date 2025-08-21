// ==UserScript==
// @name         ChatGPT Automation Pro
// @namespace    http://tampermonkey.net/
// @version      1.1
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
// ==/UserScript==

(function () {
    'use strict';

    // Configuration
    const CONFIG = {
        DEBUG_MODE: true,
        RESPONSE_TIMEOUT: 3000000, // 5 minutes
        MIN_WIDTH: 300,
        MIN_HEIGHT: 200,
        MAX_WIDTH: 600,
        MAX_HEIGHT: 800,
        DEFAULT_VISIBLE: false
    };

    // State management
    let isProcessing = false;
    let isLooping = false;
    let currentBatchIndex = 0;
    let dynamicElements = [];
    let failedElements = []; // Queue for failed items
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
            
            // Auto-scroll logs if enabled
            if (autoScrollLogs) {
                logContainer.scrollTop = logContainer.scrollHeight;
            }

            // Keep only last 50 log entries
            while (logContainer.children.length > 50) {
                logContainer.removeChild(logContainer.firstChild);
            }
        }
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
                .map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
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
                log(`Custom code context: item=${item ? JSON.stringify(item).slice(0,100) : 'null'}, index=${index}, total=${total}`);
            }

            const fn = new Function('response', 'log', 'console', 'item', 'index', 'total', 'http', code);
            await Promise.resolve(fn(
                responseText,
                (msg, type = 'info') => log(msg, type),
                console,
                item,
                index,
                total,
                http
            ));
            log('Custom code executed successfully');
        } catch (error) {
            log(`Custom code execution error: ${error.message}`, 'error');
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

    // Save UI state
    const saveUIState = () => {
        const state = {
            position: {
                left: mainContainer.style.left,
                top: mainContainer.style.top,
                right: mainContainer.style.right
            },
            size: {
                width: mainContainer.style.width,
                height: mainContainer.style.height
            },
            minimized: isMinimized,
            visible: uiVisible
        };
        GM_setValue('uiState', JSON.stringify(state));
    };

    // Load UI state
    const loadUIState = () => {
        try {
            const savedState = GM_getValue('uiState', null);
            if (savedState) {
                return JSON.parse(savedState);
            }
        } catch (error) {
            log('Error loading UI state', 'warning');
        }
        return null;
    };



    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Function to start a new chat
    const startNewChat = async () => {
        try {
            // Look for the home button using the provided selector
            const homeButton = document.querySelector('a[aria-label="Home"][href="/"]');
            if (homeButton) {
                log('Starting new chat...');
                homeButton.click();
                await sleep(1000); // Wait for navigation
                return true;
            } else {
                log('Home button not found, trying alternative method', 'warning');
                // Try alternative approach by navigating to home
                window.location.href = '/';
                await sleep(2000);
                return true;
            }
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
            log('Already processing a message', 'warning');
            return;
        }

        if (!isLooping) {
            isProcessing = true;
            currentBatchIndex = 0;
            failedElements = []; // Reset failed queue
        }

        updateStatus('processing');

        try {
            let messagesToProcess = [];

            if (isTemplate && dynamicElements.length > 0) {
                // Add any failed elements to the front of the queue
                const allElements = [...failedElements, ...dynamicElements.slice(currentBatchIndex)];
                
                // Debug: Log the elements being processed
                if (CONFIG.DEBUG_MODE) {
                    log(`Processing ${allElements.length} elements. First element: ${JSON.stringify(allElements[0])}`);
                }
                
                // Process template with dynamic elements
                messagesToProcess = allElements.map((element, index) => ({
                    message: processDynamicTemplate(message, {
                        item: element,
                        index: index + 1,
                        total: allElements.length
                    }),
                    customCode,
                    elementData: element,
                    index: index + 1,
                    originalIndex: dynamicElements.indexOf(element)
                }));
                
                // Clear failed elements since we're processing them
                failedElements = [];
            } else {
                messagesToProcess = [{ message, customCode }];
            }

            for (let i = 0; i < messagesToProcess.length; i++) {
                const { message: processedMessage, customCode: code, elementData, index, originalIndex } = messagesToProcess[i];
                
                updateProgress(i + 1, messagesToProcess.length);

                if (isTemplate) {
                    log(`Processing item ${index}/${messagesToProcess.length}: ${JSON.stringify(elementData)}`);
                }

                try {
                    // Start new chat if option is enabled and not the first item
                    if (newChatPerItem && i > 0) {
                        const success = await startNewChat();
                        if (!success) {
                            log('Failed to start new chat, continuing in current chat', 'warning');
                        }
                        await sleep(1000); // Additional wait after new chat
                    }

                    log(`Starting message processing...`);

                    // Type the message
                    await typeMessage(processedMessage);
                    await sleep(500);

                    // Send the message
                    await sendMessage();
                    updateStatus('waiting');

                    // Wait for response
                    log('Waiting for ChatGPT response...');
                    const responseElement = await waitForResponse();
                    const responseText = extractResponseText(responseElement);

                    log('Response received');
                    console.log('ChatGPT Response:', responseText);

                    // Execute custom code if provided
                    if (code && code.trim() !== '') {
                        if (isTemplate) {
                            try { log(`Custom code context -> index: ${index ?? 'null'}/${messagesToProcess.length}, item: ${elementData ? JSON.stringify(elementData).slice(0,200) : 'null'}`); } catch { /* no-op */ }
                        }
                        log('Executing custom code...');
                        await executeCustomCode(code, responseText, {
                            elementData,
                            index,
                            total: messagesToProcess.length
                        });
                    }

                    // Item processed successfully - remove from original array if auto-remove is enabled
                    if (isTemplate && autoRemoveProcessed && originalIndex !== undefined && originalIndex >= 0) {
                        dynamicElements.splice(originalIndex, 1);
                        // Update indices for remaining items
                        for (let j = i + 1; j < messagesToProcess.length; j++) {
                            if (messagesToProcess[j].originalIndex > originalIndex) {
                                messagesToProcess[j].originalIndex--;
                            }
                        }
                        updateDynamicElementsDisplay(dynamicElements);
                    }

                    log(`Item ${index} processed successfully`);

                } catch (itemError) {
                    log(`Error processing item ${index}: ${itemError.message}`, 'error');
                    
                    // Add failed item to retry queue (front of queue for next batch)
                    if (isTemplate && elementData) {
                        failedElements.unshift(elementData);
                        log(`Item ${index} added to retry queue`, 'warning');
                    }
                    
                    // Continue with next item instead of stopping entire batch
                    log('Continuing with next item...', 'info');
                }

                // Add delay between batch items (user configurable)
                if (i < messagesToProcess.length - 1) {
                    log(`Waiting ${batchWaitTime}ms before next item...`);
                    await sleep(batchWaitTime);
                }

                // Check if loop should continue
                if (!isLooping) break;
            }

            // Show retry queue status
            if (failedElements.length > 0) {
                log(`Batch completed with ${failedElements.length} failed items in retry queue`, 'warning');
                log('Failed items will be retried in next batch run', 'info');
            } else {
                log('All items processed successfully');
            }

            updateStatus('complete');
            log('Message processing completed');
            updateProgress(0, 0); // Reset progress

        } catch (error) {
            log(`Batch error: ${error.message}`, 'error');
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

    // Update visibility of failed items buttons
    const updateFailedButtonsVisibility = () => {
        const retryBtn = document.getElementById('retry-failed-btn');
        const clearBtn = document.getElementById('clear-failed-btn');
        const failedCountSpan = document.getElementById('failed-count');
        
        if (retryBtn && clearBtn && failedCountSpan) {
            if (failedElements.length > 0) {
                retryBtn.style.display = 'inline-block';
                clearBtn.style.display = 'inline-block';
                failedCountSpan.textContent = failedElements.length;
            } else {
                retryBtn.style.display = 'none';
                clearBtn.style.display = 'none';
            }
        }
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
                        <button class="tab-btn active" data-tab="simple">Simple</button>
                        <button class="tab-btn" data-tab="template">Template</button>
                        <button class="tab-btn" data-tab="advanced">Response (JS)</button>
                    </div>
                    
                    <div class="tab-content active" id="simple-tab">
                        <div class="form-group">
                            <label for="message-input">Message:</label>
                            <textarea id="message-input" placeholder="Enter your message for ChatGPT..." rows="3"></textarea>
                        </div>
                    </div>
                    
                    <div class="tab-content" id="template-tab">
                        <div class="form-group">
                            <label for="template-input">Message Template:</label>
                            <textarea id="template-input" placeholder="Template with placeholders like {{item}}, {{index}}, {{total}} or {item.name}..." rows="3"></textarea>
                            <div class="help-text">Use {{item}} / {item}, {{index}} / {index}, {{total}} / {total}. Nested paths supported, e.g. {item.name} or {{item.orderId}}</div>
                        </div>
                        
                        <div class="form-group">
                            <label for="dynamic-elements-input">Dynamic Elements (JSON array or function):</label>
                            <div class="code-editor">
                                <textarea id="dynamic-elements-input" placeholder='["item1", "item2", "item3"] or () => ["generated", "items"]' rows="4"></textarea>
                                <div class="editor-tools">
                                    <button class="tool-btn" id="format-json-btn" title="Format JSON">{ }</button>
                                    <button class="tool-btn" id="validate-elements-btn" title="Validate">✓</button>
                                    <button class="tool-btn" id="elements-syntax-check-btn" title="Check JS">JS</button>
                                    <button class="tool-btn" id="elements-insert-fn-btn" title="Insert Snippet">📝</button>
                                </div>
                            </div>
                        </div>
                        
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
                                
                                <label class="checkbox-label">
                                    <input type="checkbox" id="auto-scroll-checkbox" checked>
                                    <span class="checkmark"></span>
                                    Auto-scroll logs
                                </label>
                                
                                <div class="wait-time-control">
                                    <label for="wait-time-input">Wait between items (ms):</label>
                                    <input type="number" id="wait-time-input" min="100" max="30000" value="2000" step="100">
                                </div>
                            </div>
                            
                            <div class="batch-actions">
                                <button id="stop-batch-btn" class="btn btn-danger" style="display: none;">Stop Batch</button>
                                <button id="retry-failed-btn" class="btn btn-warning" style="display: none;">Retry Failed (<span id="failed-count">0</span>)</button>
                                <button id="clear-failed-btn" class="btn btn-secondary" style="display: none;">Clear Failed</button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="tab-content" id="advanced-tab">
                        <div class="form-group">
                            <label for="custom-code-input">Custom Code (JavaScript):</label>
                            <div class="code-editor">
                                <textarea id="custom-code-input" placeholder="// Custom code to run after response (optional)
// Available variables: response, log, console, item, index, total, http
// http: cross-origin helper (GM_xmlhttpRequest)
//   await http.postForm('https://api.example.com/submit', { foo: 'bar' })
// Example: log('Response length: ' + response.length);" rows="6"></textarea>
                                <div class="editor-tools">
                                    <button class="tool-btn" id="syntax-check-btn" title="Check Syntax">JS</button>
                                    <button class="tool-btn" id="insert-template-btn" title="Insert Template">📝</button>
                                </div>
                            </div>
                            <div class="help-text">Runs your JavaScript after ChatGPT finishes. Use <code>response</code> (string), <code>log()</code>, and <code>http</code> (CORS-capable) to integrate with any website's API.</div>
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
                
                <div class="automation-log" id="log-container" style="display: none;">
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
            
            #chatgpt-automation-ui.minimized { resize: none; }
            #chatgpt-automation-ui.minimized .automation-content {overflow-y: auto; }
            #chatgpt-automation-ui.minimized .progress-container,
            #chatgpt-automation-ui.minimized .automation-form { display: none; }
            #chatgpt-automation-ui.minimized .automation-log { display: block !important; }
            
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
                overflow-y: auto;
                max-height: calc(100% - 60px);
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
                overflow-y: auto;
            }
            
            #chatgpt-automation-ui.dark-mode .automation-log {
                border-color: var(--border-light, rgba(255,255,255,0.06));
            }
            
            #chatgpt-automation-ui .log-header {
                padding: 10px 16px;
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
                padding: 12px;
                overflow-y: auto;
                scroll-behavior: smooth;
            }
            
            #chatgpt-automation-ui .log-entry {
                padding: 4px 0;
                font-size: 11px;
                font-family: 'SF Mono', 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                border-bottom: 1px solid var(--border-light, rgba(0,0,0,0.03));
                line-height: 1.4;
            }
            
            #chatgpt-automation-ui .log-entry:last-child {
                border-bottom: none;
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

        // Load saved state
        const savedState = loadUIState();
        if (savedState) {
            if (savedState.position.left) {
                mainContainer.style.left = savedState.position.left;
                mainContainer.style.right = 'auto';
            }
            if (savedState.position.top) {
                mainContainer.style.top = savedState.position.top;
            }
            if (savedState.size.width) {
                mainContainer.style.width = savedState.size.width;
            }
            if (savedState.size.height) {
                mainContainer.style.height = savedState.size.height;
            }
            if (savedState.minimized) {
                isMinimized = true;
                mainContainer.classList.add('minimized');
            }
            if (typeof savedState.visible === 'boolean') {
                uiVisible = savedState.visible;
            }
        }
        // Default hidden based on persisted/CONFIG
        if (!uiVisible) {
            mainContainer.style.display = 'none';
        }

        // Bind events
        bindEvents();

        // Initialize failed buttons visibility
        updateFailedButtonsVisibility();

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
        const shouldShow = savedState ? savedState.visible === true : CONFIG.DEFAULT_VISIBLE;
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
                const shouldShow = savedState ? !!savedState.visible : CONFIG.DEFAULT_VISIBLE;
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
                
                // Update failed buttons visibility
                updateFailedButtonsVisibility();
            }
        });

        // Stop batch button
        document.getElementById('stop-batch-btn').addEventListener('click', () => {
            stopBatchProcessing();
            document.getElementById('stop-batch-btn').style.display = 'none';
            updateFailedButtonsVisibility();
        });

        // Auto-remove processed items checkbox
        document.getElementById('auto-remove-checkbox').addEventListener('change', (e) => {
            autoRemoveProcessed = e.target.checked;
            log(`Auto-remove processed items: ${autoRemoveProcessed ? 'enabled' : 'disabled'}`);
        });

        // New chat per item checkbox
        document.getElementById('new-chat-checkbox').addEventListener('change', (e) => {
            newChatPerItem = e.target.checked;
            log(`New chat per item: ${newChatPerItem ? 'enabled' : 'disabled'}`);
        });

        // Auto-scroll logs checkbox
        document.getElementById('auto-scroll-checkbox').addEventListener('change', (e) => {
            autoScrollLogs = e.target.checked;
            log(`Auto-scroll logs: ${autoScrollLogs ? 'enabled' : 'disabled'}`);
            
            // Update button state
            const btn = document.getElementById('toggle-auto-scroll-btn');
            if (btn) {
                btn.style.opacity = autoScrollLogs ? '1' : '0.5';
                btn.title = autoScrollLogs ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
            }
            
            // If enabling auto-scroll, scroll to bottom immediately
            if (autoScrollLogs && logContainer) {
                logContainer.scrollTop = logContainer.scrollHeight;
            }
        });

        // Wait time input
        document.getElementById('wait-time-input').addEventListener('change', (e) => {
            const value = parseInt(e.target.value);
            if (value >= 0 && value <= 30000) {
                batchWaitTime = value;
                log(`Wait time between items set to ${value}ms`);
            } else {
                e.target.value = batchWaitTime;
                log('Invalid wait time, keeping current value', 'warning');
            }
        });

        // Retry failed items button
        document.getElementById('retry-failed-btn').addEventListener('click', async () => {
            if (failedElements.length === 0) {
                log('No failed items to retry', 'warning');
                return;
            }

            log(`Retrying ${failedElements.length} failed items...`);
            
            // Get current template and custom code
            const message = templateInput.value.trim();
            const customCode = customCodeInput.value.trim();
            
            if (!message) {
                log('Please enter a template message', 'warning');
                return;
            }

            // Set loop mode and start processing
            isLooping = document.getElementById('loop-checkbox').checked;
            if (isLooping) {
                document.getElementById('stop-batch-btn').style.display = 'inline-block';
            }

            await processMessage(message, customCode, true);
            updateFailedButtonsVisibility();
        });

        // Clear failed items button
        document.getElementById('clear-failed-btn').addEventListener('click', () => {
            const count = failedElements.length;
            failedElements = [];
            log(`Cleared ${count} failed items from retry queue`);
            updateFailedButtonsVisibility();
        });

        // Clear button
        document.getElementById('clear-btn').addEventListener('click', () => {
            messageInput.value = '';
            customCodeInput.value = '';
            templateInput.value = '';
            dynamicElementsInput.value = '';
            document.getElementById('loop-checkbox').checked = false;
            // Also clear failed items
            failedElements = [];
            updateFailedButtonsVisibility();
            log('Form cleared');
        });

        // Toggle log button
        document.getElementById('toggle-log-btn').addEventListener('click', () => {
            const logElement = document.getElementById('log-container');
            if (logElement.style.display === 'none') {
                logElement.style.display = 'block';
            } else {
                logElement.style.display = 'none';
            }
        });

        // Clear log button
        document.getElementById('clear-log-btn').addEventListener('click', () => {
            logContainer.innerHTML = '';
            log('Log cleared');
        });

        // Toggle auto-scroll button
        document.getElementById('toggle-auto-scroll-btn').addEventListener('click', () => {
            autoScrollLogs = !autoScrollLogs;
            const checkbox = document.getElementById('auto-scroll-checkbox');
            if (checkbox) checkbox.checked = autoScrollLogs;
            
            const btn = document.getElementById('toggle-auto-scroll-btn');
            btn.style.opacity = autoScrollLogs ? '1' : '0.5';
            btn.title = autoScrollLogs ? 'Auto-scroll: ON' : 'Auto-scroll: OFF';
            
            log(`Auto-scroll logs: ${autoScrollLogs ? 'enabled' : 'disabled'}`);
            
            // If enabling auto-scroll, scroll to bottom immediately
            if (autoScrollLogs && logContainer) {
                logContainer.scrollTop = logContainer.scrollHeight;
            }
        });

        // Minimize button
        document.getElementById('minimize-btn').addEventListener('click', () => {
            isMinimized = !isMinimized;
            if (isMinimized) {
                mainContainer.classList.add('minimized');
            } else {
                mainContainer.classList.remove('minimized');
            }
            saveUIState();
        });

        // Close button
        document.getElementById('close-btn').addEventListener('click', () => {
            mainContainer.style.display = 'none';
            uiVisible = false;
            saveUIState();
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

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                const x = e.clientX - dragOffset.x;
                const y = e.clientY - dragOffset.y;

                mainContainer.style.left = `${Math.max(0, Math.min(x, window.innerWidth - mainContainer.offsetWidth))}px`;
                mainContainer.style.top = `${Math.max(0, Math.min(y, window.innerHeight - mainContainer.offsetHeight))}px`;
                mainContainer.style.right = 'auto';

                saveUIState();
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            header.style.userSelect = '';
        });

        // Resizing functionality
        let isResizing = false;
        let resizeStartX, resizeStartY, resizeStartWidth, resizeStartHeight;

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            resizeStartWidth = mainContainer.offsetWidth;
            resizeStartHeight = mainContainer.offsetHeight;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (isResizing) {
                const newWidth = Math.max(CONFIG.MIN_WIDTH, Math.min(CONFIG.MAX_WIDTH, resizeStartWidth + (e.clientX - resizeStartX)));
                const newHeight = Math.max(CONFIG.MIN_HEIGHT, Math.min(CONFIG.MAX_HEIGHT, resizeStartHeight + (e.clientY - resizeStartY)));

                mainContainer.style.width = `${newWidth}px`;
                mainContainer.style.height = `${newHeight}px`;

                saveUIState();
            }
        });

        document.addEventListener('mouseup', () => {
            isResizing = false;
        });
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
                saveUIState();
            }
        },
        show: () => {
            if (mainContainer) {
                mainContainer.style.display = 'block';
                uiVisible = true;
                saveUIState();
            }
        },
        hide: () => {
            if (mainContainer) {
                mainContainer.style.display = 'none';
                uiVisible = false;
                saveUIState();
            }
        }
    };

})();
