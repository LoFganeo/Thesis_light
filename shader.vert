// a simple pass-through vertex shader
// it receives vertex position and texture coordinates from p5
// and passes them to the fragment shader

#ifdef GL_ES
precision mediump float;
#endif

// this is a p5.js default attribute
attribute vec3 aPosition;

// this is a p5.js default attribute
attribute vec2 aTexCoord;

// this is a varying variable that will be passed to the fragment shader
varying vec2 vTexCoord;

void main() {
  // pass through texture coordinates
  vTexCoord = aTexCoord;

  // In p5.js WEBGL, aPosition is already in clip space for our full-screen rect
  gl_Position = vec4(aPosition, 1.0);
}
