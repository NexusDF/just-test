import {
  BOARD_SIZE,
  BOMB_RUN_LENGTH,
  BOSSES,
  BOSS_EVERY,
  BURN_HURT,
  CHARGE_BOMB,
  CHARGE_CASCADE,
  CHARGE_EXPLODE,
  CHARGE_MAX,
  DAMAGE_PER_GEM,
  EXPLOSION_DAMAGE,
  FIRE_TURNS,
  FREEZE_TURNS,
  GEM_COLORS,
  MATCH_MIN,
  PLAYER_MAX_HP,
  POINTS_BOMB,
  POINTS_EXPLODED_CELL,
  POINTS_PER_GEM,
  SKULL_HEAL,
  SLOP_HEAL,
  inBounds,
  isBomb,
  isGem,
  isOrthogonal,
  isSkull,
  samePosition,
} from './types'
import type {
  Board,
  Blaze,
  BombCell,
  Cell,
  FallMove,
  GameEvent,
  GameState,
  GemCell,
  GemColor,
  Position,
  RandomSource,
  ResolvedMove,
  SpawnedGem,
} from './types'

interface Run {
  cells: Position[]
}

interface SwapBias {
  a: Position
  b: Position
}

function bossAt(level: number): (typeof BOSSES)[number] {
  return BOSSES[level] ?? BOSSES[0]
}

function makeState(level: number, score: number, random: RandomSource): GameState {
  const boss = bossAt(level)
  let board = fillBoard(random)
  while (!hasMove(board)) board = fillBoard(random)
  return {
    board,
    score,
    level,
    enemy: { name: boss.name, hp: boss.maxHp, maxHp: boss.maxHp },
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

export function createState(random?: RandomSource): GameState {
  return makeState(0, 0, random ?? Math.random)
}

export function nextLevel(state: GameState, random?: RandomSource): GameState | null {
  const level = state.level + 1
  if (level >= BOSSES.length) return null
  return makeState(level, state.score, random ?? Math.random)
}

export function applySwap(
  state: GameState,
  a: Position,
  b: Position,
  random?: RandomSource,
): ResolvedMove {
  if (state.player.hp === 0 || !inBounds(a) || !inBounds(b) || !isOrthogonal(a, b)) {
    return { state, events: [{ type: 'reject', a: copyPosition(a), b: copyPosition(b) }] }
  }

  const working = cloneState(state)
  exchange(working.board, a, b)
  const runs = findRuns(working.board)
  if (runs.length === 0) {
    return {
      state,
      events: [
        { type: 'swap', a: copyPosition(a), b: copyPosition(b) },
        { type: 'reject', a: copyPosition(a), b: copyPosition(b) },
      ],
    }
  }

  const source = random ?? Math.random
  const nextId = idFactory(working.board)
  const events: GameEvent[] = [{ type: 'swap', a: copyPosition(a), b: copyPosition(b) }]
  const breachActive = working.breached
  working.breached = false
  resolveCascades(working, runs, 1, { a, b }, breachActive, source, nextId, events)
  if (working.enemy.hp > 0 && working.player.hp > 0) {
    bossPhase(working, breachActive, source, nextId, events)
  }
  return { state: working, events }
}

export function applyCast(state: GameState, random?: RandomSource): ResolvedMove {
  if (state.charge < CHARGE_MAX || state.player.hp === 0 || state.enemy.hp === 0) {
    return { state, events: [{ type: 'fizzle' }] }
  }

  const working = cloneState(state)
  working.charge = 0
  const trick = bossAt(working.level).trick
  const events: GameEvent[] = [
    { type: 'cast', trick },
    { type: 'charge', value: 0, max: CHARGE_MAX },
  ]
  const source = random ?? Math.random
  const nextId = idFactory(working.board)

  if (trick === 'shatter') {
    let opened = false
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        if (!isSkull(cellAt(working.board, row, col))) continue
        working.board[row][col] = null
        opened = true
      }
    }
    if (opened) {
      settle(working, source, nextId, events)
      resolveCascades(
        working,
        findRuns(working.board),
        1,
        null,
        working.breached,
        source,
        nextId,
        events,
      )
    }
  } else if (trick === 'thaw') {
    working.frozen = null
    working.frozenTurns = 0
    events.push({ type: 'thaw' })
  } else if (trick === 'breach') {
    working.breached = true
  } else if (trick === 'scrape') {
    working.slops = []
  } else {
    working.blazes = []
  }

  return { state: working, events }
}

