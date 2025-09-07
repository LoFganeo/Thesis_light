#ifdef GL_ES
precision mediump float;
#endif

varying vec2 vTexCoord;

// Uniforms from p5.js
uniform vec2 u_resolution;
uniform float u_time;
uniform vec2 u_mouse;

// Custom uniforms
uniform float u_bands[5];
uniform vec3 u_auroraColors[5];
uniform vec2 u_bandCenters[5];
uniform float u_bandSigmaArr[5];

// Noise function (from https://www.shadertoy.com/view/4sfGzS)
vec3 hash( vec3 p ) {
  p = vec3( dot(p,vec3(127.1,311.7, 74.7)),
        dot(p,vec3(269.5,183.3,246.1)),
        dot(p,vec3(113.5,271.9,124.6)));
  return -1.0 + 2.0*fract(sin(p)*43758.5453123);
}

float noise( in vec3 p ) {
    vec3 i = floor( p );
    vec3 f = fract( p );
  
    vec3 u = f*f*(3.0-2.0*f);

    return mix( mix( mix( dot( hash( i + vec3(0.0,0.0,0.0) ), f - vec3(0.0,0.0,0.0) ), 
                          dot( hash( i + vec3(1.0,0.0,0.0) ), f - vec3(1.0,0.0,0.0) ), u.x),
                     mix( dot( hash( i + vec3(0.0,1.0,0.0) ), f - vec3(0.0,1.0,0.0) ), 
                          dot( hash( i + vec3(1.0,1.0,0.0) ), f - vec3(1.0,1.0,0.0) ), u.x), u.y),
                mix( mix( dot( hash( i + vec3(0.0,0.0,1.0) ), f - vec3(0.0,0.0,1.0) ), 
                          dot( hash( i + vec3(1.0,0.0,1.0) ), f - vec3(1.0,0.0,1.0) ), u.x),
                     mix( dot( hash( i + vec3(0.0,1.0,1.0) ), f - vec3(0.0,1.0,1.0) ), 
                          dot( hash( i + vec3(1.0,1.0,1.0) ), f - vec3(1.0,1.0,1.0) ), u.x), u.y), u.z );
}


void main() {
  vec2 st = vTexCoord;
  st.y = 1.0 - st.y; // Flip y-axis to match p5 coordinate system
  vec2 pixel = st * u_resolution;

  // --- Weight Calculation ---
  float weights[5];
  float totalWeight = 0.0;
  for (int i = 0; i < 5; i++) {
    vec2 center = u_bandCenters[i];
    float sigma = u_bandSigmaArr[i];
    vec2 diff = pixel - center;
    float w = exp(-(dot(diff, diff)) / (2.0 * sigma * sigma));
    weights[i] = w;
    totalWeight += w;
  }

  // --- Find max and second max indices ---
  // This is tricky in GLSL. We'll do a simplified sort.
  int maxIdx = 0;
  int secondIdx = 1;
  for (int i = 1; i < 5; i++) {
    if (weights[i] > weights[maxIdx]) {
      secondIdx = maxIdx;
      maxIdx = i;
    } else if (weights[i] > weights[secondIdx]) {
      secondIdx = i;
    }
  }
  if (weights[secondIdx] > weights[maxIdx]) { // final check
      int temp = maxIdx;
      maxIdx = secondIdx;
      secondIdx = temp;
  }


  // --- Weight Normalization (same logic as JS) ---
  for (int i = 0; i < 5; i++) {
    if (i == maxIdx) {
      weights[i] *= 1.12;
    } else {
      weights[i] *= 0.38;
    }
  }
  float sumW = 0.0;
  for(int i=0; i<5; i++) sumW += weights[i];
  for(int i=0; i<5; i++) weights[i] = pow(weights[i]/sumW, 1.18);
  float normSum = 0.0;
  for(int i=0; i<5; i++) normSum += weights[i];
  for(int i=0; i<5; i++) weights[i] /= normSum;


  // --- Color & Alpha Calculation ---
  float w1 = weights[maxIdx];
  float w2 = weights[secondIdx];

  vec3 colorA = u_auroraColors[maxIdx];
  vec3 colorB = u_auroraColors[secondIdx];

  float band1 = u_bands[maxIdx];
  float sensitivity1 = (maxIdx == 0) ? 0.65 : (maxIdx == 4) ? 0.55 : 1.0;
  band1 *= sensitivity1;
  float d1 = distance(pixel, u_bandCenters[maxIdx]);
  float focus1 = exp(-d1 * 0.009) * band1;
  float n1 = noise(vec3(pixel * 0.003, u_time * 0.12 + float(maxIdx) * 0.2));
  float val1 = clamp(n1 + focus1 * 1.5, 0.0, 1.0);
  float energyThreshold1 = 0.13 + 0.09 * float(maxIdx);
  float a1 = (18.0 + 22.0*float(maxIdx) + 60.0*band1) * pow(val1, 2.2) + (60.0 + 80.0*band1)*focus1;
  a1 *= 0.13 + 0.22*band1;
  float show1 = (val1 > energyThreshold1 && band1 > 0.01 && a1 > 1.0) ? 1.0 : 0.0;

  float band2 = u_bands[secondIdx];
  float sensitivity2 = (secondIdx == 0) ? 0.65 : (secondIdx == 4) ? 0.55 : 1.0;
  band2 *= sensitivity2;
  float d2 = distance(pixel, u_bandCenters[secondIdx]);
  float focus2 = exp(-d2 * 0.009) * band2;
  float n2 = noise(vec3(pixel * 0.003, u_time * 0.12 + float(secondIdx) * 0.2));
  float val2 = clamp(n2 + focus2 * 1.5, 0.0, 1.0);
  float energyThreshold2 = 0.13 + 0.09 * float(secondIdx);
  float a2 = (18.0 + 22.0*float(secondIdx) + 60.0*band2) * pow(val2, 2.2) + (60.0 + 80.0*band2)*focus2;
  a2 *= 0.13 + 0.22*band2;
  float show2 = (val2 > energyThreshold2 && band2 > 0.01 && a2 > 1.0) ? 1.0 : 0.0;

  float blend = 0.0;
  if (w2 > 0.18 && show1 > 0.5 && show2 > 0.5) {
    blend = w2 / (w1 + w2);
  }

  vec3 finalColor = mix(colorA, colorB, blend);
  float finalAlpha = mix(a1, a2, blend) / 255.0; // Normalize alpha
  float bandEnergy = mix(band1, band2, blend);

  if (bandEnergy > 0.01 && finalAlpha * 255.0 > 1.0) {
    gl_FragColor = vec4(finalColor, finalAlpha);
  } else {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); // Opaque black
  }
}
