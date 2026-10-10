// GPU rasterizer of the Canvas 2D bitmap (plans/PLAN-canvas-2d.md,
// "Decisions"; docs/specifications/canvas-2d.md, "Bitmap storage and
// color" and "Time of rasterization").
//
// The bitmap is one rgba8unorm texture with premultiplied alpha. A flush
// draws the recorded commands of src/wasm/canvas-2d.wat into it, in call
// order, in one render pass for each target and one submission. Each draw
// blends into the 8-bit texture with the fixed-function blender, so the
// result is quantized after every draw, as Chrome's canvas is. Measured on
// the pinned Chrome (2026-10-10): source-over of a fill is
// round((s * sa + d * (255 - sa)) / 255) with the color alpha quantized to
// eight bits and globalAlpha not quantized; drawImage quantizes globalAlpha
// to eight bits; putImageData premultiplies as round(c * a / 255). The
// blender produces exactly these bytes.
//
// The command records are the instance data: the WGSL struct Command is the
// record layout of canvas-2d.wat, uploaded with no repacking.
//
// Coverage of a rectangle is clamp(0.5 - d, 0, 1) for the distance d of
// the pixel center outside the farthest transformed edge, and, outside two
// adjacent edges, clamp(0.5 - (max + (sqrt(2) - 1) * min), 0, 1) of the two
// distances (measured on Chrome). This equals Chrome for every
// pixel-aligned edge; a fractional or rotated edge can differ by one, which
// slice 3 measures (plans/PLAN-canvas-2d.md, slice 2 status).

const COMMAND_SIZE = 80;
const KIND_FILL = 1;
const KIND_STROKE = 2;
const KIND_CLEAR = 3;
const KIND_PUT = 4;
const KIND_IMAGE = 5;

export const BITMAP_FORMAT = "rgba8unorm";

