import SwiftUI
import WebKit
import StoreKit
import Security

struct ChatContainer: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> ChatController { ChatController() }
    func updateUIViewController(_ controller: ChatController, context: Context) {}
}

@MainActor final class ChatController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private var web: WKWebView!
    private var updates: Task<Void, Never>?
    private var transactions: [String: StoreKit.Transaction] = [:]
    private var overlay: UIView?
    private let keyAccount = "openrouter-api-key"
    private var productId: String { Bundle.main.object(forInfoDictionaryKey: "PRODUCT_ID") as? String ?? "au.openchat.app.plus.monthly" }
    private var appURL: URL? { URL(string: Bundle.main.object(forInfoDictionaryKey: "APP_URL") as? String ?? "") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "native")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.translatesAutoresizingMaskIntoConstraints = false
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = .white
        web.scrollView.contentInsetAdjustmentBehavior = .never
        view.addSubview(web)
        NSLayoutConstraint.activate([web.topAnchor.constraint(equalTo: view.topAnchor), web.bottomAnchor.constraint(equalTo: view.bottomAnchor), web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        updates = Task { [weak self] in
            for await result in StoreKit.Transaction.updates {
                guard let self else { return }
                if case .verified(let transaction) = result { self.deliver(transaction, jws: result.jwsRepresentation) }
            }
        }
        load()
    }
    deinit { updates?.cancel() }
    @objc private func load() {
        overlay?.removeFromSuperview()
        guard let url = appURL, url.scheme == "https", let host = url.host, !host.hasSuffix(".example") else { showOffline("Set your deployed HTTPS app URL in the Xcode build settings."); return }
        web.load(URLRequest(url: url))
    }
    private func showOffline(_ message: String) {
        overlay?.removeFromSuperview()
        let stack = UIStackView(); stack.axis = .vertical; stack.spacing = 22; stack.alignment = .center
        let label = UILabel(); label.text = message; label.numberOfLines = 0; label.textAlignment = .center; label.textColor = .secondaryLabel
        let button = UIButton(type: .system); button.setTitle("Try again", for: .normal); button.addTarget(self, action: #selector(load), for: .touchUpInside)
        stack.addArrangedSubview(label); stack.addArrangedSubview(button); stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),stack.leadingAnchor.constraint(equalTo: view.leadingAnchor,constant: 30),stack.trailingAnchor.constraint(equalTo: view.trailingAnchor,constant: -30)])
        overlay = stack
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showOffline("Can’t connect right now. Check your connection and try again.") }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { overlay?.removeFromSuperview() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let expected = appURL else { decisionHandler(.cancel); return }
        if url.scheme == expected.scheme && url.host == expected.host && url.port == expected.port { decisionHandler(.allow); return }
        if navigationAction.navigationType == .linkActivated && ["https", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
        decisionHandler(.cancel)
    }
    private func emit(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.nativeEvent && window.nativeEvent(\(json));", completionHandler: nil)
    }
    private func deliver(_ transaction: StoreKit.Transaction, jws: String) {
        guard transaction.productID == productId else { return }
        transactions[String(transaction.id)] = transaction
        emit(["type":"purchase", "transactionId":String(transaction.id), "jws":jws])
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let expected = appURL,
              message.frameInfo.securityOrigin.protocol == expected.scheme,
              message.frameInfo.securityOrigin.host == expected.host,
              [0, expected.port ?? 443].contains(message.frameInfo.securityOrigin.port),
              let payload = message.body as? [String: Any], let action = payload["action"] as? String else { return }
        Task {
            do {
                switch action {
                case "loadKey": emit(["type":"key", "value":readKey() ?? ""])
                case "saveKey": try saveKey(payload["value"] as? String ?? "")
                case "products":
                    if let product = try await Product.products(for: [productId]).first { emit(["type":"product", "price":product.displayPrice]) }
                    else { emit(["type":"error", "message":"This subscription is not available yet."]) }
                case "purchase":
                    guard let token = payload["accountToken"] as? String, let uuid = UUID(uuidString: token), let product = try await Product.products(for: [productId]).first else { throw NativeError.unavailable }
                    let result = try await product.purchase(options: [.appAccountToken(uuid)])
                    switch result {
                    case .success(let verification):
                        if case .verified(let transaction) = verification { deliver(transaction, jws: verification.jwsRepresentation) }
                        else { throw NativeError.verification }
                    case .pending: emit(["type":"error", "message":"Purchase is pending Apple approval."])
                    case .userCancelled: emit(["type":"error", "message":"Purchase cancelled."])
                    @unknown default: throw NativeError.unavailable
                    }
                case "finish":
                    if let id = payload["transactionId"] as? String, let transaction = transactions[id] { await transaction.finish(); transactions[id] = nil }
                case "entitlements":
                    for await result in StoreKit.Transaction.currentEntitlements { if case .verified(let transaction) = result { deliver(transaction, jws: result.jwsRepresentation) } }
                case "restore":
                    try await AppStore.sync()
                    for await result in StoreKit.Transaction.currentEntitlements { if case .verified(let transaction) = result { deliver(transaction, jws: result.jwsRepresentation) } }
                    emit(["type":"restored"])
                case "manage":
                    if let scene = view.window?.windowScene { try await AppStore.showManageSubscriptions(in: scene) }
                case "export":
                    guard let value = payload["value"] as? String, value.utf8.count < 20_000_000 else { throw NativeError.unavailable }
                    let file = FileManager.default.temporaryDirectory.appendingPathComponent("open-chat-conversations.json")
                    try value.write(to: file, atomically: true, encoding: .utf8)
                    let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                    activity.popoverPresentationController?.sourceView = view
                    activity.popoverPresentationController?.sourceRect = CGRect(x:view.bounds.midX,y:view.bounds.midY,width:1,height:1)
                    activity.completionWithItemsHandler = { _,_,_,_ in try? FileManager.default.removeItem(at: file) }
                    present(activity, animated: true)
                default: break
                }
            } catch { emit(["type":"error", "message":"Could not complete this action. Please try again."]) }
        }
    }
    private var keyQuery: [String: Any] { [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:Bundle.main.bundleIdentifier ?? "au.openchat.app", kSecAttrAccount as String:keyAccount] }
    private func readKey() -> String? {
        var query = keyQuery; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    private func saveKey(_ value: String) throws {
        SecItemDelete(keyQuery as CFDictionary)
        guard !value.isEmpty else { return }
        var query = keyQuery; query[kSecValueData as String] = Data(value.utf8); query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw NativeError.unavailable }
    }
    enum NativeError: Error { case unavailable, verification }
}
