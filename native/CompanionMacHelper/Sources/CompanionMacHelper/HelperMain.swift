import AppKit
import ApplicationServices
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private let maxRequestBytes = 65_536
private let maxNodesCap = 120
private let maxDepthCap = 8
let protectedBundles: Set<String> = [
    "com.apple.loginwindow",
    "com.apple.SecurityAgent",
    "com.apple.loginwindow.LWBuiltIn"
]

private let responseLock = NSLock()

private final class CapturePrompt: @unchecked Sendable {
    private var asked = false
    private let lock = NSLock()

    func allowed(_ prompt: Bool) -> Bool {
        if CGPreflightScreenCaptureAccess() {
            return true
        }
        if !prompt {
            return false
        }
        lock.lock()
        let shouldAsk = !asked
        if shouldAsk {
            asked = true
        }
        lock.unlock()
        if shouldAsk {
            _ = CGRequestScreenCaptureAccess()
        }
        return CGPreflightScreenCaptureAccess()
    }
}

private let capturePrompt = CapturePrompt()
private let actionQueue = DispatchQueue(label: "com.companion.helper.actions")
private let actionGroup = DispatchGroup()

private final class CancelBox: @unchecked Sendable {
    private var ids: Set<String> = []
    private let lock = NSLock()

    func contains(_ id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return ids.contains(id)
    }

    func insert(_ id: String) {
        lock.lock()
        ids.insert(id)
        lock.unlock()
    }

    func remove(_ id: String) {
        lock.lock()
        ids.remove(id)
        lock.unlock()
    }
}

private let cancelledRequests = CancelBox()

private final class RequestBox: @unchecked Sendable {
    let id: String
    let method: String
    let params: [String: Any]
    init(id: String, method: String, params: [String: Any]) {
        self.id = id
        self.method = method
        self.params = params
    }
}

func helperRequestCancelled(_ id: String) -> Bool {
    cancelledRequests.contains(id)
}

private func markRequestCancelled(_ id: String) {
    cancelledRequests.insert(id)
}

private func clearRequestCancelled(_ id: String) {
    cancelledRequests.remove(id)
}

@main
enum HelperMain {
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let worker = DispatchQueue(label: "com.companion.helper.stdio")
        worker.async {
            sweepOldCaptures()
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
                if method == "desktop.cancel" {
                    if let target = params["requestId"] as? String, !target.isEmpty {
                        markRequestCancelled(target)
                    }
                    writeLine(ok(["accepted": true]).merging(["id": id, "version": 1]) { current, _ in current })
                    continue
                }
                let box = RequestBox(id: id, method: method, params: params)
                actionGroup.enter()
                actionQueue.async {
                    defer { actionGroup.leave() }
                    handle(box)
                }
            }
            actionGroup.wait()
            exit(0)
        }
        RunLoop.main.run()
    }
}

private func handle(_ box: RequestBox) {
    if helperRequestCancelled(box.id) {
        writeLine(fail(code: "aborted", message: "Stopped before the action.").merging(["id": box.id, "version": 1]) { current, _ in current })
        clearRequestCancelled(box.id)
        return
    }
    let result = dispatch(method: box.method, params: box.params, requestId: box.id)
    let acted = ((result["result"] as? [String: Any])?["acted"] as? Bool) == true
    let body: [String: Any]
    if helperRequestCancelled(box.id) && acted {
        body = fail(code: "uncertain", message: "That action may already have finished. I will not try it again.")
    } else if helperRequestCancelled(box.id) {
        body = fail(code: "aborted", message: "Stopped before the action.")
    } else {
        body = result
    }
    writeLine(body.merging(["id": box.id, "version": 1]) { current, _ in current })
    clearRequestCancelled(box.id)
}

private func dispatch(method: String, params: [String: Any], requestId: String) -> [String: Any] {
    if method == "screen.captureOnce" {
        return capture(params)
    }
    if method == "desktop.captureWindow" {
        return captureWindow(params, requestId: requestId)
    }
    return onMain { dispatchOnMain(method: method, params: params, requestId: requestId) }
}

