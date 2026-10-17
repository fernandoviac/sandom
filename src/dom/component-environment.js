import { getDefaultGpu } from "../gpu-thread.js";
import { isGpuThreadCapability } from "./webgpu-facade.js";

const environmentState = new WeakMap();
const locationEnvironment = new WeakMap();
const historyEnvironment = new WeakMap();
const navigatorEnvironment = new WeakMap();
const screenEnvironment = new WeakMap();
const orientationEnvironment = new WeakMap();
const constructorToken = Symbol("component platform constructor");

const environmentOptionNames = new Set([
  "navigation",
  "language",
  "languages",
  "online",
  "hardwareConcurrency",
  "maximumTouchPoints",
  "screen",
  "fetch",
  "createWebSocket",
  "gpu",
  "userAgent",
  "platform",
  "webdriver",
]);

const orientationTypes = new Set([
  "landscape-primary",
  "landscape-secondary",
  "portrait-primary",
  "portrait-secondary",
]);

const scrollRestorationValues = new Set(["auto", "manual"]);
const landscapePrimaryOrientation = Object.freeze({
  type: "landscape-primary",
  angle: 0,
});
const portraitPrimaryOrientation = Object.freeze({
  type: "portrait-primary",
  angle: 0,
});

function integerCapability(value, name, minimum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return number;
}

function positiveGeometry(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return number;
}


function runtimePlatform(target) {
  if (target.Deno?.build) {
    return `Deno ${target.Deno.build.os} ${target.Deno.build.arch}`;
  }
  if (target.process?.platform) {
    return `Node ${target.process.platform} ${target.process.arch}`;
  }
  if (target.Bun?.version) return "Bun";
  return "Sandom host runtime";
}

function runtimeUserAgent(target) {
  if (target.Deno?.version?.deno) {
    return `Sandom/1.0 Deno/${target.Deno.version.deno}`;
  }
  if (target.process?.versions?.node) {
    return `Sandom/1.0 Node/${target.process.versions.node}`;
  }
  if (target.Bun?.version) return `Sandom/1.0 Bun/${target.Bun.version}`;
  return "Sandom/1.0";
}

function normalizeScreen(screen) {
  if (screen === undefined) return null;
  if (!screen || typeof screen !== "object" || Array.isArray(screen)) {
    throw new TypeError("environment.screen must be an object");
  }
  const allowed = new Set([
    "width",
    "height",
    "availWidth",
    "availHeight",
    "colorDepth",
    "pixelDepth",
    "orientation",
  ]);
  for (const key of Reflect.ownKeys(screen)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`Unknown environment.screen option ${String(key)}`);
    }
  }
  if (screen.width === undefined || screen.height === undefined) {
    throw new TypeError("environment.screen width and height must be supplied together");
  }
  const width = positiveGeometry(screen.width, "environment.screen.width");
  const height = positiveGeometry(screen.height, "environment.screen.height");
  const availWidth = positiveGeometry(
    screen.availWidth ?? width,
    "environment.screen.availWidth",
  );
  const availHeight = positiveGeometry(
    screen.availHeight ?? height,
    "environment.screen.availHeight",
  );
  if (availWidth > width || availHeight > height) {
    throw new RangeError("environment.screen available geometry cannot exceed its total geometry");
  }
  const colorDepth = integerCapability(
    screen.colorDepth ?? 24,
    "environment.screen.colorDepth",
    1,
  );
  const pixelDepth = integerCapability(
    screen.pixelDepth ?? colorDepth,
    "environment.screen.pixelDepth",
    1,
  );
  let orientation = null;
  if (screen.orientation !== undefined) {
    if (
      !screen.orientation || typeof screen.orientation !== "object" ||
      Array.isArray(screen.orientation)
    ) {
      throw new TypeError("environment.screen.orientation must be an object");
    }
    for (const key of Reflect.ownKeys(screen.orientation)) {
      if (typeof key !== "string" || !["type", "angle"].includes(key)) {
        throw new TypeError(`Unknown environment.screen.orientation option ${String(key)}`);
      }
    }
    if (!orientationTypes.has(screen.orientation.type)) {
      throw new RangeError(`Unknown screen orientation type ${JSON.stringify(screen.orientation.type)}`);
    }
    const angle = Number(screen.orientation.angle);
    if (![0, 90, 180, 270].includes(angle)) {
      throw new RangeError("environment.screen.orientation.angle must be 0, 90, 180, or 270");
    }
    orientation = Object.freeze({ type: screen.orientation.type, angle });
  }
  return Object.freeze({
    width,
    height,
    availWidth,
    availHeight,
    colorDepth,
    pixelDepth,
    orientation,
  });
}