function bossPhase(
  state: GameState,
  breachActive: boolean,
  random: RandomSource,
  nextId: () => string,
  events: GameEvent[],
): void {
  const boss = bossAt(state.level)
  if (boss.trick === 'shatter') {
    const skulls = countSkulls(state.board)
    const amount = Math.min(skulls * SKULL_HEAL, state.enemy.maxHp - state.enemy.hp)
    if (amount > 0) {
      state.enemy.hp += amount
      events.push({
        type: 'heal',
        amount,
        hp: state.enemy.hp,
        maxHp: state.enemy.maxHp,
      })
    }
  }

  state.moves += 1

  if (state.frozenTurns > 0) {
    state.frozenTurns -= 1
    if (state.frozenTurns === 0) {
      state.frozen = null
      events.push({ type: 'thaw' })
    }
  }

  const due: string[] = []
  const kept: Blaze[] = []
  for (const blaze of state.blazes) {
    if (blaze.turns - 1 <= 0) due.push(blaze.id)
    else kept.push({ id: blaze.id, turns: blaze.turns - 1 })
  }
  state.blazes = kept

  const consumed = new Set<string>()
  let burned = 0
  for (const id of due) {
    if (consumed.has(id)) continue
    const pos = findId(state.board, id)
    if (!pos) continue
    const cells = burnArea(state.board, pos)
    events.push({ type: 'burn', cells: cells.map((cell) => copyPosition(cell)) })
    const gone = new Set<string>()
    for (const cell of cells) {
      const occupant = cellAt(state.board, cell.row, cell.col)
      if (occupant) {
        gone.add(occupant.id)
        consumed.add(occupant.id)
      }
      state.board[cell.row][cell.col] = null
    }
    forgetIds(state, gone)
    burned += 1
  }

  if (burned > 0) {
    settle(state, random, nextId, events)
    resolveCascades(state, findRuns(state.board), 1, null, breachActive, random, nextId, events)
    const amount = Math.min(burned * BURN_HURT, state.player.hp)
    if (amount > 0) {
      state.player.hp -= amount
      events.push({
        type: 'hurt',
        amount,
        hp: state.player.hp,
        maxHp: state.player.maxHp,
      })
      if (state.player.hp === 0) {
        events.push({ type: 'down' })
        return
      }
    }
  }

  if (state.enemy.hp <= 0) return
  if (state.moves % BOSS_EVERY !== 0) return

  const amount = Math.min(boss.hurt, state.player.hp)
  if (amount > 0) {
    state.player.hp -= amount
    events.push({
      type: 'hurt',
      amount,
      hp: state.player.hp,
      maxHp: state.player.maxHp,
    })
  }
  if (state.player.hp === 0) {
    events.push({ type: 'down' })
    return
  }
  writeCorrupt(state, random, nextId, events)
}

function writeCorrupt(
  state: GameState,
  random: RandomSource,
  nextId: () => string,
  events: GameEvent[],
): void {
  const trick = bossAt(state.level).trick
  if (trick === 'breach') {
    events.push({ type: 'corrupt', trick: 'armor', cells: [], color: null })
    return
  }
  if (trick === 'thaw') {
    const colors = GEM_COLORS.filter((color) => boardHasColor(state.board, color))
    if (colors.length === 0) return
    const index = Math.floor(random() * colors.length)
    const color = colors[index] ?? GEM_COLORS[0]
    state.frozen = color
    state.frozenTurns = FREEZE_TURNS
    events.push({ type: 'corrupt', trick: 'freeze', cells: [], color })
    return
  }
  const skip =
    trick === 'quench'
      ? new Set(state.blazes.map((blaze) => blaze.id))
      : trick === 'scrape'
        ? new Set(state.slops)
        : new Set<string>()
  const gems = gemPositions(state.board, skip)
  if (gems.length === 0) return
  const index = Math.floor(random() * gems.length)
  const pos = gems[index]
  if (!pos) return
  const previous = cellAt(state.board, pos.row, pos.col)
  if (!previous) return
  if (trick === 'shatter') {
    forgetIds(state, new Set([previous.id]))
    state.board[pos.row][pos.col] = { id: nextId(), kind: 'skull' }
    events.push({ type: 'corrupt', trick: 'skull', cells: [copyPosition(pos)], color: null })
    return
  }
  if (trick === 'scrape') {
    state.slops = [...state.slops, previous.id]
    events.push({ type: 'corrupt', trick: 'slop', cells: [copyPosition(pos)], color: null })
    return
  }
  state.blazes = [...state.blazes, { id: previous.id, turns: FIRE_TURNS }]
  events.push({ type: 'corrupt', trick: 'ignite', cells: [copyPosition(pos)], color: null })
}

