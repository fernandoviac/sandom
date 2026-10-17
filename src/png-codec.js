import { readPackageAsset } from './package-assets.js';
import { PNG_ABI as ABI } from './png-abi.js';

// Sandom's binding for the @sandom/png module. The package ships the module
// and its ABI record; the library import map resolves it (a sibling checkout
// locally, the reviewed library set or the installed npm package otherwise).
const PNG_CODEC_WASM = '@sandom/png/png-codec.wasm';

export class PngCodecError extends Error {
  constructor(status, domain, field, offset) {
    const name = Object.keys(ABI.status).find((key) => ABI.status[key] === status) ?? 'internalFailure';
    const chunk = domain === 1 ? String.fromCharCode(field >>> 24, (field >>> 16) & 255, (field >>> 8) & 255, field & 255) : field;
    super(`PNG ${name}: ${chunk} at ${offset}`);
    this.name = 'PngCodecError'; this.code = name; this.status = status;
    this.domain = domain; this.field = chunk; this.offset = offset;
  }
}

export function createPngCodec({ getPngBytes = null } = {}) {
  let loading, ready;
  async function load() {
    loading ??= (async () => {
      const bytes = getPngBytes ? await getPngBytes() : await readPackageAsset(new URL(import.meta.resolve(PNG_CODEC_WASM)));
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const e = instance.exports;
      if (!(e.memory instanceof WebAssembly.Memory) || e.png_version?.() !== ABI.version || e.png_record_bytes?.() !== ABI.recordBytes) {
        throw new PngCodecError(ABI.status.abiMismatch, 0, 0, 0);
      }
      try { e.png_initialize(); } catch (cause) {
        throw new Error('PNG codec initialization failed before publishing any results', { cause });
      }
      ready = e;
      return e;
    })();
    return await loading;
  }
  // Handles are closure-private and owner-branded; numbers never cross runtimes.
  const owner = Symbol('PNG instance');
  function checked(e, value) {
    if (value) return value;
    const ptr = e.png_error();
    const words = new Uint32Array(e.memory.buffer, ptr, 4);
    throw new PngCodecError(...words);
  }
  function handle(e, id) { return { owner, id: checked(e, id), live: true }; }
  function id(h) {
    if (h?.owner !== owner || !h.live) throw new PngCodecError(ABI.status.invalidHandle, 0, 0, 0);
    return h.id;
  }
  function release(e, h) { if (h) { checked(e, e.png_release(id(h))); h.live = false; } }
  function allocate(e, bytes) {
    const h = handle(e, e.png_alloc(bytes.byteLength));
    try {
      const ptr = checked(e, e.png_ptr(id(h)));
      new Uint8Array(e.memory.buffer, ptr, bytes.byteLength).set(bytes);
      return h;
    } catch (error) { release(e, h); throw error; }
  }
  function result(e, h) {
    const ptr = checked(e, e.png_ptr(id(h)));
    const length = e.png_len(id(h));
    const view = new DataView(e.memory.buffer, ptr, ABI.recordBytes);
    const get = (name) => view.getUint32(ABI.fields[name], true);
    if (get('version') !== ABI.version) throw new PngCodecError(ABI.status.abiMismatch, 0, 0, 0);
    function copy(offsetName, lengthName) {
      const offset = get(offsetName), count = get(lengthName);
      if (!count) return new Uint8Array(0);
      if (offset < ptr + ABI.recordBytes || offset + count > ptr + length) throw new PngCodecError(ABI.status.abiMismatch, 0, 0, offset);
      return new Uint8Array(e.memory.buffer, offset, count).slice();
    }
    return { get, view, copy };
  }
  function encodingRequest(pixels, width, height, options) {
    if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray || pixels instanceof Uint16Array || pixels instanceof Float32Array)) throw new TypeError('PNG pixels must be uint8, uint16, or float32');
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) throw new TypeError('PNG dimensions must be positive integers');
    if (pixels.byteLength > ABI.limits.decodedBytes) throw new PngCodecError(ABI.status.resourceLimit, 0, 0, 0);
    const level = options.compressionLevel ?? 6;
    if (!Number.isInteger(level) || level < 0 || level > 9) throw new TypeError('PNG compressionLevel must be an integer 0..9 (advisory)');
    if (options.profile && (!(options.profile instanceof Uint8Array) || options.profile.byteLength > ABI.limits.profileBytes)) throw new TypeError('Invalid PNG profile bytes');
    const channelLayout = options.channelLayout ?? 'rgba';
    if (channelLayout !== 'rgba' && channelLayout !== 'rgb') throw new TypeError('PNG channelLayout must be "rgba" or "rgb"');
    return { pixels, width, height, options, level, channelLayout };
  }
  function encodeReady({ pixels, width, height, options, level, channelLayout }) {
    if (!ready) throw new Error('PNG codec: initialize() must complete before synchronous encoding');
    const e = ready;
    const channels = channelLayout === 'rgb' ? 3 : 4;
    let input, request, profile, output;
    try {
      input = allocate(e, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
      if (options.profile) profile = allocate(e, options.profile);
      const record = new Uint8Array(ABI.recordBytes); const view = new DataView(record.buffer);
      const set = (name, value) => view.setUint32(ABI.fields[name], value, true);
      const setFloat = (name, value) => view.setFloat64(ABI.fields[name], value, true);
      set('version', ABI.version); set('width', width); set('height', height);
      set('rowStride', options.rowStride ?? width * channels * pixels.BYTES_PER_ELEMENT);
      set('sampleType', pixels instanceof Float32Array ? ABI.enums.sampleType.indexOf('float32') : pixels instanceof Uint16Array ? ABI.enums.sampleType.indexOf('uint16') : ABI.enums.sampleType.indexOf('uint8'));
      set('bitsPerSample', options.bitDepth ?? 8); set('channelLayout', ABI.enums.channelLayout.indexOf(channelLayout)); set('alphaMode', ABI.enums.alphaMode.indexOf(channelLayout === 'rgb' ? 'opaque' : 'straight'));
      set('pixelHandle', id(input)); set('pixelLength', pixels.byteLength);
      set('profileHandle', profile ? id(profile) : 0); set('profileLength', options.profile?.byteLength ?? 0);
      set('mode', options.colorEncoding ? 1 : 0); set('compressionLevel', level);
      if (options.colorEncoding) { set('primaries', ABI.enums.primaries.indexOf(options.colorEncoding.primaries)); set('transfer', ABI.enums.transfer.indexOf(options.colorEncoding.transferFunction)); }
      let flags = 0;
      if (options.masteringDisplay != null) { flags |= ABI.flags.masteringDisplay; setFloat('masteringMaxLow', options.masteringDisplay.maxLuminance); setFloat('masteringMinLow', options.masteringDisplay.minLuminance); }
      if (options.contentLightLevel != null) { flags |= ABI.flags.contentLightLevel; setFloat('contentMaxLow', options.contentLightLevel.maxContentLightLevel); setFloat('frameAverageLow', options.contentLightLevel.maxFrameAverageLightLevel); }
      set('flags', flags); request = allocate(e, record);
      output = handle(e, e.png_encode(id(request)));
      return result(e, output).copy('pixelOffset', 'pixelLength');
    } finally { release(e, output); release(e, request); release(e, profile); release(e, input); }
  }
  return Object.freeze({
    async initialize() { await load(); },
    async decode(bytes) {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('decodePNG requires Uint8Array bytes');
      if (bytes.byteLength > ABI.limits.inputBytes) throw new PngCodecError(ABI.status.resourceLimit, 0, 0, 0);
      // Cold initialization crosses an await: snapshot caller-owned input first.
      // Warm operations stay synchronous through the single module copy.
      if (!ready) bytes = bytes.slice();
      const e = ready ?? await load(); let input, output;
      try {
        input = allocate(e, bytes); output = handle(e, e.png_decode(id(input)));
        const { get, view, copy } = result(e, output);
        const storage = copy('pixelOffset', 'pixelLength');
        const profile = copy('profileOffset', 'profileLength');
        const flags = get('flags');
        const sampleType = ABI.enums.sampleType[get('sampleType')];
        const metadata = {};
        if (flags & ABI.flags.assumedSrgb) metadata.codecState = { assumedSrgb: true };
        if (flags & ABI.flags.assumedSrgbTransfer) metadata.codecState = { assumedSrgbTransfer: true };
        if (flags & ABI.flags.iccProfile) metadata.iccProfile = profile;
        if (flags & ABI.flags.codedColorVolume) metadata.codedColorVolume = { primariesCode: get('primariesCode'), transferCode: get('transferCode') };
        if (flags & ABI.flags.masteringDisplay) metadata.masteringDisplayColorVolume = Object.fromEntries(['redX', 'redY', 'greenX', 'greenY', 'blueX', 'blueY', 'whiteX', 'whiteY', 'maximumLuminance', 'minimumLuminance'].map((key) => [key, get(key)]));
        if (flags & ABI.flags.contentLightLevel) metadata.contentLightLevel = { maximumContentLightLevel: get('maximumContentLightLevel'), maximumFrameAverageLightLevel: get('maximumFrameAverageLightLevel') };
        const transferFunction = ABI.enums.transfer[get('transfer')];
        return {
          width: get('width'), height: get('height'), rowStride: get('rowStride'),
          sampleType, bitsPerSample: get('bitsPerSample'), channelLayout: ABI.enums.channelLayout[get('channelLayout')], alphaMode: ABI.enums.alphaMode[get('alphaMode')],
          pixels: sampleType === 'uint16' ? new Uint16Array(storage.buffer) : storage,
          colorEncoding: { primaries: ABI.enums.primaries[get('primaries')], transferFunction,
            transferFunctionParameters: transferFunction === 'gamma' ? view.getFloat64(ABI.fields.gammaLow, true) : null,
            whitePoint: ABI.enums.whitePoint[get('whitePoint')], referenceWhiteLuminance: 203,
            profile: transferFunction === 'icc' ? profile : null }, metadata,
        };
      } finally { release(e, output); release(e, input); }
    },
    async encode(pixels, width, height, options = {}) {
      const request = encodingRequest(pixels, width, height, options);
      if (!ready) {
        request.pixels = pixels.slice();
        request.options = { ...options, profile: options.profile?.slice(),
          colorEncoding: options.colorEncoding && { ...options.colorEncoding },
          masteringDisplay: options.masteringDisplay && { ...options.masteringDisplay },
          contentLightLevel: options.contentLightLevel && { ...options.contentLightLevel } };
        await load();
      }
      return encodeReady(request);
    },
    encodeWithCompletion(pixels, width, height, options, operation) {
      let bytes;
      try { bytes = encodeReady(encodingRequest(pixels, width, height, options)); }
      catch (error) { operation.throw(error); return; }
      operation.reply(bytes);
    },
  });
}

export const defaultPngCodec = createPngCodec();
