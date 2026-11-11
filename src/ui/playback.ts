import gsap from 'gsap'
import type { GameEvent, GemColor, Position } from '../game'
import { play } from '../audio/play'
import { createCoinElement } from './coin'
import type { Piece, PieceLayer } from './pieces'

const SWAP_DURATION = 0.16
const REJECT_DURATION = 0.16
const MATCH_DURATION = 0.22
const EXPLODE_DURATION = 0.28
const FALL_DURATION = 0.24
const SPAWN_DURATION = 0.24
const SCORE_DURATION = 0.16
const COIN_FLIGHT = 0.68
const DAMAGE_DURATION = 0.24
const DEFEAT_DURATION = 0.36
const HEAL_DURATION = 0.28
const HURT_DURATION = 0.28
const DOWN_DURATION = 0.5
const CHARGE_DURATION = 0.12
const CAST_DURATION = 0.28
const FIZZLE_DURATION = 0.16
const THAW_DURATION = 0.24
const CORRUPT_DURATION = 0.32
const BURN_DURATION = 0.28

export interface EnemyPlayback {
  el: HTMLElement
  onDamage: (event: Extract<GameEvent, { type: 'damage' }>) => void
  onDefeat: () => void
}

export interface BattleHooks {
  onHeal: (event: Extract<GameEvent, { type: 'heal' }>) => void
  onHurt: (event: Extract<GameEvent, { type: 'hurt' }>) => void
  onDown: () => void
  onCharge: (value: number) => void
  onBreach: () => void
  onFreeze: (color: GemColor | null) => void
}

const SHARD_COLOR: Record<GemColor, string> = {
  red: '#ff314c',
  blue: '#3a74ff',
  green: '#16d064',
  yellow: '#ffd000',
  purple: '#c44dff',
}

const BOMB_SHARD = '#ffd7a1'

interface PendingSwap {
  first: Piece
  second: Piece
  a: Position
  b: Position
}

type BurstKind = 'line' | 'blast'

function assertNever(value: never): never {
  throw new Error(`Неизвестное событие: ${String(value)}`)
}

function shardColor(piece: Piece): string {
  if (piece.color) return SHARD_COLOR[piece.color]
  return BOMB_SHARD
}

function glide(
  tl: gsap.core.Timeline,
  el: HTMLElement,
  from: Position,
  to: Position,
  size: number,
  start: number,
  duration: number,
  ease: string,
  overwrite: 'auto' | false = 'auto',
): void {
  tl.fromTo(
    el,
    { x: from.col * size, y: from.row * size },
    {
      x: to.col * size,
      y: to.row * size,
      duration,
      ease,
      immediateRender: false,
      overwrite,
    },
    start,
  )
}

function burst(
  layer: PieceLayer,
  tl: gsap.core.Timeline,
  at: Position,
  color: string,
  start: number,
  duration: number,
  kind: BurstKind,
  size: number,
): void {
  const count = kind === 'blast' ? 8 : 6
  const shard = kind === 'blast' ? 9 : 7
  const spread = kind === 'blast' ? 0.62 : 0.34
  const reach = kind === 'blast' ? 0.7 : 0.48
  const cx = at.col * size + size * 0.5 - shard * 0.5
  const cy = at.row * size + size * 0.5 - shard * 0.5
  for (let index = 0; index < count; index += 1) {
    const el = document.createElement('span')
    el.className = kind === 'blast' ? 'shard blast' : 'shard'
    el.style.background = color
    el.style.width = `${shard}px`
    el.style.height = `${shard}px`
    layer.fx.append(el)
    const angle = (Math.PI * 2 * index) / count + (Math.random() - 0.5) * 0.55
    const distance = size * (spread + Math.random() * reach)
    const dx = Math.cos(angle) * distance
    const dy = Math.sin(angle) * distance + size * 0.16
    gsap.set(el, { x: cx, y: cy, autoAlpha: 0, scale: 0.65, rotation: 0 })
    tl.fromTo(
      el,
      { x: cx, y: cy, autoAlpha: 1, scale: 1 },
      {
        x: cx + dx,
        y: cy + dy,
        autoAlpha: 0,
        scale: 0.35,
        rotation: (Math.random() * 2 - 1) * 150,
        duration,
        ease: 'power2.out',
        immediateRender: false,
        onComplete: () => el.remove(),
      },
      start,
    )
  }
}