function resolveCascades(
  state: GameState,
  runs: Run[],
  multiplier: number,
  bias: SwapBias | null,
  breachActive: boolean,
  random: RandomSource,
  nextId: () => string,
  events: GameEvent[],
): void {
  let pending = runs
  let stepBias = bias
  let stepMultiplier = multiplier
  while (pending.length > 0) {
    resolveStep(state, pending, stepMultiplier, stepBias, breachActive, random, nextId, events)
    stepBias = null
    pending = findRuns(state.board)
    if (pending.length > 0) stepMultiplier += 1
  }
}

function resolveStep(
  state: GameState,
  runs: Run[],
  multiplier: number,
  bias: SwapBias | null,
  breachActive: boolean,
  random: RandomSource,
  nextId: () => string,
  events: GameEvent[],
): void {
  const board = state.board
  const runIds = runs.map((run) => run.cells.map((cell) => cellAt(board, cell.row, cell.col)?.id ?? null))
  const greased = new Set(state.slops)
  const lineKeys = new Set<string>()
  for (const run of runs) {
    for (const cell of run.cells) lineKeys.add(keyOf(cell))
  }

  const runColors: (GemColor | null)[] = runs.map((run) => {
    const origin = run.cells[0]
    if (!origin) return null
    const cell = cellAt(board, origin.row, origin.col)
    return isGem(cell) ? cell.color : null
  })

  const placed = new Set<string>()
  const bombs: { at: Position; cell: BombCell }[] = []
  for (const run of runs) {
    if (run.cells.length !== BOMB_RUN_LENGTH) continue
    const anchor = bombAnchor(run.cells, bias)
    const anchorKey = keyOf(anchor)
    if (placed.has(anchorKey)) continue
    placed.add(anchorKey)
    const cell: BombCell = { id: nextId(), kind: 'bomb' }
    bombs.push({ at: copyPosition(anchor), cell })
  }

  const queue: Position[] = []
  const queued = new Set<string>()
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (!isBomb(cellAt(board, row, col))) continue
      if (!orthogonalToLine(row, col, lineKeys)) continue
      const position = { row, col }
      queue.push(position)
      queued.add(keyOf(position))
    }
  }

  const removed: Position[] = []
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const key = `${row},${col}`
      if (!lineKeys.has(key) || placed.has(key)) continue
      removed.push({ row, col })
    }
  }

  const gone = new Set<string>()
  for (const position of removed) {
    const cell = cellAt(board, position.row, position.col)
    if (cell) gone.add(cell.id)
    board[position.row][position.col] = null
  }
  for (const bomb of bombs) {
    const previous = cellAt(board, bomb.at.row, bomb.at.col)
    if (previous) gone.add(previous.id)
    board[bomb.at.row][bomb.at.col] = bomb.cell
  }
  forgetIds(state, gone)

  events.push({
    type: 'match',
    runs: runs.map((run) => ({
      cells: run.cells.map((cell) => copyPosition(cell)),
    })),
    removed,
    bombs,
  })

  strikeRows(state, runs, runColors, runIds, greased, breachActive, events)

  const linePoints =
    (runs.reduce((sum, run) => sum + run.cells.length, 0) * POINTS_PER_GEM +
      bombs.length * POINTS_BOMB) *
    multiplier
  if (linePoints > 0) {
    state.score += linePoints
    events.push({ type: 'score', points: linePoints, total: state.score, multiplier })
  }

  const explodes = detonate(state, queue, queued, multiplier, events)
  const gain =
    (multiplier >= 2 ? CHARGE_CASCADE : 0) + bombs.length * CHARGE_BOMB + explodes * CHARGE_EXPLODE
  if (gain > 0 && state.charge < CHARGE_MAX) {
    state.charge = Math.min(CHARGE_MAX, state.charge + gain)
    events.push({ type: 'charge', value: state.charge, max: CHARGE_MAX })
  }

  settle(state, random, nextId, events)
}