private func dispatchOnMain(method: String, params: [String: Any], requestId: String) -> [String: Any] {
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
    case "desktop.listWindows":
        return listDesktopWindows(params)
    case "desktop.focusWindow":
        return focusDesktopWindow(params, requestId: requestId)
    case "desktop.observe":
        return observeDesktop(params, requestId: requestId)
    case "desktop.clickElement":
        return clickDesktopElement(params, requestId: requestId)
    case "desktop.setText":
        return setDesktopText(params, requestId: requestId)
    case "desktop.keyPress":
        return pressDesktopKey(params, requestId: requestId)
    case "desktop.scroll":
        return scrollDesktop(params, requestId: requestId)
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
        if !screenCaptureAllowed(prompt: params["prompt"] as? Bool == true) {
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
        let owned = content.windows.filter {
            $0.owningApplication?.processID == pid && $0.isOnScreen && $0.windowLayer == 0
        }
        let pool = owned.isEmpty
            ? content.windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen }
            : owned
        let titled = pool.filter { title.isEmpty || ($0.title ?? "") == title }
        let candidates = titled.isEmpty ? pool : titled
        guard let window = candidates.max(by: { lhs, rhs in
            lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
        }) else {
            return fail(code: "protected_context", message: "That window can't be captured.")
        }
        let shot = try await grabWindow(content: content, window: window)
        return ok([
            "byteLength": shot.image.width * shot.image.height * 4,
            "width": shot.image.width,
            "height": shot.image.height,
            "allBlack": false,
            "protected": false
        ])
    } catch let problem as CaptureProblem {
        return fail(code: problem.code, message: problem.message)
    } catch {
        return captureFailure(error)
    }
}

private func captureWindow(_ params: [String: Any], requestId: String) -> [String: Any] {
    guard params["consent"] as? Bool == true else {
        return fail(code: "capture_refused", message: "I won't look at your screen.")
    }
    if !screenCaptureAllowed(prompt: params["prompt"] as? Bool == true) {
        return fail(code: "capture_refused", message: "Screen Recording permission is not granted.")
    }
    let windowId = (params["windowId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let bundleId = (params["bundleId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let process = (params["processId"] as? NSNumber)?.intValue ?? -1
    guard process > 0, let cgId = UInt32(windowId), !bundleId.isEmpty else {
        return fail(code: "not_found", message: "That window is no longer open.")
    }
    if protectedBundles.contains(bundleId) {
        return fail(code: "protected_context", message: "I can't work with that secure screen.")
    }
    if helperRequestCancelled(requestId) {
        return fail(code: "aborted", message: "Stopped before the action.")
    }
    let box = ShotBox(fail(code: "capture_unavailable", message: "I couldn't take a screenshot."))
    let semaphore = DispatchSemaphore(value: 0)
    let pid = pid_t(process)
    Task.detached {
        let result = await takeWindowFile(requestId: requestId, windowId: cgId, pid: pid, bundleId: bundleId)
        box.value = result
        semaphore.signal()
    }
    semaphore.wait()
    return box.value
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

private struct CaptureProblem: Error {
    var code: String
    var message: String
}

private struct GrabbedShot {
    var image: CGImage
    var scale: Double
    var displayId: String
    var pointWidth: Double
    var pointHeight: Double
}

private func screenCaptureAllowed(prompt: Bool) -> Bool {
    capturePrompt.allowed(prompt)
}

private func captureFailure(_ error: Error) -> [String: Any] {
    let text = String(describing: error)
    if text.contains("-3801") || text.lowercased().contains("declined") {
        return fail(code: "capture_refused", message: "Screen Recording permission is not granted.")
    }
    return fail(code: "capture_unavailable", message: "I couldn't take a screenshot.")
}

private func permissionDenied(_ error: Error) -> Bool {
    let text = String(describing: error)
    return text.contains("-3801") || text.lowercased().contains("declined")
}

private func takeWindowFile(requestId: String, windowId: CGWindowID, pid: pid_t, bundleId: String) async -> [String: Any] {
    sweepOldCaptures()
    if helperRequestCancelled(requestId) {
        return fail(code: "aborted", message: "Stopped before the action.")
    }
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
            return fail(code: "not_found", message: "That window can't be captured.")
        }
        let owner = window.owningApplication
        if owner?.processID != pid || owner?.bundleIdentifier != bundleId {
            return fail(code: "focus_changed", message: "That was a different window, so I did not take a picture.")
        }
        if companionPids().contains(pid) || !window.isOnScreen {
            return fail(code: "not_found", message: "That window is no longer open.")
        }
        if sensitiveTitle(window.title ?? "") {
            return fail(code: "protected_context", message: "I can't work with that secure screen.")
        }
        if helperRequestCancelled(requestId) {
            return fail(code: "aborted", message: "Stopped before the action.")
        }
        let shot = try await grabWindow(content: content, window: window)
        if helperRequestCancelled(requestId) {
            return fail(code: "aborted", message: "Stopped before the action.")
        }
        guard let stored = writeCapture(shot.image) else {
            return fail(code: "capture_unavailable", message: "I couldn't keep that picture.")
        }
        if helperRequestCancelled(requestId) {
            try? FileManager.default.removeItem(at: stored.url)
            return fail(code: "aborted", message: "Stopped before the action.")
        }
        return ok([
            "windowId": String(window.windowID),
            "processId": Int(pid),
            "bundleId": bundleId,
            "title": clip(window.title ?? ""),
            "displayId": shot.displayId,
            "scale": shot.scale,
            "width": shot.image.width,
            "height": shot.image.height,
            "pointWidth": shot.pointWidth,
            "pointHeight": shot.pointHeight,
            "byteLength": stored.bytes,
            "filePath": stored.url.path,
            "directory": stored.directory.path,
            "blank": false,
            "protected": false
        ])
    } catch let problem as CaptureProblem {
        return fail(code: problem.code, message: problem.message)
    } catch {
        return captureFailure(error)
    }
}

private func grabWindow(content: SCShareableContent, window: SCWindow) async throws -> GrabbedShot {
    guard let display = displayFor(window: window, content: content) else {
        throw CaptureProblem(code: "capture_unavailable", message: "I couldn't tell which screen that window is on.")
    }
    let scale = resolvedScale(window: window)
    guard scale >= 1, scale <= 4 else {
        throw CaptureProblem(code: "capture_unavailable", message: "I couldn't tell the screen scale.")
    }
    let image = try await captureWindowImage(content: content, window: window, scale: scale)
    let fitted = fittedImage(image, maxEdge: 1280)
    if frameLooksBlank(fitted) {
        throw CaptureProblem(code: "protected_capture", message: "The capture was blank, so I discarded it.")
    }
    return GrabbedShot(
        image: fitted,
        scale: Double(scale),
        displayId: String(display.displayID),
        pointWidth: Double(window.frame.width),
        pointHeight: Double(window.frame.height)
    )
}

private func captureWindowImage(content: SCShareableContent, window: SCWindow, scale: CGFloat) async throws -> CGImage {
    let independent = SCContentFilter(desktopIndependentWindow: window)
    do {
        let image = try await renderShot(filter: independent, window: window, scale: scale, source: nil)
        if !frameLooksBlank(image) {
            return image
        }
    } catch {
        if permissionDenied(error) {
            throw error
        }
    }
    guard let display = displayFor(window: window, content: content) else {
        throw CaptureProblem(code: "protected_capture", message: "The capture was blank, so I discarded it.")
    }
    let filter = SCContentFilter(display: display, including: [window])
    if #available(macOS 14.2, *) {
        filter.includeMenuBar = false
    }
    let source = CGRect(
        x: window.frame.minX - display.frame.minX,
        y: window.frame.minY - display.frame.minY,
        width: window.frame.width,
        height: window.frame.height
    )
    let image = try await renderShot(filter: filter, window: window, scale: scale, source: source)
    if frameLooksBlank(image) {
        throw CaptureProblem(code: "protected_capture", message: "The capture was blank, so I discarded it.")
    }
    return image
}

