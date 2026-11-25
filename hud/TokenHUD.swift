import AppKit
import Foundation

// MARK: - Shared Config & Metrics

struct MonitorSettings: Codable {
    var planName: String = "Google AI Pro"
    var googleAccount: String = ""
    var contextLimit: Double = 1_000_000
    var fiveHourTokenBudget: Double = 8_000_000
    var weeklyTokenBudget: Double = 30_000_000
    var inputPricePerM: Double = 1.25
    var cachePricePerM: Double = 0.31
    var outputPricePerM: Double = 5.0
}

struct TurnPoint {
    let input: Double
    let cacheRead: Double
    let output: Double
    let timestamp: TimeInterval
}

struct LiveSnapshot {
    let conversationTitle: String
    let model: String
    let contextUsed: Double
    let contextRemaining: Double
    let contextRatio: Double
    let cacheHitRate: Double
    let fiveHourUsed: Double
    let fiveHourRemaining: Double
    let fiveHourRatio: Double
    let fiveHourTurns: Int
    let weeklyUsed: Double
    let weeklyRemaining: Double
    let weeklyRatio: Double
    let weeklyTurns: Int
    let recentTurns: [TurnPoint]
    let updatedAt: Date
}

enum LocalDataReader {
    static let settingsURL: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".gemini/config/plugin-data/context-token-monitor/settings.json")
    }()

    static let brainURL: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".gemini/antigravity/brain")
    }()

    static func loadSettings() -> MonitorSettings {
        guard let data = try? Data(contentsOf: settingsURL),
              let decoded = try? JSONDecoder().decode(MonitorSettings.self, from: data) else {
            return MonitorSettings()
        }
        return decoded
    }

    static func saveSettings(_ settings: MonitorSettings) {
        let dir = settingsURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(settings) {
            try? data.write(to: settingsURL, options: .atomic)
        }
    }

    /// Safely detects active Google account via official gcloud CLI if installed (no browser cookie/token access).
    static func detectGcloudAccount() -> String? {
        let candidates = [
            "/opt/homebrew/bin/gcloud",
            "/usr/local/bin/gcloud",
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("google-cloud-sdk/bin/gcloud").path
        ]
        guard let bin = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return nil
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bin)
        proc.arguments = ["config", "get-value", "account"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return nil }
            let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if out.contains("@") && !out.contains("unset") {
                return out
            }
        } catch {
            return nil
        }
        return nil
    }

    static func readLiveSnapshot(settings: MonitorSettings) -> LiveSnapshot {
        let now = Date()
        let nowTs = now.timeIntervalSince1970
        let fiveHoursAgo = nowTs - 5 * 3600
        let sevenDaysAgo = nowTs - 7 * 24 * 3600

        let isoWithFrac = ISO8601DateFormatter()
        isoWithFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoBasic = ISO8601DateFormatter()
        isoBasic.formatOptions = [.withInternetDateTime]

        var bestMtime: Date = .distantPast
        var activeTitle = "等待会话…"
        var activeModel = "-"
        var activeLatestInput: Double = 0
        var activeTotalInput: Double = 0
        var activeTotalCache: Double = 0
        var activeTurns: [TurnPoint] = []

        var fiveHUsed: Double = 0
        var fiveHTurns = 0
        var weekUsed: Double = 0
        var weekTurns = 0

        if let dirs = try? FileManager.default.contentsOfDirectory(
            at: brainURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) {
            for dir in dirs {
                let transcript = dir.appendingPathComponent(".system_generated/logs/transcript.jsonl")
                guard FileManager.default.fileExists(atPath: transcript.path),
                      let attrs = try? FileManager.default.attributesOfItem(atPath: transcript.path),
                      let mtime = attrs[.modificationDate] as? Date,
                      let content = try? String(contentsOf: transcript, encoding: .utf8) else {
                    continue
                }

                var convTitle = ""
                var convModel = "-"
                var convLatestInput: Double = 0
                var convTotalInput: Double = 0
                var convTotalCache: Double = 0
                var convTurns: [TurnPoint] = []

                for line in content.split(separator: "\n") {
                    guard let data = line.data(using: .utf8),
                          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let type = obj["type"] as? String else {
                        continue
                    }

                    if type == "USER_INPUT", convTitle.isEmpty, let raw = obj["content"] as? String {
                        let cleaned = raw
                            .replacingOccurrences(of: "<USER_REQUEST>", with: "")
                            .replacingOccurrences(of: "</USER_REQUEST>", with: "")
                            .replacingOccurrences(of: "\n", with: " ")
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        convTitle = String(cleaned.prefix(36))
                    } else if type == "PLANNER_RESPONSE" {
                        let uncached = (obj["input_tokens"] as? NSNumber)?.doubleValue ?? 0
                        let cache = (obj["cache_read_tokens"] as? NSNumber)?.doubleValue ?? 0
                        let out = (obj["output_tokens"] as? NSNumber)?.doubleValue ?? 0
                        let totalIn = uncached + cache
                        if let m = obj["model"] as? String, !m.isEmpty {
                            convModel = m
                        }
                        if totalIn > 0 {
                            convLatestInput = totalIn
                        }
                        convTotalInput += totalIn
                        convTotalCache += cache

                        var ts = mtime.timeIntervalSince1970
                        if let created = obj["created_at"] as? String {
                            if let d = isoWithFrac.date(from: created) ?? isoBasic.date(from: created) {
                                ts = d.timeIntervalSince1970
                            }
                        }

                        // Weighted effective tokens: uncached*1 + cache*0.1 + output*4
                        let effTurn = uncached + cache * 0.1 + out * 4.0
                        if ts >= fiveHoursAgo {
                            fiveHUsed += effTurn
                            fiveHTurns += 1
                        }
                        if ts >= sevenDaysAgo {
                            weekUsed += effTurn
                            weekTurns += 1
                        }
                        convTurns.append(TurnPoint(input: totalIn, cacheRead: cache, output: out, timestamp: ts))
                    }
                }

                if mtime > bestMtime && !convTurns.isEmpty {
                    bestMtime = mtime
                    activeTitle = convTitle.isEmpty ? String(dir.lastPathComponent.prefix(12)) : convTitle
                    activeModel = convModel
                    activeLatestInput = convLatestInput
                    activeTotalInput = convTotalInput
                    activeTotalCache = convTotalCache
                    activeTurns = Array(convTurns.suffix(24))
                }
            }
        }

        let ctxRem = max(0, settings.contextLimit - activeLatestInput)
        let ctxRatio = settings.contextLimit > 0 ? activeLatestInput / settings.contextLimit : 0
        let cacheRate = activeTotalInput > 0 ? activeTotalCache / activeTotalInput : 0
        let fiveHRem = max(0, settings.fiveHourTokenBudget - fiveHUsed)
        let fiveHRatio = settings.fiveHourTokenBudget > 0 ? fiveHUsed / settings.fiveHourTokenBudget : 0
        let weekRem = max(0, settings.weeklyTokenBudget - weekUsed)
        let weekRatio = settings.weeklyTokenBudget > 0 ? weekUsed / settings.weeklyTokenBudget : 0

        return LiveSnapshot(
            conversationTitle: activeTitle,
            model: activeModel,
            contextUsed: activeLatestInput,
            contextRemaining: ctxRem,
            contextRatio: ctxRatio,
            cacheHitRate: cacheRate,
            fiveHourUsed: fiveHUsed,
            fiveHourRemaining: fiveHRem,
            fiveHourRatio: fiveHRatio,
            fiveHourTurns: fiveHTurns,
            weeklyUsed: weekUsed,
            weeklyRemaining: weekRem,
            weeklyRatio: weekRatio,
            weeklyTurns: weekTurns,
            recentTurns: activeTurns,
            updatedAt: now
        )
    }
}

