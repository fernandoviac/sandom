// Document.execCommand and the queryCommand* members (the Editing API,
// https://w3c.github.io/editing/docs/execCommand/). The DOM core
// (core/dom/editing.watpart, core/dom/editing-inline.watpart,
// core/dom/editing-block.watpart, core/dom/editing-history.watpart) knows
// the commands, decides whether each is enabled and takes its value,
// answers the queries, and executes a command as an input run of the input
// controller (src/dom/input-controller.js): in the focused text control,
// else in the editing host of the document Selection. The run fires the
// input event, and no beforeinput event, as Chrome does for execCommand.
// undo and redo apply the document's undo history. copy and cut fire the
// clipboard event, with the DataTransfer that the input controller makes
// for them, and cut fires no beforeinput; the core enables them only while
// the window has transient activation, and paste never, as Chrome does for
// a script.
import { layoutConstant } from "../wasm/layout-table.js";
import { withCustomElementReactions } from "./custom-elements.js";
import { activationClock } from "./local-time.js";

const CMD_COPY = layoutConstant("CMD_COPY");
const CMD_CUT = layoutConstant("CMD_CUT");

function commandCode(document, commandId) {
  return document._domCore.status("editing_command_code", ...document._domCore.input(String(commandId)));
}

function focusedElement(document) {
  return document._focusedElement ?? document.activeElement ?? null;
}

// Whether command `code` can run: the document has a text editor (a render
// backend made by createSandomDOM), and the core enables the command for
// the focused element and the document Selection.
function enabled(document, code) {
  if (code === 0 || !document._editingCommands) return false;
  const target = focusedElement(document) ?? document.documentElement;
  return target !== null && document._domCore.status("editing_command_enabled", document._coreHandle, target._coreHandle, code,
    activationClock(document)) === 1;
}

export function installEditingCommands(prototype) {
  Object.defineProperties(prototype, {
    execCommand: {
      value: function execCommand(commandId, _showUI = false, value = "") {
        if (arguments.length < 1) throw new TypeError("Failed to execute 'execCommand' on 'Document': 1 argument required, but only 0 present.");
        const code = commandCode(this, commandId);
        const text = String(value);
        return withCustomElementReactions(() => {
          if (!enabled(this, code)) return false;
          if (this._domCore.status("editing_command_value_accepted", code, ...this._domCore.input(text)) !== 1) return false;
          const target = focusedElement(this) ?? this.documentElement;
          this._editingCommands.command(this.documentElement, code, text, { target, clipboard: code === CMD_COPY || code === CMD_CUT });
          return true;
        }, this._domCore);
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    queryCommandEnabled: {
      value: function queryCommandEnabled(commandId) {
        return enabled(this, commandCode(this, commandId));
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    queryCommandIndeterm: {
      value: function queryCommandIndeterm(commandId) {
        const code = commandCode(this, commandId);
        return code !== 0 && this._domCore.status("editing_command_indeterm", this._coreHandle, code) === 1;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    queryCommandState: {
      value: function queryCommandState(commandId) {
        const code = commandCode(this, commandId);
        return code !== 0 && this._domCore.status("editing_command_state", this._coreHandle, code) === 1;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    queryCommandSupported: {
      value: function queryCommandSupported(commandId) {
        return commandCode(this, commandId) !== 0;
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
    queryCommandValue: {
      value: function queryCommandValue(commandId) {
        const code = commandCode(this, commandId);
        if (code === 0) return "";
        return this._domCore.string("editing_command_value", this._coreHandle, code) ?? "";
      },
      writable: true,
      enumerable: true,
      configurable: true,
    },
  });
}