const SHADER = /* wgsl */ `
struct Command {
  kind: u32,
  index: u32,
  color: u32,
  alpha: f32,
  rect: vec4f,
  m0: vec4f,
  m1: vec4f,
  source: vec4f,
}

struct Bitmap {
  size: vec2f,
  padding: vec2f,
}

@group(0) @binding(0) var<uniform> bitmap: Bitmap;
@group(0) @binding(1) var<storage, read> commands: array<Command>;
@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var imageSampler: sampler;

const STROKE: u32 = ${KIND_STROKE}u;
const PUT: u32 = ${KIND_PUT}u;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) command: u32,
}

fn mapPoint(c: Command, p: vec2f) -> vec2f {
  return vec2f(c.m0.x * p.x + c.m0.z * p.y + c.m1.x, c.m0.y * p.x + c.m0.w * p.y + c.m1.y);
}

// Left, top, right and bottom of the user-space rectangle that the command covers.
fn coveredRect(c: Command) -> vec4f {
  var r = vec4f(c.rect.xy, c.rect.xy + c.rect.zw);
  if (c.kind == STROKE) {
    let halfWidth = c.m1.z * 0.5;
    r = r + vec4f(-halfWidth, -halfWidth, halfWidth, halfWidth);
  }
  return r;
}

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Varyings {
  let c = commands[instance];
  var low: vec2f;
  var high: vec2f;
  if (c.kind == PUT) {
    low = c.rect.xy;
    high = c.rect.xy + c.rect.zw;
  } else {
    let r = coveredRect(c);
    let p0 = mapPoint(c, r.xy);
    let p1 = mapPoint(c, r.zy);
    let p2 = mapPoint(c, r.zw);
    let p3 = mapPoint(c, r.xw);
    low = floor(min(min(p0, p1), min(p2, p3))) - vec2f(1.0);
    high = ceil(max(max(p0, p1), max(p2, p3))) + vec2f(1.0);
  }
  low = clamp(low, vec2f(0.0), bitmap.size);
  high = clamp(high, vec2f(0.0), bitmap.size);
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let point = mix(low, high, corners[vertex]);
  var output: Varyings;
  output.position = vec4f(point.x / bitmap.size.x * 2.0 - 1.0, 1.0 - point.y / bitmap.size.y * 2.0, 0.0, 1.0);
  output.command = instance;
  return output;
}

// The distance from the pixel center to the outside of an edge (positive
// outside the rectangle).
fn outsideDistance(p: vec2f, a: vec2f, b: vec2f, orientation: f32) -> f32 {
  let edge = b - a;
  return -orientation * (edge.x * (p.y - a.y) - edge.y * (p.x - a.x)) / length(edge);
}

// A pixel center outside two adjacent edges takes the coverage of its
// distance to the corner, approximated as max + (sqrt(2) - 1) * min of the
// two edge distances, as Chrome's rectangle coverage measures.
fn cornerCoverage(first: f32, second: f32) -> f32 {
  if (first <= 0.0 || second <= 0.0) {
    return 1.0;
  }
  return clamp(0.5 - (max(first, second) + 0.41421356 * min(first, second)), 0.0, 1.0);
}

fn rectCoverage(c: Command, r: vec4f, p: vec2f) -> f32 {
  let q0 = mapPoint(c, r.xy);
  let q1 = mapPoint(c, r.zy);
  let q2 = mapPoint(c, r.zw);
  let q3 = mapPoint(c, r.xw);
  let area = (q1.x - q0.x) * (q3.y - q0.y) - (q1.y - q0.y) * (q3.x - q0.x);
  let orientation = select(-1.0, 1.0, area > 0.0);
  let d0 = outsideDistance(p, q0, q1, orientation);
  let d1 = outsideDistance(p, q1, q2, orientation);
  let d2 = outsideDistance(p, q2, q3, orientation);
  let d3 = outsideDistance(p, q3, q0, orientation);
  let edges = clamp(0.5 - max(max(d0, d1), max(d2, d3)), 0.0, 1.0);
  let corners = min(
    min(cornerCoverage(d0, d1), cornerCoverage(d1, d2)),
    min(cornerCoverage(d2, d3), cornerCoverage(d3, d0)),
  );
  return min(edges, corners);
}

@fragment
fn fillFragment(input: Varyings) -> @location(0) vec4f {
  let c = commands[input.command];
  let p = input.position.xy;
  let r = vec4f(c.rect.xy, c.rect.xy + c.rect.zw);
  var coverage: f32;
  if (c.kind == STROKE) {
    let halfWidth = c.m1.z * 0.5;
    coverage = rectCoverage(c, r + vec4f(-halfWidth, -halfWidth, halfWidth, halfWidth), p) -
      rectCoverage(c, r + vec4f(halfWidth, halfWidth, -halfWidth, -halfWidth), p);
  } else {
    coverage = rectCoverage(c, r, p);
  }
  if (coverage <= 0.0) {
    discard;
  }
  let alpha = c.alpha * coverage;
  let color = unpack4x8unorm(c.color);
  return vec4f(color.rgb * alpha, alpha);
}

@fragment
fn clearFragment(input: Varyings) -> @location(0) vec4f {
  let c = commands[input.command];
  let coverage = rectCoverage(c, vec4f(c.rect.xy, c.rect.xy + c.rect.zw), input.position.xy);
  if (coverage <= 0.0) {
    discard;
  }
  return vec4f(0.0, 0.0, 0.0, coverage);
}

// putImageData: the payload holds unpremultiplied bytes; premultiply and
// replace the destination.
@fragment
fn putFragment(input: Varyings) -> @location(0) vec4f {
  let c = commands[input.command];
  let texel = textureLoad(image, vec2i(input.position.xy - c.rect.xy), 0);
  return vec4f(texel.rgb * texel.a, texel.a);
}

@fragment
fn imageFragment(input: Varyings) -> @location(0) vec4f {
  let c = commands[input.command];
  let p = input.position.xy;
  let coverage = rectCoverage(c, vec4f(c.rect.xy, c.rect.xy + c.rect.zw), p);
  if (coverage <= 0.0) {
    discard;
  }
  let determinant = c.m0.x * c.m0.w - c.m0.y * c.m0.z;
  let offset = p - c.m1.xy;
  let user = vec2f(c.m0.w * offset.x - c.m0.z * offset.y, c.m0.x * offset.y - c.m0.y * offset.x) / determinant;
  let sourcePoint = c.source.xy + (user - c.rect.xy) * (c.source.zw / c.rect.zw);
  let sampled = textureSampleLevel(image, imageSampler, sourcePoint / vec2f(textureDimensions(image)), 0.0);
  return sampled * (c.alpha * coverage);
}
`;

const SOURCE_OVER = Object.freeze({
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
});
const CLEAR_TRANSPARENT = Object.freeze({
  color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
});
// An opaque bitmap clears to opaque black and keeps alpha at one.
const CLEAR_OPAQUE = Object.freeze({
  color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" },
});

