import SwiftUI

// MARK: - Palette (ported from the Windows mixer)

extension Color {
    init(hex: String) {
        let v = UInt64(hex.replacingOccurrences(of: "#", with: ""), radix: 16) ?? 0
        self = Color(red: Double((v >> 16) & 0xff) / 255,
                     green: Double((v >> 8) & 0xff) / 255,
                     blue: Double(v & 0xff) / 255)
    }
    // Graphite / silver console (2020s)
    static let bg = Color(hex: "3A4048")        // chassis
    static let panel = Color(hex: "4A515B")     // raised panel
    static let fg = Color(hex: "EDEFF2")        // text
    static let subc = Color(hex: "AEB6C0")      // secondary text
    static let bd = Color(hex: "2A2F35")        // recessed groove / dark edge
    static let hi = Color(hex: "5E6671")        // bevel highlight
    static let acc = Color(hex: "46C2B6")       // teal — primary
    static let acc2 = Color(hex: "FF8C42")      // amber — active / ON
    static let red = Color(hex: "E0605C")
}

// Brushed-metal gradients + bevels

extension LinearGradient {
    static let chassis = LinearGradient(colors: [Color(hex: "434A53"), Color(hex: "343A42")],
                                        startPoint: .top, endPoint: .bottom)
    static let panelMetal = LinearGradient(colors: [Color(hex: "545C67"), Color(hex: "434A53")],
                                           startPoint: .top, endPoint: .bottom)
    static let thumbMetal = LinearGradient(colors: [Color(hex: "EFF2F6"), Color(hex: "B9C0CA"), Color(hex: "9AA2AD")],
                                           startPoint: .top, endPoint: .bottom)
    static let grooveInset = LinearGradient(colors: [Color(hex: "23272D"), Color(hex: "32373E")],
                                            startPoint: .top, endPoint: .bottom)
}

struct MetalPanel: ViewModifier {
    var radius: CGFloat = 8
    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius)
                    .fill(LinearGradient.panelMetal)
                    .overlay(RoundedRectangle(cornerRadius: radius).stroke(Color.hi.opacity(0.5), lineWidth: 1).blur(radius: 0.5).offset(y: 0.5))
                    .overlay(RoundedRectangle(cornerRadius: radius).stroke(Color.bd, lineWidth: 1))
                    .shadow(color: .black.opacity(0.35), radius: 6, x: 0, y: 3)
            )
    }
}
extension View {
    func metalPanel(_ radius: CGFloat = 8) -> some View { modifier(MetalPanel(radius: radius)) }
}

struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                header
                outputsSection
                sourcesSection
                EqualizerView(effects: model.effects)
                transport
                footer
            }
            .padding(14)
        }
        .background(LinearGradient.chassis.ignoresSafeArea())
        .foregroundColor(.fg)
        .alert(item: $model.alert) { a in
            Alert(title: Text(a.title), message: Text(a.message), dismissButton: .default(Text("OK")))
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("CHANNEL SPLITTER").font(.system(size: 16, weight: .bold)).foregroundColor(.acc)
            Text("by \(kBrand)").font(.system(size: 11, weight: .bold)).foregroundColor(.acc)
            Text("L/R → колонки · мультиисточник · баланс · EQ · калибровка")
                .font(.system(size: 11)).foregroundColor(.subc)
            Spacer()
        }
    }

    private var outputsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("ВЫХОДЫ — КОЛОНКИ").font(.system(size: 13, weight: .bold)).foregroundColor(.acc)
                Spacer()
                Button("+ Колонка") { model.addOutput() }
            }
            VStack(spacing: 4) {
                ForEach(model.outputs) { spk in
                    OutputRow(speaker: spk)
                }
            }
            .padding(8)
            .metalPanel()
        }
    }

    private var sourcesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("ИСТОЧНИКИ").font(.system(size: 13, weight: .bold)).foregroundColor(.acc)
                Spacer()
                Button("+ Системный звук") { model.addSource(systemAudio: true) }
                Button("+ Источник") { model.addSource(systemAudio: false) }
            }
            VStack(spacing: 4) {
                ForEach(model.sources) { src in
                    SourceRow(source: src)
                }
            }
            .padding(8)
            .metalPanel()
        }
    }

    private var transport: some View {
        HStack(spacing: 12) {
            Button(action: { model.toggleRun() }) {
                Text(model.engine.isRunning ? "● ON" : "○ OFF")
                    .font(.system(size: 13, weight: .bold))
                    .frame(width: 80)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(model.engine.isRunning
                                  ? LinearGradient(colors: [Color(hex: "FFA45C"), Color(hex: "F07A2E")], startPoint: .top, endPoint: .bottom)
                                  : LinearGradient.thumbMetal)
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.bd, lineWidth: 1))
                            .shadow(color: model.engine.isRunning ? Color.acc2.opacity(0.5) : .clear, radius: 6)
                    )
                    .foregroundColor(model.engine.isRunning ? Color(hex: "2A1400") : Color(hex: "2A2F35"))
            }.buttonStyle(.plain)

            Button("Калибровка (микрофон)") { model.calibrate() }
                .disabled(!model.engine.isRunning || model.calibrating)

            Button("⟳ Устройства") { model.refreshDevices() }

            Text("МАСТЕР").foregroundColor(.subc)
            HSlider(value: $model.masterPercent, range: 0...150, onChange: { model.applyMaster() })
                .frame(width: 140)
            Text("\(Int(model.masterPercent))%").foregroundColor(.subc).frame(width: 42)

            Spacer()
            Text(model.engine.statusText).foregroundColor(.subc)
        }
    }

    private var footer: some View {
        Text("© 2026 \(kBrand)  ·  Channel Splitter v\(kVersion)  ·  разработчик: \(kDeveloper)  ·  все права защищены")
            .font(.system(size: 9)).foregroundColor(.subc)
            .frame(maxWidth: .infinity)
    }
}

