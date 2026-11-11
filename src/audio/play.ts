import type { GameEventName } from '../game/types'

let audioContext: AudioContext | null = null

type AudioContextCtor = typeof AudioContext

function audioContextConstructor(): AudioContextCtor | null {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextCtor
  }
  if (typeof scope.AudioContext === 'function') return scope.AudioContext
  if (typeof scope.webkitAudioContext === 'function') return scope.webkitAudioContext
  return null
}

/** Один контекст на модуль. Повторный вызов возвращает уже созданный. */
function context(): AudioContext | null {
  if (audioContext) return audioContext
  const Ctor = audioContextConstructor()
  if (!Ctor) return null
  audioContext = new Ctor()
  return audioContext
}

function resume(ctx: AudioContext): void {
  if (ctx.state === 'running') return
  void ctx.resume().catch(() => {})
}

function drop(source: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  source.onended = () => {
    for (const node of nodes) {
      try {
        node.disconnect()
      } catch {
        /* узел уже отключён */
      }
    }
  }
}

type Envelope = 'decay' | 'buzz'

function tone(
  ctx: AudioContext,
  type: OscillatorType,
  frequency: number,
  start: number,
  duration: number,
  peak: number,
  attack: number,
  envelope: Envelope,
): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(frequency, start)

  const end = start + duration
  const attackEnd = Math.min(start + attack, end - 0.004)
  const level = gain.gain
  level.setValueAtTime(0, start)
  level.linearRampToValueAtTime(peak, attackEnd)
  if (envelope === 'buzz') {
    const releaseAt = start + duration * 0.65
    if (releaseAt > attackEnd) level.setValueAtTime(peak, releaseAt)
    level.linearRampToValueAtTime(0, end)
  } else {
    level.exponentialRampToValueAtTime(0.0001, end)
  }

  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(start)
  osc.stop(end + 0.02)
  drop(osc, [osc, gain])
}

function playSwap(ctx: AudioContext): void {
  const start = ctx.currentTime
  tone(ctx, 'sine', 520, start, 0.07, 0.12, 0.008, 'decay')
  tone(ctx, 'sine', 700, start + 0.072, 0.08, 0.12, 0.008, 'decay')
}

function playReject(ctx: AudioContext): void {
  tone(ctx, 'square', 140, ctx.currentTime, 0.16, 0.05, 0.012, 'buzz')
}

function playMatch(ctx: AudioContext): void {
  tone(ctx, 'triangle', 880, ctx.currentTime, 0.26, 0.13, 0.006, 'decay')
}

function playFall(ctx: AudioContext): void {
  tone(ctx, 'sine', 220, ctx.currentTime, 0.04, 0.045, 0.003, 'decay')
}

function playSpawn(ctx: AudioContext): void {
  tone(ctx, 'sine', 360, ctx.currentTime, 0.075, 0.06, 0.014, 'decay')
}

function playScore(ctx: AudioContext, multiplier: number): void {
  const factor = Number.isFinite(multiplier) ? multiplier : 1
  const frequency = Math.min(1800, 480 * Math.max(1, factor))
  tone(ctx, 'sine', frequency, ctx.currentTime, 0.13, 0.11, 0.008, 'decay')
}

function playDamage(ctx: AudioContext): void {
  const start = ctx.currentTime
  tone(ctx, 'square', 150, start, 0.07, 0.07, 0.004, 'decay')
  tone(ctx, 'triangle', 92, start, 0.12, 0.08, 0.004, 'decay')
}

function playDefeat(ctx: AudioContext): void {
  const start = ctx.currentTime
  tone(ctx, 'sawtooth', 220, start, 0.14, 0.05, 0.01, 'decay')
  tone(ctx, 'triangle', 110, start + 0.1, 0.26, 0.06, 0.012, 'decay')
}

function noise(
  ctx: AudioContext,
  duration: number,
  peak: number,
  filterType: BiquadFilterType,
  frequency: number,
  attack: number,
): void {
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) {
    const decay = 1 - i / length
    data[i] = (Math.random() * 2 - 1) * decay * decay
  }

  const source = ctx.createBufferSource()
  const filter = ctx.createBiquadFilter()
  const gain = ctx.createGain()
  source.buffer = buffer
  filter.type = filterType

  const start = ctx.currentTime
  const end = start + duration
  filter.frequency.setValueAtTime(frequency, start)
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(peak, start + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, end)

  source.connect(filter)
  filter.connect(gain)
  gain.connect(ctx.destination)
  source.start(start)
  source.stop(end + 0.02)
  drop(source, [source, filter, gain])
}

