import { describe, expect, it } from 'vitest'
import {
  BOARD_SIZE,
  BOSSES,
  BURN_HURT,
  CHARGE_MAX,
  DAMAGE_PER_GEM,
  ENEMY_MAX_HP,
  ENEMY_NAME,
  EXPLOSION_DAMAGE,
  GEM_COLORS,
  PLAYER_MAX_HP,
  SKULL_HEAL,
  SLOP_HEAL,
  applyCast,
  applySwap,
  createState,
  nextLevel,
} from './index'
import type {
  Board,
  Cell,
  DamageEvent,
  ExplodeEvent,
  FallEvent,
  GameEvent,
  GameState,
  GemColor,
  MatchEvent,
  Position,
  RandomSource,
  ScoreEvent,
  SpawnEvent,
} from './index'

/**
 * Фон без двух соседних гемов одного цвета: цвет (row * 2 + col) % 5.
 * Сценарии только докрашивают нужные клетки.
 */
function baseBoard(): Board {
  const board: Board = []
  let serial = 1
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const line: (Cell | null)[] = []
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      line.push({
        id: `c${serial}`,
        kind: 'gem',
        color: GEM_COLORS[(row * 2 + col) % GEM_COLORS.length] ?? 'red',
      })
      serial += 1
    }
    board.push(line)
  }
  return board
}

function paint(board: Board, row: number, col: number, color: GemColor): void {
  const cell = board[row]?.[col]
  if (!cell || cell.kind !== 'gem') throw new Error(`нет гема ${row},${col}`)
  cell.color = color
}

function plantBomb(board: Board, row: number, col: number): void {
  const cell = board[row]?.[col]
  board[row][col] = { id: cell?.id ?? `x${row}${col}`, kind: 'bomb' }
}

function stateFrom(board: Board, hp: number = ENEMY_MAX_HP, level = 0): GameState {
  const boss = BOSSES[level] ?? BOSSES[0]
  return {
    board,
    score: 0,
    level,
    enemy: { name: boss.name, hp, maxHp: boss.maxHp },
    player: { hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP },
    charge: 0,
    moves: 0,
    frozen: null,
    frozenTurns: 0,
    breached: false,
    blazes: [],
    slops: [],
  }
}

function plantSkull(board: Board, row: number, col: number): void {
  const cell = board[row]?.[col]
  board[row][col] = { id: cell?.id ?? `s${row}${col}`, kind: 'skull' }
}

function indicesRandom(indices: number[]): RandomSource {
  let cursor = 0
  return () => {
    const index = indices[cursor] ?? 0
    cursor += 1
    return (index + 0.5) / GEM_COLORS.length
  }
}

function mulberry32(seed: number): RandomSource {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let mixed = value
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function countRuns(board: Board): number {
  let count = 0
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    let col = 0
    while (col < BOARD_SIZE) {
      const cell = board[row]?.[col]
      if (!cell || cell.kind !== 'gem') {
        col += 1
        continue
      }
      const { color } = cell
      const start = col
      col += 1
      while (col < BOARD_SIZE) {
        const next = board[row]?.[col]
        if (!next || next.kind !== 'gem' || next.color !== color) break
        col += 1
      }
      if (col - start >= 3) count += 1
    }
  }
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    let row = 0
    while (row < BOARD_SIZE) {
      const cell = board[row]?.[col]
      if (!cell || cell.kind !== 'gem') {
        row += 1
        continue
      }
      const { color } = cell
      const start = row
      row += 1
      while (row < BOARD_SIZE) {
        const next = board[row]?.[col]
        if (!next || next.kind !== 'gem' || next.color !== color) break
        row += 1
      }
      if (row - start >= 3) count += 1
    }
  }
  return count
}

function hasSwapThatMatches(board: Board): boolean {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (col + 1 < BOARD_SIZE && createsRun(board, { row, col }, { row, col: col + 1 })) return true
      if (row + 1 < BOARD_SIZE && createsRun(board, { row, col }, { row: row + 1, col })) return true
    }
  }
  return false
}

function createsRun(board: Board, a: Position, b: Position): boolean {
  const copy = board.map((row) => row.map((cell) => (cell ? { ...cell } : null)))
  const saved = copy[a.row]?.[a.col]
  const rowA = copy[a.row]
  const rowB = copy[b.row]
  if (!rowA || !rowB) return false
  rowA[a.col] = rowB[b.col] ?? null
  rowB[b.col] = saved ?? null
  return countRuns(copy) > 0
}

function play(state: GameState, a: Position, b: Position, random?: RandomSource) {
  const before = JSON.stringify(state)
  const refs = state.board.map((row) => row.map((cell) => cell))
  const result = applySwap(state, a, b, random)
  expect(JSON.stringify(state)).toBe(before)
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      expect(state.board[row]?.[col]).toBe(refs[row]?.[col])
    }
  }

  const inputCells = new Set(refs.flat().filter((cell): cell is Cell => cell !== null))
  for (const event of result.events) {
    if (event.type === 'match') {
      for (const bomb of event.bombs) expect(inputCells.has(bomb.cell)).toBe(false)
    }
    if (event.type === 'spawn') {
      for (const gem of event.cells) expect(inputCells.has(gem.cell)).toBe(false)
    }
  }

  if (result.state === state) return result

  const inputRows = new Set(state.board)
  expect(result.state.board).not.toBe(state.board)
  for (const row of result.state.board) {
    expect(inputRows.has(row)).toBe(false)
    expect(row).toHaveLength(BOARD_SIZE)
    for (const cell of row) {
      expect(cell).not.toBeNull()
      if (cell) expect(inputCells.has(cell)).toBe(false)
    }
  }
  expect(countRuns(result.state.board)).toBe(0)
  return result
}

function matchesOf(events: GameEvent[]): MatchEvent[] {
  return events.filter((event): event is MatchEvent => event.type === 'match')
}

function scoresOf(events: GameEvent[]): ScoreEvent[] {
  return events.filter((event): event is ScoreEvent => event.type === 'score')
}

function damagesOf(events: GameEvent[]): DamageEvent[] {
  return events.filter((event): event is DamageEvent => event.type === 'damage')
}

function explodesOf(events: GameEvent[]): ExplodeEvent[] {
  return events.filter((event): event is ExplodeEvent => event.type === 'explode')
}

