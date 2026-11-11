/**
 * Замороженный контракт. Этот файл меняет только начальник.
 * Логика, звук и интерфейс импортируют отсюда и не правят его.
 *
 * Поле 8×8. Строка 0 — верх, столбец 0 — левый край.
 * Гравитация сдвигает незакреплённые клетки к большим номерам строк.
 * Пустая клетка (null) бывает только внутри разрешения хода.
 * Устойчивое поле заполнено целиком.
 *
 * Шаг игрока, пока босс жив и игрок жив:
 * swap → match → damage×(ряды, которые бьют) → score → (explode → score)×N → charge?
 * → fall → spawn, затем каскад снова с match.
 * charge пишется один раз за шаг и только если заряд реально вырос: после всех score
 * этого шага и до fall. Рост: CHARGE_CASCADE, если multiplier ≥ 2; плюс CHARGE_BOMB
 * за каждую новую бомбу; плюс CHARGE_EXPLODE за каждый explode. Потолок CHARGE_MAX.
 * Множитель каскада по-прежнему не умножает урон.
 *
 * Если удар опускает здоровье босса до нуля, сразу после этого damage идёт defeat.
 * При нулевом здоровье следующие удары не наносят урона и defeat больше не приходит.
 * Недопустимый обмен соседних клеток: swap, затем reject. Иначе только reject.
 * Входное состояние не мутирует. Отказ возвращает тот же объект state.
 *
 * Очки шага умножаются на multiplier.
 * На ходу игрока multiplier равен 1, на каждом следующем каскаде он на 1 больше.
 * Взрывы той же волны используют multiplier этой волны.
 * 10 очков за каждое вхождение обычного гема в линию (пересечение считается дважды).
 * 50 очков за каждый появившийся взрывающийся гем.
 * 30 очков за каждую клетку, снятую взрывом.
 * Линия из 5 и длиннее взрывающийся гем не создаёт.
 *
 * Выбитый ряд — одна прямая из match.runs.
 * Обычный урон ряда равен его длине × DAMAGE_PER_GEM, не больше остатка.
 * Исключения боя описаны ниже. Взрыв снимает здоровье босса только у голема.
 *
 * После устойчивого поля, если босс ещё жив и игрок ещё жив:
 * 1. Орк: если на поле остались черепа, одно heal. Новые черепа этого хода не лечат.
 *    Сумма min(число черепов × SKULL_HEAL, до полного здоровья). При нуле события нет.
 * 2. moves += 1. Убийственный ход сюда не доходит: фаза босса пропускается целиком,
 *    moves не растёт, ответного удара нет.
 * 3. Тик. Если frozenTurns > 0, уменьшить на 1. На нуле очистить frozen и дать thaw.
 *    У каждого blaze уменьшить turns. Дошедшие до нуля сгорают.
 * 4. burn снимает сам гем и четырёх соседей по стороне, если клетка занята.
 *    Список cells отсортирован по строке и столбцу, без повторов.
 *    Чужой огонь на снятой клетке гаснет без отдельного burn и без BURN_HURT.
 *    Затем fall, spawn и каскады с multiplier снова с 1.
 *    Одно hurt на все сгоревшие в этот тик огни: число × BURN_HURT, не больше остатка.
 *    Ноль очков здоровья после hurt даёт один down, и фаза на этом кончается.
 * 5. Если moves кратно BOSS_EVERY, босс бьёт игрока на boss.hurt (hurt, при нуле down).
 *    Смерть игрока отменяет порчу. Иначе corrupt:
 *    - shatter (орк): один череп вместо гема. Индекс floor(random × число гемов)
 *      в обходе по строкам. Бомбы и черепа не выбираются. Огонь на заменённом id гаснет.
 *    - thaw (ведьма): frozen = цвет из GEM_COLORS, который ещё есть на поле,
 *      тот же индекс от random. frozenTurns = FREEZE_TURNS. Старый лёд сменяется.
 *    - breach (голем): corrupt с trick 'armor', клетки пустые, поле не меняется.
 *    - quench (дракон): один новый огонь на геме без blaze, turns = FIRE_TURNS,
 *      тот же способ выбора, что у черепа.
 *    - scrape (супер-свин): один жир на геме, которого ещё нет в slops.
 *      Тот же способ выбора. id гема дописывается в slops.
 *    Если выбрать некого, corrupt не пишется, удар игрока остаётся.
 * Отказ хода, смерть босса и applyCast эту фазу не запускают.
 * random фазы босса читается после заливок каскада игрока.
 *
 * Лёд: гем цвета frozen не падает и режет колонку на отрезки. Внутри отрезка
 * остальные клетки падают к его низу, дыры остаются у верха отрезка.
 * Линия цвета frozen даёт очки и бомбу как обычно и не даёт damage.
 * Совпадение снимает замёрзший гем. Бомбы и черепа льдом не закрепляются.
 *
 * Череп — клетка. В линию не входит, падает как бомба, взрыв 3×3 его снимает.
 * Линия его не снимает.
 *
 * Броня голема: ряд короче 4 не даёт damage, пока breached ложно.
 * Ряд из 4 и длиннее бьёт всегда. Каждый explode по голему бьёт на EXPLOSION_DAMAGE.
 * Остальные боссы от взрыва здоровье не теряют.
 *
 * Жир супер-свина действует, только пока его приём — scrape.
 * Линия, в которой до снятия был id из slops, не даёт damage.
 * Если среди этих id есть ещё не лечившие в этом шаге, сразу одно heal:
 * их число × SLOP_HEAL, не больше нехватки до полного здоровья.
 * Тот же id во второй линии шага не лечит повторно. При нулевой сумме события нет.
 * Множитель каскада это лечение не умножает.
 * Снятие клетки (линия, взрыв, замена) убирает её id из slops и само не лечит.
 *
 * applyCast при charge < CHARGE_MAX, player.hp === 0 или enemy.hp === 0:
 * один fizzle и тот же state.
 * Иначе charge = 0, события cast затем charge, приём босса:
 * - shatter: снять все черепа, затем fall, spawn и каскады с multiplier 1;
 * - thaw: очистить лёд и дать thaw;
 * - breach: breached = true до конца следующего успешного applySwap, потом снова false;
 *   отказ хода бросок не тратит;
 * - quench: снять все blaze без burn.
 * - scrape: очистить slops, поле не менять.
 * Неудачный приём (нечего снимать) всё равно тратит заряд.
 * applyCast не увеличивает moves и не запускает фазу босса.
 *
 * createState: первый босс, счёт 0, уровень 0, игрок на PLAYER_MAX_HP,
 * заряд 0, moves 0, лёд пуст, breached false, blazes пуст, slops пуст.
 * nextLevel сохраняет счёт, поднимает уровень, лечит босса и игрока,
 * обнуляет заряд, moves, лёд, breached, blazes и slops, собирает новое поле.
 * После последнего босса возвращает null.
 * applySwap при player.hp === 0 — только reject, без swap.
 */

