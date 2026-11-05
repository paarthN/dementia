import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

private let maxRequestBytes = 65_536
private let maxNodesCap = 120
private let maxDepthCap = 8
private let protectedBundles: Set<String> = [
    "com.apple.loginwindow",
    "com.apple.SecurityAgent",
    "com.apple.loginwindow.LWBuiltIn"
]

@main
enum HelperMain {
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let worker = DispatchQueue(label: "com.companion.helper.stdio")
        worker.async {
            while let line = readLine(strippingNewline: true) {
                if line.utf8.count > maxRequestBytes {
                    writeError(id: "rejected", code: "request_too_large", message: "That request is too large.")
                    continue
                }
                guard
                    let data = line.data(using: .utf8),
                    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let id = object["id"] as? String,
                    let version = object["version"] as? Int,
                    let method = object["method"] as? String
                else {
                    writeError(id: "rejected", code: "bad_request", message: "The request was not valid JSON.")
                    continue
                }
                if version != 1 {
                    writeError(id: id, code: "unsupported_version", message: "This helper speaks protocol version 1.")
                    continue
                }
                let params = object["params"] as? [String: Any] ?? [:]
                let result = dispatch(method: method, params: params)
                writeLine(result.merging(["id": id, "version": 1]) { current, _ in current })
            }
            exit(0)
        }
        RunLoop.main.run()
    }
}

private func dispatch(method: String, params: [String: Any]) -> [String: Any] {
    if method == "screen.captureOnce" {
        return capture(params)
    }
    return onMain { dispatchOnMain(method: method, params: params) }
}

private func dispatchOnMain(method: String, params: [String: Any]) -> [String: Any] {
    switch method {
    case "system.ping":
        return ok(["pong": true])
    case "system.promptAccessibility":
        return ok(["trusted": promptAccessibility()])
    case "system.getForegroundWindow":
        return foregroundResponse()
    case "ui.inspectForeground":
        return inspect(
            params,
            depth: bounded(params["depth"], default: 4, cap: maxDepthCap),
            maxNodes: bounded(params["maxNodes"], default: 80, cap: maxNodesCap)
        )
    case "ui.findElement", "ui.readElementState":
        return find(params)
    case "ui.invokeElement":
        return invoke(params)
    default:
        return fail(code: "unknown_method", message: "That helper method is not available.")
    }
}