function oneMatch(events: GameEvent[]): MatchEvent {
  const matches = matchesOf(events)
  expect(matches).toHaveLength(1)
  const match = matches[0]
  if (!match) throw new Error('нет match')
  return match
}

function tripleAtTop(): Board {
  const board = baseBoard()
  paint(board, 0, 1, 'red')
  paint(board, 1, 2, 'red')
  return board
}

function expectFresh(state: GameState): void {
  expect(state.score).toBe(0)
  expect(state.board).toHaveLength(BOARD_SIZE)
  let serial = 1
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    expect(state.board[row]).toHaveLength(BOARD_SIZE)
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = state.board[row]?.[col]
      expect(cell).toMatchObject({ id: `c${serial}`, kind: 'gem' })
      if (cell && cell.kind === 'gem') expect(GEM_COLORS).toContain(cell.color)
      serial += 1
    }
  }
  expect(countRuns(state.board)).toBe(0)
  expect(hasSwapThatMatches(state.board)).toBe(true)
  expect(state.level).toBe(0)
  expect(state.enemy).toEqual({ name: ENEMY_NAME, hp: ENEMY_MAX_HP, maxHp: ENEMY_MAX_HP })
  expect(state.player).toEqual({ hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP })
  expect(state.charge).toBe(0)
  expect(state.moves).toBe(0)
  expect(state.frozen).toBeNull()
  expect(state.frozenTurns).toBe(0)
  expect(state.breached).toBe(false)
  expect(state.blazes).toEqual([])
  expect(state.slops).toEqual([])
}