private func renderShot(filter: SCContentFilter, window: SCWindow, scale: CGFloat, source: CGRect?) async throws -> CGImage {
    guard let size = outputSize(points: window.frame.size, scale: scale) else {
        throw CaptureProblem(code: "capture_unavailable", message: "I couldn't tell the screen scale.")
    }
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = false
    configuration.showsCursor = false
    configuration.scalesToFit = true
    configuration.preservesAspectRatio = true
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.width = size.width
    configuration.height = size.height
    if #available(macOS 15.0, *) {
        configuration.showMouseClicks = false
    }
    if let source, source.width > 1, source.height > 1 {
        configuration.sourceRect = source
    }
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
}

private func resolvedScale(window: SCWindow) -> CGFloat {
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let reported = CGFloat(filter.pointPixelScale)
    if reported.isFinite, reported >= 1, reported <= 4 {
        return reported
    }
    let frame = window.frame
    let backing = onMain { () -> CGFloat in
        let screen = NSScreen.screens.first { $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY)) }
            ?? NSScreen.screens.first { $0.frame.intersects(frame) }
        return screen?.backingScaleFactor ?? 0
    }
    if backing.isFinite, backing >= 1, backing <= 4 {
        return backing
    }
    return 0
}

private func outputSize(points: CGSize, scale: CGFloat) -> (width: Int, height: Int)? {
    guard scale.isFinite, scale >= 1, scale <= 4 else {
        return nil
    }
    var width = Int((points.width * scale).rounded())
    var height = Int((points.height * scale).rounded())
    if width < 2 || height < 2 {
        return nil
    }
    let longest = max(width, height)
    if longest > 1280 {
        let fit = 1280.0 / Double(longest)
        width = max(1, Int((Double(width) * fit).rounded()))
        height = max(1, Int((Double(height) * fit).rounded()))
    }
    return (width, height)
}

private func displayFor(window: SCWindow, content: SCShareableContent) -> SCDisplay? {
    let center = CGPoint(x: window.frame.midX, y: window.frame.midY)
    return content.displays.first { $0.frame.contains(center) }
        ?? content.displays.first { $0.frame.intersects(window.frame) }
}

