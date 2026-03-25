/**
 * CAM — Control Anything on MacOS
 * An OpenClaw plugin that gives AI agents full control over the macOS desktop
 * via Apple's Accessibility API (AX), without requiring screen-recording permission.
 *
 * Tools provided:
 * - macos_list_apps     List all running applications
 * - macos_query_ui      Get the full AX UI tree of an app (playwright-style)
 * - macos_list_elements Get a flat list of interactive elements with coordinates
 * - macos_click         Click at coordinates or on a named element
 * - macos_type          Type text into the focused element
 * - macos_key           Press keyboard shortcuts
 * - macos_scroll        Scroll at a screen position
 * - macos_long_press    Hold the mouse button (long press)
 * - macos_screenshot    Take a screenshot
 * - macos_activate_app  Bring an app to the foreground
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// ─── JXA serialization lock ───────────────────────────────────────────────────
// osascript / JXA is not safe to run concurrently — parallel calls can fail with
// "not authorized" or silent errors. Serialize all JXA calls through a simple queue.
let _jxaLockChain = Promise.resolve();
function withJXALock(fn) {
  const next = _jxaLockChain.then(() => fn());
  // Reset chain on completion so it doesn't grow unboundedly
  _jxaLockChain = next.catch(() => {});
  return next;
}

// ─── JXA helpers ─────────────────────────────────────────────────────────────

/**
 * Run a JXA script. JXA requires top-level code to be in a function called `run`.
 * We wrap the script in `run()` automatically.
 * For long scripts, write to a temp file to avoid osascript -e arg length limits.
 */
async function runJXA(script) {
  return withJXALock(() => _runJXA(script));
}

