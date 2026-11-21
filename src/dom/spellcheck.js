// The host's spellchecker, a thin wrapper over core/dom/spellcheck.watpart.
// The core decides which fields to check, when, which answers count and
// where the marks go; this file carries the requests to the host and its
// answers back.
//
// A spellchecker is `{ check(request) }`. The core queues a request for a
// field whose value or language changed; after the frame that queued it,
// `check` receives `{ field, value, language, revision, reply }`. The host
// calls `reply(errors)` once, at any later time, with `{ start, end }`
// UTF-16 offsets of that value in increasing order.
//
// A spellchecker MAY have `suggest(request)`. When a field's context menu
// opens on a misspelled word, `suggest` receives `{ field, word, language,
// revision, reply }`; the host calls `reply(suggestions)` once with an
// array of strings, and the menu shows the first five.

const REQUEST_SIZE = 32;

// Gives `document`'s host spellchecker `checker`, or none for null.
export function setDocumentSpellchecker(document, checker) {
  if (checker !== null && (typeof checker !== "object" || typeof checker.check !== "function")) {
    throw new TypeError(`setSpellchecker: the spellchecker is ${describe(checker)}; expected null or an object with a check(request) method`);
  }
  const core = document._domCore;
  document._spellchecker = checker;
  core.status("spellcheck_host_set", document._coreHandle, checker === null ? 0 : 1);
  for (const surface of document._liveRenderSurfaces ?? []) surface._scheduleAnimationFrame();
}

// Gives the host the requests that the last frame of `document` queued.
export function sendSpellcheckRequests(document) {
  const checker = document._spellchecker;
  if (!checker) return;
  const core = document._domCore;
  if (typeof checker.suggest === "function" && core.status("spellcheck_suggest_take", document._coreHandle) === 1) {
    sendSuggestRequest(core, checker, "spellcheck_suggest_take");
  }
  const count = core.status("spellcheck_requests_take", document._coreHandle);
  if (count === 0) return;
  const output = core.output("spellcheck_requests_take");
  const view = output.memory();
  const text = (at) => view.memoryText(core.decoder, view.getUint32(at, true), view.getUint32(at + 4, true));
  const requests = [];
  for (let index = 0; index < count; index++) {
    const row = output.pointer + index * REQUEST_SIZE;
    requests.push({
      handle: view.getBigUint64(row, true),
      revision: view.getUint32(row + 8, true),
      value: text(row + 12),
      language: text(row + 20),
    });
  }
  for (const { handle, revision, value, language } of requests) {
    const field = core.wrapperFor(handle);
    let answered = false;
    checker.check(Object.freeze({
      field,
      value,
      language,
      revision,
      reply(errors) {
        if (answered) {
          throw new Error(`spellcheck reply: revision ${revision} of the field already has its answer`);
        }
        answered = true;
        reply(core, field, handle, value, revision, errors);
      },
    }));
  }
}

function reply(core, field, handle, value, revision, errors) {
  if (!Array.isArray(errors)) {
    throw new TypeError(`spellcheck reply: errors is ${describe(errors)}; expected an array of { start, end }`);
  }
  const ranges = new Uint32Array(errors.length * 2);
  errors.forEach((error, index) => {
    if (!Number.isInteger(error?.start) || !Number.isInteger(error?.end) || error.start < 0 || error.end < 0) {
      throw new TypeError(`spellcheck reply: error ${index} is ${describe(error)}; expected { start, end } with non-negative integer offsets`);
    }
    ranges[index * 2] = error.start;
    ranges[index * 2 + 1] = error.end;
  });
  const [pointer] = core.byteInput(new Uint8Array(ranges.buffer));
  const result = core.status("spellcheck_reply", handle, revision, pointer, errors.length);
  if (result < 0) {
    const index = -1 - result;
    throw new RangeError(`spellcheck reply: error ${index} is ${describe(errors[index])}; ranges must increase, not overlap, ` +
      `and lie in the value of ${value.length} UTF-16 units`);
  }
  if (result === 1) field._renderSurface?._scheduleAnimationFrame(field);
}

function sendSuggestRequest(core, checker, operation) {
  const output = core.output(operation);
  const pointer = output.pointer;
  const view = output.memory();
  const text = (at) => view.memoryText(core.decoder, view.getUint32(at, true), view.getUint32(at + 4, true));
  const handle = view.getBigUint64(pointer, true);
  const revision = view.getUint32(pointer + 8, true);
  const word = text(pointer + 12);
  const language = text(pointer + 20);
  const field = core.wrapperFor(handle);
  let answered = false;
  checker.suggest(Object.freeze({
    field,
    word,
    language,
    revision,
    reply(suggestions) {
      if (answered) throw new Error(`spellcheck suggest reply: revision ${revision} already has its answer`);
      if (!Array.isArray(suggestions) || suggestions.some((entry) => typeof entry !== "string")) {
        throw new TypeError(`spellcheck suggest reply: suggestions is ${describe(suggestions)}; expected an array of strings`);
      }
      answered = true;
      const encoded = suggestions.map((entry) => core.encoder.encode(entry));
      const block = new Uint8Array(encoded.reduce((sum, entry) => sum + 4 + entry.byteLength, 0));
      const blockView = new DataView(block.buffer);
      let at = 0;
      for (const entry of encoded) {
        blockView.setUint32(at, entry.byteLength, true);
        block.set(entry, at + 4);
        at += 4 + entry.byteLength;
      }
      const [blockPointer] = core.byteInput(block);
      const result = core.status("spellcheck_suggestions_set", handle, revision, blockPointer, block.byteLength, suggestions.length);
      if (result === 1) field._renderSurface?._scheduleAnimationFrame(field);
    },
  }));
}

function describe(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