function fadeOut(
  layer: PieceLayer,
  tl: gsap.core.Timeline,
  piece: Piece,
  start: number,
  duration: number,
): void {
  tl.to(
    piece.el,
    {
      autoAlpha: 0,
      scale: 0.16,
      duration,
      ease: 'power2.in',
      onComplete: () => layer.remove(piece),
    },
    start,
  )
}

function flash(
  layer: PieceLayer,
  tl: gsap.core.Timeline,
  center: Position,
  start: number,
  size: number,
): void {
  const el = document.createElement('div')
  el.className = 'flash'
  const span = size * 3
  el.style.width = `${span}px`
  el.style.height = `${span}px`
  layer.fx.append(el)
  const x = (center.col - 1) * size
  const y = (center.row - 1) * size
  gsap.set(el, { x, y, autoAlpha: 0, scale: 0.62, transformOrigin: '50% 50%' })
  tl.fromTo(
    el,
    { autoAlpha: 1, scale: 0.62 },
    {
      autoAlpha: 0,
      scale: 1.16,
      duration: EXPLODE_DURATION,
      ease: 'power2.out',
      immediateRender: false,
      onComplete: () => el.remove(),
    },
    start,
  )
}

function scheduleSwap(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'swap' }>,
  start: number,
  size: number,
): PendingSwap | null {
  tl.add(() => play('swap'), start)
  const first = layer.at(event.a.row, event.a.col)
  const second = layer.at(event.b.row, event.b.col)
  if (!first || !second) return null
  const a = { row: event.a.row, col: event.a.col }
  const b = { row: event.b.row, col: event.b.col }
  first.row = b.row
  first.col = b.col
  second.row = a.row
  second.col = a.col
  glide(tl, first.el, a, b, size, start, SWAP_DURATION, 'power2.inOut')
  glide(tl, second.el, b, a, size, start, SWAP_DURATION, 'power2.inOut')
  tl.set([first.el, second.el], { zIndex: 2 }, start)
  tl.set([first.el, second.el], { zIndex: 1 }, start + SWAP_DURATION)
  return { first, second, a, b }
}

function scheduleReject(
  tl: gsap.core.Timeline,
  swapped: PendingSwap | null,
  start: number,
  size: number,
): boolean {
  tl.add(() => play('reject'), start)
  if (!swapped) return false
  const { first, second, a, b } = swapped
  first.row = a.row
  first.col = a.col
  second.row = b.row
  second.col = b.col
  glide(tl, first.el, b, a, size, start, REJECT_DURATION, 'power2.inOut')
  glide(tl, second.el, a, b, size, start, REJECT_DURATION, 'power2.inOut')
  tl.set([first.el, second.el], { zIndex: 2 }, start)
  tl.set([first.el, second.el], { zIndex: 1 }, start + REJECT_DURATION)
  return true
}

function coinAim(scoreEl: HTMLElement, fx: HTMLElement): { x: number; y: number } | null {
  const badge = scoreEl.parentElement?.querySelector('.score-coin')
  const node = badge instanceof HTMLElement ? badge : scoreEl
  const from = fx.getBoundingClientRect()
  const to = node.getBoundingClientRect()
  if (from.width === 0 || to.width === 0) return null
  return {
    x: to.left + to.width / 2 - from.left,
    y: to.top + to.height / 2 - from.top,
  }
}

