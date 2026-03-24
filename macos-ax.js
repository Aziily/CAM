/**
 * macOS Accessibility API bridge via osascript (JXA - JavaScript for Automation)
 * This module provides functions to query and control macOS UI elements.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a JXA script via osascript
 */
async function runJXA(script) {
  const { stdout, stderr } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr && stderr.trim()) {
    // JXA sometimes writes warnings to stderr
  }
  return stdout.trim();
}

/**
 * Run an AppleScript
 */
async function runAppleScript(script) {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Get list of running applications
 */
export async function listApplications() {
  const script = `
    const se = Application("System Events");
    const procs = se.processes.whose({ backgroundOnly: false })();
    return JSON.stringify(procs.map(p => ({
      name: p.name(),
      pid: p.unixId(),
      frontmost: p.frontmost(),
      bundleId: p.bundleIdentifier ? p.bundleIdentifier() : null
    })));
  `;
  const result = await runJXA(script);
  return JSON.parse(result);
}

/**
 * Get the frontmost application name
 */
export async function getFrontmostApp() {
  const script = `
    const se = Application("System Events");
    const front = se.processes.whose({ frontmost: true })();
    if (front.length === 0) return "unknown";
    return front[0].name();
  `;
  return await runJXA(script);
}

/**
 * Query UI tree for an application, returning a playwright-like structured representation
 * Returns elements with role, title, value, position, size, actions, and children
 */
export async function queryUITree(appName, maxDepth = 6, maxElements = 200) {
  const script = `
    ObjC.import('stdlib');
    const se = Application("System Events");

    let procs;
    try {
      procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    } catch(e) {
      return JSON.stringify({ error: "App not found: " + ${JSON.stringify(appName)} });
    }

    if (procs.length === 0) {
      return JSON.stringify({ error: "App not found: " + ${JSON.stringify(appName)} });
    }

    const proc = procs[0];
    let elementCount = 0;
    const maxEl = ${maxElements};

    function getElement(el, depth) {
      if (depth <= 0 || elementCount >= maxEl) return null;
      elementCount++;

      let role = "", title = "", value = "", desc = "", x = 0, y = 0, w = 0, h = 0;
      let enabled = true, focused = false;

      try { role = el.role(); } catch(e) { role = "unknown"; }
      try { title = el.title(); } catch(e) {}
      try { value = el.value(); } catch(e) {}
      try { desc = el.description(); } catch(e) {}
      try {
        const pos = el.position();
        x = pos[0]; y = pos[1];
      } catch(e) {}
      try {
        const sz = el.size();
        w = sz[0]; h = sz[1];
      } catch(e) {}
      try { enabled = el.enabled(); } catch(e) {}
      try { focused = el.focused(); } catch(e) {}

      // Get available actions
      let actions = [];
      try {
        actions = el.actions.name();
      } catch(e) {}

      const node = {
        role,
        title: title || undefined,
        value: (value !== null && value !== undefined && value !== "") ? String(value).slice(0, 200) : undefined,
        description: desc || undefined,
        position: [Math.round(x), Math.round(y)],
        size: [Math.round(w), Math.round(h)],
        enabled: enabled !== false ? undefined : false,
        focused: focused ? true : undefined,
        actions: actions.length > 0 ? actions : undefined,
      };

      // Get children
      if (depth > 1) {
        let children = [];
        try {
          const uiChildren = el.uiElements();
          for (let i = 0; i < uiChildren.length && elementCount < maxEl; i++) {
            const child = getElement(uiChildren[i], depth - 1);
            if (child) children.push(child);
          }
        } catch(e) {}
        if (children.length > 0) node.children = children;
      }

      return node;
    }

    // Get windows
    let windows = [];
    try {
      const wins = proc.windows();
      for (let i = 0; i < wins.length && elementCount < maxEl; i++) {
        const w = getElement(wins[i], ${maxDepth});
        if (w) windows.push(w);
      }
    } catch(e) {
      // Fallback: try uiElements directly
      try {
        const els = proc.uiElements();
        for (let i = 0; i < els.length && elementCount < maxEl; i++) {
          const el = getElement(els[i], ${maxDepth});
          if (el) windows.push(el);
        }
      } catch(e2) {}
    }

    return JSON.stringify({
      app: ${JSON.stringify(appName)},
      elementCount,
      windows
    });
  `;

  const result = await runJXA(script);
  return JSON.parse(result);
}

/**
 * Get a flat list of interactive/hintable elements (like vimac hint mode)
 * Returns elements that can be clicked, focused, or interacted with
 */
export async function queryInteractiveElements(appName, maxElements = 200) {
  const script = `
    const se = Application("System Events");

    let procs;
    try {
      procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    } catch(e) {
      return JSON.stringify({ error: "App not found" });
    }

    if (procs.length === 0) {
      return JSON.stringify({ error: "App not found: " + ${JSON.stringify(appName)} });
    }

    const proc = procs[0];
    const elements = [];
    const maxEl = ${maxElements};

    // Roles that are typically interactive
    const interactiveRoles = new Set([
      "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea",
      "AXComboBox", "AXPopUpButton", "AXMenuButton", "AXLink", "AXMenuItem",
      "AXTab", "AXCell", "AXRow", "AXSlider", "AXScrollBar", "AXSplitter",
      "AXDisclosureTriangle", "AXImage", "AXStaticText", "AXToolbar",
      "AXSearchField", "AXColorWell", "AXDateField", "AXIncrementor",
      "AXOutline", "AXTable", "AXList"
    ]);

    let idCounter = 0;

    function traverse(el, depth) {
      if (elements.length >= maxEl || depth <= 0) return;

      let role = "unknown";
      try { role = el.role(); } catch(e) { return; }

      let title = "", value = "", desc = "";
      let x = 0, y = 0, w = 0, h = 0;

      try { title = el.title() || ""; } catch(e) {}
      try { value = el.value(); value = value !== null ? String(value).slice(0, 100) : ""; } catch(e) {}
      try { desc = el.description() || ""; } catch(e) {}
      try { const pos = el.position(); x = pos[0]; y = pos[1]; } catch(e) {}
      try { const sz = el.size(); w = sz[0]; h = sz[1]; } catch(e) {}

      // Check if element has actions
      let actions = [];
      try { actions = el.actions.name(); } catch(e) {}

      const isInteractive = interactiveRoles.has(role) || actions.length > 0;

      if (isInteractive && w > 0 && h > 0) {
        const label = title || desc || value || role;
        elements.push({
          id: ++idCounter,
          role,
          label: label.slice(0, 100),
          position: [Math.round(x), Math.round(y)],
          size: [Math.round(w), Math.round(h)],
          center: [Math.round(x + w/2), Math.round(y + h/2)],
          actions: actions.length > 0 ? actions : undefined,
          value: value || undefined,
        });
      }

      // Recurse into children
      try {
        const children = el.uiElements();
        for (let i = 0; i < children.length; i++) {
          traverse(children[i], depth - 1);
        }
      } catch(e) {}
    }

    // Traverse from windows
    try {
      const wins = proc.windows();
      for (const win of wins) {
        traverse(win, 8);
      }
    } catch(e) {
      try {
        const els = proc.uiElements();
        for (const el of els) traverse(el, 8);
      } catch(e2) {}
    }

    return JSON.stringify({ app: ${JSON.stringify(appName)}, elements });
  `;

  const result = await runJXA(script);
  return JSON.parse(result);
}

/**
 * Click at a specific screen coordinate using cliclick or CGEvent
 */
export async function clickAt(x, y, button = "left", doubleClick = false) {
  // Use cliclick if available, otherwise use osascript
  try {
    const cmd = doubleClick ? "dc" : (button === "right" ? "rc" : "c");
    await execFileAsync("cliclick", [`${cmd}:${x},${y}`], { timeout: 5000 });
    return { success: true, method: "cliclick" };
  } catch (e) {
    // Fallback to JXA
    const script = `
      const app = Application.currentApplication();
      app.includeStandardAdditions = true;

      ObjC.import('CoreGraphics');
      ObjC.import('Foundation');

      const point = { x: ${x}, y: ${y} };

      // Create mouse down event
      const mouseDown = $.CGEventCreateMouseEvent(
        null,
        ${button === "right" ? "$.kCGEventRightMouseDown" : "$.kCGEventLeftMouseDown"},
        point,
        ${button === "right" ? "$.kCGMouseButtonRight" : "$.kCGMouseButtonLeft"}
      );

      // Create mouse up event
      const mouseUp = $.CGEventCreateMouseEvent(
        null,
        ${button === "right" ? "$.kCGEventRightMouseUp" : "$.kCGEventLeftMouseUp"},
        point,
        ${button === "right" ? "$.kCGMouseButtonRight" : "$.kCGMouseButtonLeft"}
      );

      $.CGEventPost($.kCGHIDEventTap, mouseDown);
      $.CGEventPost($.kCGHIDEventTap, mouseUp);

      ${doubleClick ? `
      // Second click for double-click
      delay(0.05);
      $.CGEventPost($.kCGHIDEventTap, mouseDown);
      $.CGEventPost($.kCGHIDEventTap, mouseUp);
      ` : ""}

      return "ok";
    `;
    await runJXA(script);
    return { success: true, method: "jxa-cgevent" };
  }
}

/**
 * Click on a UI element by its label/role in an app
 */
export async function clickElement(appName, elementLabel, elementRole = null) {
  const roleFilter = elementRole ? `&& role === ${JSON.stringify(elementRole)}` : "";
  const script = `
    const se = Application("System Events");
    const procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    if (procs.length === 0) return JSON.stringify({ error: "App not found" });

    const proc = procs[0];
    const label = ${JSON.stringify(elementLabel)}.toLowerCase();

    function findAndClick(el, depth) {
      if (depth <= 0) return false;

      let role = "", title = "", desc = "", value = "";
      try { role = el.role(); } catch(e) { return false; }
      try { title = (el.title() || "").toLowerCase(); } catch(e) {}
      try { desc = (el.description() || "").toLowerCase(); } catch(e) {}
      try { value = String(el.value() || "").toLowerCase(); } catch(e) {}

      const matchesLabel = title === label || desc === label || value === label ||
                           title.includes(label) || desc.includes(label);
      const matchesRole = !${JSON.stringify(elementRole)} || role === ${JSON.stringify(elementRole)};

      if (matchesLabel && matchesRole) {
        try {
          el.actions.whose({ name: "AXPress" })[0].perform();
          return JSON.stringify({ success: true, role, title: title || desc });
        } catch(e) {
          try {
            el.click();
            return JSON.stringify({ success: true, role, title: title || desc, method: "click" });
          } catch(e2) {
            return JSON.stringify({ error: "Could not click: " + e2.message });
          }
        }
      }

      try {
        const children = el.uiElements();
        for (const child of children) {
          const result = findAndClick(child, depth - 1);
          if (result) return result;
        }
      } catch(e) {}

      return null;
    }

    try {
      const wins = proc.windows();
      for (const win of wins) {
        const result = findAndClick(win, 8);
        if (result) return result;
      }
    } catch(e) {}

    return JSON.stringify({ error: "Element not found: " + ${JSON.stringify(elementLabel)} });
  `;

  const result = await runJXA(script);
  return JSON.parse(result);
}

/**
 * Type text into the focused element or a specific element
 */
export async function typeText(text, appName = null) {
  if (appName) {
    // Activate the app first
    await runJXA(`Application(${JSON.stringify(appName)}).activate()`);
    await new Promise(r => setTimeout(r, 300));
  }

  // Use keystroke via System Events
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
    const se = Application("System Events");
    se.keystroke(${JSON.stringify(text)});
    return "ok";
  `;
  await runJXA(script);
  return { success: true };
}

/**
 * Press a key or key combination
 */
export async function pressKey(key, modifiers = []) {
  // Map common key names
  const keyMap = {
    "enter": "return", "return": "return", "tab": "tab", "space": "space",
    "escape": "escape", "esc": "escape", "delete": "delete", "backspace": "delete",
    "up": "up arrow", "down": "down arrow", "left": "left arrow", "right": "right arrow",
    "home": "home", "end": "end", "pageup": "page up", "pagedown": "page down",
    "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4", "f5": "f5",
    "f6": "f6", "f7": "f7", "f8": "f8", "f9": "f9", "f10": "f10",
    "f11": "f11", "f12": "f12",
  };

  const mappedKey = keyMap[key.toLowerCase()] || key;
  const modList = modifiers.map(m => {
    const modMap = { "cmd": "command down", "command": "command down",
                     "ctrl": "control down", "control": "control down",
                     "alt": "option down", "option": "option down",
                     "shift": "shift down" };
    return modMap[m.toLowerCase()] || `${m} down`;
  });

  const modStr = modList.length > 0 ? ` using {${modList.join(", ")}}` : "";
  const appleScript = `tell application "System Events" to key code (key code of "${mappedKey}")${modStr}`;

  // Use keystroke for regular keys, key code for special keys
  const jxaScript = `
    const se = Application("System Events");
    ${modList.length > 0
      ? `se.keystroke(${JSON.stringify(mappedKey)}, { using: [${modList.map(m => JSON.stringify(m.replace(" down", ""))).join(", ")}] });`
      : `se.keystroke(${JSON.stringify(mappedKey)});`
    }
    return "ok";
  `;

  try {
    await runJXA(jxaScript);
    return { success: true };
  } catch (e) {
    // Fallback to AppleScript
    const asScript = `tell application "System Events" to keystroke "${mappedKey}"${modStr}`;
    await runAppleScript(asScript);
    return { success: true, method: "applescript" };
  }
}

/**
 * Scroll at a position
 */
export async function scrollAt(x, y, deltaX = 0, deltaY = -3) {
  const script = `
    ObjC.import('CoreGraphics');

    const scrollEvent = $.CGEventCreateScrollWheelEvent(
      null,
      $.kCGScrollEventUnitLine,
      2,
      ${deltaY},
      ${deltaX}
    );

    // Move mouse to position first
    const moveEvent = $.CGEventCreateMouseEvent(
      null,
      $.kCGEventMouseMoved,
      { x: ${x}, y: ${y} },
      $.kCGMouseButtonLeft
    );
    $.CGEventPost($.kCGHIDEventTap, moveEvent);

    $.CGEventPost($.kCGHIDEventTap, scrollEvent);
    return "ok";
  `;

  await runJXA(script);
  return { success: true };
}

/**
 * Take a screenshot and return base64
 */
export async function takeScreenshot(region = null) {
  const args = ["-x"]; // silent
  if (region) {
    args.push("-R", `${region.x},${region.y},${region.width},${region.height}`);
  }

  const tmpPath = `/tmp/openclaw-screenshot-${Date.now()}.png`;
  args.push(tmpPath);

  await execFileAsync("screencapture", args, { timeout: 10000 });

  const { readFile } = await import("node:fs/promises");
  const data = await readFile(tmpPath);

  // Cleanup
  const { unlink } = await import("node:fs/promises");
  await unlink(tmpPath).catch(() => {});

  return data.toString("base64");
}

/**
 * Activate (bring to front) an application
 */
export async function activateApp(appName) {
  const script = `Application(${JSON.stringify(appName)}).activate(); return "ok";`;
  await runJXA(script);
  return { success: true };
}

/**
 * Get the text content of a UI element (for reading text fields, labels, etc.)
 */
export async function getElementValue(appName, elementLabel) {
  const script = `
    const se = Application("System Events");
    const procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    if (procs.length === 0) return JSON.stringify({ error: "App not found" });

    const proc = procs[0];
    const label = ${JSON.stringify(elementLabel)}.toLowerCase();

    function findValue(el, depth) {
      if (depth <= 0) return null;

      let role = "", title = "", desc = "", value = "";
      try { role = el.role(); } catch(e) { return null; }
      try { title = (el.title() || "").toLowerCase(); } catch(e) {}
      try { desc = (el.description() || "").toLowerCase(); } catch(e) {}
      try { value = String(el.value() || ""); } catch(e) {}

      if (title === label || desc === label || title.includes(label) || desc.includes(label)) {
        return JSON.stringify({ role, title, value, description: desc });
      }

      try {
        const children = el.uiElements();
        for (const child of children) {
          const result = findValue(child, depth - 1);
          if (result) return result;
        }
      } catch(e) {}
      return null;
    }

    try {
      const wins = proc.windows();
      for (const win of wins) {
        const result = findValue(win, 8);
        if (result) return result;
      }
    } catch(e) {}

    return JSON.stringify({ error: "Element not found" });
  `;

  const result = await runJXA(script);
  return JSON.parse(result);
}

/**
 * Format UI tree as a playwright-like text representation
 * Similar to Playwright's aria snapshot format
 */
export function formatUITreeAsText(tree, indent = 0) {
  if (!tree) return "";
  const lines = [];
  const pad = "  ".repeat(indent);

  const formatNode = (node, depth) => {
    const p = "  ".repeat(depth);
    const role = node.role || "element";
    const label = node.title || node.description || node.value || "";
    const labelStr = label ? ` "${label}"` : "";
    const valueStr = node.value && node.value !== label ? ` [value: "${node.value}"]` : "";
    const posStr = node.position ? ` @[${node.position[0]},${node.position[1]}]` : "";
    const sizeStr = node.size ? ` ${node.size[0]}x${node.size[1]}` : "";
    const actionStr = node.actions ? ` {${node.actions.join("|")}}` : "";
    const focusStr = node.focused ? " [focused]" : "";
    const disabledStr = node.enabled === false ? " [disabled]" : "";

    lines.push(`${p}${role}${labelStr}${valueStr}${posStr}${sizeStr}${actionStr}${focusStr}${disabledStr}`);

    if (node.children) {
      for (const child of node.children) {
        formatNode(child, depth + 1);
      }
    }
  };

  if (tree.windows) {
    lines.push(`App: ${tree.app} (${tree.elementCount} elements)`);
    for (const win of tree.windows) {
      formatNode(win, 0);
    }
  } else {
    formatNode(tree, indent);
  }

  return lines.join("\n");
}

/**
 * Format interactive elements as a playwright-like reference list
 */
export function formatInteractiveElements(data) {
  if (data.error) return `Error: ${data.error}`;

  const lines = [`App: ${data.app}`, `Interactive elements (${data.elements.length}):`, ""];

  for (const el of data.elements) {
    const label = el.label || el.role;
    const actions = el.actions ? ` [${el.actions.join(",")}]` : "";
    const value = el.value ? ` = "${el.value}"` : "";
    lines.push(`  [${el.id}] ${el.role} "${label}"${value}${actions} @center(${el.center[0]},${el.center[1]}) size(${el.size[0]}x${el.size[1]})`);
  }

  return lines.join("\n");
}
