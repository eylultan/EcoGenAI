// Handles DOM interactions & backend communication

(() => {
  var ext = (typeof browser !== 'undefined' && browser && browser.runtime && browser.runtime.getURL)
    ? browser : (typeof chrome !== 'undefined' && chrome && chrome.runtime && chrome.runtime.getURL)
    ? chrome : null;
  if (!ext) return;

  var DEFAULT_BACKEND_URL = 'http://localhost:8000';
  var PANEL_WIDTH = 360;

  var panelIframe = null;
  var toggleBtn   = null;
  var isOpen      = true;
  var styleTag     = null; 
  var layoutStyleEl = null; 
  var composerEl   = null; 
  var layoutRootEl = null; 

  var settings = { model: 'unknown', region: 'unknown', backendUrl: DEFAULT_BACKEND_URL };
  var lastPayload = null;
  var session = { carbon: 0, energy: 0, water: 0, turns: 0 };
  var lastBroadcastModel = '';
  var lastBroadcastRegion = '';
  var modelSyncStarted = false;
  var modelSyncObserver = null;
  var modelSyncTimer = null;

  var regionOverride     = null;
  var complexityOverride = 'auto';
  var locationMode       = 'provider'; // "provider" or "user-region"

  // Prompt complexity classifier

  function classifyPromptComplexity(text) {
    var lower = (text || '').toLowerCase();
    var words = lower.trim().split(/\s+/);
    var len   = words.length;

    var complexPatterns = [
      'step by step', 'step-by-step', 'analyze', 'analyse', 'compare',
      'contrast', 'evaluate', 'critique', 'debate', 'prove', 'derive',
      'calculate', 'algorithm', 'implement', 'write code', 'build a',
      'design a', 'reason', 'reasoning', 'trade-off', 'tradeoff',
      'pros and cons', 'in detail', 'thoroughly', 'justify', 'explain why', 'multi-step',
      'architecture', 'optimize', 'optimise', 'critically evaluate', 'discuss implications',
      'solve', 'simulate','model', 'debug', 'refactor', 'write a function', 'implement in', 'code example',
      'derive from', 'starting from', 'walk through', 'break down', 'stepwise', 'chain of thought', 'prove that',
      'demonstrate', 'why does',

    ];
    var mediumPatterns = [
      'summarize', 'summarise', 'shorten', 'explain briefly', 'describe', 'list', 'explain the concept',
      'outline', 'paraphrase', 'translate', 'rewrite', 'elaborate',
      'give me', 'tell me about', 'how does', 'what is the difference', 'simplify', 'explain in simple terms',
      'extract key points', 'bullet points', 'convert into', 'reformat', 'condense',
      'key takeaways', 'tldr', 
    ];

    for (var i = 0; i < complexPatterns.length; i++) {
      if (lower.indexOf(complexPatterns[i]) !== -1) return 'reasoning';
    }
    for (var j = 0; j < mediumPatterns.length; j++) {
      if (lower.indexOf(mediumPatterns[j]) !== -1) return 'summarisation';
    }

    var questionCount = (lower.match(/\?/g) || []).length;
    if (questionCount >= 2) return 'reasoning';

    if (len > 60) return 'reasoning';
    if (len > 30)  return 'summarisation';

    return 'simple';
  }

  // Helpers

  // Logs a message to the console
  function log() {
    if (typeof console !== 'undefined' && console.log) {
      var args = ['[EcoGenAI]'];
      for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
      console.log.apply(console, args);
    }
  }

  // Estimates the number of tokens in the text 
  function estimateTokens(text) {
    var s = (text || '').trim();
    if (!s) return 0;
    return Math.max(1, Math.round(s.split(/\s+/).length * 1.33));
  }

  function normalizeBackendUrl(url) {
    var base = url || DEFAULT_BACKEND_URL;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return base;
  }

  // Detects the region based on the timezone
  function detectRegion() {
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    if (tz.indexOf('Europe')  === 0) return 'europe';

    var LATAM_PREFIXES = [
      'America/Mexico_City','America/Cancun','America/Merida','America/Monterrey',
      'America/Matamoros','America/Chihuahua','America/Hermosillo','America/Mazatlan',
      'America/Ojinaga','America/Bahia_Banderas','America/Tijuana','America/Ensenada',
      'America/Bogota','America/Lima','America/Guayaquil','America/La_Paz',
      'America/Caracas','America/Santiago','America/Buenos_Aires',
      'America/Argentina','America/Asuncion','America/Montevideo',
      'America/Sao_Paulo','America/Manaus','America/Belem','America/Fortaleza',
      'America/Recife','America/Maceio','America/Bahia','America/Cuiaba',
      'America/Porto_Velho','America/Boa_Vista','America/Rio_Branco','America/Noronha',
      'America/Guyana','America/Paramaribo','America/Cayenne',
      'America/Havana','America/Jamaica','America/Port-au-Prince',
      'America/Santo_Domingo','America/Puerto_Rico','America/Barbados',
      'America/Martinique','America/Guadeloupe','America/Trinidad',
      'America/Panama','America/Costa_Rica','America/Guatemala',
      'America/Tegucigalpa','America/Managua','America/El_Salvador','America/Belize',
    ];
    for (var i = 0; i < LATAM_PREFIXES.length; i++) {
      if (tz.indexOf(LATAM_PREFIXES[i]) === 0) return 'latin-america';
    }
    if (tz.indexOf('America') === 0 || tz.indexOf('US/') === 0) return 'north-america';
    if (tz.indexOf('Asia')    === 0) return 'asia';
    if (tz.indexOf('Dubai') !== -1 || tz.indexOf('Riyadh') !== -1 || tz.indexOf('Qatar') !== -1)
      return 'middle-east';
    return 'unknown';
  }

  // Detects the ChatGPT model
  function detectChatGptModel() {
    var el = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    if (el) {
      var txt = (el.innerText || el.textContent || '').trim();
      if (txt) { log('Model from data-testid:', txt); return txt; }
    }
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var t = (buttons[i].innerText || '').trim().toLowerCase();
      if (t.indexOf('gpt') !== -1 || t.indexOf('chatgpt') !== -1) {
        var label = buttons[i].innerText.trim();
        log('Model from button scan:', label);
        return label;
      }
    }
    log('Model detection: no match, using unknown');
    return 'unknown';
  }

  function modelLabelToKey(label) {
    var l = (label || '').toLowerCase();
  
    //  GPT-4 family 
    if (l.indexOf('4o-mini') !== -1 || l.indexOf('4o mini') !== -1) return 'gpt-4o-mini';
    if (l.indexOf('4.5')     !== -1) return 'gpt-4.5';
    if (l.indexOf('4.1')     !== -1) return 'gpt-4.1';
    if (l.indexOf('4o')      !== -1) return 'gpt-4o';
    if (l.indexOf('3.5')     !== -1) return 'gpt-3.5';
  
    // GPT-5.x versioned 
    if (l.indexOf('5.4') !== -1 && (l.indexOf('think') !== -1 || l.indexOf('reason') !== -1)) return 'chatgpt-thinking';
    if (l.indexOf('5.4') !== -1 && l.indexOf('pro')   !== -1) return 'chatgpt-pro';
    if (l.indexOf('5.4') !== -1)                              return 'chatgpt-thinking';
    if (l.indexOf('5.3') !== -1)                              return 'chatgpt-instant';
    if (l.indexOf('5.2') !== -1 && (l.indexOf('think') !== -1 || l.indexOf('reason') !== -1)) return 'gpt-5.2-thinking';
    if (l.indexOf('5.2') !== -1)                              return 'gpt-5.2-instant';
    if (l.indexOf('5.1') !== -1 && (l.indexOf('think') !== -1 || l.indexOf('reason') !== -1)) return 'gpt-5.1-thinking';
    if (l.indexOf('5.1') !== -1)                              return 'gpt-5.1-instant';
  
    // GPT-5 base 
    if (l.indexOf('gpt-5') !== -1 || l.indexOf('gpt 5') !== -1) return 'gpt-5';
  
    // ChatGPT Auto 

    if (l.indexOf('auto') !== -1) return 'chatgpt-auto';
  
    // ChatGPT generic

    if (l.indexOf('chatgpt') !== -1) return 'chatgpt-auto';
  
    // Fallback for any other GPT label 
    if (l.indexOf('gpt') !== -1) return 'gpt-4o';
  
    // o-series
    if (l.indexOf('o4-mini') !== -1) return 'o4-mini-high';
    if (l.indexOf('o3-mini') !== -1 && l.indexOf('high') !== -1) return 'o3-mini-high';
    if (l.indexOf('o3-mini') !== -1) return 'o3-mini';
    if (l.indexOf('o3-pro') !== -1) return 'o3-pro';
    if (l.indexOf('o3')      !== -1) return 'o3';
    return 'unknown';
  }

  // Panel communication

  function sendToPanel(message) {
    if (!panelIframe || !panelIframe.contentWindow) return;
    panelIframe.contentWindow.postMessage(message, '*');
  }

  function setPanelStatus(kind, debug) {
    sendToPanel({ type: 'impact:status', kind: kind, debug: debug });
  }

  function setPanelUpdate(payload, debug) {
    lastPayload = payload;
    sendToPanel({ type: 'impact:update', payload: payload, debug: debug });
    setTimeout(function () {
      sendToPanel({ type: 'impact:update', payload: payload, debug: debug || 'retry' });
    }, 200);
  }

  
  function broadcastDetectedInfo(force) {
    var model  = detectChatGptModel();
    var region = (regionOverride && regionOverride !== 'auto')
      ? regionOverride
      : detectRegion();
    if (!force && model === lastBroadcastModel && region === lastBroadcastRegion) return;
    settings.model = model;
    lastBroadcastModel = model;
    lastBroadcastRegion = region;
    sendToPanel({ type: 'impact:detected', model: model, region: region });
    log('Broadcast detected — model:', model, 'region:', region);
  }

  function startModelSyncWatcher() {
    if (modelSyncStarted) return;
    modelSyncStarted = true;

    function attachObserverToModelButton() {
      var btn = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
      if (!btn) return false;
      if (modelSyncObserver) modelSyncObserver.disconnect();
      modelSyncObserver = new MutationObserver(function () {
        broadcastDetectedInfo(false);
      });
      modelSyncObserver.observe(btn, { childList: true, subtree: true, characterData: true });
      return true;
    }

    broadcastDetectedInfo(true);
    attachObserverToModelButton();
    setTimeout(function () { broadcastDetectedInfo(false); attachObserverToModelButton(); }, 600);
    setTimeout(function () { broadcastDetectedInfo(false); attachObserverToModelButton(); }, 1800);

    modelSyncTimer = setInterval(function () {
      broadcastDetectedInfo(false);
      attachObserverToModelButton();
    }, 1500);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        broadcastDetectedInfo(false);
        attachObserverToModelButton();
      }
    });
    window.addEventListener('focus', function () {
      broadcastDetectedInfo(false);
      attachObserverToModelButton();
    });
  }

  function ensureStyleTag() {
    if (styleTag && document.head.contains(styleTag)) return;
    styleTag = document.getElementById('ecogenai-styles');
    if (styleTag) return;
    styleTag = document.createElement('style');
    styleTag.id = 'ecogenai-styles';
    styleTag.textContent =
      'html.ecogenai-open body {' +
      '  overflow-x: hidden !important;' +
      '}';
    document.head.appendChild(styleTag);
    log('Layout style tag injected');
  }

  function ensureLayoutStyle() {
    ensureStyleTag();
    layoutStyleEl = styleTag;
    return styleTag;
  }


  function findPrimaryLayoutRoot() {
    var byId = document.getElementById('__next');
    if (byId) return byId;

    var inputEl = findChatGptInput();
    if (inputEl) {
      var best = null;
      var bestWidth = 0;
      var el = inputEl.parentElement;
      while (el && el !== document.body && el !== document.documentElement) {
        var rect = el.getBoundingClientRect();
        var pos = window.getComputedStyle(el).position;
        if (pos !== 'fixed' && rect.width > bestWidth && rect.width >= window.innerWidth * 0.72) {
          best = el;
          bestWidth = rect.width;
        }
        el = el.parentElement;
      }
      if (best) return best;
    }

    var main = document.querySelector('main');
    if (main) return main;
    return document.body;
  }

  function applyNextFix() {
    if (layoutRootEl) {
      layoutRootEl.style.removeProperty('width');
      layoutRootEl.style.removeProperty('max-width');
      layoutRootEl.style.removeProperty('overflow-x');
      layoutRootEl.style.removeProperty('box-sizing');
      layoutRootEl = null;
    }

    var rootEl = findPrimaryLayoutRoot();
    if (!rootEl) return;

    if (isOpen) {
      rootEl.style.setProperty('width', 'calc(100vw - ' + PANEL_WIDTH + 'px)', 'important');
      rootEl.style.setProperty('max-width', 'calc(100vw - ' + PANEL_WIDTH + 'px)', 'important');
      rootEl.style.setProperty('overflow-x', 'hidden', 'important');
      rootEl.style.setProperty('box-sizing', 'border-box', 'important');
      layoutRootEl = rootEl;
      log('Layout root fix applied to', rootEl.tagName, rootEl.id ? ('#' + rootEl.id) : '');
    } else {
    }
  }


  function findComposerRoot(inputEl) {
    var outermost = null;
    var el = inputEl.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      var pos = window.getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') outermost = el;
      el = el.parentElement;
    }
    return outermost;
  }

  function applyComposerFix() {
    if (composerEl) {
      composerEl.style.removeProperty('right');
      composerEl.style.removeProperty('margin-right');
      composerEl = null;
    }
    if (!isOpen) return;

    var inputEl = findChatGptInput();
    if (!inputEl || !document.contains(inputEl)) return;

    var root = findComposerRoot(inputEl);
    if (!root) return;

    composerEl = root;
    var pos = window.getComputedStyle(root).position;
    if (pos === 'fixed') {
      composerEl.style.setProperty('right', PANEL_WIDTH + 'px', 'important');
    } else {
      composerEl.style.setProperty('margin-right', PANEL_WIDTH + 'px', 'important');
    }
    log('Composer fix applied to', root.tagName, '(position:', pos + ')');
  }



  function applyOpenState() {
    if (!panelIframe || !toggleBtn) return;

    ensureLayoutStyle();

    if (isOpen) {
      panelIframe.style.width       = PANEL_WIDTH + 'px';
      panelIframe.style.borderLeft  = '1px solid rgba(0,0,0,0.09)';
   
      document.documentElement.classList.add('ecogenai-open');
      applyNextFix();
      applyComposerFix();
      setTimeout(function () { if (isOpen) { applyNextFix(); applyComposerFix(); } }, 400);
      setTimeout(function () { if (isOpen) { applyNextFix(); applyComposerFix(); } }, 1200);
    } else {
      panelIframe.style.width      = '0px';
      panelIframe.style.borderLeft = '0';
      document.documentElement.classList.remove('ecogenai-open');
      applyNextFix();    
      applyComposerFix(); 
    }

    panelIframe.style.transition = 'width 0.2s ease';
    toggleBtn.textContent = isOpen ? '\u27E9' : '\u27E8';
    toggleBtn.title       = isOpen ? 'Hide EcoGenAI panel' : 'Show EcoGenAI panel';
    toggleBtn.style.right = isOpen ? (PANEL_WIDTH + 'px') : '0px';
  }

  // UI Creation

  function createUi() {
    if (panelIframe) return;

    panelIframe = document.createElement('iframe');
    panelIframe.id  = 'ecogenai-panel';
    panelIframe.src = ext.runtime.getURL('panel.html');
    panelIframe.style.cssText = [
      'position: fixed',
      'top: 0',
      'right: 0',
      'width: ' + PANEL_WIDTH + 'px',
      'height: 100vh',
      'border: 0',
      'border-left: 1px solid rgba(0,0,0,0.09)',
      'background: #f3f4f6',
      'z-index: 2147483646',
      'transition: width 0.2s ease',
    ].join('; ');

    toggleBtn = document.createElement('button');
    toggleBtn.type      = 'button';
    toggleBtn.textContent = '\u27E9';
    toggleBtn.title     = 'Hide EcoGenAI panel';
    toggleBtn.style.cssText = [
      'position: fixed',
      'top: 50px',
      'right: ' + PANEL_WIDTH + 'px',
      'z-index: 2147483647',
      'width: 34px',
      'height: 34px',
      'border: 1px solid rgba(0,0,0,0.12)',
      'border-radius: 12px 0 0 12px',
      'background: rgba(255,255,255,0.95)',
      'color: #374151',
      'backdrop-filter: blur(10px)',
      'cursor: pointer',
      'font-size: 16px',
      'font-weight: 700',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.08)',
      'pointer-events: auto',
    ].join('; ');

    toggleBtn.addEventListener('click', function () {
      isOpen = !isOpen;
      applyOpenState();
    });

    document.documentElement.appendChild(panelIframe);
    document.documentElement.appendChild(toggleBtn);

    applyOpenState();


    window.addEventListener('message', function (event) {
      if (!panelIframe || !panelIframe.contentWindow) return;
      if (event.source !== panelIframe.contentWindow) return;
      var data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'impact:panel-ready') {
        setPanelStatus('ok', 'Panel ready');
        if (lastPayload) setPanelUpdate(lastPayload, 'Cached result');
        sendToPanel({ type: 'impact:status', kind: 'ok', debug: 'Listening on this page\u2026' });
        broadcastDetectedInfo();
        setTimeout(broadcastDetectedInfo, 600);
        setTimeout(broadcastDetectedInfo, 1800);
      }
      if (data.type === 'impact:settings') {
        if (typeof data.regionOverride === 'string') {
          regionOverride = data.regionOverride;
          log('Region override set to:', regionOverride);
        }
        if (typeof data.complexity === 'string') {
          complexityOverride = data.complexity;
          log('Complexity override set to:', complexityOverride);
        }
        if (typeof data.locationMode === 'string') {
          locationMode = data.locationMode;
          log('Location mode set to:', locationMode);
        }
      }
    });
  }

  // Storage

  function getExtApi() {
    if (typeof browser !== 'undefined' && browser && browser.storage && browser.storage.sync) return browser;
    if (typeof chrome  !== 'undefined' && chrome  && chrome.storage  && chrome.storage.sync)  return chrome;
    return null;
  }

  function loadSettings(cb) {
    var api = getExtApi();
    if (!api) { cb(null); return; }
    api.storage.sync.get({ model: 'unknown', backendUrl: DEFAULT_BACKEND_URL }, function (result) {
      cb(result);
    });
  }



  function getLastAssistantText() {
    var messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!messages.length) return '';
    var last = messages[messages.length - 1];
    var md = last.querySelector('.markdown');
    if (md) return (md.innerText || md.textContent || '').trim();
    return (last.innerText || last.textContent || '').trim();
  }

  function getLastUserPromptText() {
    var messages = document.querySelectorAll('[data-message-author-role="user"]');
    if (!messages.length) return '';
    var last = messages[messages.length - 1];
    var md = last.querySelector('.markdown');
    if (md) return (md.innerText || md.textContent || '').trim();
    return (last.innerText || last.textContent || '').trim();
  }

  function isStillGenerating() {
    return !!(
      document.querySelector('[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label="Stop generating"]') ||
      document.querySelector('button[aria-label*="Stop"]')
    );
  }

  function waitForResponseComplete(callback) {
    var lastLength  = 0;
    var stableCount = 0;
    var maxWait     = 120;
    var attempts    = 0;

    var interval = setInterval(function () {
      attempts++;
      if (isStillGenerating()) {
        lastLength  = 0;
        stableCount = 0;
        if (attempts > maxWait) {
          clearInterval(interval);
          callback(getLastAssistantText());
        }
        return;
      }
      var currentText = getLastAssistantText();
      if (currentText.length === lastLength && currentText.length > 0) {
        stableCount++;
      } else {
        lastLength  = currentText.length;
        stableCount = 0;
      }
      if (stableCount >= 3) {
        clearInterval(interval);
        log('Response complete:', currentText.length, 'chars');
        callback(currentText);
        return;
      }
      if (attempts > maxWait) {
        clearInterval(interval);
        log('Timeout — reading partial response:', currentText.length, 'chars');
        callback(currentText);
      }
    }, 500);
  }

  // Backend call

  function sendPromptToBackend(prompt, detectedLabel, onCompleted) {
    if (!prompt || !prompt.trim()) return;
    log('Prompt captured:', prompt.length, 'chars');
    setPanelStatus('working', 'Waiting for response\u2026');

    waitForResponseComplete(function (responseText) {
      var tokens_in  = estimateTokens(prompt);
      var tokens_out = estimateTokens(responseText);
      log('tokens_in:', tokens_in, 'tokens_out:', tokens_out);

      var baseUrl    = normalizeBackendUrl(settings.backendUrl);
      var modelKey   = modelLabelToKey(settings.model || detectedLabel);
      var region = (regionOverride && regionOverride !== 'auto')
        ? regionOverride
        : detectRegion();
      var resolvedComplexity = (complexityOverride === 'auto')
        ? classifyPromptComplexity(prompt)
        : complexityOverride;
      var body = {
        site: location.host,
        model: modelKey,
        region: region,
        location_mode: locationMode,
        complexity: resolvedComplexity,
        prompt: prompt,
        response: responseText,
        tokens_in: tokens_in,
        tokens_out: tokens_out,
      };

      setPanelStatus('working', 'Calling backend\u2026');
      fetch(baseUrl + '/estimate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          return res.json()
            .then(function (data) { return { ok: res.ok, status: res.status, data: data }; })
            .catch(function () { return { ok: res.ok, status: res.status, data: null }; });
        })
        .then(function (result) {
          if (!result.ok) {
            var detail = result.data && result.data.detail ? JSON.stringify(result.data.detail) : 'unknown error';
            throw new Error('Backend ' + result.status + ': ' + detail);
          }
          var data = result.data || {};
          var carbon = Number(data.carbon_g);
          var energy = Number(data.energy_wh);
          var water = Number(data.water_ml);
          if (!isFinite(carbon) || !isFinite(energy) || !isFinite(water)) {
            throw new Error('Backend response missing numeric estimate fields');
          }

          session.carbon += carbon;
          session.energy += energy;
          session.water  += water;
          session.turns  += 1;
          var backendMeta = data.meta || {};
          var payload = {
            carbon_g:     carbon,
            energy_wh:    energy,
            water_ml:     water,
            carbon_range: { low: Number(data.carbon_low), high: Number(data.carbon_high) },
            energy_range: { low: Number(data.energy_low), high: Number(data.energy_high) },
            water_range:  { low: Number(data.water_low), high: Number(data.water_high) },
            session: { carbon: session.carbon, energy: session.energy, water: session.water, turns: session.turns },
            meta: {
              model_label:       detectedLabel,
              model:             backendMeta.model    || modelKey,
              region:            backendMeta.region   || body.region,
              tokens_in:         (backendMeta.tokens_in != null ? backendMeta.tokens_in : tokens_in),
              tokens_out:        (backendMeta.tokens_out != null ? backendMeta.tokens_out : tokens_out),
              tokens_total:      (backendMeta.tokens_total != null ? backendMeta.tokens_total : (tokens_in + tokens_out)),
              complexity:        backendMeta.complexity   || resolvedComplexity,
              complexity_factor: backendMeta.complexity_factor,
              location_mode:     backendMeta.location_mode || locationMode,
              provider:          backendMeta.provider || 'unknown',
            },
          };
          if (!isFinite(payload.carbon_range.low) || !isFinite(payload.carbon_range.high)) {
            payload.carbon_range.low = carbon * 0.75;
            payload.carbon_range.high = carbon * 1.25;
          }
          if (!isFinite(payload.energy_range.low) || !isFinite(payload.energy_range.high)) {
            payload.energy_range.low = energy * 0.80;
            payload.energy_range.high = energy * 1.20;
          }
          if (!isFinite(payload.water_range.low) || !isFinite(payload.water_range.high)) {
            payload.water_range.low = water * 0.65;
            payload.water_range.high = water * 1.35;
          }
          log('Result — carbon:', payload.carbon_g, 'energy:', payload.energy_wh,
              'water:', payload.water_ml, 'turns:', session.turns);
          setPanelUpdate(payload, detectedLabel + ': ' + (tokens_in + tokens_out) + ' total tokens');
          if (typeof onCompleted === 'function') onCompleted(true, responseText);
        })
        .catch(function (e) {
          log('Fetch failed:', String(e));
          setPanelStatus('error', 'Fetch failed: ' + String(e));
          if (typeof onCompleted === 'function') onCompleted(false, '');
        });
    });
  }

  // Input helpers

  function findChatGptInput() {
    var el = document.querySelector('textarea');
    if (el) return el;
    el = document.querySelector('[contenteditable="true"][data-placeholder]');
    if (el) return el;
    el = document.querySelector('div[contenteditable="true"]');
    if (el) return el;
    el = document.querySelector('[role="textbox"]');
    return el || null;
  }

  function getInputValue(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA') return el.value || '';
    return (el.innerText || el.textContent || '').trim();
  }

  // ChatGPT binding
  function attachChatGpt() {
    var inputEl = findChatGptInput();
    if (!inputEl) return false;
    if (inputEl.dataset.ecogenaiBound === '1') return true;
    inputEl.dataset.ecogenaiBound = '1';

    log('Input found, attached to', inputEl.tagName, inputEl.className || '');

    if (isOpen) { applyNextFix(); applyComposerFix(); }

    var detectedLabel = detectChatGptModel();
    settings.model = detectedLabel;
    log('Detected model:', detectedLabel, '->', modelLabelToKey(detectedLabel));

    broadcastDetectedInfo(true);
    setTimeout(function () { broadcastDetectedInfo(false); }, 1000);
    startModelSyncWatcher();

    var lastSentPrompt = '';
    var lastSentTime   = 0;
    var lastRegenPrompt = '';
    var lastRegenTime = 0;
    var regenRequestedAt = 0;
    var pendingRegenProbe = null;
    var estimateInFlight = false;
    var assistantChangeTimer = null;
    var lastEstimatedAssistantText = (getLastAssistantText() || '').trim();
    var sawGenerationCycle = false;

    function requestEstimate(capturedPrompt, source) {
      if (!capturedPrompt || !capturedPrompt.trim()) return;
      estimateInFlight = true;
      sendPromptToBackend(capturedPrompt, detectedLabel, function (ok, responseText) {
        estimateInFlight = false;
        if (!ok) return;
        lastEstimatedAssistantText = (responseText || getLastAssistantText() || '').trim();
        sawGenerationCycle = false;
        log('Estimate completed via', source, '- assistant chars:', lastEstimatedAssistantText.length);
      });
    }

    function onSend(capturedPrompt) {
      if (!capturedPrompt || !capturedPrompt.trim()) return;
      var now = Date.now();
      if (capturedPrompt === lastSentPrompt && (now - lastSentTime) < 2000) return;
      regenRequestedAt = 0;
      sawGenerationCycle = false;
      lastSentPrompt = capturedPrompt;
      lastSentTime   = now;
      requestEstimate(capturedPrompt, 'send');
    }

    function triggerRegenerationEstimate(source) {
      var now = Date.now();
      var promptFromThread = getLastUserPromptText() || lastSentPrompt || getInputValue(inputEl);
      var prompt = (promptFromThread || '').trim();
      if (!prompt) {
        log('Regenerate detected via', source, 'but prompt not found');
        return;
      }
      if (prompt === lastRegenPrompt && (now - lastRegenTime) < 2500) return;
      lastRegenPrompt = prompt;
      lastRegenTime = now;
      lastSentPrompt = prompt;
      lastSentTime = now;
      regenRequestedAt = 0;
      sawGenerationCycle = false;
      log('Regenerate detected via', source, '- re-estimating');
      requestEstimate(prompt, source);
    }

    function probeForRegenAfterAction(source) {
      if (pendingRegenProbe) clearTimeout(pendingRegenProbe);
      var startedAt = Date.now();
      var attempt = function () {
        if ((Date.now() - startedAt) > 10000) {
          pendingRegenProbe = null;
          return;
        }
        if (isStillGenerating()) {
          regenRequestedAt = Date.now();
          triggerRegenerationEstimate(source);
          pendingRegenProbe = null;
          return;
        }
        pendingRegenProbe = setTimeout(attempt, 250);
      };
      pendingRegenProbe = setTimeout(attempt, 120);
    }

  
    inputEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      var p = getInputValue(inputEl);
      log('Keydown Enter, prompt length:', p.length);
      if (p.trim()) onSend(p);
    }, true);

    var form = inputEl.closest('form');
    if (form && !form.dataset.ecogenaiBound) {
      form.dataset.ecogenaiBound = '1';
      form.addEventListener('submit', function () {
        var p = getInputValue(inputEl);
        if (p.trim()) onSend(p);
      });
      log('Form submit listener added');
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (!e.target) return;
      var tag = (e.target.tagName || '').toLowerCase();
      var isInput = tag === 'textarea' || tag === 'input' || (e.target.isContentEditable === true);
      if (!isInput) return;
      var p = getInputValue(e.target) || getInputValue(inputEl);
      if (p && p.trim()) onSend(p);
    }, true);

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest
        ? e.target.closest('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"]')
        : null;
      if (!btn) return;
      var p = getInputValue(inputEl);
      log('Send button clicked, prompt length:', p.length);
      if (p && p.trim()) onSend(p);
    }, true);

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest
        ? e.target.closest(
            'button[data-testid*="retry"], ' +
            'button[data-testid*="regenerate"], ' +
            'button[aria-label*="Try again"], ' +
            'button[aria-label*="Regenerate"], ' +
            'button[title*="Try again"], ' +
            'button[title*="Regenerate"]'
          )
        : null;
      if (!btn) return;
      regenRequestedAt = Date.now();
      triggerRegenerationEstimate('regen-button');
    }, true);

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      if (btn.closest('form')) return; 
      var inAssistantArea = !!btn.closest('[data-message-author-role="assistant"]');
      if (!inAssistantArea) return;

      var hint = (
        (btn.getAttribute('data-testid') || '') + ' ' +
        (btn.getAttribute('aria-label') || '') + ' ' +
        (btn.getAttribute('title') || '') + ' ' +
        (btn.textContent || '')
      ).toLowerCase();

   
      if (
        hint.indexOf('copy') !== -1 ||
        hint.indexOf('like') !== -1 ||
        hint.indexOf('dislike') !== -1 ||
        hint.indexOf('share') !== -1 ||
        hint.indexOf('read aloud') !== -1
      ) {
        return;
      }

      probeForRegenAfterAction('assistant-action');
    }, true);


    var assistantContainer = document.querySelector('main') || document.documentElement;
    function scheduleAssistantTextChangeCheck(source) {
      if (!sawGenerationCycle) return;
      if (assistantChangeTimer) clearTimeout(assistantChangeTimer);
      assistantChangeTimer = setTimeout(function () {
        if (!sawGenerationCycle) return;
        if (estimateInFlight) return;
        if (isStillGenerating()) {
          scheduleAssistantTextChangeCheck(source);
          return;
        }
        var latestAssistantText = (getLastAssistantText() || '').trim();
        if (!latestAssistantText) return;
        if (latestAssistantText === lastEstimatedAssistantText) return;

        var prompt = (getLastUserPromptText() || lastSentPrompt || '').trim();
        if (!prompt) return;
        if ((Date.now() - lastSentTime) < 1000) return;

        regenRequestedAt = Date.now();
        triggerRegenerationEstimate(source);
      }, 350);
    }

    var regenObserver = new MutationObserver(function (mutations) {
      if (!regenRequestedAt || (Date.now() - regenRequestedAt) > 45000) return;
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType === 1 &&
              node.getAttribute &&
              node.getAttribute('data-message-author-role') === 'assistant') {
            triggerRegenerationEstimate('observer');
            return;
          }
        }
      }
    });
    regenObserver.observe(assistantContainer, { childList: true, subtree: true });


    var assistantTextObserver = new MutationObserver(function () {
      if (isStillGenerating()) sawGenerationCycle = true;
      scheduleAssistantTextChangeCheck('assistant-text-change');
    });
    assistantTextObserver.observe(assistantContainer, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return true;
  }



  function startInputBinding() {
    var host = location.host;
    log('Content script loaded on', host);

    settings.region = detectRegion();
    log('Detected region:', settings.region);

    var bind = function () {
      if (host === 'chat.openai.com' || host === 'chatgpt.com') return attachChatGpt();
      return true;
    };
    if (bind()) return;

    log('No input yet, observing DOM\u2026');
    var obs = new MutationObserver(function () {
      if (bind()) {
        obs.disconnect();
        log('Input attached via observer');
      }
    });
    obs.observe(document.documentElement, { subtree: true, childList: true });
  }


  function init() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }
    log('Initialising on', location.host);
    createUi();
    loadSettings(function (loaded) {
      if (loaded) settings.backendUrl = loaded.backendUrl || DEFAULT_BACKEND_URL;
      setPanelStatus('ok', 'Ready on ' + location.host);
      startInputBinding();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();