private func promptAccessibility() -> Bool {
    // The SDK exports this key as mutable global state, which Swift 6 rejects.
    // The header value is the string AXTrustedCheckOptionPrompt.
    let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

private func foregroundResponse() -> [String: Any] {
    guard AXIsProcessTrusted() else {
        return fail(code: "access_denied", message: "Accessibility permission is not granted.")
    }
    switch readForeground() {
    case let .denied(message):
        return fail(code: "access_denied", message: message)
    case let .protected(kind):
        return fail(code: "protected_context", message: "I can't work with that secure screen.", details: ["protection": kind])
    case let .ready(window):
        return ok(window.payload(controls: [], truncated: false))
    }
}

private func inspect(_ params: [String: Any] = [:], depth: Int, maxNodes: Int) -> [String: Any] {
    guard AXIsProcessTrusted() else {
        return fail(code: "access_denied", message: "Accessibility permission is not granted.")
    }
    switch targetApp(params, bringForward: params["bringForward"] as? Bool == true) {
    case let .denied(message):
        return fail(code: "access_denied", message: message)
    case let .protected(kind):
        return fail(code: "protected_context", message: "I can't work with that secure screen.", details: ["protection": kind])
    case let .ready(window):
        var controls: [[String: Any]] = []
        var truncated = false
        var sawSecure = false
        if let element = window.element {
            let windowBudget = max(0, maxNodes - 16)
            walk(element, depth: depth, into: &controls, maxNodes: windowBudget, truncated: &truncated, sawSecure: &sawSecure)
        }
        if let menu = menuBar(window.application), !sawSecure {
            appendMenuBar(menu, into: &controls, maxNodes: maxNodes, truncated: &truncated, sawSecure: &sawSecure)
        }
        if sawSecure {
            return fail(code: "protected_context", message: "I can't work with that secure screen.", details: ["protection": "secure_field"])
        }
        return ok(window.payload(controls: controls, truncated: truncated))
    }
}

private func appendMenuBar(
    _ menu: AXUIElement,
    into controls: inout [[String: Any]],
    maxNodes: Int,
    truncated: inout Bool,
    sawSecure: inout Bool
) {
    walk(menu, depth: 0, into: &controls, maxNodes: maxNodes, truncated: &truncated, sawSecure: &sawSecure)
    guard let items = childrenOf(menu) else {
        return
    }
    for item in items {
        if sawSecure || controls.count >= maxNodes {
            truncated = controls.count >= maxNodes
            return
        }
        walk(item, depth: 0, into: &controls, maxNodes: maxNodes, truncated: &truncated, sawSecure: &sawSecure)
        for popup in childrenOf(item) ?? [] {
            guard
                let popupBounds = boundsOf(popup),
                (popupBounds["height"] ?? 0) > 1,
                (popupBounds["width"] ?? 0) > 1
            else {
                continue
            }
            walk(popup, depth: 3, into: &controls, maxNodes: maxNodes, truncated: &truncated, sawSecure: &sawSecure)
        }
    }
}

private func menuBar(_ application: AXUIElement) -> AXUIElement? {
    if let menu = childrenOf(application)?.first(where: { stringAttribute($0, kAXRoleAttribute) == "AXMenuBar" }) {
        return menu
    }
    if let raw = copyAttribute(application, kAXMenuBarAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() {
        return (raw as! AXUIElement)
    }
    return nil
}

private func invoke(_ params: [String: Any]) -> [String: Any] {
    guard AXIsProcessTrusted() else {
        return fail(code: "access_denied", message: "Accessibility permission is not granted.")
    }
    let name = (params["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if name.isEmpty {
        return fail(code: "not_found", message: "What should I press?")
    }
    if sensitiveName(name) {
        return fail(code: "protected_context", message: "I won't press a password field.")
    }
    let role = params["role"] as? String
    let text = params["text"] as? String
    switch targetApp(params, bringForward: true) {
    case let .denied(message):
        return fail(code: "access_denied", message: message)
    case let .protected(kind):
        return fail(code: "protected_context", message: "I can't work with that secure screen.", details: ["protection": kind])
    case let .ready(window):
        var found: [AXUIElement] = []
        var sawSecure = false
        if let element = window.element {
            collectMatches(element, depth: maxDepthCap, name: name, role: role, into: &found, secure: &sawSecure)
        }
        if let menu = menuBar(window.application), !sawSecure {
            collectMenuMatches(menu, name: name, role: role, into: &found, secure: &sawSecure)
        }
        if sawSecure {
            return fail(code: "protected_context", message: "I can't work with that secure screen.", details: ["protection": "secure_field"])
        }
        if found.isEmpty {
            return fail(code: "not_found", message: "I can't find \(name) on this screen.")
        }
        if found.count > 1 {
            return fail(code: "ambiguous", message: "Which one should I use?")
        }
        let target = found[0]
        let axRole = stringAttribute(target, kAXRoleAttribute) ?? ""
        let label = labelOf(target, role: axRole)
        if let text, !text.isEmpty {
            let textRoles = ["AXTextField", "AXTextArea", "AXComboBox"]
            if !textRoles.contains(axRole) {
                return fail(code: "not_allowlisted", message: "I can type into a text field.")
            }
            let setError = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, text as CFTypeRef)
            if setError != .success {
                return fail(code: "not_allowlisted", message: "I couldn't type into that field.")
            }
            return ok(["typed": true, "changed": true, "name": label, "role": axRole])
        }
        if !performPress(target, role: axRole) {
            return fail(code: "not_allowlisted", message: "I couldn't press that control.")
        }
        return ok(["pressed": true, "changed": true, "name": label, "role": axRole])
    }
}

private func collectMenuMatches(
    _ menu: AXUIElement,
    name: String,
    role: String?,
    into found: inout [AXUIElement],
    secure: inout Bool
) {
    collectMatches(menu, depth: 0, name: name, role: role, into: &found, secure: &secure)
    guard let items = childrenOf(menu) else {
        return
    }
    for item in items {
        if secure {
            return
        }
        collectMatches(item, depth: 0, name: name, role: role, into: &found, secure: &secure)
        for popup in childrenOf(item) ?? [] {
            guard
                let popupBounds = boundsOf(popup),
                (popupBounds["height"] ?? 0) > 1,
                (popupBounds["width"] ?? 0) > 1
            else {
                continue
            }
            collectMatches(popup, depth: 3, name: name, role: role, into: &found, secure: &secure)
        }
    }
}

private func collectMatches(
    _ element: AXUIElement,
    depth: Int,
    name: String,
    role: String?,
    into found: inout [AXUIElement],
    secure: inout Bool
) {
    if secure {
        return
    }
    let axRole = stringAttribute(element, kAXRoleAttribute) ?? ""
    let subrole = stringAttribute(element, kAXSubroleAttribute) ?? ""
    if axRole == "AXSecureTextField" || subrole == "AXSecureTextField" || subrole == (kAXSecureTextFieldSubrole as String) {
        secure = true
        return
    }
    let label = labelOf(element, role: axRole)
    let enabled = boolAttribute(element, kAXEnabledAttribute) ?? true
    let skipped = axRole == "AXWindow" || axRole == "AXMenuBar" || axRole == "AXApplication"
    if enabled && !skipped && sameControlName(label, name) && (role == nil || role == axRole) {
        found.append(element)
    }
    if depth <= 0 {
        return
    }
    for child in childrenOf(element) ?? [] {
        collectMatches(child, depth: depth - 1, name: name, role: role, into: &found, secure: &secure)
        if secure {
            return
        }
    }
}

private func sameControlName(_ actual: String, _ expected: String) -> Bool {
    func norm(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: ".…"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let wanted = norm(expected)
    return !wanted.isEmpty && norm(actual) == wanted
}

private func sensitiveName(_ value: String) -> Bool {
    let lower = value.lowercased()
    if lower.contains("password") || lower.contains("passcode") {
        return true
    }
    return lower.range(of: "\\bpin\\b", options: .regularExpression) != nil
}

private func find(_ params: [String: Any]) -> [String: Any] {
    let inspected = inspect(depth: maxDepthCap, maxNodes: maxNodesCap)
    guard inspected["ok"] as? Bool == true, let result = inspected["result"] as? [String: Any] else {
        return inspected
    }
    let controls = result["controls"] as? [[String: Any]] ?? []
    let name = (params["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let role = params["role"] as? String
    let match = controls.first { control in
        let controlRole = control["role"] as? String
        let controlName = (control["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let roleMatches = role == nil || role == controlRole
        let nameMatches = name == nil || name?.isEmpty == true || controlName == name
        return roleMatches && nameMatches
    }
    if let match {
        return ok(match)
    }
    return fail(code: "not_found", message: "I can't reliably find that button.")
}

private func capture(_ params: [String: Any]) -> [String: Any] {
    guard params["consent"] as? Bool == true else {
        return fail(code: "capture_refused", message: "I won't look at your screen.")
    }
    let foreground = onMain { () -> ForegroundRead in
        guard AXIsProcessTrusted() else {
            return .denied("Accessibility permission is not granted.")
        }
        return readForeground()
    }
    switch foreground {
    case .protected:
        return fail(code: "protected_context", message: "I can't work with that secure screen.")
    case let .denied(message):
        return fail(code: "access_denied", message: message)
    case let .ready(window):
        if !CGPreflightScreenCaptureAccess() {
            if params["prompt"] as? Bool == true {
                _ = CGRequestScreenCaptureAccess()
            }
            return fail(code: "capture_refused", message: "Screen Recording permission is not granted.")
        }
        let box = ShotBox(fail(code: "capture_unavailable", message: "I couldn't take a screenshot."))
        let semaphore = DispatchSemaphore(value: 0)
        let pid = window.processId
        let title = window.title
        Task.detached {
            let result = await takeShot(pid: pid, title: title)
            box.value = result
            semaphore.signal()
        }
        semaphore.wait()
        return box.value
    }
}

private final class ShotBox: @unchecked Sendable {
    var value: [String: Any]
    init(_ value: [String: Any]) {
        self.value = value
    }
}

private func takeShot(pid: pid_t, title: String) async -> [String: Any] {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { candidate in
            candidate.owningApplication?.processID == pid && (title.isEmpty || candidate.title == title)
        }) ?? content.windows.first(where: { $0.owningApplication?.processID == pid }) else {
            return fail(code: "protected_context", message: "That window can't be captured.")
        }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = false
        configuration.showsCursor = false
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = max(1, Int(window.frame.width * scale))
        configuration.height = max(1, Int(window.frame.height * scale))
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        let black = imageIsMostlyBlack(image)
        let bytes = image.bytesPerRow * image.height
        if black {
            return fail(code: "protected_capture", message: "The capture was blank, so I discarded it.")
        }
        return ok([
            "byteLength": bytes,
            "width": image.width,
            "height": image.height,
            "allBlack": false,
            "protected": false
        ])
    } catch {
        let text = String(describing: error)
        if text.contains("-3801") || text.lowercased().contains("declined") {
            return fail(code: "capture_refused", message: "Screen Recording permission is not granted.")
        }
        return fail(code: "capture_unavailable", message: "I couldn't take a screenshot.")
    }
}

private enum ForegroundRead {
    case ready(ForegroundWindow)
    case protected(String)
    case denied(String)
}

private struct ForegroundWindow {
    var element: AXUIElement?
    var application: AXUIElement
    var title: String
    var processId: pid_t
    var bundleId: String?
    var processName: String?
    var bounds: [String: Double]?

    func payload(controls: [[String: Any]], truncated: Bool) -> [String: Any] {
        let named = controls.contains { (($0["name"] as? String) ?? "").trimmingCharacters(in: .whitespaces).isEmpty == false }
        var result: [String: Any] = [
            "snapshotId": "snap-\(processId)-\(abs(title.hashValue))",
            "windowId": "pid:\(processId)",
            "title": title,
            "processId": Int(processId),
            "bounds": bounds ?? NSNull(),
            "protected": false,
            "metadataMissing": title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !named,
            "automationDenied": false,
            "controls": controls,
            "truncated": truncated
        ]
        if let bundleId {
            result["bundleId"] = bundleId
        }
        if let processName {
            result["processName"] = processName
        }
        return result
    }
}

private func companionPids() -> Set<pid_t> {
    [getpid(), getppid()]
}

private func appBehindCompanion() -> pid_t? {
    let skip = companionPids()
    guard
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else {
        return nil
    }
    for window in windows {
        let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        if layer != 0 {
            continue
        }
        guard let owner = window[kCGWindowOwnerPID as String] as? NSNumber else {
            continue
        }
        let pid = pid_t(owner.int32Value)
        if pid <= 0 || skip.contains(pid) {
            continue
        }
        let name = window[kCGWindowOwnerName as String] as? String ?? ""
        if name == "Window Server" || name == "Dock" || name == "Control Center" {
            continue
        }
        return pid
    }
    return nil
}

private func activateApp(_ pid: pid_t) {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        _ = app.setActivationPolicy(.accessory)
        _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
        RunLoop.current.run(until: Date().addingTimeInterval(0.35))
        _ = app.setActivationPolicy(.prohibited)
    }
}

private func performPress(_ element: AXUIElement, role: String) -> Bool {
    if AXUIElementPerformAction(element, "AXPress" as CFString) == .success {
        return true
    }
    if role == "AXMenuBarItem" || role == "AXMenuItem" || role == "AXMenuButton" || role == "AXPopUpButton" {
        return AXUIElementPerformAction(element, "AXShowMenu" as CFString) == .success
    }
    return false
}

private func targetApp(_ params: [String: Any], bringForward: Bool) -> ForegroundRead {
    let requested = params["processId"] as? Int ?? 0
    var read = requested > 0 ? readApp(pid: pid_t(requested)) : readForeground()
    if bringForward, case let .ready(window) = read {
        activateApp(window.processId)
        read = readApp(pid: window.processId)
    }
    return read
}

private func readForeground() -> ForegroundRead {
    let system = AXUIElementCreateSystemWide()
    var appRef: CFTypeRef?
    let appError = AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &appRef)
    if appError == .apiDisabled {
        return .denied("Accessibility permission is not granted.")
    }

    var application: AXUIElement?
    var pid: pid_t = 0
    if appError == .success, let appRaw = appRef {
        let focused = appRaw as! AXUIElement
        if AXUIElementGetPid(focused, &pid) == .success {
            application = focused
        }
    }
    if application == nil, let front = NSWorkspace.shared.frontmostApplication {
        pid = front.processIdentifier
        application = AXUIElementCreateApplication(pid)
    }
    guard let application else {
        return .denied("I couldn't read the front app.")
    }
    if companionPids().contains(pid), let other = appBehindCompanion() {
        return readApp(pid: other)
    }
    return readApp(pid: pid, application: application)
}

private func readApp(pid: pid_t, application given: AXUIElement? = nil) -> ForegroundRead {
    let application = given ?? AXUIElementCreateApplication(pid)
    let running = NSRunningApplication(processIdentifier: pid)
    let bundleId = running?.bundleIdentifier
    if let bundleId, protectedBundles.contains(bundleId) {
        let kind = bundleId == "com.apple.loginwindow" ? "lock_screen" : "password"
        return .protected(kind)
    }

    var windowRef: CFTypeRef?
    let windowError = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &windowRef)
    if windowError == .apiDisabled {
        return .denied("Accessibility permission is not granted.")
    }
    if windowError == .cannotComplete {
        return .protected("tcc")
    }
    let window = windowError == .success ? (windowRef as! AXUIElement) : nil
    let title = window.flatMap { stringAttribute($0, kAXTitleAttribute) } ?? ""
    let subrole = window.flatMap { stringAttribute($0, kAXSubroleAttribute) } ?? ""
    if subrole == "AXSecureTextField" || subrole == (kAXSecureTextFieldSubrole as String) {
        return .protected("secure_field")
    }
    if subrole == (kAXSystemDialogSubrole as String), title.lowercased().contains("password") {
        return .protected("password")
    }
    return .ready(ForegroundWindow(
        element: window ?? application,
        application: application,
        title: title,
        processId: pid,
        bundleId: bundleId,
        processName: running?.localizedName,
        bounds: window.flatMap(boundsOf)
    ))
}

private func walk(
    _ element: AXUIElement,
    depth: Int,
    into controls: inout [[String: Any]],
    maxNodes: Int,
    truncated: inout Bool,
    sawSecure: inout Bool
) {
    if controls.count >= maxNodes {
        truncated = true
        return
    }
    let role = stringAttribute(element, kAXRoleAttribute) ?? ""
    let subrole = stringAttribute(element, kAXSubroleAttribute) ?? ""
    if role == "AXSecureTextField" || subrole == "AXSecureTextField" || subrole == (kAXSecureTextFieldSubrole as String) {
        sawSecure = true
        return
    }
    let name = labelOf(element, role: role)
    let enabled = boolAttribute(element, kAXEnabledAttribute) ?? true
    let container = name.isEmpty && [
        "AXGroup", "AXScrollArea", "AXSplitGroup", "AXRow", "AXCell", "AXLayoutArea",
        "AXList", "AXOutline", "AXScrollBar", "AXSplitter", "AXToolbar"
    ].contains(role)
    if !container {
        controls.append([
            "id": "node-\(controls.count)",
            "name": name,
            "role": role,
            "enabled": enabled,
            "offscreen": false,
            "bounds": boundsOf(element) ?? NSNull()
        ])
    }
    if depth <= 0 {
        return
    }
    guard let children = childrenOf(element) else {
        return
    }
    for child in children {
        if let bounds = boundsOf(child), (bounds["width"] ?? 0) <= 0 || (bounds["height"] ?? 0) <= 0 {
            continue
        }
        walk(child, depth: depth - 1, into: &controls, maxNodes: maxNodes, truncated: &truncated, sawSecure: &sawSecure)
        if sawSecure || controls.count >= maxNodes {
            truncated = controls.count >= maxNodes
            return
        }
    }
}

private func labelOf(_ element: AXUIElement, role: String) -> String {
    let title = stringAttribute(element, kAXTitleAttribute)
    if let title, !title.isEmpty {
        return clip(title)
    }
    let description = stringAttribute(element, kAXDescriptionAttribute)
    if let description, !description.isEmpty {
        return clip(description)
    }
    let valueRoles = [
        "AXStaticText", "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
        "AXMenuButton", "AXCell", "AXRow", "AXSlider", "AXLink"
    ]
    if valueRoles.contains(role), let value = stringAttribute(element, kAXValueAttribute), !value.isEmpty {
        return clip(value)
    }
    return ""
}

private func clip(_ text: String) -> String {
    if text.count <= 80 {
        return text
    }
    return String(text.prefix(80))
}

private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let raw = copyAttribute(element, attribute) else {
        return nil
    }
    return raw as? String
}

private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
    guard let raw = copyAttribute(element, attribute) else {
        return nil
    }
    return raw as? Bool
}

