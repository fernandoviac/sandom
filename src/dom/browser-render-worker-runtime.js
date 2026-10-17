import { DocumentSession } from "./document-session.js";
import { prepareRenderInput } from "./render-animation.js";
import { createSuppliedResourceHost } from "../host/supplied-resource-host.js";
import {
  BROWSER_RENDER_ERROR_KIND,
  BROWSER_RENDER_PROTOCOL_VERSION,
  BROWSER_RENDER_READY_KIND,
  BROWSER_RENDER_REQUEST_KIND,
  BROWSER_RENDER_RESULT_KIND,
} from "./browser-render-worker-protocol.js";

export function serializeBrowserWorkerError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    stack: error?.stack ?? null,
    details: error?.details ?? null,
    errors: error instanceof AggregateError
      ? error.errors.map((entry) => serializeBrowserWorkerError(entry))
      : undefined,
  };
}

export async function prepareBrowserRenderInput(message) {
  if (
    message.input === null || typeof message.input !== "object" ||
    typeof message.input.name !== "string" || message.input.name.length === 0 ||
    !(message.input.bytes instanceof Uint8Array)
  ) {
    throw new TypeError(
      "Browser render request input requires a name and Uint8Array bytes",
    );
  }
  const baseURL = new URL(
    encodeURIComponent(message.input.name),
    "https://sandom.invalid/upload/",
  );
  const resources = new Map();
  for (const resource of message.resources ?? []) {
    if (
      resource === null || typeof resource !== "object" ||
      typeof resource.url !== "string" ||
      !(resource.bytes instanceof Uint8Array)
    ) {
      throw new TypeError(
        "Each browser render resource requires a URL and Uint8Array bytes",
      );
    }
    const resourceURL = new URL(resource.url, baseURL).href;
    if (resources.has(resourceURL)) {
      throw new TypeError(`Duplicate browser render resource ${resourceURL}`);
    }
    resources.set(resourceURL, {
      bytes: resource.bytes,
      mediaType: resource.contentType ?? null,
    });
  }
  // The transferred resources are the complete resource set: the worker
  // reads nothing else.
  return await prepareRenderInput(
    { url: baseURL, bytes: message.input.bytes },
    {
      preprocessor: message.input.preprocessor,
      host: createSuppliedResourceHost({ resources }),
    },
  );
}

export async function renderBrowserWorkerRequest(message) {
  if (message?.kind !== BROWSER_RENDER_REQUEST_KIND) {
    throw new TypeError(`Expected ${BROWSER_RENDER_REQUEST_KIND}`);
  }
  if (message.version !== BROWSER_RENDER_PROTOCOL_VERSION) {
    throw new RangeError(
      `Unsupported browser render request version ${
        JSON.stringify(message.version)
      }`,
    );
  }
  if (
    typeof message.identifier !== "string" || message.identifier.length === 0
  ) {
    throw new TypeError("Browser render request requires an identifier");
  }
  const preparedInput = await prepareBrowserRenderInput(message);
  const session = new DocumentSession(preparedInput);
  try {
    const plan = await session.plan(message.request ?? {});
    const rendered = await session.renderOnce(plan);
    return Object.freeze({
      kind: BROWSER_RENDER_RESULT_KIND,
      version: BROWSER_RENDER_PROTOCOL_VERSION,
      identifier: message.identifier,
      output: Object.freeze({
        bytes: rendered.bytes,
        format: rendered.format,
        mediaType: plan.output.mediaType,
        extension: plan.output.extension,
        width: rendered.width,
        height: rendered.height,
        frameCount: rendered.frameCount,
        durationMilliseconds: rendered.durationMilliseconds,
        loopCount: plan.output.format === "gif"
          ? plan.capture.repetition.kind === "infinite"
            ? 0
            : plan.capture.repetition.count
          : undefined,
      }),
      plan,
      resources: rendered.resources,
      diagnostics: rendered.diagnostics,
    });
  } finally {
    await session.dispose();
  }
}

export function installBrowserRenderWorker(target = globalThis) {
  if (typeof target.postMessage !== "function") {
    throw new TypeError("Browser render worker target requires postMessage()");
  }
  target.onmessage = async (event) => {
    const identifier = typeof event.data?.identifier === "string"
      ? event.data.identifier
      : null;
    try {
      const result = await renderBrowserWorkerRequest(event.data);
      target.postMessage(result, [result.output.bytes.buffer]);
    } catch (error) {
      target.postMessage({
        kind: BROWSER_RENDER_ERROR_KIND,
        version: BROWSER_RENDER_PROTOCOL_VERSION,
        identifier,
        error: serializeBrowserWorkerError(error),
      });
    }
  };
  target.postMessage({
    kind: BROWSER_RENDER_READY_KIND,
    version: BROWSER_RENDER_PROTOCOL_VERSION,
  });
}