describe('три в ряд', () => {
  it('несоседний и внешний ход не меняет поле и не мутирует вход', () => {
    const state = stateFrom(baseBoard())
    const outside: Position[][] = [
      [{ row: 0, col: 0 }, { row: 0, col: 2 }],
      [{ row: 0, col: 0 }, { row: 1, col: 1 }],
      [{ row: 0, col: 0 }, { row: 0, col: 0 }],
      [{ row: -1, col: 0 }, { row: 0, col: 0 }],
      [{ row: 0, col: 0 }, { row: 8, col: 0 }],
      [{ row: 7, col: 7 }, { row: 7, col: 8 }],
    ]
    for (const pair of outside) {
      const a = pair[0]
      const b = pair[1]
      if (!a || !b) throw new Error('пара')
      const snapshotA = { ...a }
      const snapshotB = { ...b }
      const result = play(state, a, b)
      expect(result.state).toBe(state)
      expect(result.events).toEqual([{ type: 'reject', a: snapshotA, b: snapshotB }])
      expect(a).toEqual(snapshotA)
      expect(b).toEqual(snapshotB)
    }
  })

  it('соседний обмен без линии: swap, reject, поле прежнее', () => {
    const state = stateFrom(baseBoard())
    const a = { row: 0, col: 0 }
    const b = { row: 0, col: 1 }
    const result = play(state, a, b)
    expect(result.state).toBe(state)
    expect(result.events).toEqual([
      { type: 'swap', a, b },
      { type: 'reject', a, b },
    ])
  })

  it('линия 3: 30 очков, множитель 1, без бомбы и взрыва', () => {
    const state = stateFrom(tripleAtTop())
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(result.events.map((event) => event.type)).toEqual(['swap', 'match', 'damage', 'score', 'spawn'])
    const match = oneMatch(result.events)
    expect(match.bombs).toEqual([])
    expect(match.runs).toEqual([
      {
        cells: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
          { row: 0, col: 2 },
        ],
      },
    ])
    expect(match.removed).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ])
    expect(explodesOf(result.events)).toEqual([])
    expect(scoresOf(result.events)).toEqual([{ type: 'score', points: 30, total: 30, multiplier: 1 }])
    expect(result.state.score).toBe(30)
  })

  it('линия 4: бомба в клетке b и 90 очков, без взрыва', () => {
    const board = baseBoard()
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'blue')
    paint(board, 0, 3, 'red')
    paint(board, 1, 2, 'red')
    const state = stateFrom(board)
    const a = { row: 1, col: 2 }
    const b = { row: 0, col: 2 }
    const result = play(state, a, b, indicesRandom([1, 2, 3]))
    expect(result.events.map((event) => event.type)).toEqual([
      'swap',
      'match',
      'damage',
      'score',
      'charge',
      'spawn',
    ])
    const match = oneMatch(result.events)
    expect(match.runs[0]?.cells).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 0, col: 3 },
    ])
    expect(match.removed).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 3 },
    ])
    expect(match.bombs).toEqual([{ at: b, cell: { id: 'c65', kind: 'bomb' } }])
    expect(match.bombs[0]?.cell.id).not.toBe('c3')
    expect(result.state.board[0]?.[2]).toMatchObject({ id: 'c65', kind: 'bomb' })
    expect(explodesOf(result.events)).toEqual([])
    expect(scoresOf(result.events)).toEqual([{ type: 'score', points: 90, total: 90, multiplier: 1 }])
    expect(result.events).toContainEqual({ type: 'charge', value: 20, max: CHARGE_MAX })
  })

  it('линия 5: бомбы нет, снято 5, 50 очков', () => {
    const board = baseBoard()
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'blue')
    paint(board, 0, 3, 'red')
    paint(board, 0, 4, 'red')
    paint(board, 0, 5, 'blue')
    paint(board, 1, 2, 'red')
    const state = stateFrom(board)
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 2, 3, 4, 0]))
    expect(result.events.map((event) => event.type)).toEqual(['swap', 'match', 'damage', 'score', 'spawn'])
    const match = oneMatch(result.events)
    expect(match.bombs).toEqual([])
    expect(match.removed).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 0, col: 3 },
      { row: 0, col: 4 },
    ])
    expect(explodesOf(result.events)).toEqual([])
    expect(scoresOf(result.events)).toEqual([{ type: 'score', points: 50, total: 50, multiplier: 1 }])
  })

  it('пересечение двух линий по 3: один match, два runs, 60 очков', () => {
    const board = baseBoard()
    paint(board, 1, 0, 'red')
    paint(board, 1, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 2, 2, 'red')
    const state = stateFrom(board)
    const result = play(state, { row: 1, col: 3 }, { row: 1, col: 2 }, indicesRandom([2, 3, 0, 1, 4]))
    expect(result.events.map((event) => event.type)).toEqual([
      'swap',
      'match',
      'damage',
      'damage',
      'score',
      'fall',
      'spawn',
    ])
    const match = oneMatch(result.events)
    expect(match.runs).toEqual([
      {
        cells: [
          { row: 1, col: 0 },
          { row: 1, col: 1 },
          { row: 1, col: 2 },
        ],
      },
      {
        cells: [
          { row: 0, col: 2 },
          { row: 1, col: 2 },
          { row: 2, col: 2 },
        ],
      },
    ])
    expect(match.removed).toEqual([
      { row: 0, col: 2 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
      { row: 2, col: 2 },
    ])
    expect(match.bombs).toEqual([])
    expect(scoresOf(result.events)).toEqual([{ type: 'score', points: 60, total: 60, multiplier: 1 }])
    const spawn = result.events.find((event): event is SpawnEvent => event.type === 'spawn')
    expect(spawn?.cells.map((cell) => cell.fromRow)).toEqual([-1, -1, -3, -2, -1])
  })

  it('бомба по стороне от новой линии взрывается по 30 за занятую клетку', () => {
    const board = baseBoard()
    paint(board, 0, 0, 'blue')
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 0, 3, 'green')
    plantBomb(board, 0, 4)
    const state = stateFrom(board)
    const result = play(state, { row: 1, col: 3 }, { row: 0, col: 3 }, indicesRandom([2, 3, 4, 0, 2, 0, 1, 4]))
    expect(result.events.map((event) => event.type)).toEqual([
      'swap',
      'match',
      'damage',
      'score',
      'explode',
      'score',
      'charge',
      'spawn',
    ])
    const explodes = explodesOf(result.events)
    expect(explodes).toHaveLength(1)
    expect(explodes[0]?.center).toEqual({ row: 0, col: 4 })
    expect(explodes[0]?.cells).toEqual([
      { row: 0, col: 4 },
      { row: 0, col: 5 },
      { row: 1, col: 3 },
      { row: 1, col: 4 },
      { row: 1, col: 5 },
    ])
    const scores = scoresOf(result.events)
    expect(scores[0]).toEqual({ type: 'score', points: 30, total: 30, multiplier: 1 })
    expect(scores[1]).toEqual({
      type: 'score',
      points: 5 * 30,
      total: 180,
      multiplier: 1,
    })
    expect(result.events).toContainEqual({ type: 'charge', value: 15, max: CHARGE_MAX })
    expect(damagesOf(result.events)).toHaveLength(1)
  })

  it('вторая бомба внутри 3×3 даёт ровно один explode', () => {
    const board = baseBoard()
    paint(board, 0, 0, 'blue')
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 0, 3, 'green')
    plantBomb(board, 0, 4)
    plantBomb(board, 0, 5)
    const state = stateFrom(board)
    const result = play(
      state,
      { row: 1, col: 3 },
      { row: 0, col: 3 },
      indicesRandom([2, 3, 4, 0, 2, 3, 0, 1, 2, 3]),
    )
    const explodes = explodesOf(result.events)
    expect(explodes.map((event) => event.center)).toEqual([
      { row: 0, col: 4 },
      { row: 0, col: 5 },
    ])
    expect(explodes.filter((event) => event.center.row === 0 && event.center.col === 5)).toHaveLength(1)
    expect(explodes[1]?.cells).toEqual([
      { row: 0, col: 6 },
      { row: 1, col: 6 },
    ])
    const scores = scoresOf(result.events)
    expect(scores.map((event) => event.points)).toEqual([30, 150, 60])
    expect(scores.map((event) => event.multiplier)).toEqual([1, 1, 1])
    expect(scores[2]?.total).toBe(30 + 150 + 60)
  })

  it('бомба только по диагонали и вне чужого 3×3 не взрывается', () => {
    const board = baseBoard()
    paint(board, 0, 0, 'blue')
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 0, 3, 'green')
    plantBomb(board, 1, 4)
    const bombId = board[1]?.[4]?.id
    const state = stateFrom(board)
    const result = play(state, { row: 1, col: 3 }, { row: 0, col: 3 }, indicesRandom([2, 3, 0]))
    expect(explodesOf(result.events)).toEqual([])
    expect(result.events.map((event) => event.type)).toEqual(['swap', 'match', 'damage', 'score', 'spawn'])
    expect(result.state.board[1]?.[4]).toMatchObject({ id: bombId, kind: 'bomb' })
    expect(scoresOf(result.events)[0]).toEqual({ type: 'score', points: 30, total: 30, multiplier: 1 })
  })

  it('каскад доигрывает до конца, второй score имеет множитель 2', () => {
    const state = stateFrom(tripleAtTop())
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([3, 3, 3, 0, 1, 4]))
    expect(result.events.map((event) => event.type)).toEqual([
      'swap',
      'match',
      'damage',
      'score',
      'spawn',
      'match',
      'damage',
      'score',
      'charge',
      'spawn',
    ])
    const matches = matchesOf(result.events)
    expect(matches[0]?.bombs).toEqual([])
    expect(matches[1]?.bombs).toEqual([{ at: { row: 0, col: 3 }, cell: { id: 'c68', kind: 'bomb' } }])
    expect(matches[1]?.removed).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ])
    const scores = scoresOf(result.events)
    expect(scores[0]).toEqual({ type: 'score', points: 30, total: 30, multiplier: 1 })
    expect(scores[1]).toEqual({ type: 'score', points: 180, total: 210, multiplier: 2 })
    expect(scores[1]?.total).toBe((scores[0]?.total ?? 0) + (scores[1]?.points ?? 0))
    expect(result.events).toContainEqual({ type: 'charge', value: 45, max: CHARGE_MAX })
    expect(result.state.score).toBe(210)
    expect(result.state.board[0]?.[3]).toMatchObject({ id: 'c68', kind: 'bomb' })
    expect(explodesOf(result.events)).toEqual([])
  })

  it('падение сохраняет id, spawn даёт новые гемы и верный fromRow', () => {
    const board = baseBoard()
    paint(board, 7, 0, 'red')
    paint(board, 7, 2, 'green')
    paint(board, 6, 2, 'red')
    const state = stateFrom(board)
    const result = play(state, { row: 6, col: 2 }, { row: 7, col: 2 }, indicesRandom([3, 4, 0]))
    expect(result.events.map((event) => event.type)).toEqual([
      'swap',
      'match',
      'damage',
      'score',
      'fall',
      'spawn',
    ])
    const fall = result.events.find((event): event is FallEvent => event.type === 'fall')
    if (!fall) throw new Error('нет fall')
    expect(fall.moves).toHaveLength(21)
    for (let index = 1; index < fall.moves.length; index += 1) {
      const previous = fall.moves[index - 1]
      const current = fall.moves[index]
      if (!previous || !current) throw new Error('ход')
      const order = previous.from.row - current.from.row || previous.from.col - current.from.col
      expect(order).toBeLessThan(0)
    }
    const afterSwap = state.board.map((row) => row.map((cell) => cell))
    const swapped = afterSwap[6]?.[2]
    const landed = afterSwap[7]
    const origin = afterSwap[6]
    if (!landed || !origin) throw new Error('столбец')
    origin[2] = landed[2] ?? null
    landed[2] = swapped ?? null
    for (const move of fall.moves) {
      expect(move.from).not.toEqual(move.to)
      expect(afterSwap[move.from.row]?.[move.from.col]?.id).toBe(move.id)
      expect(result.state.board[move.to.row]?.[move.to.col]?.id).toBe(move.id)
      expect(result.state.board[move.to.row]?.[move.to.col]).not.toBe(
        afterSwap[move.from.row]?.[move.from.col],
      )
    }
    expect(fall.moves[0]).toEqual({
      id: 'c1',
      from: { row: 0, col: 0 },
      to: { row: 1, col: 0 },
    })
    expect(fall.moves[20]).toEqual({
      id: 'c59',
      from: { row: 6, col: 2 },
      to: { row: 7, col: 2 },
    })
    expect(fall.moves.some((move) => move.id === 'c4' || move.id === 'c51')).toBe(false)

    const spawn = result.events.find((event): event is SpawnEvent => event.type === 'spawn')
    if (!spawn) throw new Error('нет spawn')
    expect(spawn.cells.map((cell) => [cell.at.row, cell.at.col, cell.fromRow])).toEqual([
      [0, 0, -1],
      [0, 1, -1],
      [0, 2, -1],
    ])
    expect(spawn.cells.map((cell) => cell.cell.id)).toEqual(['c65', 'c66', 'c67'])
    expect(spawn.cells.map((cell) => cell.cell.color)).toEqual(['yellow', 'purple', 'red'])
    for (const gem of spawn.cells) {
      expect(gem.cell.kind).toBe('gem')
      expect(gem.fromRow).toBe(gem.at.row - 1)
      expect(result.state.board[gem.at.row]?.[gem.at.col]).toMatchObject({
        id: gem.cell.id,
        kind: 'gem',
        color: gem.cell.color,
      })
    }
  })

  it('createState на 30 сидах: без линий, с ходом, только гемы', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const first = createState(mulberry32(seed))
      const second = createState(mulberry32(seed))
      expectFresh(first)
      expect(second.board).toEqual(first.board)
      expect(second.score).toBe(0)
      expect(second.enemy).toEqual(first.enemy)
    }
    expectFresh(createState())
  })

  it('каждый выбитый ряд снимает здоровье по длине ряда', () => {
    const state = stateFrom(tripleAtTop())
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    const row = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ]
    expect(damagesOf(result.events)).toEqual([
      {
        type: 'damage',
        amount: row.length * DAMAGE_PER_GEM,
        hp: ENEMY_MAX_HP - row.length * DAMAGE_PER_GEM,
        maxHp: ENEMY_MAX_HP,
        cells: row,
      },
    ])
    expect(result.events.some((event) => event.type === 'defeat')).toBe(false)
    expect(result.state.enemy).toEqual({
      name: ENEMY_NAME,
      hp: ENEMY_MAX_HP - 30,
      maxHp: ENEMY_MAX_HP,
    })
    expect(state.enemy.hp).toBe(ENEMY_MAX_HP)
  })

  it('два ряда бьют по очереди, смертельный удар обрезает урон и даёт один defeat', () => {
    const board = baseBoard()
    paint(board, 1, 0, 'red')
    paint(board, 1, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 2, 2, 'red')
    const state = stateFrom(board, 40)
    const result = play(state, { row: 1, col: 3 }, { row: 1, col: 2 }, indicesRandom([2, 3, 0, 1, 4]))
    expect(damagesOf(result.events).map((event) => [event.amount, event.hp])).toEqual([
      [30, 10],
      [10, 0],
    ])
    expect(result.events.map((event) => event.type)).toEqual([
      'swap',
      'match',
      'damage',
      'damage',
      'defeat',
      'score',
      'fall',
      'spawn',
    ])
    expect(result.state.enemy.hp).toBe(0)
  })

  it('ряд, который добивает врага, не даёт бить следующим рядам того же шага', () => {
    const board = baseBoard()
    paint(board, 1, 0, 'red')
    paint(board, 1, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 2, 2, 'red')
    const state = stateFrom(board, 20)
    const result = play(state, { row: 1, col: 3 }, { row: 1, col: 2 }, indicesRandom([2, 3, 0, 1, 4]))
    expect(damagesOf(result.events)).toEqual([
      {
        type: 'damage',
        amount: 20,
        hp: 0,
        maxHp: ENEMY_MAX_HP,
        cells: [
          { row: 1, col: 0 },
          { row: 1, col: 1 },
          { row: 1, col: 2 },
        ],
      },
    ])
    expect(result.events.filter((event) => event.type === 'defeat')).toHaveLength(1)
    expect(result.state.enemy.hp).toBe(0)
  })

  it('поверженный враг больше не получает урон, очки ряда остаются', () => {
    const state = stateFrom(tripleAtTop(), 0)
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(result.events.map((event) => event.type)).toEqual(['swap', 'match', 'score', 'spawn'])
    expect(result.state.enemy.hp).toBe(0)
    expect(scoresOf(result.events)).toEqual([{ type: 'score', points: 30, total: 30, multiplier: 1 }])
  })

  it('каскад бьёт каждым рядом, взрыв здоровье не снимает', () => {
    const alive = stateFrom(tripleAtTop())
    const fought = play(alive, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([3, 3, 3, 0, 1, 4]))
    expect(damagesOf(fought.events).map((event) => event.amount)).toEqual([30, 40])
    expect(fought.state.enemy.hp).toBe(ENEMY_MAX_HP - 70)

    const finishing = stateFrom(tripleAtTop(), 30)
    const fallen = play(finishing, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([3, 3, 3, 0, 1, 4]))
    expect(fallen.events.map((event) => event.type)).toEqual([
      'swap',
      'match',
      'damage',
      'defeat',
      'score',
      'spawn',
      'match',
      'score',
      'charge',
      'spawn',
    ])
    expect(fallen.state.enemy.hp).toBe(0)
    expect(fallen.state.moves).toBe(0)
    expect(fallen.state.player.hp).toBe(PLAYER_MAX_HP)
    expect(fallen.events).toContainEqual({ type: 'charge', value: 45, max: CHARGE_MAX })
    expect(scoresOf(fallen.events).map((event) => event.points)).toEqual([30, 180])
  })

  it('ход сохраняет уровень и имя босса', () => {
    const state = stateFrom(tripleAtTop(), 200, 2)
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(result.state.level).toBe(2)
    expect(result.state.enemy.name).toBe(BOSSES[2].name)
    expect(result.state.enemy.maxHp).toBe(BOSSES[2].maxHp)
    expect(result.state.enemy.hp).toBe(200)
    expect(damagesOf(result.events)).toEqual([])
    expect(scoresOf(result.events)).toEqual([{ type: 'score', points: 30, total: 30, multiplier: 1 }])
  })

  it('nextLevel сохраняет счёт, ставит следующего босса и новое поле', () => {
    const fought = play(stateFrom(tripleAtTop()), { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    const next = nextLevel(fought.state, mulberry32(4))
    expect(next).not.toBeNull()
    if (!next) return
    expect(next.level).toBe(1)
    expect(next.score).toBe(fought.state.score)
    expect(next.score).toBeGreaterThan(0)
    expect(next.enemy).toEqual({
      name: BOSSES[1].name,
      hp: BOSSES[1].maxHp,
      maxHp: BOSSES[1].maxHp,
    })
    expect(countRuns(next.board)).toBe(0)
    expect(hasSwapThatMatches(next.board)).toBe(true)
    const again = nextLevel(fought.state, mulberry32(4))
    expect(again?.board).toEqual(next.board)
  })

  it('после последнего босса nextLevel возвращает null', () => {
    const last = stateFrom(baseBoard(), BOSSES[BOSSES.length - 1].maxHp, BOSSES.length - 1)
    expect(nextLevel(last, mulberry32(1))).toBeNull()
  })

  it('свежее состояние: игрок 100/100, charge 0, moves 0, frozen null, frozenTurns 0, breached false, blazes []', () => {
    const state = createState(mulberry32(1))
    expect(state.player).toEqual({ hp: 100, maxHp: 100 })
    expect(state.charge).toBe(0)
    expect(state.moves).toBe(0)
    expect(state.frozen).toBeNull()
    expect(state.frozenTurns).toBe(0)
    expect(state.breached).toBe(false)
    expect(state.blazes).toEqual([])
    expect(state.slops).toEqual([])
  })

  it('один успешный ход с moves 0 доводит moves до 1 и не бьёт игрока', () => {
    const state = stateFrom(tripleAtTop())
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(result.state.moves).toBe(1)
    expect(result.state.player.hp).toBe(PLAYER_MAX_HP)
    expect(result.events.some((event) => event.type === 'hurt' || event.type === 'down')).toBe(false)
  })

  it('орк, на поле один череп, тройка его не снимает: после урона одно heal на SKULL_HEAL, череп на месте. Если босс уже на полном здоровье, heal нет', () => {
    const woundedBoard = tripleAtTop()
    plantSkull(woundedBoard, 7, 7)
    const skullId = woundedBoard[7]?.[7]?.id
    const wounded = stateFrom(woundedBoard, ENEMY_MAX_HP - SKULL_HEAL)
    const healed = play(wounded, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    const heals = healed.events.filter((event) => event.type === 'heal')
    expect(heals).toEqual([
      {
        type: 'heal',
        amount: SKULL_HEAL,
        hp: ENEMY_MAX_HP - SKULL_HEAL - 3 * DAMAGE_PER_GEM + SKULL_HEAL,
        maxHp: ENEMY_MAX_HP,
      },
    ])
    expect(healed.events.findIndex((event) => event.type === 'heal')).toBeGreaterThan(
      healed.events.findIndex((event) => event.type === 'damage'),
    )
    expect(healed.state.board[7]?.[7]).toMatchObject({ id: skullId, kind: 'skull' })

    const fullBoard = tripleAtTop()
    plantSkull(fullBoard, 7, 7)
    const fullSkull = fullBoard[7]?.[7]?.id
    const fullState = stateFrom(fullBoard)
    fullState.frozen = 'red'
    fullState.frozenTurns = 2
    const full = play(fullState, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(full.events.some((event) => event.type === 'heal')).toBe(false)
    expect(full.state.enemy.hp).toBe(ENEMY_MAX_HP)
    expect(full.state.board[7]?.[7]).toMatchObject({ id: fullSkull, kind: 'skull' })
  })

  it('взрыв, который снимает единственный череп, не даёт heal', () => {
    const board = baseBoard()
    paint(board, 0, 0, 'blue')
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 0, 3, 'green')
    plantBomb(board, 0, 4)
    plantSkull(board, 1, 4)
    const state = stateFrom(board, ENEMY_MAX_HP - SKULL_HEAL)
    const result = play(
      state,
      { row: 1, col: 3 },
      { row: 0, col: 3 },
      indicesRandom([2, 3, 4, 0, 2, 0, 1, 4]),
    )
    expect(explodesOf(result.events)).toHaveLength(1)
    expect(result.events.some((event) => event.type === 'heal')).toBe(false)
    expect(result.state.board.flat().some((cell) => cell?.kind === 'skull')).toBe(false)
    expect(result.state.enemy.hp).toBe(ENEMY_MAX_HP - SKULL_HEAL - 30)
  })

  it('moves равен 2, один успешный ход орка: moves становится 3, hurt ровно boss.hurt, ровно один corrupt trick skull', () => {
    const board = baseBoard()
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'blue')
    paint(board, 0, 3, 'red')
    paint(board, 1, 2, 'red')
    const state = stateFrom(board)
    state.moves = 2
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, () => 0)
    expect(result.state.moves).toBe(3)
    const hurts = result.events.filter((event) => event.type === 'hurt')
    expect(hurts).toEqual([
      {
        type: 'hurt',
        amount: BOSSES[0].hurt,
        hp: PLAYER_MAX_HP - BOSSES[0].hurt,
        maxHp: PLAYER_MAX_HP,
      },
    ])
    expect(BOSSES[0].hurt).toBe(18)
    const corrupts = result.events.filter((event) => event.type === 'corrupt')
    expect(corrupts).toEqual([
      { type: 'corrupt', trick: 'skull', cells: [{ row: 0, col: 0 }], color: null },
    ])
    expect(result.state.board[0]?.[0]?.kind).toBe('skull')
  })

  it('ведьма: frozen red и frozenTurns 1, ход не кратен 4, красная тройка даёт очки и не даёт damage, после хода есть thaw и frozen === null', () => {
    const state = stateFrom(tripleAtTop(), BOSSES[1].maxHp, 1)
    state.frozen = 'red'
    state.frozenTurns = 1
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(result.state.moves).toBe(1)
    expect(damagesOf(result.events)).toEqual([])
    expect(scoresOf(result.events)).toEqual([{ type: 'score', points: 30, total: 30, multiplier: 1 }])
    expect(result.events.some((event) => event.type === 'hurt')).toBe(false)
    expect(result.events).toContainEqual({ type: 'thaw' })
    expect(result.state.frozen).toBeNull()
    expect(result.state.frozenTurns).toBe(0)
    expect(result.state.enemy.hp).toBe(BOSSES[1].maxHp)
  })

  it('гравитация льда: замёрзший гем остаётся в своей строке, клетки выше падают только до него, не сквозь него', () => {
    const board = baseBoard()
    const column: GemColor[] = ['blue', 'yellow', 'purple', 'green', 'red', 'blue', 'green', 'yellow']
    for (let row = 0; row < column.length; row += 1) {
      const color = column[row]
      if (color) paint(board, row, 0, color)
    }
    paint(board, 3, 1, 'green')
    paint(board, 4, 2, 'green')
    const anchor = board[4]?.[0]?.id
    const above = board[2]?.[0]?.id
    const top = board[0]?.[0]?.id
    const below = board[5]?.[0]?.id
    expect(countRuns(board)).toBe(0)
    const state = stateFrom(board)
    state.frozen = 'red'
    state.frozenTurns = 4
    const result = play(state, { row: 4, col: 2 }, { row: 3, col: 2 }, indicesRandom([1, 2, 3]))
    const at = (id: string | undefined) => {
      for (let row = 0; row < BOARD_SIZE; row += 1) {
        for (let col = 0; col < BOARD_SIZE; col += 1) {
          if (result.state.board[row]?.[col]?.id === id) return { row, col }
        }
      }
      return null
    }
    expect(at(anchor)).toEqual({ row: 4, col: 0 })
    expect(at(above)).toEqual({ row: 3, col: 0 })
    expect(at(top)).toEqual({ row: 1, col: 0 })
    expect(at(below)).toEqual({ row: 5, col: 0 })
    expect(result.state.frozen).toBe('red')
  })

  it('applyCast при charge 99 даёт только fizzle и тот же объект state. При 100 на ведьме снимает лёд, пишет cast и charge с value 0, затем thaw, moves не растёт', () => {
    const short = stateFrom(baseBoard())
    short.charge = 99
    const fizzled = applyCast(short)
    expect(fizzled.state).toBe(short)
    expect(fizzled.events).toEqual([{ type: 'fizzle' }])

    const witch = stateFrom(baseBoard(), BOSSES[1].maxHp, 1)
    witch.charge = CHARGE_MAX
    witch.frozen = 'red'
    witch.frozenTurns = 2
    witch.moves = 5
    const before = JSON.stringify(witch)
    const cast = applyCast(witch)
    expect(JSON.stringify(witch)).toBe(before)
    expect(cast.state).not.toBe(witch)
    expect(cast.events).toEqual([
      { type: 'cast', trick: 'thaw' },
      { type: 'charge', value: 0, max: CHARGE_MAX },
      { type: 'thaw' },
    ])
    expect(cast.state.charge).toBe(0)
    expect(cast.state.frozen).toBeNull()
    expect(cast.state.frozenTurns).toBe(0)
    expect(cast.state.moves).toBe(5)
  })

  it('голем: тройка без броска без damage; после cast breach следующая тройка бьёт на 30 и снимает breached; explode бьёт на EXPLOSION_DAMAGE даже без броска', () => {
    const blocked = play(
      stateFrom(tripleAtTop(), 200, 2),
      { row: 1, col: 2 },
      { row: 0, col: 2 },
      indicesRandom([0, 1, 0]),
    )
    expect(damagesOf(blocked.events)).toEqual([])
    expect(blocked.state.enemy.hp).toBe(200)
    expect(blocked.state.breached).toBe(false)
    expect(scoresOf(blocked.events)).toEqual([{ type: 'score', points: 30, total: 30, multiplier: 1 }])

    const armed = stateFrom(tripleAtTop(), 200, 2)
    armed.charge = CHARGE_MAX
    const cast = applyCast(armed)
    expect(cast.state.breached).toBe(true)
    expect(armed.breached).toBe(false)
    const pierced = play(cast.state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(damagesOf(pierced.events)).toEqual([
      {
        type: 'damage',
        amount: 30,
        hp: 170,
        maxHp: BOSSES[2].maxHp,
        cells: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
          { row: 0, col: 2 },
        ],
      },
    ])
    expect(pierced.state.breached).toBe(false)
    expect(pierced.state.enemy.hp).toBe(170)

    const board = baseBoard()
    paint(board, 0, 0, 'blue')
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 0, 3, 'green')
    plantBomb(board, 0, 4)
    const exploded = play(
      stateFrom(board, 200, 2),
      { row: 1, col: 3 },
      { row: 0, col: 3 },
      indicesRandom([2, 3, 4, 0, 2, 0, 1, 4]),
    )
    const boom = explodesOf(exploded.events)
    expect(boom).toHaveLength(1)
    expect(damagesOf(exploded.events)).toEqual([
      {
        type: 'damage',
        amount: EXPLOSION_DAMAGE,
        hp: 200 - EXPLOSION_DAMAGE,
        maxHp: BOSSES[2].maxHp,
        cells: boom[0]?.cells,
      },
    ])
    const types = exploded.events.map((event) => event.type)
    const explodeAt = types.indexOf('explode')
    expect(types.slice(explodeAt, explodeAt + 3)).toEqual(['explode', 'score', 'damage'])
  })

  it('дракон: blaze с turns 1 сгорает на следующем успешном ходе, если этот ход не снял гем. burn, затем hurt на BURN_HURT. Если гем снят линией в этот ход, burn нет', () => {
    const quiet = tripleAtTop()
    const quietId = quiet[7]?.[7]?.id
    if (!quietId) throw new Error('нет гема')
    const alive = stateFrom(quiet, BOSSES[3].maxHp, 3)
    alive.blazes = [{ id: quietId, turns: 1 }]
    const burned = play(alive, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0, 3, 1, 4, 2, 0, 3]))
    const burnAt = burned.events.findIndex((event) => event.type === 'burn')
    const hurtAt = burned.events.findIndex((event) => event.type === 'hurt')
    expect(burnAt).toBeGreaterThan(-1)
    expect(hurtAt).toBeGreaterThan(burnAt)
    expect(burned.events[burnAt]).toEqual({
      type: 'burn',
      cells: [
        { row: 6, col: 7 },
        { row: 7, col: 6 },
        { row: 7, col: 7 },
      ],
    })
    expect(burned.events.filter((event) => event.type === 'hurt')).toEqual([
      {
        type: 'hurt',
        amount: BURN_HURT,
        hp: PLAYER_MAX_HP - BURN_HURT,
        maxHp: PLAYER_MAX_HP,
      },
    ])
    expect(burned.state.blazes.some((blaze) => blaze.id === quietId)).toBe(false)

    const cleared = tripleAtTop()
    const removedId = cleared[0]?.[1]?.id
    if (!removedId) throw new Error('нет гема')
    const doomed = stateFrom(cleared, BOSSES[3].maxHp, 3)
    doomed.blazes = [{ id: removedId, turns: 1 }]
    const spared = play(doomed, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(spared.events.some((event) => event.type === 'burn' || event.type === 'hurt')).toBe(false)
    expect(spared.state.blazes).toEqual([])
    expect(spared.state.player.hp).toBe(PLAYER_MAX_HP)
  })

  it('player.hp равен BURN_HURT и огонь сгорает: hurt доводит до нуля и сразу один down, corrupt нет', () => {
    const board = tripleAtTop()
    const id = board[7]?.[7]?.id
    if (!id) throw new Error('нет гема')
    const state = stateFrom(board, BOSSES[3].maxHp, 3)
    state.player.hp = BURN_HURT
    state.moves = 2
    state.blazes = [{ id, turns: 1 }]
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0, 3, 1, 4, 2, 0, 3]))
    const hurtAt = result.events.findIndex((event) => event.type === 'hurt')
    expect(result.events[hurtAt]).toEqual({
      type: 'hurt',
      amount: BURN_HURT,
      hp: 0,
      maxHp: PLAYER_MAX_HP,
    })
    expect(result.events[hurtAt + 1]).toEqual({ type: 'down' })
    expect(result.events.slice(hurtAt + 2)).toEqual([])
    expect(result.events.filter((event) => event.type === 'hurt')).toHaveLength(1)
    expect(result.events.some((event) => event.type === 'corrupt')).toBe(false)
    expect(result.state.player.hp).toBe(0)
  })

  it('applySwap при player.hp 0 — только reject, тот же state', () => {
    const state = stateFrom(tripleAtTop())
    state.player.hp = 0
    const a = { row: 1, col: 2 }
    const b = { row: 0, col: 2 }
    const result = play(state, a, b)
    expect(result.state).toBe(state)
    expect(result.events).toEqual([{ type: 'reject', a, b }])
  })

  it('nextLevel лечит игрока, обнуляет charge, moves, лёд, breached, blazes, счёт сохраняет', () => {
    const state = stateFrom(baseBoard(), 50, 0)
    state.score = 480
    state.player.hp = 40
    state.charge = 70
    state.moves = 3
    state.frozen = 'blue'
    state.frozenTurns = 2
    state.breached = true
    state.blazes = [{ id: 'c1', turns: 1 }]
    state.slops = ['c9']
    const next = nextLevel(state, mulberry32(4))
    expect(next).not.toBeNull()
    if (!next) return
    expect(next.score).toBe(480)
    expect(next.level).toBe(1)
    expect(next.player).toEqual({ hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP })
    expect(next.charge).toBe(0)
    expect(next.moves).toBe(0)
    expect(next.frozen).toBeNull()
    expect(next.frozenTurns).toBe(0)
    expect(next.breached).toBe(false)
    expect(next.blazes).toEqual([])
    expect(next.slops).toEqual([])
    expect(next.enemy).toEqual({
      name: BOSSES[1].name,
      hp: BOSSES[1].maxHp,
      maxHp: BOSSES[1].maxHp,
    })
    expect(state.score).toBe(480)
    expect(state.player.hp).toBe(40)
    expect(state.blazes).toEqual([{ id: 'c1', turns: 1 }])
    expect(state.slops).toEqual(['c9'])
  })

  it('супер-свин: moves 2, ход даёт hurt 20 и один corrupt slop на первом геме', () => {
    const board = baseBoard()
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'blue')
    paint(board, 0, 3, 'red')
    paint(board, 1, 2, 'red')
    const state = stateFrom(board, BOSSES[4].maxHp, 4)
    state.moves = 2
    const result = play(state, { row: 1, col: 2 }, { row: 0, col: 2 }, () => 0)
    expect(result.state.moves).toBe(3)
    expect(result.state.enemy.name).toBe('Дамир Супер-свин')
    const hurts = result.events.filter((event) => event.type === 'hurt')
    expect(hurts).toEqual([
      {
        type: 'hurt',
        amount: BOSSES[4].hurt,
        hp: PLAYER_MAX_HP - BOSSES[4].hurt,
        maxHp: PLAYER_MAX_HP,
      },
    ])
    expect(BOSSES[4].hurt).toBe(20)
    const greased = result.state.board[0]?.[0]
    expect(greased?.kind).toBe('gem')
    expect(result.events.filter((event) => event.type === 'corrupt')).toEqual([
      { type: 'corrupt', trick: 'slop', cells: [{ row: 0, col: 0 }], color: null },
    ])
    expect(result.state.slops).toEqual([greased?.id])
  })

  it('жир в линии не даёт damage и лечит на SLOP_HEAL за каждый новый id; без жира линия бьёт; на полном здоровье heal нет', () => {
    const woundedBoard = tripleAtTop()
    const inLine = woundedBoard[1]?.[2]?.id
    const aside = woundedBoard[0]?.[0]?.id
    if (!inLine || !aside) throw new Error('нет гема')
    const wounded = stateFrom(woundedBoard, BOSSES[4].maxHp - 100, 4)
    wounded.slops = [inLine]
    const healed = play(wounded, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(damagesOf(healed.events)).toEqual([])
    expect(healed.events.filter((event) => event.type === 'heal')).toEqual([
      {
        type: 'heal',
        amount: SLOP_HEAL,
        hp: BOSSES[4].maxHp - 100 + SLOP_HEAL,
        maxHp: BOSSES[4].maxHp,
      },
    ])
    const healAt = healed.events.findIndex((event) => event.type === 'heal')
    expect(healAt).toBeGreaterThan(healed.events.findIndex((event) => event.type === 'match'))
    expect(healed.events.findIndex((event) => event.type === 'score')).toBeGreaterThan(healAt)
    expect(scoresOf(healed.events)).toEqual([{ type: 'score', points: 30, total: 30, multiplier: 1 }])
    expect(healed.state.slops).toEqual([])
    expect(healed.state.enemy.hp).toBe(BOSSES[4].maxHp - 100 + SLOP_HEAL)

    const pairBoard = tripleAtTop()
    const first = pairBoard[0]?.[0]?.id
    const second = pairBoard[1]?.[2]?.id
    if (!first || !second) throw new Error('нет гема')
    const pair = stateFrom(pairBoard, BOSSES[4].maxHp - 100, 4)
    pair.slops = [first, second]
    const both = play(pair, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(both.events.filter((event) => event.type === 'heal')).toEqual([
      {
        type: 'heal',
        amount: SLOP_HEAL * 2,
        hp: BOSSES[4].maxHp - 100 + SLOP_HEAL * 2,
        maxHp: BOSSES[4].maxHp,
      },
    ])
    expect(damagesOf(both.events)).toEqual([])

    const cleanBoard = tripleAtTop()
    const kept = cleanBoard[7]?.[7]?.id
    if (!kept) throw new Error('нет гема')
    const clean = stateFrom(cleanBoard, BOSSES[4].maxHp - 100, 4)
    clean.slops = [kept]
    const struck = play(clean, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(damagesOf(struck.events)).toEqual([
      {
        type: 'damage',
        amount: 30,
        hp: BOSSES[4].maxHp - 100 - 30,
        maxHp: BOSSES[4].maxHp,
        cells: [
          { row: 0, col: 0 },
          { row: 0, col: 1 },
          { row: 0, col: 2 },
        ],
      },
    ])
    expect(struck.events.some((event) => event.type === 'heal')).toBe(false)
    expect(struck.state.slops).toEqual([kept])

    const fullBoard = tripleAtTop()
    const fullId = fullBoard[1]?.[2]?.id
    if (!fullId) throw new Error('нет гема')
    const full = stateFrom(fullBoard, BOSSES[4].maxHp, 4)
    full.slops = [fullId]
    const stuffed = play(full, { row: 1, col: 2 }, { row: 0, col: 2 }, indicesRandom([0, 1, 0]))
    expect(stuffed.events.some((event) => event.type === 'heal' || event.type === 'damage')).toBe(false)
    expect(stuffed.state.enemy.hp).toBe(BOSSES[4].maxHp)
    expect(stuffed.state.slops).toEqual([])
    expect(scoresOf(stuffed.events)).toEqual([{ type: 'score', points: 30, total: 30, multiplier: 1 }])
  })

  it('взрыв снимает жир и не лечит свина', () => {
    const board = baseBoard()
    paint(board, 0, 0, 'blue')
    paint(board, 0, 1, 'red')
    paint(board, 0, 2, 'red')
    paint(board, 0, 3, 'green')
    plantBomb(board, 0, 4)
    const greased = board[1]?.[4]?.id
    if (!greased) throw new Error('нет гема')
    const state = stateFrom(board, BOSSES[4].maxHp - 100, 4)
    state.slops = [greased]
    const result = play(
      state,
      { row: 1, col: 3 },
      { row: 0, col: 3 },
      indicesRandom([2, 3, 4, 0, 2, 0, 1, 4]),
    )
    expect(explodesOf(result.events)).toHaveLength(1)
    expect(result.events.some((event) => event.type === 'heal')).toBe(false)
    expect(result.state.slops).toEqual([])
    expect(damagesOf(result.events)[0]).toMatchObject({ amount: 30 })
  })

  it('applyCast scrape при полном заряде очищает slops, moves не растит и поле не меняет', () => {
    const board = baseBoard()
    const pig = stateFrom(board, BOSSES[4].maxHp, 4)
    pig.charge = CHARGE_MAX
    pig.moves = 4
    pig.slops = ['c1', 'c2']
    const before = JSON.stringify(pig)
    const cast = applyCast(pig)
    expect(JSON.stringify(pig)).toBe(before)
    expect(cast.state).not.toBe(pig)
    expect(cast.events).toEqual([
      { type: 'cast', trick: 'scrape' },
      { type: 'charge', value: 0, max: CHARGE_MAX },
    ])
    expect(cast.state.slops).toEqual([])
    expect(cast.state.moves).toBe(4)
    expect(cast.state.charge).toBe(0)
    expect(cast.state.board).toEqual(pig.board)
  })
})