export const BOARD_SIZE = 8

export const GEM_COLORS = ['red', 'blue', 'green', 'yellow', 'purple'] as const
export type GemColor = (typeof GEM_COLORS)[number]

export const GEM_FILES = {
  red: 'red.svg',
  blue: 'blue.svg',
  green: 'green.svg',
  yellow: 'yellow.svg',
  purple: 'purple.svg',
  bomb: 'bomb.svg',
} as const

export const MATCH_MIN = 3
export const BOMB_RUN_LENGTH = 4
export const POINTS_PER_GEM = 10
export const POINTS_BOMB = 50
export const POINTS_EXPLODED_CELL = 30

export const PLAYER_MAX_HP = 100
export const BOSS_EVERY = 3
export const CHARGE_MAX = 100
export const CHARGE_CASCADE = 25
export const CHARGE_BOMB = 20
export const CHARGE_EXPLODE = 15
export const SKULL_HEAL = 20
export const EXPLOSION_DAMAGE = 40
export const FIRE_TURNS = 2
export const FREEZE_TURNS = 3
export const BURN_HURT = 14
export const SLOP_HEAL = 16

export const CAST_TRICKS = ['shatter', 'thaw', 'breach', 'quench', 'scrape'] as const
export type CastTrick = (typeof CAST_TRICKS)[number]

