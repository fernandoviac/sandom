// CSS Font Loading 3: FontFace and the FontFaceSet of document.fonts. Each
// added FontFace is one @font-face rule in its own constructed sheet, which
// the core cascades after the document's adopted sheets
// (core/dom/font-face-set.watpart). The core composes and checks the rule
// text, and font-face-rules.watpart loads the face as it loads any
// @font-face rule, so an added face answers its family as a rule does. This
// module converts the Web IDL arguments, holds the faces and their sheets,
// and settles each face's promise when the core reports its state.
import { sharedDomCore } from "../dom-wasm/core.js";
import { layoutConstant } from "../wasm/layout-table.js";

const FONT_FACE_UNLOADED = layoutConstant("FONT_FACE_UNLOADED");
const FONT_FACE_PENDING = layoutConstant("FONT_FACE_PENDING");
const FONT_FACE_LOADED = layoutConstant("FONT_FACE_LOADED");
const FONT_FACE_FAILED = layoutConstant("FONT_FACE_FAILED");

// FontFaceDescriptors (CSS Font Loading 3, 2.1), in the order of the
// core's rule text, with their defaults.
const DESCRIPTORS = [
  ["style", "normal"],
  ["weight", "normal"],
  ["stretch", "normal"],
  ["unicodeRange", "U+0-10FFFF"],
  ["featureSettings", "normal"],
  ["display", "auto"],
];
// The @font-face descriptor of each FontFaceDescriptors member.
const DESCRIPTOR_PROPERTIES = ["font-style", "font-weight", "font-stretch", "unicode-range", "font-feature-settings", "font-display"];
// Descriptors that the face's rule does not carry: a value other than the
// default throws, so a face never drops a descriptor.
const UNCARRIED_DESCRIPTORS = [
  ["variationSettings", "normal"],
  ["ascentOverride", "normal"],
  ["descentOverride", "normal"],
  ["lineGapOverride", "normal"],
];
const faceState = new WeakMap();

// The state of a face: its values, its rule once a set holds it, its status
// and its loaded promise.
function faceStateRecord(family, values) {
  let resolveLoaded;
  let rejectLoaded;
  const loaded = new Promise((resolve, reject) => {
    resolveLoaded = resolve;
    rejectLoaded = reject;
  });
  // A rejection that nobody observes is not an unhandled one: a face that
  // fails reports through status and loaded.
  loaded.catch(() => {});
  return {
    family,
    values,
    ruleText: null,
    rule: null,
    cssConnected: false,
    status: "unloaded",
    loaded,
    resolveLoaded,
    rejectLoaded,
    sets: new Set(),
  };
}
// The blob URL of a binary source lives as long as its face.
const blobURLs = new FinalizationRegistry((url) => URL.revokeObjectURL(url));

function bufferBytes(source) {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  }
  return null;
}

export class FontFace {
  constructor(family, source, descriptors = {}) {
    if (arguments.length < 2) {
      throw new TypeError(`Failed to construct 'FontFace': 2 arguments required, but only ${arguments.length} present.`);
    }
    const values = Object.fromEntries(DESCRIPTORS.map(([name, initial]) => [
      name,
      descriptors?.[name] === undefined ? initial : String(descriptors[name]),
    ]));
    for (const [name, initial] of UNCARRIED_DESCRIPTORS) {
      if (descriptors?.[name] !== undefined && String(descriptors[name]) !== initial) {
        throw new DOMException(
          `Failed to construct 'FontFace': the ${name} descriptor ${JSON.stringify(String(descriptors[name]))} is not supported by Sandom; omit it or give "${initial}".`,
          "NotSupportedError",
        );
      }
    }
    // A binary source is a blob URL that the face's rule names.
    const bytes = bufferBytes(source);
    const sourceIsURL = bytes !== null;
    const sourceText = sourceIsURL ? URL.createObjectURL(new Blob([bytes])) : String(source);
    const state = faceStateRecord(String(family), values);
    faceState.set(this, state);
    if (sourceIsURL) blobURLs.register(this, sourceText);
    try {
      state.ruleText = sharedDomCore.string(
        "font_face_rule_text",
        ...sharedDomCore.input(state.family),
        ...sharedDomCore.input(sourceText),
        sourceIsURL ? 1 : 0,
        ...DESCRIPTORS.flatMap(([name]) => sharedDomCore.input(values[name])),
      );
    } catch (error) {
      state.status = "error";
      state.rejectLoaded(error);
    }
  }
  get family() {
    return faceState.get(this).family;
  }
  get style() {
    return faceState.get(this).values.style;
  }
  get weight() {
    return faceState.get(this).values.weight;
  }
  get stretch() {
    return faceState.get(this).values.stretch;
  }
  get unicodeRange() {
    return faceState.get(this).values.unicodeRange;
  }
  get featureSettings() {
    return faceState.get(this).values.featureSettings;
  }
  get display() {
    return faceState.get(this).values.display;
  }
  get status() {
    return faceState.get(this).status;
  }
  get loaded() {
    return faceState.get(this).loaded;
  }
  // Loads the face through a document whose FontFaceSet holds it. A face in
  // no set has no document to fetch through, so the load rejects.
  load() {
    const state = faceState.get(this);
    if (state.status !== "unloaded") return state.loaded;
    const [set] = state.sets;
    if (set === undefined) {
      return Promise.reject(new DOMException(
        `The FontFace "${state.family}" is in no FontFaceSet; add it with document.fonts.add(face) before load().`,
        "InvalidStateError",
      ));
    }
    set._startLoad(this);
    return state.loaded;
  }
}

Object.defineProperty(FontFace.prototype, Symbol.toStringTag, { value: "FontFace", configurable: true });

