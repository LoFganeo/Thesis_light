// === Mapping模式切换 ===
let mappingMode = 'A'; // 'A' = 瞬时响应, 'B' = 累积慢淡出
let bandAccum = [0,0,0,0,0];
const decayRate = 0.92; // B模式下能量衰减系数
// === 全局能量-音频同步偏移 ===
let offsetMs = 0;

// Marker pulse overlay (Space key visual feedback)
let markerPulse = null; // { start: millis(), duration: 900 }


let auroraColors = [];
let colorsInitialized = false;
let globalEnergy = 0, focusEnergy = 0, focusX = 0, focusY = 0;
let colorHueOffset = 0;
// 新增：UI与叠加控制
let showRing = true;
let showUI = true;

// === 颜色转换工具（全局）===
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

// === CSV能量数据相关 ===
let energyData = [];
let energyFrame = 0;
let energyLoaded = false;
let energyCols = 0;
let csvPlaying = false;
let csvInterval = null;
let csvFps = 60; // 约每秒60帧

// 历史轨迹数组
let bandHistory = [[],[],[],[],[]]; // 五分区能量历史
const historyLength = 30; // 轨迹长度（帧数）

// PapaParse加载csv
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

function setup() {
  let cnv = createCanvas(window.innerWidth, window.innerHeight);
  cnv.parent('p5-holder');
  // 存储canvas元素，便于将DOM坐标转换为画布坐标
  window._p5CanvasEl = cnv.elt;
  background(0);
}

function windowResized() {
  resizeCanvas(window.innerWidth, window.innerHeight);
}



