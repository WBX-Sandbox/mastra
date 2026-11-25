/**
 * Desktop control (Mastra computer-use tools) backed by the WBX desktop API: screenshots and
 * mouse/keyboard actions on the sandbox's display (template `desktop`).
 */

import type { ComputerPosition, ComputerScreenshot, ComputerScreenSize, SandboxComputer } from "@mastra/core/workspace";
import type { ComputerAction } from "wbxsandbox";

import type { WBXSandbox } from "./sandbox.js";

/** Mastra / browser key names → WBX key names (xdotool keysyms). */
const KEY_NAMES: Record<string, string> = {
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  enter: "Return",
  return: "Return",
  escape: "Escape",
  esc: "Escape",
  " ": "space",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  tab: "Tab",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  home: "Home",
  end: "End",
  insert: "Insert",
  control: "ctrl",
  ctrl: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "super",
  cmd: "super",
  command: "super",
  super: "super",
  win: "super",
  "+": "plus",
  "-": "minus",
  "=": "equal",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
};

/** Normalizes one key for the WBX API (letters, digits, F-keys and known names). */
export function normalizeKey(key: string): string {
  const k = KEY_NAMES[key.toLowerCase()] ?? KEY_NAMES[key];
  if (k) return k;
  if (/^[A-Za-z0-9_]{1,32}$/.test(key)) return key;
  throw new Error(`unsupported key "${key}"`);
}

/** `"Enter"` → `"Return"`, `["ctrl", "s"]` → `"ctrl+s"`. */
export function keyCombo(key: string | string[]): string {
  return (Array.isArray(key) ? key : [key]).map(normalizeKey).join("+");
}

export class WBXComputer implements SandboxComputer {
  #sandbox: WBXSandbox;
  #cursor: ComputerPosition | undefined;
  #size: ComputerScreenSize | undefined;

  constructor(sandbox: WBXSandbox) {
    this.#sandbox = sandbox;
  }

  async #act(actions: ComputerAction[]): Promise<void> {
    await this.#sandbox.ensureRunning();
    const r = await this.#sandbox.wbx.computer.actions(actions);
    if (!r.ok) throw new Error(`desktop action failed: ${r.error ?? "unknown error"}`);
  }

  async screenshot(): Promise<ComputerScreenshot> {
    await this.#sandbox.ensureRunning();
    const s = await this.#sandbox.wbx.computer.screenshot({ format: "png" });
    if (s.screenWidth && s.screenHeight) this.#size = { width: s.screenWidth, height: s.screenHeight };
    return { data: s.data, mediaType: "image/png" };
  }

  async leftClick(x: number, y: number): Promise<void> {
    await this.#act([{ type: "click", x, y }]);
    this.#cursor = { x, y };
  }

  async rightClick(x: number, y: number): Promise<void> {
    await this.#act([{ type: "click", x, y, button: "right" }]);
    this.#cursor = { x, y };
  }

  async doubleClick(x: number, y: number): Promise<void> {
    await this.#act([{ type: "click", x, y, count: 2 }]);
    this.#cursor = { x, y };
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.#act([{ type: "move", x, y }]);
    this.#cursor = { x, y };
  }

  async drag(from: ComputerPosition, to: ComputerPosition): Promise<void> {
    await this.#act([{ type: "drag", x: from.x, y: from.y, to_x: to.x, to_y: to.y }]);
    this.#cursor = { ...to };
  }

  async scroll(direction: "up" | "down", amount: number): Promise<void> {
    const steps = Math.max(1, Math.min(50, Math.round(amount)));
    const at = this.#cursor ?? (await this.#center());
    await this.#act([{ type: "scroll", x: at.x, y: at.y, dx: 0, dy: direction === "down" ? steps : -steps }]);
  }

  async type(text: string): Promise<void> {
    await this.#act([{ type: "type", text }]);
  }

  async press(key: string | string[]): Promise<void> {
    await this.#act([{ type: "key", keys: keyCombo(key) }]);
  }

  async getScreenSize(): Promise<ComputerScreenSize> {
    if (!this.#size) {
      await this.#sandbox.ensureRunning();
      const st = await this.#sandbox.wbx.computer.status();
      if (!st.available) throw new Error(`the desktop is not available${st.reason ? `: ${st.reason}` : ""}`);
      this.#size = { width: st.width, height: st.height };
    }
    return { ...this.#size };
  }

  /**
   * The last position this provider moved the mouse to (the WBX API does not report the
   * cursor); the screen centre before the first action.
   */
  async getCursorPosition(): Promise<ComputerPosition> {
    return this.#cursor ? { ...this.#cursor } : this.#center();
  }

  async #center(): Promise<ComputerPosition> {
    const s = await this.getScreenSize();
    return { x: Math.floor(s.width / 2), y: Math.floor(s.height / 2) };
  }
}
