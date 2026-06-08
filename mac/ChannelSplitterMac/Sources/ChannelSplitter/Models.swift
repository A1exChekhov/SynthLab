import Foundation
import Combine

// MARK: - Constants (ported from channel-splitter/splitter_gui.py)

enum Audio {
    static let sampleRate: Double = 48000
    static let block: Int = 960           // ~20 ms blocks — fewer glitches with Bluetooth
    static let maxBufFrames: Int = 960 * 60 // deeper ring buffer to absorb clock drift
    static let minDB: Float = -48.0
    static let maxDB: Float = 3.0

    // Graphic EQ (12 bands incl. 20 Hz and 20 kHz)
    static let eqFreqs: [Float] = [20, 31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000, 20000]
    static let eqQ: Float = 1.4
    static let eqRange: Float = 12.0      // +/- dB
    static let bassFreq: Float = 110.0    // low-shelf Bass Boost

    // per-band frequency edges for spectrum binning (geometric means)
    static let eqEdges: [(lo: Float, hi: Float)] = {
        var edges: [(Float, Float)] = []
        let f = eqFreqs
        for i in 0..<f.count {
            let lo = i > 0 ? (f[i - 1] * f[i]).squareRoot() : f[i] / 1.3
            let hi = i < f.count - 1 ? (f[i + 1] * f[i]).squareRoot()
                                     : min(f[i] * 1.3, Float(sampleRate) / 2 - 1)
            edges.append((lo, hi))
        }
        return edges
    }()
    // +3 dB/oct display tilt (relative to 250 Hz) so the bars look balanced
    static let eqTilt: [Float] = eqFreqs.map { ($0 / 250.0).squareRoot() }
    static let specFloor: Float = -60.0
    static let specCeil: Float = -6.0

    // Distinct test tones per speaker (Hz)
    static let testTones: [Double] = [440, 660, 550, 330, 770, 220, 880, 494]
}

// MARK: - Roles

enum SpeakerRole: String, CaseIterable, Identifiable {
    case left   = "Левый"
    case center = "Моно"
    case right  = "Правый"
    var id: String { rawValue }

    /// balance value: -1 = LEFT channel, 0 = mono mix, +1 = RIGHT channel
    var balance: Float {
        switch self {
        case .left: return -1.0
        case .center: return 0.0
        case .right: return 1.0
        }
    }
}

// MARK: - Audio device descriptor

struct AudioDeviceInfo: Identifiable, Hashable {
    let deviceID: UInt32      // AudioDeviceID
    let name: String
    let uid: String
    var id: UInt32 { deviceID }
}

// MARK: - Output speaker

final class OutputSpeaker: ObservableObject, Identifiable {
    let id = UUID()
    var intId: Int = 0                             // stable integer id for the web bridge

    @Published var device: AudioDeviceInfo?
    @Published var role: SpeakerRole = .left
    @Published var volumePercent: Double = 100      // 0..150
    @Published var mute: Bool = false
    @Published var isSub: Bool = false
    @Published var xover: Double = 120              // crossover Hz for sub
    @Published var delayMs: Double = 0             // manual / calibrated delay
    @Published var inv: Bool = false               // phase invert 180°
    var stereo: Bool = false                       // L/R passthrough (role "L/R")
    var peak: Float = 0                            // written by audio thread, read by meter timer

    // audio-thread state (plain, read/written from render thread)
    var balance: Float { role.balance }
    var volume: Float { mute ? 0 : Float(volumePercent) / 100.0 }
    var measuredDelayMs: Double = 0                // last calibration result

    /// Web-UI role token: "L" | "R" | "Mono" | "L/R"
    var roleKey: String {
        get {
            if stereo { return "L/R" }
            switch role {
            case .left: return "L"
            case .right: return "R"
            case .center: return "Mono"
            }
        }
        set {
            switch newValue {
            case "L":   role = .left;   stereo = false
            case "R":   role = .right;  stereo = false
            case "Mono": role = .center; stereo = false
            case "L/R": role = .center; stereo = true
            default: break
            }
        }
    }
}

// MARK: - Source

final class SourceConfig: ObservableObject, Identifiable {
    let id = UUID()
    var intId: Int = 0                             // stable integer id for the web bridge

