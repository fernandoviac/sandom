import { prepareImageSceneInput } from "./dom-wasm/direct-scene-input.js";
import {
  ImageJoinInfoSize,
  ImageRequestSize,
  readImageJoinInfo,
  readImageRequest,
} from "./dom-wasm/record-readers.generated.js";
import { layoutConstant } from "./wasm/layout-table.js";
import { SandomHostError } from "./host/contract.js";

const decoder = new TextDecoder();
const PROPERTY = Object.fromEntries(["SRC", "CANVAS", "BACKGROUND", "MASK", "BORDER", "ICON", "COUNT"]
  .map((name) => [name, layoutConstant(`IMAGE_PROPERTY_${name}`)]));
const IMAGE_INDEX_NONE = layoutConstant("IMAGE_INDEX_NONE");
const IMAGE_KIND_ENCODED = layoutConstant("IMAGE_KIND_ENCODED");
const IMAGE_KIND_CANVAS = layoutConstant("IMAGE_KIND_CANVAS");
const IMAGE_KIND_ICON = layoutConstant("IMAGE_KIND_ICON");
const IMAGE_KINDS = new Set([IMAGE_KIND_ENCODED, IMAGE_KIND_CANVAS, IMAGE_KIND_ICON]);

function checkImageRecord(record, usage) {
  if (!IMAGE_KINDS.has(record.kind)) throw new Error(`Unknown native image kind ${record.kind}`);
  if (usage) {
    if (record.property >= PROPERTY.COUNT) throw new Error(`Unknown native image property ${record.property}`);
    if (record.requiredDecode !== 0 && record.requiredDecode !== record.kind) {
      throw new Error(`Image kind ${record.kind} has invalid decode operation ${record.requiredDecode}`);
    }
  }
  return record;
}

