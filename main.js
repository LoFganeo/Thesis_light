// === Mapping Mode Switch ===
let mappingMode = 'A'; // 'A' = instant response, 'B' = accumulated slow fade
let bandAccum = [0,0,0,0,0];
const decayRate = 0.92; // energy decay factor in mode B
// Mapping and sensitivity tuning
const DEFAULT_BAND_ORIGINS = [0,1,2,3,4];
const MAPPING_A_BASE_LEVEL = 0.08;
const MAPPING_A_PEAK_SCALE = 0.72;
const MAPPING_A_CLIP_PIVOT = 1.2;
const MAPPING_A_CLIP_RATIO = 0.55;
const HIGH_FREQ_SENSITIVITY = 0.58;
const LOW_END_SENSITIVITY = 0.55;
// === Global energy–audio sync offset ===
let offsetMs = 0;
let participantId = null; // set by seat selector
let sessionId = null; // set by start-session API
let lastSwitchTime = 0;   // updated on mode switch

// Marker pulse overlay (Space key visual feedback)
let markerPulse = null; // { start: millis(), duration: 900 }


let auroraColors = [];
let colorsInitialized = false;
let globalEnergy = 0, focusEnergy = 0, focusX = 0, focusY = 0;
let colorHueOffset = 0;
// Added: UI and overlay controls
let showRing = true;
let showUI = true;

