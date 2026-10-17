import { prepareImageSceneInput } from "./dom-wasm/direct-scene-input.js";
import { SandomHostError } from "./host/contract.js";

const decoder = new TextDecoder();
const properties = ["src", "canvas", "background-image", "mask-image", "border-image-source", "broken-image-icon"];
const IMAGE_JOIN_RECORD_BYTES = 40;
const IMAGE_REQUEST_RECORD_BYTES = 56;

function imageRecordBytes(view, offset, end, usage) {
  const size = usage ? IMAGE_REQUEST_RECORD_BYTES : IMAGE_JOIN_RECORD_BYTES;
  if (end - offset < size) throw new Error(`Image request has ${end - offset} bytes; requires ${size}`);
  const kind = view.getUint32(offset + 4, true);
  if (kind < 1 || kind > 3) throw new Error(`Unknown native image kind ${kind}`);
  if (usage) {
    const property = view.getUint32(offset + 44, true);
    const required = view.getUint32(offset + 52, true);
    if (property >= properties.length) throw new Error(`Unknown native image property ${property}`);
    if (required !== 0 && required !== kind) throw new Error(`Image kind ${kind} has invalid decode operation ${required}`);
  }
  return size;
}

// The native registry owns request state, cache joins, indices and reclamation.
// This binding retains external effects: fetch/decode promises, pixels and Errors.
export function createImageResourceBinding({ core, ensureScope, pixels, decode, decodeIcon, failureCode }) {
  const pending = new Map();
  const decoded = new Map();
  const failures = new Map();
  let nextFailure = 1;

  function readInfo(view, offset) {
    const pointer = view.getUint32(offset + 8, true);
    const length = view.getUint32(offset + 12, true);
    return {
      identity: view.getUint32(offset, true),
      kind: view.getUint32(offset + 4, true),
      source: decoder.decode(new Uint8Array(core.memory.buffer, pointer, length)),
      resourceIdentifier: view.getUint32(offset + 16, true),
      imageIndex: view.getUint32(offset + 20, true),
      failure: view.getUint32(offset + 24, true),
      errorHandle: view.getUint32(offset + 28, true),
      resourceHandle: view.getBigUint64(offset + 32, true),
    };
  }
  function info(identity) {
    core.status("image_join_info", identity);
    const view = new DataView(core.memory.buffer);
    const pointer = core.exports.abi_output_pointer();
    imageRecordBytes(view, pointer, pointer + core.exports.abi_output_length(), false);
    return readInfo(view, pointer);
  }
  function requests(nodes) {
    const count = prepareImageSceneInput(core, nodes, ensureScope());
    const pointer = core.exports.abi_output_pointer();
    const view = new DataView(core.memory.buffer);
    const end = pointer + core.exports.abi_output_length();
    const output = new Array(count);
    let offset = pointer;
    for (let index = 0; index < count; index++) {
      const size = imageRecordBytes(view, offset, end, true);
      output[index] = { ...readInfo(view, offset), node: view.getUint32(offset + 40, true),
        property: view.getUint32(offset + 44, true), layer: view.getUint32(offset + 48, true),
        requiredDecode: view.getUint32(offset + 52, true) };
      offset += size;
    }
    if (offset !== end) throw new Error(`Image request table has ${end - offset} unconsumed bytes`);
    return output;
  }
  function releasePixels() {
    const count = core.status("image_join_released");
    const view = new DataView(core.memory.buffer, core.exports.abi_output_pointer(), count * 4);
    for (let index = 0; index < count; index++) pixels.delete(view.getUint32(index * 4, true));
  }
  function commit(identity, entry) {
    const index = core.status("image_join_commit", identity, entry.width, entry.height,
      entry.naturalWidth ?? entry.width, entry.naturalHeight ?? entry.height,
      entry.defaultSized ? 1 : 0, entry.naturalRatio ?? 0);
    releasePixels();
    pixels.set(index, entry);
    return index;
  }
  function fail(identity, broken) {
    const handle = nextFailure++;
    failures.set(handle, broken);
    core.status("image_join_fail", identity, failureCode(broken), handle);
  }
  function decodedEntry(resource, cacheKey) {
    let effect = decoded.get(cacheKey);
    if (effect === undefined) {
      effect = decode(resource, cacheKey);
      decoded.set(cacheKey, effect);
      effect.catch(() => { if (decoded.get(cacheKey) === effect) decoded.delete(cacheKey); });
    }
    return effect;
  }
  async function load(request, resolveResource) {
    let resource;
    try {
      if (!resolveResource) throw new SandomHostError("missing-host-capability",
        `Image ${request.source} has no document resource loader to demand it through`,
        { details: { capability: "resource" } });
      resource = await resolveResource({ requestedURL: request.source, kind: "image" });
    } catch (cause) {
      return { broken: { failure: "fetch", error: new Error(
        `Image ${request.source}: resource resolution failed: ${cause.message ?? String(cause)}`, { cause }) } };
    }
    if (!(resource?.bytes instanceof Uint8Array)) throw new TypeError("Image resolver must return Uint8Array bytes");
    const cacheKey = resource.cacheKey ?? resource.finalURL ?? request.source;
    const required = core.status("image_join_source", request.identity, ...core.input(cacheKey));
    if (!required) return { cacheKey };
    const entry = await decodedEntry(resource, cacheKey);
    return entry.failure === undefined ? { cacheKey, entry } : { cacheKey, broken: entry };
  }
  function start(request, resolveResource) {
    if (request.requiredDecode !== 1 || pending.has(request.identity)) return;
    // Keep a rejection as an effect outcome until ordered consumption observes it.
    const effect = load(request, resolveResource).then(value => ({ value }), error => ({ error }));
    pending.set(request.identity, effect);
  }
  function canvas(request, sources) {
    const source = sources.get(request.resourceIdentifier) ?? sources.get(request.source);
    if (!source) throw new Error(`Missing canvas image source ${request.resourceIdentifier} (${request.source})`);
    core.status("image_join_source", request.identity, ...core.input(request.source));
    return commit(request.identity, source);
  }
  function copyResolution(output, nodes, request, index) {
    const row = output[request.node] === nodes[request.node] ? { ...nodes[request.node] } : output[request.node];
    if (request.property === 0 || request.property === 1 || request.property === 5) {
      row.imageIndex = index;
    } else if (request.property === 2 || request.property === 3) {
      const sourceName = request.property === 2 ? "backgroundImages" : "masks";
      const targetName = request.property === 2 ? "resolvedBackgroundImages" : "resolvedMasks";
      if (!Object.hasOwn(row, targetName) || row[targetName] === nodes[request.node][targetName]) {
        row[targetName] = nodes[request.node][sourceName].slice();
      }
      row[targetName][request.layer] = { ...nodes[request.node][sourceName][request.layer], imageIndex: index };
    } else if (request.property === 4) {
      row.resolvedBorderImage = { ...nodes[request.node].borderImage, imageIndex: index };
    } else {
      throw new Error(`Unknown native image property ${request.property}`);
    }
    output[request.node] = row;
  }
  function report(request, nodes, onError) {
    const current = info(request.identity);
    if (!current.failure) {
      if (current.imageIndex === 65535) return undefined;
      if (!pixels.has(current.imageIndex)) throw new Error(`Image request ${request.identity}: native index ${current.imageIndex} has no host pixels`);
      return current.imageIndex;
    }
    const broken = failures.get(current.errorHandle);
    if (!broken) throw new Error(`Image request ${request.identity} has no host error for handle ${current.errorHandle}`);
    if (!onError) throw broken.error;
    onError({ node: nodes[request.node], property: properties[request.property], requestedURL: request.source,
      failure: broken.failure, error: broken.error });
    return undefined;
  }
  async function prepareImages(nodes, resolveResource, sources = new Map(), onError = null) {
    const rows = requests(nodes);
    if (!rows.length) return nodes;
    for (const request of rows) start(request, resolveResource);
    const output = nodes.slice();
    for (const request of rows) {
      if (request.requiredDecode === 2) {
        copyResolution(output, nodes, request, canvas(request, sources));
        continue;
      }
      if (request.requiredDecode === 3) {
        if (core.status("image_join_source", request.identity, ...core.input(request.source))) {
          commit(request.identity, await decodeIcon());
        }
      } else if (request.requiredDecode === 1) {
        const effect = pending.get(request.identity);
        if (effect !== undefined) {
          const outcome = await effect;
          if (pending.get(request.identity) === effect) pending.delete(request.identity);
          if (Object.hasOwn(outcome, "error")) throw outcome.error;
          const loaded = outcome.value;
          if (loaded.cacheKey !== undefined) {
            core.status("image_join_source", request.identity, ...core.input(loaded.cacheKey));
          }
          const current = info(request.identity);
          if (current.imageIndex === 65535 && !current.failure) {
            if (loaded.broken) fail(request.identity, loaded.broken);
            else if (loaded.entry) commit(request.identity, loaded.entry);
          }
          if (loaded.cacheKey !== undefined) decoded.delete(loaded.cacheKey);
        }
      } else if (request.requiredDecode !== 0) {
        throw new Error(`Unknown native image decode operation ${request.requiredDecode}`);
      }
      copyResolution(output, nodes, request, report(request, nodes, onError));
    }
    return output;
  }
  function prepareImagesSync(nodes, sources = new Map()) {
    const rows = requests(nodes);
    if (!rows.length) return nodes;
    const output = nodes.slice();
    for (const request of rows) {
      const index = request.requiredDecode === 2 ? canvas(request, sources)
        : request.imageIndex === 65535 ? undefined : request.imageIndex;
      if (request.requiredDecode === 3) throw new Error("The broken image icon requires an asynchronous render before synchronous layout");
      copyResolution(output, nodes, request, index);
    }
    return output;
  }
  function registerDecodedImage(resourceHandle, resource) {
    const source = resource.cacheKey ?? resource.finalURL;
    const identity = core.status("image_join_open", ensureScope(), core.resourceId(resourceHandle), ...core.input(source), 1);
    if (info(identity).imageIndex !== 65535) return null;
    const required = core.status("image_join_source", identity, ...core.input(source));
    if (!required) return null;
    return decodedEntry(resource, source).then(entry => {
      if (entry.failure === undefined) commit(identity, entry);
      else fail(identity, entry);
      decoded.delete(source);
    });
  }
  function canvasImageEntry(resource) {
    const source = resource.cacheKey ?? resource.finalURL;
    const index = core.status("image_join_cache", ensureScope(), ...core.input(source));
    if (index !== 65535) {
      const entry = pixels.get(index);
      if (!entry) throw new Error(`Image ${source}: native index ${index} has no host pixels`);
      return Promise.resolve(entry);
    }
    return decodedEntry(resource, source).then(entry => entry.failure === undefined ? entry : null);
  }
  return { prepareImages, prepareImagesSync, registerDecodedImage, canvasImageEntry, releasePixels };
}