func fmtTokens(_ n: Double) -> String {
    if n >= 1_000_000 { return String(format: "%.2fM", n / 1_000_000) }
    if n >= 1_000 { return String(format: "%.1fK", n / 1_000) }
    return String(Int(n))
}

func toneColor(ratio: Double) -> NSColor {
    if ratio >= 0.85 { return NSColor(red: 0.97, green: 0.35, blue: 0.33, alpha: 1) }
    if ratio >= 0.65 { return NSColor(red: 0.95, green: 0.72, blue: 0.22, alpha: 1) }
    return NSColor(red: 0.25, green: 0.82, blue: 0.48, alpha: 1)
}

// MARK: - Mini Progress Ring

final class RingGaugeView: NSView {
    var ratio: Double = 0 { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        let radius = min(bounds.width, bounds.height) / 2 - 2.5

        let bgPath = NSBezierPath()
        bgPath.appendArc(withCenter: center, radius: radius, startAngle: 0, endAngle: 360)
        bgPath.lineWidth = 2.6
        NSColor.white.withAlphaComponent(0.16).setStroke()
        bgPath.stroke()

        let clamped = max(0, min(1, ratio))
        if clamped > 0.005 {
            let fgPath = NSBezierPath()
            fgPath.appendArc(
                withCenter: center,
                radius: radius,
                startAngle: 90,
                endAngle: 90 - CGFloat(clamped * 360),
                clockwise: true
            )
            fgPath.lineWidth = 2.6
            fgPath.lineCapStyle = .round
            toneColor(ratio: ratio).setStroke()
            fgPath.stroke()
        }
    }
}