// MARK: - Output row

struct OutputRow: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var speaker: OutputSpeaker

    var body: some View {
        HStack(spacing: 8) {
            DevicePicker(devices: model.outDevices, selection: Binding(
                get: { speaker.device }, set: { speaker.device = $0; model.deviceChanged() }))
                .frame(width: 220)

            Picker("", selection: $speaker.role) {
                ForEach(SpeakerRole.allCases) { Text($0.rawValue).tag($0) }
            }
            .labelsHidden().frame(width: 90)
            .onChange(of: speaker.role) { _ in model.applyEQ() }

            HSlider(value: $speaker.volumePercent, range: 0...150).frame(width: 90)

            Toggle("SUB", isOn: $speaker.isSub)
                .toggleStyle(.checkbox)
                .onChange(of: speaker.isSub) { _ in model.applyEQ() }
            Stepper(value: $speaker.xover, in: 40...300, step: 10) {
                Text("\(Int(speaker.xover)) Гц").font(.system(size: 11)).foregroundColor(.subc)
            }
            .frame(width: 110)
            .onChange(of: speaker.xover) { _ in model.applyEQ() }

            HStack(spacing: 2) {
                Text("Задержка").font(.system(size: 10)).foregroundColor(.subc)
                TextField("0", value: $speaker.delayMs, format: .number.precision(.fractionLength(0)))
                    .frame(width: 46).textFieldStyle(.roundedBorder)
                    .onChange(of: speaker.delayMs) { _ in model.applyDelays() }
                Text("мс").font(.system(size: 10)).foregroundColor(.subc)
            }

            Button("🔊") { model.testOutput(speaker) }.buttonStyle(.plain)

            MeterBar(level: min(1.0, speaker.peak * 1.3), tick: model.meterTick).frame(width: 54, height: 12)

            Button("✕") { model.removeOutput(speaker) }.buttonStyle(.plain).foregroundColor(.red)
        }
    }
}

// MARK: - Source row

struct SourceRow: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var source: SourceConfig

    var body: some View {
        HStack(spacing: 8) {
            DevicePicker(devices: model.inDevices, selection: Binding(
                get: { source.device }, set: { source.device = $0; model.deviceChanged() }))
                .frame(width: 240)

            HSlider(value: $source.volumePercent, range: 0...150).frame(width: 100)
            Text("\(Int(source.volumePercent))%").foregroundColor(.fg).frame(width: 42)

            HSlider(value: $source.balancePercent, range: -100...100, fillFromCenter: true).frame(width: 110)
            Text(balText(source.balancePercent)).foregroundColor(.fg).frame(width: 40)

            Toggle("Ø фаза", isOn: $source.invertPhase).toggleStyle(.checkbox)
            Toggle("M", isOn: $source.mute).toggleStyle(.checkbox)

            Spacer()
            Button("✕") { model.removeSource(source) }.buttonStyle(.plain).foregroundColor(.red)
        }
    }

    private func balText(_ x: Double) -> String {
        let n = Int(x.rounded())
        if n == 0 { return "C" }
        return n < 0 ? "L\(-n)" : "R\(n)"
    }
}

