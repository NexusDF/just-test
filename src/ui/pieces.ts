import gsap from 'gsap'
import { BOARD_SIZE } from '../game'
import type { Board, Cell, GemColor } from '../game'
import { fireUrl, iceUrl, imageSource, slopUrl } from './gems'

export interface Piece {
  id: string
  kind: 'gem' | 'bomb' | 'skull'
  color: GemColor | null
  row: number
  col: number
  el: HTMLDivElement
}

export interface PieceLayer {
  fx: HTMLElement
  at(row: number, col: number): Piece | undefined
  get(id: string): Piece | undefined
  mount(cell: Cell, row: number, col: number): Piece
  forget(piece: Piece): void
  remove(piece: Piece): void
  cellSize(): number
  layout(): void
  sync(board: Board): void
  ensureAttached(): void
  destroy(): void
  setFrozen(color: GemColor | null): void
  ignite(id: string): void
  clearFire(): void
  dropSkulls(): void
  plantSkull(row: number, col: number): void
  grease(id: string): void
  clearSlop(): void
  applyHazards(color: GemColor | null, blazeIds: readonly string[], slopIds: readonly string[]): void
}

export function createPieceLayer(
  root: HTMLElement,
  fx: HTMLElement,
  readSize: () => number,
): PieceLayer {
  const pieces = new Map<string, Piece>()
  let frozen: GemColor | null = null
  const blazes = new Set<string>()
  const slops = new Set<string>()

  function paint(piece: Piece): void {
    const ice = piece.el.querySelector('.piece-ice')
    const fire = piece.el.querySelector('.piece-fire')
    const slop = piece.el.querySelector('.piece-slop')
    if (ice instanceof HTMLElement) {
      ice.classList.toggle('is-on', piece.kind === 'gem' && piece.color === frozen && frozen !== null)
    }
    if (fire instanceof HTMLElement) fire.classList.toggle('is-on', blazes.has(piece.id))
    if (slop instanceof HTMLElement) slop.classList.toggle('is-on', piece.kind === 'gem' && slops.has(piece.id))
  }

  function cellSize(): number {
    const size = readSize()
    return Number.isFinite(size) && size > 0 ? size : 64
  }

  function place(piece: Piece): void {
    const size = cellSize()
    gsap.set(piece.el, {
      x: piece.col * size,
      y: piece.row * size,
      scale: 1,
      autoAlpha: 1,
      rotation: 0,
      zIndex: 1,
    })
  }

  function mount(cell: Cell, row: number, col: number): Piece {
    const el = document.createElement('div')
    el.className = 'piece'
    el.dataset.id = cell.id
    const img = document.createElement('img')
    img.className = 'piece-image'
    img.alt = ''
    img.draggable = false
    img.src = imageSource(cell)
    const ice = document.createElement('img')
    ice.className = 'piece-ice'
    ice.alt = ''
    ice.draggable = false
    ice.src = iceUrl
    const fire = document.createElement('img')
    fire.className = 'piece-fire'
    fire.alt = ''
    fire.draggable = false
    fire.src = fireUrl
    const slop = document.createElement('img')
    slop.className = 'piece-slop'
    slop.alt = ''
    slop.draggable = false
    slop.src = slopUrl
    el.append(img, ice, fire, slop)
    root.append(el)
    const piece: Piece = {
      id: cell.id,
      kind: cell.kind,
      color: cell.kind === 'gem' ? cell.color : null,
      row,
      col,
      el,
    }
    pieces.set(piece.id, piece)
    place(piece)
    paint(piece)
    return piece
  }

  function forget(piece: Piece): void {
    piece.row = -1
    piece.col = -1
  }

  function remove(piece: Piece): void {
    pieces.delete(piece.id)
    piece.row = -1
    piece.col = -1
    piece.el.remove()
  }

  function at(row: number, col: number): Piece | undefined {
    for (const piece of pieces.values()) {
      if (piece.row === row && piece.col === col) return piece
    }
    return undefined
  }

  function layout(): void {
    for (const piece of pieces.values()) {
      if (piece.row < 0 || piece.col < 0) continue
      place(piece)
    }
  }

  function sync(board: Board): void {
    const keep = new Set<string>()
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      const line = board[row]
      if (!line) continue
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = line[col]
        if (!cell) continue
        keep.add(cell.id)
        const existing = pieces.get(cell.id)
        if (!existing) {
          mount(cell, row, col)
          continue
        }
        existing.kind = cell.kind
        existing.color = cell.kind === 'gem' ? cell.color : null
        existing.row = row
        existing.col = col
        const img = existing.el.querySelector('img')
        if (img instanceof HTMLImageElement) {
          const src = imageSource(cell)
          if (img.getAttribute('src') !== src) img.src = src
        }
        place(existing)
        paint(existing)
      }
    }
    for (const piece of [...pieces.values()]) {
      if (!keep.has(piece.id)) remove(piece)
    }
  }

  function ensureAttached(): void {
    for (const piece of pieces.values()) {
      if (piece.el.parentElement !== root) root.append(piece.el)
    }
  }

  function destroy(): void {
    for (const piece of pieces.values()) {
      gsap.killTweensOf(piece.el)
      piece.el.remove()
    }
    pieces.clear()
    for (const child of [...fx.children]) {
      gsap.killTweensOf(child)
      child.remove()
    }
  }

  function setFrozen(color: GemColor | null): void {
    frozen = color
    for (const piece of pieces.values()) paint(piece)
  }

  function ignite(id: string): void {
    blazes.add(id)
    const piece = pieces.get(id)
    if (piece) paint(piece)
  }

  function clearFire(): void {
    blazes.clear()
    for (const piece of pieces.values()) paint(piece)
  }

  function grease(id: string): void {
    slops.add(id)
    const piece = pieces.get(id)
    if (piece) paint(piece)
  }

  function clearSlop(): void {
    slops.clear()
    for (const piece of pieces.values()) paint(piece)
  }

  function dropSkulls(): void {
    for (const piece of [...pieces.values()]) {
      if (piece.kind === 'skull') remove(piece)
    }
  }

  function plantSkull(row: number, col: number): void {
    const previous = at(row, col)
    if (previous) remove(previous)
    mount({ id: `skull-${row}-${col}`, kind: 'skull' }, row, col)
  }

  function applyHazards(
    color: GemColor | null,
    blazeIds: readonly string[],
    slopIds: readonly string[],
  ): void {
    frozen = color
    blazes.clear()
    for (const id of blazeIds) blazes.add(id)
    slops.clear()
    for (const id of slopIds) slops.add(id)
    for (const piece of pieces.values()) paint(piece)
  }

  return {
    fx,
    at,
    get: (id) => pieces.get(id),
    mount,
    forget,
    remove,
    cellSize,
    layout,
    sync,
    ensureAttached,
    destroy,
    setFrozen,
    ignite,
    clearFire,
    grease,
    clearSlop,
    dropSkulls,
    plantSkull,
    applyHazards,
  }
}