const VALIDATION_THRESHOLDS = {
  minPlaybackSeconds: 30,
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
  if (energyLoaded && energyData.length > 0) {
    let frameIdx = 0;
    if (window.audio && !window.audio.paused && !isNaN(window.audio.currentTime)) {
      frameIdx = Math.floor((window.audio.currentTime * csvFps) - (offsetMs / 1000 * csvFps));
      frameIdx = Math.max(0, Math.min(energyData.length - 1, frameIdx));
    } else {
      frameIdx = energyFrame % energyData.length;
    }
    let row = energyData[frameIdx];
    if (mappingMode === 'A') {
      for (let i = 0; i < 5; i++) {
        const raw = (typeof row[i] === 'number' && isFinite(row[i])) ? Math.max(row[i], 0) : MAPPING_A_BASE_LEVEL;
        const baseVal = MAPPING_A_BASE_LEVEL;
        const delta = Math.max(raw - baseVal, 0);
        let scaled = baseVal + delta * MAPPING_A_PEAK_SCALE;
        if (scaled > MAPPING_A_CLIP_PIVOT) {
          scaled = MAPPING_A_CLIP_PIVOT + (scaled - MAPPING_A_CLIP_PIVOT) * MAPPING_A_CLIP_RATIO;
        }
        bands[i] = scaled;
      }
    } else if (mappingMode === 'B') {
      // hi1/kick bands (0 and 4) have stronger damping + delay + higher threshold; other bands normal
      const minBase = [0.16, 0.11, 0.11, 0.11, 0.16];
      const boostRateArr = [0.04, 0.08, 0.08, 0.08, 0.04];
      const decayArr = [0.97, 0.94, 0.93, 0.94, 0.97];
      const gammaArr = [0.82, 0.78, 0.78, 0.78, 0.82];
      // Response delay: use 3-frame smoothing on all bands
      if (!window.bandDelay) window.bandDelay = [[],[],[],[],[]];
      for(let i=0;i<5;i++) {
        let target = row[i] || minBase[i];
        window.bandDelay[i].push(target);
        if (window.bandDelay[i].length>3) window.bandDelay[i].shift();
        target = window.bandDelay[i].reduce((a,b)=>a+b,0)/window.bandDelay[i].length;
        let extraBoost = (target - bandAccum[i]) * boostRateArr[i];
        bandAccum[i] = bandAccum[i]*decayArr[i] + target*(1-decayArr[i]) + extraBoost;
        bands[i] = Math.max(Math.pow(bandAccum[i], gammaArr[i]), minBase[i]);
      }
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
  let grid = 8;
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
    let baseSigma = Math.min(width, height)*0.28;
    window._bandSigmaArr = [baseSigma, baseSigma, baseSigma, baseSigma, baseSigma];
  }
  let baseSigma = Math.min(width, height)*0.28;
  let bandCenters = [];
  let bandSigmaArr = [];
  let t = millis()/1000;
  for (let i=0; i<5; i++) {
    // Dynamic perturbation + energy bias
    let cx0 = [width*0.25, width*0.75, width*0.5, width*0.25, width*0.75][i];
    let cy0 = [height*0.22, height*0.22, height*0.5, height*0.78, height*0.78][i];
    let dx = Math.sin(t*0.13 + i*1.2)*width*0.018 + Math.cos(t*0.19 + i*0.7)*width*0.012;
    let dy = Math.cos(t*0.11 + i*1.7)*height*0.016 + Math.sin(t*0.17 + i*0.9)*height*0.011;
    // Energy bias (under high energy shift slightly toward center)
    let bandE = bands ? bands[i] : 0.1;
    let centerBiasX = (width/2 - cx0) * bandE * 0.13;
    let centerBiasY = (height/2 - cy0) * bandE * 0.13;
    let cx = cx0 + dx + centerBiasX;
    let cy = cy0 + dy + centerBiasY;
    // Smooth transition
    let prev = window._bandCenters[i];
    let smooth = 0.82;
    let newCx = prev[0]*smooth + cx*(1-smooth);
    let newCy = prev[1]*smooth + cy*(1-smooth);
    bandCenters.push([newCx, newCy]);
    window._bandCenters[i] = [newCx, newCy];
    // Sigma dynamics: base + energy + perturbation + per-band variation
    let sigmaBase = baseSigma * (0.98 + 0.07*Math.sin(t*0.21+i*0.8));
    let sigmaEnergy = 1.0 + bandE*0.22;
    let sigma = sigmaBase * sigmaEnergy * (0.97 + 0.06*Math.cos(t*0.17+i*1.3));
    // hi1/kick slightly narrower
    if (i===0||i===4) sigma *= 0.93;
    // Smoothing
    let prevSigma = window._bandSigmaArr[i];
    let sigmaSmooth = 0.82;
    let newSigma = prevSigma*sigmaSmooth + sigma*(1-sigmaSmooth);
    bandSigmaArr.push(newSigma);
    window._bandSigmaArr[i] = newSigma;
  }
  // CPU path (keep CPU rendering only)
  for (let x=0; x<width; x+=grid) {
    for (let y=0; y<height; y+=grid) {
      let weights = [];
      let totalWeight = 0;
      for (let i=0; i<5; i++) {
        let dx = x-bandCenters[i][0];
        let dy = y-bandCenters[i][1];
        let sigma = bandSigmaArr[i];
        let w = Math.exp(-(dx*dx+dy*dy)/(2*sigma*sigma));
        weights.push(w);
        totalWeight += w;
      }
      for (let i=0; i<5; i++) weights[i] /= totalWeight;
      let idxs = [0,1,2,3,4];
      idxs.sort((a,b)=>weights[b]-weights[a]);
      let maxIdx = idxs[0], secondIdx = idxs[1];
      for (let i=0; i<5; i++) {
        if (i === maxIdx) { weights[i] *= 1.12; } else { weights[i] *= 0.38; }
      }
      let sumW = weights.reduce((a,b)=>a+b,0);
      for (let i=0; i<5; i++) weights[i] = Math.pow(weights[i]/sumW, 1.18);
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
    const dur = markerPulse.duration || 450; // keep faster pulse
    if (elapsed >= dur) {
      markerPulse = null;
    } else {
      const t = elapsed / dur; // 0..1
      const ease = Math.sin(t * Math.PI); // in-out
      // thickness anim (half of current), two-layer glow
      const thick = 1.5 + ease * 4.5; // was 3 + ease * 9
      const thickOuter = thick * 1.8;
      const alphaBase = 40 + ease * 180;
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
  .glass-panel{background:rgba(30,32,40,0.92);backdrop-filter:saturate(1.1) blur(8px);-webkit-backdrop-filter:saturate(1.1) blur(8px);border-radius:14px;box-shadow:0 6px 24px #000a;border:1px solid rgba(255,255,255,0.08)}
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
  #play-fab{position:fixed;top:24px;right:24px;width:48px;height:48px;border-radius:50%;border:none;cursor:pointer;z-index:2300;display:flex;align-items:center;justify-content:center;font-size:20px;color:#fff;background:rgba(30,32,40,0.92);box-shadow:0 6px 24px #000a;border:1px solid rgba(255,255,255,0.08)}
  #play-fab:hover{background:rgba(255,255,255,0.12)}

  /* New panels */
  #sample-panel{position:fixed;top:16px;left:24px;z-index:2250;padding:10px 14px;background:rgba(30,32,40,0.98);border:1px solid rgba(255,255,255,0.35);box-shadow:0 8px 28px #000c;display:none}
  #sample-panel label{color:#fff;opacity:.9;font-weight:600;letter-spacing:1px;margin-right:8px}
  #sample-panel select{color:#fff;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:10px;padding:6px 10px;outline:none}
  #mode-panel{position:fixed;top:86px;left:24px;z-index:2250;padding:10px 14px;display:none;background:rgba(30,32,40,0.98);border:1px solid rgba(255,255,255,0.35);box-shadow:0 8px 28px #000c}
  #offset-panel{position:fixed;top:168px;left:24px;z-index:2250;padding:10px 14px;display:none;background:rgba(30,32,40,0.98);border:1px solid rgba(255,255,255,0.35);box-shadow:0 8px 28px #000c}
  
  /* Seat Selection Overlay */
  #seat-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(10,12,18,0.98);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding-top:15vh;color:#fff;font-family:sans-serif;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}
  #seat-overlay h1{font-weight:300;letter-spacing:2px;margin-bottom:10px;}
  #seat-overlay p{opacity:0.8;margin-top:0;margin-bottom:40px;}
  #seat-grid{display:grid;grid-template-columns:repeat(10, 1fr);gap:12px;max-width:600px;}
  .seat-box{width:40px;height:40px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:600;cursor:pointer;transition:all .18s ease;}
  .seat-box.available:hover{background:#4ecdc4;color:#111;transform:scale(1.1);}
  .seat-box.used{background:#e55073;color:rgba(255,255,255,0.5);cursor:not-allowed;opacity:0.5;}

  /* Welcome Screen */
  #welcome-overlay, #song-overlay, #feedback-overlay, #thanks-overlay {
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
  #welcome-overlay.hidden, #song-overlay.hidden, #feedback-overlay.hidden, #thanks-overlay.hidden {
    opacity: 0;
    pointer-events: none;
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
      0 0 7px #fff,
      0 0 10px #fff,
      0 0 21px #fff,
      0 0 42px #4ecdc4,
      0 0 82px #4ecdc4,
      0 0 92px #4ecdc4,
      0 0 102px #4ecdc4,
      0 0 151px #4ecdc4;
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
    background: rgba(0, 0, 0, 0.9);
    z-index: 9998;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #fff;
    font-size: 18vw;
    font-weight: 200;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }
  #countdown-overlay.visible {
    opacity: 1;
  }
  #countdown-number {
    transform: scale(0.5);
    opacity: 0;
    transition: transform 0.45s cubic-bezier(0.2, 1, 0.3, 1), opacity 0.45s ease;
  }
  #countdown-number.show {
    transform: scale(1);
    opacity: 1;
  }

  /* Feedback slider styling */
  .nicer-range { -webkit-appearance:none; appearance:none; width:80%; height:6px; background: linear-gradient(90deg,#4ecdc4,#8df1ea); border-radius: 4px; outline:none; }
  .nicer-range::-webkit-slider-thumb { -webkit-appearance:none; width:22px; height:22px; background:#fff; border:3px solid #4ecdc4; border-radius:50%; box-shadow:0 2px 8px rgba(0,0,0,0.4); cursor:pointer; }
  .nicer-range::-moz-range-thumb { width:22px; height:22px; background:#fff; border:3px solid #4ecdc4; border-radius:50%; box-shadow:0 2px 8px rgba(0,0,0,0.4); cursor:pointer; }
  `;
  document.head.appendChild(style);

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

  // New: Sample panel (top-left)
  const samplePanel = document.createElement('div');
  samplePanel.id = 'sample-panel';
  samplePanel.className = 'glass-panel';
  samplePanel.innerHTML = `<div class="row" id="sample-row"></div>`;
  document.body.appendChild(samplePanel);

  // New: Mode and Offset panels (left side, show only while holding Backquote)
  const modePanel = document.createElement('div');
  modePanel.id = 'mode-panel';
  modePanel.className = 'glass-panel';
  modePanel.innerHTML = `
    <div class="row">
      <span class="panel-label">Mode</span>
      <button id="mapping-a-btn" class="btn" title="Switch to A (A)">A</button>
      <button id="mapping-b-btn" class="btn" title="Switch to B (B)">B</button>
    </div>
  `;
  document.body.appendChild(modePanel);

  const offsetPanel = document.createElement('div');
  offsetPanel.id = 'offset-panel';
  offsetPanel.className = 'glass-panel';
  offsetPanel.innerHTML = `
    <div class="row">
      <span class="panel-label">Offset</span>
      <input type="range" id="offset-slider" min="-2000" max="2000" step="1" style="width:260px;">
      <span id="offset-value" class="badge">0</span>
      <button id="offset-m50" class="btn mini-btn" title="-50ms ([)">-50</button>
      <button id="offset-p50" class="btn mini-btn" title="+50ms (])">+50</button>
    </div>
  `;
  document.body.appendChild(offsetPanel);
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
    if (mode === 'A') {
      mappingMode = 'A';
    } else {
      mappingMode = 'B';
      if (energyLoaded && energyData.length > 0) {
        let frameIdx = 0;
        if (window.audio && !window.audio.paused && !isNaN(window.audio.currentTime)) {
          frameIdx = Math.floor((window.audio.currentTime * csvFps) - (offsetMs / 1000 * csvFps));
          frameIdx = Math.max(0, Math.min(energyData.length - 1, frameIdx));
        } else {
          frameIdx = energyFrame % energyData.length;
        }
        let row = energyData[frameIdx];
        for(let i=0;i<5;i++) bandAccum[i] = row[i] || 0.09;
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
  function updateMappingUI() {
    mappingABtn.classList.toggle('active', mappingMode==='A');
    mappingBBtn.classList.toggle('active', mappingMode==='B');
  }
  mappingABtn.onclick = () => { setMapping('A'); };
  mappingBBtn.onclick = () => { setMapping('B'); };
  updateMappingUI();

  // Move Sample label+select into Sample panel
  const sampleSelect = document.getElementById('sample-select');
  const sampleLabel = document.querySelector('label[for="sample-select"]');
  const sampleRow = document.getElementById('sample-row');
  if (sampleRow) {
    if (sampleLabel) sampleRow.appendChild(sampleLabel);
    if (sampleSelect) sampleRow.appendChild(sampleSelect);
  }
  // Ensure a default option exists for playback
  if (sampleSelect && !sampleSelect.options.length) {
    sampleSelect.innerHTML = '<option value="stems/stem-full.mp3">Sample 1</option>';
  }

  // Audio wiring
  let audioLoaded = false;
  let audio;
  window.audio = null;
  // Auto A/B switch scheduler (runs only while playing)
  let modeSwitchTimer = null;
  // --- Adaptive auto-switch config/state ---
  // Base intervals (ms)
  let DIFF_MIN_MS_NORMAL = 3000, DIFF_MAX_MS_NORMAL = 9000;   // normal: 3–9s
  let DIFF_MIN_MS_HARD   = 2600, DIFF_MAX_MS_HARD   = 6000;   // hard:   2.6–6s
  // Soft-start window
  const SOFT_START_SEC = 30;                                   // first 30s
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
    modeSwitchTimer = setTimeout(()=>{
      modeSwitchTimer = null;
      try{
        if (audio && !audio.paused) {
          // Always toggle to ensure a real switch (avoid logging no-op)
          const next = (mappingMode === 'A') ? 'B' : 'A';
          setMapping(next);
        }
      } finally {
        if (audio && !audio.paused) scheduleNextModeSwitch();
      }
    }, delay);
  }
  function startModeAutoSwitch(){
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
  function togglePlay(){
    if (!audioLoaded) return;

    // Hide both tour bubbles when play is clicked for the first time
    if (tourBubble.classList.contains('visible')) {
      tourBubble.classList.remove('visible');
    }
    if (hueBubble.classList.contains('visible')) {
      hueBubble.classList.remove('visible');
    }

    if (audio.paused){
      if (featureConfig.enableCountdown) {
        featureUsage.hadCountdown = true;
        const countdownNumber = document.getElementById('countdown-number');
        countdownOverlay.classList.add('visible');
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
            audio.play();
            window._previewLights = false;
            setPlayIcon();
          }
        }, 1000);
      } else {
        audio.play();
        window._previewLights = false;
        setPlayIcon();
      }
    } else {
      audio.pause();
      setPlayIcon();
      // If paused before end, confirm finish
      if (audio.currentTime > 0 && audio.currentTime < (isFinite(audio.duration)? audio.duration-0.2 : 1e9)) {
        confirmFinishDialog();
      }
    }
  }
  if (sampleSelect){
    sampleSelect.onchange = () => {
      if (audio){ audio.pause(); audio.currentTime = 0; audio.onended = null; }
      stopModeAutoSwitch();
      audio = new Audio(sampleSelect.value);
      window.audio = audio;
      audioLoaded = false;
      audio.oncanplay = () => { audioLoaded = true; setPlayIcon(); };
      audio.onplay = () => { pauseCSV(); startModeAutoSwitch(); };
      audio.onpause = () => {
        pauseCSV(); stopModeAutoSwitch();
        try{
          if (audio && isFinite(audio.duration) && audio.currentTime > 0 && audio.currentTime < audio.duration - 0.2) {
            if (!window._finishingDialogOpen) confirmFinishDialog();
          }
        }catch(e){}
      };
      audio.onended = () => { pauseCSV(); stopModeAutoSwitch(); setPlayIcon(); try{ showFeedbackSlider(); }catch(e){} };
      energyFrame = 0;
      setPlayIcon();
    };
    sampleSelect.onchange();
  }
  playFab.onclick = togglePlay;

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
        <input type="range" min="1" max="30" step="1" value="8" id="fb-count" class="nicer-range" />
        <div id="fb-count-wrap" style="display:none;margin-top:10px;font-size:24px;font-weight:700;letter-spacing:1px"><span id="fb-count-val"></span></div>
        <div style="margin-top:18px"></div>
        <p class="welcome-text">How difficult was it?</p>
        <input type="range" min="1" max="5" step="1" value="3" id="fb-diff" class="nicer-range" />
        <div id="fb-diff-wrap" style="display:none;margin-top:10px;font-size:20px;font-weight:700;letter-spacing:1px">Difficulty: <span id="fb-diff-val"></span></div>
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
    slider.oninput = ()=>{ out.textContent = slider.value; outWrap.style.display='block'; };
    diffSlider.oninput = ()=>{ diffOut.textContent = diffSlider.value; diffWrap.style.display='block'; };
    btn.onclick = async ()=>{
      if (!sessionId) {
        alert('Session is not ready. Please wait a moment and try again.');
        return;
      }
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
        <div style="margin-top:18px;display:flex;gap:10px;align-items:center;justify-content:center;font-size:14px;opacity:.9">
          <span>Do you want to start again?</span>
          <button class="btn" id="thanks-restart">Yes</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // Stay on Thank You screen; allow restart
    const restartBtn = overlay.querySelector('#thanks-restart');
    if (restartBtn){
      restartBtn.onclick = ()=>{
        try{ if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }catch(e){}
        lastFinalizeResult = null;
        setupSeatSelection();
      };
    }
  }

  // Finish confirmation when pausing mid-song
  function confirmFinishDialog(){
    const overlay = document.createElement('div');
    overlay.id = 'finish-overlay';
    window._finishingDialogOpen = true;
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(0,0,0,0.6)';
    overlay.style.zIndex = '12000';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.innerHTML = `
      <div class="welcome-content" style="
        background: rgba(30,32,40,0.92);
        backdrop-filter: saturate(1.1) blur(12px);
        -webkit-backdrop-filter: saturate(1.1) blur(12px);
        border: 1px solid rgba(78,205,196,0.30);
        border-radius: 14px;
        padding: 18px 22px;
        max-width: 520px;
        color: #fff;
        box-shadow: 0 10px 28px rgba(0,0,0,0.35), 0 0 22px rgba(78,205,196,0.18);
      ">
        <h2 style="margin:0 0 8px 0; color:#eafaf8; text-shadow:0 0 8px rgba(78,205,196,0.35)">Do you wish to finish?</h2>
        <p style="margin:6px 0 0 0; opacity:.85">You can submit feedback now or continue listening.</p>
        <div style="display:flex; gap:12px; justify-content:center; margin-top:12px">
          <button class="btn" id="fin-no">No</button>
          <button class="btn primary" id="fin-yes">Yes</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#fin-no').onclick = ()=>{ overlay.style.opacity='0'; setTimeout(()=>{ if (overlay.parentNode) overlay.parentNode.removeChild(overlay); window._finishingDialogOpen=false; }, 200); };
    overlay.querySelector('#fin-yes').onclick = async ()=>{
      updatePlaybackStats();
      const evaluation = evaluateSessionStats();
      let proceedToFeedback = true;

      if (!evaluation.meetsAll && sessionStats.playbackSeconds >= VALIDATION_THRESHOLDS.reminderPlaybackSeconds) {
        const message = 'Data has not yet met the analysis criteria. Continue for another 10–20 seconds to include this session in the study?';
        const continuePlayback = window.confirm(message);
        if (continuePlayback) {
          overlay.style.opacity='0';
          setTimeout(()=>{
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            window._finishingDialogOpen=false;
            try{
              if (audio && audio.paused) {
                audio.play();
                setPlayIcon();
              }
            }catch(e){}
          }, 200);
          proceedToFeedback = false;
        }
      }

      if (!proceedToFeedback) {
        return;
      }

      pendingFinalizeAction = evaluation.meetsAll ? 'complete' : 'cancel';
      try{ if (audio && !audio.paused) audio.pause(); }catch(e){}
      overlay.style.opacity='0';
      setTimeout(()=>{ if (overlay.parentNode) overlay.parentNode.removeChild(overlay); window._finishingDialogOpen=false; showFeedbackSlider(); }, 200);
    };
  }

  let logCount = 0;
  function logAndTriggerPulse() {
    // Trigger visual pulse immediately
    markerPulse = { start: millis(), duration: 450 };

    // If no seat is selected or audio is not playing, do not log
    if (!participantId || !sessionId || !window.audio || window.audio.paused) {
      console.warn('Log attempt failed: No participant ID, session ID, or audio not playing.');
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

  // Hold-to-show (Backquote) + shortcuts
  let backquoteHeld = false;
  function showHiddenPanels(){ samplePanel.style.display = 'block'; modePanel.style.display = 'block'; offsetPanel.style.display = 'block'; }
  function hideHiddenPanels(){ samplePanel.style.display = 'none'; modePanel.style.display = 'none'; offsetPanel.style.display = 'none'; }

  window.addEventListener('keydown', (e)=>{
    const isBackquote = (e.code === 'Backquote')
      || ['`','~','·','～','｀','ˋ','‵','§','±','Dead'].includes(e.key)
      || e.keyCode === 192 || e.which === 192;
    if (isBackquote && !backquoteHeld) { backquoteHeld = true; showHiddenPanels(); }
    if (e.target && ['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if (e.key==='a' || e.key==='A'){ setMapping('A'); }
    if (e.key==='b' || e.key==='B'){ setMapping('B'); }
    if (e.key==='h' || e.key==='H'){ hueRandBtn.click(); }
    if (e.key===']'){ const os = document.getElementById('offset-slider'); const ov = document.getElementById('offset-value'); if (os && ov){ offsetMs = Math.min(2000, offsetMs+50); os.value = offsetMs; ov.textContent = offsetMs; } }
    if (e.key==='['){ const os = document.getElementById('offset-slider'); const ov = document.getElementById('offset-value'); if (os && ov){ offsetMs = Math.max(-2000, offsetMs-50); os.value = offsetMs; ov.textContent = offsetMs; } }
    // Enter toggles play/pause
    if (e.code==='Enter' || e.key==='Enter'){ e.preventDefault(); togglePlay(); }
    // Space triggers marker pulse and logs data
    if (e.code==='Space' || e.key===' '){ e.preventDefault(); logAndTriggerPulse(); }
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
  });

  async function startNewSession(pId) {
    const songId = 'stem-full';

    try {
      const res = await fetch('/api/start-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId: pId, songId })
      });

      let payload = {};
      try {
        payload = await res.json();
      } catch (_) {
        payload = {};
      }

      if (res.status === 409) {
        const error = payload?.error || 'Seat already taken';
        throw Object.assign(new Error(error), { code: 'seat-taken' });
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
      resetSessionStats();
      sessionFinalized = false;
    } catch (error) {
      console.error('Failed to finalize session', error);
      sessionFinalized = false;
    }
  }

  function renderSeatGrid(overlay, usedSeats) {
    let gridHtml = '<h1>Select Your Seat</h1><p>Each seat corresponds to a unique participant ID.</p><div id="seat-grid">';
    for (let i = 1; i <= 40; i++) {
      const seatId = `S${i.toString().padStart(2, '0')}`;
      const isUsed = usedSeats.includes(seatId);
      gridHtml += `<div class="seat-box ${isUsed ? 'used' : 'available'}" data-seat-id="${seatId}">${seatId}</div>`;
    }
    gridHtml += '</div>';
    overlay.innerHTML = gridHtml;

    const availableSeats = overlay.querySelectorAll('.seat-box.available');
    availableSeats.forEach(seat => {
      seat.addEventListener('click', async () => {
        if (seat.dataset.state === 'busy') return;
        seat.dataset.state = 'busy';
        participantId = seat.getAttribute('data-seat-id');
        console.log(`Seat selected: ${participantId}`);

        try {
          await startNewSession(participantId);
        } catch (error) {
          participantId = null;
          seat.dataset.state = 'idle';
          alert('Failed to start session. Please try again.');
          console.warn('Failed to start session from compact selector:', error);
          return;
        }

        overlay.style.opacity = '0';
        setTimeout(() => {
          if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
          }
           // Show tour bubble
          const tourBubble = document.getElementById('tour-bubble');
          if (tourBubble) tourBubble.classList.add('visible');
        }, 300);
      });
    });
  }

  // Seat selection overlay (100 seats: seat-1 ... seat-100) with fetch + fallback
  function setupSeatSelection() {
    const overlay = document.createElement('div');
    overlay.id = 'seat-overlay';
    overlay.innerHTML = `
      <h1>Please select a seat</h1>
      <p>Select a white square to begin the experiment. Red squares are already taken.</p>
      <div id="seat-grid"></div>
    `;
    document.body.appendChild(overlay);
    const grid = document.getElementById('seat-grid');

    fetch('/api/get-used-seats')
      .then(res => {
        if (!res.ok) throw new Error(`API responded with ${res.status}`);
        return res.json();
      })
      .then((payload) => {
        const used = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.seats)
            ? payload.seats
            : [];
        const degraded = Array.isArray(payload) ? false : !!payload?.degraded;
        if (degraded) {
          const notice = document.createElement('p');
          notice.style.color = '#f5b942';
          notice.style.marginBottom = '18px';
          notice.textContent = 'Seat locking is running in offline mode. Seats may collide.';
          overlay.insertBefore(notice, grid);
        }
        for (let i = 1; i <= 100; i++) {
          const seatId = `seat-${i}`;
          const seat = document.createElement('div');
          seat.className = 'seat-box';
          seat.textContent = i;
          seat.dataset.id = seatId;
          if (used.includes(seatId)) {
            seat.classList.add('used');
          } else {
          seat.classList.add('available');
          seat.onclick = async () => {
            if (seat.dataset.state === 'busy' || seat.classList.contains('used')) return;
            seat.dataset.state = 'busy';
            participantId = seatId;
            seat.classList.add('pending');
            try {
              await startNewSession(participantId);
              console.log(`Seat selected: ${participantId}`);

              // Randomize initial spatial mapping for this session (r1/r2 or mirrors)
              try {
                if (typeof window._slotMap === 'undefined') window._slotMap = [0,1,2,3,4];
                const sm = [0,1,2,3,4];
                const method = (Math.random() < 0.8) ? 'rotate' : 'mirror';
                const rot = (arr,k)=> arr.map((_,i)=> arr[(i - k + arr.length)%arr.length]);
                if (method === 'rotate'){
                  const step = Math.random() < 0.5 ? 1 : 2;
                  window._slotMap = rot(sm, step);
                  window._currentMappingLabel = `r${step}`;
                } else {
                  if (Math.random()<0.5){ window._slotMap = [ sm[1], sm[0], sm[2], sm[4], sm[3] ]; window._currentMappingLabel='mh'; }
                  else { window._slotMap = [ sm[3], sm[4], sm[2], sm[0], sm[1] ]; window._currentMappingLabel='mv'; }
                }
                window._lastSpatialSwitchT = 0;
                window._previewLights = true; // enable preview lights for Step 1 hue selection
              } catch(e){ console.warn('init spatial mapping failed', e); }

              overlay.style.opacity = '0';
              setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                const tourBubbleEl = document.getElementById('tour-bubble');
                if (tourBubbleEl) tourBubbleEl.classList.add('visible');
                const hueB = document.getElementById('hue-bubble');
                setTimeout(()=>{ if (hueB) hueB.classList.add('visible'); }, 1200);
              }, 300);
            } catch (error) {
              participantId = null;
              if (error.code === 'seat-taken') {
                seat.classList.remove('available');
                seat.classList.add('used');
                seat.setAttribute('title', 'Seat already taken');
                alert('Seat already taken. Please choose another seat.');
              } else {
                alert('Failed to start session. Please try again.');
                console.warn('Failed to start session:', error);
              }
            } finally {
              seat.dataset.state = 'idle';
              seat.classList.remove('pending');
            }
          };
          }
          grid.appendChild(seat);
        }
      })
      .catch(err => {
        console.error('Could not fetch used seats.', err);
        grid.innerHTML = `<p style="color:#e55073;">Could not load seat information. You can continue locally.</p>`;
        const row = document.createElement('div');
        row.className = 'row';
        const retry = document.createElement('button');
        retry.className = 'btn'; retry.textContent = 'Retry';
        retry.onclick = ()=>{ if (overlay.parentNode) overlay.parentNode.removeChild(overlay); setupSeatSelection(); };
        const cont = document.createElement('button');
        cont.className = 'btn primary'; cont.textContent = 'Continue (local)';
        cont.onclick = ()=>{ participantId = 'local-'+Date.now(); if (overlay.parentNode) overlay.parentNode.removeChild(overlay); const tourBubbleEl = document.getElementById('tour-bubble'); if (tourBubbleEl) tourBubbleEl.classList.add('visible'); };
        row.appendChild(retry); row.appendChild(cont); overlay.appendChild(row);
      });
  }

  function setupWelcomeScreen() {
    const overlay = document.createElement('div');
    overlay.id = 'welcome-overlay';
    overlay.innerHTML = `
      <div class="welcome-content">
        <h1 class="welcome-title">Welcome</h1>
        <p class="welcome-text">
          You will experience a combined audiovisual content.
        </p>
        <p class="welcome-text">
          The experiment contains two modes: <strong>Mode A</strong> (instant response) and <strong>Mode B</strong> (energy accumulation). Your experiment will start randomly from either A or B mode. The system will automatically switch between them. Please press the <strong>Spacebar</strong> when you feel the switch happening. The screen edge glow when you press.
        </p>
        <p class="welcome-text">
          When you achieve <strong>several consecutive accurate presses</strong> (very close to the switch), the <strong>colored regions may relocate</strong> smoothly. This is expected and part of the challenge — please adjust the Hue first, then focus on detecting changes.
        </p>
        <p class="welcome-text">
          For the best experience, please use headphones.
        </p>
        <p class="welcome-text">
          Thank you for participating in this experiment!
        </p>
        <button class="welcome-button">Enter</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const button = overlay.querySelector('.welcome-button');
    button.addEventListener('click', () => {
      overlay.classList.add('hidden');
      // Wait for fade-out animation then remove overlay
      setTimeout(() => {
        if (overlay.parentNode) {
          overlay.parentNode.removeChild(overlay);
        }
      }, 500);
      setupSeatSelection();
    });
  }

  setupWelcomeScreen();

}); // end DOMContentLoaded
