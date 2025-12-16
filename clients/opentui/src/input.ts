/**
 * Input encoding for terminal applications.
 *
 * OpenTUI gives us higher-level key events; we need to convert them back into
 * terminal escape sequences and forward them to prise via `write_pty`.
 */

export type KeyEvent = {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
};

class InputHandler {
  private cursorMode: "normal" | "application" = "normal";

  setCursorMode(mode: "normal" | "application"): void {
    this.cursorMode = mode;
  }

  encodeKey(event: KeyEvent): string {
    const { key, ctrl, alt, shift, meta } = event;

    // Control key combinations
    if (ctrl && !alt && !meta) {
      if (key.length === 1 && key >= "a" && key <= "z") {
        return String.fromCharCode(key.charCodeAt(0) - 96);
      }
      if (key.length === 1 && key >= "A" && key <= "Z") {
        return String.fromCharCode(key.charCodeAt(0) - 64);
      }
      if (key === "[") return "\x1b";
      if (key === "\\") return "\x1c";
      if (key === "]") return "\x1d";
      if (key === "^") return "\x1e";
      if (key === "_") return "\x1f";
    }

    // Function keys
    const fnKeyMap: Record<string, string> = {
      f1: "\x1bOP",
      f2: "\x1bOQ",
      f3: "\x1bOR",
      f4: "\x1bOS",
      f5: "\x1b[15~",
      f6: "\x1b[17~",
      f7: "\x1b[18~",
      f8: "\x1b[19~",
      f9: "\x1b[20~",
      f10: "\x1b[21~",
      f11: "\x1b[23~",
      f12: "\x1b[24~",
    };

    const lower = key.toLowerCase();
    if (fnKeyMap[lower]) {
      return this.addModifiers(fnKeyMap[lower]!, { ctrl, alt, shift });
    }

    // Navigation keys
    const cursorPrefix = this.cursorMode === "application" ? "\x1bO" : "\x1b[";
    const navKeyMap: Record<string, string> = {
      up: `${cursorPrefix}A`,
      down: `${cursorPrefix}B`,
      right: `${cursorPrefix}C`,
      left: `${cursorPrefix}D`,
      home: "\x1b[H",
      end: "\x1b[F",
      pageup: "\x1b[5~",
      pagedown: "\x1b[6~",
      insert: "\x1b[2~",
      delete: "\x1b[3~",
    };

    if (navKeyMap[lower]) {
      return this.addModifiers(navKeyMap[lower]!, { ctrl, alt, shift });
    }

    switch (lower) {
      case "return":
      case "enter":
        return alt && !ctrl ? "\n" : "\r";
      case "tab":
        return shift ? "\x1b[Z" : "\t";
      case "backspace":
        return "\x7f";
      case "escape":
        return "\x1b";
      case "space":
        return " ";
    }

    // Alt key prefix for printable chars
    if (alt && key.length === 1) {
      return "\x1b" + key;
    }

    // Regular character
    if (key.length === 1) {
      return key;
    }

    return "";
  }

  private addModifiers(
    seq: string,
    mods: { ctrl?: boolean; alt?: boolean; shift?: boolean }
  ): string {
    const { ctrl, alt, shift } = mods;

    if (!ctrl && !alt && !shift) {
      return seq;
    }

    let code = 1;
    if (shift) code += 1;
    if (alt) code += 2;
    if (ctrl) code += 4;

    if (seq.startsWith("\x1b[") && seq.length > 2) {
      const lastChar = seq[seq.length - 1];
      const middle = seq.slice(2, -1);

      if (middle === "" || middle.match(/^\d+$/)) {
        const num = middle === "" ? "1" : middle;
        return `\x1b[${num};${code}${lastChar}`;
      }
    }

    return seq;
  }
}

export const inputHandler = new InputHandler();

export function encodeKey(event: KeyEvent): string {
  return inputHandler.encodeKey(event);
}