function strikeRows(
  state: GameState,
  runs: Run[],
  colors: (GemColor | null)[],
  ids: (string | null)[][],
  greased: ReadonlySet<string>,
  breachActive: boolean,
  events: GameEvent[],
): void {
  if (state.enemy.hp <= 0) return
  const golem = bossAt(state.level).trick === 'breach'
  const pig = bossAt(state.level).trick === 'scrape'
  const fed = new Set<string>()
  for (let index = 0; index < runs.length; index += 1) {
    if (state.enemy.hp <= 0) break
    const run = runs[index]
    if (!run) continue
    const color = colors[index] ?? null
    if (color !== null && color === state.frozen) continue
    if (golem && run.cells.length < BOMB_RUN_LENGTH && !breachActive) continue
    if (pig && feedSlop(state, ids[index] ?? [], greased, fed, events)) continue
    const amount = Math.min(run.cells.length * DAMAGE_PER_GEM, state.enemy.hp)
    state.enemy.hp -= amount
    events.push({
      type: 'damage',
      amount,
      hp: state.enemy.hp,
      maxHp: state.enemy.maxHp,
      cells: run.cells.map((cell) => copyPosition(cell)),
    })
    if (state.enemy.hp === 0) {
      events.push({ type: 'defeat' })
      break
    }
  }
}

function feedSlop(
  state: GameState,
  ids: readonly (string | null)[],
  greased: ReadonlySet<string>,
  fed: Set<string>,
  events: GameEvent[],
): boolean {
  const fresh: string[] = []
  let any = false
  for (const id of ids) {
    if (id === null || !greased.has(id)) continue
    any = true
    if (fed.has(id)) continue
    fed.add(id)
    fresh.push(id)
  }
  if (!any) return false
  const amount = Math.min(fresh.length * SLOP_HEAL, state.enemy.maxHp - state.enemy.hp)
  if (amount > 0) {
    state.enemy.hp += amount
    events.push({
      type: 'heal',
      amount,
      hp: state.enemy.hp,
      maxHp: state.enemy.maxHp,
    })
  }
  return true
}

function detonate(
  state: GameState,
  queue: Position[],
  queued: Set<string>,
  multiplier: number,
  events: GameEvent[],
): number {
  const board = state.board
  const golem = bossAt(state.level).trick === 'breach'
  const exploded = new Set<string>()
  let explodes = 0
  for (let index = 0; index < queue.length; index += 1) {
    const center = queue[index]
    if (!center) continue
    const centerKey = keyOf(center)
    if (exploded.has(centerKey)) continue
    exploded.add(centerKey)

    const cells: Position[] = []
    const triggered: Position[] = []
    for (let row = center.row - 1; row <= center.row + 1; row += 1) {
      for (let col = center.col - 1; col <= center.col + 1; col += 1) {
        if (!inBounds({ row, col })) continue
        const occupant = cellAt(board, row, col)
        if (!occupant) continue
        cells.push({ row, col })
        if (!isBomb(occupant)) continue
        const bombKey = `${row},${col}`
        if (exploded.has(bombKey) || queued.has(bombKey)) continue
        triggered.push({ row, col })
      }
    }

    cells.sort(byRowCol)
    const gone = new Set<string>()
    for (const cell of cells) {
      const occupant = cellAt(board, cell.row, cell.col)
      if (occupant) gone.add(occupant.id)
      board[cell.row][cell.col] = null
    }
    forgetIds(state, gone)

    triggered.sort(byRowCol)
    for (const bomb of triggered) {
      queued.add(keyOf(bomb))
      queue.push(bomb)
    }

    events.push({
      type: 'explode',
      center: copyPosition(center),
      cells,
    })
    explodes += 1
    const points = cells.length * POINTS_EXPLODED_CELL * multiplier
    if (points > 0) {
      state.score += points
      events.push({ type: 'score', points, total: state.score, multiplier })
    }
    if (golem && state.enemy.hp > 0) {
      const amount = Math.min(EXPLOSION_DAMAGE, state.enemy.hp)
      state.enemy.hp -= amount
      events.push({
        type: 'damage',
        amount,
        hp: state.enemy.hp,
        maxHp: state.enemy.maxHp,
        cells: cells.map((cell) => copyPosition(cell)),
      })
      if (state.enemy.hp === 0) events.push({ type: 'defeat' })
    }
  }
  return explodes
}