// MARK: - Device picker

struct DevicePicker: View {
    let devices: [AudioDeviceInfo]
    @Binding var selection: AudioDeviceInfo?

    var body: some View {
        Picker("", selection: Binding(
            get: { selection?.deviceID ?? devices.first?.deviceID ?? 0 },
            set: { id in selection = devices.first { $0.deviceID == id } })) {
            ForEach(devices) { Text($0.name).tag($0.deviceID) }
        }
        .labelsHidden()
    }
}

// MARK: - Meter

struct MeterBar: View {
    let level: Float
    let tick: Int
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Rectangle().fill(Color.bd)
                Rectangle()
                    .fill(level < 0.8 ? Color.acc : (level < 0.95 ? Color(hex: "ffd166") : Color.red))
                    .frame(width: geo.size.width * CGFloat(max(0, min(1, level))))
            }
        }
        .cornerRadius(2)
    }
}

// MARK: - Equalizer + effects

struct EqualizerView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var effects: EffectState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("ЭКВАЛАЙЗЕР · 12 ПОЛОС").font(.system(size: 13, weight: .bold)).foregroundColor(.acc)
                Button(effects.eqOn ? "EQ ВКЛ" : "EQ ВЫКЛ") {
                    effects.eqOn.toggle(); model.applyEQ()
                }
                .foregroundColor(effects.eqOn ? Color.acc2 : .subc)
                Button("Сброс") {
                    for i in 0..<effects.eqGains.count { effects.eqGains[i] = 0 }
                    model.applyEQ()
                }
                Spacer()
            }

            effectsRow

            // one flat row: fader, indicator, fader, indicator …
            HStack(alignment: .bottom, spacing: 5) {
                ForEach(0..<Audio.eqFreqs.count, id: \.self) { i in
                    VStack(spacing: 2) {
                        Text(flabel(Audio.eqFreqs[i])).font(.system(size: 9)).foregroundColor(.subc)
                        VerticalGainSlider(value: $effects.eqGains[i], range: -12...12) {
                            model.applyEQ()
                        }
                        .frame(width: 20, height: 96)
                        Text("\(Int(effects.eqGains[i].rounded()))")
                            .font(.system(size: 10)).foregroundColor(.fg)
                    }
                    SpectrumBar(level: model.spectrum.indices.contains(i) ? model.spectrum[i] : 0)
                        .frame(width: 7, height: 96)
                }
            }
        }
        .padding(10)
        .metalPanel()
    }

    private var effectsRow: some View {
        HStack(spacing: 18) {
            EffectColumn(name: "BASS", color: .acc, range: 0...12,
                         on: $effects.bassOn, value: $effects.bass,
                         label: { "\(Int($0)) dB" }, onChange: { model.applyEQ() })
            EffectColumn(name: "SPATIAL", color: .acc2, range: 0...100,
                         on: $effects.spatialOn, value: $effects.spatialPercent,
                         label: { "\(Int($0))%" }, onChange: {})
            EffectColumn(name: "3D", color: .acc, range: 0...100,
                         on: $effects.threeDOn, value: $effects.threeDPercent,
                         label: { "\(Int($0))%" }, onChange: {})
            EffectColumn(name: "7.1 SURROUND", color: Color(hex: "f78c6b"), range: 0...100,
                         on: $effects.surroundOn, value: $effects.surroundPercent,
                         label: { "\(Int($0))%" }, onChange: {})
        }
    }

    private func flabel(_ f: Float) -> String {
        f >= 1000 ? "\(Int(f / 1000))k" : "\(Int(f))"
    }
}

struct EffectColumn: View {
    let name: String
    let color: Color
    let range: ClosedRange<Double>
    @Binding var on: Bool
    @Binding var value: Double
    let label: (Double) -> String
    let onChange: () -> Void

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 6) {
                Text(name).font(.system(size: 11, weight: .bold)).foregroundColor(color)
                Toggle("", isOn: $on).labelsHidden().toggleStyle(.checkbox)
                    .onChange(of: on) { _ in onChange() }
            }
            HSlider(value: $value, range: range, onChange: onChange).frame(width: 130)
            Text(label(value)).font(.system(size: 10)).foregroundColor(.subc)
        }
    }
}

// MARK: - Vertical gain slider (visible track + 0 dB mark + draggable thumb)