// MARK: - Mini Bar

final class MiniBarView: NSView {
    var ratio: Double = 0 { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        let bg = NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2)
        NSColor.white.withAlphaComponent(0.14).setFill()
        bg.fill()

        let w = max(2, bounds.width * CGFloat(max(0, min(1, ratio))))
        let fillRect = CGRect(x: 0, y: 0, width: w, height: bounds.height)
        let fg = NSBezierPath(roundedRect: fillRect, xRadius: bounds.height / 2, yRadius: bounds.height / 2)
        toneColor(ratio: ratio).setFill()
        fg.fill()
    }
}

// MARK: - Sparkline View

final class SparklineView: NSView {
    var turns: [TurnPoint] = [] { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.withAlphaComponent(0.05).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
        guard !turns.isEmpty else { return }

        let maxVal = max(turns.map { $0.input }.max() ?? 1000, 1000)
        let pad: CGFloat = 6
        let innerW = bounds.width - pad * 2
        let innerH = bounds.height - pad * 2
        let stepX = innerW / CGFloat(turns.count)
        let barW = max(3, min(12, stepX - 2))

        for (i, t) in turns.enumerated() {
            let x = pad + CGFloat(i) * stepX + (stepX - barW) / 2
            let totalH = max(2, innerH * CGFloat(t.input / maxVal))
            let cacheH = max(0, innerH * CGFloat(min(t.cacheRead, t.input) / maxVal))

            NSColor(red: 0.35, green: 0.65, blue: 1.0, alpha: 0.72).setFill()
            NSBezierPath(roundedRect: CGRect(x: x, y: pad, width: barW, height: totalH), xRadius: 2, yRadius: 2).fill()

            if cacheH > 1 {
                NSColor(red: 0.25, green: 0.82, blue: 0.48, alpha: 0.92).setFill()
                NSBezierPath(roundedRect: CGRect(x: x, y: pad, width: barW, height: cacheH), xRadius: 2, yRadius: 2).fill()
            }
        }
    }
}

// MARK: - Top Floating HUD Window

final class TopHUDWindow: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class HUDRootView: NSView {
    private let compactHeight: CGFloat = 48
    private let expandedHeight: CGFloat = 320
    private(set) var isExpanded = false

    private let ring = RingGaugeView(frame: CGRect(x: 0, y: 0, width: 24, height: 24))
    private let planBadge = NSTextField(labelWithString: "Pro")
    private let ctxLabel = NSTextField(labelWithString: "上下文 剩 --")
    private let fiveHLabel = NSTextField(labelWithString: "5h 剩 --")
    private let fiveHBar = MiniBarView(frame: CGRect(x: 0, y: 0, width: 48, height: 5))
    private let weekLabel = NSTextField(labelWithString: "7d 剩 --")
    private let weekBar = MiniBarView(frame: CGRect(x: 0, y: 0, width: 48, height: 5))
    private let cacheLabel = NSTextField(labelWithString: "缓存 --%")
    private let expandBtn = NSButton(title: "▾", target: nil, action: nil)
    private let closeBtn = NSButton(title: "✕", target: nil, action: nil)