export function normalizeComponentEnvironmentOptions(value, target = globalThis) {
  if (value === undefined) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("renderComponent environment must be an object");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !environmentOptionNames.has(key)) {
      throw new TypeError(`Unknown renderComponent environment option ${String(key)}`);
    }
  }
  for (const name of ["navigation", "fetch", "createWebSocket"]) {
    if (value[name] !== undefined && typeof value[name] !== "function") {
      throw new TypeError(`environment.${name} must be a function`);
    }
  }
  for (const name of ["language", "userAgent", "platform"]) {
    if (value[name] !== undefined && (typeof value[name] !== "string" || value[name].length === 0)) {
      throw new TypeError(`environment.${name} must be a nonempty string`);
    }
  }
  if (value.languages !== undefined) {
    if (
      !Array.isArray(value.languages) || value.languages.length === 0 ||
      value.languages.some((language) => typeof language !== "string" || language.length === 0)
    ) {
      throw new TypeError("environment.languages must be a nonempty array of nonempty strings");
    }
  }
  for (const name of ["online", "webdriver"]) {
    if (value[name] !== undefined && typeof value[name] !== "boolean") {
      throw new TypeError(`environment.${name} must be a boolean`);
    }
  }
  if (
    value.gpu !== undefined && value.gpu !== null &&
    !isGpuThreadCapability(value.gpu)
  ) {
    throw new TypeError("environment.gpu must be a GPU-thread facade or null; supply native devices through a GPU-thread provider module");
  }
  const language = value.language ?? value.languages?.[0] ?? "en";
  const languages = Object.freeze([...(value.languages ?? [language])]);
  if (languages[0] !== language) {
    throw new TypeError("environment.language must equal the first environment.languages value");
  }
  const sources = Object.freeze(Object.fromEntries(
    [...environmentOptionNames].map((name) => [
      name,
      value[name] !== undefined ? "caller" : "default",
    ]),
  ));
  return Object.freeze({
    navigation: value.navigation ?? null,
    language,
    languages,
    online: value.online ?? false,
    hardwareConcurrency: integerCapability(
      value.hardwareConcurrency ?? 1,
      "environment.hardwareConcurrency",
      1,
    ),
    maximumTouchPoints: integerCapability(
      value.maximumTouchPoints ?? 0,
      "environment.maximumTouchPoints",
      0,
    ),
    screen: normalizeScreen(value.screen),
    fetch: value.fetch ?? null,
    createWebSocket: value.createWebSocket ?? null,
    // Undefined selects the realm's capability when a component first uses
    // it (the environment's gpu getter), so a component that never touches
    // WebGPU does not start a GPU thread.
    gpu: value.gpu,
    userAgent: value.userAgent ?? runtimeUserAgent(target),
    platform: value.platform ?? runtimePlatform(target),
    webdriver: value.webdriver ?? false,
    sources,
  });
}

function stateFor(environment) {
  const state = environmentState.get(environment);
  if (!state) throw new TypeError("Invalid component environment");
  return state;
}

function assertActive(environment, owner, propertyName) {
  const state = stateFor(environment);
  if (state.disposed) {
    environment.observe(owner, propertyName, "default", true);
    throw new DOMException("The component environment is disposed", "InvalidStateError");
  }
  return state;
}

function sourceFor(environment, name) {
  return environment.options.sources[name];
}

function currentHref(environment) {
  return stateFor(environment).currentURL.href;
}

function updateDocumentURL(environment) {
  const href = currentHref(environment);
  environment.document.URL = href;
  environment.document.documentURI = href;
}

function cloneState(environment, value) {
  const clone = environment.target.structuredClone ?? globalThis.structuredClone;
  if (typeof clone !== "function") {
    throw new DOMException(
      "History state requires the selected realm's structuredClone capability",
      "NotSupportedError",
    );
  }
  return clone(value);
}

