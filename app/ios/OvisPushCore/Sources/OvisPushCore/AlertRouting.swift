import Foundation

/// The destination fields of a PC's decrypted push payload (shared/push.ts PushPayload).
public struct AlertPayload: Decodable, Equatable {
    public let paneId: String?
    public let machineId: String?
    public let workspaceId: String?
    public let endpoint: String?
    public let serverId: String?

    public init(
        paneId: String? = nil,
        machineId: String? = nil,
        workspaceId: String? = nil,
        endpoint: String? = nil,
        serverId: String? = nil
    ) {
        self.paneId = paneId
        self.machineId = machineId
        self.workspaceId = workspaceId
        self.endpoint = endpoint
        self.serverId = serverId
    }

    enum CodingKeys: String, CodingKey {
        case paneId = "pane_id"
        case machineId = "machine_id"
        case workspaceId = "workspace_id"
        case endpoint
        case serverId = "server_id"
    }
}

/// How a tapped push alert lands: either delivered into the open page (`selection`, a JSON
/// "select-pane" object) or opened by loading `address` on the saved `pc`.
public struct AlertTap: Equatable {
    public let pc: String
    public let address: String?
    public let selection: String?

    public init(pc: String, address: String?, selection: String?) {
        self.pc = pc
        self.address = address
        self.selection = selection
    }
}