// The native registry owns request state, cache joins, indices and reclamation.
// This binding retains external effects: fetch/decode promises, pixels and Errors.
export function createImageResourceBinding({ core, ensureScope, pixels, decode, decodeIcon, failureCode }) {
  const pending = new Map();
  const decoded = new Map();
  const failures = new Map();
  let nextFailure = 1;

  // The record with its source URL, which `memory` (the reads of the output
  // that holds the record) names.
  function withSource(record, memory) {
    record.source = memory.memoryText(decoder, record.sourcePointer, record.sourceLength);
    return record;
  }
  function info(identity) {
    core.status("image_join_info", identity);
    const output = core.output("image_join_info");
    const available = output.byteLength;
    if (available < ImageJoinInfoSize) throw new Error(`Image request has ${available} bytes; requires ${ImageJoinInfoSize}`);
    return withSource(checkImageRecord(readImageJoinInfo(output, 0), false), output);
  }
  function requests(nodes) {
    const count = prepareImageSceneInput(core, nodes, ensureScope());
    const table = core.output("image_requests_prepare");
    const end = table.byteLength;
    const output = new Array(count);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      if (end - offset < ImageRequestSize) throw new Error(`Image request has ${end - offset} bytes; requires ${ImageRequestSize}`);
      output[index] = withSource(checkImageRecord(readImageRequest(table, offset), true), table);
      offset += ImageRequestSize;
    }
    if (offset !== end) throw new Error(`Image request table has ${end - offset} unconsumed bytes`);
    return output;
  }
  function releasePixels() {
    const count = core.status("image_join_released");
    const view = count === 0 ? null : core.output("image_join_released");
    for (let index = 0; index < count; index++) pixels.delete(view.getUint32(index * Uint32Array.BYTES_PER_ELEMENT, true));
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
      // The request modifiers of the url() that named the image (CSS
      // Values 5 §4.1.1) set the fields of its demand.
      const settings = request.resourceIdentifier
        ? core.resourceRequest(core.resourceById(request.resourceIdentifier))
        : {};
      resource = await resolveResource({ requestedURL: request.source, kind: "image", ...settings });
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
    if (request.requiredDecode !== IMAGE_KIND_ENCODED || pending.has(request.identity)) return;
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
    if (request.property === PROPERTY.SRC || request.property === PROPERTY.CANVAS || request.property === PROPERTY.ICON) {
      row.imageIndex = index;
    } else if (request.property === PROPERTY.BACKGROUND || request.property === PROPERTY.MASK) {
      const sourceName = request.property === PROPERTY.BACKGROUND ? "backgroundImages" : "masks";
      const targetName = request.property === PROPERTY.BACKGROUND ? "resolvedBackgroundImages" : "resolvedMasks";
      if (!Object.hasOwn(row, targetName) || row[targetName] === nodes[request.node][targetName]) {
        row[targetName] = nodes[request.node][sourceName].slice();
      }
      row[targetName][request.layer] = { ...nodes[request.node][sourceName][request.layer], imageIndex: index };
    } else if (request.property === PROPERTY.BORDER) {
      row.resolvedBorderImage = { ...nodes[request.node].borderImage, imageIndex: index };
    } else {
      throw new Error(`Unknown native image property ${request.property}`);
    }
    output[request.node] = row;
  }
  function report(request, nodes, onError) {
    const current = info(request.identity);
    if (!current.failure) {
      if (current.imageIndex === IMAGE_INDEX_NONE) return undefined;
      if (!pixels.has(current.imageIndex)) throw new Error(`Image request ${request.identity}: native index ${current.imageIndex} has no host pixels`);
      return current.imageIndex;
    }
    const broken = failures.get(current.errorHandle);
    if (!broken) throw new Error(`Image request ${request.identity} has no host error for handle ${current.errorHandle}`);
    if (!onError) throw broken.error;
    onError({ node: nodes[request.node], property: core.string("image_property_name", request.property), requestedURL: request.source,
      failure: broken.failure, error: broken.error });
    return undefined;
  }
  async function prepareImages(nodes, resolveResource, sources = new Map(), onError = null) {
    const rows = requests(nodes);
    if (!rows.length) return nodes;
    for (const request of rows) start(request, resolveResource);
    const output = nodes.slice();
    for (const request of rows) {
      if (request.requiredDecode === IMAGE_KIND_CANVAS) {
        copyResolution(output, nodes, request, canvas(request, sources));
        continue;
      }
      if (request.requiredDecode === IMAGE_KIND_ICON) {
        if (core.status("image_join_source", request.identity, ...core.input(request.source))) {
          commit(request.identity, await decodeIcon());
        }
      } else if (request.requiredDecode === IMAGE_KIND_ENCODED) {
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
          if (current.imageIndex === IMAGE_INDEX_NONE && !current.failure) {
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
  // A synchronous layout takes each image as decoded so far: an image the
  // host has not decoded yet, the broken image icon included, has no index
  // and the next asynchronous render decodes it. The icon box has a fixed
  // 16 by 16 size (engine-record.watpart $engineImageFallbackBox), so its
  // layout needs no pixels.
  function prepareImagesSync(nodes, sources = new Map()) {
    const rows = requests(nodes);
    if (!rows.length) return nodes;
    const output = nodes.slice();
    for (const request of rows) {
      const index = request.requiredDecode === IMAGE_KIND_CANVAS ? canvas(request, sources)
        : request.imageIndex === IMAGE_INDEX_NONE ? undefined : request.imageIndex;
      copyResolution(output, nodes, request, index);
    }
    return output;
  }
  function registerDecodedImage(resourceHandle, resource) {
    const source = resource.cacheKey ?? resource.finalURL;
    const identity = core.status("image_join_open", ensureScope(), core.resourceId(resourceHandle), ...core.input(source), IMAGE_KIND_ENCODED);
    if (info(identity).imageIndex !== IMAGE_INDEX_NONE) return null;
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
    if (index !== IMAGE_INDEX_NONE) {
      const entry = pixels.get(index);
      if (!entry) throw new Error(`Image ${source}: native index ${index} has no host pixels`);
      return Promise.resolve(entry);
    }
    return decodedEntry(resource, source).then(entry => entry.failure === undefined ? entry : null);
  }
  return { prepareImages, prepareImagesSync, registerDecodedImage, canvasImageEntry, releasePixels };
}