function cloneHistoryState(environment, value, operation, requestedURL) {
  try {
    return cloneState(environment, value);
  } catch (error) {
    environment.observe("History", operation, "default", true, {
      requestedURL: requestedURL.href,
      missingHandler: error.name === "NotSupportedError"
        ? "structuredClone"
        : null,
    });
    throw error;
  }
}

function sameDocumentExceptHash(left, right) {
  const normalizedLeft = new URL(left.href);
  const normalizedRight = new URL(right.href);
  normalizedLeft.hash = "";
  normalizedRight.hash = "";
  return normalizedLeft.href === normalizedRight.href;
}

const popStateEventState = new WeakMap();
const hashChangeEventState = new WeakMap();

export class PopStateEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    popStateEventState.set(this, init.state ?? null);
  }
  get state() {
    return popStateEventState.get(this);
  }
}

export class HashChangeEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    hashChangeEventState.set(this, Object.freeze({
      oldURL: String(init.oldURL ?? ""),
      newURL: String(init.newURL ?? ""),
    }));
  }
  get oldURL() {
    return hashChangeEventState.get(this)?.oldURL ?? "";
  }
  get newURL() {
    return hashChangeEventState.get(this)?.newURL ?? "";
  }
}

function dispatchHashChange(environment, oldURL, newURL) {
  environment.target.dispatchEvent(new HashChangeEvent("hashchange", {
    oldURL,
    newURL,
  }));
}

function dispatchPopState(environment, state) {
  environment.target.dispatchEvent(new PopStateEvent("popstate", { state }));
}

function replaceHistoryEntry(environment, url, state) {
  const internal = stateFor(environment);
  internal.entries[internal.entryIndex] = { url: new URL(url.href), state };
  internal.currentURL = new URL(url.href);
  updateDocumentURL(environment);
}

function pushHistoryEntry(environment, url, state) {
  const internal = stateFor(environment);
  internal.entries.splice(internal.entryIndex + 1);
  internal.entries.push({ url: new URL(url.href), state });
  internal.entryIndex = internal.entries.length - 1;
  internal.currentURL = new URL(url.href);
  updateDocumentURL(environment);
}

function requestNavigation(environment, kind, requestedURL) {
  const internal = assertActive(environment, "Location", kind);
  const oldURL = internal.currentURL.href;
  const nextURL = new URL(requestedURL, oldURL);
  // A javascript: URL evaluates in the document realm instead of
  // navigating (HTML, "evaluate a javascript: URL").
  if (nextURL.protocol === "javascript:") {
    environment.document._scriptProcessing?.queueJavaScriptURL(nextURL.href);
    return;
  }
  if (kind !== "reload" && nextURL.href === oldURL) return;
  if (kind !== "reload" && sameDocumentExceptHash(internal.currentURL, nextURL)) {
    if (kind === "replace") replaceHistoryEntry(environment, nextURL, null);
    else pushHistoryEntry(environment, nextURL, null);
    dispatchHashChange(environment, oldURL, nextURL.href);
    environment.observe("Location", kind, "default", false);
    return;
  }
  if (!environment.navigation) {
    environment.observe("Location", kind, "default", true, {
      requestedURL: nextURL.href,
      missingHandler: "environment.navigation",
    });
    throw new DOMException(
      `Navigation to ${nextURL.href} requires environment.navigation`,
      "NotSupportedError",
    );
  }
  const request = Object.freeze({
    kind,
    currentURL: oldURL,
    requestedURL: nextURL.href,
  });
  let accepted;
  try {
    accepted = environment.navigation(request);
  } catch (error) {
    environment.observe("Location", kind, "caller", true, {
      requestedURL: nextURL.href,
      missingHandler: null,
    });
    throw error;
  }
  if (
    typeof accepted !== "string" &&
    !(accepted instanceof URL)
  ) {
    environment.observe("Location", kind, "caller", true, {
      requestedURL: nextURL.href,
      missingHandler: null,
    });
    throw new TypeError(
      `environment.navigation must return the accepted URL for ${nextURL.href}`,
    );
  }
  let finalURL;
  try {
    finalURL = new URL(accepted, oldURL);
  } catch (error) {
    environment.observe("Location", kind, "caller", true, {
      requestedURL: nextURL.href,
      missingHandler: null,
    });
    throw new TypeError(`environment.navigation returned an invalid URL for ${nextURL.href}`, {
      cause: error,
    });
  }
  if (kind !== "reload") {
    if (kind === "replace") replaceHistoryEntry(environment, finalURL, null);
    else pushHistoryEntry(environment, finalURL, null);
    if (sameDocumentExceptHash(new URL(oldURL), finalURL) && oldURL !== finalURL.href) {
      dispatchHashChange(environment, oldURL, finalURL.href);
    }
  }
  environment.observe("Location", kind, "caller", false);
}

