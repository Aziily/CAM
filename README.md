<div align="center">

# 🖥️ CAM — Control Anything on MacOS

**An [OpenClaw](https://openclaw.ai) plugin that gives AI agents full control over the macOS desktop**  
**through Apple's Accessibility API — no vision model required.**

> 🇨🇳 [中文文档](./README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-plugin-blue)](https://openclaw.ai)

</div>

---

## 💡 How It Works

macOS exposes every native UI element through the **Accessibility API** (`AXUIElement`). CAM traverses this tree — similar to how a browser exposes the DOM — and returns structured data: element roles, labels, screen coordinates, sizes, and available actions. The agent reads this tree to decide what to click or type, then issues atomic tool calls to perform the interaction.

This approach means:

- 🚫 **No vision model needed** — the agent reads structured element data, not pixels
- 🔒 **No screen recording** — AX queries use only the Accessibility permission
- 🍎 **Works with native apps** — Finder, Safari, Terminal, App Store, and any Cocoa app with a full AX tree
- ⚡ **Partial support for Electron apps** — elements exposed via `AXEnhancedUserInterface` are accessible; Web-rendered content may require coordinate-based fallback

---

## 📋 Prerequisites

1. **macOS** (Apple Silicon, recent version)
2. **[OpenClaw](https://openclaw.ai)** — the host application that loads and runs plugins
3. **Node.js Accessibility permission** — on first use, macOS will prompt you:
   - Open **System Settings → Privacy & Security → Accessibility**
   - Add `node` and **enable** the toggle

   > Without this, calls will fail with *"not authorized to send Apple events"*

4. **Optional: `cliclick`** — improves click reliability:
   ```bash
   brew install cliclick
   ```
   If absent, the plugin falls back to CoreGraphics `CGEvent` automatically.

---

## 🚀 Installation

```bash
# 1. Clone the repository
git clone https://github.com/Aziily/CAM.git

# 2. Install via OpenClaw CLI
openclaw plugins install ./CAM
```

---

## 🛠️ Available Tools

### 📋 `cam_list_apps`

List all running macOS applications. **Always call this first** to get the exact app name.

**Parameters:** none

```
Running applications (12):
Frontmost: Terminal

  ▶ Terminal (com.apple.Terminal) [pid:1234]
    Finder (com.apple.finder) [pid:456]
    Safari (com.apple.Safari) [pid:789]
```

---

### 🌲 `cam_query_ui`

Get the full AX UI element tree of an app (Playwright-style hierarchical format).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `app` | string | ✅ | App name from `cam_list_apps` |
| `max_depth` | number | — | Tree depth (default: 6, max: 12) |
| `max_elements` | number | — | Element cap (default: 150, max: 400) |

```
App: Finder (45 elements)
AXWindow "Downloads" @(0,25) 1280x755 {AXRaise|AXClose}
  AXToolbar @(0,25) 1280x52
    AXButton "Back" @(10,35) 30x30 {AXPress}
```

---

### 🔍 `cam_list_elements`

Get a flat numbered list of all interactive elements with center coordinates. **This is the primary tool for UI automation.**

**Standard workflow:**
1. `cam_list_elements(app)` → get numbered list with coordinates
2. Identify target by label/role
3. `cam_click({ x, y })` → click using Center coordinates
4. `cam_type({ text })` → type into focused element
5. `cam_screenshot()` → verify result

| Parameter | Type | Required | Description |
|---|---|---|---|
| `app` | string | ✅ | App name |
| `max_elements` | number | — | Cap (default: 200, max: 400) |

```
  ID  | Role                | Label          | Center    | Size
  ----|---------------------|----------------|-----------|------
     1 | AXButton           | Back           | (45,45)   | 30x30
     2 | AXTextField        | Address Bar    | (640,45)  | 800x30
```

---

### 🖱️ `cam_click`

Click by coordinates or by label.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | number | cond. | X coordinate |
| `y` | number | cond. | Y coordinate |
| `app` | string | cond. | App name (use with `label`) |
| `label` | string | cond. | Element label to find |
| `role` | string | — | AX role filter (e.g. `AXButton`) |
| `button` | `"left"` \| `"right"` | — | Mouse button (default: `"left"`) |
| `double_click` | boolean | — | Double-click (default: `false`) |

```json
{ "x": 640, "y": 400 }
{ "app": "Finder", "label": "Desktop" }
{ "x": 200, "y": 300, "button": "right" }
{ "x": 400, "y": 500, "double_click": true }
```

---

### ⌨️ `cam_type`

Type text via clipboard paste. Works with all characters including CJK, paths, symbols.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✅ | Text to type |
| `app` | string | — | Activate this app before typing |

```json
{ "text": "Hello, world!" }
```

---

### 🔑 `cam_key`

Press a key or keyboard shortcut.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✅ | `return`, `escape`, `tab`, `space`, `delete`, `a`–`z`, `f1`–`f12`, `up/down/left/right` |
| `modifiers` | string[] | — | `cmd`, `ctrl`, `alt`/`option`, `shift` |

```json
{ "key": "return" }
{ "key": "a", "modifiers": ["cmd"] }
{ "key": "z", "modifiers": ["cmd", "shift"] }
```

---

### 📜 `cam_scroll`

Scroll at a screen position.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | number | ✅ | X coordinate |
| `y` | number | ✅ | Y coordinate |
| `delta_x` | number | — | Horizontal scroll (default: 0) |
| `delta_y` | number | — | Vertical scroll (default: -3; **negative = scroll down**) |

```json
{ "x": 640, "y": 400, "delta_y": -5 }
```

---

### 👆 `cam_long_press`

Hold the mouse button for a duration.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | number | ✅ | X coordinate |
| `y` | number | ✅ | Y coordinate |
| `duration_ms` | number | — | Hold duration in ms (default: 800) |

```json
{ "x": 500, "y": 300, "duration_ms": 800 }
```

---

### 📸 `cam_screenshot`

Take a screenshot. Returns base64 PNG, auto-resized to max 1280 px wide.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `region` | object | — | `{ x, y, width, height }` |

```json
{}
{ "region": { "x": 0, "y": 0, "width": 800, "height": 600 } }
```

---

### 🎯 `cam_activate_app`

Bring an app to the foreground. Waits 600 ms after activation.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `app` | string | ✅ | Application name |

```json
{ "app": "Terminal" }
```

---

## 🎬 Example

> **Prompt:** *"Use CAM tools to install QQ Music from the App Store for me. Do not use any other tools."*

The agent will:

```
1. cam_activate_app   { "app": "App Store" }
2. cam_list_elements  { "app": "App Store" }
   → find the search field
3. cam_click          { "x": <search_x>, "y": <search_y> }
4. cam_type           { "text": "QQ Music" }
5. cam_key            { "key": "return" }
6. cam_screenshot     {}
   → confirm search results loaded
7. cam_list_elements  { "app": "App Store" }
   → find "QQ Music" result and "Get" button
8. cam_click          { "x": <get_x>, "y": <get_y> }
   → click Get / Install
9. cam_screenshot     {}
   → confirm installation started
```

---

## ⚙️ Plugin Config Options

| Option | Type | Default | Description |
|---|---|---|---|
| `screenshotOnQuery` | boolean | false | Auto-capture screenshot on every UI query |
| `maxElements` | number (1–500) | 200 | Global cap on elements returned per query |

---

## ⚠️ Known Limitations

- **Electron / web-rendered content** — elements inside Web views are not in the AX tree; use `cam_screenshot` + coordinate-based clicks as fallback
- **Single primary display** — multi-monitor coordinate translation is not handled
- **No native drag-and-drop** — complex drag operations are not supported
- **JXA timeout** — very large app trees may time out (60 s limit); use `max_depth`/`max_elements` to limit scope

---

## 📁 Project Structure

```
CAM/
├── index.js               # Plugin entry point (ES module)
├── macos-ax.js            # Standalone AX helper (reference only)
├── ax_traverse            # Swift binary: recursive AX tree traversal
├── ax_search              # Swift binary: AXUIElementsForSearchPredicate
├── openclaw.plugin.json   # Plugin manifest
├── package.json
└── README.md / README.zh.md
```

---

<div align="center">

## 📊 Stats

[![Star History Chart](https://api.star-history.com/svg?repos=Aziily/CAM&type=Date)](https://star-history.com/#Aziily/CAM&Date)

![Visitor Count](https://visitor-badge.laobi.icu/badge?page_id=Aziily.CAM)

</div>

---

## 🙏 Acknowledgements

- **[Vimac](https://github.com/dexterleng/vimac)** — inspired the hint-mode element enumeration approach using `AXUIElementsForSearchPredicate`
- **Apple Accessibility API** — the foundation that makes desktop automation possible without screen recording

---

<div align="center">

MIT © [Aziily](https://github.com/Aziily)

</div>