export const CORRUPT_TRICKS = ['skull', 'freeze', 'ignite', 'armor', 'slop'] as const
export type CorruptTrick = (typeof CORRUPT_TRICKS)[number]

export const BOSSES = [
  { name: 'Орк-шаман', maxHp: 200, portrait: 'orc.svg', fallen: 'повержен', trick: 'shatter', hurt: 18 },
  { name: 'Ледяная ведьма', maxHp: 280, portrait: 'witch.svg', fallen: 'повержена', trick: 'thaw', hurt: 16 },
  { name: 'Каменный голем', maxHp: 250, portrait: 'golem.svg', fallen: 'повержен', trick: 'breach', hurt: 22 },
  { name: 'Дракон', maxHp: 360, portrait: 'dragon.svg', fallen: 'повержен', trick: 'quench', hurt: 12 },
  { name: 'Дамир Супер-свин', maxHp: 400, portrait: 'pig.svg', fallen: 'повержен', trick: 'scrape', hurt: 20 },
] as const

export type BossSpec = (typeof BOSSES)[number]

export const ENEMY_NAME = BOSSES[0].name
export const ENEMY_MAX_HP = BOSSES[0].maxHp
export const DAMAGE_PER_GEM = 10

export const HAZARD_FILES = {
  skull: 'skull.svg',
  ice: 'ice.svg',
  fire: 'fire.svg',
  slop: 'slop.svg',
} as const

export const GAME_EVENTS = [
  'swap',
  'reject',
  'match',
  'damage',
  'defeat',
  'explode',
  'fall',
  'spawn',
  'score',
  'heal',
  'hurt',
  'down',
  'charge',
  'cast',
  'fizzle',
  'thaw',
  'corrupt',
  'burn',
] as const
export type GameEventName = (typeof GAME_EVENTS)[number]

export interface Position {
  row: number
  col: number
}

export type CellId = string

export interface GemCell {
  id: CellId
  kind: 'gem'
  color: GemColor
}

export interface BombCell {
  id: CellId
  kind: 'bomb'
}

export interface SkullCell {
  id: CellId
  kind: 'skull'
}

export type Cell = GemCell | BombCell | SkullCell

/** row-major: board[row][col]. null — пустая клетка. */
export type Board = (Cell | null)[][]

export interface SwapEvent {
  type: 'swap'
  a: Position
  b: Position
}

export interface RejectEvent {
  type: 'reject'
  a: Position
  b: Position
}

export interface MatchRun {
  /** Клетки одной прямой, слева направо или сверху вниз. */
  cells: Position[]
}

export interface MatchEvent {
  type: 'match'
  /** Все прямые линии этого шага, каждая не короче MATCH_MIN. */
  runs: MatchRun[]
  /** Снятые гемы. Клетки, где появился взрывающийся гем, сюда не входят. */
  removed: Position[]
  /**
   * По одному гему на линию длины ровно BOMB_RUN_LENGTH.
   * Если две такие линии претендуют на одну клетку, гем один.
   * Линия длиннее BOMB_RUN_LENGTH бомбу не даёт.
   */
  bombs: { at: Position; cell: BombCell }[]
}

export interface ExplodeEvent {
  type: 'explode'
  center: Position
  /**
   * Занятые клетки области 3×3, которые эта вспышка снимает.
   * Центр входит в список. Клетка, уже снятая в этой волне, повторно не входит.
   */
  cells: Position[]
}

export interface FallMove {
  id: CellId
  from: Position
  to: Position
}

export interface FallEvent {
  type: 'fall'
  moves: FallMove[]
}

export interface SpawnedGem {
  at: Position
  cell: GemCell
  /**
   * Визуальная стартовая строка над полем.
   * Для столбца, где пусты `holes` верхних клеток, гем в строке `r` стартует с `r - holes`.
   */
  fromRow: number
}

export interface SpawnEvent {
  type: 'spawn'
  cells: SpawnedGem[]
}

export interface ScoreEvent {
  type: 'score'
  /** Уже умноженные очки этого начисления. Больше нуля. */
  points: number
  /** Счёт после этого начисления. */
  total: number
  multiplier: number
}