class ComponentDOMStringList {
  get length() {
    return 0;
  }
  item() {
    return null;
  }
  contains() {
    return false;
  }
  [Symbol.iterator]() {
    return [][Symbol.iterator]();
  }
}

const emptyAncestorOrigins = Object.freeze(new ComponentDOMStringList());
function readLocation(location, name) {
  const environment = locationEnvironment.get(location);
  const internal = assertActive(environment, "Location", name);
  environment.observe("Location", name, "default", false);
  return internal.currentURL[name];
}

function writeLocation(location, name, value) {
  const environment = locationEnvironment.get(location);
  const internal = assertActive(environment, "Location", name);
  const requested = new URL(internal.currentURL.href);
  requested[name] = String(value);
  requestNavigation(environment, "assign", requested);
}

function locationDescriptor(location, name) {
  return {
    configurable: false,
    enumerable: true,
    get: () => readLocation(location, name),
    set: (value) => writeLocation(location, name, value),
  };
}

export class Location {
  constructor(token, environment) {
    if (token !== constructorToken) throw new TypeError("Illegal constructor");
    locationEnvironment.set(this, environment);
    Object.defineProperties(this, {
      href: {
        configurable: false,
        enumerable: true,
        get: () => readLocation(this, "href"),
        set: (value) => this.assign(value),
      },
      origin: {
        configurable: false,
        enumerable: true,
        get: () => readLocation(this, "origin"),
      },
      protocol: locationDescriptor(this, "protocol"),
      host: locationDescriptor(this, "host"),
      hostname: locationDescriptor(this, "hostname"),
      port: locationDescriptor(this, "port"),
      pathname: locationDescriptor(this, "pathname"),
      search: locationDescriptor(this, "search"),
      hash: locationDescriptor(this, "hash"),
      ancestorOrigins: {
        configurable: false,
        enumerable: true,
        get: () => {
          const environment = locationEnvironment.get(this);
          assertActive(environment, "Location", "ancestorOrigins");
          environment.observe("Location", "ancestorOrigins", "default", false);
          return emptyAncestorOrigins;
        },
      },
    });
  }
  assign(url) {
    requestNavigation(locationEnvironment.get(this), "assign", String(url));
  }
  replace(url) {
    requestNavigation(locationEnvironment.get(this), "replace", String(url));
  }
  reload() {
    const environment = locationEnvironment.get(this);
    requestNavigation(environment, "reload", currentHref(environment));
  }
  toString() {
    return this.href;
  }
}