function rowCells(event: Extract<GameEvent, { type: 'match' }>): Position[] {
  const source = event.runs.length > 0 ? event.runs.flatMap((run) => run.cells) : event.removed
  const seen = new Set<string>()
  const cells: Position[] = []
  for (const cell of source) {
    const key = `${cell.row},${cell.col}`
    if (seen.has(key)) continue
    seen.add(key)
    cells.push(cell)
  }
  return cells
}

function launchCoin(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  scoreEl: HTMLElement,
  fromX: number,
  fromY: number,
  start: number,
  size: number,
  side: number,
  scale: number,
): void {
  const el = createCoinElement()
  layer.fx.append(el)
  const path = { toX: fromX, toY: fromY - size, midX: fromX, midY: fromY - size }
  const spin = side * (240 + Math.random() * 200)
  const state = { t: 0 }
  const remove = (): void => {
    el.remove()
  }
  gsap.set(el, {
    x: fromX,
    y: fromY,
    xPercent: -50,
    yPercent: -50,
    scale: scale * 0.35,
    autoAlpha: 0,
    rotation: 0,
  })
  tl.to(
    state,
    {
      t: 1,
      duration: COIN_FLIGHT,
      ease: 'power2.out',
      immediateRender: false,
      onStart: () => {
        const aim = coinAim(scoreEl, layer.fx)
        const toX = aim?.x ?? fromX
        const toY = aim?.y ?? fromY - size * 4
        const dx = toX - fromX
        const dy = toY - fromY
        const len = Math.hypot(dx, dy) || 1
        const bow = side * size * (0.28 + Math.random() * 0.38)
        path.toX = toX
        path.toY = toY
        path.midX = (fromX + toX) / 2 + (-dy / len) * bow
        path.midY = (fromY + toY) / 2 + (dx / len) * bow - size * 0.42
        gsap.set(el, { autoAlpha: 1 })
      },
      onUpdate: () => {
        const t = state.t
        const u = 1 - t
        const x = u * u * fromX + 2 * u * t * path.midX + t * t * path.toX
        const y = u * u * fromY + 2 * u * t * path.midY + t * t * path.toY
        const pop = t < 0.12 ? 0.65 + (t / 0.12) * 0.5 : t > 0.78 ? 1.15 - ((t - 0.78) / 0.22) * 0.5 : 1.15
        const fade = t < 0.86 ? 1 : 1 - (t - 0.86) / 0.14
        gsap.set(el, {
          x,
          y,
          scale: scale * pop,
          rotation: spin * t,
          autoAlpha: Math.max(0, fade),
        })
      },
      onComplete: remove,
      onInterrupt: remove,
    },
    start,
  )
}

/** Монетки с каждой клетки снятого ряда летят к счётчику. Число не трогаем. */
function flyCoins(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'match' }>,
  scoreEl: HTMLElement,
  start: number,
  size: number,
): void {
  const cells = rowCells(event)
  cells.forEach((pos, index) => {
    const originX = pos.col * size + size * 0.5
    const originY = pos.row * size + size * 0.5
    const delay = index * 0.035
    launchCoin(
      tl,
      layer,
      scoreEl,
      originX + (Math.random() - 0.5) * size * 0.16,
      originY + (Math.random() - 0.5) * size * 0.16,
      start + delay,
      size,
      1,
      1,
    )
    launchCoin(
      tl,
      layer,
      scoreEl,
      originX + (Math.random() - 0.5) * size * 0.22,
      originY + (Math.random() - 0.5) * size * 0.22,
      start + delay + 0.05,
      size,
      -1,
      0.78,
    )
  })
}

