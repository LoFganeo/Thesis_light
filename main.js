// === Mapping Mode Switch ===
let mappingMode = 'A'; // 'A' = instant response, 'B' = accumulated slow fade
let bandAccum = [0,0,0,0,0];
let shapeAccum = [0,0,0,0,0]; // 新添加，用于形态惯性
let modeBAmbientAccum = [0,0,0,0,0];
let modeBPrevFinal = [0,0,0,0,0];
const decayRate = 0.92; // energy decay factor in mode B
const QUALTRICS_PARAMS = (() => {
  try {
    const rawQuery = window.location ? (window.location.search || '') : '';
    console.log('[Qualtrics] raw query:', rawQuery);
    const params = new URLSearchParams(rawQuery);
    console.log('[Qualtrics] params string:', params.toString());
    const userIDRaw = params.get('userID');
    const emailRaw = params.get('email');
    const userID = userIDRaw ? userIDRaw.trim() : null;
    const email = emailRaw ? emailRaw.trim() : null;
    console.log('[Qualtrics] extracted userID/email:', userID, email);
    return {
      userID: userID && userID.length ? userID : null,
      email: email && email.length ? email : null,
      hasParams: !!(userIDRaw && userIDRaw.trim().length)
    };
  } catch (err) {
    console.warn('Failed parsing Qualtrics params', err);
    return { userID: null, email: null, hasParams: false };
  }
})();
let sessionStartOptions = null;
let sessionStartPromise = null;
// Mapping and sensitivity tuning
const DEFAULT_BAND_ORIGINS = [0,1,2,3,4];
// Base positions for 5 bands as [x_ratio, y_ratio] to avoid per-frame array creation
const BAND_BASE_POSITIONS = [
  [0.25, 0.22],  // Band 0: top-left
  [0.75, 0.22],  // Band 1: top-right
  [0.5,  0.5],   // Band 2: center
  [0.25, 0.78],  // Band 3: bottom-left
  [0.75, 0.78]   // Band 4: bottom-right
];
// Region constraints for band center perturbation (as ratios)
const BAND_REGION_X_RATIOS = [0.12, 0.12, 0.15, 0.12, 0.12];
const BAND_REGION_Y_RATIOS = [0.12, 0.12, 0.16, 0.12, 0.12];
const MAPPING_A_BASE_LEVEL = 0.08;
const MAPPING_A_PEAK_SCALE = 0.72;
const MAPPING_A_CLIP_PIVOT = 1.2;
const MAPPING_A_CLIP_RATIO = 0.55;
const HIGH_FREQ_SENSITIVITY = 0.58;
const LOW_END_SENSITIVITY = 0.55;
const QUALTRICS_SURVEY_URL = 'https://nyu.qualtrics.com/jfe/form/SV_eCWOIY9iGjukpUO';
// === Global energy–audio sync offset ===
let offsetMs = 0;
let participantId = null; // set from Qualtrics params
let sessionId = null; // set by start-session API
let lastSwitchTime = 0;   // updated on mode switch

// Marker pulse overlay (Space key visual feedback)
let markerPulse = null; // { start: millis(), duration: 900 }
let testMarkerPulse = null; // { start: timestamp, duration: 900 } - for testing phase canvas
const SPACE_COOLDOWN_MS = 1000;
let spaceHoldActive = false;
let lastSpaceReleaseTime = 0;
let allowSpaceTesting = true;
let countdownActive = false;

// Tutorial state
let tutorialActive = false;
let tutorialPassed = false;
let tutorialHitCount = 0;
let tutorialMissCount = 0; // Track consecutive misses
let tutorialRequiredHits = 3;
let tutorialStartTime = 0;
let tutorialLastSwitchTime = 0;
let tutorialSwitches = [];
let tutorialSwitchTimers = []; // setTimeout timers for precise switch timing


let auroraColors = [];
let colorsInitialized = false;
let globalEnergy = 0, focusEnergy = 0, focusX = 0, focusY = 0;
let colorHueOffset = 0;
// Added: UI and overlay controls
let showRing = true;
let showUI = true;

// === Real-time adjustment baseline ===
const DEFAULT_GLOBAL_BRIGHTNESS = 2.6;
const DEFAULT_MAPPING_A_BASE = 1.5;
const DEFAULT_MAPPING_A_PEAK = 1.7;
const DEFAULT_MAPPING_A_NORM_PERCENTILE = 20; // 10th/90th percentile (20 means 20%-80%)
const DEFAULT_MAPPING_A_NORM_LIMIT = 100; // Max normalized value in percentage (100 = 1.0x)
const DEFAULT_MAPPING_A_CLIP_STRENGTH = 80; // Smooth clip strength in percentage (80 = 0.8)
const DEFAULT_MAPPING_A_NORM_STRENGTH = 10; // Hybrid blend: 0=raw, 100=full normalization (10 = 10%)
const DEFAULT_MAPPING_B_ATTACK = 0.15;
const DEFAULT_MAPPING_B_RELEASE = 0.10;
const DEFAULT_MAPPING_B_MIN_BASE = 1.10;
const DEFAULT_MAPPING_B_GAMMA = 1.00;
const DEFAULT_SHAPE_SIGMA = 0.90;
const DEFAULT_SHAPE_BIAS = 1.16;
const MODE_B_LOOKAHEAD_SEC = 0.25;
const MODE_B_LOOKAHEAD_DECAY = 0.9;
const MODE_B_FAST_FLOOR_BLEND = 0.3;
const MODE_B_AMBIENT_DECAY = 0.97;
const MODE_B_SHAPE_DECAY = 0.99;
const MODE_B_DIFF_THRESHOLD = 0.18;
const MODE_B_DECAY_FLOOR = 0.82;
const MODE_B_BASELINE_DEFAULT_FRAMES = 12;
const MODE_B_PEAK_THRESHOLD = 0.12;
const MODE_B_PEAK_STD_MULT = 0.8;
const MODE_B_BASELINE_STD_FALLOFF = 0.5;

// === Dynamic Decay Rate Calculation Parameters (V2) ===
const DECAY_CALC_PARAMS = {
  // Standard deviation multiplier for peak detection threshold
  thresholdStdDevMultiplier: 0.8,
  // Minimum number of peaks required for dynamic calculation (fallback to defaults if less)
  minPeakCount: 8,
  // Minimum frames between peaks to filter noise (0.15 sec * 60fps ≈ 9 frames)
  minPeakIntervalFrames: 9,
  // Event rate input range in Hz (events per second)
  eventRateRange: [1, 10],
  // Slow decay rate output range (for high-energy sustained states)
  slowDecayRange: [0.98, 0.94],
  // Fast decay rate output range (for low-energy/transient states)
  fastDecayRange: [0.94, 0.88]
};

let modeBBaselineFrames = [MODE_B_BASELINE_DEFAULT_FRAMES, MODE_B_BASELINE_DEFAULT_FRAMES, MODE_B_BASELINE_DEFAULT_FRAMES, MODE_B_BASELINE_DEFAULT_FRAMES, MODE_B_BASELINE_DEFAULT_FRAMES];
let modeBPeakThresholds = [MODE_B_PEAK_THRESHOLD, MODE_B_PEAK_THRESHOLD, MODE_B_PEAK_THRESHOLD, MODE_B_PEAK_THRESHOLD, MODE_B_PEAK_THRESHOLD];
let modeBNextPeakFrames = null;
let modeBPrevPeakFrames = null;
// Dynamic decay rates calculated per band (V2)
let perBandDecayRates = [];
// Per-band energy normalization for Mode A
let perBandNormalizationA = [];

const globalAdjust = {
  brightnessScale: DEFAULT_GLOBAL_BRIGHTNESS
};

const mappingAAdjust = {
  baseScale: DEFAULT_MAPPING_A_BASE,
  peakScale: DEFAULT_MAPPING_A_PEAK,
  normPercentile: DEFAULT_MAPPING_A_NORM_PERCENTILE,
  normLimit: DEFAULT_MAPPING_A_NORM_LIMIT,
  clipStrength: DEFAULT_MAPPING_A_CLIP_STRENGTH,
  normStrength: DEFAULT_MAPPING_A_NORM_STRENGTH
};

const mappingBAdjust = {
  attack: DEFAULT_MAPPING_B_ATTACK,
  release: DEFAULT_MAPPING_B_RELEASE,
  minBaseScale: DEFAULT_MAPPING_B_MIN_BASE,
  gammaScale: DEFAULT_MAPPING_B_GAMMA
};

const shapeAdjust = {
  sigmaScale: DEFAULT_SHAPE_SIGMA,
  biasScale: DEFAULT_SHAPE_BIAS
};

const VALIDATION_THRESHOLDS = {
  minPlaybackSeconds: 60,
  minKeypressCount: 5,
  minHitCount: 2,
  reminderPlaybackSeconds: 20
};

const sessionStats = {
  playbackSeconds: 0,
  keypressCount: 0,
  hitCount: 0,
  negativeHitCount: 0
};

function resetSessionStats() {
  sessionStats.playbackSeconds = 0;
  sessionStats.keypressCount = 0;
  sessionStats.hitCount = 0;
  sessionStats.negativeHitCount = 0;
  window.__thesisHasStartedPlayback = false;
}

function updatePlaybackStats() {
  if (window.audio && !isNaN(window.audio.currentTime)) {
    sessionStats.playbackSeconds = Math.max(sessionStats.playbackSeconds, window.audio.currentTime);
  }
}

  function recordKeypressMetrics(rt) {
    sessionStats.keypressCount += 1;
    if (typeof rt === 'number' && isFinite(rt)) {
      if (rt >= 0 && rt <= 2.0) {
        sessionStats.hitCount += 1;
    } else if (rt < 0 && rt >= -2.0) {
      sessionStats.negativeHitCount += 1;
    }
  }
}

function evaluateSessionStats(stats = sessionStats) {
  const playbackSeconds = stats.playbackSeconds || 0;
  const keypressCount = stats.keypressCount || 0;
  const hitCount = stats.hitCount || 0;
  const negativeHits = stats.negativeHitCount || 0;

  const meetsPlayback = playbackSeconds >= VALIDATION_THRESHOLDS.minPlaybackSeconds;
  const meetsKeypress = keypressCount >= VALIDATION_THRESHOLDS.minKeypressCount;
  const meetsHits = hitCount >= VALIDATION_THRESHOLDS.minHitCount;

  const zeroHitButPressed = keypressCount >= VALIDATION_THRESHOLDS.minKeypressCount && hitCount === 0;
  const allNegativeHits = hitCount === 0 && negativeHits > 0;

  const meetsAll = meetsPlayback && meetsKeypress && meetsHits && !zeroHitButPressed && !allNegativeHits;

  return {
    meetsAll,
    meetsPlayback,
    meetsKeypress,
    meetsHits,
    zeroHitButPressed,
    allNegativeHits
  };
}

function markPlaybackStarted(){
  window.__thesisHasStartedPlayback = true;
}

// === Logging retry + telemetry ===
const LOG_QUEUE_KEY = 'thesis-log-queue-v1';
const SWITCH_QUEUE_KEY = 'thesis-switch-queue-v1';
const FEEDBACK_QUEUE_KEY = 'thesis-feedback-queue-v1';
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
const transmitStats = { sentCount: 0, queuedCount: 0 };
let sessionFinalized = false;
let pendingFinalizeAction = 'complete';
let lastFinalizeResult = null;

function safeLoadQueue(key){
  try {
    if (!window.localStorage) return [];
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Failed to load queue', key, err);
    return [];
  }
}

function safeSaveQueue(key, queue){
  try {
    if (!window.localStorage) return;
    window.localStorage.setItem(key, JSON.stringify(queue));
  } catch (err) {
    console.warn('Failed to persist queue', key, err);
  }
}

function enqueuePayload(queueKey, payload){
  const queue = safeLoadQueue(queueKey);
  queue.push({ payload, timestamp: Date.now() });
  if (queue.length > 1000) queue.shift();
  safeSaveQueue(queueKey, queue);
  transmitStats.queuedCount += 1;
}

function delay(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hashEmail(email) {
  if (!email || !window.crypto || !window.crypto.subtle) return null;
  try {
    const normalized = email.trim().toLowerCase();
    const encoder = new TextEncoder();
    const data = encoder.encode(normalized);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    console.warn('Email hash failed', err);
    return null;
  }
}

async function sendWithRetry(endpoint, payload, attempt = 1){
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return true;
  } catch (error) {
    if (attempt >= RETRY_MAX_ATTEMPTS) {
      console.warn('sendWithRetry exhausted', endpoint, error);
      return false;
    }
    const waitMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    await delay(waitMs);
    return sendWithRetry(endpoint, payload, attempt + 1);
  }
}

async function postWithRetry(endpoint, payload, queueKey){
  if (!navigator.onLine) {
    enqueuePayload(queueKey, payload);
    return false;
  }
  const success = await sendWithRetry(endpoint, payload);
  if (success) {
    transmitStats.sentCount += 1;
    return true;
  }
  enqueuePayload(queueKey, payload);
  return false;
}

async function flushQueue(queueKey, endpoint){
  const queue = safeLoadQueue(queueKey);
  if (!queue.length || !navigator.onLine) return;
  const remaining = [];
  for (const item of queue) {
    const ok = await sendWithRetry(endpoint, item.payload);
    if (ok) {
      transmitStats.sentCount += 1;
      transmitStats.queuedCount = Math.max(0, transmitStats.queuedCount - 1);
    } else {
      remaining.push(item);
    }
  }
  safeSaveQueue(queueKey, remaining);
}

async function flushAllQueues(){
  await flushQueue(LOG_QUEUE_KEY, '/api/log');
  await flushQueue(SWITCH_QUEUE_KEY, '/api/switch');
  await flushQueue(FEEDBACK_QUEUE_KEY, '/api/feedback');
}

const urlParams = new URLSearchParams(window.location.search);
const featureConfig = {
  enableCountdown: urlParams.get('countdown') !== '0'
};
const featureUsage = {
  hadCountdown: featureConfig.enableCountdown
};

// === Color conversion utilities (global) ===
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  let max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    let d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    }
    let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    let p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

/**
 * Calculate per-band energy normalization parameters for Mode A
 *
 * @param {Array<Array<number>>} energyData - 2D array of energy values [frame][band]
 * @param {number} percentile - Percentile value (e.g., 10 means 10th-90th percentile)
 * @returns {Array<Object>} Array of 5 objects: { minEnergy, maxEnergy, range }
 */
function calculatePerBandNormalization(energyData, percentile = 10) {
  const results = [];

  for (let bandIndex = 0; bandIndex < 5; bandIndex++) {
    // Extract energy values for this band
    const bandEnergies = energyData.map(row => {
      const val = row[bandIndex];
      return (typeof val === 'number' && isFinite(val)) ? Math.max(val, 0) : 0;
    });

    if (bandEnergies.length === 0) {
      // Fallback for empty data
      results.push({
        minEnergy: 0,
        maxEnergy: 1,
        range: 1
      });
      continue;
    }

    // Sort to find percentiles
    const sorted = [...bandEnergies].sort((a, b) => a - b);

    // Use adjustable percentiles to avoid outliers
    const pLow = Math.max(0, Math.min(50, percentile)) / 100; // Clamp to 0-50%
    const pHigh = 1 - pLow;
    const pLowIndex = Math.floor(sorted.length * pLow);
    const pHighIndex = Math.floor(sorted.length * pHigh);
    const minEnergy = sorted[pLowIndex];
    const maxEnergy = sorted[pHighIndex];
    const range = Math.max(maxEnergy - minEnergy, 0.01); // Avoid division by zero

    results.push({
      minEnergy: minEnergy,
      maxEnergy: maxEnergy,
      range: range
    });
  }

  return results;
}

/**
 * Smooth clipping function using tanh for gradual compression
 *
 * @param {number} value - Input value
 * @param {number} pivot - Threshold above which compression starts
 * @param {number} strength - Compression strength (lower = more compression)
 * @returns {number} Compressed value
 */
function smoothClip(value, pivot, strength = 0.5) {
  if (value <= pivot) return value;

  const excess = value - pivot;
  const compressed = Math.tanh(excess / strength) * 0.4;
  return pivot + compressed;
}

/**
 * Calculate dynamic decay rates for each frequency band based on music analysis (V2)
 *
 * @param {Array<Array<number>>} energyData - 2D array of energy values [frame][band]
 * @param {number} csvFps - Frame rate of the energy data (e.g., 60)
 * @param {Object} params - Configuration parameters (DECAY_CALC_PARAMS)
 * @returns {Array<Object>} Array of 5 objects: { slowDecay, fastDecay, medianEnergy, eventRateHz, peakCount }
 */