    // Detail area
    private let detailContainer = NSView()
    private let accountField = NSTextField()
    private let syncAccountBtn = NSButton(title: "同步 gcloud", target: nil, action: nil)
    private let presetProBtn = NSButton(title: "Pro 预设", target: nil, action: nil)
    private let presetUltraBtn = NSButton(title: "Ultra 预设", target: nil, action: nil)
    private let detailStatsLabel = NSTextField(labelWithString: "")
    private let sparkline = SparklineView()
    private let fiveHInput = NSTextField()
    private let weekInput = NSTextField()
    private let saveBtn = NSButton(title: "保存额度", target: nil, action: nil)
    private let quitBtn = NSButton(title: "彻底退出", target: nil, action: nil)

    var onToggleExpand: ((Bool) -> Void)?
    var onSaveSettings: ((MonitorSettings) -> Void)?
    var onSyncGcloud: (() -> String?)?
    var onHideToMenuBar: (() -> Void)?
    var onQuitApp: (() -> Void)?

    private var currentSettings = MonitorSettings()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor

        let blur = NSVisualEffectView(frame: bounds)
        blur.autoresizingMask = [.width, .height]
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        addSubview(blur)

        let tint = NSView(frame: bounds)
        tint.autoresizingMask = [.width, .height]
        tint.wantsLayer = true
        tint.layer?.backgroundColor = NSColor(red: 0.08, green: 0.10, blue: 0.14, alpha: 0.94).cgColor
        addSubview(tint)

        layer?.borderWidth = 1.2
        layer?.borderColor = NSColor.white.withAlphaComponent(0.28).cgColor

        setupCompactBar()
        setupDetailSection()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func styleCapsuleLabel(_ lbl: NSTextField, size: CGFloat = 12, weight: NSFont.Weight = .medium, color: NSColor = .white) {
        lbl.font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
        lbl.textColor = color
        lbl.lineBreakMode = .byTruncatingTail
    }