export interface EnemyState {
  name: string
  hp: number
  maxHp: number
}

export interface PlayerState {
  hp: number
  maxHp: number
}

export interface Blaze {
  id: CellId
  /** Сколько успешных ходов огонь ещё переживёт, пока не дойдёт до нуля. */
  turns: number
}

export interface DamageEvent {
  type: 'damage'
  /** Снятое здоровье этого ряда. Больше нуля и не больше остатка до удара. */
  amount: number
  /** Здоровье после удара, не ниже нуля. */
  hp: number
  maxHp: number
  /** Клетки выбитого ряда, слева направо или сверху вниз. */
  cells: Position[]
}

export interface DefeatEvent {
  type: 'defeat'
}

export interface HealEvent {
  type: 'heal'
  /** Сколько здоровья вернулось. Больше нуля и не больше нехватки до удара. */
  amount: number
  hp: number
  maxHp: number
}

export interface HurtEvent {
  type: 'hurt'
  /** Снятое здоровье игрока. Больше нуля и не больше остатка. */
  amount: number
  hp: number
  maxHp: number
}

export interface DownEvent {
  type: 'down'
}

export interface ChargeEvent {
  type: 'charge'
  /** Заряд после изменения, от нуля до CHARGE_MAX включительно. */
  value: number
  max: number
}

export interface CastEvent {
  type: 'cast'
  trick: CastTrick
}

export interface FizzleEvent {
  type: 'fizzle'
}

export interface ThawEvent {
  type: 'thaw'
}

export interface CorruptEvent {
  type: 'corrupt'
  trick: CorruptTrick
  /** Клетки порчи. У брони пустой список. У льда тоже пустой: цвет лежит в color. */
  cells: Position[]
  color: GemColor | null
}

export interface BurnEvent {
  type: 'burn'
  cells: Position[]
}

export type GameEvent =
  | SwapEvent
  | RejectEvent
  | MatchEvent
  | DamageEvent
  | DefeatEvent
  | ExplodeEvent
  | FallEvent
  | SpawnEvent
  | ScoreEvent
  | HealEvent
  | HurtEvent
  | DownEvent
  | ChargeEvent
  | CastEvent
  | FizzleEvent
  | ThawEvent
  | CorruptEvent
  | BurnEvent

export interface GameState {
  board: Board
  score: number
  /** Индекс в BOSSES, с нуля. */
  level: number
  enemy: EnemyState
  player: PlayerState
  /** От нуля до CHARGE_MAX. */
  charge: number
  /** Число успешных applySwap, которые дошли до фазы босса. */
  moves: number
  frozen: GemColor | null
  frozenTurns: number
  /** Следующий успешный ход голема бьёт и тройками. После него снова false. */
  breached: boolean
  blazes: Blaze[]
  /** id гемов под жиром супер-свина. */
  slops: CellId[]
}

export interface ResolvedMove {
  state: GameState
  events: GameEvent[]
}

/** Возвращает число из полуинтервала [0, 1). */
export type RandomSource = () => number

export type CreateState = (random?: RandomSource) => GameState

export type ApplySwap = (
  state: GameState,
  a: Position,
  b: Position,
  random?: RandomSource,
) => ResolvedMove

export type ApplyCast = (state: GameState, random?: RandomSource) => ResolvedMove

export function isGem(cell: Cell | null): cell is GemCell {
  return cell !== null && cell.kind === 'gem'
}

export function isBomb(cell: Cell | null): cell is BombCell {
  return cell !== null && cell.kind === 'bomb'
}

export function isSkull(cell: Cell | null): cell is SkullCell {
  return cell !== null && cell.kind === 'skull'
}

export function samePosition(a: Position, b: Position): boolean {
  return a.row === b.row && a.col === b.col
}

export function inBounds(position: Position): boolean {
  return (
    position.row >= 0 &&
    position.col >= 0 &&
    position.row < BOARD_SIZE &&
    position.col < BOARD_SIZE
  )
}

export function isOrthogonal(a: Position, b: Position): boolean {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1
}