private func childrenOf(_ element: AXUIElement) -> [AXUIElement]? {
    guard let raw = copyAttribute(element, kAXChildrenAttribute) else {
        return nil
    }
    return raw as? [AXUIElement]
}

private func boundsOf(_ element: AXUIElement) -> [String: Double]? {
    guard
        let position = copyAttribute(element, kAXPositionAttribute),
        let size = copyAttribute(element, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(),
        CFGetTypeID(size) == AXValueGetTypeID()
    else {
        return nil
    }
    let positionValue = position as! AXValue
    let sizeValue = size as! AXValue
    var point = CGPoint.zero
    var cgSize = CGSize.zero
    guard
        AXValueGetType(positionValue) == .cgPoint,
        AXValueGetType(sizeValue) == .cgSize,
        AXValueGetValue(positionValue, .cgPoint, &point),
        AXValueGetValue(sizeValue, .cgSize, &cgSize)
    else {
        return nil
    }
    return ["x": point.x, "y": point.y, "width": cgSize.width, "height": cgSize.height]
}

private func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if error != .success {
        return nil
    }
    return value
}

private func imageIsMostlyBlack(_ image: CGImage) -> Bool {
    guard let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else {
        return true
    }
    let length = CFDataGetLength(data)
    if length == 0 {
        return true
    }
    let step = max(1, length / 2_000)
    var dark = 0
    var samples = 0
    var index = 0
    while index < length {
        if bytes[index] < 8 {
            dark += 1
        }
        samples += 1
        index += step
    }
    return samples > 0 && dark * 100 / samples > 97
}

private func bounded(_ value: Any?, default fallback: Int, cap: Int) -> Int {
    let parsed = value as? Int ?? fallback
    return min(max(parsed, 1), cap)
}

private func ok(_ result: [String: Any]) -> [String: Any] {
    ["ok": true, "result": result]
}

private func fail(code: String, message: String, details: [String: Any]? = nil) -> [String: Any] {
    var error: [String: Any] = ["code": code, "message": message]
    if let details {
        error["details"] = details
    }
    return ["ok": false, "error": error]
}

private func writeError(id: String, code: String, message: String) {
    writeLine(fail(code: code, message: message).merging(["id": id, "version": 1]) { current, _ in current })
}

private func writeLine(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else {
        fputs("{\"id\":\"rejected\",\"version\":1,\"ok\":false,\"error\":{\"code\":\"bad_response\",\"message\":\"The helper could not encode a response.\"}}\n", stdout)
        return
    }
    fputs(text, stdout)
    fputs("\n", stdout)
    fflush(stdout)
}

private func onMain<T>(_ body: @escaping () -> T) -> T {
    if Thread.isMainThread {
        return body()
    }
    return DispatchQueue.main.sync(execute: body)
}