function scheduleMatch(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'match' }>,
  start: number,
  size: number,
  scoreEl: HTMLElement,
): void {
  tl.add(() => play('match'), start)
  flyCoins(tl, layer, event, scoreEl, start, size)
  for (const pos of event.removed) {
    const piece = layer.at(pos.row, pos.col)
    if (!piece) continue
    const color = shardColor(piece)
    layer.forget(piece)
    fadeOut(layer, tl, piece, start, MATCH_DURATION)
    burst(layer, tl, pos, color, start, MATCH_DURATION, 'line', size)
  }
  for (const bomb of event.bombs) {
    const pos = bomb.at
    const previous = layer.at(pos.row, pos.col)
    const color = previous ? shardColor(previous) : BOMB_SHARD
    if (previous) {
      layer.forget(previous)
      tl.to(
        previous.el,
        {
          autoAlpha: 0,
          duration: MATCH_DURATION * 0.45,
          ease: 'power1.out',
          onComplete: () => layer.remove(previous),
        },
        start,
      )
    }
    const created = layer.mount(bomb.cell, pos.row, pos.col)
    gsap.set(created.el, {
      x: pos.col * size,
      y: pos.row * size,
      scale: 0.45,
      autoAlpha: 0,
      zIndex: 2,
    })
    tl.set(created.el, { autoAlpha: 1 }, start)
    tl.to(
      created.el,
      {
        scale: 1,
        duration: MATCH_DURATION,
        ease: 'back.out(1.7)',
      },
      start,
    )
    tl.set(created.el, { zIndex: 1 }, start + MATCH_DURATION)
    burst(layer, tl, pos, color, start, MATCH_DURATION, 'line', size)
  }
}

function scheduleExplode(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'explode' }>,
  start: number,
  size: number,
): void {
  tl.add(() => play('explode'), start)
  flash(layer, tl, event.center, start, size)
  for (const pos of event.cells) {
    const piece = layer.at(pos.row, pos.col)
    if (!piece) continue
    const color = shardColor(piece)
    layer.forget(piece)
    fadeOut(layer, tl, piece, start, EXPLODE_DURATION * 0.72)
    burst(layer, tl, pos, color, start, EXPLODE_DURATION, 'blast', size)
  }
}

function scheduleFall(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'fall' }>,
  start: number,
  size: number,
): void {
  tl.add(() => play('fall'), start)
  for (const move of event.moves) {
    const piece = layer.get(move.id)
    if (!piece) continue
    piece.row = move.to.row
    piece.col = move.to.col
    glide(tl, piece.el, move.from, move.to, size, start, FALL_DURATION, 'power2.in')
  }
}

function scheduleSpawn(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'spawn' }>,
  start: number,
  size: number,
): void {
  tl.add(() => play('spawn'), start)
  for (const spawned of event.cells) {
    const piece = layer.mount(spawned.cell, spawned.at.row, spawned.at.col)
    const from = { row: spawned.fromRow, col: spawned.at.col }
    gsap.set(piece.el, {
      x: from.col * size,
      y: from.row * size,
      autoAlpha: 0,
      scale: 1,
    })
    tl.set(piece.el, { autoAlpha: 1 }, start)
    glide(tl, piece.el, from, spawned.at, size, start, SPAWN_DURATION, 'power2.in', false)
  }
}

function scheduleDamage(
  tl: gsap.core.Timeline,
  enemy: EnemyPlayback,
  event: Extract<GameEvent, { type: 'damage' }>,
  start: number,
): void {
  tl.add(() => {
    play('damage')
    enemy.onDamage(event)
  }, start)
  tl.fromTo(
    enemy.el,
    { x: 0 },
    {
      x: 7,
      duration: 0.05,
      yoyo: true,
      repeat: 3,
      ease: 'power1.inOut',
      overwrite: 'auto',
    },
    start,
  )
}

function scheduleDefeat(
  tl: gsap.core.Timeline,
  enemy: EnemyPlayback,
  start: number,
): void {
  tl.add(() => {
    play('defeat')
    enemy.onDefeat()
  }, start)
  tl.fromTo(
    enemy.el,
    { scale: 1 },
    {
      scale: 0.96,
      duration: 0.12,
      yoyo: true,
      repeat: 1,
      ease: 'power1.inOut',
      transformOrigin: 'center center',
      overwrite: 'auto',
    },
    start,
  )
}

