// Pixelado real estilo t3ssel8r (PASS_FRAG del Kit 3D):
// 1. La escena se dibuja en un render target chico (1 texel = 1 "pixel de arte" de KIT_PIXEL px CSS,
//    2 por defecto como pide v2, redondeado a pixeles fisicos enteros para que todos midan igual en
//    pantallas al 125 % o 150 %). ?pixel=3 o ?pixel=4 lo agrandan; ?pixel=0 lo apaga.
// 2. La camara se ajusta a la grilla de pixeles del mundo antes de dibujar: al panear, lo quieto no
//    "hierve"; el resto de subpixel se compensa al escalar, asi el paneo sigue siendo suave.
// 3. Un pase de pantalla completa escala con nearest y dibuja el contorno tinta de 1 pixel a partir
//    del depth (segunda derivada: los planos inclinados no se marcan, solo los saltos de silueta).
//    El vacio alrededor del diorama es el fondo (todo en este shader, sin mallas): una ciudad de noche
//    vista desde lo alto. Cielo de la hora con resplandor en el horizonte, bancos de nubes tramados
//    (vientre tenido por la ciudad, borde hacia la luna), estrellas finas arriba, luna pixel, ciudad en
//    tres capas con perspectiva de aire (retranqueos, ventanas tibias y frias, balizas y pocos neones
//    magenta y cian), luz de calle y un halo tibio alrededor de la oficina. Las capas se corren con la
//    camara a distinta velocidad (paralaje, uPan). Todo va en "pixeles de arte" de 2 px CSS (uArt) y a
//    baja intensidad: la oficina es la protagonista. Quieto a proposito (sin titilar, parpadear ni
//    cruzar nada): solo las nubes derivan, tan lento que no se nota. Mucho movimiento distrae.

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  type Camera,
  Color,
  DepthTexture,
  HalfFloatType,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  type Scene,
  Scene as ThreeScene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { getDayState } from './daylight';
import { INK_MIX, KIT_PIXEL, PAL } from './world/kit';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uRtSize;
uniform vec2 uScreen;
uniform float uPixel;
uniform vec2 uShift;
uniform float uDepthRange;
uniform float uThreshold;
uniform vec3 uInk;
uniform float uInkMix;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform float uStars;
uniform float uNight;
uniform float uTime;
uniform float uArt;
uniform float uChunky;
uniform vec2 uPan;
uniform vec2 uHaloR;
uniform vec3 uHorizon;
uniform vec3 uStarWarm;
uniform vec3 uStarCool;
uniform vec3 uMoon;
uniform vec3 uCloudShade;
uniform vec3 uCloudLit;
uniform vec3 uCityFar;
uniform vec3 uCityMid;
uniform vec3 uCityNear;
uniform vec3 uCityGlow;
uniform vec3 uWindow;
uniform vec3 uWindowCool;
uniform vec3 uBeacon;
uniform vec3 uNeonA;
uniform vec3 uNeonB;
uniform vec3 uHalo;
varying vec2 vUv;

float bayer2(vec2 a) { a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float depthAt(vec2 cell) { return texture2D(tDepth, (cell + 0.5) / uRtSize).x * uDepthRange; }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}

// una estrella (o ninguna) por celda de 'size' pixeles de arte; las mas brillantes llevan cruz
vec3 starLayer(vec2 g, float size, float density, float seed, float flare) {
  vec2 cell = floor(g / size);
  float h = hash(cell + seed);
  float cut = 1.0 - density;
  if (h < cut) return vec3(0.0);
  float k = (h - cut) / density;
  vec2 pos = cell * size + 1.0 + floor(vec2(hash(cell + seed + 3.1), hash(cell + seed + 7.7)) * (size - 2.0));
  vec2 d = abs(floor(g) - pos);
  // sin titilar (el fondo va quieto para no distraer): cada estrella con su brillo fijo
  float tw = 0.65 + 0.35 * fract(h * 91.0);
  float lum = 0.0;
  if (d.x + d.y < 0.5) lum = 1.0;
  else if (flare > 0.5 && k > 0.6 && min(d.x, d.y) < 0.5 && max(d.x, d.y) < 1.5) lum = 0.5;
  else if (flare > 0.5 && k > 0.9 && min(d.x, d.y) < 0.5 && max(d.x, d.y) < 2.5) lum = 0.22 * tw;
  vec3 c = mix(uStarWarm, uStarCool, fract(h * 13.7));
  return c * lum * (0.3 + 0.7 * k) * tw;
}