async function _runJXA(script) {
  // ObjC.import() must be at file top-level in JXA (not inside a function).
  // Extract any ObjC.import lines and hoist them before the function wrapper.
  const importLines = [];
  const bodyLines = [];
  for (const line of script.split("\n")) {
    if (/^\s*ObjC\.import\s*\(/.test(line)) {
      importLines.push(line.trim());
    } else {
      bodyLines.push(line);
    }
  }
  const body = bodyLines.join("\n");
  const wrapped = `${importLines.join("\n")}\nfunction run() {\n${body}\n}`;

  // Always use temp file — avoids osascript -e newline/quoting issues.
  // Timeout 60s: Electron apps (大象, Cursor) require deep AX traversal which can take 40-50s.
  const tmpPath = join(tmpdir(), `openclaw-jxa-${Date.now()}.js`);
  await writeFile(tmpPath, wrapped, "utf8");
  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", tmpPath], {
      timeout: 60000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout.trim();
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

// ─── Core macOS AX functions ──────────────────────────────────────────────────

/**
 * Activate AX support for Electron/Chromium apps.
 * Mirrors vimac's AXEnhancedUserInterfaceActivator + AXManualAccessibilityActivator.
 * Must be called before querying elements in non-native apps.
 */
async function activateAXForApp(appName) {
  // Use osascript with AXUIElement C API via ObjC bridge
  const script = `
    ObjC.import('ApplicationServices');
    ObjC.import('Foundation');

    const se = Application("System Events");
    const procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    if (!procs.length) return "not_found";

    const pid = procs[0].unixId();

    // Create AXUIElement for the app
    const appEl = $.AXUIElementCreateApplication(pid);

    // Set AXEnhancedUserInterface = true (Chromium/Electron accessibility)
    $.AXUIElementSetAttributeValue(appEl, $("AXEnhancedUserInterface"), $.YES);
    // Set AXManualAccessibility = true (Electron specific)
    $.AXUIElementSetAttributeValue(appEl, $("AXManualAccessibility"), $.YES);

    return "ok";
  `;
  try {
    await runJXA(script);
    await new Promise(r => setTimeout(r, 300)); // give app time to expose AX tree
  } catch (e) {
    // non-fatal — proceed anyway
  }
}

async function listApplications() {
  const script = `
    const se = Application("System Events");
    const procs = se.processes.whose({ backgroundOnly: false })();
    return JSON.stringify(procs.map(p => {
      let bid = null;
      try { bid = p.bundleIdentifier(); } catch(e) {}
      return {
        name: p.name(),
        pid: p.unixId(),
        frontmost: p.frontmost(),
        bundleId: bid
      };
    }));
  `;
  const result = await runJXA(script);
  return JSON.parse(result);
}

async function queryUITree(appName, maxDepth, maxElements) {
  const script = `
    const se = Application("System Events");
    const procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    if (procs.length === 0) return JSON.stringify({ error: "App not found: " + ${JSON.stringify(appName)} });

    const proc = procs[0];
    let elementCount = 0;
    const maxEl = ${maxElements};

    function getNode(el, depth) {
      if (depth <= 0 || elementCount >= maxEl) return null;
      elementCount++;

      let role = "unknown", title = "", value = "", desc = "";
      let x = 0, y = 0, w = 0, h = 0;
      let enabled = undefined, focused = undefined;

      try { role = el.role(); } catch(e) {}
      try { title = el.title() || ""; } catch(e) {}
      try {
        const v = el.value();
        value = (v !== null && v !== undefined) ? String(v).slice(0, 200) : "";
      } catch(e) {}
      try { desc = el.description() || ""; } catch(e) {}
      try { const pos = el.position(); x = pos[0]; y = pos[1]; } catch(e) {}
      try { const sz = el.size(); w = sz[0]; h = sz[1]; } catch(e) {}
      try { const en = el.enabled(); if (en === false) enabled = false; } catch(e) {}
      try { const fo = el.focused(); if (fo === true) focused = true; } catch(e) {}

      let actions = [];
      try { actions = el.actions.name(); } catch(e) {}

      const node = { role };
      if (title) node.title = title;
      if (value) node.value = value;
      if (desc && desc !== title) node.description = desc;
      node.position = [Math.round(x), Math.round(y)];
      node.size = [Math.round(w), Math.round(h)];
      if (enabled === false) node.enabled = false;
      if (focused) node.focused = true;
      if (actions.length > 0) node.actions = actions;

      if (depth > 1) {
        const children = [];
        try {
          const uiChildren = el.uiElements();
          for (let i = 0; i < uiChildren.length && elementCount < maxEl; i++) {
            const child = getNode(uiChildren[i], depth - 1);
            if (child) children.push(child);
          }
        } catch(e) {}
        if (children.length > 0) node.children = children;
      }
      return node;
    }

    const windows = [];
    try {
      const wins = proc.windows();
      for (let i = 0; i < wins.length && elementCount < maxEl; i++) {
        const w = getNode(wins[i], ${maxDepth});
        if (w) windows.push(w);
      }
    } catch(e) {
      try {
        const els = proc.uiElements();
        for (let i = 0; i < els.length && elementCount < maxEl; i++) {
          const el = getNode(els[i], ${maxDepth});
          if (el) windows.push(el);
        }
      } catch(e2) {}
    }

    return JSON.stringify({ app: ${JSON.stringify(appName)}, elementCount, windows });
  `;
  return JSON.parse(await runJXA(script));
}

async function queryInteractiveElements(appName, maxElements) {
  // Activate AX for Electron/Chromium apps (mirrors vimac's AXEnhancedUserInterface activation)
  await activateAXForApp(appName);

  // Get PID
  const pidStr = await runJXA(`
    const se = Application("System Events");
    const procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    if (!procs.length) return "0";
    return String(procs[0].unixId());
  `);
  const pid = parseInt(pidStr, 10);
  if (!pid) return { error: `App not found: ${appName}`, elements: [] };

  // Try the compiled Swift helper first (120x faster than JXA for deep Electron trees)
  const helperPath = join(new URL(import.meta.url).pathname, "../ax_traverse");
  try {
    const { stdout } = await execFileAsync(helperPath, [String(pid)], {
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim());
    result.app = appName;
    // Re-number IDs and cap at maxElements
    result.elements = result.elements.slice(0, maxElements).map((e, i) => ({ ...e, id: i + 1 }));
    result.count = result.elements.length;
    return result;
  } catch (e) {
    // Fallback: JXA deep traversal (slower but works without compiled binary)
  }

  // JXA fallback — depth 25, ~45s for deeply nested Electron apps
  const script = `
    const se = Application("System Events");
    const procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    if (procs.length === 0) return JSON.stringify({ error: "App not found" });
    const proc = procs[0];
    const maxEl = ${maxElements};
    const elements = [];
    let idCounter = 0;
    const ignoredActions = new Set(["AXShowMenu","AXScrollToVisible","AXShowDefaultUI","AXShowAlternateUI"]);

    function traverse(el, depth) {
      if (elements.length >= maxEl || depth <= 0) return;
      let role = "unknown";
      try { role = el.role(); } catch(e) { return; }
      if (role === "AXWindow" || role === "AXScrollArea") {
        try { const kids = el.uiElements(); for (let i = 0; i < kids.length && elements.length < maxEl; i++) traverse(kids[i], depth-1); } catch(e) {}
        return;
      }
      let actions = []; try { actions = el.actions.name(); } catch(e) {}
      const realActions = actions.filter(a => !ignoredActions.has(a));
      if (realActions.length > 0) {
        let title="",value="",desc="",x=0,y=0,w=0,h=0;
        try{title=el.title()||"";}catch(e){}
        try{const v=el.value();value=(v!==null&&v!==undefined)?String(v).slice(0,100):"";}catch(e){}
        try{desc=el.description()||"";}catch(e){}
        try{const pos=el.position();x=pos[0];y=pos[1];}catch(e){}
        try{const sz=el.size();w=sz[0];h=sz[1];}catch(e){}
        if(w>0&&h>0){
          elements.push({id:++idCounter,role,label:(title||desc||value||role).slice(0,100),
            position:[Math.round(x),Math.round(y)],size:[Math.round(w),Math.round(h)],
            center:[Math.round(x+w/2),Math.round(y+h/2)],actions:realActions,value:value||undefined});
        }
      }
      try{
        let kids;
        if(role==="AXTable"||role==="AXOutline"){try{kids=el.visibleRows();}catch(e){kids=el.uiElements();}}
        else kids=el.uiElements();
        for(let i=0;i<kids.length&&elements.length<maxEl;i++)traverse(kids[i],depth-1);
      }catch(e){}
    }
    try{const wins=proc.windows();for(let i=0;i<wins.length&&elements.length<maxEl;i++)traverse(wins[i],25);}
    catch(e){try{const els=proc.uiElements();for(let i=0;i<els.length&&elements.length<maxEl;i++)traverse(els[i],25);}catch(e2){}}
    return JSON.stringify({ app: ${JSON.stringify(appName)}, elements });
  `;
  return JSON.parse(await runJXA(script));
}

async function clickAtCoords(x, y, button, doubleClick) {
  // Try cliclick first (fast, reliable)
  try {
    const cmd = doubleClick ? "dc" : (button === "right" ? "rc" : "c");
    await execFileAsync("/opt/homebrew/bin/cliclick", [`${cmd}:${x},${y}`], { timeout: 5000 });
    return { success: true, method: "cliclick", x, y };
  } catch (e) {
    // Fallback: CGEvent via JXA
    const btnDown = button === "right" ? "$.kCGEventRightMouseDown" : "$.kCGEventLeftMouseDown";
    const btnUp = button === "right" ? "$.kCGEventRightMouseUp" : "$.kCGEventLeftMouseUp";
    const btnId = button === "right" ? "$.kCGMouseButtonRight" : "$.kCGMouseButtonLeft";
    const script = `
      ObjC.import('CoreGraphics');
      const pt = { x: ${x}, y: ${y} };
      const down = $.CGEventCreateMouseEvent(null, ${btnDown}, pt, ${btnId});
      const up   = $.CGEventCreateMouseEvent(null, ${btnUp},   pt, ${btnId});
      $.CGEventPost($.kCGHIDEventTap, down);
      $.CGEventPost($.kCGHIDEventTap, up);
      ${doubleClick ? `
      const start = Date.now();
      while(Date.now() - start < 80) {}
      const down2 = $.CGEventCreateMouseEvent(null, ${btnDown}, pt, ${btnId});
      const up2   = $.CGEventCreateMouseEvent(null, ${btnUp},   pt, ${btnId});
      $.CGEventPost($.kCGHIDEventTap, down2);
      $.CGEventPost($.kCGHIDEventTap, up2);
      ` : ""}
      return "ok";
    `;
    await runJXA(script);
    return { success: true, method: "cgevent", x, y };
  }
}

async function clickElementByLabel(appName, label, role) {
  const script = `
    const se = Application("System Events");
    const procs = se.processes.whose({ name: ${JSON.stringify(appName)} })();
    if (procs.length === 0) return JSON.stringify({ error: "App not found" });

    const proc = procs[0];
    const searchLabel = ${JSON.stringify(label)}.toLowerCase();
    const searchRole = ${JSON.stringify(role || "")};

    function findAndClick(el, depth) {
      if (depth <= 0) return null;
      let role = "", title = "", desc = "", value = "";
      try { role = el.role(); } catch(e) { return null; }
      try { title = (el.title() || "").toLowerCase(); } catch(e) {}
      try { desc = (el.description() || "").toLowerCase(); } catch(e) {}
      try { value = String(el.value() || "").toLowerCase(); } catch(e) {}

      const labelMatch = title === searchLabel || desc === searchLabel ||
                         title.includes(searchLabel) || desc.includes(searchLabel) ||
                         value === searchLabel;
      const roleMatch = !searchRole || role === searchRole;

      if (labelMatch && roleMatch) {
        try {
          el.actions.whose({ name: "AXPress" })[0].perform();
          return JSON.stringify({ success: true, role, matched: title || desc });
        } catch(e) {
          try {
            el.click();
            return JSON.stringify({ success: true, role, matched: title || desc, method: "click" });
          } catch(e2) {
            return JSON.stringify({ error: "Click failed: " + String(e2) });
          }
        }
      }

      try {
        const children = el.uiElements();
        for (const child of children) {
          const r = findAndClick(child, depth - 1);
          if (r) return r;
        }
      } catch(e) {}
      return null;
    }

    try {
      const wins = proc.windows();
      for (const win of wins) {
        const r = findAndClick(win, 10);
        if (r) return r;
      }
    } catch(e) {}

    return JSON.stringify({ error: "Element not found: " + ${JSON.stringify(label)} });
  `;
  return JSON.parse(await runJXA(script));
}

async function typeText(text, appName) {
  if (appName) {
    await runJXA(`Application(${JSON.stringify(appName)}).activate(); return "ok";`);
    await new Promise(r => setTimeout(r, 400));
  }
  // Write text to clipboard via stdin pipe — preserves real newlines.
  // NOTE: printf %s ${JSON.stringify(text)} | pbcopy was WRONG because JSON.stringify
  // escapes \n to the two-char sequence \n which printf %s does NOT unescape.
  // Using spawn + stdin.write() sends the raw string bytes directly.
  const { spawn } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    const proc = spawn("/usr/bin/pbcopy");
    proc.stdin.write(text, "utf8");
    proc.stdin.end();
    proc.on("close", resolve);
    proc.on("error", reject);
  });
  const script = `
    const se = Application("System Events");
    se.keystroke("v", { using: ["command down"] });
    return "ok";
  `;
  await runJXA(script);
  return { success: true };
}

async function pressKey(key, modifiers) {
  // Special keys must use keyCode() — JXA's keystroke() types the literal
  // string, so keystroke("return") types the word "return" rather than
  // pressing the Enter key.
  const KEY_CODES = {
    return: 36, enter: 36,
    tab: 48,
    space: 49,
    delete: 51, backspace: 51,
    escape: 53, esc: 53,
    left: 123, right: 124, down: 125, up: 126,
    f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
    f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
    home: 115, end: 119, pageup: 116, pagedown: 121,
    forwarddelete: 117,
  };

  const modMap = {
    cmd: "command down", command: "command down",
    ctrl: "control down", control: "control down",
    alt: "option down", option: "option down",
    shift: "shift down"
  };
  const using = modifiers
    .map(m => modMap[m.toLowerCase()] || (m + " down"))
    .map(m => JSON.stringify(m))
    .join(", ");
  const usingStr = using ? `, { using: [${using}] }` : "";

  const keyLower = key.toLowerCase();
  const keyCode = KEY_CODES[keyLower];

  let script;
  if (keyCode !== undefined) {
    // Use keyCode for special keys to avoid typing the key name as text
    script = `
      const se = Application("System Events");
      se.keyCode(${keyCode}${usingStr});
      return "ok";
    `;
  } else {
    // Single character keys (a-z, 0-9, symbols) use keystroke
    script = `
      const se = Application("System Events");
      se.keystroke(${JSON.stringify(key)}${usingStr});
      return "ok";
    `;
  }
  await runJXA(script);
  return { success: true };
}

async function scrollAt(x, y, deltaX, deltaY) {
  const script = `
    ObjC.import('CoreGraphics');
    const moveEvt = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, { x: ${x}, y: ${y} }, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, moveEvt);
    const scrollEvt = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, ${deltaY}, ${deltaX});
    $.CGEventPost($.kCGHIDEventTap, scrollEvt);
    return "ok";
  `;
  await runJXA(script);
  return { success: true };
}

async function longPressAt(x, y, durationMs) {
  const ms = Math.max(100, durationMs || 800);
  const script = `
    ObjC.import('CoreGraphics');
    const pt = { x: ${x}, y: ${y} };
    // Mouse down
    const down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, down);
    // Hold for duration
    const start = Date.now();
    while (Date.now() - start < ${ms}) {}
    // Mouse up
    const up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, up);
    return "ok";
  `;
  await runJXA(script);
  return { success: true, duration: ms };
}

async function takeScreenshot(region) {
  const tmpRaw = `/tmp/openclaw-ss-${Date.now()}.png`;
  const tmpSmall = `/tmp/openclaw-ss-${Date.now()}-small.png`;
  const args = ["-x", tmpRaw];
  if (region) {
    args.splice(1, 0, "-R", `${region.x},${region.y},${region.width},${region.height}`);
  }
  // Use absolute path — LaunchAgent services may not have /usr/sbin in PATH
  await execFileAsync("/usr/sbin/screencapture", args, { timeout: 10000 });
  // Resize to max 1280px wide to keep under API limits (avoid 413)
  try {
    await execFileAsync("/usr/bin/sips", ["-Z", "1280", "--out", tmpSmall, tmpRaw], { timeout: 10000 });
    const data = await readFile(tmpSmall);
    await unlink(tmpRaw).catch(() => {});
    await unlink(tmpSmall).catch(() => {});
    return data.toString("base64");
  } catch (e) {
    // fallback: return original
    const data = await readFile(tmpRaw);
    await unlink(tmpRaw).catch(() => {});
    return data.toString("base64");
  }
}

// ─── Text formatters ──────────────────────────────────────────────────────────

function formatUITree(tree) {
  if (tree.error) return `Error: ${tree.error}`;
  const lines = [`App: ${tree.app} (${tree.elementCount} elements scanned)`];

  function formatNode(node, depth) {
    const pad = "  ".repeat(depth);
    const label = node.title || node.description || "";
    const labelStr = label ? ` "${label}"` : "";
    const valStr = node.value && node.value !== label ? ` [="${node.value}"]` : "";
    const pos = node.position ? ` @(${node.position[0]},${node.position[1]})` : "";
    const size = node.size ? ` ${node.size[0]}x${node.size[1]}` : "";
    const acts = node.actions ? ` {${node.actions.join("|")}}` : "";
    const focus = node.focused ? " [focused]" : "";
    const disabled = node.enabled === false ? " [disabled]" : "";
    lines.push(`${pad}${node.role}${labelStr}${valStr}${pos}${size}${acts}${focus}${disabled}`);
    if (node.children) {
      for (const child of node.children) formatNode(child, depth + 1);
    }
  }

  for (const win of (tree.windows || [])) formatNode(win, 0);
  return lines.join("\n");
}

function formatInteractiveElements(data) {
  if (data.error) return `Error: ${data.error}`;
  const lines = [
    `App: ${data.app}`,
    `Found ${data.elements.length} interactive elements:`,
    "",
    "  ID  | Role                | Label                          | Center       | Size",
    "  ----|---------------------|--------------------------------|--------------|----------"
  ];
  for (const el of data.elements) {
    const id = String(el.id).padStart(4);
    const role = el.role.padEnd(20).slice(0, 20);
    const label = (el.label || "").padEnd(31).slice(0, 31);
    const center = `(${el.center[0]},${el.center[1]})`.padEnd(13);
    const size = `${el.size[0]}x${el.size[1]}`;
    const val = el.value ? ` = "${el.value.slice(0, 30)}"` : "";
    lines.push(`  ${id} | ${role}| ${label}| ${center}| ${size}${val}`);
  }
  return lines.join("\n");
}

// ─── Gemini thought_signature compat ─────────────────────────────────────────
//
// Some OpenAI-compatible API gateways proxy Gemini models. Gemini 3+ returns a
// `thought_signature` inside `tool_calls[].extra_content.google.thought_signature`
// in the streaming response. OpenClaw's openai-completions provider doesn't read
// `extra_content`, so the signature is lost. When openclaw replays history,
// Gemini rejects the request with "missing thought_signature".
//
// Fix:
//  1. Patch globalThis.fetch to intercept SSE responses from providers that
//     return Gemini thought_signature fields.
//     Transform each chunk: move `extra_content.google.thought_signature`
//     into `reasoning_details: [{type:"reasoning.encrypted", id, data}]`
//     — the format OpenClaw's openai-completions provider DOES understand.
//     OpenClaw then stores it as `toolCall.thoughtSignature = JSON.stringify(detail)`.
//
//  2. In the wrapStreamFn's onPayload hook, when building the next request,
//     convert `reasoning_details` back to `extra_content.google.thought_signature`
//     on each tool_call (the format Gemini expects).

function installThoughtSignatureInterceptor() {
  if (globalThis.__geminiThoughtSigInterceptorInstalled) return;
  globalThis.__geminiThoughtSigInterceptorInstalled = true;

  const originalFetch = globalThis.fetch;
  if (!originalFetch) return;

  globalThis.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Only intercept SSE responses that carry Gemini thought_signature fields.
    // The check is intentionally broad: any provider returning extra_content.google
    // will be handled correctly; providers that don't will pass through unchanged.
    const isSankuai = typeof url === "string" && url.includes("aigc.sankuai.com");
    const isGeminiProxy = isSankuai; // extend here for other Gemini-compatible gateways

    if (!isGeminiProxy) return originalFetch(input, init);

    // ── Outgoing request: fix the payload before sending ──────────────────
    // 1. Restore thought_signature from reasoning_details back into
    //    extra_content.google.thought_signature (Gemini's required format).
    // 2. Remove empty assistant messages (content:[]) that openclaw stores
    //    after error turns — Gemini rejects requests containing them.
    let patchedInit = init;
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (Array.isArray(body.messages)) {
          const stripPrefix = (id) => (id || "").replace(/^functioncall/i, "").replace(/^function-call-/i, "").replace(/-/g, "");

          // Pass 1: restore thought_signature
          for (const msg of body.messages) {
            if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
            const rd = Array.isArray(msg.reasoning_details) ? msg.reasoning_details : [];
            const sigs = rd.filter(d => d?.type === "reasoning.encrypted" && d.id && d.data)
                          .map(d => ({ norm: stripPrefix(d.id), data: d.data }));
            if (sigs.length === 0) continue;
            for (const tc of msg.tool_calls) {
              const tcNorm = stripPrefix(tc.id);
              const match = sigs.find(s => s.norm.startsWith(tcNorm) || tcNorm.startsWith(s.norm));
              if (match && !tc.extra_content) {
                tc.extra_content = { google: { thought_signature: match.data } };
              }
            }
            delete msg.reasoning_details;
          }

          // Pass 2: remove empty assistant turns (content:[] with no tool_calls)
          body.messages = body.messages.filter(msg => {
            if (msg.role === "assistant" && Array.isArray(msg.content) && msg.content.length === 0) {
              if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) return false;
            }
            return true;
          });

          patchedInit = { ...init, body: JSON.stringify(body) };
        }
      } catch (e) { /* non-JSON body or parse error — pass through unchanged */ }
    }

    const response = await originalFetch(input, patchedInit);
    if (!response.body) return response;

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) return response;

    // Transform the SSE stream: inject reasoning_details from extra_content
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const transformStream = new TransformStream({
      start() { this.buffer = ""; },
      transform(chunk, controller) {
        this.buffer += decoder.decode(chunk, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";

        const outputLines = [];
        for (const line of lines) {
          if (!line.startsWith("data: ")) {
            outputLines.push(line);
            continue;
          }
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            outputLines.push(line);
            continue;
          }
          try {
            const chunk = JSON.parse(data);
            const toolCalls = chunk?.choices?.[0]?.delta?.tool_calls;
            if (toolCalls) {
              let injected = false;
              const reasoningDetails = [];
              for (const tc of toolCalls) {
                const sig = tc?.extra_content?.google?.thought_signature;
                if (sig && tc.id) {
                  reasoningDetails.push({ type: "reasoning.encrypted", id: tc.id, data: sig });
                  injected = true;
                }
              }
              if (injected) {
                // Inject reasoning_details into the delta
                if (!chunk.choices[0].delta.reasoning_details) {
                  chunk.choices[0].delta.reasoning_details = reasoningDetails;
                } else {
                  chunk.choices[0].delta.reasoning_details.push(...reasoningDetails);
                }
                outputLines.push("data: " + JSON.stringify(chunk));
                continue;
              }
            }
          } catch (e) { /* ignore parse errors, pass through unchanged */ }
          outputLines.push(line);
        }
        controller.enqueue(encoder.encode(outputLines.join("\n") + (outputLines.length ? "\n" : "")));
      },
      flush(controller) {
        if (this.buffer) controller.enqueue(encoder.encode(this.buffer));
      }
    });

    const transformedBody = response.body.pipeThrough(transformStream);
    return new Response(transformedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function createGeminiThoughtSignatureWrapper(baseStreamFn) {
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    const wrappedOptions = {
      ...options,
      onPayload: (payload, mdl) => {
        if (payload && typeof payload === "object" && Array.isArray(payload.messages)) {
          // ── Fix: Gemini rejects assistant messages with empty content array.
          // This happens when openclaw stores an error turn (stopReason=error) as
          // an assistant message with content:[]. Strip those messages so they
          // never reach the API.
          payload.messages = payload.messages.filter(msg => {
            if (msg.role === "assistant" && Array.isArray(msg.content) && msg.content.length === 0) {
              // Only remove if there are also no tool_calls (truly empty turn)
              if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
                return false;
              }
            }
            return true;
          });
        }

        // Convert reasoning_details back to extra_content.google.thought_signature
        // for Gemini's expected format
        if (payload && typeof payload === "object" && Array.isArray(payload.messages)) {
          let injectedCount = 0;
          for (const msg of payload.messages) {
            if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
            const reasoningDetails = Array.isArray(msg.reasoning_details) ? msg.reasoning_details : [];
            // ID normalization:
            // - reasoning_details.id comes from our injected "reasoning.encrypted" detail
            //   where id = original Gemini tool_call id with "function-call-" stripped and "-" removed
            //   e.g. "function-call-990ddc55-ccfe-48b8-bf86-8a2f7f5f5ed9" -> "990ddc55ccfe48b8bf868a2f7f5f5ed9"
            // - tool_calls[].id in the outgoing payload = pi-ai's stored id, which is the original
            //   "function-call-UUID" id but with "functioncall" prefix and truncated to ~22 chars
            //   e.g. "functioncall990ddc55ccfe48b8bf86" (truncated)
            // Match by checking if rd_id starts with the hex part of tc_id
            const stripFunctionCallPrefix = (id) => (id || "").replace(/^functioncall/i, "").replace(/^function-call-/i, "").replace(/-/g, "");
            const sigEntries = []; // [{rdNorm, data}]
            for (const detail of reasoningDetails) {
              if (detail?.type === "reasoning.encrypted" && detail.id && detail.data) {
                sigEntries.push({ rdNorm: stripFunctionCallPrefix(detail.id), data: detail.data });
              }
            }
            if (sigEntries.length === 0) continue;
            for (const tc of msg.tool_calls) {
              const tcNorm = stripFunctionCallPrefix(tc.id);
              // Match: rdNorm starts with tcNorm (tcNorm is truncated prefix of rdNorm)
              const entry = sigEntries.find(e => e.rdNorm.startsWith(tcNorm) || tcNorm.startsWith(e.rdNorm));
              if (entry && !tc.extra_content) {
                tc.extra_content = { google: { thought_signature: entry.data } };
                injectedCount++;
              }
            }
            // Remove reasoning_details — Sankuai doesn't want it
            delete msg.reasoning_details;
          }
        }
        return originalOnPayload?.(payload, mdl);
      },
    };
    return baseStreamFn(model, context, wrappedOptions);
  };
}