function calculatePerBandDecayRates_V2(energyData, csvFps, params) {
  const results = [];
  const decayBase = [0.94, 0.88, 0.88, 0.88, 0.94]; // Default decay rates from existing code

  // Linear mapping helper function
  const mapValue = (value, inMin, inMax, outMin, outMax) => {
    const clamped = Math.max(inMin, Math.min(inMax, value));
    return outMin + (clamped - inMin) * (outMax - outMin) / (inMax - inMin);
  };

  // Process each of the 5 frequency bands
  for (let bandIndex = 0; bandIndex < 5; bandIndex++) {
    // 1. Extract energy values for this band
    const bandEnergies = energyData.map(row => {
      const val = row[bandIndex];
      return (typeof val === 'number' && isFinite(val)) ? Math.max(val, 0) : 0;
    });

    if (bandEnergies.length === 0) {
      // Fallback for empty data
      results.push({
        slowDecay: decayBase[bandIndex],
        fastDecay: decayBase[bandIndex],
        medianEnergy: 0.1,
        eventRateHz: 0,
        peakCount: 0
      });
      continue;
    }

    // 2. Calculate statistics: mean, standard deviation, and median
    const mean = bandEnergies.reduce((sum, v) => sum + v, 0) / bandEnergies.length;
    const variance = bandEnergies.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / bandEnergies.length;
    const stdDev = Math.sqrt(variance);

    // Calculate median
    const sorted = [...bandEnergies].sort((a, b) => a - b);
    const medianEnergy = sorted[Math.floor(sorted.length / 2)];

    // 3. Calculate dynamic peak threshold
    const peakThreshold = mean + params.thresholdStdDevMultiplier * stdDev;

    // 4. Improved peak detection with minimum interval constraint
    const peakIndices = [];
    let lastPeakIndex = -params.minPeakIntervalFrames; // Initialize to allow first peak

    for (let i = 1; i < bandEnergies.length - 1; i++) {
      const current = bandEnergies[i];
      const prev = bandEnergies[i - 1];
      const next = bandEnergies[i + 1];

      // Check all conditions for a peak:
      // 1. Above threshold
      // 2. Higher than previous point
      // 3. Higher than or equal to next point
      // 4. Sufficient distance from last peak
      if (current > peakThreshold &&
          current > prev &&
          current >= next &&
          (i - lastPeakIndex) >= params.minPeakIntervalFrames) {
        peakIndices.push(i);
        lastPeakIndex = i;
      }
    }

    // 5. Check if we have enough peaks for reliable calculation
    if (peakIndices.length < params.minPeakCount) {
      // Insufficient peaks - use default decay rates
      results.push({
        slowDecay: decayBase[bandIndex],
        fastDecay: decayBase[bandIndex] * 0.94, // Slightly faster for fast decay
        medianEnergy: medianEnergy,
        eventRateHz: 0,
        peakCount: peakIndices.length
      });
      continue;
    }

    // 6. Calculate event rate (events per second)
    // Compute intervals between consecutive peaks
    const intervals = [];
    for (let i = 1; i < peakIndices.length; i++) {
      intervals.push(peakIndices[i] - peakIndices[i - 1]);
    }

    // Find median interval
    intervals.sort((a, b) => a - b);
    const medianIntervalFrames = intervals[Math.floor(intervals.length / 2)];
    const eventRateHz = csvFps / medianIntervalFrames;

    // 7. Map event rate to decay rates
    const [eventMin, eventMax] = params.eventRateRange;
    const [slowMin, slowMax] = params.slowDecayRange;
    const [fastMin, fastMax] = params.fastDecayRange;

    const slowDecay = mapValue(eventRateHz, eventMin, eventMax, slowMin, slowMax);
    const fastDecay = mapValue(eventRateHz, eventMin, eventMax, fastMin, fastMax);

    // 8. Store results for this band
    results.push({
      slowDecay: slowDecay,
      fastDecay: fastDecay,
      medianEnergy: medianEnergy,
      eventRateHz: eventRateHz,
      peakCount: peakIndices.length
    });
  }

  return results;
}

// === CSV energy data ===
let energyData = [];
let energyFrame = 0;
let energyLoaded = false;
let energyCols = 0;
let csvPlaying = false;
let csvInterval = null;
let csvFps = 60; // about 60 fps

// History traces
let bandHistory = [[],[],[],[],[]]; // five-band energy history
const historyLength = 30; // trace length (frames)

// Load CSV via PapaParse
function preload() {
  if (typeof Papa !== 'undefined') {
    Papa.parse('stems/stem_energy_timeseries.csv', {
      download: true,
      dynamicTyping: true,
      complete: function(results) {
        try {
          if (results && Array.isArray(results.errors) && results.errors.length > 0) {
            console.warn('Papa.parse reported errors:', results.errors);
          }
          if (!results || !Array.isArray(results.data) || results.data.length < 2) {
            console.warn('CSV seems empty or malformed (no rows). Visualization will idle until data is available.');
            energyLoaded = false;
            return;
          }
          energyData = results.data.slice(1).filter(row => row && row.length > 1);
          energyCols = results.data[0]?.length || 0;
          energyLoaded = energyData.length > 0;
          if (!energyLoaded) {
            console.warn('CSV parsed but no usable rows found.');
            return;
          }
          energyFrame = 0;
          try{ computeGlobalSaliency(); }catch(e){ console.warn('Saliency compute failed', e); }
          try{ computeModeBPeakBaselines(); }catch(e){ console.warn('ModeB baseline compute failed', e); }
          try{
            perBandNormalizationA = calculatePerBandNormalization(energyData, mappingAAdjust.normPercentile);
            console.log('[Mode A] Calculated per-band normalization:', perBandNormalizationA);
          }catch(e){ console.warn('Mode A normalization calculation failed', e); }
          try{
            perBandDecayRates = calculatePerBandDecayRates_V2(energyData, csvFps, DECAY_CALC_PARAMS);
            console.log('[Decay V2] Calculated dynamic decay rates:', perBandDecayRates);
          }catch(e){ console.warn('Dynamic decay rate calculation failed', e); }
        } catch (err) {
          console.warn('Failed processing CSV results:', err);
          energyLoaded = false;
        }
      },
      error: function(err, file, inputElem, reason) {
        console.warn('Papa.parse failed to load CSV:', err || reason || 'Unknown error');
        energyLoaded = false;
      }
    });
  } else {
    console.warn('PapaParse (Papa) is not available; CSV will not load.');
  }
}

