<div align="center">

# 🖥️ CAM — Control Anything on MacOS

**一个 [OpenClaw](https://openclaw.ai) 插件，让 AI Agent 通过 Apple 无障碍 API 完整控制 macOS 桌面**  
**无需视觉模型。**

> 🇺🇸 [English Documentation](./README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-plugin-blue)](https://openclaw.ai)

</div>

---

## 💡 工作原理

macOS 通过 **Accessibility API**（`AXUIElement`）暴露所有原生 UI 元素。CAM 遍历这棵树——类似浏览器暴露 DOM 的方式——返回结构化数据：元素角色、标签、屏幕坐标、尺寸和可用操作。Agent 读取这棵树来决定点击或输入的目标，然后发出原子工具调用执行交互。

这种方式的优势：

- 🚫 **无需视觉模型** — Agent 读取结构化元素数据，而非像素
- 🔒 **无需屏幕录制** — AX 查询只需要无障碍访问权限
- 🍎 **支持原生应用** — Finder、Safari、Terminal、App Store，以及任何拥有完整 AX 树的 Cocoa 应用
- ⚡ **部分支持 Electron 应用** — 通过 `AXEnhancedUserInterface` 暴露的元素可访问；Web 渲染内容可能需要基于坐标的兜底方案

---

## 📋 前置条件

1. **macOS**（Apple Silicon，较新版本）
2. **[OpenClaw](https://openclaw.ai)** — 加载并运行插件的宿主应用
3. **Node.js 无障碍权限** — 首次使用时，macOS 会提示：
   - 打开 **系统设置 → 隐私与安全性 → 辅助功能**
   - 添加 `node` 并**开启**开关

   > 未授权时调用会报错：*"not authorized to send Apple events"*

4. **可选：`cliclick`** — 提升点击可靠性：
   ```bash
   brew install cliclick
   ```
   未安装时自动回退到 CoreGraphics `CGEvent`。

---

## 🚀 安装

```bash
# 1. 克隆仓库
git clone https://github.com/Aziily/CAM.git

# 2. 通过 OpenClaw CLI 安装
openclaw plugins install ./CAM
```

---

## 🛠️ 可用工具

### 📋 `cam_list_apps`

列出所有正在运行的 macOS 应用。**始终先调用此工具**获取精确的应用名称。

**参数：** 无

```
Running applications (12):
Frontmost: Terminal

  ▶ Terminal (com.apple.Terminal) [pid:1234]
    Finder (com.apple.finder) [pid:456]
    Safari (com.apple.Safari) [pid:789]
```

---

### 🌲 `cam_query_ui`

以 Playwright 风格层级文本格式获取应用的完整 AX UI 元素树。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `app` | string | ✅ | `cam_list_apps` 返回的应用名称 |
| `max_depth` | number | — | 树深度（默认：6，最大：12） |
| `max_elements` | number | — | 元素上限（默认：150，最大：400） |

```
App: Finder (45 elements)
AXWindow "下载" @(0,25) 1280x755 {AXRaise|AXClose}
  AXToolbar @(0,25) 1280x52
    AXButton "后退" @(10,35) 30x30 {AXPress}
```

---

### 🔍 `cam_list_elements`

获取应用中所有可交互元素的扁平编号列表，包含中心坐标。**这是 UI 自动化的核心工具。**

**标准工作流：**
1. `cam_list_elements(app)` → 获取带坐标的编号列表
2. 通过标签/角色定位目标元素
3. `cam_click({ x, y })` → 使用 Center 坐标点击
4. `cam_type({ text })` → 向聚焦元素输入文字
5. `cam_screenshot()` → 截图验证结果

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `app` | string | ✅ | 应用名称 |
| `max_elements` | number | — | 上限（默认：200，最大：400） |

```
  ID  | Role                | Label          | Center    | Size
  ----|---------------------|----------------|-----------|------
     1 | AXButton           | 后退           | (45,45)   | 30x30
     2 | AXTextField        | 地址栏         | (640,45)  | 800x30
```

---

### 🖱️ `cam_click`

通过坐标或标签点击 UI 元素。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `x` | number | 条件 | X 坐标 |
| `y` | number | 条件 | Y 坐标 |
| `app` | string | 条件 | 应用名称（配合 `label`） |
| `label` | string | 条件 | 要查找的元素标签 |
| `role` | string | — | AX 角色过滤（如 `AXButton`） |
| `button` | `"left"` \| `"right"` | — | 鼠标按键（默认：`"left"`） |
| `double_click` | boolean | — | 双击（默认：`false`） |

```json
{ "x": 640, "y": 400 }
{ "app": "Finder", "label": "桌面" }
{ "x": 200, "y": 300, "button": "right" }
{ "x": 400, "y": 500, "double_click": true }
```

---

### ⌨️ `cam_type`

通过剪贴板粘贴输入文字。支持中文、路径、特殊字符等所有字符。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | ✅ | 要输入的文字 |
| `app` | string | — | 输入前激活此应用 |

```json
{ "text": "你好，世界！" }
```

---

### 🔑 `cam_key`

按下按键或快捷键。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key` | string | ✅ | `return`、`escape`、`tab`、`space`、`delete`、`a`–`z`、`f1`–`f12`、`up/down/left/right` |
| `modifiers` | string[] | — | `cmd`、`ctrl`、`alt`/`option`、`shift` |

```json
{ "key": "return" }
{ "key": "a", "modifiers": ["cmd"] }
{ "key": "z", "modifiers": ["cmd", "shift"] }
```

---

### 📜 `cam_scroll`

在屏幕指定位置滚动。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `x` | number | ✅ | X 坐标 |
| `y` | number | ✅ | Y 坐标 |
| `delta_x` | number | — | 水平滚动（默认：0） |
| `delta_y` | number | — | 垂直滚动（默认：-3；**负数 = 向下**） |

```json
{ "x": 640, "y": 400, "delta_y": -5 }
```

---

### 👆 `cam_long_press`

在指定位置按住鼠标（长按）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `x` | number | ✅ | X 坐标 |
| `y` | number | ✅ | Y 坐标 |
| `duration_ms` | number | — | 按住时长，毫秒（默认：800） |

```json
{ "x": 500, "y": 300, "duration_ms": 800 }
```

---

### 📸 `cam_screenshot`

截图。返回 base64 PNG，自动缩放至最大宽度 1280 px。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `region` | object | — | `{ x, y, width, height }` |

```json
{}
{ "region": { "x": 0, "y": 0, "width": 800, "height": 600 } }
```

---

### 🎯 `cam_activate_app`

将应用切换到前台。激活后等待 600 ms。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `app` | string | ✅ | 应用名称 |

```json
{ "app": "Terminal" }
```

---

## 🎬 使用示例

> **提示词：** *"Use CAM tools to install QQ Music from the App Store for me. Do not use any other tools."*
>
> 或中文版：*"请你使用 CAM 工具，为我从 App Store 安装 QQ 音乐，不要使用其他工具。"*

Agent 的执行流程：

```
1. cam_activate_app   { "app": "App Store" }
2. cam_list_elements  { "app": "App Store" }
   → 找到搜索框
3. cam_click          { "x": <搜索框x>, "y": <搜索框y> }
4. cam_type           { "text": "QQ音乐" }
5. cam_key            { "key": "return" }
6. cam_screenshot     {}
   → 确认搜索结果已加载
7. cam_list_elements  { "app": "App Store" }
   → 找到"QQ音乐"结果和"获取"按钮
8. cam_click          { "x": <获取按钮x>, "y": <获取按钮y> }
   → 点击获取/安装
9. cam_screenshot     {}
   → 确认安装已开始
```

---

## ⚙️ 插件配置选项

| 选项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `screenshotOnQuery` | boolean | false | 每次 UI 查询时自动截图 |
| `maxElements` | number (1–500) | 200 | 每次查询返回的元素数量上限 |

---

## ⚠️ 已知限制

- **Electron / Web 渲染内容** — Web 视图内部元素不在 AX 树中；使用 `cam_screenshot` + 坐标点击作为兜底
- **仅支持主显示器** — 多显示器坐标转换暂不支持
- **不支持原生拖放** — 复杂拖放操作暂未实现
- **JXA 超时** — 超大应用树遍历可能超时（60 秒）；使用 `max_depth`/`max_elements` 限制范围

---

## 📁 项目结构

```
CAM/
├── index.js               # 插件入口（ES 模块）
├── macos-ax.js            # 独立 AX 辅助库（参考用）
├── ax_traverse            # Swift 二进制：递归 AX 树遍历
├── ax_search              # Swift 二进制：AXUIElementsForSearchPredicate 枚举
├── openclaw.plugin.json   # 插件清单
├── package.json
└── README.md / README.zh.md
```

---

<div align="center">

## 📊 统计

[![Star History Chart](https://api.star-history.com/svg?repos=Aziily/CAM&type=Date)](https://star-history.com/#Aziily/CAM&Date)

![Visitor Count](https://visitor-badge.laobi.icu/badge?page_id=Aziily.CAM)

</div>

---

## 🙏 致谢

- **[Vimac](https://github.com/dexterleng/vimac)** — 启发了使用 `AXUIElementsForSearchPredicate` 枚举屏幕上所有可交互元素的 hint 模式实现思路
- **Apple Accessibility API** — 使一切成为可能的底层基础，无需屏幕录制

---

<div align="center">

MIT © [Aziily](https://github.com/Aziily)

</div>