// The FontFaceSet of a document's style system. `system` gives the
// reconciliation of the font rules and each rule's resource.
export function createFontFaceSet({ document, core, fontPending, system, CSSStyleSheet }) {
  // Added FontFace → { sheet, rule } in insertion order.
  const faces = new Map();
  // The FontFace of each active @font-face rule, by rule handle.
  const ruleFaces = new Map();
  const statusOf = (rule) => {
    switch (core.status("font_face_state", rule)) {
      case FONT_FACE_PENDING: return "loading";
      case FONT_FACE_LOADED: return "loaded";
      case FONT_FACE_FAILED: return "error";
      case FONT_FACE_UNLOADED: return "unloaded";
    }
  };
  const publishSheets = () => {
    core.setFontFaceSheets(
      document._coreHandle,
      [...faces.values()].filter(({ sheet }) => sheet !== null).map(({ sheet }) => sheet._coreSheetHandle),
    );
    document._invalidateStyles();
    system.reconcileFonts();
  };
  // The faces of the set: one for each active @font-face rule of the
  // document, then the added faces.
  const listed = () => {
    system.reconcileFonts();
    const addedRules = new Set([...faces.values()].map(({ rule }) => rule));
    const current = new Map();
    for (const rule of system.fontRules()) {
      if (addedRules.has(rule)) continue;
      current.set(rule, ruleFaces.get(rule) ?? ruleFace(set, rule, core.ruleDeclarations(rule)));
    }
    ruleFaces.clear();
    for (const [rule, face] of current) ruleFaces.set(rule, face);
    set._settleFaces();
    return [...current.values(), ...faces.keys()];
  };
  const set = {
    get status() {
      return core.status("font_faces_in_state", document._coreHandle, FONT_FACE_PENDING) > 0 ? "loading" : "loaded";
    },
    get ready() {
      return Promise.all([...fontPending]).then(() => this);
    },
    check() {
      return core.status("font_faces_in_state", document._coreHandle, FONT_FACE_PENDING) === 0;
    },
    load() {
      return this.ready.then(() => []);
    },
    get size() {
      return listed().length;
    },
    add(face) {
      if (!(face instanceof FontFace)) {
        throw new TypeError("Failed to execute 'add' on 'FontFaceSet': parameter 1 is not of type 'FontFace'.");
      }
      if (faces.has(face) || faceState.get(face).cssConnected) return this;
      const state = faceState.get(face);
      state.sets.add(this);
      if (state.ruleText === null) {
        // A face whose descriptors do not parse joins no cascade.
        faces.set(face, { sheet: null, rule: null });
        return this;
      }
      const sheet = new CSSStyleSheet({ baseURL: document.baseURI, document });
      core.status("stylesheet_replace", sheet._coreSheetHandle, ...core.input(state.ruleText), 1);
      state.rule = sheet._ruleList()[0]._coreRuleHandle;
      faces.set(face, { sheet, rule: state.rule });
      publishSheets();
      this._settleFaces();
      return this;
    },
    delete(face) {
      if (face instanceof FontFace && faceState.get(face).cssConnected) {
        throw new DOMException(
          "Failed to execute 'delete' on 'FontFaceSet': the face belongs to an @font-face rule; remove the rule instead.",
          "InvalidModificationError",
        );
      }
      const entry = faces.get(face);
      if (entry === undefined) return false;
      faces.delete(face);
      faceState.get(face).sets.delete(this);
      if (entry.sheet !== null) publishSheets();
      return true;
    },
    has(face) {
      return listed().includes(face);
    },
    // Removes the added faces; the faces of @font-face rules stay.
    clear() {
      for (const face of faces.keys()) faceState.get(face).sets.delete(this);
      faces.clear();
      publishSheets();
    },
    forEach(callback, thisArgument = undefined) {
      for (const face of listed()) callback.call(thisArgument, face, face, this);
    },
    keys() {
      return listed()[Symbol.iterator]();
    },
    values() {
      return listed()[Symbol.iterator]();
    },
    entries() {
      return listed().map((face) => [face, face])[Symbol.iterator]();
    },
    [Symbol.iterator]() {
      return listed()[Symbol.iterator]();
    },
    // Starts the load of a face whose rule waits for its unicode-range.
    _startLoad(face) {
      const { rule } = faceState.get(face);
      system.reconcileFonts();
      system.fontResource(rule)?.load?.().catch(() => {});
      this._settleFaces();
    },
    // Reads the core state of each face and settles its loaded promise
    // once it is loaded or failed. The style system calls it at each
    // change of a face's state.
    _settleFaces() {
      for (const face of [...ruleFaces.values(), ...faces.keys()]) {
        const state = faceState.get(face);
        if (state.rule === null || state.status === "loaded" || state.status === "error") continue;
        state.status = statusOf(state.rule);
        if (state.status === "loaded") state.resolveLoaded(face);
        if (state.status === "error") {
          state.rejectLoaded(system.fontResource(state.rule)?.error ??
            new DOMException(`The font face "${state.family}" failed to load.`, "NetworkError"));
        }
      }
    },
  };
  return set;
}

// The CSS-connected FontFace of @font-face rule `rule` with `declarations`
// ([{ property, value }]) in `set`.
function ruleFace(set, rule, declarations) {
  const value = (property, initial) =>
    declarations.findLast((declaration) => declaration.property.toLowerCase() === property)?.value ?? initial;
  const face = Object.create(FontFace.prototype);
  const state = faceStateRecord(
    value("font-family", ""),
    Object.fromEntries(DESCRIPTORS.map(([name, initial], index) => [name, value(DESCRIPTOR_PROPERTIES[index], initial)])),
  );
  Object.assign(state, { rule, cssConnected: true });
  state.sets.add(set);
  faceState.set(face, state);
  return face;
}