// ---- Global saliency (S_global) — only compute, not change visuals ----
// Simple, robust metrics on 5 bands over whole CSV: Var, PeakRate, Contrast, Regularity
function computeGlobalSaliency(){
  if (!energyLoaded || !Array.isArray(energyData) || energyData.length === 0) return;
  const n = energyData.length;
  const bands = 5;
  const series = Array.from({length: bands}, (_,i)=> energyData.map(row => Number(row[i]||0)));

  function mean(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
  function variance(arr){ const m=mean(arr); let s=0; for(const v of arr){ const d=v-m; s+=d*d; } return s/arr.length; }
  function std(arr){ return Math.sqrt(Math.max(variance(arr), 1e-9)); }
  function percentile(arr, p){ const a=[...arr].sort((x,y)=>x-y); const idx=Math.min(a.length-1, Math.max(0, Math.floor((p/100)*a.length))); return a[idx]; }
  function peakRate(arr){ const m=mean(arr), s=std(arr); const thr=m+0.6*s; let peaks=0; for(let i=1;i<arr.length-1;i++){ if (arr[i]>thr && arr[i]>arr[i-1] && arr[i]>=arr[i+1]) peaks++; } return (peaks/(n/ csvFps)); }
  function contrast(arr){ const p95=percentile(arr,95), p50=percentile(arr,50); return (p95 - p50)/Math.max(1e-6, p50); }
  function regularity(arr){ // simple normalized autocorr peak in 0.5..3s lag
    const minLag = Math.floor(0.5*csvFps), maxLag = Math.floor(3.0*csvFps);
    const m = mean(arr), denom = arr.reduce((a,b)=>a+(b-m)*(b-m),0) || 1e-6;
    let best=0;
    for(let lag=minLag; lag<=maxLag; lag+=Math.floor(csvFps/6)){
      let num=0; for(let i=lag;i<arr.length;i++){ num += (arr[i]-m)*(arr[i-lag]-m); }
      best = Math.max(best, num/denom);
    }
    return best; // 0..1
  }
  function zscore(vs){ const m=mean(vs), s=Math.sqrt(variance(vs))||1e-6; return vs.map(v=>(v-m)/s); }

  const Var = series.map(variance);
  const Peak = series.map(peakRate);
  const Contr = series.map(contrast);
  const Regl = series.map(regularity);
  const w = {var:0.35, peak:0.35, contr:0.20, regl:0.10};
  const S = zscore(Var).map((_,i)=> w.var*zscore(Var)[i] + w.peak*zscore(Peak)[i] + w.contr*zscore(Contr)[i] + w.regl*zscore(Regl)[i]);
  const pairs = S.map((s,i)=>({i,s})).sort((a,b)=>b.s-a.s);
  window._saliency = {scores:S, ranking:pairs, main:pairs[0].i, weights:w};
  console.log('[Saliency] global scores', S.map(v=>v.toFixed(3)), 'main=', pairs[0]);
}

function computeModeBPeakBaselines(){
  if (!energyData || !energyData.length) {
    modeBBaselineFrames = new Array(5).fill(MODE_B_BASELINE_DEFAULT_FRAMES);
    modeBNextPeakFrames = null;
    modeBPrevPeakFrames = null;
    return;
  }
  const n = energyData.length;
  const bands = Math.min(5, energyData[0] ? energyData[0].length : 0);
  modeBBaselineFrames = new Array(5).fill(MODE_B_BASELINE_DEFAULT_FRAMES);
  modeBPeakThresholds = new Array(5).fill(MODE_B_PEAK_THRESHOLD);
  modeBNextPeakFrames = Array.from({length:5}, ()=> new Array(n).fill(Infinity));
  modeBPrevPeakFrames = Array.from({length:5}, ()=> new Array(n).fill(Infinity));

  for (let b=0; b<bands; b++) {
    const energies = energyData.map(row => {
      const val = row && typeof row[b] === 'number' && isFinite(row[b]) ? row[b] : 0;
      return Math.max(val, 0);
    });
    const peaks = [];
    const energyMean = energies.reduce((sum,v)=>sum+v,0) / energies.length;
    const energyVar = energies.reduce((sum,v)=> sum + Math.pow(v - energyMean, 2), 0) / energies.length;
    const energyStd = Math.sqrt(Math.max(energyVar, 1e-12));
    const dynamicThreshold = Math.max(MODE_B_PEAK_THRESHOLD, energyMean + MODE_B_PEAK_STD_MULT * energyStd);
    modeBPeakThresholds[b] = dynamicThreshold;
    for (let i=1; i<n-1; i++) {
      const v = energies[i];
      if (v >= energies[i-1] && v > energies[i+1] && v >= dynamicThreshold) {
        peaks.push(i);
      }
    }
    if (!peaks.length) {
      continue;
    }
    const intervals = [];
    for (let i=1; i<peaks.length; i++) {
      const gap = peaks[i] - peaks[i-1];
      if (gap > 0) intervals.push(gap);
    }
    if (intervals.length) {
      const intMean = intervals.reduce((sum,v)=>sum+v,0)/intervals.length;
      const intVar = intervals.reduce((sum,v)=> sum + Math.pow(v - intMean,2),0)/intervals.length;
      const intStd = Math.sqrt(Math.max(intVar, 1e-6));
      const baseline = Math.max(1, Math.round(intMean - MODE_B_BASELINE_STD_FALLOFF * intStd));
      modeBBaselineFrames[b] = baseline;
    }

    const first = peaks[0];
    for (let i=0; i<=first && i<n; i++) {
      modeBNextPeakFrames[b][i] = first - i;
    }
    for (let p=0; p<peaks.length-1; p++) {
      const curr = peaks[p];
      const next = peaks[p+1];
      for (let i=curr; i<next && i<n; i++) {
        modeBNextPeakFrames[b][i] = next - i;
      }
    }
    const last = peaks[peaks.length-1];
    for (let i=last; i<n; i++) {
      modeBNextPeakFrames[b][i] = Infinity;
    }

    for (let i=0; i<first && i<n; i++) {
      modeBPrevPeakFrames[b][i] = first - i;
    }
    for (let p=0; p<peaks.length-1; p++) {
      const curr = peaks[p];
      const next = peaks[p+1];
      for (let i=curr; i<next && i<n; i++) {
        modeBPrevPeakFrames[b][i] = i - curr;
      }
    }
    const lastPeak = peaks[peaks.length-1];
    for (let i=lastPeak; i<n; i++) {
      modeBPrevPeakFrames[b][i] = i - lastPeak;
    }
  }
  modeBPrevFinal = [0,0,0,0,0];
}

function setup() {
  let cnv = createCanvas(window.innerWidth, window.innerHeight);
  cnv.parent('p5-holder');
  // Store canvas element for DOM-to-canvas coordinate conversion
  window._p5CanvasEl = cnv.elt;
  background(0);
}

function windowResized() {
  resizeCanvas(window.innerWidth, window.innerHeight);
}



function draw() {
  background(0, 40); // faster clear
  updatePlaybackStats();

  // Hue ring triadic color mapping
  auroraColors = [];
  // Smooth animation: baseAngle eases toward colorHueOffset
  if (typeof window.baseAngle === 'undefined') window.baseAngle = colorHueOffset % 360;
  let speed = 0.18; // larger = faster
  let diff = ((colorHueOffset % 360) - window.baseAngle + 360) % 360;
  if (diff > 180) diff -= 360;
  window.baseAngle += diff * speed;
  window.baseAngle = (window.baseAngle + 360) % 360;
  let baseAngle = window.baseAngle;
  // Triangle vertices: low, mid, high
  let triAngles = [baseAngle, (baseAngle+120)%360, (baseAngle+240)%360];
  let triColors = triAngles.map(a => hslToRgb(a/360, 0.85, 0.55));
  // Midpoints: low–mid and mid–high
  let midAngles = [
    (triAngles[0]+60)%360, // low–mid
    (triAngles[2]+60)%360  // mid–high
  ];
  let midColors = midAngles.map(a => hslToRgb(a/360, 0.85, 0.55));
  // auroraColors: [hi1 top, mid-high midpoint, mid top, low top, low-mid midpoint]
  auroraColors = [
    triColors[2],    // hi1 (high)
    midColors[1],    // hi2 (mid-high midpoint)
    triColors[1],    // mid
    triColors[0],    // kick (low)
    midColors[0]     // bass (low-mid midpoint)
  ];
  colorsInitialized = true;

  // === Drive with CSV energy ===
  let bands = [0.09,0.09,0.09,0.09,0.09];
  let shapeBands = [0.09,0.09,0.09,0.09,0.09];
  if (energyLoaded && energyData.length > 0) {
    let frameIdx = 0;
    if (window.audio && !window.audio.paused && !isNaN(window.audio.currentTime)) {
      // Calculate raw frame time, then clamp before flooring to avoid negative indices
      const rawFrameTime = (window.audio.currentTime * csvFps) - (offsetMs / 1000 * csvFps);
      frameIdx = Math.floor(Math.max(0, rawFrameTime));
      frameIdx = Math.min(energyData.length - 1, frameIdx);
    } else {
      frameIdx = energyFrame % energyData.length;
    }
    let row = energyData[frameIdx];
    if (mappingMode === 'A') {
      const baseFactor = Math.max(0, mappingAAdjust.baseScale);
      const peakFactor = Math.max(0, mappingAAdjust.peakScale);
      const normLimitMax = Math.max(0.1, mappingAAdjust.normLimit / 100); // Convert percentage to decimal
      const clipStrength = Math.max(0.1, mappingAAdjust.clipStrength / 100); // Convert percentage to decimal
      const normStrength = Math.max(0, Math.min(100, mappingAAdjust.normStrength)) / 100; // 0-1 range

      for (let i = 0; i < 5; i++) {
        const raw = (typeof row[i] === 'number' && isFinite(row[i])) ? Math.max(row[i], 0) : MAPPING_A_BASE_LEVEL;
        const baseVal = MAPPING_A_BASE_LEVEL * baseFactor;

        // === Hybrid Blending: Calculate both raw and normalized paths ===

        // Path 1: Raw mapping (original V1.3 logic)
        const deltaRaw = Math.max(0, raw - MAPPING_A_BASE_LEVEL);
        const rawScaled = baseVal + deltaRaw * MAPPING_A_PEAK_SCALE * peakFactor;

        // Path 2: Normalized mapping (V1.4 logic)
        let normalized = raw;
        if (perBandNormalizationA && perBandNormalizationA[i]) {
          const { minEnergy, range } = perBandNormalizationA[i];
          normalized = (raw - minEnergy) / range;
          normalized = Math.max(0, Math.min(normLimitMax, normalized));
        }
        const normalizedScaled = baseVal + normalized * MAPPING_A_PEAK_SCALE * peakFactor;

        // Blend between raw and normalized based on normStrength
        let scaled = rawScaled * (1 - normStrength) + normalizedScaled * normStrength;

        // Smooth clipping (applies to final blended result)
        if (scaled > MAPPING_A_CLIP_PIVOT) {
          scaled = smoothClip(scaled, MAPPING_A_CLIP_PIVOT, clipStrength);
        }

        bands[i] = scaled;
        shapeBands[i] = scaled;
      }
    } else if (mappingMode === 'B') {
      // hi1/kick bands (0 and 4) have stronger damping + delay + higher threshold; other bands normal
      const minBaseBase = [0.16, 0.11, 0.11, 0.11, 0.16];
      const boostRateBase = [0.04, 0.08, 0.08, 0.08, 0.04];
      const decayBase = [0.94, 0.88, 0.88, 0.88, 0.94];
      const gammaBase = [0.82, 0.78, 0.78, 0.78, 0.82];

      const baseAttack = DEFAULT_MAPPING_B_ATTACK || 1;
      const baseRelease = DEFAULT_MAPPING_B_RELEASE || 1;
      const attackRatio = baseAttack ? (Math.max(0, mappingBAdjust.attack) / baseAttack) : 1;
      const releaseRatio = baseRelease ? (Math.max(0, mappingBAdjust.release) / baseRelease) : 1;
      const floorScale = Math.max(0, mappingBAdjust.minBaseScale);
      const gammaScale = Math.max(0.1, mappingBAdjust.gammaScale);

      const minBase = minBaseBase.map(v => v * floorScale);
      const boostRateArr = boostRateBase.map((v,idx) => {
        if (idx === 3) return v * attackRatio * 0.6;
        return v * attackRatio;
      });
      const decayArr = decayBase.map((v,idx) => {
        const base = 1 - Math.min(0.99, (1 - v) * releaseRatio);
        if (idx === 3) return Math.max(0.90, base);
        return base;
      });
      const gammaArr = gammaBase.map(v => Math.max(0.1, Math.min(2.0, v * gammaScale)));

      const lookaheadFramesBase = Math.max(1, Math.round(csvFps * MODE_B_LOOKAHEAD_SEC));
      const ambientDecay = MODE_B_AMBIENT_DECAY;
      const shapeDecayRate = MODE_B_SHAPE_DECAY;
      const shapeBoostRate = 1.0 - shapeDecayRate;

      // Response delay: use 3-frame smoothing on all bands
      if (!window.bandDelay) window.bandDelay = [[],[],[],[],[]];
      if (typeof window._bandSmoothB === 'undefined') {
        window._bandSmoothB = [0,0,0,0,0];
      }
      const prevRow = (energyData && energyData.length) ? energyData[Math.max(0, frameIdx-1)] || row : row;
      const nextRow = (energyData && energyData.length) ? energyData[Math.min(energyData.length-1, frameIdx+1)] || row : row;
      for(let i=0; i<5; i++) {
        let currentEnergy = row[i] || minBase[i];

        let brightnessTarget = currentEnergy;
        let lookaheadFrames = lookaheadFramesBase;
        let lookaheadDecay = MODE_B_LOOKAHEAD_DECAY;
        if (i === 3) {
          lookaheadFrames = Math.round(lookaheadFramesBase * 1.35);
          lookaheadDecay *= 0.75;
        }
        if (energyData && energyData.length) {
          const futureLimit = Math.min(energyData.length - 1, frameIdx + lookaheadFrames);
          for (let step = 1, idx = frameIdx + 1; idx <= futureLimit; idx++, step++) {
            const futureRow = energyData[idx];
            if (!futureRow) break;
            const futureVal = futureRow[i] || minBase[i];
            const weight = Math.exp(-step * lookaheadDecay);
            brightnessTarget = Math.max(brightnessTarget, futureVal * weight);
          }
        }
        brightnessTarget = Math.min(1, brightnessTarget);

        window.bandDelay[i].push(brightnessTarget);
        if (window.bandDelay[i].length > 3) window.bandDelay[i].shift();
        brightnessTarget = window.bandDelay[i].reduce((a,b) => a+b, 0) / window.bandDelay[i].length;

        // --- 快速亮度池 ---
        const prevEnergy = prevRow ? (prevRow[i] || minBase[i]) : currentEnergy;
        const nextEnergy = nextRow ? (nextRow[i] || minBase[i]) : currentEnergy;
        const diffPrev = Math.abs(currentEnergy - prevEnergy);
        const diffNext = Math.abs(nextEnergy - currentEnergy);
        const diffMetric = Math.max(diffPrev, diffNext);
        const diffRatio = Math.min(1, diffMetric / MODE_B_DIFF_THRESHOLD);
        const closeness = 1 - diffRatio;

        let boostFactor = boostRateArr[i] * (0.5 + 0.5 * diffRatio);
        if (i === 3) boostFactor = boostFactor * (0.7 + 0.3 * diffRatio);

        // === V2 Hybrid Decay Logic ===
        let decayFactor;
        const bandParams = perBandDecayRates[i];

        // Check if we have valid dynamic parameters for this band
        if (bandParams && bandParams.peakCount >= DECAY_CALC_PARAMS.minPeakCount) {
          // --- Macro layer: baseline decay based on current energy state ---
          const baselineDecay = (bandAccum[i] > bandParams.medianEnergy)
            ? bandParams.slowDecay
            : bandParams.fastDecay;

          // --- Micro layer: real-time adjustment based on energy smoothness ---
          const microAdjustment = closeness * 0.08;

          // --- Combine baseline with micro-adjustment ---
          let finalDecayFactor = baselineDecay - microAdjustment;

          // --- Apply release slider adjustment ---
          finalDecayFactor = 1 - (1 - finalDecayFactor) * releaseRatio;

          // --- Safety clamp ---
          decayFactor = Math.max(MODE_B_DECAY_FLOOR, Math.min(finalDecayFactor, 0.995));
        } else {
          // Fallback to original logic if dynamic calculation unavailable
          decayFactor = decayArr[i] - closeness * 0.08;
          decayFactor = Math.max(MODE_B_DECAY_FLOOR, Math.min(decayFactor, 0.995));
        }

        let extraBoost = (brightnessTarget - bandAccum[i]) * boostFactor;
        bandAccum[i] = bandAccum[i] * decayFactor + brightnessTarget * (1 - decayFactor) + extraBoost;
        let fastValue = Math.max(Math.pow(bandAccum[i], gammaArr[i]), minBase[i]);
        shapeBands[i] = fastValue;

        // --- 慢速（环境）亮度池 ---
        modeBAmbientAccum[i] = modeBAmbientAccum[i] * ambientDecay + brightnessTarget * (1 - ambientDecay);
        const ambientValue = Math.max(modeBAmbientAccum[i], minBase[i]);
        let finalBandValue = fastValue * (1 - MODE_B_FAST_FLOOR_BLEND) + ambientValue * MODE_B_FAST_FLOOR_BLEND;

        const baselineFrames = modeBBaselineFrames[i] || MODE_B_BASELINE_DEFAULT_FRAMES;
        const framesToNext = (modeBNextPeakFrames && modeBNextPeakFrames[i]) ? modeBNextPeakFrames[i][frameIdx] : baselineFrames;
        const framesSincePrev = (modeBPrevPeakFrames && modeBPrevPeakFrames[i]) ? modeBPrevPeakFrames[i][frameIdx] : baselineFrames;
        const proximity = Math.min(framesToNext, framesSincePrev);
        if (proximity <= baselineFrames) {
          finalBandValue = Math.max(finalBandValue, modeBPrevFinal[i] || finalBandValue);
          bandAccum[i] = Math.max(bandAccum[i], finalBandValue);
          modeBAmbientAccum[i] = Math.max(modeBAmbientAccum[i], finalBandValue);
        }
        modeBPrevFinal[i] = finalBandValue;

        // --- 新增逻辑：对 hi1 (i=0) 应用额外平滑 ---
        if (i === 0) {
          const smoothFactor = 0.85;
          const prevSmoothed = window._bandSmoothB[i] || finalBandValue;
          finalBandValue = prevSmoothed * smoothFactor + finalBandValue * (1.0 - smoothFactor);
          window._bandSmoothB[i] = finalBandValue;
        } else {
          window._bandSmoothB[i] = finalBandValue;
        }

        bands[i] = finalBandValue;

        // --- 更新“形态”能量池 (慢时钟) ---
        const shapeEnergy = closeness > 0.5 ? (currentEnergy * 0.6 + nextEnergy * 0.4) : currentEnergy;
        shapeAccum[i] = shapeAccum[i] * shapeDecayRate + shapeEnergy * shapeBoostRate;
      }
    }

    const brightnessScale = Math.max(0, globalAdjust.brightnessScale);
    for (let i=0;i<5;i++) {
      bands[i] = Math.max(0, bands[i] * brightnessScale);
    }

    // Update bandHistory
    for (let i=0;i<5;i++) {
      bandHistory[i].push(bands[i]);
      if (bandHistory[i].length > historyLength) bandHistory[i].shift();
    }
  }

  // Apply spatial mapping (no lighthouse): remap bands/colors by slotMap if defined
  if (typeof window._slotMap !== 'undefined' && Array.isArray(window._slotMap) && window._slotMap.length===5) {
    const sm = window._slotMap;
    // remap colors for visualization
    const mappedColors = [ auroraColors[sm[0]], auroraColors[sm[1]], auroraColors[sm[2]], auroraColors[sm[3]], auroraColors[sm[4]] ];
    const mappedBands  = [ bands[sm[0]],  bands[sm[1]],  bands[sm[2]],  bands[sm[3]],  bands[sm[4]] ];
    auroraColors = mappedColors;
    bands = mappedBands;
    window._bandOrigins = sm.slice();
  } else {
    window._bandOrigins = DEFAULT_BAND_ORIGINS.slice();
  }

  const bandOrigins = window._bandOrigins || DEFAULT_BAND_ORIGINS;

  // === Dynamic focus point ===
  let time = millis()/1000;
  focusX = width/2 + Math.sin(time*0.23)*width*0.18 + Math.cos(time*0.13)*width*0.09;
  focusY = height/2 + Math.cos(time*0.19)*height*0.16 + Math.sin(time*0.11)*height*0.07;

  // === Five-band pixelated fog rendering ===
  // Adaptive grid density: use larger grid (lower resolution) for high-res displays
  // This provides 40-50% FPS improvement on large screens with minimal visual impact
  const totalPixels = width * height;
  let grid;
  if (totalPixels > 3000000) {        // 4K+ displays (~3840×2160)
    grid = 16;
  } else if (totalPixels > 2000000) { // QHD displays (~2560×1440)
    grid = 12;
  } else {                             // HD and below (~1920×1080)
    grid = 8;
  }
  // === Dynamic/adaptive band layout ===
  // 1) bandCenters slowly perturb over time (dynamic centers)
  // 2) bandSigma adapts with energy (adaptive width)
  // 3) per-frame smoothing to avoid abrupt jumps
  // 4) slight per-band sigma differences (non-uniform)
  // 5) centers biased toward screen center under high energy
  if (!window._bandCenters) {
    window._bandCenters = [
      [width*0.25, height*0.22],
      [width*0.75, height*0.22],
      [width*0.5, height*0.5],
      [width*0.25, height*0.78],
      [width*0.75, height*0.78]
    ];
  }
  if (!window._bandSigmaArr) {
    let baseSigmaInit = Math.min(width, height)*0.28;
    window._bandSigmaArr = [baseSigmaInit, baseSigmaInit, baseSigmaInit, baseSigmaInit, baseSigmaInit];
  }
  let baseSigma = Math.min(width, height)*0.28;
  let bandCenters = [];
  let bandSigmaArr = [];
  let t = millis()/1000;
  for (let i=0; i<5; i++) {
    // Dynamic perturbation + energy bias
    // Use pre-calculated base positions to avoid array creation every frame
    const [cx0Ratio, cy0Ratio] = BAND_BASE_POSITIONS[i];
    let cx0 = width * cx0Ratio;
    let cy0 = height * cy0Ratio;
    const perturbScale = (mappingMode === 'B') ? 0.35 : 1;
    let dx = perturbScale * (Math.sin(t*0.13 + i*1.2)*width*0.026 + Math.cos(t*0.21 + i*0.7)*width*0.017);
    let dy = perturbScale * (Math.cos(t*0.11 + i*1.7)*height*0.024 + Math.sin(t*0.19 + i*0.9)*height*0.016);
    // Energy bias (under high energy shift slightly toward center)
    let bandE = shapeBands ? shapeBands[i] : 0.1;
    let centerBiasBaseX = (width/2 - cx0) * bandE * 0.06;
    let centerBiasBaseY = (height/2 - cy0) * bandE * 0.06;
    let centerBiasScale;
    if (mappingMode === 'B') {
      const slowState = shapeAccum[i];
      const biasMin = 1.0;
      const biasMax = DEFAULT_SHAPE_BIAS;
      const mappedBias = (typeof map === 'function')
        ? map(slowState, 0, 1, biasMin, biasMax)
        : biasMin + (biasMax - biasMin) * slowState;
      const baseBiasScale = DEFAULT_SHAPE_BIAS || 1;
      const sliderBiasRatio = baseBiasScale ? (shapeAdjust.biasScale / baseBiasScale) : 1;
      centerBiasScale = mappedBias * sliderBiasRatio;
      centerBiasScale = Math.min(centerBiasScale, 0.7);
    } else {
      centerBiasScale = shapeAdjust.biasScale;
    }
    const biasAttenuation = (mappingMode === 'B') ? 0.35 : 1;
    let centerBiasX = centerBiasBaseX * centerBiasScale * biasAttenuation;
    let centerBiasY = centerBiasBaseY * centerBiasScale * biasAttenuation;
    if (mappingMode === 'B') {
      const biasClamp = Math.min(1, bandE / 0.6);
      centerBiasX *= biasClamp;
      centerBiasY *= biasClamp;
    }
    let cx = cx0 + dx + centerBiasX;
    let cy = cy0 + dy + centerBiasY;
    // Smooth transition
    let prev = window._bandCenters[i];
    let smooth = 0.78;
    let newCx = prev[0]*smooth + cx*(1-smooth);
    let newCy = prev[1]*smooth + cy*(1-smooth);
    const clamp = (v,min,max)=> Math.max(min, Math.min(max, v));
    // Use pre-calculated region ratios to avoid array creation
    const regionXR = width * BAND_REGION_X_RATIOS[i];
    const regionYR = height * BAND_REGION_Y_RATIOS[i];
    newCx = clamp(newCx, cx0 - regionXR, cx0 + regionXR);
    newCy = clamp(newCy, cy0 - regionYR, cy0 + regionYR);
    bandCenters.push([newCx, newCy]);
    window._bandCenters[i] = [newCx, newCy];
    // Sigma dynamics: base + energy + perturbation + per-band variation
    let sigmaBase = baseSigma * (0.98 + 0.07*Math.sin(t*0.21+i*0.8));
    let sigmaEnergy = 1.0 + bandE*0.22;
    let sigma = sigmaBase * sigmaEnergy * (0.97 + 0.06*Math.cos(t*0.17+i*1.3));
    if (mappingMode === 'B') {
      sigma = baseSigma + (sigma - baseSigma) * (2/3);
    }
    if (mappingMode === 'B') {
      const maxScale = 0.9;
      sigma = Math.min(sigma, baseSigma * maxScale);
    }
    // hi1/kick slightly narrower
    if (i===0||i===4) {
      const narrowFactor = 0.93;
      sigma *= mappingMode === 'B' ? (1 - (1 - narrowFactor) * (2/3)) : narrowFactor;
    }
    if (mappingMode === 'B') {
      const slowState = shapeAccum[i];
      const sigmaMinScale = DEFAULT_SHAPE_SIGMA;
      const sigmaMaxScale = DEFAULT_SHAPE_SIGMA * 2.5;
      const mappedSigma = (typeof map === 'function')
        ? map(slowState, 0, 1, sigmaMinScale, sigmaMaxScale)
        : sigmaMinScale + (sigmaMaxScale - sigmaMinScale) * slowState;
      const baseSigmaScale = DEFAULT_SHAPE_SIGMA || 1;
      const sliderSigmaRatio = baseSigmaScale ? (shapeAdjust.sigmaScale / baseSigmaScale) : 1;
      const combinedScale = mappedSigma * sliderSigmaRatio;
      sigma *= 1 + (combinedScale - 1) * (2/3);
    } else {
      sigma *= shapeAdjust.sigmaScale;
    }
    // Smoothing
    let prevSigma = window._bandSigmaArr[i];
    let sigmaSmooth = 0.82;
    let newSigma = prevSigma*sigmaSmooth + sigma*(1-sigmaSmooth);
    bandSigmaArr.push(newSigma);
    window._bandSigmaArr[i] = newSigma;
  }
  // CPU path (keep CPU rendering only)
  // Pre-check: skip expensive per-pixel calculations if all bands have very low energy
  const ENERGY_THRESHOLD = 0.02;
  const hasVisibleEnergy = bands.some(b => b >= ENERGY_THRESHOLD);

  for (let x=0; x<width; x+=grid) {
    for (let y=0; y<height; y+=grid) {
      // Early exit: if no bands have visible energy, render black immediately
      if (!hasVisibleEnergy) {
        fill(0, 0, 0, 255);
        rect(x, y, 4, 4);
        continue;
      }

      let weights = [];
      let totalWeight = 0;
      for (let i=0; i<5; i++) {
        // Skip calculation for bands with negligible energy (10-15% FPS gain)
        if (bands[i] < ENERGY_THRESHOLD) {
          weights.push(0);
          continue;
        }

        let dx = x-bandCenters[i][0];
        let dy = y-bandCenters[i][1];
        let sigma = bandSigmaArr[i];
        let w = Math.exp(-(dx*dx+dy*dy)/(2*sigma*sigma));
        weights.push(w);
        totalWeight += w;
      }

      // Safety: if no weights (all bands below threshold or too far), render black
      if (totalWeight === 0) {
        fill(0, 0, 0, 255);
        rect(x, y, 4, 4);
        continue;
      }

      for (let i=0; i<5; i++) weights[i] /= totalWeight;
      let idxs = [0,1,2,3,4];
      idxs.sort((a,b)=>weights[b]-weights[a]);
      let maxIdx = idxs[0], secondIdx = idxs[1];
      for (let i=0; i<5; i++) {
        if (i === maxIdx) { weights[i] *= 1.12; } else { weights[i] *= 0.38; }
      }
      let sumW = weights.reduce((a,b)=>a+b,0);
      for (let i=0; i<5; i++) weights[i] = Math.pow(weights[i]/sumW, 1.0);
      let normSum = weights.reduce((a,b)=>a+b,0);
      for (let i=0; i<5; i++) weights[i] /= normSum;

      // Band energy & color mixing
      let w1 = weights[maxIdx], w2 = weights[secondIdx];
      let colorA = auroraColors[maxIdx];
      let colorB = auroraColors[secondIdx];
      let band1 = bands[maxIdx];
      const origin1 = (bandOrigins && bandOrigins[maxIdx] !== undefined) ? bandOrigins[maxIdx] : maxIdx;
      const sensitivity1 = (origin1 === 0 || origin1 === 1) ? HIGH_FREQ_SENSITIVITY : (origin1 === 4 ? LOW_END_SENSITIVITY : 1.0);
      band1 *= sensitivity1;
      let d1 = dist(x, y, bandCenters[maxIdx][0], bandCenters[maxIdx][1]);
      let focus1 = Math.exp(-d1*0.009) * band1;
      let n1 = noise(x*0.003, y*0.003, time*0.12 + maxIdx*0.2);
      let val1 = Math.max(0, Math.min(1, n1 + focus1*1.5));
      let energyThreshold1 = 0.13 + 0.09*maxIdx;
      let a1 = (18 + 22*maxIdx + 60*band1) * Math.pow(val1, 2.2) + (60 + 80*band1)*focus1;
      a1 *= 0.13 + 0.22*band1;
      let show1 = (val1 > energyThreshold1 && band1 > 0.01 && a1 > 1) ? 1 : 0;
      let band2 = bands[secondIdx];
      const origin2 = (bandOrigins && bandOrigins[secondIdx] !== undefined) ? bandOrigins[secondIdx] : secondIdx;
      const sensitivity2 = (origin2 === 0 || origin2 === 1) ? HIGH_FREQ_SENSITIVITY : (origin2 === 4 ? LOW_END_SENSITIVITY : 1.0);
      band2 *= sensitivity2;
      let d2 = dist(x, y, bandCenters[secondIdx][0], bandCenters[secondIdx][1]);
      let focus2 = Math.exp(-d2*0.009) * band2;
      let n2 = noise(x*0.003, y*0.003, time*0.12 + secondIdx*0.2);
      let val2 = Math.max(0, Math.min(1, n2 + focus2*1.5));
      let energyThreshold2 = 0.13 + 0.09*secondIdx;
      let a2 = (18 + 22*secondIdx + 60*band2) * Math.pow(val2, 2.2) + (60 + 80*band2)*focus2;
      a2 *= 0.13 + 0.22*band2;
      let show2 = (val2 > energyThreshold2 && band2 > 0.01 && a2 > 1) ? 1 : 0;
      let blend = 0;
      if (w2 > 0.18 && show1 && show2) {
        blend = w2 / (w1 + w2);
      }
      let r = colorA[0]*(1-blend) + colorB[0]*blend;
      let g = colorA[1]*(1-blend) + colorB[1]*blend;
      let b = colorA[2]*(1-blend) + colorB[2]*blend;
      let alpha = a1*(1-blend) + a2*blend;
      let bandEnergy = band1*(1-blend) + band2*blend;
      if (bandEnergy > 0.01 && alpha > 1) {
        fill(r, g, b, alpha);
        rect(x, y, 4, 4);
      } else {
        fill(0,0,0,255);
        rect(x, y, 4, 4);
      }
    }
  }

  // Preview lights: show five softly glowing regions before playback so users can test Hue
  if (window._previewLights) {
    noStroke();
    for (let i=0;i<5;i++){
      const c = auroraColors[i] || [180,180,180];
      fill(c[0], c[1], c[2], 140);
      const cx = (window._bandCenters && window._bandCenters[i]) ? window._bandCenters[i][0] : (i%2? width*0.75: width*0.25);
      const cy = (window._bandCenters && window._bandCenters[i]) ? window._bandCenters[i][1] : ([height*0.22,height*0.22,height*0.5,height*0.78,height*0.78][i]||height*0.5);
      const d = Math.min(width, height) * 0.22;
      ellipse(cx, cy, d, d);
    }
  }

  // Draw hue ring and triangle (aligned above Hue slider)
  if (window._hueHovered) {
    const ringR = 60;
    let ringX = 32 + 240/2; // fallback
    let ringY = height - 200; // fallback

    const hueRect = (window.huePanelEl && window.huePanelEl.getBoundingClientRect) ? window.huePanelEl.getBoundingClientRect() : null;
    const canvasRect = (window._p5CanvasEl && window._p5CanvasEl.getBoundingClientRect) ? window._p5CanvasEl.getBoundingClientRect() : {left:0, top:0, width: width, height: height};

    if (hueRect) {
      const gap = 16;
      ringX = Math.round(hueRect.left + hueRect.width/2 - canvasRect.left);
      ringY = Math.round(hueRect.top - canvasRect.top - ringR - gap);
    }

    ringX = Math.max(ringR + 12, Math.min(width - ringR - 12, ringX));
    ringY = Math.max(ringR + 12, Math.min(height - ringR - 12, ringY));

    push();
    translate(ringX, ringY);
    // Ring
    for(let i=0;i<360;i+=2){
      let c = hslToRgb(i/360,0.85,0.55);
      stroke(c[0],c[1],c[2]);
      strokeWeight(8);
      let angle = radians(i);
      let x1 = cos(angle)*ringR, y1 = sin(angle)*ringR;
      let x2 = cos(angle)*ringR*0.85, y2 = sin(angle)*ringR*0.85;
      line(x1,y1,x2,y2);
    }
    // Triangle
    let triR = ringR*0.7;
    let triPts = triAngles.map(a => [cos(radians(a))*triR, sin(radians(a))*triR]);
    noFill();
    stroke(255,255,255,180);
    strokeWeight(3);
    beginShape();
    for(let i=0;i<3;i++) vertex(triPts[i][0], triPts[i][1]);
    endShape(CLOSE);
    // Vertex dots and labels (L/M/H)
    let labels = ['L','M','H'];
    for(let i=0;i<3;i++){
      fill(triColors[i][0],triColors[i][1],triColors[i][2]);
      noStroke();
      ellipse(triPts[i][0], triPts[i][1], 16, 16);
      fill(255);
      textAlign(CENTER, CENTER);
      textSize(15);
      text(labels[i], triPts[i][0], triPts[i][1]-22);
    }
    pop();
  }

  // Edge glow overlay for Space key marker (Siri-like soft colorful gradient)
  if (markerPulse) {
    const elapsed = millis() - markerPulse.start;
    const dur = markerPulse.duration || 900;
    if (elapsed >= dur) {
      markerPulse = null;
    } else {
      const t = elapsed / dur; // 0..1
      const ease = Math.sin(t * Math.PI); // in-out
      // thickness anim (half of previous), two-layer glow
      const thick = 0.75 + ease * 2.25; // half of earlier thickness
      const thickOuter = thick * 1.8;
      const alphaBase = (40 + ease * 180) / 3;
      const hueShift = (millis() * 0.12) % 360; // animate hues ~120deg/s

      // draw edge gradient dots with HSB and additive blend for glow
      push();
      blendMode(ADD);
      strokeCap(ROUND);
      // switch to HSB for easy rainbow
      colorMode(HSB, 360, 100, 100, 255);

      const cx = width / 2;
      const cy = height / 2;
      const drawEdgeDots = (inset, weight, alphaMul) => {
        const step = Math.max(2, Math.floor(weight * 0.9));
        // top & bottom edges
        for (let x = inset; x <= width - inset; x += step) {
          const yTop = inset;
          const yBot = height - inset;
          // top
          let ang = Math.atan2(yTop - cy, x - cx);
          let h = ((ang * 180 / Math.PI) + 360) % 360;
          h = (h + hueShift) % 360;
          stroke(h, 80, 100, alphaBase * alphaMul);
          strokeWeight(weight);
          point(x, yTop);
          // bottom
          ang = Math.atan2(yBot - cy, x - cx);
          h = ((ang * 180 / Math.PI) + 360) % 360;
          h = (h + hueShift) % 360;
          stroke(h, 80, 100, alphaBase * alphaMul);
          strokeWeight(weight);
          point(x, yBot);
        }
        // left & right edges
        for (let y = inset; y <= height - inset; y += step) {
          const xL = inset;
          const xR = width - inset;
          // left
          let ang = Math.atan2(y - cy, xL - cx);
          let h = ((ang * 180 / Math.PI) + 360) % 360;
          h = (h + hueShift) % 360;
          stroke(h, 80, 100, alphaBase * alphaMul);
          strokeWeight(weight);
          point(xL, y);
          // right
          ang = Math.atan2(y - cy, xR - cx);
          h = ((ang * 180 / Math.PI) + 360) % 360;
          h = (h + hueShift) % 360;
          stroke(h, 80, 100, alphaBase * alphaMul);
          strokeWeight(weight);
          point(xR, y);
        }
      };

      const insetBase = thick * 0.5;
      // soft outer glow
      drawEdgeDots(insetBase + thick * 0.6, thickOuter, 0.45);
      // crisper inner glow
      drawEdgeDots(insetBase, thick, 1.0);

      // restore RGB color mode for rest of draw
      colorMode(RGB, 255, 255, 255, 255);
      pop();
    }
  }
}



window.addEventListener('DOMContentLoaded', () => {
  flushAllQueues();
  window.addEventListener('online', flushAllQueues);

  // Styles
  const style = document.createElement('style');
  style.id = 'ui-style';
  style.textContent = `
  .glass-panel{background:rgba(30,32,40,0.55);backdrop-filter:saturate(1.1) blur(8px);-webkit-backdrop-filter:saturate(1.1) blur(8px);border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.05)}
  .btn{padding:6px 14px;border-radius:10px;border:none;color:#fff;background:rgba(255,255,255,0.08);cursor:pointer;font-weight:600;transition:.18s ease;min-height:32px;display:inline-flex;align-items:center}
  .btn:hover{background:rgba(255,255,255,0.16)}
  .btn.active{background:#4ecdc4;color:#222}
  .mini-btn{padding:4px 10px;border-radius:10px;font-size:.9em;min-height:32px}
  .row{display:flex;align-items:center;gap:10px}
  .sp-between{justify-content:space-between}
  input[type=range]{-webkit-appearance:none;width:100%;background:transparent}
  input[type=range]::-webkit-slider-runnable-track{height:4px;background:#4ecdc4;border-radius:2px}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;background:#fff;border-radius:50%;margin-top:-5px;border:2px solid #4ecdc4}
  .badge{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:28px;padding:0 8px;border-radius:10px;background:rgba(255,255,255,0.08);color:#fff}
  .panel-label{color:#fff;opacity:.7;font-weight:600;letter-spacing:1px;margin-right:6px}

  /* Color toolbar */
  #color-toolbar{position:fixed;left:24px;bottom:0;transform:translateY(calc(100% - 48px));transition:transform .18s ease;z-index:2000;padding:10px 14px}
  #color-toolbar.expanded{transform:translateY(0)}
  #color-toolbar .ct-header{display:flex;align-items:center;justify-content:center;min-height:36px;width:100%}
  #color-toolbar .ct-content{margin-top:6px}
  #color-toolbar:hover .header-chip .arrow, #color-toolbar.expanded .header-chip .arrow{transform:rotate(180deg)}

  /* Header chip (used by color panel) */
  .header-chip{display:inline-flex;align-items:center;gap:8px}
  .header-chip .title{color:#fff;font-weight:700;letter-spacing:1px}
  .header-chip .arrow{display:inline-block;opacity:.85;transition:transform .18s ease}

  /* Play FAB */
  #play-fab{position:fixed;top:24px;right:24px;width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;z-index:2300;display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;background:rgba(30,32,40,0.55);box-shadow:0 6px 24px rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.05)}
  #play-fab:hover{background:rgba(255,255,255,0.12)}

  /* New panels */
  #control-panel{position:fixed;top:16px;left:24px;z-index:2250;padding:14px 18px;display:none;background:rgba(24,26,32,0.55);border:1px solid rgba(255,255,255,0.05);box-shadow:0 8px 28px rgba(0,0,0,0.35);border-radius:16px;min-width:420px}
  #control-panel .control-row{display:flex;align-items:center;gap:28px;flex-wrap:wrap}
  #control-panel .mode-group{display:flex;align-items:center;gap:10px}
  #control-panel .mode-group .btn{min-width:44px;justify-content:center}
  #control-panel .offset-group{display:flex;align-items:center;gap:12px;flex:1;min-width:260px}
  #control-panel .offset-group .offset-buttons{display:flex;gap:6px}
  #control-panel .offset-group .btn{min-width:56px;justify-content:center}
  #mapping-panel{position:fixed;top:104px;left:24px;width:380px;z-index:2250;padding:18px 24px 24px;display:none;background:rgba(24,26,32,0.55);border:1px solid rgba(255,255,255,0.05);box-shadow:0 10px 34px rgba(0,0,0,0.35);border-radius:18px;font-family:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  #mapping-panel .slider-row{display:flex;align-items:center;gap:14px;margin-top:14px}
  #mapping-panel .slider-row:first-child{margin-top:0}
  #mapping-panel .slider-label{flex:0 0 96px;color:rgba(255,255,255,0.86);font-weight:600;letter-spacing:0.6px}
  #mapping-panel input[type=range]{flex:1;background:linear-gradient(90deg,rgba(105,224,213,0.85),rgba(156,244,235,0.9));height:6px;border-radius:4px;outline:none;-webkit-appearance:none;appearance:none}
  #mapping-panel input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:#fff;border:3px solid rgba(106,237,224,0.8);box-shadow:0 4px 12px rgba(0,0,0,0.35);cursor:pointer}
  #mapping-panel input[type=range]::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:#fff;border:3px solid rgba(106,237,224,0.8);box-shadow:0 4px 12px rgba(0,0,0,0.35);cursor:pointer}
  #mapping-panel .badge{min-width:62px;height:30px;padding:0 10px;border-radius:12px;background:rgba(255,255,255,0.12);color:#f5f9ff;font-weight:600;display:flex;align-items:center;justify-content:center;letter-spacing:0.4px}
  
  /* Welcome Screen */
  #welcome-overlay, #song-overlay, #feedback-overlay, #thanks-overlay, #mode-compare-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: #000;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #fff;
    text-align: center;
    padding: 20px;
    box-sizing: border-box;
    opacity: 1;
    transition: opacity 0.5s ease-out;
  }
  #welcome-overlay.hidden, #song-overlay.hidden, #feedback-overlay.hidden, #thanks-overlay.hidden, #mode-compare-overlay.hidden {
    opacity: 0;
    pointer-events: none;
  }
  #mode-compare-overlay.instant {
    opacity: 1;
    pointer-events: auto;
    transition: none !important;
  }
  .welcome-content {
    max-width: 680px;
  }
  .welcome-title {
    font-size: 56px;
    font-weight: 600;
    margin-bottom: 20px;
    color: #fff;
    text-shadow:
      0 0 7px rgba(255,255,255,0.45),
      0 0 10px rgba(255,255,255,0.45),
      0 0 21px rgba(255,255,255,0.45),
      0 0 42px rgba(78,205,196,0.45),
      0 0 82px rgba(78,205,196,0.45),
      0 0 92px rgba(78,205,196,0.45),
      0 0 102px rgba(78,205,196,0.45),
      0 0 151px rgba(78,205,196,0.45);
  }
  .welcome-text {
    font-size: 18px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.8);
    margin: 20px 0;
  }
  .welcome-text strong {
    color: #4ecdc4;
    font-weight: 600;
  }
  .welcome-button {
    margin-top: 40px;
    padding: 15px 30px;
    font-size: 18px;
    font-weight: 600;
    color: #000;
    background-color: #fff;
    border: none;
    border-radius: 12px;
    cursor: pointer;
    transition: transform 0.2s ease, background-color 0.2s ease;
  }
  .welcome-button:hover {
    background-color: #f0f0f0;
    transform: scale(1.05);
  }
  .mode-demo-grid{
    display:flex;
    gap:32px;
    justify-content:center;
    align-items:flex-start;
    margin:32px 0 24px;
    flex-wrap:wrap;
  }
  .mode-demo-item{
    display:flex;
    flex-direction:column;
    align-items:center;
    width:28vw;
    max-width:360px;
    min-width:220px;
  }
  .mode-demo-item video{
    width:100%;
    height:auto;
    border-radius:16px;
    box-shadow:0 20px 60px rgba(0,0,0,0.35);
    background:#000;
  }
  .mode-demo-label{
    margin-top:12px;
    font-size:18px;
    font-weight:600;
    letter-spacing:1px;
    color:#ffffff;
    text-transform:uppercase;
  }
  .welcome-content.mode-preview{
    max-width:980px;
    width:calc(100% - 48px);
  }
  .mode-preview .mode-line{
    max-width:860px;
    margin:20px auto;
  }
  .mode-preview .mode-line + .mode-demo-grid{
    margin-top:32px;
  }
  .song-grid { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 16px; margin-top: 18px; }
  .song-card { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 14px; }
  .song-title { font-weight: 600; margin-bottom: 8px; }
  .song-actions { display:flex; gap:10px; justify-content:center; }
  .btn.disabled{ opacity:0.4; pointer-events:none; }
  input[type=range].scale { width: 80%; margin-top: 12px; }

  /* Guided Tour Bubbles - Unified Design */
  .tour-bubble-base {
    position: fixed;
    background: rgba(30,32,40,0.96);
    backdrop-filter: saturate(1.1) blur(12px);
    -webkit-backdrop-filter: saturate(1.1) blur(12px);
    border: 1px solid rgba(78, 205, 196, 0.3);
    color: #fff;
    padding: 12px 18px;
    border-radius: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-weight: 500;
    font-size: 14px;
    z-index: 9000;
    opacity: 0;
    transform: scale(0.8) translateY(8px);
    transition: opacity 0.4s cubic-bezier(0.2, 1, 0.3, 1), transform 0.4s cubic-bezier(0.2, 1, 0.3, 1);
    pointer-events: none;
    white-space: nowrap;
    box-shadow: 
      0 8px 32px rgba(0,0,0,0.4),
      0 2px 8px rgba(78, 205, 196, 0.1),
      inset 0 1px 0 rgba(255,255,255,0.1);
  }
  .tour-bubble-base.visible {
    opacity: 1;
    transform: scale(1) translateY(0);
    pointer-events: auto;
  }
  .tour-bubble-base::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(78, 205, 196, 0.05), rgba(78, 205, 196, 0.02));
    border-radius: 14px;
    pointer-events: none;
  }

  #tour-bubble {
    top: 28px;
    right: 84px; /* Position next to the play button */
  }
  #tour-bubble::after { /* The arrow pointing right */
    content: '';
    position: absolute;
    top: 50%;
    left: 100%;
    margin-top: -8px;
    border-width: 8px;
    border-style: solid;
    border-color: transparent transparent transparent rgba(30,32,40,0.96);
    filter: drop-shadow(1px 0 2px rgba(0,0,0,0.2));
  }

  #hue-bubble {
    left: 288px; /* Position to the right of the Hue panel (24px + 240px + 24px) */
    bottom: 24px; /* Align with the bottom of the Hue panel */
  }
  #hue-bubble::after { /* The arrow pointing left */
    content: '';
    position: absolute;
    top: 50%;
    right: 100%;
    margin-top: -8px;
    border-width: 8px;
    border-style: solid;
    border-color: transparent rgba(30,32,40,0.96) transparent transparent;
    filter: drop-shadow(-1px 0 2px rgba(0,0,0,0.2));
  }

  /* Neon step badge */
  .neon-step{display:inline-block;margin-right:8px;padding:2px 8px;border-radius:10px;color:#eaffff;background:rgba(78,205,196,0.15);font-weight:700;letter-spacing:1px;
    box-shadow:0 0 10px rgba(78,205,196,0.35), inset 0 0 6px rgba(78,205,196,0.2);}

  /* Countdown Overlay */
  #countdown-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 9998;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #fff;
    font-size: 18vw;
    font-weight: 200;
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  #countdown-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at center, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0.0) 70%);
    z-index: -1;
  }
  #countdown-overlay.visible {
    opacity: 1;
  }
  #countdown-number {
    transform: scale(0.5);
    opacity: 0;
    text-shadow: 0 0 30px rgba(0,0,0,0.6), 0 0 12px rgba(78,205,196,0.4);
    transition: transform 0.45s cubic-bezier(0.2, 1, 0.3, 1), opacity 0.45s ease;
  }
  #countdown-number.show {
    transform: scale(1);
    opacity: 1;
  }

  /* Tutorial Overlay */
  #tutorial-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    z-index: 9999;
    display: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    pointer-events: none;
  }
  #tutorial-overlay.active {
    display: block;
  }
  #tutorial-content {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .tutorial-title {
    position: absolute;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 2em;
    font-weight: 200;
    color: #4ecdc4;
    text-shadow: 2px 2px 8px rgba(0, 0, 0, 0.8);
    margin: 0;
    white-space: nowrap;
  }
  .tutorial-instruction {
    position: absolute;
    top: 65px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 1.1em;
    color: #e0e0e0;
    text-shadow: 2px 2px 8px rgba(0, 0, 0, 0.8);
    margin: 0;
    white-space: nowrap;
  }
  .tutorial-instruction strong {
    color: #4ecdc4;
    font-weight: 600;
  }
  #tutorial-feedback {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 3em;
    font-weight: 600;
    text-shadow: 3px 3px 12px rgba(0, 0, 0, 0.9);
  }
  #tutorial-feedback.hit {
    color: #5fff5f;
    animation: feedbackPulse 0.5s ease;
  }
  #tutorial-feedback.miss {
    color: #ff5f5f;
    animation: feedbackShake 0.5s ease;
  }
  @keyframes feedbackPulse {
    0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    50% { transform: translate(-50%, -50%) scale(1.2); opacity: 0.8; }
  }
  @keyframes feedbackShake {
    0%, 100% { transform: translate(-50%, -50%) translateX(0); }
    25% { transform: translate(-50%, -50%) translateX(-10px); }
    75% { transform: translate(-50%, -50%) translateX(10px); }
  }
  #tutorial-counter {
    position: fixed;
    bottom: 24px;
    right: 24px;
    font-size: 1.5em;
    color: #4ecdc4;
    font-weight: 600;
    text-shadow: 2px 2px 8px rgba(0, 0, 0, 0.8);
  }
  #tutorial-hit-count {
    color: #fff;
    font-size: 1.2em;
  }
  .tutorial-retry {
    margin-top: 30px;
    padding: 12px 30px;
    font-size: 1.1em;
    background: #4ecdc4;
    color: #1a1a2e;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    transition: all 0.3s ease;
    box-shadow: 0 4px 12px rgba(78, 205, 196, 0.3);
  }
  .tutorial-retry:hover {
    background: #5fe0d0;
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(78, 205, 196, 0.4);
  }
  .tutorial-retry.hidden {
    display: none;
  }
  .tutorial-start {
    position: fixed;
    top: 28px;
    right: 90px;
    padding: 12px 24px;
    font-size: 1.1em;
    background: transparent;
    color: #fff;
    border: none;
    cursor: pointer;
    font-weight: 700;
    transition: all 0.3s ease;
    letter-spacing: 1px;
    text-transform: uppercase;
    text-shadow: 0 0 10px rgba(255, 255, 255, 0.8),
                 0 0 20px rgba(78, 205, 196, 0.6),
                 0 0 30px rgba(78, 205, 196, 0.4),
                 0 0 40px rgba(78, 205, 196, 0.3);
  }
  .tutorial-start:hover {
    text-shadow: 0 0 15px rgba(255, 255, 255, 1),
                 0 0 25px rgba(78, 205, 196, 0.8),
                 0 0 35px rgba(78, 205, 196, 0.6),
                 0 0 45px rgba(78, 205, 196, 0.4);
  }
  .tutorial-start.hidden {
    display: none;
  }

  /* Feedback slider styling */
  .nicer-range { -webkit-appearance:none; appearance:none; width:80%; height:6px; background: linear-gradient(90deg,#4ecdc4,#8df1ea); border-radius: 4px; outline:none; }
  .nicer-range::-webkit-slider-thumb { -webkit-appearance:none; width:22px; height:22px; background:#fff; border:3px solid #4ecdc4; border-radius:50%; box-shadow:0 2px 8px rgba(0,0,0,0.4); cursor:pointer; }
  .nicer-range::-moz-range-thumb { width:22px; height:22px; background:#fff; border:3px solid #4ecdc4; border-radius:50%; box-shadow:0 2px 8px rgba(0,0,0,0.4); cursor:pointer; }

  /* Spacebar hint with bouncing arrow */
  .spacebar-hint {
    margin-top: 30px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .hint-text {
    font-size: 18px;
    color: rgba(255,255,255,0.9);
    font-weight: 600;
    letter-spacing: 0.5px;
    animation: fadePulse 2s ease-in-out infinite;
  }
  .hint-arrow {
    font-size: 48px;
    color: #4ecdc4;
    line-height: 1;
    animation: bounceArrow 1.5s ease-in-out infinite;
    text-shadow: 0 0 20px rgba(78,205,196,0.6);
  }
  @keyframes fadePulse {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 1; }
  }
  @keyframes bounceArrow {
    0%, 100% {
      transform: translateY(0px);
      opacity: 1;
    }
    50% {
      transform: translateY(12px);
      opacity: 0.6;
    }
  }
  `;
  document.head.appendChild(style);

  // Test spacebar canvas overlay (for testing phases - Welcome, Mode Preview, Countdown)
  const testCanvas = document.createElement('canvas');
  testCanvas.id = 'test-spacebar-canvas';
  testCanvas.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 10001;
    display: none;
  `;
  document.body.appendChild(testCanvas);

  // Render loop for test spacebar canvas effect
  const renderTestSpacebarEffect = () => {
    if (!testMarkerPulse) {
      testCanvas.style.display = 'none';
      requestAnimationFrame(renderTestSpacebarEffect);
      return;
    }

    const now = performance.now();
    const elapsed = now - testMarkerPulse.start;
    const dur = testMarkerPulse.duration || 900;

    if (elapsed >= dur) {
      testMarkerPulse = null;
      testCanvas.style.display = 'none';
      requestAnimationFrame(renderTestSpacebarEffect);
      return;
    }

    // Show canvas and resize to window
    testCanvas.style.display = 'block';
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (testCanvas.width !== w || testCanvas.height !== h) {
      testCanvas.width = w;
      testCanvas.height = h;
    }

    const ctx = testCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    // Replicate markerPulse drawing logic exactly
    const t = elapsed / dur; // 0..1
    const ease = Math.sin(t * Math.PI); // in-out
    const thick = 0.75 + ease * 2.25;
    const thickOuter = thick * 1.8;
    const alphaBase = (40 + ease * 180) / 3;
    const hueShift = (now * 0.12) % 360; // ~120deg/s rotation

    ctx.globalCompositeOperation = 'lighter'; // ADD blend mode equivalent
    ctx.lineCap = 'round';

    const cx = w / 2;
    const cy = h / 2;

    const drawEdgeDots = (inset, weight, alphaMul) => {
      const step = Math.max(2, Math.floor(weight * 0.9));

      // Helper to convert HSB to RGB
      const hsbToRgb = (h, s, b, a) => {
        h = h % 360;
        s = s / 100;
        b = b / 100;
        const k = (n) => (n + h / 60) % 6;
        const f = (n) => b * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
        const r = Math.round(255 * f(5));
        const g = Math.round(255 * f(3));
        const bl = Math.round(255 * f(1));
        return `rgba(${r},${g},${bl},${a})`;
      };

      // Top & bottom edges
      for (let x = inset; x <= w - inset; x += step) {
        const yTop = inset;
        const yBot = h - inset;

        // Top
        let ang = Math.atan2(yTop - cy, x - cx);
        let hue = ((ang * 180 / Math.PI) + 360) % 360;
        hue = (hue + hueShift) % 360;
        const alpha = (alphaBase * alphaMul) / 255;
        ctx.fillStyle = hsbToRgb(hue, 80, 100, alpha);
        ctx.beginPath();
        ctx.arc(x, yTop, weight / 2, 0, Math.PI * 2);
        ctx.fill();

        // Bottom
        ang = Math.atan2(yBot - cy, x - cx);
        hue = ((ang * 180 / Math.PI) + 360) % 360;
        hue = (hue + hueShift) % 360;
        ctx.fillStyle = hsbToRgb(hue, 80, 100, alpha);
        ctx.beginPath();
        ctx.arc(x, yBot, weight / 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Left & right edges
      for (let y = inset; y <= h - inset; y += step) {
        const xL = inset;
        const xR = w - inset;

        // Left
        let ang = Math.atan2(y - cy, xL - cx);
        let hue = ((ang * 180 / Math.PI) + 360) % 360;
        hue = (hue + hueShift) % 360;
        const alpha = (alphaBase * alphaMul) / 255;
        ctx.fillStyle = hsbToRgb(hue, 80, 100, alpha);
        ctx.beginPath();
        ctx.arc(xL, y, weight / 2, 0, Math.PI * 2);
        ctx.fill();

        // Right
        ang = Math.atan2(y - cy, xR - cx);
        hue = ((ang * 180 / Math.PI) + 360) % 360;
        hue = (hue + hueShift) % 360;
        ctx.fillStyle = hsbToRgb(hue, 80, 100, alpha);
        ctx.beginPath();
        ctx.arc(xR, y, weight / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const insetBase = thick * 0.5;
    // Soft outer glow
    drawEdgeDots(insetBase + thick * 0.6, thickOuter, 0.45);
    // Crisp inner glow
    drawEdgeDots(insetBase, thick, 1.0);

    requestAnimationFrame(renderTestSpacebarEffect);
  };

  // Start the render loop
  requestAnimationFrame(renderTestSpacebarEffect);

  // Play FAB
  const playFab = document.createElement('button');
  playFab.id = 'play-fab';
  playFab.title = 'Play/Pause (Enter)';
  playFab.textContent = '▶';
  document.body.appendChild(playFab);

  // Color toolbar: header centered (kept)
  const colorToolbar = document.createElement('div');
  colorToolbar.id = 'color-toolbar';
  colorToolbar.className = 'glass-panel';
  colorToolbar.innerHTML = `
    <div class="ct-header">
      <div class="header-chip" id="ct-chip">
        <span class="title">Hue</span>
        <span class="arrow">▲</span>
      </div>
    </div>
    <div class="ct-content">
      <div class="row sp-between" style="gap:10px;align-items:center;">
        <input type="range" id="hue-slider" min="0" max="359" step="1" style="width:180px;background:none;">
        <button id="hue-rand-btn" class="btn mini-btn" title="Random Hue (H)">Hue±</button>
      </div>
    </div>
  `;
  document.body.appendChild(colorToolbar);
  window.huePanelEl = colorToolbar;

  // New: Combined Mode & Offset control panel (top-left)
  const controlPanel = document.createElement('div');
  controlPanel.id = 'control-panel';
  controlPanel.className = 'glass-panel';
  controlPanel.innerHTML = `
    <div class="control-row">
      <div class="mode-group">
        <span class="panel-label">Mode</span>
        <button id="mapping-a-btn" class="btn" title="Switch to A (A)">A</button>
        <button id="mapping-b-btn" class="btn" title="Switch to B (B)">B</button>
        <button id="mode-firm-btn" class="btn mini-btn" title="Pin current mode">Firm</button>
      </div>
      <div class="offset-group">
        <span class="panel-label">Offset</span>
        <input type="range" id="offset-slider" min="-2000" max="2000" step="1" style="flex:1;">
        <span id="offset-value" class="badge">0</span>
        <div class="offset-buttons">
          <button id="offset-m50" class="btn mini-btn" title="-50ms ([)">-50</button>
          <button id="offset-p50" class="btn mini-btn" title="+50ms (])">+50</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(controlPanel);

  // Bind offset slider
  const offsetSlider = document.getElementById('offset-slider');
  const offsetValue = document.getElementById('offset-value');
  if (offsetSlider && offsetValue) {
    offsetSlider.value = String(offsetMs);
    offsetValue.textContent = String(offsetMs);
    offsetSlider.oninput = (e) => {
      const v = parseInt(e.target.value, 10) || 0;
      offsetMs = Math.max(-2000, Math.min(2000, v));
      offsetValue.textContent = String(offsetMs);
    };
  }
  const offsetMinusBtn = document.getElementById('offset-m50');
  const offsetPlusBtn = document.getElementById('offset-p50');
  if (offsetMinusBtn && offsetSlider && offsetValue) {
    offsetMinusBtn.addEventListener('click', () => {
      offsetMs = Math.max(-2000, offsetMs - 50);
      offsetSlider.value = String(offsetMs);
      offsetValue.textContent = String(offsetMs);
    });
  }
  if (offsetPlusBtn && offsetSlider && offsetValue) {
    offsetPlusBtn.addEventListener('click', () => {
      offsetMs = Math.min(2000, offsetMs + 50);
      offsetSlider.value = String(offsetMs);
      offsetValue.textContent = String(offsetMs);
    });
  }

  // Mapping adjustment panel (Backquote hold)
  const mappingPanel = document.createElement('div');
  mappingPanel.id = 'mapping-panel';
  mappingPanel.className = 'glass-panel';
  mappingPanel.innerHTML = `
    <div class="slider-row">
      <span class="slider-label">Global</span>
      <input type="range" id="global-slider" min="0" max="300" step="1">
      <span id="global-value" class="badge">260%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">A Base</span>
      <input type="range" id="a-base-slider" min="0" max="300" step="1">
      <span id="a-base-value" class="badge">150%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">A Peak</span>
      <input type="range" id="a-peak-slider" min="0" max="300" step="1">
      <span id="a-peak-value" class="badge">170%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">A Percentile</span>
      <input type="range" id="a-percentile-slider" min="0" max="50" step="1">
      <span id="a-percentile-value" class="badge">20</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">A NormLimit</span>
      <input type="range" id="a-norm-limit-slider" min="50" max="300" step="5">
      <span id="a-norm-limit-value" class="badge">100%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">A ClipStr</span>
      <input type="range" id="a-clip-str-slider" min="10" max="150" step="5">
      <span id="a-clip-str-value" class="badge">80%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">A NormStr</span>
      <input type="range" id="a-norm-str-slider" min="0" max="100" step="5">
      <span id="a-norm-str-value" class="badge">10%</span>
    </div>
    <div class="slider-row" style="margin-top:18px;">
      <span class="slider-label">Shape σ</span>
      <input type="range" id="shape-sigma-slider" min="0" max="200" step="1">
      <span id="shape-sigma-value" class="badge">90%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">Shape Bias</span>
      <input type="range" id="shape-bias-slider" min="0" max="300" step="1">
      <span id="shape-bias-value" class="badge">116%</span>
    </div>
    <div class="slider-row" style="margin-top:18px;">
      <span class="slider-label">B Attack</span>
      <input type="range" id="b-attack-slider" min="0" max="200" step="1">
      <span id="b-attack-value" class="badge">15%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">B Release</span>
      <input type="range" id="b-release-slider" min="0" max="200" step="1">
      <span id="b-release-value" class="badge">10%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">B Floor</span>
      <input type="range" id="b-floor-slider" min="0" max="200" step="1">
      <span id="b-floor-value" class="badge">110%</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">B Gamma</span>
      <input type="range" id="b-gamma-slider" min="0" max="300" step="1">
      <span id="b-gamma-value" class="badge">100%</span>
    </div>
  `;
  document.body.appendChild(mappingPanel);

  const globalSlider = document.getElementById('global-slider');
  const globalValue = document.getElementById('global-value');
  if (globalSlider && globalValue) {
    const init = Math.round(globalAdjust.brightnessScale * 100);
    globalSlider.value = String(init);
    globalValue.textContent = `${init}%`;
    globalSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(300, parseInt(event.target.value, 10) || init));
      globalAdjust.brightnessScale = val / 100;
      globalValue.textContent = `${val}%`;
    });
  }

  const aBaseSlider = document.getElementById('a-base-slider');
  const aBaseValue = document.getElementById('a-base-value');
  if (aBaseSlider && aBaseValue) {
    const init = Math.round(mappingAAdjust.baseScale * 100);
    aBaseSlider.value = String(init);
    aBaseValue.textContent = `${init}%`;
    aBaseSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(300, parseInt(event.target.value, 10) || init));
      mappingAAdjust.baseScale = val / 100;
      aBaseValue.textContent = `${val}%`;
    });
  }

  const aPeakSlider = document.getElementById('a-peak-slider');
  const aPeakValue = document.getElementById('a-peak-value');
  if (aPeakSlider && aPeakValue) {
    const init = Math.round(mappingAAdjust.peakScale * 100);
    aPeakSlider.value = String(init);
    aPeakValue.textContent = `${init}%`;
    aPeakSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(300, parseInt(event.target.value, 10) || init));
      mappingAAdjust.peakScale = val / 100;
      aPeakValue.textContent = `${val}%`;
    });
  }

  const aPercentileSlider = document.getElementById('a-percentile-slider');
  const aPercentileValue = document.getElementById('a-percentile-value');
  if (aPercentileSlider && aPercentileValue) {
    const init = mappingAAdjust.normPercentile;
    aPercentileSlider.value = String(init);
    aPercentileValue.textContent = String(init);
    aPercentileSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(50, parseInt(event.target.value, 10) || init));
      mappingAAdjust.normPercentile = val;
      aPercentileValue.textContent = String(val);
      // Recalculate normalization when percentile changes
      if (energyLoaded && energyData.length > 0) {
        try {
          perBandNormalizationA = calculatePerBandNormalization(energyData, val);
          console.log('[Mode A] Recalculated normalization with percentile:', val);
        } catch(e) {
          console.warn('Failed to recalculate normalization', e);
        }
      }
    });
  }

  const aNormLimitSlider = document.getElementById('a-norm-limit-slider');
  const aNormLimitValue = document.getElementById('a-norm-limit-value');
  if (aNormLimitSlider && aNormLimitValue) {
    const init = mappingAAdjust.normLimit;
    aNormLimitSlider.value = String(init);
    aNormLimitValue.textContent = `${init}%`;
    aNormLimitSlider.addEventListener('input', (event) => {
      const val = Math.max(50, Math.min(300, parseInt(event.target.value, 10) || init));
      mappingAAdjust.normLimit = val;
      aNormLimitValue.textContent = `${val}%`;
    });
  }

  const aClipStrSlider = document.getElementById('a-clip-str-slider');
  const aClipStrValue = document.getElementById('a-clip-str-value');
  if (aClipStrSlider && aClipStrValue) {
    const init = mappingAAdjust.clipStrength;
    aClipStrSlider.value = String(init);
    aClipStrValue.textContent = `${init}%`;
    aClipStrSlider.addEventListener('input', (event) => {
      const val = Math.max(10, Math.min(150, parseInt(event.target.value, 10) || init));
      mappingAAdjust.clipStrength = val;
      aClipStrValue.textContent = `${val}%`;
    });
  }

  const aNormStrSlider = document.getElementById('a-norm-str-slider');
  const aNormStrValue = document.getElementById('a-norm-str-value');
  if (aNormStrSlider && aNormStrValue) {
    const init = mappingAAdjust.normStrength;
    aNormStrSlider.value = String(init);
    aNormStrValue.textContent = `${init}%`;
    aNormStrSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(100, parseInt(event.target.value, 10) || init));
      mappingAAdjust.normStrength = val;
      aNormStrValue.textContent = `${val}%`;
    });
  }

  const shapeSigmaSlider = document.getElementById('shape-sigma-slider');
  const shapeSigmaValue = document.getElementById('shape-sigma-value');
  if (shapeSigmaSlider && shapeSigmaValue) {
    const init = Math.round(shapeAdjust.sigmaScale * 100);
    shapeSigmaSlider.value = String(init);
    shapeSigmaValue.textContent = `${init}%`;
    shapeSigmaSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(200, parseInt(event.target.value, 10) || init));
      shapeAdjust.sigmaScale = val / 100;
      shapeSigmaValue.textContent = `${val}%`;
    });
  }

  const shapeBiasSlider = document.getElementById('shape-bias-slider');
  const shapeBiasValue = document.getElementById('shape-bias-value');
  if (shapeBiasSlider && shapeBiasValue) {
    const init = Math.round(shapeAdjust.biasScale * 100);
    shapeBiasSlider.value = String(init);
    shapeBiasValue.textContent = `${init}%`;
    shapeBiasSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(300, parseInt(event.target.value, 10) || init));
      shapeAdjust.biasScale = val / 100;
      shapeBiasValue.textContent = `${val}%`;
    });
  }

  const bAttackSlider = document.getElementById('b-attack-slider');
  const bAttackValue = document.getElementById('b-attack-value');
  if (bAttackSlider && bAttackValue) {
    const init = Math.round(mappingBAdjust.attack * 100);
    bAttackSlider.value = String(init);
    bAttackValue.textContent = `${init}%`;
    bAttackSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(200, parseInt(event.target.value, 10) || init));
      mappingBAdjust.attack = val / 100;
      bAttackValue.textContent = `${val}%`;
    });
  }

  const bReleaseSlider = document.getElementById('b-release-slider');
  const bReleaseValue = document.getElementById('b-release-value');
  if (bReleaseSlider && bReleaseValue) {
    const init = Math.round(mappingBAdjust.release * 100);
    bReleaseSlider.value = String(init);
    bReleaseValue.textContent = `${init}%`;
    bReleaseSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(200, parseInt(event.target.value, 10) || init));
      mappingBAdjust.release = val / 100;
      bReleaseValue.textContent = `${val}%`;
    });
  }

  const bFloorSlider = document.getElementById('b-floor-slider');
  const bFloorValue = document.getElementById('b-floor-value');
  if (bFloorSlider && bFloorValue) {
    const init = Math.round(mappingBAdjust.minBaseScale * 100);
    bFloorSlider.value = String(init);
    bFloorValue.textContent = `${init}%`;
    bFloorSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(200, parseInt(event.target.value, 10) || init));
      mappingBAdjust.minBaseScale = val / 100;
      bFloorValue.textContent = `${val}%`;
    });
  }

  const bGammaSlider = document.getElementById('b-gamma-slider');
  const bGammaValue = document.getElementById('b-gamma-value');
  if (bGammaSlider && bGammaValue) {
    const init = Math.round(mappingBAdjust.gammaScale * 100);
    bGammaSlider.value = String(init);
    bGammaValue.textContent = `${init}%`;
    bGammaSlider.addEventListener('input', (event) => {
      const val = Math.max(0, Math.min(300, parseInt(event.target.value, 10) || init));
      mappingBAdjust.gammaScale = val / 100;
      bGammaValue.textContent = `${val}%`;
    });
  }

  // New: Guided Tour Bubble
  const tourBubble = document.createElement('div');
  tourBubble.id = 'tour-bubble';
  tourBubble.className = 'tour-bubble-base';
  tourBubble.innerHTML = '<span class="neon-step">Step 2</span>Click here to start the experience';
  document.body.appendChild(tourBubble);

  // New: Hue Guided Tour Bubble
  const hueBubble = document.createElement('div');
  hueBubble.id = 'hue-bubble';
  hueBubble.className = 'tour-bubble-base';
  hueBubble.innerHTML = '<span class="neon-step">Step 1</span>Assign color mapping as you wish through the color panel';
  document.body.appendChild(hueBubble);

  // New: Countdown Overlay
  const countdownOverlay = document.createElement('div');
  countdownOverlay.id = 'countdown-overlay';
  countdownOverlay.innerHTML = '<div id="countdown-number"></div>';
  document.body.appendChild(countdownOverlay);

  // Tutorial Overlay
  const tutorialOverlay = document.createElement('div');
  tutorialOverlay.id = 'tutorial-overlay';
  tutorialOverlay.innerHTML = `
    <div id="tutorial-content">
      <h2 class="tutorial-title">Tutorial</h2>
      <p class="tutorial-instruction">Press <strong>SPACEBAR</strong> when you notice the visual pattern change!</p>
      <div id="tutorial-feedback"></div>
      <div id="tutorial-counter">Hits: <span id="tutorial-hit-count">0</span>/${tutorialRequiredHits}</div>
      <button id="tutorial-retry-btn" class="tutorial-retry hidden">Retry Tutorial</button>
      <button id="tutorial-start-btn" class="tutorial-start hidden">Start Experiment</button>
    </div>
  `;
  document.body.appendChild(tutorialOverlay);

  // Tutorial Functions
  let tutorialModeListener = null;

  function startTutorial() {
    console.log('[Tutorial] Starting tutorial');
    tutorialActive = true;
    tutorialPassed = false;
    tutorialHitCount = 0;
    tutorialMissCount = 0;
    tutorialSwitches = [];

    // Generate tutorial mode switches (extended duration for more practice)
    const tutorialDuration = 45; // seconds - extended for more practice time
    const numSwitches = 5; // Ensure at least 5 opportunities
    tutorialStartTime = 0;

    for (let i = 0; i < numSwitches; i++) {
      const switchTime = (tutorialDuration / (numSwitches + 1)) * (i + 1) + (Math.random() * 2 - 1);
      tutorialSwitches.push(switchTime);
    }
    tutorialSwitches.sort((a, b) => a - b);
    console.log('[Tutorial] Switch times:', tutorialSwitches);

    // Show tutorial overlay
    tutorialOverlay.classList.add('active');
    document.getElementById('tutorial-hit-count').textContent = '0';
    document.getElementById('tutorial-feedback').textContent = '';
    document.getElementById('tutorial-retry-btn').classList.add('hidden');

    // Set up tutorial audio segment
    if (window.audio) {
      window.audio.currentTime = 0;
      tutorialStartTime = 0;
      allowSpaceTesting = false;
      window._tutorialMode = true;
      window._previewLights = false; // Disable preview lights during tutorial

      // Ensure audio is playing
      if (window.audio.paused) {
        window.audio.play().then(() => {
          console.log('[Tutorial] Audio started playing');
        }).catch(err => {
          console.error('[Tutorial] Audio play failed:', err);
        });
      }

      // Set up automatic mode switching during tutorial using setTimeout for precision
      // Clear any existing timers first
      tutorialSwitchTimers.forEach(timer => clearTimeout(timer));
      tutorialSwitchTimers = [];

      // Schedule all tutorial switches using setTimeout (like in experiment)
      // This ensures precise timing instead of relying on imprecise timeupdate events
      // IMPORTANT: Calculate delay relative to current audio position
      tutorialSwitches.forEach((switchTime) => {
        const currentAudioTime = window.audio.currentTime;
        const remainingTime = switchTime - currentAudioTime;

        // Only schedule if switch is in the future
        if (remainingTime > 0) {
          const delayMs = remainingTime * 1000; // Convert remaining seconds to milliseconds
          const timer = setTimeout(() => {
            if (!tutorialActive) return;

            const newMode = mappingMode === 'A' ? 'B' : 'A';
            setMapping(newMode);
            console.log('[Tutorial] Auto-switched to mode', newMode, 'at', window.audio.currentTime, 'scheduled at', switchTime);
          }, delayMs);

          tutorialSwitchTimers.push(timer);
        }
      });

      // Set up listener only for checking tutorial end
      tutorialModeListener = function() {
        const currentTime = window.audio.currentTime;

        // Auto-end tutorial after duration
        if (currentTime >= tutorialDuration) {
          if (tutorialHitCount < tutorialRequiredHits) {
            // Show retry option
            const feedbackEl = document.getElementById('tutorial-feedback');
            feedbackEl.textContent = 'Tutorial incomplete. Try again?';
            feedbackEl.className = 'miss';
            document.getElementById('tutorial-retry-btn').classList.remove('hidden');
            window.audio.pause();
            window.audio.removeEventListener('timeupdate', tutorialModeListener);
            tutorialActive = false;

            // Clear any pending switch timers
            tutorialSwitchTimers.forEach(timer => clearTimeout(timer));
            tutorialSwitchTimers = [];
          }
        }
      };

      window.audio.addEventListener('timeupdate', tutorialModeListener);
    }
  }

  function checkTutorialHit() {
    if (!tutorialActive || !window.audio) return;

    const currentTime = window.audio.currentTime;
    const feedbackEl = document.getElementById('tutorial-feedback');

    // Check if hit is within window of any switch
    let isHit = false;
    let hitType = '';

    for (let switchTime of tutorialSwitches) {
      const timeDiff = currentTime - switchTime;  // Positive = after switch, Negative = before switch
      // Match experiment logic: ONLY count hits AFTER switch (0 to 2.0 seconds)
      // Per thesis document line 222: "Hit: RT ∈ [0, 2000] ms"
      // Anticipatory responses (RT < 0) are NOT counted as hits
      if (timeDiff >= 0 && timeDiff <= 2.0) {
        isHit = true;
        tutorialHitCount++;
        console.log('[Tutorial] Hit! RT =', timeDiff.toFixed(2), 's after switch');

        // Remove this switch from the array so it can't be hit twice
        const idx = tutorialSwitches.indexOf(switchTime);
        if (idx > -1) tutorialSwitches.splice(idx, 1);

        break;
      }
    }

    // Update feedback
    if (isHit) {
      feedbackEl.textContent = '✓ Hit!';
      feedbackEl.className = 'hit';
      tutorialMissCount = 0; // Reset miss count on hit
      console.log('[Tutorial] Hit! Count:', tutorialHitCount);
    } else {
      tutorialMissCount++;
      console.log('[Tutorial] Miss at time:', currentTime, 'Miss count:', tutorialMissCount);

      // Penalty: 2 misses reduce hit count by 1
      if (tutorialMissCount >= 2) {
        tutorialHitCount = Math.max(0, tutorialHitCount - 1);
        tutorialMissCount = 0; // Reset miss counter
        feedbackEl.textContent = '⚠️ -1 Hit (2 misses)';
        console.log('[Tutorial] Penalty applied! New hit count:', tutorialHitCount);
      } else {
        // Simple miss feedback - no complex early/late logic
        feedbackEl.textContent = 'Missed!';
      }
      feedbackEl.className = 'miss';
    }

    // Update counter
    document.getElementById('tutorial-hit-count').textContent = tutorialHitCount;

    // Clear feedback after animation - text disappears completely
    setTimeout(() => {
      feedbackEl.textContent = '';
      feedbackEl.className = '';
    }, 1500);

    // Check if tutorial complete
    if (tutorialHitCount >= tutorialRequiredHits) {
      setTimeout(() => {
        completeTutorial();
      }, 800);
    }
  }

  function completeTutorial() {
    console.log('[Tutorial] Tutorial passed!');
    tutorialActive = false;
    tutorialPassed = true;
    window._tutorialMode = false;

    // Clean up event listener
    if (window.audio && tutorialModeListener) {
      window.audio.removeEventListener('timeupdate', tutorialModeListener);
      tutorialModeListener = null;
    }

    // Clear any pending switch timers
    tutorialSwitchTimers.forEach(timer => clearTimeout(timer));
    tutorialSwitchTimers = [];

    // Show success message and Start button
    const feedbackEl = document.getElementById('tutorial-feedback');
    feedbackEl.textContent = '🎉 Tutorial Complete!';
    feedbackEl.className = 'hit';

    // Keep all elements visible - don't hide title, instruction, or counter
    // They will all be hidden together when play button is clicked

    // Show Start button
    const startBtn = document.getElementById('tutorial-start-btn');
    if (startBtn) {
      startBtn.classList.remove('hidden');
      startBtn.style.display = 'block';
    }

    // Pause audio and reset
    if (window.audio) {
      window.audio.pause();
      window.audio.currentTime = 0;
    }
  }

  function failTutorial() {
    console.log('[Tutorial] Tutorial failed - no retry for now');
    // For now, we won't auto-fail - just let them keep trying
  }

  // Tutorial retry button handler
  document.getElementById('tutorial-retry-btn').addEventListener('click', () => {
    if (window.audio) {
      window.audio.pause();
      window.audio.currentTime = 0;
    }
    startTutorial();
  });

  // Tutorial start experiment button handler
  document.getElementById('tutorial-start-btn').addEventListener('click', async () => {
    // Hide tutorial overlay immediately when button is clicked
    tutorialOverlay.classList.remove('active');

    // Explicitly hide all tutorial child elements to ensure they disappear
    const tutorialTitle = tutorialOverlay.querySelector('.tutorial-title');
    const tutorialInstruction = tutorialOverlay.querySelector('.tutorial-instruction');
    const tutorialCounter = document.getElementById('tutorial-counter');
    const tutorialFeedback = document.getElementById('tutorial-feedback');
    const startBtn = document.getElementById('tutorial-start-btn');

    if (tutorialTitle) tutorialTitle.style.display = 'none';
    if (tutorialInstruction) tutorialInstruction.style.display = 'none';
    if (tutorialCounter) tutorialCounter.style.display = 'none';
    if (tutorialFeedback) tutorialFeedback.style.display = 'none';
    if (startBtn) startBtn.style.display = 'none';

    // Hide all UI panels - only play button should remain visible
    const colorToolbar = document.getElementById('color-toolbar');
    const controlPanel = document.getElementById('control-panel');
    const mappingPanel = document.getElementById('mapping-panel');
    const tourBubble = document.getElementById('tour-bubble');
    const hueBubble = document.getElementById('hue-bubble');

    if (colorToolbar) colorToolbar.style.display = 'none';
    if (controlPanel) controlPanel.style.display = 'none';
    if (mappingPanel) mappingPanel.style.display = 'none';
    if (tourBubble) tourBubble.style.display = 'none';
    if (hueBubble) hueBubble.style.display = 'none';

    // Ensure session is started
    const ready = await ensureSessionStarted();
    if (!ready) {
      return;
    }

    // Start countdown directly
    if (featureConfig.enableCountdown) {
      featureUsage.hadCountdown = true;
      const countdownNumber = document.getElementById('countdown-number');
      countdownOverlay.classList.add('visible');
      countdownActive = true;
      allowSpaceTesting = true;
      let count = 3;

      const showNumber = (num) => {
        countdownNumber.textContent = num;
        countdownNumber.classList.add('show');
        setTimeout(() => {
          countdownNumber.classList.remove('show');
        }, 650);
      };

      const countdownInterval = setInterval(() => {
        if (count > 0) {
          showNumber(count);
          count--;
        } else {
          clearInterval(countdownInterval);
          countdownOverlay.classList.remove('visible');
          countdownActive = false;
          allowSpaceTesting = false;
          if (window.audio) {
            window.audio.play();
            markPlaybackStarted();
            window._previewLights = false;
            setPlayIcon();
          }
        }
      }, 1000);
    } else {
      allowSpaceTesting = false;
      countdownActive = false;
      if (window.audio) {
        window.audio.play();
        markPlaybackStarted();
        window._previewLights = false;
        setPlayIcon();
      }
    }
  });

  const modeCompareOverlay = document.createElement('div');
  modeCompareOverlay.id = 'mode-compare-overlay';
  modeCompareOverlay.classList.add('hidden');
  modeCompareOverlay.innerHTML = `
    <div class="welcome-content mode-preview">
      <h1 class="welcome-title">Mode Mapping Preview</h1>
      <p class="welcome-text mode-line"><strong style="color:#4ecdc4;">IMPORTANT:</strong> Press <strong style="color:#4ecdc4;">SPACEBAR</strong> whenever you notice the visual pattern change!</p>
      <p class="welcome-text mode-line">The experiment contains two modes: Mode A (instant response) and Mode B (energy accumulation).
      The experiment will start randomly from either mode A or B, with automatic switches between.</p>
      <div class="mode-demo-grid">
        <div class="mode-demo-item">
          <video src="./videos/M-A.mp4" autoplay muted loop playsinline></video>
          <span class="mode-demo-label">Mode A</span>
        </div>
        <div class="mode-demo-item">
          <video src="./videos/M-B.mp4" autoplay muted loop playsinline></video>
          <span class="mode-demo-label">Mode B</span>
        </div>
      </div>
      <p class="welcome-text mode-line">The colored regions may relocate smoothly when you achieve several consecutive accurate presses.
      Please adjust the Color panel based on your perference first, then you can start detecting changes.</p>
      <button class="welcome-button" id="mode-compare-continue">Continue</button>
      <div class="spacebar-hint">
        <p class="hint-text">You can press SPACEBAR now to see the effect</p>
        <div class="hint-arrow">↓</div>
      </div>
    </div>
  `;
  document.body.appendChild(modeCompareOverlay);
  const modeCompareContinueBtn = modeCompareOverlay.querySelector('#mode-compare-continue');

  function showGuidedBubbles(){
    const tourBubbleEl = document.getElementById('tour-bubble');
    if (tourBubbleEl) tourBubbleEl.classList.add('visible');
    const hueBubbleEl = document.getElementById('hue-bubble');
    if (hueBubbleEl) hueBubbleEl.classList.add('visible');
  }

  let modeCompareShown = false;
  function showModeCompareOverlay(next){
    if (modeCompareShown) {
      if (typeof next === 'function') next();
      return;
    }
    allowSpaceTesting = true;
    modeCompareShown = true;
    modeCompareOverlay.classList.add('instant');
    modeCompareOverlay.classList.remove('hidden');
    requestAnimationFrame(() => {
      modeCompareOverlay.classList.remove('instant');
    });
    const handleContinue = () => {
      modeCompareOverlay.classList.add('hidden');
      modeCompareContinueBtn.removeEventListener('click', handleContinue);
      setTimeout(() => {
        if (typeof next === 'function') next();
      }, 350);
    };
    modeCompareContinueBtn.addEventListener('click', handleContinue);
  }

  // --- LOGIC ---

  // Randomize starting mode
  mappingMode = Math.random() < 0.5 ? 'A' : 'B';
  console.log(`Starting with random mode: ${mappingMode}`);

  // Mapping buttons
  const mappingABtn = document.getElementById('mapping-a-btn');
  const mappingBBtn = document.getElementById('mapping-b-btn');
  function setMapping(mode){
    // de-dup: only act when mode actually changes
    if (mode === mappingMode) { updateMappingUI(); return; }
    if (window.audio) {
      lastSwitchTime = window.audio.currentTime;
    }
    mappingMode = mode;
    if (energyLoaded && energyData.length > 0) {
      let frameIdx = 0;
      if (window.audio && !window.audio.paused && !isNaN(window.audio.currentTime)) {
        // Calculate raw frame time, then clamp before flooring to avoid negative indices
        const rawFrameTime = (window.audio.currentTime * csvFps) - (offsetMs / 1000 * csvFps);
        frameIdx = Math.floor(Math.max(0, rawFrameTime));
        frameIdx = Math.min(energyData.length - 1, frameIdx);
      } else {
        frameIdx = energyFrame % energyData.length;
      }
      const row = energyData[frameIdx];
      for (let i=0;i<5;i++) {
        const v = (row && typeof row[i] === 'number' && isFinite(row[i])) ? Math.max(row[i], 0) : 0.09;
        bandAccum[i] = v;
        modeBAmbientAccum[i] = v;
        shapeAccum[i] = v;
        modeBPrevFinal[i] = v;
      }
      // Reset Mode B buffers to prevent old data from affecting new mode
      window.bandDelay = [[],[],[],[],[]];
      if (typeof window._bandSmoothB !== 'undefined') {
        window._bandSmoothB = [0,0,0,0,0];
      }
    }
    updateMappingUI();

    // P0: log system switch event (only observe; mappingId used to carry lighthouse info if available)
    try{
      const nowT = (window.audio && !isNaN(window.audio.currentTime)) ? window.audio.currentTime : 0;
      // Hard-mode spatial rotate (no lighthouse): rotate occasionally with cooldown >=25s
      if (typeof window._slotMap === 'undefined') window._slotMap = [0,1,2,3,4];
      if (typeof window._lastSpatialSwitchT === 'undefined') window._lastSpatialSwitchT = -1e9;
      if (typeof window._currentMappingLabel === 'undefined') window._currentMappingLabel = 'none';
      if (difficulty === 'hard' && window.audio && !window.audio.paused) {
        const cooldown = getAdaptiveCooldownSec();
        if (nowT - window._lastSpatialSwitchT >= cooldown) {
          const sm = window._slotMap.slice();
          const method = (Math.random() < 0.7) ? 'rotate' : 'mirror';
          const rot = (arr,k)=> arr.map((_,i)=> arr[(i - k + arr.length)%arr.length]);
          if (method === 'rotate'){
            const step = (Math.random()<0.5)?1:2; // rotate 1 or 2
            window._slotMap = rot(sm, step);
            window._currentMappingLabel = `r${step}`;
          } else {
            // mirror horizontally or vertically (positions: 0 TL,1 TR,2 C,3 BL,4 BR)
            if (Math.random()<0.5){
              // horizontal mirror: swap left<->right
              window._slotMap = [ sm[1], sm[0], sm[2], sm[4], sm[3] ];
              window._currentMappingLabel = 'mh';
            } else {
              // vertical mirror: swap top<->bottom
              window._slotMap = [ sm[3], sm[4], sm[2], sm[0], sm[1] ];
              window._currentMappingLabel = 'mv';
            }
          }
          window._lastSpatialSwitchT = nowT;
        }
      }
      if (!sessionId) return;
      const mappingLabel = window._currentMappingLabel || 'none';
      const deltaE = (typeof energyDeltaAtTimeSec==='function' && window.audio) ? energyDeltaAtTimeSec(nowT) : null;
      const payload = {
        sessionId: sessionId,
        switchTime: nowT,
        difficulty: (typeof difficulty !== 'undefined') ? difficulty : null,
        mappingId: mappingLabel,
        deltaE: deltaE
      };
      postWithRetry('/api/switch', payload, SWITCH_QUEUE_KEY)
        .then(success => {
          if (!success) {
            console.warn('Switch log queued for retry');
          }
        })
        .catch(err => console.error('Switch log failed:', err));
    }catch(e){ console.warn('log switch failed', e); }
  }
  let modeFirm = false;
  function updateMappingUI() {
    mappingABtn.classList.toggle('active', mappingMode==='A');
    mappingBBtn.classList.toggle('active', mappingMode==='B');
    modeFirmBtn.classList.toggle('active', modeFirm);
    modeFirmBtn.textContent = modeFirm ? 'Firm✓' : 'Firm';
  }
  mappingABtn.onclick = () => { if (!modeFirm) setMapping('A'); };
  mappingBBtn.onclick = () => { if (!modeFirm) setMapping('B'); };
  const modeFirmBtn = document.getElementById('mode-firm-btn');
  if (modeFirmBtn) {
    modeFirmBtn.addEventListener('click', () => {
      modeFirm = !modeFirm;
      if (modeFirm) {
        stopModeAutoSwitch();
      } else if (audio && !audio.paused) {
        startModeAutoSwitch();
      }
      updateMappingUI();
    });
  }
  updateMappingUI();

  // Audio wiring
  let audioLoaded = false;
  let audio;
  window.audio = null;
  const DEFAULT_AUDIO_SRC = 'stems/stem-full.mp3';
  // Auto A/B switch scheduler (runs only while playing)
  let modeSwitchTimer = null;
  // --- Adaptive auto-switch config/state ---
  // Base intervals (ms)
  let DIFF_MIN_MS_NORMAL = 3000, DIFF_MAX_MS_NORMAL = 9000;   // normal: 3–9s
  let DIFF_MIN_MS_HARD   = 2600, DIFF_MAX_MS_HARD   = 6000;   // hard:   2.6–6s
  // Soft-start window
  const SOFT_START_SEC = 60;                                   // first 60s
  const SOFT_MIN_MS = 4000, SOFT_MAX_MS = 8000;                // 4–8s
  let hitWindowSec = 2.0;     // <= this = hit (was 0.7)
  let goodWindowSec = 1.5;    // <= this = very good (was 0.5)
  let goodStreak = 0;         // consecutive very-good hits
  let recentHits = [];        // last N boolean
  const RECENT_N = 4;         // was 6
  let difficulty = 'normal';  // 'normal' | 'hard'
  const DIFF_UP_THRESHOLD = 0.75;
  const DIFF_DOWN_THRESHOLD = 0.50;
  const DIFF_MIN_HOLD_SEC = 5; // minimum time before changing difficulty
  let lastDifficultyChangeT = 0;

  function recomputeDifficulty(){
    const hitRate = recentHits.length ? (recentHits.reduce((a,b)=>a+(b?1:0),0)/recentHits.length) : 0;
    window._hitRate = hitRate; // expose for adaptive cooldown
    const nowT = (window.audio && !isNaN(window.audio.currentTime)) ? window.audio.currentTime : (performance.now()/1000);
    if (!Number.isFinite(lastDifficultyChangeT)) lastDifficultyChangeT = nowT;
    const elapsed = nowT - lastDifficultyChangeT;
    const canChange = elapsed >= DIFF_MIN_HOLD_SEC;
    const wantsHard = (goodStreak >= 2) || (hitRate >= DIFF_UP_THRESHOLD);
    const wantsNormal = hitRate <= DIFF_DOWN_THRESHOLD;
    let next = difficulty;
    if (canChange) {
      if (difficulty !== 'hard' && wantsHard) {
        next = 'hard';
      } else if (difficulty !== 'normal' && wantsNormal) {
        next = 'normal';
      }
    }
    if (next !== difficulty) {
      difficulty = next;
      lastDifficultyChangeT = nowT;
      console.debug('[Difficulty] change', { difficulty, hitRate, goodStreak, elapsed });
    }
  }

  // Adaptive cooldown: 10–20s sliding by last 4 hits + ±10% jitter
  function getAdaptiveCooldownSec(){
    const hr = (typeof window._hitRate === 'number') ? window._hitRate : 0.5;
    let minB=13, maxB=17; // default middle band
    if (hr >= 0.75){ minB=10; maxB=13; }
    else if (hr <= 0.25){ minB=17; maxB=20; }
    let base = minB + Math.random()*(maxB-minB);
    const jitter = 1 + (Math.random()*0.2 - 0.1); // ±10%
    const v = Math.min(20, Math.max(10, base*jitter));
    return v;
  }

  const MIN_AUTO_DELAY_MS = 2500;

  function pickDelayMsWithDifficulty(){
    // Soft-start: first 30s slower regardless of difficulty
    const nowT = (window.audio && !isNaN(window.audio.currentTime)) ? window.audio.currentTime : 0;
    let minMs, maxMs;
    if (nowT < SOFT_START_SEC){
      minMs = SOFT_MIN_MS; maxMs = SOFT_MAX_MS;
    } else if (difficulty === 'hard'){
      minMs = DIFF_MIN_MS_HARD; maxMs = DIFF_MAX_MS_HARD;
    } else {
      minMs = DIFF_MIN_MS_NORMAL; maxMs = DIFF_MAX_MS_NORMAL;
    }
    const base = minMs + Math.random()*Math.max(0, maxMs-minMs);
    const jitter = 1 + (Math.random()*0.2 - 0.1); // ±10%
    return Math.max(MIN_AUTO_DELAY_MS, base * jitter);
  }

  function energyDeltaAtTimeSec(tSec){
    if (!energyLoaded || !energyData.length) return Infinity;
    const idx = Math.max(1, Math.min(energyData.length-1, Math.floor(tSec*csvFps)));
    const row = energyData[idx] || [];
    const prev = energyData[idx-1] || [];
    let d = 0;
    for(let i=0;i<5;i++){ const a=row[i]||0, b=prev[i]||0; d += Math.abs(a-b); }
    return d;
  }

  function scheduleNextModeSwitch(){
    if (!audio || audio.paused) {
      console.debug('[AutoSwitch] paused, skip scheduling');
      return;
    }
    const delayBase = pickDelayMsWithDifficulty();
    let delay = delayBase;
    // On hard mode, prefer a future moment with lower energy change within the window
    try{
      if (difficulty === 'hard' && audio && isFinite(audio.duration) && !audio.paused){
        const nowT = audio.currentTime;
        const minS = delayBase/1000 - 0.4; // allow slight earlier/later around base
        const maxS = delayBase/1000 + 0.6;
        let bestOffset = delayBase/1000;
        let bestScore = Infinity;
        for (let s = minS; s <= maxS; s += 0.2){
          const t = nowT + Math.max(0.6, s); // ensure >=0.6s in future
          const sc = energyDeltaAtTimeSec(t);
          if (sc < bestScore){ bestScore = sc; bestOffset = s; }
        }
        delay = Math.max(MIN_AUTO_DELAY_MS, Math.round(bestOffset*1000));
      }
    }catch(e){}

    console.debug('[AutoSwitch]', {difficulty, delay});
    if (modeFirm) return;
    modeSwitchTimer = setTimeout(()=>{
      modeSwitchTimer = null;
      try{
        if (audio && !audio.paused && !modeFirm) {
          // Always toggle to ensure a real switch (avoid logging no-op)
          const next = (mappingMode === 'A') ? 'B' : 'A';
          setMapping(next);
        }
      } finally {
        if (audio && !audio.paused && !modeFirm) scheduleNextModeSwitch();
      }
    }, delay);
  }
  function startModeAutoSwitch(){
    if (modeFirm) return;
    if (!modeSwitchTimer){
      console.debug('[AutoSwitch] start');
      goodStreak = 0;
      recentHits.length = 0;
      difficulty = 'normal';
      lastDifficultyChangeT = (window.audio && !isNaN(window.audio.currentTime)) ? window.audio.currentTime : (performance.now()/1000);
      scheduleNextModeSwitch();
    }
  }
  function stopModeAutoSwitch(){ if (modeSwitchTimer){ console.debug('[AutoSwitch] stop'); clearTimeout(modeSwitchTimer); modeSwitchTimer = null; } }

  function playCSV(){ if (!csvPlaying){ csvPlaying = true; csvInterval = setInterval(()=>{ if (energyLoaded && csvPlaying){ energyFrame = (energyFrame + 1) % energyData.length; } }, 1000/csvFps); } }
  function pauseCSV(){ csvPlaying = false; if (csvInterval) clearInterval(csvInterval); }
  function setPlayIcon(){ playFab.textContent = (audio && !audio.paused && audioLoaded) ? '❚❚' : '▶'; }
  async function togglePlay(){
    if (!audioLoaded) return;

    // Hide both tour bubbles when play is clicked for the first time
    if (tourBubble.classList.contains('visible')) {
      tourBubble.classList.remove('visible');
    }
    if (hueBubble.classList.contains('visible')) {
      hueBubble.classList.remove('visible');
    }

    if (audio.paused){
      const ready = await ensureSessionStarted();
      if (!ready) {
        setPlayIcon();
        return;
      }

      // Check if tutorial needs to be completed first
      if (!tutorialPassed) {
        startTutorial();
        audio.play();
        markPlaybackStarted();
        setPlayIcon();
        return;
      }

      if (featureConfig.enableCountdown) {
        // Hide all UI elements before countdown - only play button should remain visible
        const tutorialOverlay = document.getElementById('tutorial-overlay');
        const colorToolbar = document.getElementById('color-toolbar');
        const controlPanel = document.getElementById('control-panel');
        const mappingPanel = document.getElementById('mapping-panel');
        const tourBubble = document.getElementById('tour-bubble');
        const hueBubble = document.getElementById('hue-bubble');

        if (tutorialOverlay) tutorialOverlay.classList.remove('active');
        if (colorToolbar) colorToolbar.style.display = 'none';
        if (controlPanel) controlPanel.style.display = 'none';
        if (mappingPanel) mappingPanel.style.display = 'none';
        if (tourBubble) tourBubble.style.display = 'none';
        if (hueBubble) hueBubble.style.display = 'none';

        // Also explicitly hide all tutorial child elements
        const tutorialTitle = document.querySelector('.tutorial-title');
        const tutorialInstruction = document.querySelector('.tutorial-instruction');
        const tutorialCounter = document.getElementById('tutorial-counter');
        const tutorialFeedback = document.getElementById('tutorial-feedback');
        const startBtn = document.getElementById('tutorial-start-btn');

        if (tutorialTitle) tutorialTitle.style.display = 'none';
        if (tutorialInstruction) tutorialInstruction.style.display = 'none';
        if (tutorialCounter) tutorialCounter.style.display = 'none';
        if (tutorialFeedback) tutorialFeedback.style.display = 'none';
        if (startBtn) startBtn.style.display = 'none';

        featureUsage.hadCountdown = true;
        const countdownNumber = document.getElementById('countdown-number');
        countdownOverlay.classList.add('visible');
        countdownActive = true;
        allowSpaceTesting = true;
        let count = 3;

        const showNumber = (num) => {
          countdownNumber.textContent = num;
          countdownNumber.classList.add('show');
          setTimeout(() => {
            countdownNumber.classList.remove('show');
          }, 650);
        };

        const countdownInterval = setInterval(() => {
          if (count > 0) {
            showNumber(count);
            count--;
          } else {
            clearInterval(countdownInterval);
            countdownOverlay.classList.remove('visible');
            countdownActive = false;
            allowSpaceTesting = false;
            audio.play();
            markPlaybackStarted();
            window._previewLights = false;
            setPlayIcon();
          }
        }, 1000);
      } else {
        // Hide all UI elements when playing without countdown
        const tutorialOverlay = document.getElementById('tutorial-overlay');
        const colorToolbar = document.getElementById('color-toolbar');
        const controlPanel = document.getElementById('control-panel');
        const mappingPanel = document.getElementById('mapping-panel');
        const tourBubble = document.getElementById('tour-bubble');
        const hueBubble = document.getElementById('hue-bubble');

        if (tutorialOverlay) tutorialOverlay.classList.remove('active');
        if (colorToolbar) colorToolbar.style.display = 'none';
        if (controlPanel) controlPanel.style.display = 'none';
        if (mappingPanel) mappingPanel.style.display = 'none';
        if (tourBubble) tourBubble.style.display = 'none';
        if (hueBubble) hueBubble.style.display = 'none';

        // Also explicitly hide all tutorial child elements
        const tutorialTitle = document.querySelector('.tutorial-title');
        const tutorialInstruction = document.querySelector('.tutorial-instruction');
        const tutorialCounter = document.getElementById('tutorial-counter');
        const tutorialFeedback = document.getElementById('tutorial-feedback');
        const startBtn = document.getElementById('tutorial-start-btn');

        if (tutorialTitle) tutorialTitle.style.display = 'none';
        if (tutorialInstruction) tutorialInstruction.style.display = 'none';
        if (tutorialCounter) tutorialCounter.style.display = 'none';
        if (tutorialFeedback) tutorialFeedback.style.display = 'none';
        if (startBtn) startBtn.style.display = 'none';

        allowSpaceTesting = false;
        countdownActive = false;
        audio.play();
        markPlaybackStarted();
        window._previewLights = false;
        setPlayIcon();
      }
    } else {
      audio.pause();
      setPlayIcon();
    }
  }
  const loadAudioSource = (src) => {
    if (audio){
      audio.pause();
      audio.currentTime = 0;
      audio.onended = null;
    }
    stopModeAutoSwitch();
    modeBPrevFinal = [0,0,0,0,0];
    audio = new Audio(src);
    window.audio = audio;
    audioLoaded = false;
    audio.oncanplay = () => { audioLoaded = true; setPlayIcon(); };
    audio.onplay = () => {
      pauseCSV();
      startModeAutoSwitch();
      markPlaybackStarted();
      allowSpaceTesting = false;
      countdownActive = false;
    };
    audio.onpause = () => {
      pauseCSV();
      stopModeAutoSwitch();
    };
    audio.onended = () => { pauseCSV(); stopModeAutoSwitch(); setPlayIcon(); try{ showFeedbackSlider(); }catch(e){} };
    energyFrame = 0;
    setPlayIcon();
  };

  loadAudioSource(DEFAULT_AUDIO_SRC);
  playFab.onclick = () => { togglePlay().catch(err => console.error('togglePlay failed', err)); };

  // Hover behaviors for color panel only
  colorToolbar.addEventListener('mouseenter', ()=>{ colorToolbar.classList.add('expanded'); window._hueHovered = true; });
  colorToolbar.addEventListener('mouseleave', ()=>{ colorToolbar.classList.remove('expanded'); window._hueHovered = false; });

  // Hue controls
  const hueSlider = document.getElementById('hue-slider');
  const hueRandBtn = document.getElementById('hue-rand-btn');
  hueSlider.value = colorHueOffset;
  hueSlider.oninput = (e)=>{ colorHueOffset = parseInt(e.target.value); };
  hueRandBtn.onclick = ()=>{ colorHueOffset = (colorHueOffset + Math.floor(Math.random()*90+10)) % 360; hueSlider.value = colorHueOffset; };

  // Feedback slider overlay (1-15) and thanks screen
  function showFeedbackSlider(){
    // Prevent duplicate overlays - remove any existing feedback overlay first
    const existingFeedback = document.getElementById('feedback-overlay');
    if (existingFeedback && existingFeedback.parentNode) {
      existingFeedback.parentNode.removeChild(existingFeedback);
    }

    updatePlaybackStats();
    const evaluationAtFeedback = evaluateSessionStats();
    if (pendingFinalizeAction !== 'cancel') {
      pendingFinalizeAction = evaluationAtFeedback.meetsAll ? 'complete' : 'cancel';
    }
    const overlay = document.createElement('div');
    overlay.id = 'feedback-overlay';
    overlay.innerHTML = `
      <div class="welcome-content">
        <h1 class="welcome-title">Feedback</h1>
        <p class="welcome-text">How many times do you think the mode switched?</p>
        <input type="range" min="1" max="50" step="1" value="25" id="fb-count" class="nicer-range" />
        <div id="fb-count-wrap" style="margin-top:10px;font-size:24px;font-weight:700;letter-spacing:1px"><span id="fb-count-val"></span></div>
        <div style="margin-top:18px"></div>
        <p class="welcome-text">How difficult was it?</p>
        <input type="range" min="1" max="5" step="1" value="3" id="fb-diff" class="nicer-range" />
        <div id="fb-diff-wrap" style="margin-top:10px;font-size:20px;font-weight:700;letter-spacing:1px">Difficulty: <span id="fb-diff-val"></span></div>
        <div style="margin-top:16px;display:flex;justify-content:center">
          <button class="welcome-button" id="fb-submit">Submit</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const slider = overlay.querySelector('#fb-count');
    const out = overlay.querySelector('#fb-count-val');
    const outWrap = overlay.querySelector('#fb-count-wrap');
    const diffSlider = overlay.querySelector('#fb-diff');
    const diffOut = overlay.querySelector('#fb-diff-val');
    const diffWrap = overlay.querySelector('#fb-diff-wrap');
    const btn = overlay.querySelector('#fb-submit');
    // Show values only when the user interacts
    out.textContent = slider.value;
    diffOut.textContent = diffSlider.value;
    slider.oninput = ()=>{ out.textContent = slider.value; };
    diffSlider.oninput = ()=>{ diffOut.textContent = diffSlider.value; };
    btn.onclick = async ()=>{
      if (!sessionId) {
        alert('Session is not ready. Please wait a moment and try again.');
        return;
      }
      // Prevent duplicate submissions - disable button immediately
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Submitting...';
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';

      const payload = {
        participantId: (typeof participantId === 'string') ? participantId : null,
        sessionId: sessionId,
        timesGuessed: parseInt(slider.value,10),
        difficultyRating: parseInt(diffSlider.value,10)
      };
      try {
        const success = await postWithRetry('/api/feedback', payload, FEEDBACK_QUEUE_KEY);
        if (!success) {
          console.warn('Feedback queued for retry');
        }
      } catch (e) {
        console.error('Failed to submit feedback:', e);
      }
      const action = pendingFinalizeAction;
      await finalizeSession(action);
      pendingFinalizeAction = 'complete';
      overlay.classList.add('hidden');
      setTimeout(()=>{ if (overlay.parentNode) overlay.parentNode.removeChild(overlay); showThanks(); }, 300);
    };
    
  }

  function showThanks(){
    // Prevent duplicate overlays - remove any existing thanks overlay first
    const existingThanks = document.getElementById('thanks-overlay');
    if (existingThanks && existingThanks.parentNode) {
      existingThanks.parentNode.removeChild(existingThanks);
    }

    const overlay = document.createElement('div');
    overlay.id = 'thanks-overlay';
    const released = lastFinalizeResult && lastFinalizeResult.status === 'released';
    const message = released
      ? 'This session did not meet the analysis criteria and was not recorded.'
      : 'Your feedback has been saved.';
    overlay.innerHTML = `
      <div class="welcome-content">
        <h1 class="welcome-title">Thank you for participating!</h1>
        <p class="welcome-text">${message}</p>
      </div>`;
    document.body.appendChild(overlay);
  }

  function showQualtricsRedirect(message) {
    ['welcome-overlay','thanks-overlay','qualtrics-redirect-overlay'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });

    const overlay = document.createElement('div');
    overlay.id = 'qualtrics-redirect-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = '#000';
    overlay.style.zIndex = '10000';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    overlay.style.color = '#fff';
    overlay.style.textAlign = 'center';
    overlay.style.padding = '20px';
    overlay.style.boxSizing = 'border-box';
  overlay.innerHTML = `
      <div class="welcome-content">
        <h1 class="welcome-title">Almost there</h1>
        <p class="welcome-text">${message}</p>
        <p class="welcome-text">
          <a href="${QUALTRICS_SURVEY_URL}" target="_blank" rel="noopener" style="color:#4ecdc4;text-decoration:underline;">Go to the Qualtrics survey</a>
        </p>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  let logCount = 0;
  function triggerSpaceTestGlow() {
    // Trigger canvas-based spacebar effect for testing phases
    // This exactly replicates the experiment phase effect for 100% consistency
    testMarkerPulse = { start: performance.now(), duration: 900 };
  }

  function logAndTriggerPulse() {
    // CRITICAL: Always trigger visual pulse for user feedback
    // This provides immediate visual response regardless of logging phase
    markerPulse = { start: millis(), duration: 900 };

    // During testing phases (welcome, countdown, mode-compare),
    // show pulse but skip logging to avoid recording non-experimental data
    // allowSpaceTesting=true: pre-playback testing allowed
    // countdownActive=true: countdown is running (3-2-1 before playback)
    if (allowSpaceTesting || countdownActive) {
      triggerSpaceTestGlow();
      return;  // Exit early - no logging during non-experimental phases
    }

    // If the session is not ready or audio isn't playing, skip logging silently
    // This prevents errors and ensures data integrity
    if (!participantId || !sessionId || !window.audio || window.audio.paused) {
      return;
    }

    updatePlaybackStats();
    const audioTimeNow = window.audio.currentTime;
    const lastSwitch = (typeof lastSwitchTime === 'number' && isFinite(lastSwitchTime)) ? lastSwitchTime : null;
    const dt = lastSwitch !== null ? audioTimeNow - lastSwitch : null;
    recordKeypressMetrics(dt);

    const logData = {
      participantId: participantId,
      sessionId: sessionId,
      audioTime: audioTimeNow,
      currentMode: mappingMode,
      lastSwitchTime: lastSwitchTime
    };

    postWithRetry('/api/log', logData, LOG_QUEUE_KEY)
      .then(success => {
        if (!success) {
          console.warn('Log queued for retry');
          return;
        }
        console.log('Log saved:', logData);
        logCount++;
        try{
          if (typeof dt === 'number' && isFinite(dt)) {
            const isHit = dt >= 0 && dt <= hitWindowSec;
            const isGood = dt >= 0 && dt <= goodWindowSec;
            if (isGood) {
              goodStreak++;
            } else {
              goodStreak = 0;
            }
            recentHits.push(isHit);
            if (recentHits.length > RECENT_N) recentHits.shift();
            recomputeDifficulty();
          }
        }catch(e){}
      })
      .catch(error => {
        console.error('Error sending log:', error);
      });
  }

  window.addEventListener('beforeunload', (event) => {
    if (!sessionId || !participantId) return;
    const hasStarted = !!window.__thesisHasStartedPlayback;
    if (!hasStarted) return;
    const stats = evaluateSessionStats();
    const shouldCancel = true;
    const payload = {
      action: shouldCancel ? 'cancel' : 'complete',
      sessionId,
      sentCount: transmitStats.sentCount,
      droppedCount: 0,
      hadCountdown: !!featureUsage.hadCountdown,
      stats: {
        playbackSeconds: Number(sessionStats.playbackSeconds.toFixed(2)),
        keypressCount: sessionStats.keypressCount,
        hitCount: sessionStats.hitCount,
        negativeHitCount: sessionStats.negativeHitCount
      }
    };
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon('/api/finish-session', blob);
    } catch (err) {
      try {
        navigator.sendBeacon && navigator.sendBeacon('/api/finish-session', JSON.stringify(payload));
      } catch (_) {}
    }
  });

  // Hold-to-show (Backquote) + shortcuts
  let backquoteHeld = false;
  function showHiddenPanels(){ controlPanel.style.display = 'block'; mappingPanel.style.display = 'block'; }
  function hideHiddenPanels(){ controlPanel.style.display = 'none'; mappingPanel.style.display = 'none'; }

  window.addEventListener('keydown', (e)=>{
    const isBackquote = (e.code === 'Backquote')
      || ['`','~','·','～','｀','ˋ','‵','§','±','Dead'].includes(e.key)
      || e.keyCode === 192 || e.which === 192;
    if (isBackquote && !backquoteHeld) { backquoteHeld = true; showHiddenPanels(); }
    if (e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if (!modeFirm && (e.key==='a' || e.key==='A')){ setMapping('A'); }
    if (!modeFirm && (e.key==='b' || e.key==='B')){ setMapping('B'); }
    if (e.key==='h' || e.key==='H'){ hueRandBtn.click(); }
    if (e.key===']'){ const os = document.getElementById('offset-slider'); const ov = document.getElementById('offset-value'); if (os && ov){ offsetMs = Math.min(2000, offsetMs+50); os.value = offsetMs; ov.textContent = offsetMs; } }
    if (e.key==='['){ const os = document.getElementById('offset-slider'); const ov = document.getElementById('offset-value'); if (os && ov){ offsetMs = Math.max(-2000, offsetMs-50); os.value = offsetMs; ov.textContent = offsetMs; } }
    // Enter toggles play/pause
    if (e.code==='Enter' || e.key==='Enter'){ e.preventDefault(); togglePlay().catch(err => console.error('togglePlay failed', err)); }
    // Space triggers marker pulse and logs data
    if (e.code==='Space' || e.key===' '){
      e.preventDefault();
      const now = Date.now();
      if (spaceHoldActive) return;

      // Tutorial mode: check hit
      if (tutorialActive) {
        spaceHoldActive = true;
        checkTutorialHit();
        return;
      }

      const bypassCooldown = allowSpaceTesting || countdownActive;
      if (!bypassCooldown && lastSpaceReleaseTime && (now - lastSpaceReleaseTime) < SPACE_COOLDOWN_MS) return;
      spaceHoldActive = true;
      logAndTriggerPulse();
    }
    if (e.key==='u' || e.key==='U'){
      const anyVisible = colorToolbar.style.display !== 'none' || playFab.style.display !== 'none';
      const disp = anyVisible ? 'none' : '';
      colorToolbar.style.display = disp;
      playFab.style.display = disp;
      if (disp === 'none') { hideHiddenPanels(); }
    }
  });
  window.addEventListener('keyup', (e)=>{
    const isBackquote = (e.code === 'Backquote')
      || ['`','~','·','～','｀','ˋ','‵','§','±','Dead'].includes(e.key)
      || e.keyCode === 192 || e.which === 192;
    if (isBackquote) { backquoteHeld = false; hideHiddenPanels(); }
    if (e.code === 'Space' || e.key === ' '){
      spaceHoldActive = false;
      lastSpaceReleaseTime = Date.now();
    }
  });

  function applyInitialSlotMapping() {
    try {
      if (typeof window._slotMap === 'undefined') window._slotMap = [0,1,2,3,4];
      const base = [0,1,2,3,4];
      const method = (Math.random() < 0.8) ? 'rotate' : 'mirror';
      const rot = (arr,k)=> arr.map((_,i)=> arr[(i - k + arr.length)%arr.length]);
      if (method === 'rotate') {
        const step = Math.random() < 0.5 ? 1 : 2;
        window._slotMap = rot(base, step);
        window._currentMappingLabel = `r${step}`;
      } else {
        if (Math.random() < 0.5) {
          window._slotMap = [ base[1], base[0], base[2], base[4], base[3] ];
          window._currentMappingLabel = 'mh';
        } else {
          window._slotMap = [ base[3], base[4], base[2], base[0], base[1] ];
          window._currentMappingLabel = 'mv';
        }
      }
      window._lastSpatialSwitchT = 0;
      window._previewLights = true;
    } catch (err) {
      console.warn('init spatial mapping failed', err);
    }
  }

  async function startNewSession(pId, options = {}) {
    try {
      const payloadBody = { participantId: pId };
      if (options.emailHash) payloadBody.emailHash = options.emailHash;
      if (options.email) payloadBody.email = options.email;
      const res = await fetch('/api/start-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadBody)
      });

      let payload = {};
      try {
        payload = await res.json();
      } catch (_) {
        payload = {};
      }

      if (!res.ok || !payload?.sessionId) {
        const msg = payload?.error || `Failed to start session (status ${res.status})`;
        throw Object.assign(new Error(msg), { code: 'session-failed' });
      }

      sessionId = String(payload.sessionId);
      console.log(`Session started successfully. Session ID: ${sessionId}`);
      sessionFinalized = false;
      transmitStats.sentCount = 0;
      transmitStats.queuedCount = 0;
      featureUsage.hadCountdown = featureConfig.enableCountdown;
      logCount = 0;
      pendingFinalizeAction = 'complete';
      resetSessionStats();
      lastFinalizeResult = null;
      return { note: payload.note || null };
    } catch (error) {
      console.error('Error starting new session:', error);
      throw error;
    }
  }

  async function ensureSessionStarted() {
    if (sessionId) return true;
    if (sessionStartPromise) return sessionStartPromise;
    if (!participantId) {
      alert('Participant information missing. Please reload the page through the Qualtrics link.');
      return false;
    }
    const opts = sessionStartOptions ? { ...sessionStartOptions } : {};
    sessionStartPromise = startNewSession(participantId, opts)
      .then(() => {
        sessionStartPromise = null;
        return true;
      })
      .catch((error) => {
        sessionStartPromise = null;
        console.error('Deferred session start failed:', error);
        const message = String(error?.message || '');
        if (/participant already has an active session/i.test(message)) {
          sessionStartOptions = null;
          showQualtricsRedirect('Records show this email has already tested. Please return to Qualtrics and use a new survey link.');
        } else {
          sessionStartOptions = null;
          alert('Failed to start the session. Please try again.');
        }
        return false;
      });
    return sessionStartPromise;
  }

  async function finalizeSession(action = 'complete') {
    if (!sessionId || sessionFinalized) {
      return;
    }
    sessionFinalized = true;
    try {
      await flushAllQueues();
    } catch (err) {
      console.warn('Queue flush failed before finalize', err);
    }

    const remainingLogs = safeLoadQueue(LOG_QUEUE_KEY).length;
    const remainingSwitch = safeLoadQueue(SWITCH_QUEUE_KEY).length;
    const remainingFeedback = safeLoadQueue(FEEDBACK_QUEUE_KEY).length;
    const droppedCount = remainingLogs + remainingSwitch + remainingFeedback;

    updatePlaybackStats();
    const statsSnapshot = {
      playbackSeconds: Number(sessionStats.playbackSeconds.toFixed(2)),
      keypressCount: sessionStats.keypressCount,
      hitCount: sessionStats.hitCount,
      negativeHitCount: sessionStats.negativeHitCount
    };

    const payload = {
      action,
      sessionId,
      sentCount: transmitStats.sentCount,
      droppedCount,
      hadCountdown: !!featureUsage.hadCountdown,
      stats: statsSnapshot
    };

    const finalizeRequest = async (attempt = 1) => {
      try {
        const res = await fetch('/api/finish-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          if (attempt >= RETRY_MAX_ATTEMPTS) {
            const text = await res.text();
            throw new Error(`finish-session failed: ${res.status} ${text}`);
          }
          await delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
          return finalizeRequest(attempt + 1);
        }
        return res.json();
      } catch (error) {
        if (attempt >= RETRY_MAX_ATTEMPTS) throw error;
        await delay(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        return finalizeRequest(attempt + 1);
      }
    };

    try {
      const result = await finalizeRequest();
      lastFinalizeResult = result;
      if (result && result.status === 'released') {
        alert('Session did not meet the analysis criteria. This attempt was not recorded.');
      }
      sessionId = null;
      participantId = null;
      sessionStartOptions = null;
      sessionStartPromise = null;
      resetSessionStats();
      sessionFinalized = false;
    } catch (error) {
      console.error('Failed to finalize session', error);
      sessionFinalized = false;
      sessionStartPromise = null;
    }
  }
  function setupWelcomeScreen() {
    const isAuto = QUALTRICS_PARAMS && QUALTRICS_PARAMS.hasParams;
    console.log('[Qualtrics] setupWelcomeScreen mode ->', isAuto ? 'auto' : 'manual');

    if (!isAuto || !QUALTRICS_PARAMS.userID) {
      showQualtricsRedirect('This experiment is accessible only after completing the Qualtrics intake survey.');
      return;
    }

    participantId = QUALTRICS_PARAMS.userID;

    const overlay = document.createElement('div');
    overlay.id = 'welcome-overlay';
    overlay.innerHTML = `
      <div class="welcome-content">
        <h1 class="welcome-title">Welcome</h1>
        <p class="welcome-text"><strong>Your Task:</strong> Press <strong style="color:#4ecdc4;">SPACEBAR</strong> whenever you notice the visual pattern change</p>
        <p class="welcome-text"><strong>Duration:</strong> ~3 minutes</p>
        <p class="welcome-text"><strong>Equipment:</strong> Headphones recommended</p>
        <button class="welcome-button">Enter</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const button = overlay.querySelector('.welcome-button');
    if (!button) return;

    const handleProceed = async () => {
        if (button.disabled) return;
        button.disabled = true;
        button.classList.add('disabled');
        console.log('[Qualtrics] Proceed pressed for userID:', participantId);
        try {
          if (!sessionStartOptions) {
            sessionStartOptions = {};
            const email = QUALTRICS_PARAMS.email;
            if (email) {
              const trimmed = email.trim();
              if (trimmed.length) {
                sessionStartOptions.email = trimmed;
              }
              try {
                sessionStartOptions.emailHash = await hashEmail(trimmed);
              } catch (err) {
                console.warn('Failed to hash email for session start', err);
                delete sessionStartOptions.emailHash;
              }
            }
          }
          applyInitialSlotMapping();
          overlay.classList.add('hidden');
          setTimeout(() => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            showModeCompareOverlay(showGuidedBubbles);
          }, 400);
        } catch (error) {
          console.error('[Qualtrics] Welcome proceed failed', error);
          sessionStartOptions = null;
          overlay.classList.add('hidden');
          setTimeout(() => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            showQualtricsRedirect('Unable to initialize the experience. Please refresh the page and try again.');
          }, 400);
        }
      };
    button.addEventListener('click', handleProceed);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        console.log('[Qualtrics] Enter key captured on welcome overlay');
        handleProceed();
      }
    });
    // focus button for immediate Enter capture
    setTimeout(() => { button.focus(); }, 50);
  }

  window._qualtricsParams = QUALTRICS_PARAMS;
  console.log('[Qualtrics] window._qualtricsParams set to:', window._qualtricsParams);
  setupWelcomeScreen();

}); // end DOMContentLoaded