function settle(
  state: GameState,
  random: RandomSource,
  nextId: () => string,
  events: GameEvent[],
): void {
  const moves = drop(state.board, state.frozen)
  if (moves.length > 0) events.push({ type: 'fall', moves })
  const spawned = fillHoles(state.board, random, nextId, state.frozen)
  if (spawned.length > 0) events.push({ type: 'spawn', cells: spawned })
}

function drop(board: Board, frozen: GemColor | null): FallMove[] {
  if (frozen !== null) return dropFrozen(board, frozen)
  const moves: FallMove[] = []
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    const stacked: { cell: Cell; row: number }[] = []
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      const cell = cellAt(board, row, col)
      if (cell) stacked.push({ cell, row })
    }
    const holes = BOARD_SIZE - stacked.length
    for (let row = 0; row < BOARD_SIZE; row += 1) board[row][col] = null
    for (let index = 0; index < stacked.length; index += 1) {
      const item = stacked[index]
      if (!item) continue
      const toRow = holes + index
      board[toRow][col] = item.cell
      if (item.row !== toRow) {
        moves.push({
          id: item.cell.id,
          from: { row: item.row, col },
          to: { row: toRow, col },
        })
      }
    }
  }
  moves.sort((left, right) => byRowCol(left.from, right.from))
  return moves
}

function dropFrozen(board: Board, frozen: GemColor): FallMove[] {
  const moves: FallMove[] = []
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    let row = 0
    while (row < BOARD_SIZE) {
      if (isAnchor(cellAt(board, row, col), frozen)) {
        row += 1
        continue
      }
      const start = row
      const stacked: { cell: Cell; row: number }[] = []
      while (row < BOARD_SIZE && !isAnchor(cellAt(board, row, col), frozen)) {
        const cell = cellAt(board, row, col)
        if (cell) stacked.push({ cell, row })
        row += 1
      }
      const end = row
      for (let cursor = start; cursor < end; cursor += 1) board[cursor][col] = null
      const holes = end - start - stacked.length
      for (let index = 0; index < stacked.length; index += 1) {
        const item = stacked[index]
        if (!item) continue
        const toRow = start + holes + index
        board[toRow][col] = item.cell
        if (item.row !== toRow) {
          moves.push({
            id: item.cell.id,
            from: { row: item.row, col },
            to: { row: toRow, col },
          })
        }
      }
    }
  }
  moves.sort((left, right) => byRowCol(left.from, right.from))
  return moves
}

function fillHoles(
  board: Board,
  random: RandomSource,
  nextId: () => string,
  frozen: GemColor | null,
): SpawnedGem[] {
  if (frozen !== null) return fillFrozen(board, random, nextId, frozen)
  const holesByCol: number[] = []
  for (let col = 0; col < BOARD_SIZE; col += 1) holesByCol.push(leadingHoles(board, col))

  const spawned: SpawnedGem[] = []
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (cellAt(board, row, col) !== null) continue
      const cell: GemCell = { id: nextId(), kind: 'gem', color: randomGemColor(random) }
      board[row][col] = cell
      const holes = holesByCol[col] ?? 0
      spawned.push({
        at: { row, col },
        cell,
        fromRow: row - holes,
      })
    }
  }
  return spawned
}

