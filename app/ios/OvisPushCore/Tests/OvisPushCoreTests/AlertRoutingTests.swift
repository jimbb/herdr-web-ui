import Foundation
import XCTest
@testable import OvisPushCore

final class AlertRoutingTests: XCTestCase {
    private let id = "0123456789abcdef0123456789abcdef"
    private var scope: String { "https://app.ovis.sh/s/\(id)/" }
    private let home = "http://desktop.lan:7317"
    private let laptop = "https://laptop.example.ts.net"

    func testDecodesPushPayloadFields() {
        let json = """
            {"pane_id":"w1:p1","machine_id":"build box","workspace_id":"w1","endpoint":"https://push.ovis.sh/v1/push/abc","server_id":"0123456789abcdef0123456789abcdef","title":"Claude","body":"Needs input","tag":"pane-w1:p1"}
            """.data(using: .utf8)!
        let decoded = AlertRouting.decodePayload(json)
        XCTAssertEqual(
            decoded,
            AlertPayload(
                paneId: "w1:p1",
                machineId: "build box",
                workspaceId: "w1",
                endpoint: "https://push.ovis.sh/v1/push/abc",
                serverId: id
            )
        )
        XCTAssertEqual(AlertRouting.decodePayload(Data("{\"pane_id\":null}".utf8)), AlertPayload())
        XCTAssertNil(AlertRouting.decodePayload(Data("not json".utf8)))
    }

    func testOpensTappedAlertOnItsPaneInThePcThatSentIt() {
        let saved = [home, scope, laptop]
        let direct = AlertRouting.alertLink(saved: saved, storedKey: home, serverId: id, machine: nil, workspace: "w1", pane: "w1:p1")
        XCTAssertEqual(direct?.pc, home)
        XCTAssertEqual(direct?.address, "\(home)/?machine=local&ws=w1&pane=w1%3Ap1&view=chat")

        let remote = AlertRouting.alertLink(saved: saved, storedKey: home, serverId: nil, machine: "build box", workspace: nil, pane: "w2:p3")
        XCTAssertEqual(remote?.pc, home)
        XCTAssertEqual(remote?.address, "\(home)/?machine=build%20box&pane=w2%3Ap3&view=chat")

        let relayFromOrigin = AlertRouting.alertLink(saved: saved, storedKey: "https://app.ovis.sh", serverId: id, machine: "local", workspace: "w1", pane: "w1:p1")
        XCTAssertEqual(relayFromOrigin?.pc, scope)
        XCTAssertEqual(relayFromOrigin?.address, "\(scope)#machine=local&ws=w1&pane=w1%3Ap1&view=chat")

        let relayFromScope = AlertRouting.alertLink(saved: saved, storedKey: scope, serverId: id, machine: nil, workspace: "w1", pane: "w1:p1")
        XCTAssertEqual(relayFromScope?.pc, scope)
        XCTAssertEqual(relayFromScope?.address, "\(scope)#machine=local&ws=w1&pane=w1%3Ap1&view=chat")

        let relayFromScopeWithoutServerId = AlertRouting.alertLink(saved: saved, storedKey: scope, serverId: nil, machine: nil, workspace: nil, pane: "w1:p1")
        XCTAssertEqual(relayFromScopeWithoutServerId?.pc, scope)
        XCTAssertEqual(relayFromScopeWithoutServerId?.address, "\(scope)#machine=local&pane=w1%3Ap1&view=chat")

        let relayByIdOnly = AlertRouting.alertLink(saved: saved, storedKey: nil, serverId: id, machine: nil, workspace: nil, pane: "w1:p1")
        XCTAssertEqual(relayByIdOnly?.pc, scope)
        XCTAssertEqual(relayByIdOnly?.address, "\(scope)#machine=local&pane=w1%3Ap1&view=chat")

        XCTAssertEqual(
            AlertRouting.alertLink(saved: saved, storedKey: laptop, serverId: id, machine: nil, workspace: nil, pane: "w1:p1")?.pc,
            laptop
        )

        XCTAssertNil(AlertRouting.alertLink(saved: saved, storedKey: home, serverId: id, machine: nil, workspace: nil, pane: nil))
        XCTAssertNil(AlertRouting.alertLink(saved: saved, storedKey: home, serverId: id, machine: nil, workspace: nil, pane: ""))
        XCTAssertNil(AlertRouting.alertLink(saved: saved, storedKey: "http://forgotten.lan:7317", serverId: nil, machine: nil, workspace: nil, pane: "w1:p1"))
        XCTAssertNil(AlertRouting.alertLink(saved: saved, storedKey: nil, serverId: "fedcba9876543210fedcba9876543210", machine: nil, workspace: nil, pane: "w1:p1"))
        XCTAssertNil(AlertRouting.alertLink(saved: saved, storedKey: nil, serverId: "../evil", machine: nil, workspace: nil, pane: "w1:p1"))
        XCTAssertNil(AlertRouting.alertLink(saved: saved, storedKey: nil, serverId: nil, machine: nil, workspace: nil, pane: "w1:p1"))

        // A relay ID never moves an alert from a saved direct address or another relay scope.
        XCTAssertNil(AlertRouting.alertLink(saved: [scope], storedKey: "http://forgotten.lan:7317", serverId: id, machine: nil, workspace: nil, pane: "w1:p1"))
        let otherScope = "https://app.ovis.sh/s/fedcba9876543210fedcba9876543210/"
        XCTAssertNil(AlertRouting.alertLink(saved: [scope, otherScope], storedKey: otherScope, serverId: id, machine: nil, workspace: nil, pane: "w1:p1"))

        // The hosted shell's own origin is never matched as a direct PC.
        let withList = [home, scope, "https://app.ovis.sh"]
        let hosted = AlertRouting.alertLink(saved: withList, storedKey: "https://app.ovis.sh", serverId: id, machine: nil, workspace: nil, pane: "w1:p1")
        XCTAssertEqual(hosted?.pc, scope)
        XCTAssertEqual(hosted?.address, "\(scope)#machine=local&pane=w1%3Ap1&view=chat")
    }

