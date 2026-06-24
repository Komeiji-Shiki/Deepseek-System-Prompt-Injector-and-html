// ==UserScript==
// @name         DeepSeek System Prompt Injector
// @name:zh-CN   Deepseek网页版套件
// @namespace    http://tampermonkey.net/
// @version      4.0.0
// @description  DeepSeek 套件版：系统提示词注入 + 防撤回 + 自动专家模式 + html/LaTeX 解析，可分别开关
// @description:zh-CN 为DeepSeek AI设置自定义系统提示词，支持多账号切换、防撤回、自动专家模式、html/LaTeX 解析，模块可独立开关
// @author       Shiki & 灰魂 & Franky T
// @match        https://chat.deepseek.com
// @match        https://chat.deepseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @license      MIT

// ==/UserScript==

(function () {
    'use strict';

    // ══════════════════════════════════════════════════════════════
    // 0. 模块开关（防撤回/专家/htmlLaTeX 需刷新生效；系统提示词实时生效）
    // ══════════════════════════════════════════════════════════════
    const MODULE_AR_KEY = 'ds_suite_ar_enabled';
    const MODULE_EXPERT_KEY = 'ds_suite_expert_enabled';
    const MODULE_TWIST_KEY = 'ds_suite_twist_enabled';
    const arEnabled = GM_getValue(MODULE_AR_KEY, true);
    const expertEnabled = GM_getValue(MODULE_EXPERT_KEY, true);
    const twistEnabled = GM_getValue(MODULE_TWIST_KEY, true);

    const DEBUG = true;
    function log(...args) {
        if (DEBUG) console.log('[DS Suite]', ...args);
    }

    // Toast 通知（通用）
    function showToast(message) {
        const oldToast = document.querySelector('.dsp-toast');
        if (oldToast) oldToast.remove();
        const toast = document.createElement('div');
        toast.className = 'dsp-toast';
        toast.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>${message}</span>
        `;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
    function showInjectionToast() { showToast('系统提示词已注入'); }

    // ══════════════════════════════════════════════════════════════
    // 1. 系统提示词注入模块 (SP)
    // ══════════════════════════════════════════════════════════════
    const STORAGE_KEY = 'deepseek_system_prompt';
    const ENABLED_KEY = 'deepseek_system_prompt_enabled';
    const FORMAT_KEY = 'deepseek_system_prompt_format';
    const TEMPLATE_KEY = 'deepseek_custom_template';
    const PRESETS_KEY = 'deepseek_presets';
    const CURRENT_PRESET_KEY = 'deepseek_current_preset';
    const PREFIX_KEY = 'deepseek_message_prefix';
    const PREFIX_ENABLED_KEY = 'deepseek_message_prefix_enabled';
    const DEBUG_MODE_KEY = 'deepseek_debug_mode_enabled';
    const ACCOUNTS_KEY = 'deepseek_accounts';
    const CURRENT_ACCOUNT_KEY = 'deepseek_current_account';

    const API_PATTERNS = [
        '/api/v0/chat/completion',
        '/api/v0/chat',
        '/api/v0/chat_session',
        '/chat/completions',
        '/v1/chat/completions'
    ];

    const DS_TOKENS = {
        BOS: '<｜begin▁of▁sentence｜>',
        SYSTEM: '<｜System｜>',
        USER: '<｜User｜>',
        ASSISTANT: '<｜Assistant｜>',
        END_THINK: '</think>'
    };

    const DEFAULT_TEMPLATE = '{system}\n\n---\n\n{user}';
    const DEFAULT_PRESETS = [
        { id: 'default', name: '默认', prompt: '', template: DEFAULT_TEMPLATE, useNative: true }
    ];

    let systemPrompt = GM_getValue(STORAGE_KEY, '');
    let isEnabled = GM_getValue(ENABLED_KEY, true);
    let useNativeFormat = GM_getValue(FORMAT_KEY, true);
    let customTemplate = GM_getValue(TEMPLATE_KEY, DEFAULT_TEMPLATE);
    let presets = GM_getValue(PRESETS_KEY, DEFAULT_PRESETS);
    let currentPresetId = GM_getValue(CURRENT_PRESET_KEY, 'default');
    let messagePrefix = GM_getValue(PREFIX_KEY, '当前日期是 {date}，时间是 {time}。\n\n');
    let prefixEnabled = GM_getValue(PREFIX_ENABLED_KEY, false);
    let debugModeEnabled = GM_getValue(DEBUG_MODE_KEY, false);
    let accounts = GM_getValue(ACCOUNTS_KEY, []);
    let currentAccountId = GM_getValue(CURRENT_ACCOUNT_KEY, null);
    const interceptedInstances = new WeakSet();

    // SP 调试模式
    function enableDebugMode() {
        localStorage.setItem('__appKit_@deepseek/chat_debug', '{"value":true,"__version":"0"}');
        debugModeEnabled = true;
        GM_setValue(DEBUG_MODE_KEY, true);
        log('Debug mode enabled');
        location.reload();
    }
    function disableDebugMode() {
        localStorage.setItem('__appKit_@deepseek/chat_debug', '{"value":false,"__version":"0"}');
        localStorage.setItem('__appKit_@deepseek/chat_debugPanelEnabled', '{"value":false,"__version":"0"}');
        localStorage.setItem('__debugVersionUpdateDisabled', '{"value":false,"__version":"20241018.1"}');
        localStorage.removeItem('debugModelChannel');
        localStorage.removeItem('debugLiteModelChannel');
        debugModeEnabled = false;
        GM_setValue(DEBUG_MODE_KEY, false);
        log('Debug mode disabled');
        location.reload();
    }

    // SP 变量系统（正则预编译缓存，避免每次 new RegExp）
    const VAR_KEYS = ['{date}', '{time}', '{datetime}', '{year}', '{month}', '{day}', '{hour}', '{minute}', '{weekday}', '{weekday_en}', '{timestamp}', '{random}'];
    const VAR_REGEX_CACHE = new Map();
    VAR_KEYS.forEach(k => { VAR_REGEX_CACHE.set(k, new RegExp(k.replace(/[{}]/g, '\\$&'), 'g')); });
    function replaceVariables(text) {
        if (!text) return text;
        const now = new Date();
        const pad = n => n.toString().padStart(2, '0');
        const values = {
            '{date}': `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
            '{time}': `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
            '{datetime}': `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
            '{year}': now.getFullYear().toString(),
            '{month}': pad(now.getMonth() + 1),
            '{day}': pad(now.getDate()),
            '{hour}': pad(now.getHours()),
            '{minute}': pad(now.getMinutes()),
            '{weekday}': ['日', '一', '二', '三', '四', '五', '六'][now.getDay()],
            '{weekday_en}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()],
            '{timestamp}': Math.floor(now.getTime() / 1000).toString(),
            '{random}': Math.random().toString(36).substring(2, 8)
        };
        let result = text;
        for (const key of VAR_KEYS) {
            result = result.replace(VAR_REGEX_CACHE.get(key), values[key]);
        }
        return result;
    }

    // SP 消息前缀 / 格式化
    function applyMessagePrefix(userMessage) {
        if (!prefixEnabled || !messagePrefix) return userMessage;
        return replaceVariables(messagePrefix) + userMessage;
    }
    function formatPrompt(userMessage) {
        const prefixed = applyMessagePrefix(userMessage);
        if (!systemPrompt || !isEnabled) return prefixed;
        const processed = replaceVariables(systemPrompt);
        if (useNativeFormat) {
            return `${DS_TOKENS.SYSTEM}${processed}${DS_TOKENS.USER}${prefixed}`;
        } else {
            return replaceVariables(customTemplate)
                .replace(/\{system\}/g, processed)
                .replace(/\{user\}/g, prefixed);
        }
    }
    function getSystemPromptPrefix() {
        if (!systemPrompt) return null;
        if (useNativeFormat) {
            return `${DS_TOKENS.SYSTEM}${systemPrompt}${DS_TOKENS.USER}`;
        } else {
            const parts = customTemplate.split('{user}');
            if (parts.length > 0) return parts[0].replace(/\{system\}/g, systemPrompt);
            return systemPrompt;
        }
    }

    // SP 预设管理
    function savePresets() { GM_setValue(PRESETS_KEY, presets); GM_setValue(CURRENT_PRESET_KEY, currentPresetId); }
    function loadPreset(presetId) {
        const preset = presets.find(p => p.id === presetId);
        if (!preset) return false;
        currentPresetId = presetId;
        systemPrompt = preset.prompt;
        customTemplate = preset.template || DEFAULT_TEMPLATE;
        useNativeFormat = preset.useNative !== false;
        messagePrefix = preset.prefix || '当前日期是 {date}，时间是 {time}。\n\n';
        prefixEnabled = preset.prefixEnabled || false;
        GM_setValue(STORAGE_KEY, systemPrompt);
        GM_setValue(TEMPLATE_KEY, customTemplate);
        GM_setValue(FORMAT_KEY, useNativeFormat);
        GM_setValue(CURRENT_PRESET_KEY, currentPresetId);
        GM_setValue(PREFIX_KEY, messagePrefix);
        GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);
        return true;
    }
    function createPreset(name) {
        const id = 'preset_' + Date.now();
        const np = { id, name, prompt: '', template: DEFAULT_TEMPLATE, useNative: true, prefix: '当前日期是 {date}，时间是 {time}。\n\n', prefixEnabled: false };
        presets.push(np);
        currentPresetId = id;
        savePresets();
        return np;
    }
    function updateCurrentPreset() {
        const p = presets.find(x => x.id === currentPresetId);
        if (p) { p.prompt = systemPrompt; p.template = customTemplate; p.useNative = useNativeFormat; p.prefix = messagePrefix; p.prefixEnabled = prefixEnabled; savePresets(); }
    }
    function deletePreset(presetId) {
        if (presetId === 'default') return false;
        const idx = presets.findIndex(x => x.id === presetId);
        if (idx > -1) { presets.splice(idx, 1); if (currentPresetId === presetId) loadPreset('default'); savePresets(); return true; }
        return false;
    }
    function renamePreset(presetId, newName) {
        const p = presets.find(x => x.id === presetId);
        if (p && presetId !== 'default') { p.name = newName; savePresets(); return true; }
        return false;
    }

    // SP 导入导出
    function exportConfig() {
        const config = {
            version: '4.0', exportTime: new Date().toISOString(), enabled: isEnabled,
            currentPresetId, presets,
            currentSettings: { prompt: systemPrompt, template: customTemplate, useNative: useNativeFormat, prefix: messagePrefix, prefixEnabled }
        };
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `deepseek-suite-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    function importConfig(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => {
                try {
                    const config = JSON.parse(e.target.result);
                    if (!config.presets || !Array.isArray(config.presets)) throw new Error('无效的配置文件格式');
                    const existingIds = new Set(presets.map(p => p.id));
                    const newPresets = config.presets.filter(p => {
                        if (p.id === 'default') {
                            const def = presets.find(pp => pp.id === 'default');
                            if (def) { def.prompt = p.prompt; def.template = p.template; def.useNative = p.useNative; }
                            return false;
                        }
                        if (existingIds.has(p.id)) p.id = 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
                        return true;
                    });
                    presets.push(...newPresets);
                    savePresets();
                    if (config.currentSettings) {
                        systemPrompt = config.currentSettings.prompt || '';
                        customTemplate = config.currentSettings.template || DEFAULT_TEMPLATE;
                        useNativeFormat = config.currentSettings.useNative !== false;
                        messagePrefix = config.currentSettings.prefix || '当前日期是 {date}，时间是 {time}。\n\n';
                        prefixEnabled = config.currentSettings.prefixEnabled || false;
                        GM_setValue(STORAGE_KEY, systemPrompt);
                        GM_setValue(TEMPLATE_KEY, customTemplate);
                        GM_setValue(FORMAT_KEY, useNativeFormat);
                        GM_setValue(PREFIX_KEY, messagePrefix);
                        GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);
                    }
                    if (config.enabled !== undefined) { isEnabled = config.enabled; GM_setValue(ENABLED_KEY, isEnabled); }
                    resolve({ imported: newPresets.length, total: config.presets.length });
                } catch (err) { reject(err); }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file);
        });
    }

    // SP 请求修改逻辑
    function hasPrefix(text) {
        if (!messagePrefix || !text) return false;
        const fixedParts = messagePrefix.split(/\{[^}]+\}/);
        if (fixedParts.every(p => !p.trim())) return /^(当前日期是\s*\d{4}-\d{2}-\d{2}|Current date is)/.test(text);
        return fixedParts.filter(p => p.trim()).some(part => text.includes(part.trim()));
    }
    function hasSystemPromptInjected(text) {
        if (!systemPrompt || !text) return false;
        if (text.includes(DS_TOKENS.SYSTEM) || text.includes(DS_TOKENS.USER)) return true;
        const start = systemPrompt.substring(0, Math.min(30, systemPrompt.length));
        if (start.length >= 10 && text.includes(start)) return true;
        return false;
    }
    function modifyRequestBody(body, url) {
        if (!body) return body;
        const needSP = systemPrompt && isEnabled;
        const needPrefix = prefixEnabled && messagePrefix;
        if (!needSP && !needPrefix) return body;
        try {
            let data = typeof body === 'string' ? JSON.parse(body) : body;
            let modified = false;
            const urlStr = (url || '').toString();
            const parentId = data?.parent_message_id;
            const isParentEmpty = parentId === null || parentId === undefined || parentId === '' || parentId === '0' || parentId === 0;
            const editMessageId = data?.message_id ?? data?.edit_message_id ?? data?.edited_message_id ?? data?.target_message_id ?? data?.targetMessageId ?? data?.messageId ?? null;
            const isEditMessage = !!editMessageId || /(?:^|\/)(?:edit|message_edit|edit_message)(?:\/|$)/i.test(urlStr);
            const shouldInjectSP = isParentEmpty || isEditMessage;

            if (data?.prompt && typeof data.prompt === 'string') {
                let newPrompt = data.prompt;
                if (needPrefix && !hasPrefix(newPrompt)) { newPrompt = applyMessagePrefix(newPrompt); modified = true; }
                if (needSP && shouldInjectSP && !hasSystemPromptInjected(newPrompt)) {
                    const pp = replaceVariables(systemPrompt);
                    newPrompt = useNativeFormat
                        ? `${DS_TOKENS.SYSTEM}${pp}${DS_TOKENS.USER}${newPrompt}`
                        : replaceVariables(customTemplate).replace(/\{system\}/g, pp).replace(/\{user\}/g, newPrompt);
                    modified = true;
                }
                data.prompt = newPrompt;
            } else if (Array.isArray(data?.messages)) {
                if (needSP && shouldInjectSP) {
                    const sysIdx = data.messages.findIndex(m => m.role === 'system');
                    const alreadyInjected = sysIdx >= 0 && hasSystemPromptInjected(data.messages[sysIdx].content);
                    if (!alreadyInjected) {
                        const pp = replaceVariables(systemPrompt);
                        if (sysIdx >= 0) data.messages[sysIdx].content = `${pp}\n\n${data.messages[sysIdx].content}`;
                        else data.messages.unshift({ role: 'system', content: pp });
                        modified = true;
                    }
                }
                if (needPrefix) {
                    data.messages = data.messages.map(m => {
                        if (m.role === 'user' && typeof m.content === 'string' && !hasPrefix(m.content))
                            return { ...m, content: applyMessagePrefix(m.content) };
                        return m;
                    });
                }
            }
            if (modified) {
                showInjectionToast();
                return typeof body === 'string' ? JSON.stringify(data) : data;
            }
        } catch (e) { log('modifyRequestBody error:', e); }
        return body;
    }

    // SP Fetch 拦截
    function interceptFetch() {
        const originalFetch = unsafeWindow.fetch;
        if (interceptedInstances.has(originalFetch)) return;
        function isRequestLike(v) { return v && typeof v === 'object' && typeof v.clone === 'function' && typeof v.url === 'string'; }
        function isBlobLike(v) { return v && typeof v === 'object' && typeof v.text === 'function' && typeof v.arrayBuffer === 'function'; }
        unsafeWindow.fetch = async function (input, init) {
            const requestLike = isRequestLike(input);
            const urlStr = requestLike ? input.url : input.toString();
            if (!API_PATTERNS.some(p => urlStr.includes(p))) return originalFetch.call(this, input, init);
            const initObj = init || {};
            const hasInitBody = Object.prototype.hasOwnProperty.call(initObj, 'body') && initObj.body != null;
            if (hasInitBody) {
                const modifiedInit = { ...initObj };
                const bodyVal = modifiedInit.body;
                if (isBlobLike(bodyVal)) {
                    const text = await bodyVal.text();
                    const modifiedText = modifyRequestBody(text, urlStr);
                    if (modifiedText !== text) {
                        const BlobCtor = unsafeWindow.Blob || Blob;
                        modifiedInit.body = new BlobCtor([modifiedText], { type: bodyVal.type || 'application/json' });
                    }
                } else if (typeof bodyVal === 'string') {
                    modifiedInit.body = modifyRequestBody(bodyVal, urlStr);
                }
                return originalFetch.call(this, input, modifiedInit);
            }
            if (requestLike) {
                try {
                    const cloned = input.clone();
                    const text = await cloned.text();
                    const modifiedText = modifyRequestBody(text, urlStr);
                    if (modifiedText !== text) {
                        const RequestCtor = unsafeWindow.Request || Request;
                        return originalFetch.call(this, new RequestCtor(input, { ...initObj, body: modifiedText }));
                    }
                } catch (e) { log('Fetch request body read failed:', e); }
            }
            return originalFetch.call(this, input, init);
        };
        interceptedInstances.add(originalFetch);
    }

    // ══════════════════════════════════════════════════════════════
    // 2. 防撤回模块 (AR)
    // ══════════════════════════════════════════════════════════════
    const TEMPLATE_RESPONSE = 'TEMPLATE_RESPONSE';
    const CONTENT_FILTER = 'CONTENT_FILTER';
    const RECALL_TIP_EN = '⚠️ This response has been is blocked and archived only on this browser';
    const RECALL_TIP_CH = '⚠️ 此回复已被拦截，仅在本浏览器存档';
    const RECALL_NOT_FOUND_EN = '⛔️ This response has been blocked and cannot be found in local cache.';
    const RECALL_NOT_FOUND_CH = '⛔️ 此回复已被拦截，且无法在本地缓存中找到';

    function getRecalledTipMessage(locale) { return locale === 'zh_CN' ? RECALL_TIP_CH : RECALL_TIP_EN; }
    function getRecallNotFoundMessage(locale) { return locale === 'zh_CN' ? RECALL_NOT_FOUND_CH : RECALL_NOT_FOUND_EN; }
    function arGetKey(sessId, msgId) { return 'deleted-chat-sess-' + sessId + '-msg-' + msgId; }
    function arParseKey(key, container) {
        if (Array.isArray(container) && key.match(/^[-+]?\d+$/)) {
            let i = parseInt(key);
            if (i < 0) i = container.length + i;
            return i;
        }
        return key;
    }
    function arSetValueByPath(obj, path, value, isAppend) {
        const keys = path.split('/');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
            let k = arParseKey(keys[i], current);
            if (!(k in current)) {
                const nk = arParseKey(keys[i + 1], current);
                current[k] = typeof nk === 'number' ? [] : {};
            }
            current = current[k];
        }
        const lk = arParseKey(keys[keys.length - 1], current);
        if (isAppend) {
            if (Array.isArray(current[lk])) { for (let k = 0; k < value.length; k++) current[lk].push(value[k]); }
            else current[lk] = (current[lk] || '') + value;
        } else current[lk] = value;
        return obj;
    }

    function DSState() {
        this.fields = {};
        this.sessId = '';
        this.locale = 'en_US';
        this.recalled = false;
        this._updatePath = '';
        this._updateMode = 'SET';
    }
    DSState.prototype.update = function (data) {
        let precheck = this.preCheck(data);
        if (data.p) this._updatePath = data.p;
        if (data.o) this._updateMode = data.o;
        let value = data.v;
        if (typeof value === 'object' && this._updatePath === '') {
            for (var key in value) this.fields[key] = value[key];
            return precheck;
        }
        this.setField(this._updatePath, value, this._updateMode);
        return precheck;
    };
    DSState.prototype.preCheck = function (data) {
        let path = data.p ? data.p : this._updatePath;
        let mode = data.o ? data.o : this._updateMode;
        let modified = false;
        if (mode === 'BATCH' && path === 'response') {
            for (let i = 0; i < data.v.length; i++) {
                let v = data.v[i];
                if (v.p === 'fragments' && v.v[0].type === TEMPLATE_RESPONSE) {
                    modified = true;
                    data.v[i] = { v: [{ id: (this.fields.response?.fragments?.length || 0) + 1, type: 'TIP', style: 'WARNING', content: getRecalledTipMessage(this.locale) }], p: 'fragments', o: 'APPEND' };
                }
                if (v.p === 'status' && v.v === CONTENT_FILTER) {
                    modified = true;
                    data.v[i] = { p: 'status', v: 'FINISHED' };
                }
            }
        }
        if (modified) {
            this.recalled = true;
            saveRecalledMessage(this.sessId, this.fields.response?.message_id, this.fields.response?.fragments);
            return JSON.stringify(data);
        }
        return '';
    };
    DSState.prototype.setField = function (path, value, mode) {
        if (mode === 'BATCH') {
            let subMode = 'SET';
            for (let i = 0; i < value.length; i++) {
                let v = value[i];
                if (v.o) subMode = v.o;
                this.setField(path + '/' + v.p, v.v, subMode);
            }
        } else if (mode === 'SET') { arSetValueByPath(this.fields, path, value, false); }
        else if (mode === 'APPEND') { arSetValueByPath(this.fields, path, value, true); }
    };

    function saveRecalledMessage(sessId, msgId, fragments) {
        localStorage.setItem(arGetKey(sessId, msgId), JSON.stringify(fragments));
    }
    function getRecalledMessage(req, sessId, msgId) {
        let frags = JSON.parse(localStorage.getItem(arGetKey(sessId, msgId)));
        if (!frags) return [{ content: getRecallNotFoundMessage(req.__locale), id: 2, type: TEMPLATE_RESPONSE }];
        frags.push({ id: frags.length + 1, type: 'TIP', style: 'WARNING', content: getRecalledTipMessage(req.__locale) });
        return frags;
    }

    function handleEventItem(req, msg) {
        if (!msg.v) return '';
        return req.__dsState.update(msg);
    }
    function onEventStreamResp(req, res) {
        if (req.__messagesCount === undefined) {
            req.__messagesCount = 0;
            req.__dsState = new DSState();
            req.__dsState.sessId = req.__sessId;
            req.__dsState.locale = req.__locale;
        }
        let messages = res.split('\n');
        for (let i = req.__messagesCount; i < messages.length - 1; i++) {
            let msg = messages[i];
            req.__messagesCount++;
            if (!msg.startsWith('data: ')) continue;
            let data = JSON.parse(msg.replace('data:', ''));
            let handleRes = handleEventItem(req, data);
            if (handleRes !== '') messages[i] = 'data: ' + handleRes;
        }
        if (req.__dsState.recalled) {
            let res2 = '';
            for (let l = 0; l < messages.length; l++) res2 += messages[l] + '\n';
            return res2;
        }
        return res;
    }
    function onHistoryMessageResp(req, res) {
        let json = JSON.parse(res);
        if (!json.data || !json.data.biz_data) return res;
        let data = json.data.biz_data;
        let sessId = data.chat_session.id;
        let modified = false;
        for (let i = 0; i < data.chat_messages.length; i++) {
            if (data.chat_messages[i].status === CONTENT_FILTER) {
                data.chat_messages[i].fragments = getRecalledMessage(req, sessId, data.chat_messages[i].message_id);
                data.chat_messages[i].status = 'FINISHED';
                modified = true;
            }
        }
        if (modified) { json.data.biz_data = data; res = JSON.stringify(json); }
        return res;
    }
    function onResponse(req) {
        let origRes = req.getOriginalResponse();
        if (req.__reqType === 'history' && req.readyState === 4) return onHistoryMessageResp(req, origRes);
        if (req.__reqType === 'generate') return onEventStreamResp(req, origRes);
        return origRes;
    }

    // ══════════════════════════════════════════════════════════════
    // 3. 自动专家模式模块 (Expert)
    // ══════════════════════════════════════════════════════════════
    let hasClicked = false;
    let expertDebounceTimer = null;

    function findAndClick() {
        if (hasClicked) return;
        // TreeWalker 只遍历文本节点，避免 querySelectorAll('*') 几千个元素的全量遍历
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    return node.nodeValue.trim() === '专家模式'
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_SKIP;
                }
            }
        );
        let node;
        while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (!parent) continue;
            const clickTarget = parent.closest('.dfb78875') || parent;
            if (!clickTarget) continue;
            log('[专家模式] 检测到按钮，点击切换...');
            clickTarget.click();
            hasClicked = true;
            return;
        }
    }
    function debouncedExpertCheck() {
        if (expertDebounceTimer) clearTimeout(expertDebounceTimer);
        expertDebounceTimer = setTimeout(findAndClick, 500);
    }
    function initExpertMode() {
        if (!expertEnabled) return;
        const expertObserver = new MutationObserver(() => { debouncedExpertCheck(); });
        expertObserver.observe(document.body, { childList: true, subtree: true });
        setTimeout(findAndClick, 1000);
        let expertLastUrl = location.href;
        const expertUrlObserver = new MutationObserver(() => {
            if (location.href !== expertLastUrl) {
                expertLastUrl = location.href;
                hasClicked = false;
                setTimeout(findAndClick, 1500);
            }
        });
        expertUrlObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ══════════════════════════════════════════════════════════════
    // 4. html/LaTeX 解析模块 (Twist)
    // ══════════════════════════════════════════════════════════════
    function tokenize(text) {
        let tokens = [];
        let i = 0;
        let cleanText = text.replace(/\\\(/g, '').replace(/\\\)/g, '');
        while (i < cleanText.length) {
            let char = cleanText[i];
            if (char === '\\') {
                let cmd = '';
                i++;
                while (i < cleanText.length && /[a-zA-Z]/.test(cleanText[i])) { cmd += cleanText[i]; i++; }
                if (cmd) tokens.push({ type: 'command', value: cmd });
                continue;
            }
            if (char === '{') { tokens.push({ type: 'brace_open' }); i++; continue; }
            if (char === '}') { tokens.push({ type: 'brace_close' }); i++; continue; }
            let str = '';
            while (i < cleanText.length && cleanText[i] !== '\\' && cleanText[i] !== '{' && cleanText[i] !== '}') { str += cleanText[i]; i++; }
            if (str.length > 0) tokens.push({ type: 'text', value: str });
        }
        return tokens;
    }
    function parse(tokens) {
        let current = 0;
        function walk() {
            if (current >= tokens.length) return null;
            let token = tokens[current];
            if (token.type === 'text') { current++; return { type: 'Text', value: token.value }; }
            if (token.type === 'command') {
                let node = { type: 'Command', name: token.value, args: [] };
                current++;
                while (current < tokens.length && tokens[current].type === 'brace_open') {
                    current++;
                    let argChildren = [];
                    while (current < tokens.length && tokens[current].type !== 'brace_close') {
                        let child = walk();
                        if (child) argChildren.push(child);
                    }
                    if (current < tokens.length && tokens[current].type === 'brace_close') current++;
                    node.args.push(argChildren);
                }
                return node;
            }
            current++;
            return { type: 'Text', value: token.value || '' };
        }
        let ast = [];
        while (current < tokens.length) { let node = walk(); if (node) ast.push(node); }
        return ast;
    }
    function renderAST(nodes) {
        if (!nodes) return '';
        let html = '';
        for (let node of nodes) {
            if (node.type === 'Text') { html += node.value; }
            else if (node.type === 'Command') {
                let args = node.args.map(arg => renderAST(arg));
                let styles = [];
                let content = '';
                if (node.name === 'rotatebox' && args.length >= 2) {
                    styles.push('transform: rotate(' + args[0] + 'deg)', 'display: inline-block', 'margin: 0 0.05em');
                    content = args[1];
                } else if (node.name === 'scalebox' && args.length >= 2) {
                    styles.push('font-size: ' + args[0] + 'em', 'display: inline-block');
                    content = args[1];
                } else if (node.name === 'textcolor' && args.length >= 2) {
                    styles.push('color: ' + args[0]);
                    content = args[1];
                } else if (node.name === 'colorbox' && args.length >= 2) {
                    styles.push('background-color: ' + args[0]);
                    content = args[1];
                } else { content = args.join(''); }
                if (styles.length > 0) html += '<span style="' + styles.join('; ') + '">' + content + '</span>';
                else html += content;
            }
        }
        return html;
    }
    function isVisualHTMLBlock(text) {
        const trimmed = text.trim();
        if (!trimmed || !/^\s*</.test(trimmed)) return false;
        if (/<!DOCTYPE|<html[\s>]|<head[\s>]|<body[\s>]/i.test(trimmed)) return false;
        // 剥掉前导 HTML 注释后再检测，避免流式拆分出的 <!-- ... --> 块阻断整个组的渲染
        const withoutComments = trimmed.replace(/<!--[\s\S]*?-->/g, '').trim();
        const tagRE = /<(div|span|section|article|table|ul|ol|dl|nav|header|footer|main|aside|figure|details|summary|p|h[1-6])[\s>]/i;
        if (withoutComments && tagRE.test(withoutComments)) return true;
        return tagRE.test(trimmed);
    }
    function isHTMLLanguageBlock(codeEl) {
        const cls = codeEl.className || '';
        if (/language-html|lang-html/i.test(cls)) return true;
        const pre = codeEl.closest('pre');
        if (pre && /language-html|lang-html/i.test(pre.className || '')) return true;
        return false;
    }
    function isHTMLBalanced(html) {
        // 简单标签栈检测：剥离注释和 style/script 后计算开闭标签是否平衡
        const cleaned = html
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<style[\s>][\s\S]*?<\/style>/gi, '')
            .replace(/<script[\s>][\s\S]*?<\/script>/gi, '');
        const voidElements = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
        const tags = cleaned.match(/<\/?\w+[^>]*>/g) || [];
        let stack = 0;
        for (const tag of tags) {
            if (/^<\//.test(tag)) { stack--; continue; }
            const m = tag.match(/<(\w+)/);
            if (m && !voidElements.has(m[1].toLowerCase()) && !/\/>$/.test(tag)) stack++;
        }
        return stack <= 0;
    }
    function unescapeHTML(text) {
        return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    function getOrCreateRenderContainer(target) {
        let container = target.nextElementSibling;
        if (!container || container.dataset.vizSource !== 'rendered') {
            container = document.createElement('div');
            container.dataset.vizSource = 'rendered';
            container.style.cssText = 'display: contents;';
            target.insertAdjacentElement('afterend', container);
        }
        return container;
    }
    function hideOriginalNode(target) {
        if (target.dataset.vizHidden !== 'true') {
            target.style.cssText += ';position: absolute !important; width: 0 !important; height: 0 !important; opacity: 0 !important; overflow: hidden !important; pointer-events: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important;';
            target.dataset.vizHidden = 'true';
        }
    }
    // ── Twist 专用：TextNode 非破坏性渲染辅助 ──
    // TextNode 无法直接设置 style / dataset，任何移动/替换都会破坏 React 虚拟 DOM
    // 引用一致性（parentNode.removeChild 失败 → [resetAppOnFatal]）。
    // 这里采用「保留 TextNode 原位置 + 在其旁插入渲染容器 + 清空其 nodeValue」的方案。
    const twistTextRenderMap = new WeakMap();
    function getOrCreateTwistTextRenderContainer(textNode, sourceTag) {
        const parent = textNode.parentNode;
        if (!parent || parent.nodeType !== 1) return null;
        // 1) WeakMap 缓存（流式更新幂等性）
        let container = twistTextRenderMap.get(textNode);
        if (container && container.isConnected && container.parentNode === parent) {
            return container;
        }
        // 2) 兜底：扫描紧邻的下一个 Element 兄弟
        const next = textNode.nextSibling;
        if (next && next.nodeType === 1 && next.dataset &&
            next.dataset.vizSource === sourceTag) {
            twistTextRenderMap.set(textNode, next);
            return next;
        }
        // 3) 创建新容器，插入到 textNode 之后（不替换、不移动原 TextNode）
        const c = document.createElement('span');
        c.dataset.vizSource = sourceTag;
        parent.insertBefore(c, textNode.nextSibling);
        twistTextRenderMap.set(textNode, c);
        return c;
    }
    function hideOriginalTextNode(textNode) {
        // 隐藏原 TextNode：清空 nodeValue，不改变 DOM 结构。
        // React 重新调和时仍能通过其持有的 Node 引用找到此 TextNode 并安全更新。
        if (textNode.nodeValue !== '') textNode.nodeValue = '';
    }
    // ── 激活 innerHTML 插入的 <script> 和内联事件 ──
    // 浏览器安全策略导致通过 innerHTML 插入的 <script> 不会执行，
    // onclick / onmouseover 等内联事件属性也不会绑定。
    // 本函数遍历容器内所有元素，用 replaceChild 激活脚本、用 addEventListener 绑定事件，
    // 使 AI 生成的交互式 HTML 面板可以正常运作。
    function activateScripts(container) {
        // 1) 激活 <script>：用同名新元素替换，浏览器会当作新脚本执行
        const scripts = container.querySelectorAll('script');
        for (const oldScript of scripts) {
            const newScript = document.createElement('script');
            for (let i = 0; i < oldScript.attributes.length; i++) {
                const a = oldScript.attributes[i];
                newScript.setAttribute(a.name, a.value);
            }
            newScript.textContent = oldScript.textContent;
            oldScript.parentNode.replaceChild(newScript, oldScript);
        }
        // 2) 激活内联事件属性
        const events = [
            'click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout', 'mousemove',
            'keydown', 'keyup', 'keypress',
            'change', 'input', 'focus', 'blur', 'submit', 'reset',
            'touchstart', 'touchend', 'touchmove'
        ];
        const elements = container.querySelectorAll('*');
        for (const el of elements) {
            for (const evt of events) {
                const handler = el.getAttribute('on' + evt);
                if (handler) {
                    try {
                        // addEventListener 中 this 指向元素，因此 handler 里的 this.style 等引用正常工作
                        el.addEventListener(evt, new Function('event', handler));
                    } catch (e) { /* 非法表达式静默跳过 */ }
                }
            }
        }
    }
    function processHTMLBlock(targetEl, rawContent, forceRender, skipHide) {
        if (!rawContent.trim()) return false;
        const unescaped = unescapeHTML(rawContent);
        if (!forceRender && !isVisualHTMLBlock(unescaped)) return false;
        const container = getOrCreateRenderContainer(targetEl);
        if (container.dataset.lastContent !== unescaped) {
            container.innerHTML = unescaped;
            container.dataset.lastContent = unescaped;
            activateScripts(container);
            if (!skipHide) hideOriginalNode(targetEl);
            walkDOM(container);
        }
        return true;
    }
    function processCodeBlock(codeEl) {
        const content = codeEl.textContent || codeEl.innerText || '';
        const pre = codeEl.closest('pre');
        const target = pre || codeEl;
        const force = isHTMLLanguageBlock(codeEl);
        return processHTMLBlock(target, content, force);
    }
    function processDSMarkdownHTMLSpan(spanEl) {
        const group = [spanEl];
        // 向前收集相邻 ds-markdown-html span，跳过已插入的渲染容器
        let prev = spanEl.previousSibling;
        while (prev) {
            if (prev.nodeType === 1 && prev.tagName === 'SPAN' && /ds-markdown-html/i.test(prev.className || '')) {
                group.unshift(prev);
                prev = prev.previousSibling;
            } else if (prev.nodeType === 1 && prev.dataset && prev.dataset.vizSource === 'rendered') {
                prev = prev.previousSibling; // 跳过渲染容器继续向前
            } else {
                break;
            }
        }
        // 向后收集，同样跳过渲染容器
        let next = spanEl.nextSibling;
        while (next) {
            if (next.nodeType === 1 && next.tagName === 'SPAN' && /ds-markdown-html/i.test(next.className || '')) {
                group.push(next);
                next = next.nextSibling;
            } else if (next.nodeType === 1 && next.dataset && next.dataset.vizSource === 'rendered') {
                next = next.nextSibling;
            } else {
                break;
            }
        }
        let combinedRaw = '';
        for (const s of group) combinedRaw += s.textContent || s.innerText || '';
        const firstSpan = group[0];
        // 流式期间也始终隐藏原始 span，不再等待 HTML 标签平衡
        // skipHide=true：不在 processHTMLBlock 内部隐藏，统一在外面处理
        const result = processHTMLBlock(firstSpan, combinedRaw, false, true);
        if (result) {
            for (const s of group) hideOriginalNode(s);
        }
        return result;
    }
    function processEscapedHTMLInText(node) {
        const text = node.nodeValue;
        if (!text || !/&lt;\s*(div|span|section|article|table|nav|header|footer|details|summary)\b/i.test(text)) return false;
        let unescaped = unescapeHTML(text);
        if (unescaped === text || !isVisualHTMLBlock(unescaped)) return false;
        // 非破坏性：保留原 TextNode，在其旁插入渲染容器
        const container = getOrCreateTwistTextRenderContainer(node, 'escaped-rendered');
        if (!container) return false;
        if (container.dataset.lastContent !== unescaped) {
            container.innerHTML = unescaped;
            container.dataset.lastContent = unescaped;
            activateScripts(container);
        }
        hideOriginalTextNode(node);
        return true;
    }
    const processedTextNodes = new WeakSet();
    function processTextNode(node) {
        if (processedTextNodes.has(node)) return;
        const text = node.nodeValue;
        if (!text) return;
        const parent = node.parentNode;
        if (!parent || parent.nodeType !== 1) return;
        // 不二次处理已渲染容器内的 TextNode
        if (parent.dataset && (parent.dataset.vizSource === 'rendered' ||
                               parent.dataset.vizSource === 'escaped-rendered' ||
                               parent.dataset.vizSource === 'twist-rendered')) {
            processedTextNodes.add(node);
            return;
        }
        if (text.includes('\\rotatebox') || text.includes('\\textcolor') || text.includes('\\scalebox') || text.includes('\\colorbox')) {
            const tokens = tokenize(text);
            const ast = parse(tokens);
            const html = renderAST(ast);
            if (html !== text && html !== text.replace(/\\\(/g, '').replace(/\\\)/g, '')) {
                // 非破坏性渲染：保留原 TextNode 不替换，在其旁插入渲染容器
                const container = getOrCreateTwistTextRenderContainer(node, 'twist-rendered');
                if (container) {
                    if (container.dataset.lastContent !== html) {
                        container.innerHTML = html;
                        container.dataset.lastContent = html;
                        activateScripts(container);
                    }
                    hideOriginalTextNode(node);
                    // 故意不加入 processedTextNodes：流式更新中 React 写入新值时需重新渲染
                    return;
                }
            }
        }
        if (processEscapedHTMLInText(node)) return;
        processedTextNodes.add(node);
    }
    function walkDOM(node) {
        if (node.nodeType === 1) {
            const tagName = node.tagName;
            if (['TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(tagName)) return;
            if (node.dataset && (node.dataset.vizSource === 'rendered' || node.dataset.vizSource === 'escaped-rendered' || node.dataset.vizSource === 'twist-rendered')) return;
            if (tagName === 'SPAN' && /ds-markdown-html/i.test(node.className || '')) { processDSMarkdownHTMLSpan(node); return; }
            const codeElements = node.querySelectorAll ? node.querySelectorAll('code') : [];
            for (const codeEl of codeElements) {
                if (codeEl.closest('script, style, textarea, input, [data-viz-source]')) continue;
                processCodeBlock(codeEl);
            }
        }
        if (node.nodeType === 3) { processTextNode(node); }
        else if (node.childNodes) {
            const children = Array.from(node.childNodes);
            for (let i = 0; i < children.length; i++) { if (children[i].parentNode) walkDOM(children[i]); }
        }
    }
    const pendingRoots = new Set();
    let twistRafId = null;
    function scheduleProcess(node) {
        if (!node) return;
        let target = node.nodeType === 3 ? node.parentNode : node;
        if (!target || target.nodeType !== 1) return;
        // 跳过我们自己创建的渲染容器及其后代，避免递归扫描
        if (target.dataset && (target.dataset.vizSource === 'rendered' ||
                               target.dataset.vizSource === 'escaped-rendered' ||
                               target.dataset.vizSource === 'twist-rendered')) return;
        if (target.closest && target.closest('[data-viz-source="rendered"],[data-viz-source="escaped-rendered"],[data-viz-source="twist-rendered"]')) return;
        const dsHtmlAncestor = target.closest && target.closest('span.ds-markdown-html');
        if (dsHtmlAncestor) target = dsHtmlAncestor;
        pendingRoots.add(target);
        if (twistRafId) return;
        twistRafId = requestAnimationFrame(() => {
            twistRafId = null;
            const roots = Array.from(pendingRoots);
            pendingRoots.clear();
            for (const r of roots) { if (r.isConnected) walkDOM(r); }
        });
    }
    function initTwistParser() {
        if (!twistEnabled) return;
        const twistObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(scheduleProcess);
                if (mutation.type === 'characterData') scheduleProcess(mutation.target);
                if (mutation.type === 'childList' && mutation.target.nodeType === 1) {
                    if (mutation.target.tagName === 'SPAN' && /ds-markdown-html/i.test(mutation.target.className))
                        scheduleProcess(mutation.target);
                }
            }
        });
        setTimeout(() => {
            walkDOM(document.body);
            twistObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
        }, 500);
    }

    // ══════════════════════════════════════════════════════════════
    // 5. 统一 XHR 拦截层（合并 SP body 修改 + AR response 拦截）
    // ══════════════════════════════════════════════════════════════
    function installXHRHooks() {
        const XHR = unsafeWindow.XMLHttpRequest;
        if (interceptedInstances.has(XHR.prototype)) return;

        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        const origSetReqHeader = XHR.prototype.setRequestHeader;

        // --- SP 层：open 记录 url ---
        XHR.prototype.open = function (method, url, ...args) {
            this._url = url;
            // AR 层：判定请求类型（仅 arEnabled 时）
            if (arEnabled) {
                let urlPath = url.split('?')[0];
                if (urlPath === '/api/v0/chat/history_messages') this.__reqType = 'history';
                else if (urlPath === '/api/v0/chat/completion' || urlPath === '/api/v0/chat/edit_message' || urlPath === '/api/v0/chat/regenerate' ||
                    urlPath === '/api/v0/chat/continue' || urlPath === '/api/v0/chat/resume_stream') this.__reqType = 'generate';
            }
            return origOpen.call(this, method, url, ...args);
        };

        // --- SP 层：send 修改 body ---
        XHR.prototype.send = function (body) {
            if (this._url && API_PATTERNS.some(p => this._url.includes(p))) {
                arguments[0] = modifyRequestBody(body, this._url);
            }
            // AR 层：记录 session ID
            if (arEnabled && this.__reqType === 'generate' && body) {
                try {
                    let bodyJson = typeof body === 'string' ? JSON.parse(body) : body;
                    if (bodyJson && bodyJson.chat_session_id) this.__sessId = bodyJson.chat_session_id;
                } catch (e) { /* ignore parse error */ }
            }
            return origSend.apply(this, arguments);
        };

        // --- AR 层：setRequestHeader 记录 locale ---
        XHR.prototype.setRequestHeader = function (header, value) {
            if (arEnabled && this.__reqType && header === 'x-client-locale')
                this.__locale = value;
            return origSetReqHeader.apply(this, arguments);
        };

        // --- AR 层：response / responseText getter + getOriginalResponse ---
        if (arEnabled) {
            const origRespDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');
            const origRespTextDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');

            XHR.prototype.getOriginalResponse = function () {
                return origRespDesc.get.call(this);
            };

            Object.defineProperty(XHR.prototype, 'response', {
                get: function () {
                    if (!this.__reqType) return origRespDesc.get.call(this);
                    return onResponse(this);
                },
                set: function (body) { return origRespDesc.set.call(this, body); }
            });

            Object.defineProperty(XHR.prototype, 'responseText', {
                get: function () {
                    if (!this.__reqType) return origRespTextDesc.get.call(this);
                    return onResponse(this);
                },
                set: function (body) { return origRespTextDesc.set.call(this, body); }
            });
        }

        interceptedInstances.add(XHR.prototype);
    }

    // ══════════════════════════════════════════════════════════════
    // 6. CSS 样式（Nova Silent Sky + 模块开关）
    // ══════════════════════════════════════════════════════════════
    GM_addStyle(`
        :root {
            --dsp-bg-deep: linear-gradient(180deg, #090e16 0%, #0a1220 100%);
            --dsp-bg-elev: linear-gradient(180deg, rgba(16,28,48,0.28), rgba(9,16,30,0.35));
            --dsp-line-weak: #162339;
            --dsp-line-strong: #223650;
            --dsp-text-main: #d9e5ff;
            --dsp-text-dim: #8fa0bf;
            --dsp-btn-bg: #0e1a2d;
            --dsp-btn-hover: #15263f;
            --dsp-btn-active: #132745;
            --dsp-btn-active-glow: rgba(42,168,255,0.14);
            --dsp-btn-border-active: #254569;
            --dsp-btn-border: #223650;
            --dsp-accent: #2aa8ff;
            --dsp-accent-soft: rgba(42,168,255,0.35);
            --dsp-accent-faint: rgba(42,168,255,0.12);
            --dsp-success: #22c55e;
            --dsp-danger: #ef4444;
            --dsp-notch: 10px;
        }

        @keyframes dsp-sheen { 0%{background-position:0% 0} 100%{background-position:200% 0} }
        @keyframes dsp-card-glow { 0%,100%{opacity:.25} 50%{opacity:.38} }
        @keyframes dsp-aurora-run { 0%{background-position:0% 0} 100%{background-position:200% 0} }
        @keyframes dsp-fade-in { from{opacity:0;transform:translateY(12px) scale(.97)} to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes dsp-fade-out { from{opacity:1;transform:scale(1)} to{opacity:0;transform:scale(.96)} }
        @keyframes dsp-toast-in { from{opacity:0;transform:translateX(100%) scale(.9)} to{opacity:1;transform:translateX(0) scale(1)} }
        @keyframes dsp-toast-out { from{opacity:1;transform:translateX(0) scale(1)} to{opacity:0;transform:translateX(100%) scale(.9)} }

        .dsp-toast {
            position:fixed;bottom:100px;right:24px;background:linear-gradient(135deg,#0d2818 0%,#0a1f14 100%);
            border:1px solid rgba(34,197,94,.4);color:var(--dsp-success);padding:10px 16px;font-size:13px;
            font-weight:500;display:flex;align-items:center;gap:8px;z-index:999999;
            clip-path:polygon(0 6px,6px 0,calc(100% - 6px) 0,100% 6px,100% calc(100% - 6px),calc(100% - 6px) 100%,6px 100%,0 calc(100% - 6px));
            box-shadow:0 4px 20px rgba(34,197,94,.2),inset 0 0 0 1px rgba(34,197,94,.1);
            opacity:0;transform:translateX(100%) scale(.9);transition:all .3s cubic-bezier(.4,0,.2,1);
            font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        }
        .dsp-toast.show { opacity:1;transform:translateX(0) scale(1); }
        .dsp-toast svg { width:16px;height:16px;stroke:var(--dsp-success); }

        .dsp-fab-container { position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;align-items:center;gap:8px; }
        .dsp-quick-toggle {
            width:36px;height:36px;background:var(--dsp-bg-deep);border:1px solid var(--dsp-line-weak);cursor:pointer;
            display:flex;align-items:center;justify-content:center;transition:all .2s ease;
            clip-path:polygon(0 6px,6px 0,calc(100% - 6px) 0,100% 6px,100% calc(100% - 6px),calc(100% - 6px) 100%,6px 100%,0 calc(100% - 6px));
            box-shadow:0 4px 14px rgba(0,0,0,.4),inset 0 0 0 1px rgba(255,255,255,.03);
            opacity:0;transform:translateX(10px);pointer-events:none;
        }
        .dsp-fab-container:hover .dsp-quick-toggle { opacity:1;transform:translateX(0);pointer-events:auto; }
        .dsp-quick-toggle:hover { border-color:var(--dsp-line-strong);transform:translateY(-1px)!important; }
        .dsp-quick-toggle.on { border-color:var(--dsp-accent-soft);background:linear-gradient(180deg,#162d4a 0%,#132745 100%); }
        .dsp-quick-toggle svg { width:18px;height:18px; }
        .dsp-quick-toggle .icon-on { display:none; }
        .dsp-quick-toggle .icon-off { display:block;color:var(--dsp-text-dim); }
        .dsp-quick-toggle.on .icon-on { display:block;color:var(--dsp-accent); }
        .dsp-quick-toggle.on .icon-off { display:none; }

        .dsp-fab {
            width:52px;height:52px;background:var(--dsp-bg-deep);border:1px solid var(--dsp-line-weak);cursor:pointer;
            display:flex;align-items:center;justify-content:center;transition:all .2s ease;
            clip-path:polygon(0 var(--dsp-notch),var(--dsp-notch) 0,calc(100% - var(--dsp-notch)) 0,100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)),calc(100% - var(--dsp-notch)) 100%,var(--dsp-notch) 100%,0 calc(100% - var(--dsp-notch)));
            box-shadow:0 6px 20px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.03);position:relative;
        }
        .dsp-fab svg { width:28px;height:28px;transition:all .2s ease; }
        .dsp-fab svg path { fill:var(--dsp-text-dim);transition:fill .2s ease; }
        .dsp-fab::before {
            content:"";position:absolute;inset:0;
            background:linear-gradient(120deg,rgba(255,255,255,0),rgba(255,255,255,.05),rgba(255,255,255,0));
            background-size:200% 100%;opacity:.08;pointer-events:none;animation:dsp-sheen 8s linear infinite;
        }
        .dsp-fab:hover { border-color:var(--dsp-line-strong);transform:translateY(-2px);box-shadow:0 8px 28px rgba(0,0,0,.5),0 0 0 1px var(--dsp-accent-faint); }
        .dsp-fab:hover svg path { fill:var(--dsp-text-main); }
        .dsp-fab.active { border-color:var(--dsp-accent-soft);box-shadow:0 0 20px var(--dsp-accent-faint),0 8px 28px rgba(0,0,0,.5); }
        .dsp-fab.active svg path { fill:var(--dsp-accent); }
        .dsp-fab.inactive { opacity:.6; }

        .dsp-panel {
            position:fixed;bottom:88px;right:24px;width:420px;max-width:calc(100vw - 48px);
            background:var(--dsp-bg-deep);color:var(--dsp-text-main);border:1px solid var(--dsp-line-weak);z-index:99998;
            overflow:hidden;opacity:0;visibility:hidden;transform:translateY(12px) scale(.97);
            transition:all .25s cubic-bezier(.4,0,.2,1);
            clip-path:polygon(0 var(--dsp-notch),var(--dsp-notch) 0,calc(100% - var(--dsp-notch)) 0,100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)),calc(100% - var(--dsp-notch)) 100%,var(--dsp-notch) 100%,0 calc(100% - var(--dsp-notch)));
            box-shadow:0 14px 38px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.03);
            font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
        }
        .dsp-panel::before { content:"";position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(42,168,255,.06); }
        .dsp-panel::after {
            content:"";position:absolute;inset:-1px -1px 60% -1px;
            background:radial-gradient(80% 50% at 25% 0%,rgba(255,255,255,.04),rgba(255,255,255,0));
            pointer-events:none;animation:dsp-card-glow 12s ease-in-out infinite;
        }
        .dsp-panel.open { opacity:1;visibility:visible;transform:translateY(0) scale(1); }

        .dsp-header {
            padding:14px 16px;display:flex;align-items:center;justify-content:space-between;
            background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,0));
            border-bottom:1px solid rgba(255,255,255,.04);position:relative;
        }
        .dsp-header::after {
            content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:1px;
            background:linear-gradient(90deg,transparent,rgba(42,168,255,.4),transparent);
            background-size:200% 100%;animation:dsp-aurora-run 7s linear infinite;opacity:.6;
        }
        .dsp-header-main { display:flex;flex-direction:column; }
        .dsp-title { font-size:13px;font-weight:600;letter-spacing:.3px;display:flex;align-items:center;gap:8px; }
        .dsp-subtitle { font-size:11px;color:var(--dsp-text-dim);opacity:.85;margin-top:2px; }

        .dsp-toggle {
            position:relative;width:44px;height:24px;background:var(--dsp-btn-bg);border:1px solid var(--dsp-btn-border);
            border-radius:12px;cursor:pointer;transition:all .2s;
        }
        .dsp-toggle::after {
            content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;
            background:var(--dsp-text-dim);border-radius:50%;transition:all .2s;
        }
        .dsp-toggle.on { background:var(--dsp-btn-active);border-color:var(--dsp-accent-soft); }
        .dsp-toggle.on::after { transform:translateX(20px);background:var(--dsp-accent);box-shadow:0 0 8px var(--dsp-accent-soft); }
        .dsp-toggle-small { width:36px;height:20px; }
        .dsp-toggle-small::after { width:14px;height:14px;top:2px;left:2px; }
        .dsp-toggle-small.on::after { transform:translateX(16px); }

        .dsp-body { padding:14px 16px;max-height:55vh;overflow-y:auto; }
        .dsp-section { margin-bottom:14px; }
        .dsp-section:last-child { margin-bottom:0; }
        .dsp-label {
            font-size:10.5px;color:rgba(42,168,255,.8);letter-spacing:.45px;margin-bottom:8px;
            text-transform:uppercase;display:flex;justify-content:space-between;align-items:center;
        }
        .dsp-label .count { color:var(--dsp-text-dim);text-transform:none;letter-spacing:0; }

        /* 模块开关列表 */
        .dsp-module-list { display:flex;flex-direction:column;gap:6px; }
        .dsp-module-item {
            display:flex;align-items:center;justify-content:space-between;
            padding:8px 12px;background:var(--dsp-btn-bg);border:1px solid var(--dsp-btn-border);
            font-size:12px;color:var(--dsp-text-main);transition:all .15s ease;
            clip-path:polygon(0 4px,4px 0,calc(100% - 4px) 0,100% 4px,100% calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,0 calc(100% - 4px));
        }
        .dsp-module-item:hover { background:var(--dsp-btn-hover);border-color:var(--dsp-line-strong); }

        .dsp-preset-bar { display:flex;gap:8px;align-items:center; }
        .dsp-preset-select {
            flex:1;background:var(--dsp-btn-bg);border:1px solid var(--dsp-btn-border);color:var(--dsp-text-main);
            padding:8px 12px;font-size:12px;cursor:pointer;outline:none;
            clip-path:polygon(0 6px,6px 0,calc(100% - 6px) 0,100% 6px,100% calc(100% - 6px),calc(100% - 6px) 100%,6px 100%,0 calc(100% - 6px));
            transition:border-color .2s;
        }
        .dsp-preset-select:hover,.dsp-preset-select:focus { border-color:var(--dsp-line-strong); }
        .dsp-preset-select option { background:#0e1a2d;color:var(--dsp-text-main); }
        .dsp-preset-btn {
            width:32px;height:32px;background:var(--dsp-btn-bg);border:1px solid var(--dsp-btn-border);color:var(--dsp-text-dim);
            cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;
            clip-path:polygon(0 4px,4px 0,calc(100% - 4px) 0,100% 4px,100% calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,0 calc(100% - 4px));
        }
        .dsp-preset-btn:hover { background:var(--dsp-btn-hover);color:var(--dsp-text-main);border-color:var(--dsp-line-strong); }
        .dsp-preset-btn.danger:hover { background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.5);color:var(--dsp-danger); }
        .dsp-preset-btn svg { width:14px;height:14px; }

        .dsp-textarea {
            width:100%;background:var(--dsp-btn-bg);border:1px solid var(--dsp-btn-border);padding:12px;color:var(--dsp-text-main);
            font-size:13px;font-family:'Monaco','Consolas','SF Mono',monospace;resize:vertical;outline:none;
            transition:border-color .2s,box-shadow .2s;box-sizing:border-box;
            clip-path:polygon(0 var(--dsp-notch),var(--dsp-notch) 0,calc(100% - var(--dsp-notch)) 0,100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)),calc(100% - var(--dsp-notch)) 100%,var(--dsp-notch) 100%,0 calc(100% - var(--dsp-notch)));
            box-shadow:0 4px 12px rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.02);
        }
        .dsp-textarea:focus { border-color:var(--dsp-accent-soft);box-shadow:0 0 0 1px var(--dsp-accent-faint),0 4px 12px rgba(0,0,0,.2); }
        .dsp-textarea::placeholder { color:var(--dsp-text-dim);opacity:.6; }
        .dsp-textarea.prompt { min-height:60px;height:100px; }
        .dsp-textarea.template { min-height:50px;height:70px;font-size:12px; }

        .dsp-format-group { display:grid;grid-template-columns:1fr 1fr;gap:8px; }
        .dsp-format-btn {
            position:relative;padding:10px 12px;font-size:12px;font-weight:500;cursor:pointer;
            background:var(--dsp-btn-bg);color:var(--dsp-text-main);border:1px solid var(--dsp-btn-border);
            transition:all .15s ease;text-align:center;
            clip-path:polygon(0 var(--dsp-notch),var(--dsp-notch) 0,calc(100% - var(--dsp-notch)) 0,100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)),calc(100% - var(--dsp-notch)) 100%,var(--dsp-notch) 100%,0 calc(100% - var(--dsp-notch)));
            box-shadow:0 4px 12px rgba(0,0,0,.2),inset 0 0 0 1px rgba(255,255,255,.02);
        }
        .dsp-format-btn::before {
            content:"";position:absolute;inset:0;
            background:linear-gradient(120deg,rgba(255,255,255,0),rgba(255,255,255,.05),rgba(255,255,255,0));
            background-size:200% 100%;opacity:.06;pointer-events:none;animation:dsp-sheen 9s linear infinite;
        }
        .dsp-format-btn:hover { background:var(--dsp-btn-hover);border-color:var(--dsp-line-strong);transform:translateY(-1px); }
        .dsp-format-btn.active { background:linear-gradient(180deg,#162d4a 0%,#132745 100%);border-color:var(--dsp-btn-border-active); }
        .dsp-format-btn.active::after {
            content:"";position:absolute;right:10px;top:50%;width:8px;height:8px;transform:translateY(-50%);
            border-radius:2px;background:var(--dsp-accent);box-shadow:0 0 0 2px rgba(42,168,255,.16),0 0 8px rgba(42,168,255,.22);
        }

        .dsp-variables-hint {
            background:rgba(9,14,22,.6);border:1px solid var(--dsp-line-weak);padding:10px 12px;
            font-size:11px;color:var(--dsp-text-dim);margin-top:8px;
            clip-path:polygon(0 4px,4px 0,calc(100% - 4px) 0,100% 4px,100% calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,0 calc(100% - 4px));
        }
        .dsp-variables-hint code { background:var(--dsp-btn-bg);padding:2px 5px;border-radius:3px;color:var(--dsp-accent);font-family:'Monaco','Consolas',monospace;margin-right:4px; }
        .dsp-variables-toggle { cursor:pointer;color:var(--dsp-accent);font-size:10px;text-transform:uppercase;letter-spacing:.3px; }
        .dsp-variables-toggle:hover { text-decoration:underline; }
        .dsp-variables-list { display:none;margin-top:8px;line-height:1.8; }
        .dsp-variables-list.show { display:block; }

        .dsp-preview {
            background:rgba(9,14,22,.8);border:1px solid var(--dsp-line-weak);padding:10px 12px;
            font-size:11px;color:var(--dsp-text-dim);font-family:'Monaco','Consolas','SF Mono',monospace;
            line-height:1.5;max-height:80px;overflow-y:auto;word-break:break-all;
            clip-path:polygon(0 6px,6px 0,calc(100% - 6px) 0,100% 6px,100% calc(100% - 6px),calc(100% - 6px) 100%,6px 100%,0 calc(100% - 6px));
        }
        .dsp-preview .token { color:#f472b6;font-weight:500; }
        .dsp-preview-title { font-size:10px;color:rgba(42,168,255,.7);letter-spacing:.4px;text-transform:uppercase;margin-bottom:6px; }

        .dsp-hint { font-size:10px;color:var(--dsp-text-dim);margin-top:6px;opacity:.7; }
        .dsp-hint code { background:var(--dsp-btn-bg);padding:2px 5px;border-radius:3px;color:var(--dsp-accent);font-family:'Monaco','Consolas',monospace; }

        .dsp-footer {
            padding:12px 16px;display:flex;flex-direction:column;gap:10px;
            background:linear-gradient(180deg,rgba(12,22,40,.72),rgba(9,16,30,.86));
            border-top:1px solid var(--dsp-line-weak);position:relative;
        }
        .dsp-footer::before {
            content:"";position:absolute;left:10px;right:10px;top:-1px;height:1px;
            background:linear-gradient(90deg,transparent,rgba(42,168,255,.45),transparent);
            background-size:200% 100%;animation:dsp-aurora-run 7.8s linear infinite;opacity:.5;
        }
        .dsp-footer-row { display:grid;grid-template-columns:1fr 1fr;gap:10px; }
        .dsp-footer-row.three { grid-template-columns:1fr 1fr 1fr; }

        .dsp-btn {
            position:relative;padding:10px 16px;font-size:12.5px;font-weight:600;letter-spacing:.2px;
            cursor:pointer;border:1px solid var(--dsp-btn-border);transition:all .15s ease;
            clip-path:polygon(0 var(--dsp-notch),var(--dsp-notch) 0,calc(100% - var(--dsp-notch)) 0,100% var(--dsp-notch),
                100% calc(100% - var(--dsp-notch)),calc(100% - var(--dsp-notch)) 100%,var(--dsp-notch) 100%,0 calc(100% - var(--dsp-notch)));
            box-shadow:0 6px 16px rgba(0,0,0,.28),inset 0 0 0 1px rgba(255,255,255,.03);
        }
        .dsp-btn-secondary { background:var(--dsp-btn-bg);color:var(--dsp-text-dim); }
        .dsp-btn-secondary:hover { background:var(--dsp-btn-hover);color:var(--dsp-text-main);transform:translateY(-1px); }
        .dsp-btn-primary {
            background:linear-gradient(180deg,#10233c,#0d1e34);color:var(--dsp-text-main);border-color:var(--dsp-accent-soft);
        }
        .dsp-btn-primary:hover { background:linear-gradient(180deg,#132a44,#10233c);transform:translateY(-1px);box-shadow:0 8px 22px rgba(0,0,0,.35),0 0 0 1px rgba(42,168,255,.08) inset; }
        .dsp-btn-primary:active { transform:translateY(0);background:linear-gradient(180deg,#0f2036,#0c1b2f); }
        .dsp-btn-small { padding:8px 12px;font-size:11px; }

        .dsp-file-input { display:none; }

        @media (prefers-reduced-motion:reduce) {
            *,*::before,*::after { animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important; }
        }
        @media (max-width:768px) {
            .dsp-fab-container { bottom:90px!important;right:16px!important;gap:6px!important; }
            .dsp-fab-container .dsp-fab { width:44px!important;height:44px!important;--dsp-notch:8px; }
            .dsp-fab-container .dsp-fab svg { width:24px!important;height:24px!important; }
            .dsp-fab-container .dsp-quick-toggle { width:30px!important;height:30px!important; }
            .dsp-fab-container .dsp-quick-toggle svg { width:15px!important;height:15px!important; }
            .dsp-panel { bottom:150px!important;right:12px!important;width:calc(100vw - 24px)!important;max-width:400px!important; }
            .dsp-toast { bottom:160px!important;right:12px!important; }
        }

        .dsp-account-item {
            display:flex;align-items:center;justify-content:space-between;padding:10px 12px;
            background:var(--dsp-btn-bg);border:1px solid var(--dsp-btn-border);
            clip-path:polygon(0 4px,4px 0,calc(100% - 4px) 0,100% 4px,100% calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,0 calc(100% - 4px));
            transition:all .15s ease;
        }
        .dsp-account-item.current { border-color:var(--dsp-accent-soft);background:linear-gradient(180deg,#162d4a 0%,#132745 100%);box-shadow:0 0 12px rgba(42,168,255,.08); }
        .dsp-account-item:hover { border-color:var(--dsp-line-strong); }
        .dsp-account-info { flex:1;min-width:0; }
        .dsp-account-name { font-size:13px;font-weight:500;color:var(--dsp-text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
        .dsp-account-token { font-size:10px;color:var(--dsp-text-dim);margin-top:2px;font-family:'Monaco','Consolas',monospace; }
        .dsp-account-actions { display:flex;gap:4px;flex-shrink:0;margin-left:8px; }
        .dsp-account-actions .dsp-preset-btn { width:28px;height:28px; }
        .dsp-account-actions .dsp-preset-btn svg { width:12px;height:12px; }
    `);

    // ══════════════════════════════════════════════════════════════
    // 7. UI 图标
    // ══════════════════════════════════════════════════════════════
    const DEEPSEEK_ICON = '<svg viewBox="0 0 34 26" xmlns="http://www.w3.org/2000/svg"><path d="M33.615 2.598c-.36-.176-.515.16-.726.33-.072.055-.132.127-.193.193-.526.562-1.14.93-1.943.887-1.174-.067-2.176.302-3.062 1.2-.188-1.107-.814-1.767-1.766-2.191-.498-.22-1.002-.441-1.35-.92-.244-.341-.31-.721-.433-1.096-.077-.226-.154-.457-.415-.496-.282-.044-.393.193-.504.391-.443.81-.614 1.702-.598 2.605.04 2.033.898 3.652 2.603 4.803.193.132.243.264.182.457-.116.397-.254.782-.376 1.179-.078.253-.194.308-.465.198-.936-.391-1.744-.97-2.458-1.669-1.213-1.173-2.31-2.467-3.676-3.48a16.254 16.254 0 0 0-.975-.668c-1.395-1.354.183-2.467.548-2.599.382-.138.133-.612-1.102-.606-1.234.005-2.364.42-3.803.97a4.34 4.34 0 0 1-.66.193 13.577 13.577 0 0 0-4.08-.143c-2.667.297-4.799 1.558-6.365 3.712C.116 8.436-.327 11.378.215 14.444c.57 3.233 2.22 5.91 4.755 8.002 2.63 2.17 5.658 3.233 9.113 3.03 2.098-.122 4.434-.403 7.07-2.633.664.33 1.362.463 2.518.562.892.083 1.75-.044 2.414-.182 1.04-.22.97-1.184.593-1.36-3.05-1.421-2.38-.843-2.99-1.311 1.55-1.834 3.918-5.093 4.648-9.531.072-.49.164-1.18.153-1.577-.006-.242.05-.336.326-.364a5.903 5.903 0 0 0 2.187-.672c1.977-1.08 2.774-2.853 2.962-4.978.028-.325-.006-.661-.35-.832ZM16.39 21.73c-2.956-2.324-4.39-3.089-4.982-3.056-.554.033-.454.667-.332 1.08.127.407.293.688.526 1.046.16.237.271.59-.161.854-.952.589-2.607-.198-2.685-.237-1.927-1.134-3.537-2.632-4.673-4.68-1.096-1.972-1.733-4.087-1.838-6.345-.028-.545.133-.738.676-.837A6.643 6.643 0 0 1 5.086 9.5c3.017.441 5.586 1.79 7.74 3.927 1.229 1.217 2.159 2.671 3.116 4.092 1.02 1.509 2.115 2.946 3.51 4.125.494.413.887.727 1.263.958-1.135.127-3.028.154-4.324-.87v-.002Zm1.417-9.114a.434.434 0 0 1 .587-.408c.06.022.117.055.16.105a.426.426 0 0 1 .122.303.434.434 0 0 1-.437.435.43.43 0 0 1-.432-.435Zm4.402 2.257c-.283.116-.565.215-.836.226-.421.022-.88-.149-1.13-.358-.387-.325-.664-.506-.78-1.073-.05-.242-.022-.617.022-.832.1-.463-.011-.76-.338-1.03-.265-.22-.603-.28-.974-.28a.8.8 0 0 1-.36-.11c-.155-.078-.283-.27-.161-.508.039-.077.227-.264.271-.297.504-.286 1.085-.193 1.623.022.498.204.875.578 1.417 1.107.553.639.653.815.968 1.295.25.374.476.76.632 1.2.094.275-.028.5-.354.638Z"></path></svg>';

    const ICON_ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    const ICON_DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="m19 6-.867 12.142A2 2 0 0 1 16.138 20H7.862a2 2 0 0 1-1.995-1.858L5 6m5 0V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"/></svg>';
    const ICON_RENAME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    const ICON_ACCOUNT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
    const ICON_SWITCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="11" x2="21" y2="11"/><polyline points="8 21 3 21 3 16"/><line x1="20" y1="13" x2="3" y2="13"/></svg>';
const ICON_MODULES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="10" r="2"/><circle cx="20" cy="14" r="2"/></svg>';

    // ══════════════════════════════════════════════════════════════
    // 8. 多账号切换
    // ══════════════════════════════════════════════════════════════
    function saveAccounts() { GM_setValue(ACCOUNTS_KEY, accounts); GM_setValue(CURRENT_ACCOUNT_KEY, currentAccountId); }
    function getCurrentToken() {
        try {
            const raw = localStorage.getItem('userToken');
            if (!raw) return null;
            try { return JSON.parse(raw).value || raw; } catch (e) { return raw; }
        } catch (e) { return null; }
    }
    function getCurrentAccountName() {
        const token = getCurrentToken();
        if (!token) return '未登录';
        const account = accounts.find(a => a.token === token);
        if (account) return account.name;
        if (currentAccountId) { const acc = accounts.find(a => a.id === currentAccountId); if (acc) return acc.name + ' (已变化)'; }
        return '未命名账号';
    }
    function addAccount(name, email, password) {
        const existing = email ? accounts.find(a => a.email === email) : null;
        if (existing) { alert('该邮箱已存在：' + existing.name); return existing; }
        const id = 'acc_' + Date.now();
        const token = getCurrentToken() || '';
        const newAccount = { id, name: name.trim(), email: email || '', password: password || '', token, addedAt: Date.now() };
        accounts.push(newAccount);
        currentAccountId = id;
        saveAccounts();
        return newAccount;
    }
    function loginWithEmail(email, password) {
        let deviceId = '';
        try { deviceId = localStorage.getItem('device_id') || ''; } catch (e) { }
        if (!deviceId) { const arr = new Uint8Array(48); crypto.getRandomValues(arr); deviceId = btoa(String.fromCharCode(...arr)); }
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST', url: 'https://chat.deepseek.com/api/v0/users/login',
                anonymous: false,
                headers: { 'Content-Type': 'application/json', 'x-client-platform': 'web', 'x-client-version': '2.0.0', 'x-client-locale': 'zh_CN', 'x-app-version': '2.0.0', 'Origin': 'https://chat.deepseek.com', 'Referer': 'https://chat.deepseek.com/sign_in' },
                data: JSON.stringify({ email, mobile: '', password, area_code: '', device_id: deviceId, os: 'web' }),
                onload: function (resp) {
                    try {
                        const data = JSON.parse(resp.responseText);
                        const token = data?.data?.biz_data?.user?.token || data?.data?.user?.token || data?.data?.token || data?.token;
                        if (token) resolve(token);
                        else reject(new Error(data?.message || data?.msg || data?.error || '未获取到token'));
                    } catch (e) { reject(new Error('解析登录响应失败：' + resp.responseText.substring(0, 200))); }
                },
                onerror: function (e) { reject(new Error('登录请求失败')); },
                ontimeout: function () { reject(new Error('登录请求超时')); },
                timeout: 15000
            });
        });
    }
    function switchAccount(accountId) {
        const account = accounts.find(a => a.id === accountId);
        if (!account) return false;
        try {
            if (account.email && account.password) {
                loginWithEmail(account.email, account.password).then(newToken => {
                    localStorage.setItem('userToken', JSON.stringify({ value: newToken, __version: '0' }));
                    account.token = newToken;
                    currentAccountId = accountId;
                    saveAccounts();
                    location.reload();
                }).catch(err => { alert('登录失败：' + err.message); });
                return true;
            }
            const wrapped = account.token.startsWith('{') ? account.token : JSON.stringify({ value: account.token, __version: '0' });
            localStorage.setItem('userToken', wrapped);
            currentAccountId = accountId;
            saveAccounts();
            return true;
        } catch (e) { return false; }
    }
    function deleteAccount(accountId) {
        const index = accounts.findIndex(a => a.id === accountId);
        if (index > -1) { accounts.splice(index, 1); if (currentAccountId === accountId) currentAccountId = accounts.length > 0 ? accounts[0].id : null; saveAccounts(); return true; }
        return false;
    }
    function renameAccount(accountId, newName) {
        const account = accounts.find(a => a.id === accountId);
        if (account) { account.name = newName.trim(); saveAccounts(); return true; }
        return false;
    }

    // 账号导入导出
    function exportAccounts() {
        const data = {
            version: '4.0',
            exportTime: new Date().toISOString(),
            currentAccountId: currentAccountId,
            accounts: accounts
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `deepseek-accounts-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('账号数据已导出');
    }

    function importAccounts(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => {
                try {
                    const data = JSON.parse(e.target.result);
                    if (!data.accounts || !Array.isArray(data.accounts)) throw new Error('无效的账号备份文件：缺少 accounts 字段');
                    const existingIds = new Set(accounts.map(a => a.id));
                    const existingEmails = new Set(accounts.map(a => a.email).filter(Boolean));
                    let imported = 0;
                    const toAdd = [];
                    for (const acc of data.accounts) {
                        if (!acc.name && !acc.token && !acc.email) continue; // 跳过空记录
                        if (acc.email && existingEmails.has(acc.email)) continue; // 邮箱重复则跳过
                        const newAcc = { ...acc };
                        if (existingIds.has(newAcc.id)) {
                            newAcc.id = 'acc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                        }
                        existingIds.add(newAcc.id);
                        if (newAcc.email) existingEmails.add(newAcc.email);
                        toAdd.push(newAcc);
                        imported++;
                    }
                    accounts.push(...toAdd);
                    saveAccounts();
                    if (data.currentAccountId && accounts.some(a => a.id === data.currentAccountId)) {
                        currentAccountId = data.currentAccountId;
                        GM_setValue(CURRENT_ACCOUNT_KEY, currentAccountId);
                    }
                    resolve({ imported, total: data.accounts.length });
                } catch (err) { reject(err); }
            };
            reader.onerror = () => reject(new Error('文件读取失败'));
            reader.readAsText(file);
        });
    }
    function renderAccountListHTML() {
        const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        if (accounts.length === 0) return '<div class="dsp-hint" style="text-align:center;padding:12px;">暂无保存的账号<br>点击下方按钮保存当前账号</div>';
        return accounts.map(a => {
            const isCurrent = a.id === currentAccountId;
            const infoText = a.email ? a.email : (a.token ? a.token.substring(0, 12) + '...' : '(空)');
            const timeStr = a.addedAt ? new Date(a.addedAt).toLocaleDateString() : '';
            return `<div class="dsp-account-item ${isCurrent ? 'current' : ''}" data-account-id="${a.id}">
                <div class="dsp-account-info"><div class="dsp-account-name">${esc(a.name)}</div><div class="dsp-account-token">${esc(infoText)} · ${timeStr}</div></div>
                <div class="dsp-account-actions">
                    <button class="dsp-preset-btn dsp-account-switch" data-id="${a.id}" title="切换到此账号">${ICON_SWITCH}</button>
                    <button class="dsp-preset-btn dsp-account-rename-btn" data-id="${a.id}" title="重命名">${ICON_RENAME}</button>
                    <button class="dsp-preset-btn danger dsp-account-delete-btn" data-id="${a.id}" title="删除">${ICON_DELETE}</button>
                </div>
            </div>`;
        }).join('');
    }

    // ══════════════════════════════════════════════════════════════
    // 9. 创建 UI
    // ══════════════════════════════════════════════════════════════
    function createUI() {
        if (document.querySelector('.dsp-fab-container')) return;

        const fabContainer = document.createElement('div');
        fabContainer.className = 'dsp-fab-container';

        const anyEnabled = isEnabled || prefixEnabled;
        const quickToggle = document.createElement('button');
        quickToggle.className = `dsp-quick-toggle ${anyEnabled ? 'on' : ''}`;
        quickToggle.title = anyEnabled ? '点击关闭所有注入' : '点击开启所有注入';
        quickToggle.innerHTML = `
            <span class="icon-on"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></span>
            <span class="icon-off"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
        `;

        const fab = document.createElement('button');
        const hasContent = systemPrompt || (messagePrefix && prefixEnabled);
        fab.className = `dsp-fab ${(isEnabled || prefixEnabled) && hasContent ? 'active' : 'inactive'}`;
        fab.innerHTML = DEEPSEEK_ICON;
        fab.title = 'DeepSeek 套件';

        fabContainer.appendChild(quickToggle);
        fabContainer.appendChild(fab);

        const accountFab = document.createElement('button');
        accountFab.className = 'dsp-fab dsp-account-fab';
        accountFab.innerHTML = ICON_ACCOUNT;
        accountFab.title = '多账号切换';
        fabContainer.appendChild(accountFab);
        const modulesFab = document.createElement('button');
        modulesFab.className = 'dsp-fab dsp-modules-fab';
        modulesFab.innerHTML = ICON_MODULES;
        modulesFab.title = '功能模块';
        fabContainer.appendChild(modulesFab);

        const panel = document.createElement('div');
        panel.className = 'dsp-panel';
        panel.innerHTML = `
            <div class="dsp-header">
                <div class="dsp-header-main">
                    <div class="dsp-title">🎭 DeepSeek 套件</div>
                    <div class="dsp-subtitle">SP Injector v4.0.0 · 套件版</div>
                </div>
            </div>
            <div class="dsp-body">

                <div class="dsp-section">
                    <div class="dsp-label">📚 预设</div>
                    <div class="dsp-preset-bar">
                        <select class="dsp-preset-select" id="dsp-preset-select">
                            ${presets.map(p => `<option value="${p.id}" ${p.id === currentPresetId ? 'selected' : ''}>${p.name}</option>`).join('')}
                        </select>
                        <button class="dsp-preset-btn" id="dsp-preset-add" title="新建空预设">${ICON_ADD}</button>
                        <button class="dsp-preset-btn" id="dsp-preset-rename" title="重命名">${ICON_RENAME}</button>
                        <button class="dsp-preset-btn danger" id="dsp-preset-delete" title="删除预设">${ICON_DELETE}</button>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
                        <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-export">📤 导出</button>
                        <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-import">📥 导入</button>
                    </div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-label"><span>系统提示词</span><span class="count" id="dsp-count">${systemPrompt.length} 字符</span></div>
                    <textarea class="dsp-textarea prompt" id="dsp-input" placeholder="输入你的系统提示词...">${systemPrompt}</textarea>
                    <div class="dsp-variables-hint">
                        <span class="dsp-variables-toggle" id="dsp-vars-toggle">🧩 可用变量 ▼</span>
                        <div class="dsp-variables-list" id="dsp-vars-list">
                            <code>{date}</code> 日期 · <code>{time}</code> 时间 · <code>{datetime}</code> 日期时间<br>
                            <code>{year}</code> 年 · <code>{month}</code> 月 · <code>{day}</code> 日<br>
                            <code>{hour}</code> 时 · <code>{minute}</code> 分 · <code>{weekday}</code> 星期<br>
                            <code>{timestamp}</code> 时间戳 · <code>{random}</code> 随机字符串
                        </div>
                    </div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-label">注入格式</div>
                    <div class="dsp-format-group">
                        <button class="dsp-format-btn ${useNativeFormat ? 'active' : ''}" id="dsp-fmt-native">🔮 原生 Token</button>
                        <button class="dsp-format-btn ${!useNativeFormat ? 'active' : ''}" id="dsp-fmt-custom">✏️ 自定义模板</button>
                    </div>
                </div>

                <div class="dsp-section" id="dsp-template-section" style="display:${useNativeFormat ? 'none' : 'block'}">
                    <div class="dsp-label">自定义模板</div>
                    <textarea class="dsp-textarea template" id="dsp-template" placeholder="{system}&#10;---&#10;{user}">${customTemplate}</textarea>
                    <div class="dsp-hint">占位符: <code>{system}</code> 系统提示词 · <code>{user}</code> 用户消息</div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-label"><span>📝 消息前缀</span><div class="dsp-toggle dsp-toggle-small ${prefixEnabled ? 'on' : ''}" id="dsp-prefix-toggle"></div></div>
                    <textarea class="dsp-textarea template" id="dsp-prefix-input" placeholder="当前日期是 {date}，时间是 {time}。">${messagePrefix}</textarea>
                    <div class="dsp-hint">每条用户消息前自动添加此内容，支持变量替换</div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-preview"><div class="dsp-preview-title">预览</div><div id="dsp-preview-content"></div></div>
                </div>

                <div class="dsp-section">
                    <div class="dsp-label"><span>🐛 调试模式</span><div class="dsp-toggle dsp-toggle-small ${debugModeEnabled ? 'on' : ''}" id="dsp-debug-toggle"></div></div>
                    <div class="dsp-hint">开启后显示消息 ID 和 token 数（需刷新页面）</div>
                </div>
            </div>
            <div class="dsp-footer">
                <div class="dsp-footer-row">
                    <button class="dsp-btn dsp-btn-secondary" id="dsp-cancel">取消</button>
                    <button class="dsp-btn dsp-btn-primary" id="dsp-save">保存设置</button>
                </div>
            </div>
            <input type="file" class="dsp-file-input" id="dsp-file-input" accept=".json">
        `;

        document.body.appendChild(fabContainer);
        document.body.appendChild(panel);

        // --- 账号面板 ---
        const accountPanel = document.createElement('div');
        accountPanel.className = 'dsp-panel dsp-account-panel';
        function refreshAccountPanel() {
            const listEl = accountPanel.querySelector('#dsp-account-list');
            const nameEl = accountPanel.querySelector('#dsp-current-account-name');
            if (listEl) listEl.innerHTML = renderAccountListHTML();
            if (nameEl) nameEl.textContent = '当前：' + getCurrentAccountName();
            bindAccountPanelEvents();
        }
        function bindAccountPanelEvents() {
            accountPanel.querySelectorAll('.dsp-account-switch').forEach(btn => {
                btn.onclick = () => {
                    const id = btn.dataset.id;
                    if (switchAccount(id)) {
                        const acc = accounts.find(a => a.id === id);
                        if (!acc?.email) location.reload();
                    }
                };
            });
            accountPanel.querySelectorAll('.dsp-account-rename-btn').forEach(btn => {
                btn.onclick = () => {
                    const id = btn.dataset.id;
                    const item = btn.closest('.dsp-account-item');
                    const nameEl = item.querySelector('.dsp-account-name');
                    const oldName = nameEl.textContent;
                    const input = document.createElement('input');
                    input.value = oldName;
                    input.className = 'dsp-textarea template';
                    input.style.cssText = 'height:28px;font-size:13px;padding:4px 8px;width:100%;';
                    nameEl.replaceWith(input);
                    input.focus(); input.select();
                    const done = () => {
                        const v = input.value.trim();
                        if (v && v !== oldName) { renameAccount(id, v); refreshAccountPanel(); }
                        else input.replaceWith(nameEl);
                    };
                    input.addEventListener('blur', done);
                    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = oldName; input.blur(); } });
                };
            });
            accountPanel.querySelectorAll('.dsp-account-delete-btn').forEach(btn => {
                btn.onclick = () => {
                    const id = btn.dataset.id;
                    const account = accounts.find(a => a.id === id);
                    if (confirm('确定删除账号 "' + (account?.name || '') + '"？')) { deleteAccount(id); refreshAccountPanel(); }
                };
            });
        }
        accountPanel.innerHTML = `
            <div class="dsp-header"><div class="dsp-header-main"><div class="dsp-title">👤 账号切换</div><div class="dsp-subtitle" id="dsp-current-account-name">当前：${getCurrentAccountName()}</div></div></div>
            <div class="dsp-body">
                <div class="dsp-section">
                    <div class="dsp-label"><span>已保存的账号</span><span class="count">${accounts.length} 个</span></div>
                    <div id="dsp-account-list" style="display:flex;flex-direction:column;gap:8px;">${renderAccountListHTML()}</div>
                    <div style="margin-top:10px;">
                        <div class="dsp-account-form" id="dsp-account-form" style="display:none;">
                            <input class="dsp-textarea template" id="dsp-acc-name" placeholder="账号名称" style="height:32px;margin-bottom:6px;" value="${getCurrentAccountName()}">
                            <input class="dsp-textarea template" id="dsp-acc-email" placeholder="邮箱地址" style="height:32px;margin-bottom:6px;">
                            <input class="dsp-textarea template" id="dsp-acc-password" type="password" placeholder="密码" style="height:32px;margin-bottom:6px;">
                            <div style="display:flex;gap:6px;">
                                <button class="dsp-btn dsp-btn-primary dsp-btn-small" id="dsp-acc-save">💾 保存</button>
                                <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-acc-cancel">取消</button>
                            </div>
                        </div>
                        <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-account-add">➕ 添加账号</button>
                    </div>
                </div>
            </div>
            <div class="dsp-footer">
                <div class="dsp-footer-row three">
                    <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-account-export">📤 导出</button>
                    <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-account-import">📥 导入</button>
                    <button class="dsp-btn dsp-btn-secondary dsp-btn-small" id="dsp-account-close">关闭</button>
                </div>
            </div>
            <input type="file" class="dsp-file-input" id="dsp-account-file-input" accept=".json">
        `;
        document.body.appendChild(accountPanel);

        // --- 功能模块面板 ---
        const modulesPanel = document.createElement('div');
        modulesPanel.className = 'dsp-panel dsp-modules-panel';
        modulesPanel.innerHTML = `
            <div class="dsp-header">
                <div class="dsp-header-main">
                    <div class="dsp-title">⚙️ 功能模块</div>
                    <div class="dsp-subtitle">独立控制各模块开关</div>
                </div>
            </div>
            <div class="dsp-body">
                <div class="dsp-section">
                    <div class="dsp-module-list">
                        <div class="dsp-module-item">
                            <span>🎭 系统提示词注入</span>
                            <div class="dsp-toggle dsp-toggle-small ${isEnabled ? 'on' : ''}" id="dsp-module-sp"></div>
                        </div>
                        <div class="dsp-module-item">
                            <span>🛡️ 防撤回</span>
                            <div class="dsp-toggle dsp-toggle-small ${arEnabled ? 'on' : ''}" data-module="ar"></div>
                        </div>
                        <div class="dsp-module-item">
                            <span>🔬 自动专家模式</span>
                            <div class="dsp-toggle dsp-toggle-small ${expertEnabled ? 'on' : ''}" data-module="expert"></div>
                        </div>
                        <div class="dsp-module-item">
                            <span>🌀 html/LaTeX 解析</span>
                            <div class="dsp-toggle dsp-toggle-small ${twistEnabled ? 'on' : ''}" data-module="twist"></div>
                        </div>
                    </div>
                    <div class="dsp-hint">带 ⚠ 标记的模块变更后需刷新页面生效。系统提示词注入即时生效。</div>
                </div>
            </div>
            <div class="dsp-footer">
                <button class="dsp-btn dsp-btn-secondary" id="dsp-modules-close">关闭</button>
            </div>
        `;
        document.body.appendChild(modulesPanel);
        // 账号面板事件
        accountFab.addEventListener('click', e => {
            e.stopPropagation();
            if (panel.classList.contains('open')) panel.classList.remove('open');
            if (modulesPanel.classList.contains('open')) modulesPanel.classList.remove('open');
            accountPanel.classList.toggle('open');
            if (accountPanel.classList.contains('open')) refreshAccountPanel();
        });

        // 功能模块面板事件
        modulesFab.addEventListener('click', e => {
            e.stopPropagation();
            if (panel.classList.contains('open')) panel.classList.remove('open');
            if (accountPanel.classList.contains('open')) accountPanel.classList.remove('open');
            modulesPanel.classList.toggle('open');
        });
        modulesPanel.querySelector('#dsp-modules-close').addEventListener('click', () => modulesPanel.classList.remove('open'));
        accountPanel.querySelector('#dsp-account-close').addEventListener('click', () => accountPanel.classList.remove('open'));
        accountPanel.querySelector('#dsp-account-add').addEventListener('click', () => {
            const form = accountPanel.querySelector('#dsp-account-form');
            const btn = accountPanel.querySelector('#dsp-account-add');
            if (form.style.display === 'none') {
                form.style.display = 'block'; btn.textContent = '✖ 取消添加';
                accountPanel.querySelector('#dsp-acc-name').value = getCurrentAccountName();
                accountPanel.querySelector('#dsp-acc-email').value = '';
                accountPanel.querySelector('#dsp-acc-password').value = '';
            } else { form.style.display = 'none'; btn.textContent = '➕ 添加账号'; }
        });
        accountPanel.querySelector('#dsp-acc-save').addEventListener('click', () => {
            const name = accountPanel.querySelector('#dsp-acc-name').value.trim();
            const email = accountPanel.querySelector('#dsp-acc-email').value.trim();
            const password = accountPanel.querySelector('#dsp-acc-password').value;
            if (!name || !email || !password) { alert('请填写完整信息'); return; }
            addAccount(name, email, password);
            accountPanel.querySelector('#dsp-account-form').style.display = 'none';
            accountPanel.querySelector('#dsp-account-add').textContent = '➕ 添加账号';
            refreshAccountPanel();
        });
        accountPanel.querySelector('#dsp-acc-cancel').addEventListener('click', () => {
            accountPanel.querySelector('#dsp-account-form').style.display = 'none';
            accountPanel.querySelector('#dsp-account-add').textContent = '➕ 添加账号';
        });
        bindAccountPanelEvents();

        // 账号导出导入事件
        const accountFileInput = accountPanel.querySelector('#dsp-account-file-input');
        accountPanel.querySelector('#dsp-account-export').addEventListener('click', () => {
            exportAccounts();
        });
        accountPanel.querySelector('#dsp-account-import').addEventListener('click', () => {
            accountFileInput.click();
        });
        accountFileInput.addEventListener('change', async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const result = await importAccounts(file);
                showToast(`导入成功！新增 ${result.imported} 个账号（共 ${result.total} 个）`);
                refreshAccountPanel();
            } catch (err) {
                alert('导入失败：' + err.message);
            }
            accountFileInput.value = '';
        });


        // --- 主面板元素引用 ---
        const toggle = modulesPanel.querySelector('#dsp-module-sp');
        const input = panel.querySelector('#dsp-input');
        const count = panel.querySelector('#dsp-count');
        const templateInput = panel.querySelector('#dsp-template');
        const templateSection = panel.querySelector('#dsp-template-section');
        const fmtNative = panel.querySelector('#dsp-fmt-native');
        const fmtCustom = panel.querySelector('#dsp-fmt-custom');
        const previewContent = panel.querySelector('#dsp-preview-content');
        const saveBtn = panel.querySelector('#dsp-save');
        const cancelBtn = panel.querySelector('#dsp-cancel');
        const exportBtn = panel.querySelector('#dsp-export');
        const importBtn = panel.querySelector('#dsp-import');
        const fileInput = panel.querySelector('#dsp-file-input');
        const presetSelect = panel.querySelector('#dsp-preset-select');
        const presetAdd = panel.querySelector('#dsp-preset-add');
        const presetRename = panel.querySelector('#dsp-preset-rename');
        const presetDelete = panel.querySelector('#dsp-preset-delete');
        const varsToggle = panel.querySelector('#dsp-vars-toggle');
        const varsList = panel.querySelector('#dsp-vars-list');
        const prefixInput = panel.querySelector('#dsp-prefix-input');
        const prefixToggle = panel.querySelector('#dsp-prefix-toggle');
        const debugToggle = panel.querySelector('#dsp-debug-toggle');

        function escapeHtml(text) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
        function truncate(str, len) { return str.length > len ? str.substring(0, len) + '...' : str; }

        function updatePreview() {
            const sysPrompt = input.value.trim() || '(系统提示词)';
            const userMsg = '(用户消息)';
            const processed = replaceVariables(truncate(sysPrompt, 40));
            let preview;
            if (useNativeFormat) {
                preview = `<span class="token">${escapeHtml(DS_TOKENS.SYSTEM)}</span>${escapeHtml(processed)}<span class="token">${escapeHtml(DS_TOKENS.USER)}</span>${userMsg}`;
            } else {
                const tpl = templateInput.value || DEFAULT_TEMPLATE;
                preview = escapeHtml(replaceVariables(tpl).replace(/\{system\}/g, processed).replace(/\{user\}/g, userMsg));
            }
            previewContent.innerHTML = preview.replace(/\n/g, '<br>');
        }

        function updateFab() {
            const hc = systemPrompt || (messagePrefix && prefixEnabled);
            const ae = isEnabled || prefixEnabled;
            fab.classList.toggle('active', ae && hc);
            fab.classList.toggle('inactive', !(ae && hc));
            quickToggle.classList.toggle('on', ae);
            quickToggle.title = ae ? '点击关闭所有注入' : '点击开启所有注入';
        }

        function refreshPresetSelect() {
            presetSelect.innerHTML = presets.map(p => `<option value="${p.id}" ${p.id === currentPresetId ? 'selected' : ''}>${p.name}</option>`).join('');
        }

        function syncUIFromState() {
            input.value = systemPrompt;
            templateInput.value = customTemplate;
            prefixInput.value = messagePrefix;
            count.textContent = `${systemPrompt.length} 字符`;
            fmtNative.classList.toggle('active', useNativeFormat);
            fmtCustom.classList.toggle('active', !useNativeFormat);
            templateSection.style.display = useNativeFormat ? 'none' : 'block';
            toggle.classList.toggle('on', isEnabled);
            prefixToggle.classList.toggle('on', prefixEnabled);
            refreshPresetSelect();
            updatePreview();
            updateFab();
        }

        // 主面板事件
        fab.addEventListener('click', () => {
            if (accountPanel.classList.contains('open')) accountPanel.classList.remove('open');
            if (modulesPanel.classList.contains('open')) modulesPanel.classList.remove('open');
            panel.classList.toggle('open');
        });
        quickToggle.addEventListener('click', e => {
            e.stopPropagation();
            const ae = isEnabled || prefixEnabled;
            const ns = !ae;
            isEnabled = ns; prefixEnabled = ns;
            GM_setValue(ENABLED_KEY, isEnabled); GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);
            toggle.classList.toggle('on', isEnabled);
            prefixToggle.classList.toggle('on', prefixEnabled);
            updateFab();
        });
        document.addEventListener('click', e => {
            const hit = panel.contains(e.target) || modulesPanel.contains(e.target) || accountPanel.contains(e.target) || fabContainer.contains(e.target);
            if (!hit) { panel.classList.remove('open'); modulesPanel.classList.remove('open'); accountPanel.classList.remove('open'); }
        });
        toggle.addEventListener('click', () => { isEnabled = !isEnabled; GM_setValue(ENABLED_KEY, isEnabled); toggle.classList.toggle('on', isEnabled); updateFab(); });
        input.addEventListener('input', () => { count.textContent = `${input.value.length} 字符`; updatePreview(); });
        templateInput.addEventListener('input', updatePreview);
        fmtNative.addEventListener('click', () => { useNativeFormat = true; fmtNative.classList.add('active'); fmtCustom.classList.remove('active'); templateSection.style.display = 'none'; updatePreview(); });
        fmtCustom.addEventListener('click', () => { useNativeFormat = false; fmtCustom.classList.add('active'); fmtNative.classList.remove('active'); templateSection.style.display = 'block'; updatePreview(); });
        varsToggle.addEventListener('click', () => { const s = varsList.classList.toggle('show'); varsToggle.textContent = s ? '🧩 可用变量 ▲' : '🧩 可用变量 ▼'; });
        prefixToggle.addEventListener('click', () => { prefixEnabled = !prefixEnabled; prefixToggle.classList.toggle('on', prefixEnabled); GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled); updateFab(); });
        debugToggle.addEventListener('click', () => {
            if (debugModeEnabled) { if (confirm('确定关闭调试模式？页面将刷新。')) disableDebugMode(); }
            else { if (confirm('确定开启调试模式？页面将刷新。')) enableDebugMode(); }
        });

        // 模块开关（防撤回/专家/htmlLaTeX）
        modulesPanel.querySelectorAll('.dsp-toggle[data-module]').forEach(el => {
            el.addEventListener('click', () => {
                const m = el.dataset.module;
                const cur = el.classList.toggle('on');
                let key, msg;
                if (m === 'ar') { key = MODULE_AR_KEY; msg = '防撤回'; }
                else if (m === 'expert') { key = MODULE_EXPERT_KEY; msg = '自动专家模式'; }
                else if (m === 'twist') { key = MODULE_TWIST_KEY; msg = 'html/LaTeX 解析'; }
                GM_setValue(key, cur);
                showToast(msg + (cur ? ' 已开启，刷新后生效' : ' 已关闭，刷新后生效'));
            });
        });

        // 预设管理
        presetSelect.addEventListener('change', () => { updateCurrentPreset(); loadPreset(presetSelect.value); syncUIFromState(); });
        presetAdd.addEventListener('click', () => { const name = prompt('请输入新预设名称：'); if (name && name.trim()) { createPreset(name.trim()); loadPreset(presets[presets.length - 1].id); syncUIFromState(); } });
        presetRename.addEventListener('click', () => {
            if (currentPresetId === 'default') { alert('默认预设不能重命名'); return; }
            const preset = presets.find(p => p.id === currentPresetId);
            const n = prompt('请输入新名称：', preset?.name || '');
            if (n && n.trim()) { renamePreset(currentPresetId, n.trim()); refreshPresetSelect(); }
        });
        presetDelete.addEventListener('click', () => {
            if (currentPresetId === 'default') { alert('默认预设不能删除'); return; }
            if (confirm('确定删除当前预设？')) { deletePreset(currentPresetId); syncUIFromState(); }
        });
        exportBtn.addEventListener('click', () => { systemPrompt = input.value.trim(); customTemplate = templateInput.value || DEFAULT_TEMPLATE; updateCurrentPreset(); exportConfig(); });
        importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async e => {
            const file = e.target.files?.[0];
            if (!file) return;
            try { const result = await importConfig(file); alert(`导入成功！新增 ${result.imported} 个预设`); syncUIFromState(); }
            catch (err) { alert('导入失败：' + err.message); }
            fileInput.value = '';
        });
        saveBtn.addEventListener('click', () => {
            systemPrompt = input.value.trim();
            customTemplate = templateInput.value || DEFAULT_TEMPLATE;
            messagePrefix = prefixInput.value;
            GM_setValue(STORAGE_KEY, systemPrompt);
            GM_setValue(FORMAT_KEY, useNativeFormat);
            GM_setValue(TEMPLATE_KEY, customTemplate);
            GM_setValue(PREFIX_KEY, messagePrefix);
            GM_setValue(PREFIX_ENABLED_KEY, prefixEnabled);
            updateCurrentPreset();
            updateFab();
            panel.classList.remove('open');
        });
        cancelBtn.addEventListener('click', () => panel.classList.remove('open'));

        updatePreview();
    }

    // ══════════════════════════════════════════════════════════════
    // 10. DOM 清理器（隐藏显示的注入提示词）
    // ══════════════════════════════════════════════════════════════
    function escapeRegExp(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    const cleanedContentHashes = new WeakMap();
    function simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash = hash & hash; }
        return hash;
    }
    function cleanupDisplayedPrompts(affectedRoots) {
        if (!systemPrompt && !(prefixEnabled && messagePrefix)) return;
        // 增量模式：只扫描受影响的子树；无参数时全量扫描（首次调用）
        let allDivs;
        if (affectedRoots && affectedRoots.length > 0) {
            const divSet = new Set();
            for (const root of affectedRoots) {
                if (!root.isConnected) continue;
                if (root.tagName === 'DIV') divSet.add(root);
                if (root.querySelectorAll) {
                    root.querySelectorAll('div').forEach(d => divSet.add(d));
                }
            }
            allDivs = Array.from(divSet);
        } else {
            allDivs = document.querySelectorAll('div');
        }
        for (let i = 0; i < allDivs.length; i++) {
            const el = allDivs[i];
            if (el.closest('.dsp-fab-container, .dsp-panel, .dsp-fab, .dsp-quick-toggle, .dsp-toast')) continue;
            if (el.classList.contains('dsp-fab-container') || el.classList.contains('dsp-panel') || el.classList.contains('dsp-fab') || el.classList.contains('dsp-quick-toggle') || el.classList.contains('dsp-toast')) continue;
            const text = el.textContent || '';
            const html = el.innerHTML || '';
            const ch = simpleHash(html);
            const lh = cleanedContentHashes.get(el);
            if (lh === ch) continue;
            const hasToken = html.includes('&lt;｜System｜&gt;') || html.includes('&lt;｜User｜&gt;') || text.includes(DS_TOKENS.SYSTEM) || text.includes(DS_TOKENS.USER);
            const spStart = systemPrompt.substring(0, Math.min(20, systemPrompt.length));
            const hasPC = spStart.length >= 10 && text.includes(spStart);
            let hasPrefixC = false;
            if (prefixEnabled && messagePrefix) {
                const fp = messagePrefix.split(/\{[^}]+\}/).filter(p => p.trim());
                hasPrefixC = fp.some(part => text.includes(part.trim()));
            }
            if (hasToken || hasPC || hasPrefixC) {
                const dtl = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).reduce((sum, n) => sum + (n.textContent?.length || 0), 0);
                if (dtl > 10 || (el.children.length === 0 && text.length > 20)) {
                    if (cleanElement(el)) cleanedContentHashes.set(el, simpleHash(el.innerHTML));
                }
            }
        }
    }
    function cleanElement(el) {
        let html = el.innerHTML;
        let text = el.textContent || '';
        let modified = false;
        if (prefixEnabled && messagePrefix) {
            let pp = messagePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            pp = pp.replace(/\\\{date\\\}/g, '\\d{4}-\\d{2}-\\d{2}')
                   .replace(/\\\{time\\\}/g, '\\d{2}:\\d{2}:\\d{2}')
                   .replace(/\\\{datetime\\\}/g, '\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}')
                   .replace(/\\\{year\\\}/g, '\\d{4}').replace(/\\\{month\\\}/g, '\\d{1,2}')
                   .replace(/\\\{day\\\}/g, '\\d{1,2}').replace(/\\\{hour\\\}/g, '\\d{1,2}')
                   .replace(/\\\{minute\\\}/g, '\\d{1,2}').replace(/\\\{weekday\\\}/g, '[日一二三四五六]')
                   .replace(/\\\{weekday_en\\\}/g, '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)')
                   .replace(/\\\{timestamp\\\}/g, '\\d+').replace(/\\\{random\\\}/g, '[a-zA-Z0-9]+');
            pp = pp.replace(/\\n/g, '(?:\\s*\\n\\s*|\\s*<br\\s*/?>\\s*|\\s{2,})*');
            const fp = '^(' + pp + ')(?::|：|\\s*\\n\\s*|\\s*<br\\s*/?>\\s*|\\s{2,})*';
            try {
                const regex = new RegExp(fp, 'i');
                const match = text.match(regex);
                if (match) {
                    const pe = text.indexOf(match[1]) + match[1].length;
                    let tp = 0, hp = 0, fhp = -1;
                    while (hp < html.length && tp < text.length) {
                        const hc = html[hp];
                        if (hc === '<') { const te = html.indexOf('>', hp); if (te > hp) { hp = te + 1; continue; } }
                        if (hc === '&') { const sc = html.indexOf(';', hp); if (sc > hp && sc - hp < 10) { hp = sc + 1; tp++; continue; } }
                        if (hc === text[tp]) {
                            tp++; hp++;
                            if (tp >= pe) {
                                fhp = hp;
                                const rh = html.substring(fhp);
                                const sm = rh.match(/^(?:\s|<[^>]+>|&nbsp;|:|：|<br\s*\/?>|\*\s*)+/i);
                                if (sm) fhp += sm[0].length;
                                break;
                            }
                        } else { if (/\s/.test(hc) && /\s/.test(text[tp])) { hp++; tp++; } else hp++; }
                    }
                    if (fhp > 0) { html = html.substring(fhp); modified = true; }
                }
            } catch (e) { /* fallback */ }
            if (!modified) {
                const fps = messagePrefix.split(/\{[^}]+\}/).filter(p => p.trim().length >= 3);
                if (fps.length > 0) {
                    const sp = fps.sort((a, b) => b.length - a.length)[0].trim();
                    if (text.includes(sp)) {
                        const ei = text.indexOf(sp) + sp.length;
                        let tp = 0, hp = 0;
                        while (hp < html.length && tp < ei) {
                            const hc = html[hp];
                            if (hc === '<') { const te = html.indexOf('>', hp); if (te > hp) { hp = te + 1; continue; } }
                            if (hc === '&') { const sc = html.indexOf(';', hp); if (sc > hp && sc - hp < 10) { hp = sc + 1; tp++; continue; } }
                            if (hc === text[tp]) tp++;
                            hp++;
                        }
                        if (hp > 0 && hp <= html.length) {
                            const am = html.substring(hp).match(/^(?:\s|<[^>]+>|&nbsp;|:|：|<br\s*\/?>|\*\s*)+/i);
                            if (am) hp += am[0].length;
                            html = html.substring(hp); modified = true;
                        }
                    }
                }
            }
        }
        if (modified) el.innerHTML = html;
        return modified;
    }
    function setupDOMObserver() {
        let pendingRoots = new Set();
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === 'childList') {
                    m.addedNodes.forEach(n => { if (n.nodeType === 1) pendingRoots.add(n); });
                }
                if (m.target.nodeType === 1) pendingRoots.add(m.target);
            }
            clearTimeout(window._dspCleanupTimeout);
            window._dspCleanupTimeout = setTimeout(() => {
                if ((systemPrompt && isEnabled) || (prefixEnabled && messagePrefix)) {
                    const roots = Array.from(pendingRoots).filter(n => n.isConnected);
                    cleanupDisplayedPrompts(roots.length > 0 && roots.length < 300 ? roots : null);
                }
                pendingRoots.clear();
            }, 150);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // ══════════════════════════════════════════════════════════════
    // 11. 剪贴板拦截
    // ══════════════════════════════════════════════════════════════
    function cleanTextForClipboard(text) {
        if (!text) return text;
        let cleaned = text;
        if (systemPrompt) {
            cleaned = cleaned.replace(new RegExp(escapeRegExp(DS_TOKENS.SYSTEM) + '[\\s\\S]*?' + escapeRegExp(DS_TOKENS.USER), 'g'), '');
        }
        if (!useNativeFormat && systemPrompt && systemPrompt.length > 10) {
            cleaned = cleaned.replace(new RegExp(escapeRegExp(systemPrompt) + '\\s*(?:---)?\\s*', 'g'), '');
        }
        if (prefixEnabled && messagePrefix) {
            let pp = messagePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            pp = pp.replace(/\\\{date\\\}/g, '\\d{4}-\\d{2}-\\d{2}').replace(/\\\{time\\\}/g, '\\d{2}:\\d{2}:\\d{2}')
                   .replace(/\\\{datetime\\\}/g, '\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}')
                   .replace(/\\\{year\\\}/g, '\\d{4}').replace(/\\\{month\\\}/g, '\\d{2}')
                   .replace(/\\\{day\\\}/g, '\\d{2}').replace(/\\\{hour\\\}/g, '\\d{2}')
                   .replace(/\\\{minute\\\}/g, '\\d{2}').replace(/\\\{weekday\\\}/g, '[日一二三四五六]')
                   .replace(/\\\{weekday_en\\\}/g, '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)')
                   .replace(/\\\{timestamp\\\}/g, '\\d+').replace(/\\\{random\\\}/g, '[a-z0-9]+');
            pp = pp.replace(/\\n/g, '\\n');
            try { cleaned = cleaned.replace(new RegExp(pp, 'g'), ''); } catch (e) { }
        }
        return cleaned;
    }
    function interceptClipboard() {
        document.addEventListener('copy', e => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) return;
            const text = sel.toString();
            const cleaned = cleanTextForClipboard(text);
            if (text !== cleaned) { e.preventDefault(); e.clipboardData.setData('text/plain', cleaned); }
        });
        const clipboard = unsafeWindow.navigator.clipboard;
        if (clipboard && clipboard.writeText) {
            const orig = clipboard.writeText.bind(clipboard);
            unsafeWindow.navigator.clipboard.writeText = async function (text) { return orig(cleanTextForClipboard(text)); };
        }
        const origEC = unsafeWindow.document.execCommand?.bind(unsafeWindow.document);
        if (origEC) {
            unsafeWindow.document.execCommand = function (cmd, ...args) {
                if (cmd === 'copy') {
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed) {
                        const cleaned = cleanTextForClipboard(sel.toString());
                        const te = document.createElement('textarea');
                        te.value = cleaned; te.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
                        document.body.appendChild(te); te.select();
                        const result = origEC('copy');
                        document.body.removeChild(te);
                        return result;
                    }
                }
                return origEC(cmd, ...args);
            };
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 12. 初始化
    // ══════════════════════════════════════════════════════════════
    installXHRHooks();
    interceptFetch();

    function onDOMReady() {
        if (location.hostname !== 'chat.deepseek.com') return;
        createUI();
        setupDOMObserver();
        interceptClipboard();
        if (systemPrompt && isEnabled) setTimeout(cleanupDisplayedPrompts, 200);
        initExpertMode();
        initTwistParser();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onDOMReady);
    } else {
        setTimeout(onDOMReady, 100);
    }

    log('DeepSeek System Prompt Injector v4.0.0 套件版初始化完成');
})();