function draw() {
  background(0, 40); // 更快清屏

  // 色环三角色彩映射
  auroraColors = [];
  // 平滑动画：baseAngle缓慢追踪colorHueOffset
  if (typeof window.baseAngle === 'undefined') window.baseAngle = colorHueOffset % 360;
  let speed = 0.18; // 越大越快
  let diff = ((colorHueOffset % 360) - window.baseAngle + 360) % 360;
  if (diff > 180) diff -= 360;
  window.baseAngle += diff * speed;
  window.baseAngle = (window.baseAngle + 360) % 360;
  let baseAngle = window.baseAngle;
  // 三角顶点：低频、中频、高频
  let triAngles = [baseAngle, (baseAngle+120)%360, (baseAngle+240)%360];
  let triColors = triAngles.map(a => hslToRgb(a/360, 0.85, 0.55));
  // 中点：低-中、中-高
  let midAngles = [
    (triAngles[0]+60)%360, // 低-中
    (triAngles[2]+60)%360  // 中-高
  ];
  let midColors = midAngles.map(a => hslToRgb(a/360, 0.85, 0.55));
  // auroraColors: [高频顶点, 中-高中点, 中频顶点, 低频顶点, 低-中中点]
  auroraColors = [
    triColors[2],    // hi1 (高频顶点)
    midColors[1],    // hi2 (中-高中点)
    triColors[1],    // mid (中频顶点)
    triColors[0],    // kick (低频顶点)
    midColors[0]     // bass (低-中中点)
  ];
  colorsInitialized = true;

  // === 用csv能量数据驱动 ===
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
      for(let i=0;i<5;i++) bands[i] = row[i] || 0.09;
    } else if (mappingMode === 'B') {
      // hi1/kick分区（0和4）更钝化+延迟+高阈值，其他分区正常
      const minBase = [0.16, 0.11, 0.11, 0.11, 0.16];
      const boostRateArr = [0.08, 0.16, 0.16, 0.16, 0.08];
      const decayArr = [0.97, 0.92, 0.92, 0.92, 0.97];
      const gammaArr = [0.82, 0.78, 0.78, 0.78, 0.82];
      // 响应延迟：hi1/kick用前2帧均值
      if (!window.bandDelay) window.bandDelay = [[],[],[],[],[]];
      for(let i=0;i<5;i++) {
        let target = row[i] || minBase[i];
        if (i===0 || i===4) {
          // hi1/kick延迟
          window.bandDelay[i].push(target);
          if (window.bandDelay[i].length>2) window.bandDelay[i].shift();
          target = window.bandDelay[i].reduce((a,b)=>a+b,0)/window.bandDelay[i].length;
        }
        let extraBoost = (target - bandAccum[i]) * boostRateArr[i];
        bandAccum[i] = bandAccum[i]*decayArr[i] + target*(1-decayArr[i]) + extraBoost;
        bands[i] = Math.max(Math.pow(bandAccum[i], gammaArr[i]), minBase[i]);
      }
    }
    // 更新bandHistory
    for (let i=0;i<5;i++) {
      bandHistory[i].push(bands[i]);
      if (bandHistory[i].length > historyLength) bandHistory[i].shift();
    }
  }

  // === 动态聚焦点 ===
  let time = millis()/1000;
  focusX = width/2 + Math.sin(time*0.23)*width*0.18 + Math.cos(time*0.13)*width*0.09;
  focusY = height/2 + Math.cos(time*0.19)*height*0.16 + Math.sin(time*0.11)*height*0.07;

  // === 五分区像素云雾状渲染 ===
  let grid = 8;
  // === 动态/自适应分区结构 ===
  // 1. bandCenters随时间缓慢扰动（动态分区中心）
  // 2. bandSigma随能量动态调整（自适应分区宽度）
  // 3. 每帧对bandCenters和bandSigma做平滑，避免突变
  // 4. 每个分区的sigma可略有差异（非均匀）
  // 5. 分区中心可受能量影响微调
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
    // 动态扰动+能量微调
    let cx0 = [width*0.25, width*0.75, width*0.5, width*0.25, width*0.75][i];
    let cy0 = [height*0.22, height*0.22, height*0.5, height*0.78, height*0.78][i];
    let dx = Math.sin(t*0.13 + i*1.2)*width*0.018 + Math.cos(t*0.19 + i*0.7)*width*0.012;
    let dy = Math.cos(t*0.11 + i*1.7)*height*0.016 + Math.sin(t*0.17 + i*0.9)*height*0.011;
    // 能量微调（高能量时中心略向画面中心偏移）
    let bandE = bands ? bands[i] : 0.1;
    let centerBiasX = (width/2 - cx0) * bandE * 0.13;
    let centerBiasY = (height/2 - cy0) * bandE * 0.13;
    let cx = cx0 + dx + centerBiasX;
    let cy = cy0 + dy + centerBiasY;
    // 平滑过渡
    let prev = window._bandCenters[i];
    let smooth = 0.82;
    let newCx = prev[0]*smooth + cx*(1-smooth);
    let newCy = prev[1]*smooth + cy*(1-smooth);
    bandCenters.push([newCx, newCy]);
    window._bandCenters[i] = [newCx, newCy];
    // sigma动态调整：基础+能量影响+扰动+分区差异
    let sigmaBase = baseSigma * (0.98 + 0.07*Math.sin(t*0.21+i*0.8));
    let sigmaEnergy = 1.0 + bandE*0.22;
    let sigma = sigmaBase * sigmaEnergy * (0.97 + 0.06*Math.cos(t*0.17+i*1.3));
    // hi1/kick略更窄
    if (i===0||i===4) sigma *= 0.93;
    // 平滑
    let prevSigma = window._bandSigmaArr[i];
    let sigmaSmooth = 0.82;
    let newSigma = prevSigma*sigmaSmooth + sigma*(1-sigmaSmooth);
    bandSigmaArr.push(newSigma);
    window._bandSigmaArr[i] = newSigma;
  }
  // CPU 路径（仅保留 CPU 渲染）
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

      // 分区能量与颜色混合
      let w1 = weights[maxIdx], w2 = weights[secondIdx];
      let colorA = auroraColors[maxIdx];
      let colorB = auroraColors[secondIdx];
      let band1 = bands[maxIdx];
      let sensitivity1 = (maxIdx === 0) ? 0.65 : (maxIdx === 4) ? 0.55 : 1.0;
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
      let sensitivity2 = (secondIdx === 0) ? 0.65 : (secondIdx === 4) ? 0.55 : 1.0;
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

  // 绘制色环和三角形（与 Hue 滑块居中对齐，显示在滑块正上方）
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
    // 色环
    for(let i=0;i<360;i+=2){
      let c = hslToRgb(i/360,0.85,0.55);
      stroke(c[0],c[1],c[2]);
      strokeWeight(8);
      let angle = radians(i);
      let x1 = cos(angle)*ringR, y1 = sin(angle)*ringR;
      let x2 = cos(angle)*ringR*0.85, y2 = sin(angle)*ringR*0.85;
      line(x1,y1,x2,y2);
    }
    // 三角形
    let triR = ringR*0.7;
    let triPts = triAngles.map(a => [cos(radians(a))*triR, sin(radians(a))*triR]);
    noFill();
    stroke(255,255,255,180);
    strokeWeight(3);
    beginShape();
    for(let i=0;i<3;i++) vertex(triPts[i][0], triPts[i][1]);
    endShape(CLOSE);
    // 顶点圆点和标签（LMH）
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
  #sample-panel{position:fixed;top:16px;left:24px;z-index:2250;padding:10px 14px;background:rgba(30,32,40,0.98);border:1px solid rgba(255,255,255,0.35);box-shadow:0 8px 28px #000c}
  #sample-panel label{color:#fff;opacity:.9;font-weight:600;letter-spacing:1px;margin-right:8px}
  #sample-panel select{color:#fff;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.2);border-radius:10px;padding:6px 10px;outline:none}
  #mode-panel{position:fixed;top:86px;left:24px;z-index:2250;padding:10px 14px;display:none;background:rgba(30,32,40,0.98);border:1px solid rgba(255,255,255,0.35);box-shadow:0 8px 28px #000c}
  #offset-panel{position:fixed;top:168px;left:24px;z-index:2250;padding:10px 14px;display:none;background:rgba(30,32,40,0.98);border:1px solid rgba(255,255,255,0.35);box-shadow:0 8px 28px #000c}
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

  // Mapping buttons
  const mappingABtn = document.getElementById('mapping-a-btn');
  const mappingBBtn = document.getElementById('mapping-b-btn');
  function setMapping(mode){
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
  let MODE_SWITCH_MIN_MS = 3000;
  let MODE_SWITCH_MAX_MS = 10000;
  function scheduleNextModeSwitch(){
    const span = MODE_SWITCH_MAX_MS - MODE_SWITCH_MIN_MS;
    const delay = MODE_SWITCH_MIN_MS + Math.random() * (span >= 0 ? span : 0);
    console.debug('[AutoSwitch] scheduling next in', Math.round(delay), 'ms');
    modeSwitchTimer = setTimeout(()=>{
      // clear the handle so a future start can re-arm even if we don't reschedule here
      modeSwitchTimer = null;
      try{
        if (audio && !audio.paused) {
          const next = Math.random() < 0.5 ? 'A' : 'B';
          console.debug('[AutoSwitch] switching to', next);
          setMapping(next);
        } else {
          console.debug('[AutoSwitch] audio not playing, skip switch');
        }
      } finally {
        if (audio && !audio.paused) scheduleNextModeSwitch();
      }
    }, delay);
  }
  function startModeAutoSwitch(){ if (!modeSwitchTimer){ console.debug('[AutoSwitch] start'); scheduleNextModeSwitch(); } }
  function stopModeAutoSwitch(){ if (modeSwitchTimer){ console.debug('[AutoSwitch] stop'); clearTimeout(modeSwitchTimer); modeSwitchTimer = null; } }

  function playCSV(){ if (!csvPlaying){ csvPlaying = true; csvInterval = setInterval(()=>{ if (energyLoaded && csvPlaying){ energyFrame = (energyFrame + 1) % energyData.length; } }, 1000/csvFps); } }
  function pauseCSV(){ csvPlaying = false; if (csvInterval) clearInterval(csvInterval); }
  function setPlayIcon(){ playFab.textContent = (audio && !audio.paused && audioLoaded) ? '❚❚' : '▶'; }
  function togglePlay(){ if (!audioLoaded) return; if (audio.paused){ audio.play(); } else { audio.pause(); } setPlayIcon(); }
  if (sampleSelect){
    sampleSelect.onchange = () => {
      if (audio){ audio.pause(); audio.currentTime = 0; audio.onended = null; }
      stopModeAutoSwitch();
      audio = new Audio(sampleSelect.value);
      window.audio = audio;
      audioLoaded = false;
      audio.oncanplay = () => { audioLoaded = true; setPlayIcon(); };
      audio.onplay = () => { pauseCSV(); startModeAutoSwitch(); };
      audio.onpause = () => { pauseCSV(); stopModeAutoSwitch(); };
      audio.onended = () => { pauseCSV(); stopModeAutoSwitch(); setPlayIcon(); };
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

  function triggerMarkerPulse(){ markerPulse = { start: millis(), duration: 450 }; } // faster pulse (was 900ms)

  // Hold-to-show (Backquote) + shortcuts
  let backquoteHeld = false;
  function showHiddenPanels(){ modePanel.style.display = 'block'; offsetPanel.style.display = 'block'; }
  function hideHiddenPanels(){ modePanel.style.display = 'none'; offsetPanel.style.display = 'none'; }

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
    // Space triggers marker pulse only
    if (e.code==='Space' || e.key===' '){ e.preventDefault(); triggerMarkerPulse(); }
    if (e.key==='u' || e.key==='U'){
      const anyVisible = samplePanel.style.display !== 'none' || colorToolbar.style.display !== 'none' || playFab.style.display !== 'none' || modePanel.style.display !== 'none' || offsetPanel.style.display !== 'none';
      const disp = anyVisible ? 'none' : '';
      samplePanel.style.display = disp;
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
}); // end DOMContentLoaded