function scheduleScore(
  tl: gsap.core.Timeline,
  scoreEl: HTMLElement,
  event: Extract<GameEvent, { type: 'score' }>,
  start: number,
  setScore: (total: number) => void,
): void {
  const base = getComputedStyle(scoreEl).color || '#ffe7a8'
  const badge = scoreEl.parentElement?.querySelector('.score-coin')
  tl.add(() => {
    play('score', event.multiplier)
    setScore(event.total)
  }, start)
  tl.fromTo(
    scoreEl,
    { scale: 1, color: base },
    {
      scale: 1.28,
      color: '#fff6d0',
      duration: SCORE_DURATION / 2,
      yoyo: true,
      repeat: 1,
      ease: 'power2.out',
      immediateRender: false,
    },
    start,
  )
  if (badge instanceof HTMLElement) {
    tl.fromTo(
      badge,
      { scale: 1 },
      {
        scale: 1.22,
        duration: SCORE_DURATION / 2,
        yoyo: true,
        repeat: 1,
        ease: 'power2.out',
        immediateRender: false,
        transformOrigin: 'center center',
      },
      start,
    )
  }
}

function scheduleHeal(
  tl: gsap.core.Timeline,
  event: Extract<GameEvent, { type: 'heal' }>,
  hooks: BattleHooks,
  start: number,
): void {
  tl.add(() => {
    play('heal')
    hooks.onHeal(event)
  }, start)
}

function scheduleHurt(
  tl: gsap.core.Timeline,
  event: Extract<GameEvent, { type: 'hurt' }>,
  hooks: BattleHooks,
  start: number,
): void {
  tl.add(() => {
    play('hurt')
    hooks.onHurt(event)
  }, start)
}

function scheduleDown(tl: gsap.core.Timeline, hooks: BattleHooks, start: number): void {
  tl.add(() => {
    play('down')
    hooks.onDown()
  }, start)
}

function scheduleCharge(
  tl: gsap.core.Timeline,
  event: Extract<GameEvent, { type: 'charge' }>,
  hooks: BattleHooks,
  start: number,
): void {
  tl.add(() => {
    play('charge', event.value)
    hooks.onCharge(event.value)
  }, start)
}

function scheduleCast(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'cast' }>,
  hooks: BattleHooks,
  start: number,
): void {
  tl.add(() => {
    play('cast')
    if (event.trick === 'shatter') layer.dropSkulls()
    if (event.trick === 'quench') layer.clearFire()
    if (event.trick === 'breach') hooks.onBreach()
    if (event.trick === 'scrape') layer.clearSlop()
  }, start)
}

function scheduleFizzle(tl: gsap.core.Timeline, start: number): void {
  tl.add(() => play('fizzle'), start)
}

function scheduleThaw(tl: gsap.core.Timeline, layer: PieceLayer, hooks: BattleHooks, start: number): void {
  tl.add(() => {
    play('thaw')
    layer.setFrozen(null)
    hooks.onFreeze(null)
  }, start)
}

function scheduleCorrupt(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'corrupt' }>,
  hooks: BattleHooks,
  start: number,
): void {
  tl.add(() => {
    play('corrupt')
    if (event.trick === 'freeze') {
      layer.setFrozen(event.color)
      hooks.onFreeze(event.color)
      return
    }
    if (event.trick === 'skull') {
      const pos = event.cells[0]
      if (pos) layer.plantSkull(pos.row, pos.col)
      return
    }
    if (event.trick === 'ignite') {
      const pos = event.cells[0]
      if (!pos) return
      const piece = layer.at(pos.row, pos.col)
      if (piece) layer.ignite(piece.id)
      return
    }
    if (event.trick === 'slop') {
      const pos = event.cells[0]
      if (!pos) return
      const piece = layer.at(pos.row, pos.col)
      if (piece) layer.grease(piece.id)
    }
  }, start)
}