export class History {
  constructor(token, environment) {
    if (token !== constructorToken) throw new TypeError("Illegal constructor");
    historyEnvironment.set(this, environment);
  }
  get length() {
    const environment = historyEnvironment.get(this);
    const internal = assertActive(environment, "History", "length");
    environment.observe("History", "length", "default", false);
    return internal.entries.length;
  }
  get state() {
    const environment = historyEnvironment.get(this);
    const internal = assertActive(environment, "History", "state");
    environment.observe("History", "state", "default", false);
    return internal.entries[internal.entryIndex].state;
  }
  get scrollRestoration() {
    const environment = historyEnvironment.get(this);
    const internal = assertActive(environment, "History", "scrollRestoration");
    environment.observe("History", "scrollRestoration", "default", false);
    return internal.scrollRestoration;
  }
  set scrollRestoration(value) {
    const environment = historyEnvironment.get(this);
    const internal = assertActive(environment, "History", "scrollRestoration");
    const normalized = String(value);
    if (!scrollRestorationValues.has(normalized)) {
      throw new TypeError(`Unknown scrollRestoration value ${JSON.stringify(normalized)}`);
    }
    internal.scrollRestoration = normalized;
    environment.observe("History", "scrollRestoration", "default", false);
  }
  pushState(state, unused, url = undefined) {
    const environment = historyEnvironment.get(this);
    const internal = assertActive(environment, "History", "pushState");
    String(unused);
    const requestedURL = url === undefined
      ? new URL(internal.currentURL.href)
      : new URL(String(url), internal.currentURL.href);
    if (requestedURL.origin !== internal.currentURL.origin) {
      environment.observe("History", "pushState", "default", true, {
        requestedURL: requestedURL.href,
        missingHandler: null,
      });
      throw new DOMException(
        `History URL ${requestedURL.href} is not same-origin with ${internal.currentURL.href}`,
        "SecurityError",
      );
    }
    const cloned = cloneHistoryState(
      environment,
      state,
      "pushState",
      requestedURL,
    );
    pushHistoryEntry(environment, requestedURL, cloned);
    environment.observe("History", "pushState", "default", false);
  }
  replaceState(state, unused, url = undefined) {
    const environment = historyEnvironment.get(this);
    const internal = assertActive(environment, "History", "replaceState");
    String(unused);
    const requestedURL = url === undefined
      ? new URL(internal.currentURL.href)
      : new URL(String(url), internal.currentURL.href);
    if (requestedURL.origin !== internal.currentURL.origin) {
      environment.observe("History", "replaceState", "default", true, {
        requestedURL: requestedURL.href,
        missingHandler: null,
      });
      throw new DOMException(
        `History URL ${requestedURL.href} is not same-origin with ${internal.currentURL.href}`,
        "SecurityError",
      );
    }
    const cloned = cloneHistoryState(
      environment,
      state,
      "replaceState",
      requestedURL,
    );
    replaceHistoryEntry(environment, requestedURL, cloned);
    environment.observe("History", "replaceState", "default", false);
  }
  back() {
    this.go(-1);
  }
  forward() {
    this.go(1);
  }
  go(delta = 0) {
    const environment = historyEnvironment.get(this);
    const internal = assertActive(environment, "History", "go");
    const number = Number(delta);
    const normalized = Number.isFinite(number) ? Math.trunc(number) : 0;
    if (normalized === 0) {
      requestNavigation(environment, "reload", internal.currentURL);
      return;
    }
    const nextIndex = internal.entryIndex + normalized;
    if (nextIndex < 0 || nextIndex >= internal.entries.length) return;
    const oldURL = internal.currentURL.href;
    internal.entryIndex = nextIndex;
    internal.currentURL = new URL(internal.entries[nextIndex].url.href);
    updateDocumentURL(environment);
    const currentEntry = internal.entries[nextIndex];
    dispatchPopState(environment, currentEntry.state);
    if (new URL(oldURL).hash !== internal.currentURL.hash) {
      dispatchHashChange(environment, oldURL, internal.currentURL.href);
    }
    environment.observe("History", "go", "default", false);
  }
}

function readNavigator(navigator, name, optionName) {
  const environment = navigatorEnvironment.get(navigator);
  assertActive(environment, "Navigator", name);
  environment.observe(
    "Navigator",
    name,
    sourceFor(environment, optionName),
    false,
  );
  return environment.options[optionName];
}

export class Navigator {
  constructor(token, environment) {
    if (token !== constructorToken) throw new TypeError("Illegal constructor");
    navigatorEnvironment.set(this, environment);
    Object.freeze(this);
  }
  get userAgent() {
    return readNavigator(this, "userAgent", "userAgent");
  }
  get platform() {
    return readNavigator(this, "platform", "platform");
  }
  get language() {
    return readNavigator(this, "language", "language");
  }
  get languages() {
    return readNavigator(this, "languages", "languages");
  }
  get onLine() {
    return readNavigator(this, "onLine", "online");
  }
  get hardwareConcurrency() {
    return readNavigator(
      this,
      "hardwareConcurrency",
      "hardwareConcurrency",
    );
  }
  get maxTouchPoints() {
    return readNavigator(this, "maxTouchPoints", "maximumTouchPoints");
  }
  get gpu() {
    readNavigator(this, "gpu", "gpu");
    return navigatorEnvironment.get(this).gpu ?? undefined;
  }
  get webdriver() {
    return readNavigator(this, "webdriver", "webdriver");
  }
}