// ─── Plugin definition ────────────────────────────────────────────────────────

const plugin = {
  id: "macos-control",
  name: "CAM — Control Anything on MacOS",
  description: "Control macOS UI via Accessibility API: query UI trees, click, scroll, type, screenshot. No vision model required.",

  register(api) {
    // ── Gemini thought_signature compat (provider-agnostic) ────────────────
    // Install a fetch interceptor that handles thought_signature for any
    // OpenAI-compatible Gemini proxy. The provider registration below wires
    // the outgoing-payload side for the known provider id.
    try {
      installThoughtSignatureInterceptor();

      api.registerProvider({
        id: "sankuai",
        label: "Gemini thought_signature compat",
        auth: [],
        wrapStreamFn: (ctx) => {
          if (!ctx.modelId?.startsWith("gemini-3") && !ctx.modelId?.startsWith("gemini-2.5")) {
            return null; // Only wrap Gemini 3+ and 2.5 models
          }
          if (!ctx.streamFn) return null;
          api.logger?.info?.(`cam: wrapping stream for ${ctx.provider}/${ctx.modelId} to inject thought_signature`);
          return createGeminiThoughtSignatureWrapper(ctx.streamFn);
        },
      });
      api.logger?.info?.("cam: registered Gemini thought_signature compat");
    } catch (e) {
      api.logger?.warn?.(`cam: could not register provider compat: ${e?.message}`);
    }

    // ── Tool: macos_list_apps ──────────────────────────────────────────────
    api.registerTool({
      name: "cam_list_apps",
      label: "List macOS Apps",
      description: `List all running macOS applications.

WHEN TO USE: Always call this first to get the exact app name before using any other tool.
The name returned here is what you pass to all other tools as the "app" parameter.

IMPORTANT: Call this tool alone, not in parallel with other CAM tools. Concurrent osascript
calls can interfere with each other and cause errors.

OUTPUT: Each line shows: ▶ (frontmost) AppName (bundleId) [pid:N]`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_id, _params) {
        const apps = await listApplications();
        const frontmost = apps.find(a => a.frontmost);
        const lines = [
          `Running applications (${apps.length}):`,
          frontmost ? `Frontmost: ${frontmost.name}` : "",
          "",
          ...apps.map(a => `  ${a.frontmost ? "▶" : " "} ${a.name}${a.bundleId ? ` (${a.bundleId})` : ""} [pid:${a.pid}]`)
        ].filter(l => l !== "");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    });

    // ── Tool: macos_query_ui ───────────────────────────────────────────────
    api.registerTool({
      name: "cam_query_ui",
      label: "Query macOS UI Tree",
      description: `Get the full UI element tree of a macOS app as structured text (playwright-style).

WHEN TO USE: Use to understand the current state of an app's UI — what windows, panels,
buttons, text fields exist and their positions. Best for native apps (Finder, Safari, etc.).
For Electron apps (大象, Cursor, etc.), prefer macos_screenshot + macos_list_elements.

HOW TO READ THE OUTPUT:
  Role "Label" [="value"] @(x,y) WxH {actions}
  - Role: AXButton, AXTextField, AXWindow, etc.
  - @(x,y): top-left screen coordinate
  - WxH: width × height in pixels
  - {actions}: available actions e.g. {AXPress} means clickable
  - Indentation = parent/child relationship

EXAMPLE:
  App: Finder (45 elements)
  AXWindow "下载" @(364,153) 1000x680 {AXRaise}
    AXToolbar @(364,153) 1000x52
      AXButton "后退" @(374,163) 30x30 {AXPress}   ← click at center (389,178)
      AXSearchField @(800,163) 200x22 {AXPress}     ← type here after clicking

IMPORTANT: After completing a task, close any windows you opened to keep the UI clean.`,
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "App name from macos_list_apps" },
          max_depth: { type: "number", description: "Tree depth (default: 6, max: 12)" },
          max_elements: { type: "number", description: "Max elements (default: 150)" }
        },
        required: ["app"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const { app, max_depth = 6, max_elements = 150 } = params;
        const tree = await queryUITree(app, Math.min(Math.max(1, max_depth), 12), Math.min(Math.max(1, max_elements), 400));
        return { content: [{ type: "text", text: formatUITree(tree) }] };
      }
    });

    // ── Tool: macos_list_elements ──────────────────────────────────────────
    api.registerTool({
      name: "cam_list_elements",
      label: "List Interactive UI Elements",
      description: `Get a flat list of all interactive elements in a macOS app, with their roles, labels, and screen coordinates.

## Core Workflow (how to interact with ANY app)

This is the PRIMARY tool for UI automation. The workflow is always:
  1. Call macos_list_elements(app) → get a numbered list of elements with labels and coordinates
  2. Identify the target element by its label/role in the list
  3. Call macos_click({ x, y }) using the element's Center coordinates to focus/activate it
  4. Call macos_type({ text }) to type text into the focused element
  5. Call macos_screenshot() to verify the result, then repeat if needed

## Example: Type a prompt into Cursor Composer
  1. macos_list_elements("Cursor") → find the Composer panel group, note its center/size
     - Look for AXGroup with size ~440x700 in the right panel area
     - The input box is near the BOTTOM of this panel (panelCenter.y + panelSize.height/2 - 60)
  2. macos_click({ x: panelX, y: inputY }) → click the estimated input position to focus it
  3. macos_type({ text: "implement the pass statements" }) → type the prompt
  4. macos_key({ key: "return" }) → press Enter to submit
  5. macos_screenshot() → verify the agent is running

## IMPORTANT: Cursor Composer / Electron Web inputs
  The Cursor Composer chat input is a Web-rendered contenteditable element.
  It does NOT appear in macos_list_elements output (not in AX tree).
  Strategy: estimate position from the surrounding AXGroup panel coordinates.
  - Composer panel: AXGroup @(474, 613) size 440x708 → bottom y ≈ 613+354=967
  - Input box is ~60px from bottom → y ≈ 907, x ≈ 474
  - Click that coordinate, then type. Verify with macos_screenshot().

## Output format
  ID | Role                | Label                          | Center       | Size
   1 | AXButton            | 搜索                           | (534,188)    | 200x30
   2 | AXTextField         | 消息输入框                      | (700,650)    | 600x40

## Key points
- Center coordinates are ready to use with macos_click
- If this tool returns only 0–2 elements, the UI is still loading or transitioning.
  Do NOT retry immediately — call cam_screenshot() first to see the actual screen state,
  then decide what to do based on what you see.
- For Electron apps (QQMusic, Cursor, 大象, VS Code), search results and dynamic content
  are Web-rendered and do NOT appear in the AX tree. When you can't find expected elements:
  1. Call cam_screenshot() to see the actual screen
  2. Identify the target visually and estimate its coordinates from the screenshot
  3. Use cam_click({ x, y }) with those coordinates
  4. Call cam_screenshot() again to verify the result
- App Store search results (app cards with "Get"/"获取" buttons) may NOT appear in this list
  because they are rendered in a scroll view. If you don't see the app after searching:
  1. Call cam_screenshot() to visually confirm the search results are visible
  2. Use cam_scroll({ x: 760, y: 600, delta_y: -5 }) to scroll the results area
  3. Call cam_list_elements again — the app cards should appear after scrolling
- After completing a task, close any windows you opened to keep the UI clean`,
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "App name from macos_list_apps" },
          max_elements: { type: "number", description: "Max elements (default: 200)" }
        },
        required: ["app"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const { app, max_elements = 200 } = params;
        const data = await queryInteractiveElements(app, Math.min(Math.max(1, max_elements), 400));
        return { content: [{ type: "text", text: formatInteractiveElements(data) }] };
      }
    });

    // ── Tool: macos_click ─────────────────────────────────────────────────
    api.registerTool({
      name: "cam_click",
      label: "Click macOS UI Element",
      description: `Click on a macOS UI element by screen coordinates or by label.

TWO WAYS TO CLICK:
1. By coordinates (most reliable):
   { x: 534, y: 188 }
   Use coordinates from macos_list_elements (Center column) or macos_query_ui (@(x,y) + half size).

2. By label in an app (searches AX tree):
   { app: "Finder", label: "桌面" }
   Only works for native apps with rich AX trees.

OPTIONS:
- button: "left" (default) or "right" — right-click shows context menu
- double_click: true — double-click to open files, select words, etc.

STANDARD WORKFLOW:
  1. macos_list_elements(app) → find element by label, note its Center (x,y)
  2. macos_click({ x, y }) → click to focus/activate the element
  3. macos_type({ text }) → type text into the focused element
  4. macos_screenshot() → verify result

EXAMPLE (type into Cursor Composer):
  1. macos_list_elements("Cursor") → find chat input area, note center e.g. (474, 900)
  2. macos_click({ x: 474, y: 900 }) → focus the input
  3. macos_type({ text: "implement all pass statements" }) → type prompt
  4. macos_key({ key: "return" }) → submit`,
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "X screen coordinate" },
          y: { type: "number", description: "Y screen coordinate" },
          app: { type: "string", description: "App name (for label-based search)" },
          label: { type: "string", description: "Element label to find (use with app)" },
          role: { type: "string", description: "Optional AX role filter e.g. 'AXButton'" },
          button: { type: "string", enum: ["left", "right"], description: "Mouse button (default: left)" },
          double_click: { type: "boolean", description: "Double-click (default: false)" }
        },
        additionalProperties: false,
      },
      async execute(_id, params) {
        const { x, y, app, label, role, button = "left", double_click = false } = params;
        if (typeof x === "number" && typeof y === "number") {
          const result = await clickAtCoords(x, y, button, double_click);
          return { content: [{ type: "text", text: `Clicked at (${x}, ${y})${button === "right" ? " [right-click]" : ""}${double_click ? " [double]" : ""}. Method: ${result.method}` }] };
        }
        if (app && label) {
          const result = await clickElementByLabel(app, label, role || null);
          if (result.error) return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
          return { content: [{ type: "text", text: `Clicked: ${result.role} "${result.matched || label}" in ${app}` }] };
        }
        return { content: [{ type: "text", text: "Error: Provide (x,y) or (app + label)." }], isError: true };
      }
    });

    // ── Tool: macos_type ──────────────────────────────────────────────────
    api.registerTool({
      name: "cam_type",
      label: "Type Text in macOS",
      description: `Type text into the currently focused UI element using clipboard paste.
Works reliably with all characters including Chinese, paths (/usr/bin), symbols.

IMPORTANT:
- The element must be focused first. Use cam_click to click on a text field before calling cam_type.
- Do NOT include "\\n" or newline characters in the text — they will be typed literally as text, NOT as Enter.
  To submit a form or confirm input, always call cam_key({ key: "return" }) as a separate step after cam_type.

CORRECT USAGE (search example):
  1. cam_click({ x: 386, y: 173 })                    → focus the search field
  2. cam_key({ key: "a", modifiers: ["cmd"] })         → select all existing text
  3. cam_type({ text: "QQ Music" })                    → type the search term (replaces selection)
  4. cam_key({ key: "return" })                        → press Enter to submit

Use Cmd+A before cam_type to clear any existing text in the field first.

WRONG (do not do this):
  cam_type({ text: "QQ Music\\n" })      ← \\n types the literal character, not Enter`,
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type (supports Chinese, paths, special chars)" },
          app: { type: "string", description: "Optional: activate this app before typing" }
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const { text, app } = params;
        await typeText(text, app || null);
        return { content: [{ type: "text", text: `Typed: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"` }] };
      }
    });

    // ── Tool: macos_key ───────────────────────────────────────────────────
    api.registerTool({
      name: "cam_key",
      label: "Press Key in macOS",
      description: `Press a keyboard key or shortcut in the frontmost app.

ALWAYS use cam_key to press Enter/Return — never put "\\n" inside cam_type text.

COMMON KEYS:
- { key: "return" } — confirm/submit (Enter key) ← use this after cam_type to submit forms/search
- { key: "escape" } — cancel/dismiss
- { key: "tab" } — next field
- { key: "space" } — space / toggle
- { key: "delete" } — backspace

STANDARD SEARCH WORKFLOW (App Store, Finder, Safari, etc.):
  1. cam_click({ x, y })              → focus the search field
  2. cam_type({ text: "search term" }) → type (no \\n in text!)
  3. cam_key({ key: "return" })        → press Enter to submit

COMMON SHORTCUTS:
- { key: "a", modifiers: ["cmd"] } — Select All
- { key: "c", modifiers: ["cmd"] } — Copy
- { key: "v", modifiers: ["cmd"] } — Paste
- { key: "z", modifiers: ["cmd"] } — Undo
- { key: "n", modifiers: ["cmd"] } — New window/file
- { key: "w", modifiers: ["cmd"] } — Close window ← use this to clean up after tasks
- { key: "s", modifiers: ["cmd"] } — Save
- { key: "f", modifiers: ["cmd"] } — Find/Search

Modifiers: cmd, ctrl, alt/option, shift`,
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name: 'return', 'escape', 'tab', 'space', 'delete', 'a'-'z', 'f1'-'f12', arrow keys ('up','down','left','right')" },
          modifiers: { type: "array", items: { type: "string" }, description: "Modifier keys: cmd, ctrl, alt, option, shift" }
        },
        required: ["key"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const { key, modifiers = [] } = params;
        await pressKey(key, modifiers);
        const modStr = modifiers.length > 0 ? `${modifiers.join("+")}+` : "";
        return { content: [{ type: "text", text: `Pressed: ${modStr}${key}` }] };
      }
    });

    // ── Tool: macos_scroll ────────────────────────────────────────────────
    api.registerTool({
      name: "cam_scroll",
      label: "Scroll in macOS",
      description: `Scroll at a screen position.

delta_y: negative = scroll DOWN (see more content below), positive = scroll UP
delta_x: negative = scroll LEFT, positive = scroll RIGHT

EXAMPLE: Scroll down in a list at position (500, 400):
  { x: 500, y: 400, delta_y: -5 }`,
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate to scroll at" },
          y: { type: "number", description: "Y coordinate to scroll at" },
          delta_x: { type: "number", description: "Horizontal scroll (default: 0)" },
          delta_y: { type: "number", description: "Vertical scroll (default: -3, negative=down)" }
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const { x, y, delta_x = 0, delta_y = -3 } = params;
        await scrollAt(x, y, delta_x, delta_y);
        return { content: [{ type: "text", text: `Scrolled at (${x}, ${y}): dx=${delta_x}, dy=${delta_y}` }] };
      }
    });

    // ── Tool: macos_long_press ────────────────────────────────────────────
    api.registerTool({
      name: "cam_long_press",
      label: "Long Press in macOS",
      description: `Hold the mouse button down at a position for a duration (long press).
Useful for: showing context menus, triggering drag-start, activating hold actions.

EXAMPLE: Long-press on an item to show its context menu:
  { x: 500, y: 300, duration_ms: 800 }

Default duration is 800ms. For drag operations, use 500ms then immediately call macos_click
at the destination.`,
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "X screen coordinate" },
          y: { type: "number", description: "Y screen coordinate" },
          duration_ms: { type: "number", description: "Hold duration in milliseconds (default: 800)" }
        },
        required: ["x", "y"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const { x, y, duration_ms = 800 } = params;
        const result = await longPressAt(x, y, duration_ms);
        return { content: [{ type: "text", text: `Long-pressed at (${x}, ${y}) for ${result.duration}ms` }] };
      }
    });

    // ── Tool: macos_screenshot ────────────────────────────────────────────
    api.registerTool({
      name: "cam_screenshot",
      label: "Take macOS Screenshot",
      description: `Take a screenshot to visually inspect the current state of the screen.

WHEN TO USE:
- After clicking/typing to verify the action had the expected effect
- When macos_query_ui returns empty (Electron apps)
- To find element positions visually when AX tree is unavailable
- To confirm a task completed successfully

The image is returned as base64 PNG. You can analyze it to determine coordinates.

OPTIONAL: Capture only a specific region: { region: { x: 364, y: 153, width: 1000, height: 680 } }`,
      parameters: {
        type: "object",
        properties: {
          region: {
            type: "object",
            description: "Optional region to capture (default: full screen)",
            properties: {
              x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" }
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          }
        },
        additionalProperties: false,
      },
      async execute(_id, params) {
        const base64 = await takeScreenshot(params.region || null);
        return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
      }
    });

    // ── Tool: macos_activate_app ──────────────────────────────────────────
    api.registerTool({
      name: "cam_activate_app",
      label: "Activate macOS App",
      description: `Bring a macOS application to the foreground and give it keyboard focus.

ALWAYS call this before sending keystrokes to an app. After activation, there is a
600ms delay to ensure the app fully gains focus before the next tool call.

EXAMPLE WORKFLOW:
  1. macos_activate_app({ app: "大象" }) → bring 大象 to front
  2. macos_list_elements({ app: "大象" }) → find search bar
  3. macos_click({ x: ..., y: ... }) → click search bar
  4. macos_type({ text: "陈哲恺" }) → type

CLEANUP: When done with a task, close opened windows:
  macos_key({ key: "w", modifiers: ["cmd"] }) — close current window`,
      parameters: {
        type: "object",
        properties: {
          app: { type: "string", description: "Application name (exact, from macos_list_apps)" }
        },
        required: ["app"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        await runJXA(`Application(${JSON.stringify(params.app)}).activate(); return "ok";`);
        await new Promise(r => setTimeout(r, 600));
        return { content: [{ type: "text", text: `Activated: ${params.app}` }] };
      }
    });

    api.logger?.info?.("cam: registered 10 tools (cam_list_apps, cam_query_ui, cam_list_elements, cam_click, cam_type, cam_key, cam_scroll, cam_long_press, cam_screenshot, cam_activate_app)");
  }
};

export default plugin;