const deviceResources = new WeakMap();

function resourcesFor(device) {
  let resources = deviceResources.get(device);
  if (resources) return resources;
  const module = device.createShaderModule({ label: "Sandom Canvas 2D", code: SHADER });
  const commandLayout = device.createBindGroupLayout({
    label: "Sandom Canvas 2D commands",
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
    ],
  });
  const imageLayout = device.createBindGroupLayout({
    label: "Sandom Canvas 2D image",
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
  const commandOnly = device.createPipelineLayout({ bindGroupLayouts: [commandLayout] });
  const withImage = device.createPipelineLayout({ bindGroupLayouts: [commandLayout, imageLayout] });
  const pipeline = (label, layout, entryPoint, blend) =>
    device.createRenderPipeline({
      label: `Sandom Canvas 2D ${label}`,
      layout,
      vertex: { module, entryPoint: "vertexMain" },
      fragment: {
        module,
        entryPoint,
        targets: [{ format: BITMAP_FORMAT, ...(blend ? { blend } : {}) }],
      },
      primitive: { topology: "triangle-list" },
    });
  resources = {
    commandLayout,
    imageLayout,
    fill: pipeline("fill", commandOnly, "fillFragment", SOURCE_OVER),
    clearTransparent: pipeline("clear", commandOnly, "clearFragment", CLEAR_TRANSPARENT),
    clearOpaque: pipeline("clear opaque", commandOnly, "clearFragment", CLEAR_OPAQUE),
    put: pipeline("put image data", withImage, "putFragment", null),
    image: pipeline("draw image", withImage, "imageFragment", SOURCE_OVER),
    sampler: device.createSampler({
      label: "Sandom Canvas 2D image sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    }),
  };
  deviceResources.set(device, resources);
  return resources;
}

export function createBitmapTexture(device, width, height, label) {
  return device.createTexture({
    label,
    size: { width, height },
    format: BITMAP_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
  });
}

// A GPU copy of a bitmap, for a drawImage() that reads this state later.
export function copyBitmapTexture(device, texture, width, height, label) {
  const copy = createBitmapTexture(device, width, height, label);
  const encoder = device.createCommandEncoder({ label });
  encoder.copyTextureToTexture({ texture }, { texture: copy }, { width, height });
  device.queue.submit([encoder.finish()]);
  return copy;
}

function sourceTexture(device, source, prepared) {
  if (source.kind === "commands") return prepared.get(source);
  if (source.device !== device) {
    throw new Error(
      "Canvas 2D drawImage source bitmap is on another GPUDevice than the destination canvas",
    );
  }
  return source.texture;
}

// Draws `list` into `target` on `device`, with one submission.
//
// list: { bytes, sources, payloads } where `bytes` holds `bytes.length / 80`
// command records; `sources[index]` is the drawImage source of an image
// command, either { kind: "texture", device, texture } or
// { kind: "commands", list, width, height, opaque } for a canvas that had no
// bitmap when it was drawn; `payloads[index]` is the putImageData region
// { width, height, bytes }.
// target: { texture, width, height, opaque }; `clear` starts the target
// from the blank bitmap.
export function rasterizeCommands(device, target, list, clear) {
  const resources = resourcesFor(device);
  const prepared = new Map();
  const jobs = [];
  const transient = [];
  const prepare = (commandList) => {
    for (const source of commandList.sources) {
      if (source === undefined || source.kind !== "commands" || prepared.has(source)) continue;
      prepare(source.list);
      const texture = createBitmapTexture(
        device,
        source.width,
        source.height,
        "Sandom Canvas 2D drawImage source",
      );
      transient.push(texture);
      prepared.set(source, texture);
      jobs.push({
        target: { texture, width: source.width, height: source.height, opaque: source.opaque },
        list: source.list,
        clear: true,
      });
    }
  };
  prepare(list);
  jobs.push({ target, list, clear });
  let commandBytes = 0;
  for (const job of jobs) {
    job.firstInstance = commandBytes / COMMAND_SIZE;
    commandBytes += job.list.bytes.length;
  }
  const commandBuffer = device.createBuffer({
    label: "Sandom Canvas 2D commands",
    size: Math.max(commandBytes, COMMAND_SIZE),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  transient.push(commandBuffer);
  for (const job of jobs) {
    if (job.list.bytes.length > 0) {
      device.queue.writeBuffer(commandBuffer, job.firstInstance * COMMAND_SIZE, job.list.bytes);
    }
  }
  const encoder = device.createCommandEncoder({ label: "Sandom Canvas 2D flush" });
  for (const job of jobs) {
    encodeTarget(device, resources, encoder, commandBuffer, job, prepared, transient);
  }
  device.queue.submit([encoder.finish()]);
  // Destruction waits for the submitted work that uses these resources.
  for (const resource of transient) resource.destroy();
}

function encodeTarget(device, resources, encoder, commandBuffer, job, prepared, transient) {
  const { target, list } = job;
  const uniform = device.createBuffer({
    label: "Sandom Canvas 2D target",
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  transient.push(uniform);
  device.queue.writeBuffer(uniform, 0, new Float32Array([target.width, target.height, 0, 0]));
  const commandGroup = device.createBindGroup({
    layout: resources.commandLayout,
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: commandBuffer } },
    ],
  });
  const pass = encoder.beginRenderPass({
    label: "Sandom Canvas 2D bitmap",
    colorAttachments: [{
      view: target.texture.createView(),
      loadOp: job.clear ? "clear" : "load",
      clearValue: target.opaque ? { r: 0, g: 0, b: 0, a: 1 } : { r: 0, g: 0, b: 0, a: 0 },
      storeOp: "store",
    }],
  });
  pass.setBindGroup(0, commandGroup);
  const view = new DataView(list.bytes.buffer, list.bytes.byteOffset, list.bytes.byteLength);
  const count = list.bytes.length / COMMAND_SIZE;
  let runStart = 0;
  let runKey = null;
  let runPipeline = null;
  let runImage = null;
  const endRun = (end) => {
    if (runKey === null) return;
    pass.setPipeline(runPipeline);
    if (runImage !== null) pass.setBindGroup(1, runImage);
    pass.draw(6, end - runStart, 0, job.firstInstance + runStart);
  };
  for (let index = 0; index < count; index++) {
    const kind = view.getUint32(index * COMMAND_SIZE, true);
    const reference = view.getUint32(index * COMMAND_SIZE + 4, true);
    let key;
    if (kind === KIND_FILL || kind === KIND_STROKE) key = "fill";
    else if (kind === KIND_CLEAR) key = "clear";
    else if (kind === KIND_IMAGE) key = `image ${reference}`;
    else if (kind === KIND_PUT) key = `put ${index}`;
    else throw new Error(`Canvas 2D command ${index} has the unknown kind ${kind}`);
    if (key === runKey) continue;
    endRun(index);
    runStart = index;
    runKey = key;
    runImage = null;
    if (key === "fill") {
      runPipeline = resources.fill;
    } else if (key === "clear") {
      runPipeline = target.opaque ? resources.clearOpaque : resources.clearTransparent;
    } else if (kind === KIND_IMAGE) {
      runPipeline = resources.image;
      runImage = device.createBindGroup({
        layout: resources.imageLayout,
        entries: [
          { binding: 0, resource: sourceTexture(device, list.sources[reference], prepared).createView() },
          { binding: 1, resource: resources.sampler },
        ],
      });
    } else {
      const payload = list.payloads[reference];
      const upload = device.createTexture({
        label: "Sandom Canvas 2D putImageData",
        size: { width: payload.width, height: payload.height },
        format: BITMAP_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      transient.push(upload);
      device.queue.writeTexture(
        { texture: upload },
        payload.bytes,
        { bytesPerRow: payload.width * 4 },
        { width: payload.width, height: payload.height },
      );
      runPipeline = resources.put;
      runImage = device.createBindGroup({
        layout: resources.imageLayout,
        entries: [
          { binding: 0, resource: upload.createView() },
          { binding: 1, resource: resources.sampler },
        ],
      });
    }
  }
  endRun(count);
  pass.end();
}

// Copies the bitmap into a mappable buffer and returns its premultiplied
// bytes, tightly packed. The only reader is toBlob(), which is asynchronous.
export async function readBitmapTexture(device, texture, width, height) {
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = device.createBuffer({
    label: "Sandom Canvas 2D toBlob",
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder({ label: "Sandom Canvas 2D toBlob" });
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      pixels.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
    }
    buffer.unmap();
    return pixels;
  } finally {
    buffer.destroy();
  }
}