/// Resolves a decrypted push alert to a saved PC and pane, mirroring Android's PCStore alert routing.
public enum AlertRouting {
    private static let hostedShellOrigin = "https://app.ovis.sh"
    private static let queryValueAllowed = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~"
    )
    private static let jsWhitespace = CharacterSet.whitespacesAndNewlines.union(
        CharacterSet(charactersIn: "\u{FEFF}")
    )

    public static func decodePayload(_ data: Data) -> AlertPayload? {
        try? JSONDecoder().decode(AlertPayload.self, from: data)
    }

    public static func isServerID(_ value: String) -> Bool {
        value.count == 32 && value.utf8.allSatisfy { byte in
            (byte >= 48 && byte <= 57) || (byte >= 97 && byte <= 102)
        }
    }

    /// `scheme://host[:port]` of an http or https URL without default ports (80/443), or nil.
    public static func normalizedOrigin(of text: String) -> String? {
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let shownHost = host.contains(":") ? "[\(host)]" : host
        if let port = url.port,
           !((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) {
            return "\(scheme)://\(shownHost):\(port)"
        }
        return "\(scheme)://\(shownHost)"
    }

    public static func sameOrigin(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b,
              let originA = normalizedOrigin(of: a),
              let originB = normalizedOrigin(of: b) else { return false }
        return originA == originB
    }

    public static func scoped(_ key: String) -> Bool {
        guard let path = URLComponents(string: key)?.percentEncodedPath else { return false }
        return !path.isEmpty && path != "/"
    }

    /// Whether `urlString` is a page of the PC `key`: on its origin, and for a relay PC within its
    /// scope path segment by path segment, with no dot-segment or encoded-slash traversal.
    public static func belongs(_ urlString: String, to key: String) -> Bool {
        guard sameOrigin(urlString, key), let url = URL(string: urlString) else { return false }
        let scope = URLComponents(string: key)?.percentEncodedPath ?? ""
        if scope.isEmpty || scope == "/" { return true }
        guard scope.hasPrefix("/"), scope.hasSuffix("/"), cleanPath(scope) != nil,
              let rawPath = URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedPath,
              let path = cleanPath(rawPath) else { return false }
        return (path.hasSuffix("/") ? path : path + "/").hasPrefix(scope)
    }

    /// Whether `urlString` runs the app itself (and so accepts a `select-pane` message), rather than
    /// a markdown reader (`?read=` or `#read=` in the hosted shell), `/api/`, `/ws`, or a file.
    public static func appPage(_ urlString: String, key: String) -> Bool {
        guard let components = URLComponents(string: urlString) else { return false }
        let path = components.percentEncodedPath
        if path.hasPrefix("/api/") || path == "/ws" { return false }
        let last = path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        if last.contains(".") && last != "index.html" { return false }
        let search = components.percentEncodedQuery
        let fragment = components.percentEncodedFragment
        let fromFragment = scoped(key)
            && (search == nil || search!.isEmpty)
            && fragment != nil && !fragment!.isEmpty
        let read = queryValue(in: fromFragment ? fragment : search, name: "read")
        return read == nil || read!.trimmingCharacters(in: jsWhitespace).isEmpty
    }

    public static func encodedQueryValue(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: queryValueAllowed) ?? value
    }

    /// Resolves a pane alert to its saved PC key and chat URL (query for a direct PC, fragment for a
    /// relay PC on the hosted shell). Returns nil when the alert names no pane or no saved PC.
    public static func alertLink(
        saved: [String],
        storedKey: String?,
        serverId: String?,
        machine: String?,
        workspace: String?,
        pane: String?
    ) -> (pc: String, address: String)? {
        guard let pane, !pane.isEmpty else { return nil }
        let machineValue = (machine?.isEmpty == false ? machine! : "local")
        var query = "machine=" + encodedQueryValue(machineValue)
        if let workspace, !workspace.isEmpty {
            query += "&ws=" + encodedQueryValue(workspace)
        }
        query += "&pane=" + encodedQueryValue(pane) + "&view=chat"

        // Direct PC saved by its origin; the hosted shell's own origin is never a PC itself.
        if let storedKey, !scoped(storedKey),
           let origin = normalizedOrigin(of: storedKey),
           !sameOrigin(origin, hostedShellOrigin) {
            if saved.contains(storedKey) {
                return (storedKey, storedKey + "/?" + query)
            }
            if storedKey != origin, saved.contains(origin) {
                return (origin, origin + "/?" + query)
            }
        }

        // Relay PC on the hosted shell, matched by its relay ID.
        if let serverId, isServerID(serverId) {
            let scope = "\(hostedShellOrigin)/s/\(serverId)/"
            if saved.contains(scope) {
                // An endpoint remembered under another PC's direct address or another relay scope
                // must never be redirected onto this scope.
                let matchesScope = storedKey == nil
                    || storedKey == scope
                    || (!scoped(storedKey!) && sameOrigin(storedKey, scope))
                if matchesScope {
                    return (scope, scope + "#" + query)
                }
            }
        }

        // Relay PC whose endpoint was stored directly under its saved scope when server_id is absent.
        if let storedKey, scoped(storedKey), saved.contains(storedKey),
           sameOrigin(storedKey, hostedShellOrigin),
           serverId == nil || serverId!.isEmpty {
            let base = storedKey.hasSuffix("/") ? storedKey : storedKey + "/"
            return (storedKey, base + "#" + query)
        }

        return nil
    }

    /// Decides whether tapping an alert selects the pane inside the open page (`selection`) or
    /// navigates/switches to the alert's PC and URL (`address`).
    public static func alertTap(
        saved: [String],
        current: String?,
        shown: String?,
        storedKey: String?,
        serverId: String?,
        machine: String?,
        workspace: String?,
        pane: String?
    ) -> AlertTap? {
        guard let link = alertLink(
            saved: saved,
            storedKey: storedKey,
            serverId: serverId,
            machine: machine,
            workspace: workspace,
            pane: pane
        ) else { return nil }
        guard let current, link.pc == current,
              let shown, belongs(shown, to: current), appPage(shown, key: current) else {
            return AlertTap(pc: link.pc, address: link.address, selection: nil)
        }
        var selection: [String: String] = [
            "type": "select-pane",
            "pane_id": pane!,
            "machine_id": (machine?.isEmpty == false ? machine! : "local"),
            "view": "chat"
        ]
        if let workspace, !workspace.isEmpty {
            selection["workspace_id"] = workspace
        }
        guard let data = try? JSONSerialization.data(withJSONObject: selection, options: [.sortedKeys]),
              let raw = String(data: data, encoding: .utf8) else {
            return AlertTap(pc: link.pc, address: link.address, selection: nil)
        }
        let safe = raw
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return AlertTap(pc: link.pc, address: nil, selection: safe)
    }

    /// The script run in the open page with an AlertTap's `selection` JSON: dispatches
    /// `ovis-select-pane` on `window` (heard on plain http too, where `navigator.serviceWorker` is
    /// absent), falling back to a service worker message for older pages that do not cancel it.
    public static func selectionScript(_ selection: String) -> String {
        "(() => { const data = \(selection); "
            + "if (window.dispatchEvent(new MessageEvent('ovis-select-pane', { data, cancelable: true }))) { "
            + "const worker = navigator.serviceWorker; if (worker) worker.dispatchEvent(new MessageEvent('message', { data })); } })()"
    }

    private static func cleanPath(_ path: String) -> String? {
        if path.contains("\\") { return nil }
        let lower = path.lowercased()
        if lower.contains("%2f") || lower.contains("%5c") { return nil }
        guard let decoded = path.removingPercentEncoding, !decoded.contains("\\") else { return nil }
        let twice = decoded.lowercased()
        if twice.contains("%2e") || twice.contains("%2f") || twice.contains("%5c") { return nil }
        if decoded.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) {
            return nil
        }
        return path
    }

    private static func queryValue(in query: String?, name: String) -> String? {
        guard let query else { return nil }
        let body = query.hasPrefix("?") ? String(query.dropFirst()) : query
        for pair in body.split(separator: "&", omittingEmptySubsequences: false) {
            let text = String(pair)
            let keyPart: String
            let valuePart: String
            if let equals = text.firstIndex(of: "=") {
                keyPart = String(text[..<equals])
                valuePart = String(text[text.index(after: equals)...])
            } else {
                keyPart = text
                valuePart = ""
            }
            if formDecoded(keyPart) == name {
                return formDecoded(valuePart)
            }
        }
        return nil
    }

    private static func formDecoded(_ text: String) -> String {
        let spaced = text.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }
}