struct VerticalGainSlider: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    let onChange: () -> Void

    private let trackW: CGFloat = 8
    private let thumbH: CGFloat = 11

    var body: some View {
        GeometryReader { geo in
            let h = geo.size.height
            let w = geo.size.width
            let usable = h - thumbH
            let span = range.upperBound - range.lowerBound
            let frac = CGFloat((value - range.lowerBound) / span)   // 0 bottom … 1 top
            let thumbCenterY = thumbH / 2 + usable * (1 - frac)
            let centerY = h / 2

            ZStack {
                // recessed inset track groove
                RoundedRectangle(cornerRadius: 3)
                    .fill(LinearGradient.grooveInset)
                    .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color.bd, lineWidth: 1))
                    .frame(width: trackW, height: h)
                // 0 dB center line
                Rectangle().fill(Color.subc.opacity(0.7)).frame(width: trackW + 6, height: 1).position(x: w / 2, y: centerY)
                // fill from center to thumb
                Rectangle()
                    .fill(Color.acc.opacity(0.75))
                    .frame(width: trackW - 2, height: abs(centerY - thumbCenterY))
                    .position(x: w / 2, y: (centerY + thumbCenterY) / 2)
                // brushed-metal fader cap with grip line
                ZStack {
                    RoundedRectangle(cornerRadius: 2).fill(LinearGradient.thumbMetal)
                    Rectangle().fill(Color.bd.opacity(0.6)).frame(height: 1)
                }
                .frame(width: w, height: thumbH)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(Color.bd, lineWidth: 1))
                .shadow(color: .black.opacity(0.4), radius: 2, y: 1)
                .position(x: w / 2, y: thumbCenterY)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        let y = min(max(0, g.location.y - thumbH / 2), usable)
                        value = range.lowerBound + (1 - Double(y / usable)) * span
                        onChange()
                    }
            )
            .onTapGesture(count: 2) { value = 0; onChange() }
        }
    }
}

// MARK: - Horizontal slider (visible track + rectangular thumb, no round knob)

struct HSlider: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    var fillFromCenter: Bool = false
    var onChange: () -> Void = {}

    private let thumbW: CGFloat = 10
    private let trackH: CGFloat = 6

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let usable = w - thumbW
            let span = range.upperBound - range.lowerBound
            let frac = CGFloat((value - range.lowerBound) / span)
            let thumbCenterX = thumbW / 2 + usable * frac
            let centerX = w / 2

            ZStack {
                // recessed inset groove
                RoundedRectangle(cornerRadius: 3)
                    .fill(LinearGradient.grooveInset)
                    .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color.bd, lineWidth: 1))
                    .frame(height: trackH)
                // filled portion
                Rectangle()
                    .fill(Color.acc.opacity(0.75))
                    .frame(width: fillFromCenter ? abs(thumbCenterX - centerX)
                                                 : max(0, thumbCenterX - thumbW / 2),
                           height: trackH - 2)
                    .position(x: fillFromCenter ? (thumbCenterX + centerX) / 2
                                                : (thumbCenterX - thumbW / 2) / 2 + 1,
                              y: h / 2)
                // brushed-metal thumb with vertical grip
                ZStack {
                    RoundedRectangle(cornerRadius: 2).fill(LinearGradient.thumbMetal)
                    Rectangle().fill(Color.bd.opacity(0.6)).frame(width: 1)
                }
                .frame(width: thumbW, height: h)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(Color.bd, lineWidth: 1))
                .shadow(color: .black.opacity(0.4), radius: 2, y: 1)
                .position(x: thumbCenterX, y: h / 2)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        let x = min(max(0, g.location.x - thumbW / 2), usable)
                        value = range.lowerBound + Double(x / usable) * span
                        onChange()
                    }
            )
        }
        .frame(height: 18)
    }
}

struct SpectrumBar: View {
    let level: Float
    var body: some View {
        let span = Audio.specCeil - Audio.specFloor
        let db = 20.0 * log10(level + 1e-9)
        let lvl = max(0, min(1, (db - Audio.specFloor) / span))
        return GeometryReader { geo in
            ZStack(alignment: .bottom) {
                Rectangle().fill(Color.bd)
                Rectangle()
                    .fill(lvl < 0.8 ? Color.acc : Color(hex: "ffd166"))
                    .frame(height: geo.size.height * CGFloat(lvl))
            }
        }
        .cornerRadius(1)
    }
}