// Un edificio por columna de 'width' pixeles de arte. Devuelve x cobertura, y ventana encendida (0..1),
// z ventana fria (0/1) y w senal: 1 baliza roja, 2 neon magenta, 3 neon cian (solo si 'signs').
// Los altos terminan en un cuerpo mas angosto (retranqueo) y algunos llevan antena con baliza.
vec4 building(float gx, float gy, float width, float hMin, float hMax, float seed, float signs) {
  float col = floor(gx / width);
  float wx = gx - col * width;
  float h1 = hash(vec2(col, seed));
  float bw = floor(width * (0.55 + 0.45 * hash(vec2(col, seed + 2.0))));
  float x0 = floor((width - bw) * hash(vec2(col, seed + 4.0)));
  float top = floor(mix(hMin, hMax, h1 * h1));
  wx -= x0;
  if (wx < 0.0 || wx >= bw) return vec4(0.0);
  float setback = (h1 > 0.5 && bw > 5.0) ? max(1.0, floor(bw * 0.2)) : 0.0;
  float body = top - (setback > 0.0 ? floor(2.0 + 3.0 * hash(vec2(col, seed + 8.0))) : 0.0);
  if (gy >= body && gy < top) {
    if (wx < setback || wx >= bw - setback) return vec4(0.0);
    return vec4(1.0, 0.0, 0.0, 0.0);
  }
  if (gy < body) {
    // letrero de neon en la fachada: un rectangulo que casi nunca se apaga
    if (signs > 0.5 && hash(vec2(col, seed + 10.0)) > 0.78 && bw > 4.0) {
      float sy = floor(body * (0.35 + 0.3 * hash(vec2(col, seed + 12.0))));
      if (gy >= sy && gy < sy + 2.0 && wx >= 1.0 && wx < bw - 1.0) {
        float kind = hash(vec2(col, seed + 14.0)) > 0.5 ? 2.0 : 3.0;
        return vec4(1.0, 0.0, 0.0, kind);
      }
    }
    float lit = 0.0;
    float cool = 0.0;
    bool slotX = fract((wx + 0.5) / 2.0) > 0.5 && wx < bw - 1.5;
    bool slotY = abs(fract((gy + 0.5) / 3.0) - 0.5) < 0.1 && gy < body - 2.5;
    if (slotX && slotY) {
      // ventanas encendidas fijas (sin prender y apagar: el fondo no distrae)
      vec2 id = vec2(col * 61.0 + wx, gy + seed * 17.0);
      lit = step(0.8, hash(id + 3.7)) * (0.55 + 0.45 * hash(id + 9.0));
      cool = step(0.72, hash(id + 4.0));
    }
    return vec4(1.0, lit, cool, 0.0);
  }
  if (h1 > 0.72 && abs(wx - floor(bw * 0.5)) < 0.5) {
    float ant = 3.0 + floor(5.0 * hash(vec2(col, seed + 6.0)));
    if (gy < top + ant) return vec4(1.0, 0.0, 0.0, 0.0);
    if (gy < top + ant + 1.0) return vec4(1.0, 0.0, 0.0, 1.0);
  }
  return vec4(0.0);
}

vec4 cityLayer(float gx, float gy, float w1, float w2, float hMin, float hMax, float seed, float signs) {
  vec4 b = building(gx, gy, w1, hMin, hMax, seed, signs);
  if (b.x < 0.5) b = building(gx + 5.0, gy, w2, hMin * 0.8, hMax * 0.85, seed + 3.0, signs);
  return b;
}