function fillFrozen(
  board: Board,
  random: RandomSource,
  nextId: () => string,
  frozen: GemColor,
): SpawnedGem[] {
  const holesAt = Array.from({ length: BOARD_SIZE }, () => Array.from({ length: BOARD_SIZE }, () => 0))
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    let row = 0
    while (row < BOARD_SIZE) {
      if (isAnchor(cellAt(board, row, col), frozen)) {
        row += 1
        continue
      }
      const start = row
      while (row < BOARD_SIZE && !isAnchor(cellAt(board, row, col), frozen)) row += 1
      const end = row
      let holes = 0
      for (let cursor = start; cursor < end; cursor += 1) {
        if (cellAt(board, cursor, col) === null) holes += 1
        else break
      }
      for (let cursor = start; cursor < end; cursor += 1) {
        const column = holesAt[cursor]
        if (column) column[col] = holes
      }
    }
  }

  const spawned: SpawnedGem[] = []
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (cellAt(board, row, col) !== null) continue
      const cell: GemCell = { id: nextId(), kind: 'gem', color: randomGemColor(random) }
      board[row][col] = cell
      const holes = holesAt[row]?.[col] ?? 0
      spawned.push({
        at: { row, col },
        cell,
        fromRow: row - holes,
      })
    }
  }
  return spawned
}

function fillBoard(random: RandomSource): Board {
  const board: Board = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null),
  )
  let serial = 1
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      board[row][col] = {
        id: `c${serial}`,
        kind: 'gem',
        color: pickColor(board, row, col, random),
      }
      serial += 1
    }
  }
  return board
}

function pickColor(board: Board, row: number, col: number, random: RandomSource): GemColor {
  const blocked = new Set<GemColor>()
  if (col >= 2) {
    const left = cellAt(board, row, col - 1)
    const farther = cellAt(board, row, col - 2)
    if (isGem(left) && isGem(farther) && left.color === farther.color) blocked.add(left.color)
  }
  if (row >= 2) {
    const above = cellAt(board, row - 1, col)
    const farther = cellAt(board, row - 2, col)
    if (isGem(above) && isGem(farther) && above.color === farther.color) blocked.add(above.color)
  }
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const color = randomGemColor(random)
    if (!blocked.has(color)) return color
  }
  for (const color of GEM_COLORS) {
    if (!blocked.has(color)) return color
  }
  return GEM_COLORS[0]
}

function hasMove(board: Board): boolean {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (col + 1 < BOARD_SIZE && swapCreatesRun(board, { row, col }, { row, col: col + 1 })) {
        return true
      }
      if (row + 1 < BOARD_SIZE && swapCreatesRun(board, { row, col }, { row: row + 1, col })) {
        return true
      }
    }
  }
  return false
}

function swapCreatesRun(board: Board, a: Position, b: Position): boolean {
  exchange(board, a, b)
  try {
    return findRuns(board).length > 0
  } finally {
    exchange(board, a, b)
  }
}

function findRuns(board: Board): Run[] {
  const runs: Run[] = []
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    let col = 0
    while (col < BOARD_SIZE) {
      const start = col
      const cell = cellAt(board, row, col)
      if (!isGem(cell)) {
        col += 1
        continue
      }
      const color = cell.color
      col += 1
      while (col < BOARD_SIZE) {
        const next = cellAt(board, row, col)
        if (!isGem(next) || next.color !== color) break
        col += 1
      }
      if (col - start >= MATCH_MIN) runs.push({ cells: line(row, start, col, true) })
    }
  }
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    let row = 0
    while (row < BOARD_SIZE) {
      const start = row
      const cell = cellAt(board, row, col)
      if (!isGem(cell)) {
        row += 1
        continue
      }
      const color = cell.color
      row += 1
      while (row < BOARD_SIZE) {
        const next = cellAt(board, row, col)
        if (!isGem(next) || next.color !== color) break
        row += 1
      }
      if (row - start >= MATCH_MIN) runs.push({ cells: line(col, start, row, false) })
    }
  }
  return runs
}

function line(fixed: number, from: number, to: number, horizontal: boolean): Position[] {
  const cells: Position[] = []
  for (let cursor = from; cursor < to; cursor += 1) {
    cells.push(horizontal ? { row: fixed, col: cursor } : { row: cursor, col: fixed })
  }
  return cells
}

function bombAnchor(cells: Position[], bias: SwapBias | null): Position {
  if (bias) {
    const preferredB = cells.find((cell) => samePosition(cell, bias.b))
    if (preferredB) return preferredB
    const preferredA = cells.find((cell) => samePosition(cell, bias.a))
    if (preferredA) return preferredA
  }
  let best = cells[0]
  for (const cell of cells) {
    if (!best || cell.row > best.row || (cell.row === best.row && cell.col > best.col)) best = cell
  }
  if (!best) return { row: 0, col: 0 }
  return best
}