function scheduleBurn(
  tl: gsap.core.Timeline,
  layer: PieceLayer,
  event: Extract<GameEvent, { type: 'burn' }>,
  start: number,
  size: number,
): void {
  tl.add(() => play('burn'), start)
  for (const pos of event.cells) {
    const piece = layer.at(pos.row, pos.col)
    if (!piece) continue
    const color = shardColor(piece)
    layer.forget(piece)
    fadeOut(layer, tl, piece, start, BURN_DURATION * 0.72)
    burst(layer, tl, pos, color, start, BURN_DURATION, 'blast', size)
  }
}

/** Один таймлайн на ход. Звук и частицы стоят на старте своего события. */
export function playEvents(
  layer: PieceLayer,
  events: readonly GameEvent[],
  scoreEl: HTMLElement,
  setScore: (total: number) => void,
  enemy: EnemyPlayback,
  hooks: BattleHooks,
): gsap.core.Timeline {
  const tl = gsap.timeline({ paused: true })
  const size = layer.cellSize()
  let cursor = 0
  let swapped: PendingSwap | null = null

  for (const event of events) {
    const start = cursor
    switch (event.type) {
      case 'swap':
        swapped = scheduleSwap(tl, layer, event, start, size)
        cursor += SWAP_DURATION
        break
      case 'reject':
        cursor += scheduleReject(tl, swapped, start, size) ? REJECT_DURATION : 0
        swapped = null
        break
      case 'match':
        swapped = null
        scheduleMatch(tl, layer, event, start, size, scoreEl)
        cursor += MATCH_DURATION
        break
      case 'damage':
        swapped = null
        scheduleDamage(tl, enemy, event, start)
        cursor += DAMAGE_DURATION
        break
      case 'defeat':
        swapped = null
        scheduleDefeat(tl, enemy, start)
        cursor += DEFEAT_DURATION
        break
      case 'explode':
        swapped = null
        scheduleExplode(tl, layer, event, start, size)
        cursor += EXPLODE_DURATION
        break
      case 'fall':
        swapped = null
        scheduleFall(tl, layer, event, start, size)
        cursor += FALL_DURATION
        break
      case 'spawn':
        swapped = null
        scheduleSpawn(tl, layer, event, start, size)
        cursor += SPAWN_DURATION
        break
      case 'score':
        swapped = null
        scheduleScore(tl, scoreEl, event, start, setScore)
        cursor += SCORE_DURATION
        break
      case 'heal':
        swapped = null
        scheduleHeal(tl, event, hooks, start)
        cursor += HEAL_DURATION
        break
      case 'hurt':
        swapped = null
        scheduleHurt(tl, event, hooks, start)
        cursor += HURT_DURATION
        break
      case 'down':
        swapped = null
        scheduleDown(tl, hooks, start)
        cursor += DOWN_DURATION
        break
      case 'charge':
        swapped = null
        scheduleCharge(tl, event, hooks, start)
        cursor += CHARGE_DURATION
        break
      case 'cast':
        swapped = null
        scheduleCast(tl, layer, event, hooks, start)
        cursor += CAST_DURATION
        break
      case 'fizzle':
        swapped = null
        scheduleFizzle(tl, start)
        cursor += FIZZLE_DURATION
        break
      case 'thaw':
        swapped = null
        scheduleThaw(tl, layer, hooks, start)
        cursor += THAW_DURATION
        break
      case 'corrupt':
        swapped = null
        scheduleCorrupt(tl, layer, event, hooks, start)
        cursor += CORRUPT_DURATION
        break
      case 'burn':
        swapped = null
        scheduleBurn(tl, layer, event, start, size)
        cursor += BURN_DURATION
        break
      default:
        assertNever(event)
    }
  }

  return tl
}
