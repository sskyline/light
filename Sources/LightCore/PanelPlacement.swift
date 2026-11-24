import CoreGraphics
import Foundation

public struct PanelLayout: Equatable, Sendable {
    public let capsuleX: CGFloat
    public let capsuleY: CGFloat
    public let panelShiftX: CGFloat
    public let panelWidth: CGFloat
    public let above: Bool
    public let panelMaxHeight: CGFloat

    public init(
        capsuleX: CGFloat,
        capsuleY: CGFloat,
        panelShiftX: CGFloat,
        panelWidth: CGFloat,
        above: Bool,
        panelMaxHeight: CGFloat
    ) {
        self.capsuleX = capsuleX
        self.capsuleY = capsuleY
        self.panelShiftX = panelShiftX
        self.panelWidth = panelWidth
        self.above = above
        self.panelMaxHeight = panelMaxHeight
    }
}

public struct CapsulePlacement: Equatable, Sendable {
    public let anchor: CGPoint
    public let frame: CGRect
    public let layout: PanelLayout

    public init(anchor: CGPoint, frame: CGRect, layout: PanelLayout) {
        self.anchor = anchor
        self.frame = frame
        self.layout = layout
    }
}

public struct DisplayDescriptor: Equatable, Sendable {
    public let id: Int?
    public let key: String
    public let frame: CGRect
    public let visibleFrame: CGRect

    public init(id: Int?, key: String, frame: CGRect, visibleFrame: CGRect) {
        self.id = id
        self.key = key
        self.frame = frame
        self.visibleFrame = visibleFrame
    }
}

public struct SavedCapsulePosition: Equatable, Sendable {
    public let displayID: Int?
    public let displayKey: String?
    public let x: CGFloat
    public let top: CGFloat

    public init(displayID: Int?, displayKey: String?, x: CGFloat, top: CGFloat) {
        self.displayID = displayID
        self.displayKey = displayKey
        self.x = x
        self.top = top
    }
}

public func makeDisplayKey(localizedName: String, size: CGSize, scale: CGFloat) -> String {
    let width = Int(size.width.rounded())
    let height = Int(size.height.rounded())
    let scaleText = scale.rounded() == scale ? String(Int(scale)) : String(format: "%.2f", scale)
    return "\(localizedName)|\(width)x\(height)|scale:\(scaleText)"
}

/// Computes the capsule position (clamped to `area`) and dropdown panel geometry
/// (width, horizontal shift, and whether the panel opens above or below the capsule).
public func computeCapsulePlacement(
    anchor rawAnchor: CGPoint,
    area: CGRect,
    capsuleSize: CGSize
) -> CapsulePlacement {
    let edge: CGFloat = 8
    let gap: CGFloat = 9
    let preferredPanelHeight: CGFloat = 452

    let capsuleWidth = max(1, capsuleSize.width)
    let capsuleHeight = max(1, capsuleSize.height)

    func clamp(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat {
        if high < low { return low }
        return max(low, min(value, high))
    }

    let halfCapsule = min(capsuleWidth / 2, area.width / 2)
    let clampedAnchor = CGPoint(
        x: clamp(rawAnchor.x, area.minX + halfCapsule, area.maxX - halfCapsule),
        y: clamp(rawAnchor.y, area.minY + capsuleHeight, area.maxY)
    )

    let panelWidth = max(0, min(384, area.width - edge * 2))
    let halfPanel = panelWidth / 2
    let panelCenterX = clamp(clampedAnchor.x, area.minX + edge + halfPanel, area.maxX - edge - halfPanel)
    let spaceBelow = max(0, clampedAnchor.y - capsuleHeight - gap - area.minY - edge)
    let spaceAbove = max(0, area.maxY - clampedAnchor.y - gap - edge)
    let above = spaceBelow < preferredPanelHeight && spaceAbove > spaceBelow
    let panelMaxHeight = max(180, min(preferredPanelHeight, above ? spaceAbove : spaceBelow))

    let capsuleFrame = CGRect(
        x: (clampedAnchor.x - capsuleWidth / 2).rounded(),
        y: (clampedAnchor.y - capsuleHeight).rounded(),
        width: capsuleWidth.rounded(),
        height: capsuleHeight.rounded()
    )

    let layout = PanelLayout(
        capsuleX: 0,
        capsuleY: 0,
        panelShiftX: (panelCenterX - clampedAnchor.x).rounded(),
        panelWidth: panelWidth.rounded(),
        above: above,
        panelMaxHeight: panelMaxHeight.rounded()
    )
    return CapsulePlacement(anchor: clampedAnchor, frame: capsuleFrame, layout: layout)
}

/// Computes the exact screen-coordinate frame of the dropdown panel relative to
/// a capsule's AppKit screen frame (bottom-left origin).
public func computeDropdownFrame(
    capsuleFrame: CGRect,
    panelSize: CGSize,
    area: CGRect,
    preferredAbove: Bool? = nil
) -> (frame: CGRect, above: Bool, maxHeight: CGFloat) {
    let edge: CGFloat = 8
    let gap: CGFloat = 9
    let preferredPanelHeight: CGFloat = 452

    func clamp(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat {
        if high < low { return low }
        return max(low, min(value, high))
    }

    let width = max(200, min(panelSize.width, area.width - edge * 2))
    let spaceBelow = max(0, capsuleFrame.minY - gap - area.minY - edge)
    let spaceAbove = max(0, area.maxY - capsuleFrame.maxY - gap - edge)
    let above = preferredAbove ?? (spaceBelow < preferredPanelHeight && spaceAbove > spaceBelow)
    let maxHeight = max(180, min(preferredPanelHeight, above ? spaceAbove : spaceBelow))
    let height = min(max(60, panelSize.height), maxHeight)

    let centerX = clamp(capsuleFrame.midX, area.minX + edge + width / 2, area.maxX - edge - width / 2)
    let originX = (centerX - width / 2).rounded()
    let originY: CGFloat
    if above {
        originY = (capsuleFrame.maxY + gap).rounded()
    } else {
        originY = (capsuleFrame.minY - gap - height).rounded()
    }
    let clampedY = clamp(originY, area.minY + edge, area.maxY - edge - height)

    return (
        frame: CGRect(x: originX, y: clampedY.rounded(), width: width.rounded(), height: height.rounded()),
        above: above,
        maxHeight: maxHeight.rounded()
    )
}

public func resolveDisplay(
    saved: SavedCapsulePosition?,
    displays: [DisplayDescriptor],
    mouseLocation: CGPoint,
    mainDisplayID: Int?
) -> (display: DisplayDescriptor, matchedSaved: Bool)? {
    if let saved {
        if let id = saved.displayID, let match = displays.first(where: { $0.id == id }) {
            return (match, true)
        }
        if let key = saved.displayKey, !key.isEmpty, let match = displays.first(where: { $0.key == key }) {
            return (match, true)
        }
    }
    if let byMouse = displays.first(where: { $0.frame.contains(mouseLocation) }) {
        return (byMouse, false)
    }
    if let mainDisplayID, let main = displays.first(where: { $0.id == mainDisplayID }) {
        return (main, false)
    }
    if let first = displays.first {
        return (first, false)
    }
    return nil
}