private func frameLooksBlank(_ image: CGImage) -> Bool {
    let columns = 40
    let rows = 40
    guard let context = CGContext(
        data: nil,
        width: columns,
        height: rows,
        bitsPerComponent: 8,
        bytesPerRow: columns * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return true
    }
    context.interpolationQuality = .none
    context.draw(image, in: CGRect(x: 0, y: 0, width: columns, height: rows))
    guard let data = context.data else {
        return true
    }
    let pixels = data.bindMemory(to: UInt8.self, capacity: columns * rows * 4)
    var maxLuminance = 0
    for index in 0..<(columns * rows) {
        let offset = index * 4
        let alpha = Int(pixels[offset + 3])
        let luminance = alpha == 0
            ? 0
            : (Int(pixels[offset]) + Int(pixels[offset + 1]) + Int(pixels[offset + 2])) / 3
        maxLuminance = max(maxLuminance, luminance)
    }
    return maxLuminance < 16
}

private func fittedImage(_ image: CGImage, maxEdge: Int) -> CGImage {
    let longest = max(image.width, image.height)
    if longest <= maxEdge {
        return image
    }
    let fit = Double(maxEdge) / Double(longest)
    let width = max(1, Int((Double(image.width) * fit).rounded()))
    let height = max(1, Int((Double(image.height) * fit).rounded()))
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return image
    }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage() ?? image
}

private func writeCapture(_ image: CGImage) -> (url: URL, directory: URL, bytes: Int)? {
    guard let directory = try? captureDirectory() else {
        return nil
    }
    let url = directory.appendingPathComponent("\(UUID().uuidString).png")
    guard let bytes = writePng(image, to: url) else {
        return nil
    }
    return (url, directory, bytes)
}

private func captureDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("companion-captures", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    return directory
}

private func writePng(_ image: CGImage, to url: URL) -> Int? {
    FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        try? FileManager.default.removeItem(at: url)
        return nil
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        try? FileManager.default.removeItem(at: url)
        return nil
    }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    guard let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber else {
        try? FileManager.default.removeItem(at: url)
        return nil
    }
    let count = size.intValue
    if count <= 0 || count > 1_500_000 {
        try? FileManager.default.removeItem(at: url)
        return nil
    }
    return count
}

private func sweepOldCaptures() {
    guard let directory = try? captureDirectory() else {
        return
    }
    let cutoff = Date().addingTimeInterval(-120)
    guard let files = try? FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.contentModificationDateKey, .isSymbolicLinkKey],
        options: [.skipsHiddenFiles]
    ) else {
        return
    }
    for file in files where file.pathExtension == "png" {
        let values = try? file.resourceValues(forKeys: [.contentModificationDateKey, .isSymbolicLinkKey])
        if values?.isSymbolicLink == true {
            continue
        }
        if (values?.contentModificationDate ?? .distantPast) < cutoff {
            try? FileManager.default.removeItem(at: file)
        }
    }
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

private let desktopTextLimit = 500
private let desktopNodeCap = 120
private let desktopTextRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

private struct DesktopTarget {
    var id: String
    var name: String
    var role: String
    var enabled: Bool
    var value: String?
    var bounds: [String: Double]?
}

private struct DesktopMatch {
    var element: AXUIElement
    var role: String
    var name: String
    var enabled: Bool
}

private struct ResolvedWindow {
    var pid: pid_t
    var windowId: String
    var bundleId: String
    var title: String
    var element: AXUIElement
    var appName: String
}

private enum WindowPick {
    case ready(ResolvedWindow)
    case failed([String: Any])
}

private enum MatchPick {
    case ready(DesktopMatch)
    case failed([String: Any])
}

private struct DesktopKey {
    var code: CGKeyCode
    var shift: Bool
}

