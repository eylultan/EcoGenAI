// EcoGenAI Panel Logic
(function () {
  'use strict';

  var ANALOGY_BASELINES = {
    carbon: { googleSearch: 0.2, drivingPerKm: 129.4 },  // 1 Google search = 0.2g CO2e & driving 129.4km in a car = 1g CO2e
    energy: { ledWattage: 10, phoneCharge: 20 },        // a modern smartphone full charge = 20 Wh & a 10W LED bulb =10Wh
    water:  { sipMl: 16, glassMl: 240 },                 // a small sip of water = 16ml & a glass of water = 240ml
  };

  var REGION_LABELS = {
    'europe':        'Europe',
    'north-america': 'North America',
    'asia':          'Asia ',
    'middle-east':   'Middle East',
    'africa':        'Africa',
    'latin-america-and-caribbean': 'Latin America & Caribbean',
    'unknown':       'World (global average grid)',
  };

  var PROVIDER_LABELS = {
    'azure':    'Microsoft Azure',
    'unknown':  'Auto-detected from model',
  };

  var STATUS = {
    idle:    { text: 'Idle' },
    ok:      { text: 'Connected' },
    working: { text: 'Estimating\u2026' },
    error:   { text: 'Backend error' },
  };

  var els = {};
  var promptHistory = [];
  var currentPayload = null;
  var sessionTotals  = { carbon: 0, energy: 0, water: 0, turns: 0 };

  // location mode selection
  var currentLocationMode = 'provider';
  var lastDetectedRegion  = null;      

  function $(id) { return document.getElementById(id); }

  function initEls() {
    var ids = [
      'sessionTotalValue', 'sessionUsage', 'sessionGoal',
      'sessionEnergyValue', 'sessionWaterValue',
      'sessionAnalogyIcon', 'sessionAnalogyText',
      'modelLabel', 'regionLabel',
      'carbonValue', 'energyValue', 'waterValue',
      'carbonMeta', 'energyMeta', 'waterMeta',
      'carbonRange', 'energyRange', 'waterRange',
      'carbonMin', 'carbonEst', 'carbonMax',
      'energyMin', 'energyEst', 'energyMax',
      'waterMin', 'waterEst', 'waterMax',
      'carbonAnalogyIcon', 'carbonAnalogyText',
      'energyAnalogyIcon', 'energyAnalogyText',
      'waterAnalogyIcon', 'waterAnalogyText',
      'lastUpdate', 'debugLine', 'exportBtn',
      'locationProvider', 'locationUserRegion',
      'providerRow', 'providerLabel',
      'regionRow', 'regionSelect', 'regionAuto', 'regionChoose',
      'autoComplexity', 'contextComplexity',
      'tipsToggle', 'tipsContent',
      'methodologyToggle', 'methodologyContent',
      'heroSection',
    ];
    for (var i = 0; i < ids.length; i++) {
      els[ids[i]] = $(ids[i]);
    }
  }

  function fmt(n, digits) {
    if (typeof digits === 'undefined') digits = 2;
    if (typeof n !== 'number' || isNaN(n)) return '\u2014';
    return n.toFixed(digits);
  }

  // Analogies per prompt
  function carbonAnalogy(g) {
    if (typeof g !== 'number' || isNaN(g) || g <= 0) return null;  
    var B = ANALOGY_BASELINES.carbon;
    if (g < 0.0005) return { icon: '\uD83D\uDD0D', text: 'Less than 1 Google search (0.2g CO\u2082e each)' };
    if (g < 2.0) return { icon: '\uD83D\uDD0D', text: '\u2248 ' + (g / B.googleSearch).toFixed(1) + ' Google searches (0.2g CO\u2082e each)' };
    var metres = Math.max(1, Math.round((g / B.drivingPerKm) * 1000));
    return { icon: '\uD83D\uDE97', text: '\u2248 driving ' + metres + ' metres in a car' };
  }
  
  function energyAnalogy(wh) {
    if (typeof wh !== 'number' || isNaN(wh) || wh <= 0) return null; 
    var B = ANALOGY_BASELINES.energy;
    var sec = (wh / B.ledWattage) * 3600;
    if (wh < 0.01) return { icon: '\uD83D\uDCA1', text: 'Less than 1 second of a ' + B.ledWattage + 'W LED bulb' }; 
    if (sec < 1800) {
      return { icon: '\uD83D\uDCA1', text: sec < 60
        ? '\u2248 ' + Math.round(sec) + ' seconds of a ' + B.ledWattage + 'W LED bulb'
        : '\u2248 ' + (sec / 60).toFixed(1) + ' minutes of a ' + B.ledWattage + 'W LED bulb' };
    }
    if (wh < 10) return { icon: '\uD83D\uDD0B', text: '\u2248 ' + Math.round((wh / B.phoneCharge) * 100) + '% of a smartphone charge' };
    return { icon: '\uD83D\uDD0B', text: '\u2248 ' + (wh / B.phoneCharge).toFixed(1) + ' smartphone charges' };
  }
  
  function waterAnalogy(ml) {
    if (typeof ml !== 'number' || isNaN(ml) || ml <= 0) return null; 
    var B = ANALOGY_BASELINES.water;
    if (ml < 5)       return { icon: '\uD83D\uDCA7', text: 'Less than a small sip of water' };
    if (ml < 50)      return { icon: '\uD83D\uDCA7', text: '\u2248 ' + (ml / B.sipMl).toFixed(1) + ' sips of water' };
    if (ml < B.glassMl) return { icon: '\uD83E\uDEA7', text: '\u2248 ' + Math.round((ml / B.glassMl) * 100) + '% of a glass of water' }; 
    return { icon: '\uD83E\uDEA7', text: '\u2248 ' + (ml / B.glassMl).toFixed(1) + ' glasses of water' };
  }
  
  function sessionAnalogy(carbon, energy, water) {
    var B = ANALOGY_BASELINES.energy;
    var Bw = ANALOGY_BASELINES.water;
    if (typeof energy === 'number' && energy > 0.01) {
      var charges = energy / B.phoneCharge;
      if (charges >= 0.01) {
        if (charges < 0.1) return { icon: '\uD83D\uDD0B', text: 'Today you could have charged a smartphone ~' + (charges * 100).toFixed(0) + '% of the way' };
        if (charges < 1)   return { icon: '\uD83D\uDD0B', text: 'Today you could have charged a smartphone ~' + (charges * 100).toFixed(0) + '%' };
        return { icon: '\uD83D\uDD0B', text: 'Today you could have charged a smartphone ~' + charges.toFixed(1) + ' times' };
      }
    }
    if (typeof energy === 'number' && energy > 0) {
      var sec = (energy / B.ledWattage) * 3600;
      if (sec >= 1) return { icon: '\uD83D\uDCA1', text: 'Equivalent to \u223C' + (sec < 60 ? Math.round(sec) + ' seconds' : (sec / 60).toFixed(1) + ' minutes') + ' of ' + B.ledWattage + 'W LED light' };
    }
    if (typeof water === 'number' && water >= 15) {  
      var glasses = water / Bw.glassMl; 
      return { icon: '\uD83D\uDCA7', text: 'Equivalent to \u223C' + (glasses < 1 ? Math.round(water / Bw.sipMl) + ' sips' : glasses.toFixed(1) + ' glasses') + ' of water' };
    }
    return null;
  }

  function setAnalogy(metric, value) {
    var iconEl = els[metric + 'AnalogyIcon'];
    var textEl = els[metric + 'AnalogyText'];
    if (!iconEl || !textEl) return;
    var result = null;
    if (metric === 'carbon') result = carbonAnalogy(value);
    else if (metric === 'energy') result = energyAnalogy(value);
    else if (metric === 'water') result = waterAnalogy(value);
    if (result) { iconEl.textContent = result.icon; textEl.textContent = result.text; }
    else { textEl.textContent = 'Analogy unavailable'; }
  }

  function setSessionAnalogy(sess) {
    if (!els.sessionAnalogyIcon || !els.sessionAnalogyText) return;
    var c = sess && typeof sess.carbon === 'number' ? sess.carbon : 0;
    var e = sess && typeof sess.energy === 'number' ? sess.energy : 0;
    var w = sess && typeof sess.water  === 'number' ? sess.water  : 0;
    var result = sessionAnalogy(c, e, w);
    if (result) { els.sessionAnalogyIcon.textContent = result.icon; els.sessionAnalogyText.textContent = result.text; }
    else { els.sessionAnalogyText.textContent = 'Today you could have\u2026 (send a prompt to see)'; }
  }

  function flashEl(el) {
    if (!el) return;
    el.classList.remove('value-updating');
    void el.offsetWidth;
    el.classList.add('value-updating');
  }

  function updateMetricValueVisualState(el) {
    if (!el) return;
    var txt = (el.textContent || '').toLowerCase();
    var isPlaceholder = txt === '\u2014' || txt.indexOf('enter your') !== -1 || txt.indexOf('detecting') !== -1 || txt.indexOf('waiting for prompt') !== -1;
    el.classList.toggle('is-placeholder', isPlaceholder);
  }

  function setRangeSpectrum(metric, low, mid, high, unit, digits) {
    var minEl   = els[metric + 'Min'];
    var estEl   = els[metric + 'Est'];
    var maxEl   = els[metric + 'Max'];
    var rangeEl = els[metric + 'Range'];
    if (minEl)   minEl.textContent = fmt(low, digits);
    if (estEl)   estEl.textContent = 'Point: ' + fmt(mid, digits);
    if (maxEl)   maxEl.textContent = fmt(high, digits);
    if (rangeEl) rangeEl.textContent = 'Estimated range: ' + fmt(low, digits) + '\u2013' + fmt(high, digits) + ' ' + unit + ' (point estimate: ' + fmt(mid, digits) + ').';
  }

  //Location mode button  
  function applyLocationMode(mode) {
    currentLocationMode = mode;
    var isProvider = (mode === 'provider');

    if (els.locationProvider) {
      els.locationProvider.classList.toggle('active', isProvider);
      els.locationProvider.setAttribute('aria-pressed', isProvider ? 'true' : 'false');
    }
    if (els.locationUserRegion) {
      els.locationUserRegion.classList.toggle('active', !isProvider);
      els.locationUserRegion.setAttribute('aria-pressed', !isProvider ? 'true' : 'false');
    }

    if (els.providerRow) els.providerRow.style.display = isProvider ? '' : 'none';
    if (els.regionRow)   els.regionRow.style.display   = isProvider ? 'none' : '';

    if (!isProvider && els.regionSelect && els.regionAuto) {
      var autoMode = els.regionAuto.classList.contains('active');
      els.regionSelect.disabled = autoMode;
      els.regionSelect.style.display = autoMode ? 'none' : '';
    }

    updateLocationLabel();

    postToParent({
      type:           'impact:settings',
      locationMode:   mode,
      regionOverride: isProvider ? 'auto' : (els.regionSelect && !els.regionSelect.disabled ? els.regionSelect.value : 'auto'),
    });
  }

  function updateLocationLabel(isAutoOverride) {
    if (!els.regionLabel) return;
    if (currentLocationMode === 'provider') {
      var providerText = (els.providerLabel && els.providerLabel.textContent && els.providerLabel.textContent !== 'Auto-detected from model')
        ? els.providerLabel.textContent
        : 'Provider (auto-detected)';
      els.regionLabel.textContent = providerText;
    } else {
      var isAuto = (typeof isAutoOverride === 'boolean')
        ? isAutoOverride
        : (els.regionAuto ? els.regionAuto.classList.contains('active') : true);
      if (isAuto) {
        if (lastDetectedRegion && lastDetectedRegion !== 'unknown') {
          els.regionLabel.textContent = REGION_LABELS[lastDetectedRegion] || lastDetectedRegion;
        } else {
          els.regionLabel.textContent = 'Detecting\u2026';
        }
      } else {
        var regionVal = els.regionSelect ? els.regionSelect.value : 'unknown';
        els.regionLabel.textContent = REGION_LABELS[regionVal] || regionVal;
      }
    }
  }

  function setMetrics(payload) {
    if (!payload || typeof payload !== 'object') return;
    currentPayload = payload;

    var carbon_g     = payload.carbon_g;
    var energy_wh    = payload.energy_wh;
    var water_ml     = payload.water_ml;
    var meta         = payload.meta || {};
    var carbon_range = payload.carbon_range || {};
    var energy_range = payload.energy_range || {};
    var water_range  = payload.water_range  || {};
    var sess         = payload.session || {};

    if (sess && typeof sess.carbon === 'number') sessionTotals.carbon = sess.carbon;
    if (sess && typeof sess.energy === 'number') sessionTotals.energy = sess.energy;
    if (sess && typeof sess.water  === 'number') sessionTotals.water  = sess.water;
    if (sess && sess.turns != null)              sessionTotals.turns  = sess.turns;

    if (els.carbonValue) { els.carbonValue.textContent = fmt(carbon_g, 4); flashEl(els.carbonValue); }
    if (els.energyValue) { els.energyValue.textContent = fmt(energy_wh, 4); flashEl(els.energyValue); }
    if (els.waterValue)  { els.waterValue.textContent  = fmt(water_ml, 3);  flashEl(els.waterValue); }
    updateMetricValueVisualState(els.carbonValue);
    updateMetricValueVisualState(els.energyValue);
    updateMetricValueVisualState(els.waterValue);

    if (els.sessionTotalValue) {
      els.sessionTotalValue.textContent = fmt(typeof sess.carbon === 'number' ? sess.carbon : carbon_g, 3);
      flashEl(els.sessionTotalValue);
    }
    if (els.sessionEnergyValue) els.sessionEnergyValue.textContent = fmt(typeof sess.energy === 'number' ? sess.energy : 0, 3);
    if (els.sessionWaterValue)  els.sessionWaterValue.textContent  = fmt(typeof sess.water  === 'number' ? sess.water  : 0, 3);
    if (els.sessionUsage && sess.turns != null) {
      var t = sess.turns;
      els.sessionUsage.textContent = t + (t === 1 ? ' prompt' : ' prompts');
    }

    setSessionAnalogy(sess);

    var heroEl = els.heroSection;
    if (heroEl) {
      var ratio = (typeof sess.carbon === 'number' ? sess.carbon : 0) / 107;
      heroEl.classList.remove('hero--warning', 'hero--danger');
      if (ratio >= 0.8)      heroEl.classList.add('hero--danger');
      else if (ratio >= 0.5) heroEl.classList.add('hero--warning');
    }

    var cLow  = carbon_range.low  != null ? carbon_range.low  : carbon_g;
    var cHigh = carbon_range.high != null ? carbon_range.high : carbon_g;
    var eLow  = energy_range.low  != null ? energy_range.low  : energy_wh;
    var eHigh = energy_range.high != null ? energy_range.high : energy_wh;
    var wLow  = water_range.low   != null ? water_range.low   : water_ml;
    var wHigh = water_range.high  != null ? water_range.high  : water_ml;

    setRangeSpectrum('carbon', cLow, carbon_g, cHigh, 'g CO2e', 4);
    setRangeSpectrum('energy', eLow, energy_wh, eHigh, 'Wh', 4);
    setRangeSpectrum('water',  wLow, water_ml,  wHigh, 'ml', 3);

    setAnalogy('carbon', carbon_g);
    setAnalogy('energy', energy_wh);
    setAnalogy('water',  water_ml);

    if (meta.model_label && meta.model_label !== 'unknown' && els.modelLabel) {
      els.modelLabel.textContent = meta.model_label;
    }

    if (meta.provider && els.providerLabel) {
      els.providerLabel.textContent = PROVIDER_LABELS[meta.provider] || meta.provider;
    }

    if (meta.region) {
      lastDetectedRegion = meta.region;
    }

    updateLocationLabel();

    if (meta.complexity) {
      var cat   = meta.complexity;
      var fac   = meta.complexity_factor;
      var labelMap = {
        simple: 'Simple',
        'medium reasoning': 'Medium',
        'high reasoning': 'High',
      };
      var label = labelMap[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1));
      var full  = label + (typeof fac === 'number' ? ' (\u00d7' + fac + ')' : '');
      if (els.contextComplexity) els.contextComplexity.textContent = full;
      if (els.autoComplexity)    els.autoComplexity.textContent    = full;
    }

    if (els.lastUpdate) els.lastUpdate.textContent = new Date().toLocaleTimeString();

    var sessionTurn = (sess && typeof sess.turns === 'number') ? sess.turns : null;
    var nextEntry = {
      turn_index:    promptHistory.length + 1,
      timestamp:     new Date().toISOString(),
      model:         meta.model_label  || meta.model || 'unknown',
      region:        meta.region       || 'unknown',
      provider:      meta.provider     || 'unknown',
      location_mode: meta.location_mode || currentLocationMode,
      complexity:    meta.complexity   || 'simple',
      tokens_in:     meta.tokens_in    || '',
      tokens_out:    meta.tokens_out   || '',
      tokens_total:  meta.tokens_total || '',
      energy_wh: energy_wh, energy_low: eLow, energy_high: eHigh,
      carbon_g:  carbon_g,  carbon_low: cLow, carbon_high: cHigh,
      water_ml:  water_ml,  water_low:  wLow, water_high:  wHigh,
      _session_turn: sessionTurn,
    };

    var lastEntry = promptHistory.length ? promptHistory[promptHistory.length - 1] : null;
    if (
      lastEntry &&
      sessionTurn != null &&
      lastEntry._session_turn === sessionTurn
    ) {

      nextEntry.turn_index = lastEntry.turn_index;
      promptHistory[promptHistory.length - 1] = nextEntry;
    } else {
      promptHistory.push(nextEntry);
    }
  }

  function setStatus(kind) {
    var s = STATUS[kind] || STATUS.idle;
    if (els.debugLine) {
      els.debugLine.textContent = s.text === 'Connected' ? 'Listening on this page\u2026' : s.text;
    }
  }

  function exportCsv() {
    if (promptHistory.length === 0) {
      alert('No data to export yet. Send at least one prompt to ChatGPT first.');
      return;
    }
    var headers = [
      'turn_index', 'timestamp', 'model', 'region', 'provider', 'location_mode', 'complexity',
      'tokens_in', 'tokens_out', 'tokens_total',
      'energy_wh', 'energy_low', 'energy_high',
      'carbon_g',  'carbon_low', 'carbon_high',
      'water_ml',  'water_low',  'water_high',
    ];
    var rows = [headers.join(',')];
    for (var i = 0; i < promptHistory.length; i++) {
      var r = promptHistory[i];
      var row = [];
      for (var j = 0; j < headers.length; j++) {
        var val = r[headers[j]];
        if (typeof val === 'string' && val.indexOf(',') !== -1) row.push('"' + val + '"');
        else if (val == null) row.push('');
        else row.push(String(val));
      }
      rows.push(row.join(','));
    }
    rows.push('');
    rows.push('SESSION TOTALS (this session)');
    rows.push('carbon_g,energy_wh,water_ml,prompts');
    rows.push([sessionTotals.carbon, sessionTotals.energy, sessionTotals.water, sessionTotals.turns].join(','));
    var csv  = rows.join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url;
    a.download = 'ecogenai-report-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function postToParent(msg) {
    if (window.parent) window.parent.postMessage(msg, '*');
  }

  function init() {
    initEls();
    setStatus('idle');
    updateMetricValueVisualState(els.carbonValue);
    updateMetricValueVisualState(els.energyValue);
    updateMetricValueVisualState(els.waterValue);

    window.addEventListener('message', function (event) {
      var data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'impact:status') {
        setStatus(data.kind);
        if (typeof data.debug === 'string' && els.debugLine) els.debugLine.textContent = data.debug;
        return;
      }
      if (data.type === 'impact:update') {
        if (data.payload) setMetrics(data.payload);
        if (typeof data.debug === 'string' && els.debugLine) els.debugLine.textContent = data.debug;
        setStatus('ok');
        return;
      }
      if (data.type === 'impact:detected') {
        if (data.model !== undefined && els.modelLabel) {
          els.modelLabel.textContent = (data.model === 'unknown' ? 'Detecting\u2026' : data.model);
        }
        if (data.region !== undefined) {
          lastDetectedRegion = data.region;
          updateLocationLabel();
        }
      }
    });

    document.querySelectorAll('.card').forEach(function (card) {
      var header = card.querySelector('.cardHeader');
      if (!header) return;
      header.addEventListener('click', function () {
        var isCollapsed = card.classList.toggle('collapsed');
        header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      });
      card.classList.add('collapsed');
      header.setAttribute('aria-expanded', 'false');
    });

    if (els.exportBtn) els.exportBtn.addEventListener('click', exportCsv);

    if (els.locationProvider) {
      els.locationProvider.addEventListener('click', function () { applyLocationMode('provider'); });
    }
    if (els.locationUserRegion) {
      els.locationUserRegion.addEventListener('click', function () { applyLocationMode('user-region'); });
    }

    if (els.regionAuto && els.regionChoose && els.regionSelect) {
      function setRegionMode(auto) {
        els.regionAuto.classList.toggle('active', auto);
        els.regionChoose.classList.toggle('active', !auto);
        els.regionAuto.setAttribute('aria-pressed', auto ? 'true' : 'false');
        els.regionChoose.setAttribute('aria-pressed', !auto ? 'true' : 'false');
        els.regionSelect.disabled = auto;
        els.regionSelect.style.display = auto ? 'none' : '';
        updateLocationLabel(auto); 
        postToParent({
          type:           'impact:settings',
          locationMode:   'user-region',
          regionOverride: auto ? 'auto' : els.regionSelect.value,
        });
      }
      els.regionAuto.addEventListener('click',   function () { setRegionMode(true); });
      els.regionChoose.addEventListener('click', function () { setRegionMode(false); });
      els.regionSelect.addEventListener('change', function () {
        updateLocationLabel(false);  
        postToParent({
          type:           'impact:settings',
          locationMode:   'user-region',
          regionOverride: els.regionSelect.value,
        });
      });
    }


    var tipsToggle  = els.tipsToggle;
    var tipsContent = els.tipsContent;
    if (tipsToggle && tipsContent) {
      tipsToggle.addEventListener('click', function () {
        var isExpanded = tipsToggle.getAttribute('aria-expanded') === 'true';
        tipsToggle.setAttribute('aria-expanded', String(!isExpanded));
        tipsContent.style.display = isExpanded ? 'none' : 'block';
        tipsToggle.textContent = isExpanded
          ? '\uD83D\uDCA1 How to reduce your impact \u25B8'
          : '\uD83D\uDCA1 How to reduce your impact \u25BE';
      });
    }


    var toggle  = els.methodologyToggle;
    var content = els.methodologyContent;
    if (toggle && content) {
      toggle.addEventListener('click', function () {
        var expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        content.style.display = expanded ? 'none' : 'block';
        toggle.textContent = expanded ? 'How are estimates made? \u25B8' : 'How are estimates made? \u25BE';
        if (expanded && els.technicalToggle && els.technicalContent) {
          els.technicalToggle.setAttribute('aria-expanded', 'false');
          els.technicalContent.style.display = 'none';
          els.technicalToggle.textContent = 'How it works (technical) \u25B8';
        }
      });
    }

  
    applyLocationMode('provider');
    postToParent({ type: 'impact:panel-ready' });
  }

  init();
})();