// color de un pixel de edificio: base, ventanas tibias o frias, baliza y neon (todo apagado de dia)
vec3 cityColor(vec4 b, vec3 base, float win, float neon) {
  vec3 c = mix(base, mix(uWindow, uWindowCool, b.z), b.y * win * uNight);
  if (b.w > 0.5 && b.w < 1.5) c = mix(c, uBeacon, 0.35 * uNight);
  else if (b.w > 1.5) c = mix(c, b.w < 2.5 ? uNeonA : uNeonB, neon * uNight);
  return c;
}

vec3 backdrop(vec2 uv) {
  vec2 frag = uChunky > 0.5 ? (floor(gl_FragCoord.xy / uArt) + 0.5) * uArt : gl_FragCoord.xy;
  vec2 sn = frag / uScreen;
  float t = clamp(sn.y, 0.0, 1.0);
  float H = uScreen.y / uArt;
  vec2 gp = floor(frag / uArt);
  float dith = bayer4(gp);

  // cielo: degradado con resplandor en el horizonte y una variacion lenta de tono para que no sea plano
  vec3 color = mix(uSkyBottom, uSkyTop, smoothstep(0.0, 1.0, pow(t, 0.85)));
  color = mix(color, uHorizon, exp(-t * 4.5) * 0.55);
  color *= 0.95 + 0.1 * noise(sn * vec2(1.6, 1.1));

  // nubes: dos bancos alargados en tres tonos tramados (pixel art). Por debajo las ilumina la ciudad;
  // arriba, la luna. Derivan tan despacio que no se nota el movimiento (el fondo no distrae)
  float s = min(uScreen.x, uScreen.y);
  vec2 cp = (frag + uPan * 0.03) / s;
  cp.x += uTime * 0.0004;
  float c1 = fbm(vec2(cp.x * 2.1, cp.y * 6.5) + vec2(3.1, 0.0));
  float c2 = fbm(vec2(cp.x * 3.4, cp.y * 9.0) + vec2(11.7, 4.2));
  float belt = smoothstep(0.1, 0.26, t) * (1.0 - smoothstep(0.46, 0.7, t));
  float dens = max(smoothstep(0.5, 0.78, c1), 0.7 * smoothstep(0.56, 0.8, c2)) * belt;
  float cloud = clamp(floor(dens * 3.0 + dith) / 3.0, 0.0, 1.0);

  // estrellas finas solo en el cielo alto y tapadas por las nubes
  float high = smoothstep(0.3, 0.5, t) * uStars * (1.0 - cloud);
  vec3 st = starLayer((frag + uPan * 0.012) / uArt, 9.0, 0.03, 0.0, 0.0) * 0.3;
  st += starLayer((frag + uPan * 0.025) / uArt, 17.0, 0.04, 19.0, 1.0) * 0.5;
  st += starLayer((frag + uPan * 0.04) / uArt, 33.0, 0.05, 41.0, 1.0) * 0.65;
  color += st * high;

  // luna pixel con halo en bandas tramadas
  vec2 gm = floor((frag + uPan * 0.02) / uArt);
  float R = clamp(floor(H * 0.03), 7.0, 15.0);
  vec2 md = gm + 0.5 - floor(uScreen / uArt * vec2(0.8, 0.8));
  float r = length(md);
  if (uStars > 0.01) {
    float glow = exp(-max(r - R, 0.0) / (R * 1.1));
    color += uMoon * floor(glow * 4.0 + bayer4(gm)) * 0.018 * uStars;
    if (r < R) {
      vec2 m = md / R;
      vec3 nrm = vec3(m, sqrt(max(0.0, 1.0 - dot(m, m))));
      float lit = dot(nrm, normalize(vec3(-0.55, 0.5, 0.7)));
      float tone = lit > 0.55 ? 1.0 : (lit > 0.15 ? 0.82 : 0.62);
      tone *= 1.0 - 0.14 * step(0.64, noise(md * 0.22 + 3.7));
      color = mix(color, uMoon * tone, 0.75 * uStars);
    }
  }

  // nubes: sombra arriba, borde claro hacia la luna, vientre tenido por la luz de la ciudad
  if (cloud > 0.0) {
    float under = 1.0 - smoothstep(0.12, 0.5, t);
    vec3 cc = mix(uCloudShade, uCloudLit, 0.25 + 0.75 * under);
    float moonSide = smoothstep(0.55, 0.95, sn.x) * smoothstep(0.35, 0.6, t);
    cc = mix(cc, uMoon * 0.55, moonSide * 0.35 * uStars);
    color = mix(color, cc, cloud * 0.55);
  }

  // ciudad en tres capas con perspectiva de aire: lejos mas clara y brumosa, cerca mas oscura y con neon
  float gy = gp.y;
  vec4 cFar = cityLayer(floor((frag.x + uPan.x * 0.04) / uArt), gy, 8.0, 13.0, H * 0.06, H * 0.16, 1.0, 0.0);
  if (cFar.x > 0.5) color = cityColor(cFar, mix(uCityFar, uHorizon, 0.35), 0.18, 0.0);
  color = mix(color, uHorizon, exp(-t * 8.0) * 0.4);
  vec4 cMid = cityLayer(floor((frag.x + uPan.x * 0.065) / uArt), gy, 10.0, 16.0, H * 0.035, H * 0.1, 7.0, 0.0);
  if (cMid.x > 0.5) color = cityColor(cMid, uCityMid, 0.3, 0.0);
  // luz de las calles entre los edificios cercanos
  color += uCityGlow * exp(-t * 16.0) * 0.22 * uNight;
  vec4 cNear = cityLayer(floor((frag.x + uPan.x * 0.09) / uArt), gy, 12.0, 19.0, H * 0.02, H * 0.065, 11.0, 1.0);
  if (cNear.x > 0.5) color = cityColor(cNear, uCityNear, 0.45, 0.7);

  // halo tibio alrededor de la oficina: cuanto del diorama hay en dos anillos alrededor del pixel
  float spill = 0.0;
  float rot = bayer4(gl_FragCoord.xy) * 6.2831853;
  for (int i = 0; i < 6; i++) {
    float a = rot + float(i) * 1.0471976;
    vec2 d = vec2(cos(a), sin(a)) / uRtSize;
    spill += step(texture2D(tDepth, uv + d * uHaloR.x).x, 0.99999) * 0.6;
    spill += step(texture2D(tDepth, uv + d * uHaloR.y).x, 0.99999) * 0.4;
  }
  color += uHalo * (spill / 6.0) * 0.2;
  return color;
}