    @Published var device: AudioDeviceInfo?
    @Published var volumePercent: Double = 100     // 0..150
    @Published var balancePercent: Double = 0      // -100..100  (← L … R →)
    @Published var invertPhase: Bool = false       // invert RIGHT channel
    @Published var mute: Bool = false
    @Published var loopback: Bool = false          // "System Audio" capture row
    @Published var lbName: String = ""             // selected loopback target ("" = default)
    @Published var name: String = ""               // display name (loopback rows)
    @Published var radio: Bool = false             // интернет-радио (Tuner) как источник
    @Published var radioURL: String = ""           // поток выбранной станции
    // реальный формат источника (пишется движком при старте/работе)
    var fmtRate: Double = 0
    var fmtChannels: Int = 0
    var fmtCodec: String = ""
    var peakL: Float = 0                            // written by audio thread
    var peakR: Float = 0

    var volume: Float { Float(volumePercent) / 100.0 }
    var balance: Float { Float(balancePercent) / 100.0 }
}

// MARK: - EQ + effects state

final class EffectState: ObservableObject {
    @Published var eqOn: Bool = false
    @Published var eqGains: [Double] = Array(repeating: 0, count: Audio.eqFreqs.count)

    @Published var bassOn: Bool = false
    @Published var bass: Double = 0          // 0..12 dB (low-shelf 110 Hz)

    @Published var spatialOn: Bool = false
    @Published var spatialPercent: Double = 0  // 0..100  → width 1..2
    var spatialWidth: Float { 1.0 + Float(spatialPercent) / 100.0 }

    @Published var threeDOn: Bool = false
    @Published var threeDPercent: Double = 0   // 0..100 → 0..1
    var threeD: Float { Float(threeDPercent) / 100.0 }

    @Published var surroundOn: Bool = false
    @Published var surroundPercent: Double = 0 // 0..100 → 0..1
    var surround: Float { Float(surroundPercent) / 100.0 }

    // Extended FX (v2.1 parity) — state is round-tripped to the web UI; DSP for these
    // is applied incrementally (the engine currently consumes the four effects above).
    @Published var extraNum: [String: Double] = [
        "monobass_hz": 120, "pan": 0, "distance": 1, "tilt": 0, "drive": 0,
        "reverb_size": 0.5, "reverb_mix": 0, "comp_thresh": -18,
    ]
    @Published var extraBool: [String: Bool] = [
        "monobass_on": false, "pos_on": false, "tone_on": false,
        "reverb_on": false, "comp_on": false,
    ]

    // Plain (non-published) mirrors of the extended FX, read from the real-time audio
    // render thread. Swift dictionaries are NOT safe to read while being mutated on the
    // main thread, so the render closure reads these flat values instead. Kept in sync
    // by `syncFXMirrors()` whenever the dictionaries change (set_fx / loadSettings).
    var fxPan: Float = 0          // -1..1
    var fxDistance: Float = 0     // 0 (near) .. 1 (far)
    var fxTilt: Float = 0         // -1 (warm) .. 1 (bright)
    var fxDrive: Float = 0        // 0..1
    var fxMonobassHz: Float = 120 // 60..250
    var fxReverbSize: Float = 0.5 // 0..1
    var fxReverbMix: Float = 0    // 0..0.8
    var fxCompThresh: Float = -18 // -40..0 dB
    var fxPosOn = false, fxToneOn = false, fxMonobassOn = false, fxReverbOn = false, fxCompOn = false

    func syncFXMirrors() {
        fxPan         = Float(extraNum["pan"] ?? 0)
        fxDistance    = Float(extraNum["distance"] ?? 0)
        fxTilt        = Float(extraNum["tilt"] ?? 0)
        fxDrive       = Float(extraNum["drive"] ?? 0)
        fxMonobassHz  = Float(extraNum["monobass_hz"] ?? 120)
        fxReverbSize  = Float(extraNum["reverb_size"] ?? 0.5)
        fxReverbMix   = Float(extraNum["reverb_mix"] ?? 0)
        fxCompThresh  = Float(extraNum["comp_thresh"] ?? -18)
        fxPosOn       = extraBool["pos_on"] ?? false
        fxToneOn      = extraBool["tone_on"] ?? false
        fxMonobassOn  = extraBool["monobass_on"] ?? false
        fxReverbOn    = extraBool["reverb_on"] ?? false
        fxCompOn      = extraBool["comp_on"] ?? false
    }
}