function screenValue(environment, name) {
  const configured = environment.options.screen;
  if (configured) return configured[name];
  if (name === "width" || name === "availWidth") {
    return environment.viewport.width;
  }
  if (name === "height" || name === "availHeight") {
    return environment.viewport.height;
  }
  return 24;
}

function derivedOrientation(environment) {
  const configured = environment.options.screen;
  if (configured?.orientation) return configured.orientation;
  const width = configured?.width ?? environment.viewport.width;
  const height = configured?.height ?? environment.viewport.height;
  return width >= height
    ? landscapePrimaryOrientation
    : portraitPrimaryOrientation;
}

export class ScreenOrientation extends EventTarget {
  constructor(token, environment) {
    if (token !== constructorToken) throw new TypeError("Illegal constructor");
    super();
    orientationEnvironment.set(this, environment);
  }
  get type() {
    const environment = orientationEnvironment.get(this);
    assertActive(environment, "Screen", "orientation.type");
    environment.observe("Screen", "orientation.type", sourceFor(environment, "screen"), false);
    return derivedOrientation(environment).type;
  }
  get angle() {
    const environment = orientationEnvironment.get(this);
    assertActive(environment, "Screen", "orientation.angle");
    environment.observe("Screen", "orientation.angle", sourceFor(environment, "screen"), false);
    return derivedOrientation(environment).angle;
  }
}

function readScreen(screen, name) {
  const environment = screenEnvironment.get(screen);
  assertActive(environment, "Screen", name);
  environment.observe(
    "Screen",
    name,
    sourceFor(environment, "screen"),
    false,
  );
  return screenValue(environment, name);
}

export class Screen {
  constructor(token, environment) {
    if (token !== constructorToken) throw new TypeError("Illegal constructor");
    screenEnvironment.set(this, environment);
    Object.defineProperty(this, "orientation", {
      configurable: false,
      enumerable: true,
      value: new ScreenOrientation(constructorToken, environment),
    });
  }
  get width() {
    return readScreen(this, "width");
  }
  get height() {
    return readScreen(this, "height");
  }
  get availWidth() {
    return readScreen(this, "availWidth");
  }
  get availHeight() {
    return readScreen(this, "availHeight");
  }
  get colorDepth() {
    return readScreen(this, "colorDepth");
  }
  get pixelDepth() {
    return readScreen(this, "pixelDepth");
  }
}
function installInterfaceDescriptors(
  constructor,
  interfaceName,
  memberNames,
  { installToStringTag = true } = {},
) {
  for (const name of memberNames) {
    const descriptor = Object.getOwnPropertyDescriptor(
      constructor.prototype,
      name,
    );
    Object.defineProperty(constructor.prototype, name, {
      ...descriptor,
      enumerable: true,
    });
  }
  if (installToStringTag) {
    Object.defineProperty(constructor.prototype, Symbol.toStringTag, {
      configurable: true,
      value: interfaceName,
    });
  }
}

installInterfaceDescriptors(PopStateEvent, "PopStateEvent", ["state"], {
  installToStringTag: false,
});
installInterfaceDescriptors(HashChangeEvent, "HashChangeEvent", [
  "oldURL",
  "newURL",
], {
  installToStringTag: false,
});
installInterfaceDescriptors(Location, "Location", [
  "assign",
  "replace",
  "reload",
  "toString",
]);
installInterfaceDescriptors(History, "History", [
  "length",
  "state",
  "scrollRestoration",
  "pushState",
  "replaceState",
  "back",
  "forward",
  "go",
]);
installInterfaceDescriptors(Navigator, "Navigator", [
  "userAgent",
  "platform",
  "language",
  "languages",
  "onLine",
  "hardwareConcurrency",
  "gpu",
  "maxTouchPoints",
  "webdriver",
]);
installInterfaceDescriptors(ScreenOrientation, "ScreenOrientation", [
  "type",
  "angle",
]);
installInterfaceDescriptors(Screen, "Screen", [
  "width",
  "height",
  "availWidth",
  "availHeight",
  "colorDepth",
  "pixelDepth",
]);