void main() {
  vec2 q = gl_FragCoord.xy / uPixel + uShift;
  vec2 cell = floor(q) + 1.0;
  vec2 uv = (cell + 0.5) / uRtSize;
  vec3 color = texture2D(tColor, uv).rgb;
  float raw = texture2D(tDepth, uv).x;
  float dc = raw * uDepthRange;

  // contorno exterior: el pixel mas lejano junto a un salto de profundidad se pinta de tinta
  float edge = max(
    2.0 * dc - depthAt(cell - vec2(1.0, 0.0)) - depthAt(cell + vec2(1.0, 0.0)),
    2.0 * dc - depthAt(cell - vec2(0.0, 1.0)) - depthAt(cell + vec2(0.0, 1.0))
  );

  if (raw > 0.99999) color = backdrop(uv);
  if (edge > uThreshold) color = mix(color, uInk, uInkMix);

  vec2 v = gl_FragCoord.xy / uScreen - 0.5;
  color *= 1.0 - 0.28 * smoothstep(0.34, 0.9, length(v * vec2(1.15, 1.0)));
  // tramado de 1/255 ya en sRGB: quita el escalonado de los degradados oscuros
  vec4 outColor = linearToOutputTexel(vec4(color, 1.0));
  outColor.rgb += (bayer4(gl_FragCoord.xy) - 0.47) / 255.0;
  gl_FragColor = outColor;
}
`;

interface Pipeline {
  render: (gl: WebGLRenderer, scene: Scene, camera: Camera, time: number) => void;
  dispose: () => void;
}

function createPipeline(gl: WebGLRenderer, pixelSize: number): Pipeline {
  const halfFloat = gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float');
  const depthTexture = new DepthTexture(1, 1);
  const target = new WebGLRenderTarget(1, 1, {
    type: halfFloat ? HalfFloatType : UnsignedByteType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
    depthTexture,
  });
  const uniforms = {
    tColor: { value: target.texture },
    tDepth: { value: depthTexture },
    uRtSize: { value: new Vector2(1, 1) },
    uScreen: { value: new Vector2(1, 1) },
    uPixel: { value: pixelSize },
    uShift: { value: new Vector2() },
    uDepthRange: { value: 100 },
    uThreshold: { value: 0.15 },
    uInk: { value: new Color(PAL.ink) },
    uInkMix: { value: INK_MIX },
    uSkyTop: { value: new Color() },
    uSkyBottom: { value: new Color() },
    uStars: { value: 0 },
    uNight: { value: 0 },
    uTime: { value: 0 },
    uArt: { value: 2 },
    uChunky: { value: pixelSize > 0 ? 1 : 0 },
    uPan: { value: new Vector2() },
    uHaloR: { value: new Vector2(1, 1) },
    uHorizon: { value: new Color() },
    uStarWarm: { value: new Color(PAL.cream) },
    uStarCool: { value: new Color(PAL.moon).lerp(new Color('#ffffff'), 0.35) },
    uMoon: { value: new Color(PAL.cream).lerp(new Color(PAL.moon), 0.3) },
    uCloudShade: { value: new Color() },
    uCloudLit: { value: new Color() },
    uCityFar: { value: new Color() },
    uCityMid: { value: new Color() },
    uCityNear: { value: new Color() },
    uCityGlow: { value: new Color(PAL.amber).lerp(new Color(PAL.magenta), 0.35) },
    uWindow: { value: new Color(PAL.amber) },
    uWindowCool: { value: new Color(PAL.moon).lerp(new Color('#ffffff'), 0.25) },
    uBeacon: { value: new Color(PAL.ember) },
    uNeonA: { value: new Color(PAL.magenta) },
    uNeonB: { value: new Color(PAL.cyan) },
    uHalo: { value: new Color(PAL.amber).lerp(new Color(PAL.lilac), 0.45) },
  };
  const plum = new Color(PAL.plum);
  const ink = new Color(PAL.ink);
  const white = new Color('#ffffff');
  // vientre de las nubes de noche: ciruela tenido por la luz tibia de la ciudad
  const cloudNight = new Color(PAL.plum).lerp(new Color(PAL.amber), 0.22);
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const quadScene = new ThreeScene();
  quadScene.add(quad);
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const buffer = new Vector2();
  const savedPosition = new Vector3();
  const right = new Vector3();
  const up = new Vector3();

  return {
    render(renderer, scene, camera, time) {
      if (!(camera instanceof OrthographicCamera)) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      renderer.getDrawingBufferSize(buffer);
      const dpr = renderer.getPixelRatio();
      // 0 = resolucion completa (el "Off" del kit): 1 texel = 1 pixel fisico, con contorno y cielo
      const px = pixelSize > 0 ? Math.max(1, Math.round(pixelSize * dpr)) : 1;
      const wr = Math.ceil(buffer.x / px) + 2;
      const hr = Math.ceil(buffer.y / px) + 2;
      if (target.width !== wr || target.height !== hr) target.setSize(wr, hr);

      const { left, right: frRight, top, bottom } = camera;
      savedPosition.copy(camera.position);
      // frustum del render target: 1 texel de margen a cada lado para absorber el ajuste de subpixel
      camera.left = (-px - buffer.x / 2) / dpr;
      camera.right = ((wr - 1) * px - buffer.x / 2) / dpr;
      camera.bottom = (-px - buffer.y / 2) / dpr;
      camera.top = ((hr - 1) * px - buffer.y / 2) / dpr;
      camera.updateProjectionMatrix();

      // camara ajustada a la grilla de pixeles del mundo
      const worldPerPixel = px / (dpr * camera.zoom);
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      const pr = savedPosition.dot(right) / worldPerPixel;
      const pu = savedPosition.dot(up) / worldPerPixel;
      const fr = pr - Math.round(pr);
      const fu = pu - Math.round(pu);
      camera.position.addScaledVector(right, -fr * worldPerPixel).addScaledVector(up, -fu * worldPerPixel);
      camera.updateMatrixWorld();

      const background = scene.background;
      scene.background = null;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      scene.background = background;

      camera.position.copy(savedPosition);
      camera.left = left;
      camera.right = frRight;
      camera.top = top;
      camera.bottom = bottom;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      const day = getDayState();
      uniforms.uRtSize.value.set(wr, hr);
      uniforms.uScreen.value.set(buffer.x, buffer.y);
      uniforms.uPixel.value = px;
      uniforms.uShift.value.set(fr, fu);
      uniforms.uDepthRange.value = camera.far - camera.near;
      uniforms.uThreshold.value = 0.09 + 1.6 * worldPerPixel;
      uniforms.uSkyTop.value.copy(day.skyTop);
      uniforms.uSkyBottom.value.copy(day.skyBottom);
      uniforms.uStars.value = day.stars;
      uniforms.uNight.value = day.night;
      uniforms.uTime.value = time;
      // pixel de arte del fondo: el del pixelado, o 2 px CSS a resolucion completa
      uniforms.uArt.value = pixelSize > 0 ? px : Math.max(2, Math.round(2 * dpr));
      uniforms.uPan.value.set(pr * px, pu * px);
      uniforms.uHaloR.value.set((14 * dpr) / px, (34 * dpr) / px);
      uniforms.uHorizon.value.copy(day.skyBottom).lerp(plum, 0.6 * day.night);
      uniforms.uCityFar.value.copy(day.skyBottom).lerp(ink, 0.3 + 0.2 * day.night);
      uniforms.uCityMid.value.copy(day.skyBottom).lerp(ink, 0.42 + 0.2 * day.night);
      uniforms.uCityNear.value.copy(day.skyBottom).lerp(ink, 0.55 + 0.2 * day.night);
      // nubes: de dia blancas y grises; de noche sombra azul tinta y vientre ciruela
      uniforms.uCloudShade.value.copy(day.skyTop).lerp(ink, 0.25 * day.night).lerp(white, 0.35 * (1 - day.night));
      uniforms.uCloudLit.value.copy(white).lerp(day.skyBottom, 0.25).lerp(cloudNight, day.night);

      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCamera);
    },
    dispose() {
      target.dispose();
      depthTexture.dispose();
      material.dispose();
      quad.geometry.dispose();
    },
  };
}

/** Toma el control del render (prioridad 1): R3F deja de dibujar por su cuenta */
export function PixelPipeline({ size = KIT_PIXEL }: { size?: number }) {
  const gl = useThree((s) => s.gl);
  const pipeline = useRef<Pipeline | null>(null);
  useEffect(() => {
    const p = createPipeline(gl, size);
    pipeline.current = p;
    return () => {
      pipeline.current = null;
      p.dispose();
    };
  }, [gl, size]);
  useFrame((state) => {
    const p = pipeline.current;
    if (p) {
      p.render(state.gl, state.scene, state.camera, state.clock.elapsedTime);
      return;
    }
    state.gl.setRenderTarget(null);
    state.gl.render(state.scene, state.camera);
  }, 1);
  return null;
}
