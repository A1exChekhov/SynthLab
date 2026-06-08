#!/usr/bin/env swift
// Generates icon_1024.png for Channel Splitter — dark rack panel with an amber
// speaker + sound waves (audio player / amplifier). Run: swift make_icon.swift
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let S = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: S, height: S, bitsPerComponent: 8,
                          bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }

func c(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
    CGColor(srgbRed: r/255, green: g/255, blue: b/255, alpha: a)
}
let amber = c(232, 176, 75)
let amberHi = c(255, 212, 130)
let sf = CGFloat(S)
func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x*sf, y: y*sf) }

// ── rounded-rect dark panel with vertical gradient ──
let pad: CGFloat = 48
let panel = CGRect(x: pad, y: pad, width: sf - 2*pad, height: sf - 2*pad)
let radius = sf * 0.215
let bg = CGPath(roundedRect: panel, cornerWidth: radius, cornerHeight: radius, transform: nil)
ctx.saveGState()
ctx.addPath(bg); ctx.clip()
let grad = CGGradient(colorsSpace: cs,
                      colors: [c(43, 47, 53), c(20, 22, 25), c(14, 15, 17)] as CFArray,
                      locations: [0, 0.55, 1])!
ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: sf), end: CGPoint(x: 0, y: 0), options: [])
ctx.setStrokeColor(c(255, 255, 255, 0.10)); ctx.setLineWidth(2)
ctx.addPath(CGPath(roundedRect: panel.insetBy(dx: 2, dy: 2), cornerWidth: radius, cornerHeight: radius, transform: nil))
ctx.strokePath()
ctx.restoreGState()
ctx.setStrokeColor(c(0, 0, 0, 0.9)); ctx.setLineWidth(4)
ctx.addPath(bg); ctx.strokePath()

// ── speaker (box + cone) ──
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 38, color: amber.copy(alpha: 0.9))
ctx.setFillColor(amber)
// magnet box
let box = CGPath(roundedRect: CGRect(x: 0.235*sf, y: 0.425*sf, width: 0.085*sf, height: 0.15*sf),
                 cornerWidth: 0.012*sf, cornerHeight: 0.012*sf, transform: nil)
ctx.addPath(box)
// cone (trapezoid widening to the right)
let cone = CGMutablePath()
cone.move(to: P(0.305, 0.43))
cone.addLine(to: P(0.305, 0.57))
cone.addLine(to: P(0.475, 0.74))
cone.addLine(to: P(0.475, 0.26))
cone.closeSubpath()
ctx.addPath(cone)
ctx.fillPath()
// soft inner sheen on the cone
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(cone); ctx.clip()
let coneGrad = CGGradient(colorsSpace: cs, colors: [amberHi, amber] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(coneGrad, start: P(0.30, 0.74), end: P(0.475, 0.26), options: [])
ctx.restoreGState()

// ── sound waves (arcs opening right) ──
let center = P(0.50, 0.50)
let a0 = -50.0 * .pi/180, a1 = 50.0 * .pi/180
for (i, r) in [0.115, 0.185, 0.255].enumerated() {
    let path = CGMutablePath()
    path.addArc(center: center, radius: r*sf, startAngle: CGFloat(a0), endAngle: CGFloat(a1), clockwise: false)
    ctx.addPath(path)
    ctx.setStrokeColor(amber.copy(alpha: 1.0 - Double(i)*0.18) ?? amber)
    ctx.setLineWidth(sf * (0.034 - CGFloat(i)*0.003))
    ctx.setLineCap(.round)
    ctx.setShadow(offset: .zero, blur: 30, color: amber.copy(alpha: 0.85))
    ctx.strokePath()
}

// ── write PNG ──
guard let img = ctx.makeImage() else { exit(1) }
let url = URL(fileURLWithPath: "icon_1024.png")
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, img, nil)
CGImageDestinationFinalize(dest)
print("wrote \(url.path)")