export function createComponentEnvironment({
  document,
  url,
  viewport,
  target = globalThis,
  options = normalizeComponentEnvironmentOptions(undefined, target),
}) {
  if (!document || typeof document !== "object") {
    throw new TypeError("component environment document must be an object");
  }
  if (!viewport || typeof viewport !== "object") {
    throw new TypeError("component environment viewport must be an object");
  }
  // A data-property viewport is validated eagerly. An accessor-backed
  // viewport (the implicit environment derives width/height from live
  // layout) must not be read at creation time: reading it runs synchronous
  // layout of a document that has never rendered, which the synchronous
  // font/image contract forbids. The accessor producer owns its own
  // positivity guarantee.
  const lazyViewport =
    Object.getOwnPropertyDescriptor(viewport, "width")?.get !== undefined ||
    Object.getOwnPropertyDescriptor(viewport, "height")?.get !== undefined;
  if (!lazyViewport) {
    positiveGeometry(viewport.width, "component environment viewport.width");
    positiveGeometry(viewport.height, "component environment viewport.height");
  }
  const initialURL = new URL(url).href;
  const observations = [];
  // Whether the realm offers WebGPU, read before this environment installs
  // its own navigator and without calling the realm's `gpu` getter.
  const realmOffersGpu = target.navigator != null && "gpu" in target.navigator;
  const environment = {
    document,
    url: initialURL,
    viewport,
    navigation: options.navigation,
    language: options.language,
    languages: options.languages,
    online: options.online,
    hardwareConcurrency: options.hardwareConcurrency,
    maximumTouchPoints: options.maximumTouchPoints,
    screen: options.screen,
    fetch: options.fetch,
    // A realm without WebGPU gives its components none; otherwise they use
    // the GPU-thread facade of that capability.
    get gpu() {
      if (options.gpu !== undefined) return options.gpu;
      return realmOffersGpu ? getDefaultGpu() : null;
    },
    createWebSocket: options.createWebSocket,
    options,
    target,
    observe(owner, propertyName, source, failed, details = {}) {
      const stack = new Error().stack ?? null;
      observations.push(Object.freeze({
        propertyName,
        owner,
        stack,
        source,
        failed,
        ...details,
      }));
    },
    get observations() {
      return Object.freeze([...observations]);
    },
    viewportDidResize() {
      const internal = assertActive(environment, "Screen", "orientation");
      const nextType = derivedOrientation(environment).type;
      if (internal.orientationType === null) {
        internal.orientationType = nextType;
        return;
      }
      if (nextType !== internal.orientationType) {
        internal.orientationType = nextType;
        environment.screenObject.orientation.dispatchEvent(new Event("change"));
      }
    },
    dispose() {
      const internal = stateFor(environment);
      internal.disposed = true;
      if (document._componentEnvironment === environment) {
        document._componentEnvironment = null;
      }
    },
  };
  const internal = {
    currentURL: new URL(initialURL),
    entries: [{ url: new URL(initialURL), state: null }],
    entryIndex: 0,
    scrollRestoration: "auto",
    disposed: false,
    orientationType: null,
  };
  environmentState.set(environment, internal);
  environment.locationObject = new Location(constructorToken, environment);
  environment.historyObject = new History(constructorToken, environment);
  environment.navigatorObject = new Navigator(constructorToken, environment);
  environment.screenObject = new Screen(constructorToken, environment);
  // Deriving orientation from a lazy viewport reads layout; defer the seed
  // to the first resize, by which time the document has a render surface.
  // A configured screen fixes orientation without any viewport read.
  internal.orientationType = lazyViewport && options.screen === null
    ? null
    : derivedOrientation(environment).type;
  document._componentEnvironment = environment;
  updateDocumentURL(environment);
  return Object.freeze(environment);
}

export function createImplicitComponentEnvironment(target, document) {
  const viewport = {};
  Object.defineProperties(viewport, {
    width: {
      enumerable: true,
      get: () => document._componentRenderSurface?.viewport.width ??
        document.documentElement?.clientWidth ?? 0,
    },
    height: {
      enumerable: true,
      get: () => document._componentRenderSurface?.viewport.height ??
        document.documentElement?.clientHeight ?? 0,
    },
  });
  const fallbackViewport = {
    get width() {
      return viewport.width > 0 ? viewport.width : 1280;
    },
    get height() {
      return viewport.height > 0 ? viewport.height : 720;
    },
  };
  return createComponentEnvironment({
    document,
    url: document.URL ?? "about:blank",
    viewport: fallbackViewport,
    target,
    options: normalizeComponentEnvironmentOptions(undefined, target),
  });
}