function orthogonalToLine(row: number, col: number, lineKeys: Set<string>): boolean {
  return (
    lineKeys.has(`${row - 1},${col}`) ||
    lineKeys.has(`${row + 1},${col}`) ||
    lineKeys.has(`${row},${col - 1}`) ||
    lineKeys.has(`${row},${col + 1}`)
  )
}

function leadingHoles(board: Board, col: number): number {
  let holes = 0
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    if (cellAt(board, row, col) !== null) break
    holes += 1
  }
  return holes
}

function randomGemColor(random: RandomSource): GemColor {
  const index = Math.min(GEM_COLORS.length - 1, Math.floor(random() * GEM_COLORS.length))
  return GEM_COLORS[index] ?? GEM_COLORS[0]
}

function idFactory(board: Board): () => string {
  let serial = highestIdNumber(board) + 1
  return () => {
    const id = `c${serial}`
    serial += 1
    return id
  }
}

function highestIdNumber(board: Board): number {
  let highest = 0
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue
      const numbers = cell.id.match(/\d+/g)
      if (!numbers) continue
      for (const number of numbers) {
        const value = Number(number)
        if (value > highest) highest = value
      }
    }
  }
  return highest
}

function burnArea(board: Board, origin: Position): Position[] {
  const candidates = [
    origin,
    { row: origin.row - 1, col: origin.col },
    { row: origin.row + 1, col: origin.col },
    { row: origin.row, col: origin.col - 1 },
    { row: origin.row, col: origin.col + 1 },
  ]
  const cells: Position[] = []
  for (const candidate of candidates) {
    if (!inBounds(candidate)) continue
    if (cellAt(board, candidate.row, candidate.col) === null) continue
    cells.push(candidate)
  }
  cells.sort(byRowCol)
  return cells
}

function gemPositions(board: Board, skip: ReadonlySet<string>): Position[] {
  const positions: Position[] = []
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = cellAt(board, row, col)
      if (!isGem(cell) || skip.has(cell.id)) continue
      positions.push({ row, col })
    }
  }
  return positions
}

function boardHasColor(board: Board, color: GemColor): boolean {
  for (const row of board) {
    for (const cell of row) {
      if (isGem(cell) && cell.color === color) return true
    }
  }
  return false
}

function countSkulls(board: Board): number {
  let count = 0
  for (const row of board) {
    for (const cell of row) {
      if (isSkull(cell)) count += 1
    }
  }
  return count
}

function findId(board: Board, id: string): Position | null {
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (board[row]?.[col]?.id === id) return { row, col }
    }
  }
  return null
}

function forgetIds(state: GameState, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return
  state.blazes = state.blazes.filter((blaze) => !ids.has(blaze.id))
  state.slops = state.slops.filter((id) => !ids.has(id))
}

function isAnchor(cell: Cell | null, frozen: GemColor): boolean {
  return isGem(cell) && cell.color === frozen
}

function cloneState(state: GameState): GameState {
  return {
    board: cloneBoard(state.board),
    score: state.score,
    level: state.level,
    enemy: { ...state.enemy },
    player: { ...state.player },
    charge: state.charge,
    moves: state.moves,
    frozen: state.frozen,
    frozenTurns: state.frozenTurns,
    breached: state.breached,
    blazes: state.blazes.map((blaze) => ({ id: blaze.id, turns: blaze.turns })),
    slops: [...state.slops],
  }
}

function cloneBoard(board: Board): Board {
  return board.map((row) => row.map((cell) => (cell ? { ...cell } : null)))
}

function exchange(board: Board, a: Position, b: Position): void {
  const rowA = board[a.row]
  const rowB = board[b.row]
  if (!rowA || !rowB) return
  const saved = rowA[a.col]
  rowA[a.col] = rowB[b.col] ?? null
  rowB[b.col] = saved ?? null
}

function cellAt(board: Board, row: number, col: number): Cell | null {
  return board[row]?.[col] ?? null
}

function copyPosition(position: Position): Position {
  return { row: position.row, col: position.col }
}

function keyOf(position: Position): string {
  return `${position.row},${position.col}`
}

function byRowCol(left: Position, right: Position): number {
  return left.row - right.row || left.col - right.col
}
