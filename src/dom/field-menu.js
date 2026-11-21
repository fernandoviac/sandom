// The context menu of a text field, a thin wrapper over
// core/dom/field-menu.watpart. The core decides when the menu opens, its
// rows, which are available and what the chosen row does; this file gives
// the core the host's labels and clipboard, and runs the chosen command
// through the host editing commands of the input controller.
//
// A host gives `backend.setContextMenu({ labels, clipboard })`:
// - labels: { undo, redo, cut, copy, paste, selectAll }, strings in the
//   user's language; a missing label is English.
// - clipboard: { write(text), read(request) }, or null. `read` calls
//   `request.reply(text)` or `request.refuse()` once, at any later time.
//   Without a clipboard, the menu's cut, copy and paste are unavailable.
//   The clipboard keys use the same clipboard (src/dom/input-controller.js):
//   copy and cut by key write it, and the paste key reads it; without one
//   the paste key pastes nothing.

const LABEL_CODES = Object.freeze({ undo: 1, redo: 2, cut: 3, copy: 4, paste: 5, selectAll: 6 });
const COMMAND = Object.freeze({ UNDO: 1, REDO: 2, CUT: 3, COPY: 4, PASTE: 5, SELECT_ALL: 6, REPLACE: 7 });

export function setDocumentContextMenu(document, { labels = {}, clipboard = null } = {}) {
  if (labels === null || typeof labels !== "object") {
    throw new TypeError(`setContextMenu: labels is ${describe(labels)}; expected an object of strings`);
  }
  for (const [name, label] of Object.entries(labels)) {
    if (!Object.hasOwn(LABEL_CODES, name)) {
      throw new TypeError(`setContextMenu: labels has ${JSON.stringify(name)}; expected ${Object.keys(LABEL_CODES).join(", ")}`);
    }
    if (typeof label !== "string") {
      throw new TypeError(`setContextMenu: label ${name} is ${describe(label)}; expected a string`);
    }
  }
  if (clipboard !== null && (typeof clipboard?.write !== "function" || typeof clipboard?.read !== "function")) {
    throw new TypeError(`setContextMenu: clipboard is ${describe(clipboard)}; expected null or { write(text), read(request) }`);
  }
  const core = document._domCore;
  for (const [name, code] of Object.entries(LABEL_CODES)) {
    core.status("context_menu_label_set", document._coreHandle, code, ...core.input(labels[name] ?? ""));
  }
  core.status("context_menu_clipboard_set", document._coreHandle, clipboard === null ? 0 : 1);
  document._contextMenuClipboard = clipboard;
}

// The command of an effect 7 notification, read while the notification
// holds its text.
export function fieldMenuCommand(core, notification) {
  const text = notification.aux === COMMAND.REPLACE
    ? core.decoder.decode(core.refreshBytes().subarray(notification.a, notification.a + notification.b))
    : "";
  return { command: notification.aux, field: core.wrapperFor(notification.target), text };
}

// Runs command `command` on `field` with the input controller's host
// editing commands `runtime`, after the run that chose it.
export function runFieldMenuCommand(runtime, root, { command, field, text }) {
  const target = field;
  const clipboard = (field.ownerDocument ?? field)._contextMenuClipboard;
  if (command === COMMAND.UNDO || command === COMMAND.REDO) {
    runtime.history(root, command === COMMAND.REDO, { target });
  } else if (command === COMMAND.CUT || command === COMMAND.COPY) {
    const copied = command === COMMAND.CUT ? runtime.cut(root, { target }) : runtime.copy(root, { target });
    if (copied !== null) clipboard.write(copied);
  } else if (command === COMMAND.PASTE) {
    let answered = false;
    const answer = () => {
      if (answered) throw new Error("context menu paste: the clipboard already answered");
      answered = true;
    };
    clipboard.read(Object.freeze({
      reply(pasted) {
        if (typeof pasted !== "string") {
          throw new TypeError(`context menu paste: the clipboard text is ${describe(pasted)}; expected a string`);
        }
        answer();
        runtime.paste(root, pasted, { target });
      },
      refuse: answer,
    }));
  } else if (command === COMMAND.SELECT_ALL) {
    runtime.selectAll(root, { target });
  } else if (command === COMMAND.REPLACE) {
    runtime.insertText(root, text, { inputType: "insertReplacementText", target });
  } else {
    throw new Error(`Unknown context menu command ${command}`);
  }
}

function describe(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