private func listDesktopWindows(_ params: [String: Any]) -> [String: Any] {
    let wanted = (params["bundleId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    var listed: [[String: Any]] = []
    for window in onScreenWindows() {
        if listed.count >= 40 {
            break
        }
        let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        if layer != 0 {
            continue
        }
        guard let pid = windowPid(window), let windowId = windowNumber(window) else {
            continue
        }
        if companionPids().contains(pid) {
            continue
        }
        let owner = window[kCGWindowOwnerName as String] as? String ?? ""
        if owner == "Window Server" || owner == "Dock" || owner == "Control Center" {
            continue
        }
        let running = NSRunningApplication(processIdentifier: pid)
        let bundleId = running?.bundleIdentifier
        if let bundleId, protectedBundles.contains(bundleId) {
            continue
        }
        if !wanted.isEmpty && bundleId != wanted {
            continue
        }
        let title = clip(window[kCGWindowName as String] as? String ?? "")
        if sensitiveTitle(title) {
            continue
        }
        var item: [String: Any] = [
            "windowId": windowId,
            "appName": clip(running?.localizedName ?? owner),
            "title": title,
            "processId": Int(pid)
        ]
        if let bundleId {
            item["bundleId"] = bundleId
        }
        listed.append(item)
    }
    return ok(["windows": listed])
}

private func focusDesktopWindow(_ params: [String: Any], requestId: String) -> [String: Any] {
    let windowId = (params["windowId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let bundleId = (params["bundleId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard AXIsProcessTrusted() else {
        return fail(code: "access_denied", message: "Accessibility permission is not granted.")
    }
    guard let cg = cgWindow(id: windowId), let pid = windowPid(cg) else {
        return fail(code: "not_found", message: "That window is no longer open.")
    }
    let running = NSRunningApplication(processIdentifier: pid)
    if running?.bundleIdentifier != bundleId || bundleId.isEmpty {
        return fail(code: "focus_changed", message: "That window is not in the app I expected.")
    }
    if protectedBundles.contains(bundleId) || sensitiveTitle(cg[kCGWindowName as String] as? String ?? "") {
        return fail(code: "protected_context", message: "I can't work with that secure screen.")
    }
    if helperRequestCancelled(requestId) {
        return fail(code: "aborted", message: "Stopped before the action.")
    }
    let title = cg[kCGWindowName as String] as? String ?? ""
    activateApp(pid)
    var raised = false
    if let element = matchingWindow(pid: pid, title: title) {
        raised = AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success
    }
    let front = NSWorkspace.shared.frontmostApplication
    let verified = front?.processIdentifier == pid && front?.bundleIdentifier == bundleId
    if !raised && !verified {
        return fail(code: "unsupported", message: "I couldn't bring that window forward.")
    }
    return ok([
        "acted": true,
        "verified": verified,
        "windowId": windowId,
        "processId": Int(pid),
        "bundleId": bundleId,
        "appName": clip(running?.localizedName ?? "")
    ])
}

private func observeDesktop(_ params: [String: Any], requestId: String) -> [String: Any] {
    guard AXIsProcessTrusted() else {
        return fail(code: "access_denied", message: "Accessibility permission is not granted.")
    }
    let requestedId = (params["windowId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let pid: pid_t
    let windowId: String
    let title: String
    let bundleId: String?
    let appName: String
    let element: AXUIElement?
    if !requestedId.isEmpty {
        guard let cg = cgWindow(id: requestedId), let owner = windowPid(cg) else {
            return fail(code: "not_found", message: "That window is no longer open.")
        }
        let running = NSRunningApplication(processIdentifier: owner)
        if let bundle = running?.bundleIdentifier, protectedBundles.contains(bundle) {
            return fail(code: "protected_context", message: "I can't work with that secure screen.")
        }
        let cgTitle = cg[kCGWindowName as String] as? String ?? ""
        if sensitiveTitle(cgTitle) {
            return fail(code: "protected_context", message: "I can't work with that secure screen.")
        }
        guard let matched = matchingWindow(pid: owner, title: cgTitle) else {
            return fail(code: "unsupported", message: "I can't find that window's controls.")
        }
        pid = owner
        windowId = requestedId
        title = cgTitle
        bundleId = running?.bundleIdentifier
        appName = running?.localizedName ?? ""
        element = matched
    } else {
        switch readForeground() {
        case let .denied(message):
            return fail(code: "access_denied", message: message)
        case let .protected(kind):
            return fail(code: "protected_context", message: "I can't work with that secure screen.", details: ["protection": kind])
        case let .ready(window):
            pid = window.processId
            title = window.title
            bundleId = window.bundleId
            appName = window.processName ?? ""
            element = window.element
            windowId = onScreenWindows().first { info in
                windowPid(info) == window.processId &&
                    (window.title.isEmpty || (info[kCGWindowName as String] as? String) == window.title)
            }.flatMap(windowNumber) ?? "pid:\(window.processId)"
        }
    }
    if helperRequestCancelled(requestId) {
        return fail(code: "aborted", message: "Stopped before the action.")
    }
    var targets: [DesktopTarget] = []
    var truncated = false
    var sawSecure = false
    if let element {
        walkDesktop(
            element,
            depth: maxDepthCap,
            into: &targets,
            sawSecure: &sawSecure,
            truncated: &truncated,
            requestId: requestId
        )
    }
    if sawSecure {
        return fail(code: "protected_context", message: "I can't work with that secure screen.", details: ["protection": "secure_field"])
    }
    if helperRequestCancelled(requestId) {
        return fail(code: "aborted", message: "Stopped before the action.")
    }
    var payload: [String: Any] = [
        "windowId": windowId,
        "processId": Int(pid),
        "appName": clip(appName),
        "title": clip(title),
        "protected": false,
        "truncated": truncated,
        "targets": targets.map { target -> [String: Any] in
            var item: [String: Any] = [
                "id": target.id,
                "role": target.role,
                "name": target.name,
                "enabled": target.enabled,
                "bounds": target.bounds ?? NSNull()
            ]
            if let value = target.value {
                item["value"] = value
            }
            return item
        }
    ]
    if let bundleId {
        payload["bundleId"] = bundleId
    }
    return ok(payload)
}

private func clickDesktopElement(_ params: [String: Any], requestId: String) -> [String: Any] {
    switch pickWindow(params) {
    case let .failed(body):
        return body
    case let .ready(window):
        switch oneMatch(root: window.element, name: params["name"] as? String ?? "", role: params["role"] as? String ?? "") {
        case let .failed(body):
            return body
        case let .ready(match):
            if helperRequestCancelled(requestId) {
                return fail(code: "aborted", message: "Stopped before the action.")
            }
            if !performPress(match.element, role: match.role) {
                return fail(code: "unsupported", message: "I couldn't press that control.")
            }
            return ok(["acted": true, "name": match.name, "role": match.role])
        }
    }
}

private func setDesktopText(_ params: [String: Any], requestId: String) -> [String: Any] {
    guard let text = params["text"] as? String else {
        return fail(code: "not_allowlisted", message: "I can type into a text field.")
    }
    if text.count > desktopTextLimit {
        return fail(code: "not_allowlisted", message: "That text is too long.")
    }
    let role = params["role"] as? String ?? ""
    if !desktopTextRoles.contains(role) {
        return fail(code: "not_allowlisted", message: "I can type into a text field.")
    }
    switch pickWindow(params) {
    case let .failed(body):
        return body
    case let .ready(window):
        switch oneMatch(root: window.element, name: params["name"] as? String ?? "", role: role) {
        case let .failed(body):
            return body
        case let .ready(match):
            if !desktopTextRoles.contains(match.role) {
                return fail(code: "not_allowlisted", message: "I can type into a text field.")
            }
            if helperRequestCancelled(requestId) {
                return fail(code: "aborted", message: "Stopped before the action.")
            }
            let setError = AXUIElementSetAttributeValue(match.element, kAXValueAttribute as CFString, text as CFTypeRef)
            if setError != .success {
                return fail(code: "unsupported", message: "I couldn't type into that field.")
            }
            let readBack = stringAttribute(match.element, kAXValueAttribute) ?? ""
            return ok([
                "acted": true,
                "verified": readBack == text,
                "name": match.name,
                "role": match.role,
                "value": clipText(readBack)
            ])
        }
    }
}

private func pressDesktopKey(_ params: [String: Any], requestId: String) -> [String: Any] {
    let chord = (params["chord"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    guard let key = desktopKey(chord) else {
        return fail(code: "not_allowlisted", message: "I can only press navigation keys.")
    }
    switch pickWindow(params) {
    case let .failed(body):
        return body
    case let .ready(window):
        let front = NSWorkspace.shared.frontmostApplication
        if front?.processIdentifier != window.pid || front?.bundleIdentifier != window.bundleId {
            return fail(code: "focus_changed", message: "That app is not in front, so I did not press a key.")
        }
        if helperRequestCancelled(requestId) {
            return fail(code: "aborted", message: "Stopped before the action.")
        }
        guard
            let down = CGEvent(keyboardEventSource: nil, virtualKey: key.code, keyDown: true),
            let up = CGEvent(keyboardEventSource: nil, virtualKey: key.code, keyDown: false)
        else {
            return fail(code: "unsupported", message: "I couldn't press that key.")
        }
        if key.shift {
            down.flags = .maskShift
            up.flags = .maskShift
        }
        down.postToPid(window.pid)
        up.postToPid(window.pid)
        return ok(["acted": true, "verified": false, "chord": chord])
    }
}

private func scrollDesktop(_ params: [String: Any], requestId: String) -> [String: Any] {
    let direction = (params["direction"] as? String)?.lowercased() ?? ""
    let amount = params["amount"] as? Int ?? 0
    if !["up", "down", "left", "right"].contains(direction) || amount < 1 || amount > 5 {
        return fail(code: "not_allowlisted", message: "I can scroll a short distance up, down, left, or right.")
    }
    switch pickWindow(params) {
    case let .failed(body):
        return body
    case let .ready(window):
        let vertical = direction == "up" || direction == "down"
        guard let bar = findScrollBar(root: window.element, vertical: vertical) else {
            return fail(code: "unsupported", message: "I can't find a scrollbar in that window.")
        }
        let before = numberAttribute(bar, "AXValue")
        let action = (direction == "down" || direction == "right") ? "AXIncrement" : "AXDecrement"
        var acted = false
        for _ in 0..<amount {
            if helperRequestCancelled(requestId) {
                return acted
                    ? ok(["acted": true, "verified": false])
                    : fail(code: "aborted", message: "Stopped before the action.")
            }
            if AXUIElementPerformAction(bar, action as CFString) != .success {
                break
            }
            acted = true
        }
        if !acted {
            return fail(code: "unsupported", message: "I couldn't scroll that window.")
        }
        let after = numberAttribute(bar, "AXValue")
        let verified = before != nil && after != nil && before != after
        return ok(["acted": true, "verified": verified])
    }
}

private func desktopKey(_ chord: String) -> DesktopKey? {
    // Virtual key codes match kVK_* in HIToolbox Events.h.
    switch chord {
    case "tab":
        return DesktopKey(code: 0x30, shift: false)
    case "shift+tab":
        return DesktopKey(code: 0x30, shift: true)
    case "escape":
        return DesktopKey(code: 0x35, shift: false)
    case "up":
        return DesktopKey(code: 0x7E, shift: false)
    case "down":
        return DesktopKey(code: 0x7D, shift: false)
    case "left":
        return DesktopKey(code: 0x7B, shift: false)
    case "right":
        return DesktopKey(code: 0x7C, shift: false)
    case "pageup":
        return DesktopKey(code: 0x74, shift: false)
    case "pagedown":
        return DesktopKey(code: 0x79, shift: false)
    case "home":
        return DesktopKey(code: 0x73, shift: false)
    case "end":
        return DesktopKey(code: 0x77, shift: false)
    default:
        return nil
    }
}

private func pickWindow(_ params: [String: Any]) -> WindowPick {
    guard AXIsProcessTrusted() else {
        return .failed(fail(code: "access_denied", message: "Accessibility permission is not granted."))
    }
    let windowId = (params["windowId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let bundleId = (params["bundleId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let processId = params["processId"] as? Int ?? 0
    if windowId.isEmpty || bundleId.isEmpty || processId <= 0 {
        return .failed(fail(code: "not_found", message: "I need the app and window before I can do that."))
    }
    guard let cg = cgWindow(id: windowId), let pid = windowPid(cg), pid == pid_t(processId) else {
        return .failed(fail(code: "focus_changed", message: "The window changed, so I did not continue."))
    }
    if protectedBundles.contains(bundleId) {
        return .failed(fail(code: "protected_context", message: "I can't work with that secure screen."))
    }
    if NSRunningApplication(processIdentifier: pid)?.bundleIdentifier != bundleId {
        return .failed(fail(code: "focus_changed", message: "The window changed, so I did not continue."))
    }
    let title = cg[kCGWindowName as String] as? String ?? ""
    if sensitiveTitle(title) {
        return .failed(fail(code: "protected_context", message: "I can't work with that secure screen."))
    }
    guard let element = matchingWindow(pid: pid, title: title) else {
        return .failed(fail(code: "unsupported", message: "I can't find that window's controls."))
    }
    let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
    return .ready(ResolvedWindow(
        pid: pid,
        windowId: windowId,
        bundleId: bundleId,
        title: title,
        element: element,
        appName: appName
    ))
}

private func oneMatch(root: AXUIElement, name: String, role: String) -> MatchPick {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if role.isEmpty {
        return .failed(fail(code: "not_found", message: "I can't find that control."))
    }
    let matchByRole = trimmed.isEmpty
    if matchByRole && !desktopTextRoles.contains(role) {
        return .failed(fail(code: "not_found", message: "That control doesn't have a name, so I didn't use it."))
    }
    if !matchByRole && sensitiveName(trimmed) {
        return .failed(fail(code: "protected_context", message: "I won't use a password field."))
    }
    var found: [DesktopMatch] = []
    var secure = false
    collectDesktopMatches(
        root,
        depth: maxDepthCap,
        name: trimmed,
        role: role,
        matchByRole: matchByRole,
        into: &found,
        secure: &secure
    )
    if secure {
        return .failed(fail(code: "protected_context", message: "I can't work with that secure screen.", details: ["protection": "secure_field"]))
    }
    if found.count > 1 {
        return .failed(fail(code: "ambiguous", message: "Which one should I use?"))
    }
    guard let match = found.first else {
        return .failed(fail(code: "not_found", message: "I can't find that control."))
    }
    if !match.enabled {
        return .failed(fail(code: "disabled", message: "That control is disabled, so I did not use it."))
    }
    return .ready(match)
}

private func collectDesktopMatches(
    _ element: AXUIElement,
    depth: Int,
    name: String,
    role: String,
    matchByRole: Bool,
    into found: inout [DesktopMatch],
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
    if axRole == role && (matchByRole || sameControlName(label, name)) {
        found.append(DesktopMatch(element: element, role: axRole, name: label, enabled: enabled))
    }
    if depth <= 0 {
        return
    }
    for child in childrenOf(element) ?? [] {
        collectDesktopMatches(
            child,
            depth: depth - 1,
            name: name,
            role: role,
            matchByRole: matchByRole,
            into: &found,
            secure: &secure
        )
        if secure {
            return
        }
    }
}

private func walkDesktop(
    _ element: AXUIElement,
    depth: Int,
    into targets: inout [DesktopTarget],
    sawSecure: inout Bool,
    truncated: inout Bool,
    requestId: String
) {
    if helperRequestCancelled(requestId) || sawSecure {
        return
    }
    if targets.count >= desktopNodeCap {
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
    if !container && role != "AXWindow" && role != "AXApplication" && role != "AXMenuBar" {
        var value: String?
        if desktopTextRoles.contains(role), let raw = stringAttribute(element, kAXValueAttribute) {
            value = clipText(raw)
        }
        targets.append(DesktopTarget(
            id: "node-\(targets.count)",
            name: name,
            role: role,
            enabled: enabled,
            value: value,
            bounds: boundsOf(element)
        ))
    }
    if depth <= 0 {
        return
    }
    guard let children = childrenOf(element) else {
        return
    }
    for child in children {
        if helperRequestCancelled(requestId) || sawSecure || targets.count >= desktopNodeCap {
            truncated = targets.count >= desktopNodeCap
            return
        }
        if let bounds = boundsOf(child), (bounds["width"] ?? 0) <= 0 || (bounds["height"] ?? 0) <= 0 {
            continue
        }
        walkDesktop(
            child,
            depth: depth - 1,
            into: &targets,
            sawSecure: &sawSecure,
            truncated: &truncated,
            requestId: requestId
        )
    }
}

private func findScrollBar(root: AXUIElement, vertical: Bool) -> AXUIElement? {
    var bars: [(AXUIElement, String)] = []
    gatherScrollBars(root, depth: maxDepthCap, into: &bars)
    let wanted = vertical ? "AXVerticalOrientation" : "AXHorizontalOrientation"
    let exact = bars.filter { $0.1 == wanted }
    if exact.count == 1 {
        return exact[0].0
    }
    if exact.isEmpty && bars.count == 1 {
        return bars[0].0
    }
    return nil
}

private func gatherScrollBars(_ element: AXUIElement, depth: Int, into bars: inout [(AXUIElement, String)]) {
    let role = stringAttribute(element, kAXRoleAttribute) ?? ""
    if role == "AXScrollBar" {
        bars.append((element, stringAttribute(element, "AXOrientation") ?? ""))
    }
    if depth <= 0 {
        return
    }
    for child in childrenOf(element) ?? [] {
        gatherScrollBars(child, depth: depth - 1, into: &bars)
    }
}

private func matchingWindow(pid: pid_t, title: String) -> AXUIElement? {
    let windows = axWindowList(AXUIElementCreateApplication(pid))
    if title.isEmpty {
        if windows.count == 1 {
            return windows[0]
        }
        return focusedWindow(pid: pid, title: title)
    }
    let matches = windows.filter { (stringAttribute($0, kAXTitleAttribute) ?? "") == title }
    if matches.count == 1 {
        return matches[0]
    }
    return focusedWindow(pid: pid, title: title)
}

private func focusedWindow(pid: pid_t, title: String) -> AXUIElement? {
    guard case let .ready(window) = readApp(pid: pid) else {
        return nil
    }
    if !title.isEmpty && window.title != title {
        return nil
    }
    return window.element
}

private func axWindowList(_ application: AXUIElement) -> [AXUIElement] {
    guard let raw = copyAttribute(application, "AXWindows") else {
        return []
    }
    return raw as? [AXUIElement] ?? []
}

private func onScreenWindows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}

private func cgWindow(id: String) -> [String: Any]? {
    onScreenWindows().first { windowNumber($0) == id }
}

private func windowNumber(_ window: [String: Any]) -> String? {
    guard let number = window[kCGWindowNumber as String] as? NSNumber else {
        return nil
    }
    return String(number.uint32Value)
}

private func windowPid(_ window: [String: Any]) -> pid_t? {
    guard let owner = window[kCGWindowOwnerPID as String] as? NSNumber else {
        return nil
    }
    let pid = pid_t(owner.int32Value)
    return pid > 0 ? pid : nil
}

private func numberAttribute(_ element: AXUIElement, _ attribute: String) -> Double? {
    guard let raw = copyAttribute(element, attribute) as? NSNumber else {
        return nil
    }
    return raw.doubleValue
}

private func sensitiveTitle(_ title: String) -> Bool {
    sensitiveName(title)
}

private func clipText(_ text: String) -> String {
    if text.count <= desktopTextLimit {
        return text
    }
    return String(text.prefix(desktopTextLimit))
}

private func writeError(id: String, code: String, message: String) {
    writeLine(fail(code: code, message: message).merging(["id": id, "version": 1]) { current, _ in current })
}

private func writeLine(_ object: [String: Any]) {
    responseLock.lock()
    defer { responseLock.unlock() }
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
