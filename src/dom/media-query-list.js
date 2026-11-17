import {
  addEventListener,
  createEvent,
  dispatchEvent,
  dispatchEventFromScript,
  removeEventListener,
} from "./events.js";
import { mediaMatches } from "./stylesheet.js";

export class MediaQueryList {
  constructor(document, media) {
    this._document = document;
    this.media = String(media);
    this.matches = mediaMatches(
      this.media,
      document._styleSystem.environment,
    );
    this._onchange = null;
  }

  get onchange() {
    return this._onchange;
  }

  set onchange(callback) {
    if (this._onchange) this.removeEventListener("change", this._onchange);
    this._onchange = typeof callback === "function" ? callback : null;
    if (this._onchange) this.addEventListener("change", this._onchange);
  }

  addEventListener(type, callback, options = undefined) {
    addEventListener(this, type, callback, options);
  }

  removeEventListener(type, callback, options = undefined) {
    removeEventListener(this, type, callback, options);
  }

  dispatchEvent(event) {
    return dispatchEventFromScript(this, event);
  }

  addListener(callback) {
    this.addEventListener("change", callback);
  }

  removeListener(callback) {
    this.removeEventListener("change", callback);
  }

  _reevaluate() {
    const matches = mediaMatches(
      this.media,
      this._document._styleSystem.environment,
    );
    if (matches === this.matches) return;
    this.matches = matches;
    dispatchEvent(this, createEvent("change", { matches, media: this.media }));
  }
}
Object.defineProperty(MediaQueryList.prototype, Symbol.toStringTag, { value: "MediaQueryList", configurable: true });