    func testHandsTappedAlertToOpenPageOfItsPcAndOpensAnyOtherPc() throws {
        let saved = [home, scope, laptop, "https://app.ovis.sh"]
        let same = try XCTUnwrap(
            AlertRouting.alertTap(saved: saved, current: home, shown: "\(home)/?machine=local&pane=w1%3Ap0", storedKey: home, serverId: id, machine: nil, workspace: "w1", pane: "w1:p1")
        )
        XCTAssertNil(same.address)
        let selection = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(try XCTUnwrap(same.selection).utf8)) as? [String: String]
        )
        XCTAssertEqual(selection["type"], "select-pane")
        XCTAssertEqual(selection["pane_id"], "w1:p1")
        XCTAssertEqual(selection["machine_id"], "local")
        XCTAssertEqual(selection["view"], "chat")
        XCTAssertEqual(selection["workspace_id"], "w1")

        // A relay PC's page at its scope; special characters survive JSON encoding safely.
        let odd = "p\"); alert(1); //\u{2028}</script>"
        let relay = try XCTUnwrap(
            AlertRouting.alertTap(saved: saved, current: scope, shown: "\(scope)#machine=local", storedKey: scope, serverId: id, machine: "build box", workspace: nil, pane: odd)
        )
        XCTAssertNil(relay.address)
        let rawSelection = try XCTUnwrap(relay.selection)
        XCTAssertFalse(rawSelection.contains("\u{2028}"))
        let relaySelection = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(rawSelection.utf8)) as? [String: String]
        )
        XCTAssertEqual(relaySelection["pane_id"], odd)
        XCTAssertEqual(relaySelection["machine_id"], "build box")
        XCTAssertNil(relaySelection["workspace_id"])

        let other = try XCTUnwrap(
            AlertRouting.alertTap(saved: saved, current: laptop, shown: "\(laptop)/", storedKey: home, serverId: id, machine: nil, workspace: "w1", pane: "w1:p1")
        )
        XCTAssertNil(other.selection)
        XCTAssertEqual(other.pc, home)
        XCTAssertEqual(other.address, "\(home)/?machine=local&ws=w1&pane=w1%3Ap1&view=chat")

        for shown in [nil, "https://sso.example.com/login", scope] as [String?] {
            let opened = try XCTUnwrap(
                AlertRouting.alertTap(saved: saved, current: home, shown: shown, storedKey: home, serverId: id, machine: nil, workspace: nil, pane: "w1:p1")
            )
            XCTAssertNil(opened.selection, String(describing: shown))
            XCTAssertEqual(opened.address, "\(home)/?machine=local&pane=w1%3Ap1&view=chat")
        }

        XCTAssertNil(AlertRouting.alertTap(saved: saved, current: home, shown: "\(home)/", storedKey: "http://forgotten.lan:7317", serverId: nil, machine: nil, workspace: nil, pane: "w1:p1"))
        XCTAssertNil(AlertRouting.alertTap(saved: saved, current: home, shown: "\(home)/", storedKey: home, serverId: id, machine: nil, workspace: nil, pane: nil))
    }

    func testHandsTappedAlertOnlyToAnAppPageAndOpensAddressOverReaderOrFile() throws {
        let saved = [home, scope]
        let homeAddress = "\(home)/?machine=local&pane=w1%3Ap1&view=chat"
        let scopeAddress = "\(scope)#machine=local&pane=w1%3Ap1&view=chat"

        for shown in [
            home,
            "\(home)/",
            "\(home)/index.html",
            "\(home)/?machine=local&pane=w1%3Ap0",
            "\(home)/?read=",
            "\(home)/?read=+%20%C2%A0",
            "\(home)/#read=notes.md"
        ] {
            let tap = try XCTUnwrap(
                AlertRouting.alertTap(saved: saved, current: home, shown: shown, storedKey: home, serverId: nil, machine: nil, workspace: nil, pane: "w1:p1")
            )
            XCTAssertNotNil(tap.selection, shown)
            XCTAssertNil(tap.address, shown)
        }

        for shown in [scope, "\(scope)#machine=local&pane=w1%3Ap0", "\(scope)?machine=local#read=notes.md"] {
            let tap = try XCTUnwrap(
                AlertRouting.alertTap(saved: saved, current: scope, shown: shown, storedKey: scope, serverId: id, machine: nil, workspace: nil, pane: "w1:p1")
            )
            XCTAssertNotNil(tap.selection, shown)
            XCTAssertNil(tap.address, shown)
        }

        for shown in [
            "\(home)/?read=notes.md",
            "\(home)/?machine=local&read=docs%2Fa.md",
            "\(home)/?%72ead=notes.md",
            "\(home)/api/file?path=a.html",
            "\(home)/ws",
            "\(home)/social-preview.png",
            "\(home)/notes.md"
        ] {
            let tap = try XCTUnwrap(
                AlertRouting.alertTap(saved: saved, current: home, shown: shown, storedKey: home, serverId: nil, machine: nil, workspace: nil, pane: "w1:p1")
            )
            XCTAssertNil(tap.selection, shown)
            XCTAssertEqual(tap.address, homeAddress, shown)
        }

        for shown in ["\(scope)#read=notes.md", "\(scope)#machine=local&read=a.md", "\(scope)?read=notes.md"] {
            let tap = try XCTUnwrap(
                AlertRouting.alertTap(saved: saved, current: scope, shown: shown, storedKey: scope, serverId: id, machine: nil, workspace: nil, pane: "w1:p1")
            )
            XCTAssertNil(tap.selection, shown)
            XCTAssertEqual(tap.address, scopeAddress, shown)
        }
    }

    func testSelectionScriptDispatchesWindowEventWithWorkerFallback() {
        let script = AlertRouting.selectionScript("{\"pane_id\":\"t1\",\"type\":\"select-pane\"}")
        XCTAssertTrue(script.contains("ovis-select-pane"))
        XCTAssertTrue(script.contains("navigator.serviceWorker"))
        XCTAssertTrue(script.contains("cancelable: true"))
    }
}