    private func setupCompactBar() {
        let bar = NSView(frame: CGRect(x: 0, y: bounds.height - compactHeight, width: bounds.width, height: compactHeight))
        bar.autoresizingMask = [.width, .minYMargin]

        planBadge.font = NSFont.systemFont(ofSize: 12, weight: .bold)
        planBadge.textColor = NSColor(red: 0.56, green: 0.85, blue: 1.0, alpha: 1)
        planBadge.wantsLayer = true
        planBadge.layer?.backgroundColor = NSColor(red: 0.18, green: 0.45, blue: 0.85, alpha: 0.35).cgColor
        planBadge.layer?.cornerRadius = 6

        styleCapsuleLabel(ctxLabel, size: 13, weight: .semibold, color: .white)
        styleCapsuleLabel(fiveHLabel, size: 12.5, weight: .semibold, color: .white)
        styleCapsuleLabel(weekLabel, size: 12.5, weight: .semibold, color: .white)
        styleCapsuleLabel(cacheLabel, size: 12.5, weight: .medium, color: NSColor(white: 0.90, alpha: 1))

        expandBtn.bezelStyle = .inline
        expandBtn.isBordered = false
        expandBtn.font = NSFont.systemFont(ofSize: 15, weight: .bold)
        expandBtn.contentTintColor = .white
        expandBtn.toolTip = "展开 / 收起详情"
        expandBtn.target = self
        expandBtn.action = #selector(toggleExpand)

        closeBtn.bezelStyle = .inline
        closeBtn.isBordered = false
        closeBtn.font = NSFont.systemFont(ofSize: 13, weight: .bold)
        closeBtn.contentTintColor = NSColor(white: 0.85, alpha: 1)
        closeBtn.toolTip = "隐藏外挂条（可在菜单栏重新打开）"
        closeBtn.target = self
        closeBtn.action = #selector(hideHUD)

        ring.translatesAutoresizingMaskIntoConstraints = false
        fiveHBar.translatesAutoresizingMaskIntoConstraints = false
        weekBar.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            ring.widthAnchor.constraint(equalToConstant: 24),
            ring.heightAnchor.constraint(equalToConstant: 24),
            fiveHBar.widthAnchor.constraint(equalToConstant: 64),
            fiveHBar.heightAnchor.constraint(equalToConstant: 6),
            weekBar.widthAnchor.constraint(equalToConstant: 64),
            weekBar.heightAnchor.constraint(equalToConstant: 6),
        ])

        let sep1 = makeDivider()
        let sep2 = makeDivider()
        let sep3 = makeDivider()

        let fiveHStack = NSStackView(views: [fiveHLabel, fiveHBar])
        fiveHStack.orientation = .vertical
        fiveHStack.alignment = .leading
        fiveHStack.spacing = 2

        let weekStack = NSStackView(views: [weekLabel, weekBar])
        weekStack.orientation = .vertical
        weekStack.alignment = .leading
        weekStack.spacing = 2

        let row = NSStackView(views: [
            planBadge, ring, ctxLabel, sep1, fiveHStack, sep2, weekStack, sep3, cacheLabel, NSView(), expandBtn, closeBtn
        ])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 10)
        row.frame = bar.bounds
        row.autoresizingMask = [.width, .height]
        bar.addSubview(row)
        addSubview(bar)
    }

    private func makeDivider() -> NSView {
        let v = NSView()
        v.wantsLayer = true
        v.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.14).cgColor
        v.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            v.widthAnchor.constraint(equalToConstant: 1),
            v.heightAnchor.constraint(equalToConstant: 18),
        ])
        return v
    }

    private func setupDetailSection() {
        detailContainer.frame = CGRect(x: 12, y: 10, width: bounds.width - 24, height: expandedHeight - compactHeight - 16)
        detailContainer.autoresizingMask = [.width, .height]
        detailContainer.isHidden = true

        detailStatsLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .medium)
        detailStatsLabel.textColor = .white
        detailStatsLabel.maximumNumberOfLines = 3
        detailStatsLabel.lineBreakMode = .byWordWrapping
        detailStatsLabel.frame = CGRect(x: 0, y: 196, width: detailContainer.bounds.width, height: 58)
        detailStatsLabel.autoresizingMask = [.width, .minYMargin]

        sparkline.frame = CGRect(x: 0, y: 120, width: detailContainer.bounds.width, height: 68)
        sparkline.autoresizingMask = [.width, .minYMargin]

        let acctTitle = NSTextField(labelWithString: "Google 账号:")
        acctTitle.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
        acctTitle.textColor = NSColor(white: 0.90, alpha: 1)
        acctTitle.frame = CGRect(x: 0, y: 80, width: 84, height: 22)

        accountField.placeholderString = "输入或点击同步本机 gcloud 账号"
        accountField.font = NSFont.systemFont(ofSize: 12.5)
        accountField.textColor = .white
        accountField.backgroundColor = NSColor(red: 0.13, green: 0.16, blue: 0.21, alpha: 1)
        accountField.frame = CGRect(x: 86, y: 78, width: 245, height: 24)

        for btn in [syncAccountBtn, presetProBtn, presetUltraBtn, saveBtn, quitBtn] {
            btn.bezelStyle = .rounded
            btn.controlSize = .regular
            btn.target = self
        }
        syncAccountBtn.frame = CGRect(x: 340, y: 77, width: 102, height: 26)
        syncAccountBtn.action = #selector(syncGcloud)

        presetProBtn.frame = CGRect(x: 448, y: 77, width: 88, height: 26)
        presetProBtn.action = #selector(applyProPreset)

        presetUltraBtn.frame = CGRect(x: 542, y: 77, width: 96, height: 26)
        presetUltraBtn.action = #selector(applyUltraPreset)

        let l5 = NSTextField(labelWithString: "5h 预算:")
        l5.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
        l5.textColor = NSColor(white: 0.90, alpha: 1)
        l5.frame = CGRect(x: 0, y: 40, width: 60, height: 22)
        fiveHInput.font = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .medium)
        fiveHInput.textColor = .white
        fiveHInput.backgroundColor = NSColor(red: 0.13, green: 0.16, blue: 0.21, alpha: 1)
        fiveHInput.frame = CGRect(x: 62, y: 38, width: 126, height: 24)

        let l7 = NSTextField(labelWithString: "7d 预算:")
        l7.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
        l7.textColor = NSColor(white: 0.90, alpha: 1)
        l7.frame = CGRect(x: 198, y: 40, width: 60, height: 22)
        weekInput.font = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .medium)
        weekInput.textColor = .white
        weekInput.backgroundColor = NSColor(red: 0.13, green: 0.16, blue: 0.21, alpha: 1)
        weekInput.frame = CGRect(x: 260, y: 38, width: 130, height: 24)

        saveBtn.frame = CGRect(x: 402, y: 37, width: 108, height: 26)
        saveBtn.action = #selector(saveBudget)

        quitBtn.frame = CGRect(x: 518, y: 37, width: 120, height: 26)
        quitBtn.action = #selector(quitFromPanel)

        let note = NSTextField(labelWithString: "提示：Google AI Pro 采用动态 5h + 每周额度，此处基于本地 transcript.jsonl 实时统计；官方精确余量请以 /quota 为准。")
        note.font = NSFont.systemFont(ofSize: 11.5)
        note.textColor = NSColor(white: 0.72, alpha: 1)
        note.frame = CGRect(x: 0, y: 4, width: detailContainer.bounds.width, height: 24)
        note.autoresizingMask = [.width]

        [detailStatsLabel, sparkline, acctTitle, accountField, syncAccountBtn, presetProBtn, presetUltraBtn, l5, fiveHInput, l7, weekInput, saveBtn, quitBtn, note]
            .forEach { detailContainer.addSubview($0) }
        addSubview(detailContainer)
    }

    func update(snapshot: LiveSnapshot, settings: MonitorSettings) {
        currentSettings = settings
        let shortPlan = settings.planName.replacingOccurrences(of: "Google AI ", with: "")
        let acctShort = settings.googleAccount.isEmpty ? "" : " · \(settings.googleAccount.split(separator: "@").first ?? "")"
        planBadge.stringValue = " \(shortPlan)\(acctShort) "

        ring.ratio = snapshot.contextRatio
        ctxLabel.stringValue = "上下文 剩 \(fmtTokens(snapshot.contextRemaining))"
        fiveHLabel.stringValue = "5h 剩 \(fmtTokens(snapshot.fiveHourRemaining))"
        fiveHBar.ratio = snapshot.fiveHourRatio
        weekLabel.stringValue = "7d 剩 \(fmtTokens(snapshot.weeklyRemaining))"
        weekBar.ratio = snapshot.weeklyRatio
        cacheLabel.stringValue = String(format: "缓存 %.1f%%", snapshot.cacheHitRate * 100)

        let ctxPct = String(format: "%.1f%%", snapshot.contextRatio * 100)
        let fiveHPct = String(format: "%.1f%%", snapshot.fiveHourRatio * 100)
        let weekPct = String(format: "%.1f%%", snapshot.weeklyRatio * 100)
        detailStatsLabel.stringValue = """
        当前会话：\(snapshot.conversationTitle)（模型：\(snapshot.model)）
        上下文：已用 \(fmtTokens(snapshot.contextUsed)) / \(fmtTokens(settings.contextLimit))（\(ctxPct)）· 剩余 \(fmtTokens(snapshot.contextRemaining))
        5h 窗口：已用 \(fmtTokens(snapshot.fiveHourUsed))（\(fiveHPct)）· 7d 窗口：已用 \(fmtTokens(snapshot.weeklyUsed))（\(weekPct)）
        """
        sparkline.turns = snapshot.recentTurns

        if !accountField.currentEditorIsActive {
            accountField.stringValue = settings.googleAccount
        }
        if !fiveHInput.currentEditorIsActive {
            fiveHInput.stringValue = String(Int(settings.fiveHourTokenBudget))
        }
        if !weekInput.currentEditorIsActive {
            weekInput.stringValue = String(Int(settings.weeklyTokenBudget))
        }
    }

    @objc private func toggleExpand() {
        isExpanded.toggle()
        expandBtn.title = isExpanded ? "▴" : "▾"
        detailContainer.isHidden = !isExpanded
        onToggleExpand?(isExpanded)
    }

    @objc private func syncGcloud() {
        if let acct = onSyncGcloud?() {
            accountField.stringValue = acct
            var next = currentSettings
            next.googleAccount = acct
            onSaveSettings?(next)
        } else {
            accountField.placeholderString = "未检测到已登录的 gcloud，可手动输入邮箱"
        }
    }

    @objc private func applyProPreset() {
        var next = currentSettings
        next.planName = "Google AI Pro"
        next.contextLimit = 1_000_000
        next.fiveHourTokenBudget = 8_000_000
        next.weeklyTokenBudget = 30_000_000
        fiveHInput.stringValue = "8000000"
        weekInput.stringValue = "30000000"
        onSaveSettings?(next)
    }

    @objc private func applyUltraPreset() {
        var next = currentSettings
        next.planName = "Google AI Ultra"
        next.contextLimit = 1_000_000
        next.fiveHourTokenBudget = 32_000_000
        next.weeklyTokenBudget = 120_000_000
        fiveHInput.stringValue = "32000000"
        weekInput.stringValue = "120000000"
        onSaveSettings?(next)
    }

    @objc private func saveBudget() {
        var next = currentSettings
        next.googleAccount = accountField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if let v5 = Double(fiveHInput.stringValue), v5 >= 100_000 { next.fiveHourTokenBudget = v5 }
        if let v7 = Double(weekInput.stringValue), v7 >= 500_000 { next.weeklyTokenBudget = v7 }
        onSaveSettings?(next)
    }

    @objc private func hideHUD() {
        onHideToMenuBar?()
    }

    @objc private func quitFromPanel() {
        onQuitApp?()
    }
}

