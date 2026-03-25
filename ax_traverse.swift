import Foundation
import Cocoa
import ApplicationServices

struct ElementInfo: Codable {
    var id: Int; var role: String; var label: String
    var position: [Int]; var size: [Int]; var center: [Int]
    var actions: [String]; var value: String?
}

let ignoredActions: Set<String> = ["AXShowMenu","AXScrollToVisible","AXShowDefaultUI","AXShowAlternateUI"]

// Roles that are purely structural containers - skip capturing but traverse children
let containerRoles: Set<String> = ["AXSplitGroup","AXSplitter","AXLayoutArea","AXLayoutItem",
    "AXGroup","AXScrollArea","AXScrollBar","AXWindow","AXSheet","AXDrawer"]

var elements: [ElementInfo] = []
var idCounter = 0
let maxEl = 500

func getStringAttr(_ el: AXUIElement, _ attr: String) -> String {
    var val: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success else { return "" }
    return val as? String ?? ""
}
func getPointAttr(_ el: AXUIElement, _ attr: String) -> CGPoint {
    var val: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success,
          let axVal = val, CFGetTypeID(axVal) == AXValueGetTypeID() else { return .zero }
    var pt = CGPoint.zero; AXValueGetValue(axVal as! AXValue, .cgPoint, &pt); return pt
}
func getSizeAttr(_ el: AXUIElement, _ attr: String) -> CGSize {
    var val: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &val) == .success,
          let axVal = val, CFGetTypeID(axVal) == AXValueGetTypeID() else { return .zero }
    var sz = CGSize.zero; AXValueGetValue(axVal as! AXValue, .cgSize, &sz); return sz
}

func traverse(_ el: AXUIElement, depth: Int) {
    guard depth > 0, elements.count < maxEl else { return }

    let role = getStringAttr(el, kAXRoleAttribute as String)
    let pos = getPointAttr(el, kAXPositionAttribute as String)
    let sz = getSizeAttr(el, kAXSizeAttribute as String)

    // Capture this element if it has a visible size and is not a pure structural container
    if sz.width > 0 && sz.height > 0 && !containerRoles.contains(role) {
        var actionNames: CFArray?
        AXUIElementCopyActionNames(el, &actionNames)
        let allActions = actionNames as? [String] ?? []
        let realActions = allActions.filter { !ignoredActions.contains($0) }

        var label = getStringAttr(el, kAXTitleAttribute as String)
        if label.isEmpty { label = getStringAttr(el, kAXDescriptionAttribute as String) }
        if label.isEmpty { label = getStringAttr(el, kAXPlaceholderValueAttribute as String) }

        var valStr: String? = nil
        var valRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXValueAttribute as String as CFString, &valRef) == .success,
           let v = valRef as? String, !v.isEmpty { valStr = String(v.prefix(100)) }

        idCounter += 1
        elements.append(ElementInfo(
            id: idCounter, role: role, label: String(label.prefix(60)),
            position: [Int(pos.x), Int(pos.y)], size: [Int(sz.width), Int(sz.height)],
            center: [Int(pos.x + sz.width/2), Int(pos.y + sz.height/2)],
            actions: realActions, value: valStr
        ))
    }

    // Always traverse children
    var childrenVal: CFTypeRef?
    // For web areas, try navigation order first (better for Electron/Chromium content)
    if role == "AXWebArea" {
        AXUIElementCopyAttributeValue(el, "AXChildrenInNavigationOrder" as CFString, &childrenVal)
    }
    if childrenVal == nil {
        AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenVal)
    }
    guard let children = childrenVal as? [AXUIElement] else { return }
    for child in children { guard elements.count < maxEl else { break }; traverse(child, depth: depth-1) }
}

// App lookup: prefer exact name match, prefer regular apps over XPC services
func findApp(_ query: String) -> (pid_t, String)? {
    let apps = NSWorkspace.shared.runningApplications
    let q = query.lowercased()

    // Filter to apps matching the query
    var candidates = apps.filter { a in
        let name = (a.localizedName ?? "").lowercased()
        let bid = (a.bundleIdentifier ?? "").lowercased()
        return name == q || name.contains(q) || bid.contains(q)
    }

    // Prefer apps that are NOT XPC services / helpers
    // XPC services typically have names like "AppNameUIViewService", "AppName Helper", etc.
    let nonHelpers = candidates.filter { a in
        let name = (a.localizedName ?? "").lowercased()
        return !name.contains("helper") && !name.contains("service") &&
               !name.contains("xpc") && !name.contains("agent")
    }
    if !nonHelpers.isEmpty { candidates = nonHelpers }

    // Among remaining, prefer exact name match
    let exact = candidates.filter { ($0.localizedName ?? "").lowercased() == q }
    if let a = exact.first { return (a.processIdentifier, a.localizedName ?? "") }

    // Otherwise take first candidate
    if let a = candidates.first { return (a.processIdentifier, a.localizedName ?? "") }
    return nil
}

let arg = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
var targetPid: pid_t = 0
var appName: String = ""

if let pid = pid_t(arg) {
    targetPid = pid
    for a in NSWorkspace.shared.runningApplications {
        if a.processIdentifier == pid { appName = a.localizedName ?? ""; break }
    }
} else {
    if let (pid, name) = findApp(arg) {
        targetPid = pid; appName = name
    }
}
guard targetPid > 0 else { fputs("app not found: \(arg)\n", stderr); exit(1) }
fputs("targeting: \(appName) pid=\(targetPid)\n", stderr)

let appEl = AXUIElementCreateApplication(targetPid)

// Set AXManualAccessibility — activates Chromium/Electron AX bridge
// This is persistent within the target app's process lifetime
let r1 = AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, true as CFTypeRef)
let r2 = AXUIElementSetAttributeValue(appEl, "AXEnhancedUserInterface" as CFString, true as CFTypeRef)
fputs("AXManualAccessibility=\(r1.rawValue) AXEnhancedUserInterface=\(r2.rawValue)\n", stderr)

// Wait for Chromium AX bridge to initialize (only needed first time per session)
if r1.rawValue == 0 {
    Thread.sleep(forTimeInterval: 1.5)
} else {
    Thread.sleep(forTimeInterval: 0.1)
}

var winsVal: CFTypeRef?
guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &winsVal) == .success,
      let wins = winsVal as? [AXUIElement], !wins.isEmpty else {
    fputs("no windows found\n", stderr); exit(1)
}
fputs("windows: \(wins.count)\n", stderr)

for win in wins { guard elements.count < maxEl else { break }; traverse(win, depth: 30) }
fputs("elements: \(elements.count)\n", stderr)

print(String(data: try! JSONEncoder().encode(elements), encoding: .utf8)!)