function playExplode(ctx: AudioContext): void {
  noise(ctx, 0.15, 0.18, 'lowpass', 780, 0.006)
}

function playHeal(ctx: AudioContext): void {
  const start = ctx.currentTime
  tone(ctx, 'sine', 349, start, 0.04, 0.055, 0.004, 'decay')
  tone(ctx, 'sine', 523, start + 0.038, 0.048, 0.055, 0.004, 'decay')
}

function playHurt(ctx: AudioContext): void {
  const start = ctx.currentTime
  tone(ctx, 'sine', 72, start, 0.07, 0.07, 0.002, 'decay')
  tone(ctx, 'sine', 170, start, 0.028, 0.08, 0.001, 'decay')
  noise(ctx, 0.02, 0.04, 'lowpass', 480, 0.001)
}

function playDown(ctx: AudioContext): void {
  const start = ctx.currentTime
  tone(ctx, 'sine', 164, start, 0.24, 0.045, 0.014, 'decay')
  tone(ctx, 'sine', 123, start + 0.32, 0.28, 0.045, 0.014, 'decay')
  tone(ctx, 'sine', 82, start + 0.66, 0.38, 0.04, 0.016, 'decay')
}

/** Второй аргумент — заряд 0…100, не множитель. Частота около 600…1400. */
function playCharge(ctx: AudioContext, charge: number): void {
  const raw = 600 + (charge / 100) * 800
  let frequency = 600
  if (raw === Infinity) frequency = 1400
  else if (Number.isFinite(raw)) frequency = Math.min(1400, Math.max(600, raw))
  tone(ctx, 'sine', frequency, ctx.currentTime, 0.036, 0.14, 0.002, 'decay')
}

function playCast(ctx: AudioContext): void {
  const start = ctx.currentTime
  tone(ctx, 'triangle', 1046, start, 0.038, 0.16, 0.002, 'decay')
  tone(ctx, 'triangle', 1568, start + 0.036, 0.046, 0.16, 0.002, 'decay')
}

function playFizzle(ctx: AudioContext): void {
  noise(ctx, 0.018, 0.022, 'highpass', 4800, 0.001)
}

function playThaw(ctx: AudioContext): void {
  tone(ctx, 'triangle', 2480, ctx.currentTime, 0.07, 0.07, 0.002, 'decay')
  noise(ctx, 0.032, 0.05, 'highpass', 5200, 0.001)
}

function playCorrupt(ctx: AudioContext): void {
  const start = ctx.currentTime
  tone(ctx, 'sawtooth', 55, start, 0.09, 0.05, 0.006, 'decay')
  tone(ctx, 'sawtooth', 41, start + 0.16, 0.12, 0.045, 0.006, 'decay')
}

function playBurn(ctx: AudioContext): void {
  noise(ctx, 0.06, 0.09, 'highpass', 1600, 0.002)
}

const sounds: Record<GameEventName, (ctx: AudioContext, multiplier: number) => void> = {
  swap: (ctx) => playSwap(ctx),
  reject: (ctx) => playReject(ctx),
  match: (ctx) => playMatch(ctx),
  damage: (ctx) => playDamage(ctx),
  defeat: (ctx) => playDefeat(ctx),
  explode: (ctx) => playExplode(ctx),
  fall: (ctx) => playFall(ctx),
  spawn: (ctx) => playSpawn(ctx),
  score: (ctx, multiplier) => playScore(ctx, multiplier),
  heal: (ctx) => playHeal(ctx),
  hurt: (ctx) => playHurt(ctx),
  down: (ctx) => playDown(ctx),
  charge: (ctx, charge) => playCharge(ctx, charge),
  cast: (ctx) => playCast(ctx),
  fizzle: (ctx) => playFizzle(ctx),
  thaw: (ctx) => playThaw(ctx),
  corrupt: (ctx) => playCorrupt(ctx),
  burn: (ctx) => playBurn(ctx),
}

export function play(name: GameEventName, multiplier = 1): void {
  try {
    const sound = sounds[name]
    if (!sound) return
    const ctx = context()
    if (!ctx) return
    resume(ctx)
    sound(ctx, multiplier)
  } catch {
    /* автовоспроизведение запрещено или AudioContext недоступен */
  }
}

export function unlock(): void {
  try {
    const ctx = context()
    if (!ctx) return
    resume(ctx)
  } catch {
    /* автовоспроизведение запрещено или AudioContext недоступен */
  }
}