private extension NSTextField {
    var currentEditorIsActive: Bool {
        window?.firstResponder == currentEditor() && currentEditor() != nil
    }
}

// MARK: - App Delegate

final class HUDAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var followMenuItem: NSMenuItem!
    private var hudWindow: TopHUDWindow!
    private var hudView: HUDRootView!
    private var dataTimer: Timer?
    private var visibilityTimer: Timer?
    private var settings = LocalDataReader.loadSettings()

    private var followAntigravity = true
    private var manuallyHidden = false

    private let hudWidth: CGFloat = 680
    private let compactHeight: CGFloat = 48
    private let expandedHeight: CGFloat = 320

    func applicationDidFinishLaunching(_ notification: Notification) {
        if settings.googleAccount.isEmpty, let detected = LocalDataReader.detectGcloudAccount() {
            settings.googleAccount = detected
            LocalDataReader.saveSettings(settings)
        }
        setupMenuBar()
        setupTopHUD()
        observeWorkspace()
        refreshNow()
        syncVisibility()

        dataTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.refreshNow()
        }
        visibilityTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            self?.syncVisibility()
        }
    }

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "⚡Token"
        statusItem.button?.font = NSFont.systemFont(ofSize: 12, weight: .semibold)

        let menu = NSMenu()
        let toggleItem = NSMenuItem(title: "显示 / 隐藏顶部外挂条", action: #selector(toggleHUDVisible), keyEquivalent: "")
        toggleItem.target = self
        menu.addItem(toggleItem)

        followMenuItem = NSMenuItem(title: "跟随 Antigravity 自动显隐", action: #selector(toggleFollowMode), keyEquivalent: "")
        followMenuItem.target = self
        followMenuItem.state = .on
        menu.addItem(followMenuItem)

        let resetPosItem = NSMenuItem(title: "重置到屏幕顶部居中", action: #selector(centerAtTop), keyEquivalent: "")
        resetPosItem.target = self
        menu.addItem(resetPosItem)

        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "退出 Token 顶部外挂", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    private func observeWorkspace() {
        let nc = NSWorkspace.shared.notificationCenter
        let names: [NSNotification.Name] = [
            NSWorkspace.didActivateApplicationNotification,
            NSWorkspace.didHideApplicationNotification,
            NSWorkspace.didUnhideApplicationNotification,
            NSWorkspace.didTerminateApplicationNotification,
        ]
        for name in names {
            nc.addObserver(self, selector: #selector(workspaceChanged), name: name, object: nil)
        }
    }

    @objc private func workspaceChanged() {
        syncVisibility()
    }

    private func isAntigravityApp(_ app: NSRunningApplication) -> Bool {
        let name = (app.localizedName ?? "").lowercased()
        let bid = (app.bundleIdentifier ?? "").lowercased()
        return name.contains("antigravity") || bid.contains("antigravity")
    }

    private func hasVisibleOnScreenWindow(pid: pid_t) -> Bool {
        let selfPID = ProcessInfo.processInfo.processIdentifier
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return true
        }
        var sawAnyOtherAppWindow = false
        for info in list {
            guard let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  layer == 0,
                  let boundsDict = info[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
                  rect.width >= 100,
                  rect.height >= 80 else {
                continue
            }
            if ownerPID != selfPID {
                sawAnyOtherAppWindow = true
            }
            if ownerPID == pid {
                return true
            }
        }
        // If macOS restricts window enumeration for other apps, do not falsely hide the HUD
        return !sawAnyOtherAppWindow
    }

    private func syncVisibility() {
        if manuallyHidden {
            if hudWindow.isVisible { hudWindow.orderOut(nil) }
            return
        }
        guard followAntigravity else {
            if !hudWindow.isVisible { hudWindow.orderFrontRegardless() }
            return
        }

        let selfPID = ProcessInfo.processInfo.processIdentifier
        guard let front = NSWorkspace.shared.frontmostApplication else { return }

        if front.processIdentifier == selfPID {
            if !hudWindow.isVisible { hudWindow.orderFrontRegardless() }
            return
        }

        if isAntigravityApp(front) && !front.isHidden && hasVisibleOnScreenWindow(pid: front.processIdentifier) {
            if !hudWindow.isVisible { hudWindow.orderFrontRegardless() }
        } else {
            if hudWindow.isVisible { hudWindow.orderOut(nil) }
        }
    }

    private func setupTopHUD() {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let frame = topCenteredFrame(on: screen, height: compactHeight)

        hudWindow = TopHUDWindow(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        hudWindow.isOpaque = false
        hudWindow.backgroundColor = .clear
        hudWindow.appearance = NSAppearance(named: .darkAqua)
        hudWindow.level = .floating
        hudWindow.hasShadow = true
        hudWindow.isMovableByWindowBackground = true
        hudWindow.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        hudView = HUDRootView(frame: CGRect(origin: .zero, size: frame.size))
        hudView.onToggleExpand = { [weak self] expanded in
            self?.resizeHUD(expanded: expanded)
        }
        hudView.onSaveSettings = { [weak self] next in
            guard let self = self else { return }
            self.settings = next
            LocalDataReader.saveSettings(next)
            self.refreshNow()
        }
        hudView.onSyncGcloud = {
            LocalDataReader.detectGcloudAccount()
        }
        hudView.onHideToMenuBar = { [weak self] in
            self?.manuallyHidden = true
            self?.hudWindow.orderOut(nil)
        }
        hudView.onQuitApp = { [weak self] in
            self?.quitApp()
        }

        hudWindow.contentView = hudView
        hudWindow.orderFrontRegardless()
    }

    private func topCenteredFrame(on screen: NSScreen, height: CGFloat) -> CGRect {
        let vis = screen.visibleFrame
        let x = vis.midX - hudWidth / 2
        let y = vis.maxY - height - 6
        return CGRect(x: x, y: y, width: hudWidth, height: height)
    }

    private func resizeHUD(expanded: Bool) {
        let cur = hudWindow.frame
        let newH = expanded ? expandedHeight : compactHeight
        let newY = cur.maxY - newH
        hudWindow.setFrame(CGRect(x: cur.origin.x, y: newY, width: cur.width, height: newH), display: true, animate: true)
    }

    private func refreshNow() {
        settings = LocalDataReader.loadSettings()
        let snap = LocalDataReader.readLiveSnapshot(settings: settings)
        hudView.update(snapshot: snap, settings: settings)
        statusItem.button?.title = "⚡\(fmtTokens(snap.contextRemaining))"
    }

    @objc private func toggleHUDVisible() {
        if hudWindow.isVisible {
            manuallyHidden = true
            hudWindow.orderOut(nil)
        } else {
            manuallyHidden = false
            hudWindow.orderFrontRegardless()
        }
    }

    @objc private func toggleFollowMode() {
        followAntigravity.toggle()
        followMenuItem.state = followAntigravity ? .on : .off
        manuallyHidden = false
        syncVisibility()
    }

    @objc private func centerAtTop() {
        manuallyHidden = false
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let h = hudView.isExpanded ? expandedHeight : compactHeight
        hudWindow.setFrame(topCenteredFrame(on: screen, height: h), display: true, animate: true)
        hudWindow.orderFrontRegardless()
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = HUDAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
