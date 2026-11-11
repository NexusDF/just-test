<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import {
  BOARD_SIZE,
  BOSSES,
  CHARGE_MAX,
  applyCast,
  applySwap,
  createState,
  isOrthogonal,
  nextLevel,
  samePosition,
} from '../game'
import type {
  CastTrick,
  DamageEvent,
  EnemyState,
  GameState,
  GemColor,
  PlayerState,
  Position,
  ResolvedMove,
} from '../game'
import { unlock } from '../audio/play'
import orcUrl from '../assets/enemy/orc.svg'
import witchUrl from '../assets/enemy/witch.svg'
import golemUrl from '../assets/enemy/golem.svg'
import dragonUrl from '../assets/enemy/dragon.svg'
import pigUrl from '../assets/enemy/pig.svg'
import { COIN_MARKUP } from './coin'
import { createPieceLayer, type PieceLayer } from './pieces'
import { playEvents, type BattleHooks } from './playback'

const PORTRAITS: Record<string, string> = {
  'orc.svg': orcUrl,
  'witch.svg': witchUrl,
  'golem.svg': golemUrl,
  'dragon.svg': dragonUrl,
  'pig.svg': pigUrl,
}

interface GridCell {
  key: string
  row: number
  col: number
  alt: boolean
}

interface Gesture {
  pointerId: number
  origin: Position
  moved: boolean
}

const cells: GridCell[] = []
for (let row = 0; row < BOARD_SIZE; row += 1) {
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    cells.push({
      key: `${row}-${col}`,
      row,
      col,
      alt: (row + col) % 2 === 0,
    })
  }
}

const COLOR_NAME: Record<GemColor, string> = {
  red: 'красных',
  blue: 'синих',
  green: 'зелёных',
  yellow: 'жёлтых',
  purple: 'фиолетовых',
}

const TRICK_LABEL: Record<CastTrick, string> = {
  shatter: 'Разбить',
  thaw: 'Растопить',
  breach: 'Проломить',
  quench: 'Сбить',
  scrape: 'Соскрести',
}

const HINT: Record<CastTrick, string> = {
  shatter: 'Черепа лечат шамана. Их берёт бомба или приём.',
  thaw: 'Замёрзший цвет не бьёт и не падает.',
  breach: 'Тройка не берёт броню. Бьют четвёрка, взрыв и приём.',
  quench: 'Огонь сжигает клетку и бьёт вас. Снимите его линией.',
  scrape: 'Жирный гем в линии не бьёт и лечит свина. Снимите жир приёмом или бомбой.',
}

const opening = BOSSES[0]
const score = ref(0)
const level = ref(0)
const enemyName = ref<string>(opening.name)
const enemyHp = ref<number>(opening.maxHp)
const enemyMax = ref<number>(opening.maxHp)
const playerHp = ref(100)
const playerMax = ref(100)
const charge = ref(0)
const frozen = ref<GemColor | null>(null)
const breached = ref(false)
const defeated = ref(false)
const victory = ref(false)
const down = ref(false)
const hitting = ref(false)
const playerHitting = ref(false)
const hit = ref<{ id: number; amount: number } | null>(null)
const heal = ref<{ id: number; amount: number } | null>(null)
const wound = ref<{ id: number; amount: number } | null>(null)
const selected = ref<Position | null>(null)
const busy = ref(false)
const boardEl = ref<HTMLElement | null>(null)
const piecesEl = ref<HTMLElement | null>(null)
const fxEl = ref<HTMLElement | null>(null)
const scoreEl = ref<HTMLElement | null>(null)
const enemyEl = ref<HTMLElement | null>(null)
const nextButton = ref<HTMLButtonElement | null>(null)
const restartButton = ref<HTMLButtonElement | null>(null)

watch(victory, (open) => {
  if (!open) return
  void nextTick(() => nextButton.value?.focus())
})

watch(down, (open) => {
  if (!open) return
  void nextTick(() => restartButton.value?.focus())
})

const boss = computed(() => BOSSES[level.value] ?? BOSSES[0])
const portrait = computed(() => PORTRAITS[boss.value.portrait] ?? orcUrl)
const tone = computed(() => boss.value.portrait.replace(/\.svg$/, ''))
const nextBoss = computed(() => BOSSES[level.value + 1] ?? null)

const hpWidth = computed(() => {
  if (enemyMax.value <= 0) return '0%'
  const ratio = Math.max(0, Math.min(1, enemyHp.value / enemyMax.value))
  return `${ratio * 100}%`
})

const playerWidth = computed(() => {
  if (playerMax.value <= 0) return '0%'
  const ratio = Math.max(0, Math.min(1, playerHp.value / playerMax.value))
  return `${ratio * 100}%`
})

const chargeWidth = computed(() => {
  const ratio = Math.max(0, Math.min(1, charge.value / CHARGE_MAX))
  return `${ratio * 100}%`
})

const trickLabel = computed(() => TRICK_LABEL[boss.value.trick])

const statusLine = computed(() => {
  if (frozen.value) return `Лёд на ${COLOR_NAME[frozen.value]} — они не бьют и не падают.`
  if (breached.value) return 'Броня сбита — следующая тройка бьёт.'
  return HINT[boss.value.trick]
})

const castReady = computed(
  () => charge.value >= CHARGE_MAX && !busy.value && !down.value && !defeated.value,
)

let hitSerial = 0
let hitTimer = 0
let playerTimer = 0

function syncEnemy(enemy: EnemyState): void {
  enemyName.value = enemy.name
  enemyHp.value = enemy.hp
  enemyMax.value = enemy.maxHp
  defeated.value = enemy.hp <= 0
}

function syncPlayer(player: PlayerState): void {
  playerHp.value = player.hp
  playerMax.value = player.maxHp
}

const hooks: BattleHooks = {
  onHeal: (event) => {
    enemyHp.value = event.hp
    enemyMax.value = event.maxHp
    hitSerial += 1
    heal.value = { id: hitSerial, amount: event.amount }
  },
  onHurt: (event) => {
    playerHp.value = event.hp
    playerMax.value = event.maxHp
    hitSerial += 1
    wound.value = { id: hitSerial, amount: event.amount }
    playerHitting.value = true
    window.clearTimeout(playerTimer)
    playerTimer = window.setTimeout(() => {
      playerHitting.value = false
    }, 180)
  },
  onDown: () => {
    playerHp.value = 0
  },
  onCharge: (value) => {
    charge.value = value
  },
  onBreach: () => {
    breached.value = true
  },
  onFreeze: (color) => {
    frozen.value = color
  },
}

function showDamage(event: DamageEvent): void {
  enemyHp.value = event.hp
  enemyMax.value = event.maxHp
  hitSerial += 1
  hit.value = { id: hitSerial, amount: event.amount }
  hitting.value = true
  window.clearTimeout(hitTimer)
  hitTimer = window.setTimeout(() => {
    hitting.value = false
  }, 180)
}

const selectionStyle = computed(() => {
  if (!selected.value) return undefined
  return {
    transform: `translate(${selected.value.col * 100}%, ${selected.value.row * 100}%)`,
  }
})

let model: GameState | null = null
let layer: PieceLayer | null = null
let active: ReturnType<typeof playEvents> | null = null
let gesture: Gesture | null = null
let observer: ResizeObserver | null = null

function cellFromPointer(event: PointerEvent): Position | null {
  const board = boardEl.value
  if (!board) return null
  const rect = board.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null
  const col = Math.min(BOARD_SIZE - 1, Math.floor((x / rect.width) * BOARD_SIZE))
  const row = Math.min(BOARD_SIZE - 1, Math.floor((y / rect.height) * BOARD_SIZE))
  return { row, col }
}

function finish(state: GameState): void {
  layer?.sync(state.board)
  layer?.applyHazards(
    state.frozen,
    state.blazes.map((blaze) => blaze.id),
    state.slops,
  )
  score.value = state.score
  level.value = state.level
  charge.value = state.charge
  frozen.value = state.frozen
  breached.value = state.breached
  syncEnemy(state.enemy)
  syncPlayer(state.player)
  if (state.player.hp <= 0) {
    selected.value = null
    victory.value = false
    down.value = true
  } else if (state.enemy.hp <= 0) {
    selected.value = null
    down.value = false
    victory.value = true
  }
  active = null
  busy.value = false
}

function playResult(result: ResolvedMove): void {
  const scoreNode = scoreEl.value
  const foe = enemyEl.value
  if (!layer || !scoreNode || !foe) {
    busy.value = false
    return
  }
  model = result.state
  const timeline = playEvents(
    layer,
    result.events,
    scoreNode,
    (total) => {
      score.value = total
    },
    {
      el: foe,
      onDamage: showDamage,
      onDefeat: () => {
        defeated.value = true
      },
    },
    hooks,
  )
  active = timeline
  timeline.eventCallback('onComplete', () => finish(result.state))
  timeline.play()
}

function beginMove(a: Position, b: Position): void {
  if (busy.value || victory.value || down.value || !layer || !model) return
  if (!isOrthogonal(a, b)) return
  if (!scoreEl.value || !enemyEl.value) return
  busy.value = true
  selected.value = null
  playResult(applySwap(model, a, b))
}

function beginCast(): void {
  if (!castReady.value || !model) return
  unlock()
  busy.value = true
  selected.value = null
  playResult(applyCast(model))
}

function choose(cell: Position): void {
  if (busy.value) return
  const current = selected.value
  if (!current) {
    selected.value = cell
    return
  }
  if (samePosition(current, cell)) {
    selected.value = null
    return
  }
  if (isOrthogonal(current, cell)) {
    beginMove(current, cell)
    return
  }
  selected.value = cell
}

function showModel(state: GameState): void {
  model = state
  score.value = state.score
  level.value = state.level
  charge.value = state.charge
  frozen.value = state.frozen
  breached.value = state.breached
  syncEnemy(state.enemy)
  syncPlayer(state.player)
  defeated.value = state.enemy.hp <= 0
  victory.value = false
  down.value = state.player.hp <= 0
  selected.value = null
  hit.value = null
  heal.value = null
  wound.value = null
  hitting.value = false
  playerHitting.value = false
  layer?.sync(state.board)
  layer?.applyHazards(
    state.frozen,
    state.blazes.map((blaze) => blaze.id),
    state.slops,
  )
}

function goNext(): void {
  if (!model || !layer || busy.value) return
  showModel(nextLevel(model) ?? createState())
}

function goRestart(): void {
  if (busy.value) return
  showModel(createState())
}

function onPointerDown(event: PointerEvent): void {
  unlock()
  if (event.button !== 0 || busy.value || victory.value || down.value || gesture) return
  const cell = cellFromPointer(event)
  if (!cell) return
  const host = event.currentTarget
  if (!(host instanceof HTMLElement)) return
  gesture = { pointerId: event.pointerId, origin: cell, moved: false }
  host.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (busy.value || !gesture || gesture.pointerId !== event.pointerId || gesture.moved) return
  const cell = cellFromPointer(event)
  if (!cell || samePosition(cell, gesture.origin) || !isOrthogonal(gesture.origin, cell)) return
  gesture.moved = true
  beginMove(gesture.origin, cell)
}

function onPointerUp(event: PointerEvent): void {
  if (!gesture || gesture.pointerId !== event.pointerId) return
  const current = gesture
  gesture = null
  if (current.moved || busy.value) return
  const released = cellFromPointer(event)
  if (released && isOrthogonal(current.origin, released)) {
    beginMove(current.origin, released)
    return
  }
  choose(released ?? current.origin)
}

onMounted(() => {
  const board = boardEl.value
  const pieces = piecesEl.value
  const fx = fxEl.value
  if (!board || !pieces || !fx) return
  layer = createPieceLayer(pieces, fx, () => board.clientWidth / BOARD_SIZE)
  showModel(createState())
  observer = new ResizeObserver(() => {
    if (!busy.value) layer?.layout()
  })
  observer.observe(board)
})

onUpdated(() => {
  layer?.ensureAttached()
})

onBeforeUnmount(() => {
  window.clearTimeout(hitTimer)
  window.clearTimeout(playerTimer)
  observer?.disconnect()
  observer = null
  active?.kill()
  active = null
  layer?.destroy()
  layer = null
})
</script>

<template>
  <main
    class="screen"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <header class="score" aria-label="Очки">
      <span class="score-coin" aria-hidden="true" v-html="COIN_MARKUP"></span>
      <span ref="scoreEl" class="score-value" aria-live="polite">{{ score }}</span>
    </header>
    <section
      ref="enemyEl"
      class="enemy"
      :class="[tone, { defeated }]"
      :aria-label="defeated ? `${enemyName} ${boss.fallen}` : enemyName"
    >
      <div class="enemy-portrait">
        <img class="enemy-face" :src="portrait" alt="" draggable="false" />
      </div>
      <div class="enemy-body">
        <div class="enemy-name">
          <span class="enemy-title">{{ enemyName }}</span>
          <span class="enemy-level">{{ level + 1 }}/{{ BOSSES.length }}</span>
        </div>
        <p v-if="defeated" class="enemy-status">{{ boss.fallen }}</p>
        <div class="enemy-bar-row">
          <div
            class="enemy-track"
            role="meter"
            :aria-valuenow="enemyHp"
            aria-valuemin="0"
            :aria-valuemax="enemyMax"
            :aria-valuetext="`${enemyHp} из ${enemyMax}`"
          >
            <div class="enemy-fill" :class="{ 'is-hit': hitting }" :style="{ width: hpWidth }"></div>
          </div>
          <svg class="enemy-heart" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 4.6-7 9-7 9z"
              fill="#ff4d6a"
              stroke="#fff4ea"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <div class="enemy-hp">{{ enemyHp }} / {{ enemyMax }}</div>
      </div>
      <span v-if="hit" :key="hit.id" class="enemy-hit">-{{ hit.amount }}</span>
      <span v-if="heal" :key="heal.id" class="enemy-hit is-heal">+{{ heal.amount }}</span>
    </section>
    <div class="fight">
      <div class="player" :class="{ 'is-hit': playerHitting }">
        <span class="player-name">Вы</span>
        <div
          class="player-track"
          role="meter"
          :aria-valuenow="playerHp"
          aria-valuemin="0"
          :aria-valuemax="playerMax"
          :aria-valuetext="`${playerHp} из ${playerMax}`"
        >
          <div class="player-fill" :style="{ width: playerWidth }"></div>
        </div>
        <span class="player-hp">{{ playerHp }}</span>
        <span v-if="wound" :key="wound.id" class="player-wound">-{{ wound.amount }}</span>
      </div>
      <button
        type="button"
        class="cast"
        :disabled="!castReady"
        :aria-label="`${trickLabel}, заряд ${charge} из ${CHARGE_MAX}`"
        @pointerdown.stop
        @click="beginCast"
      >
        <span class="cast-fill" :style="{ width: chargeWidth }"></span>
        <span class="cast-label">{{ charge >= CHARGE_MAX ? trickLabel : charge }}</span>
      </button>
    </div>
    <p class="hint">{{ statusLine }}</p>
    <div
      ref="boardEl"
      class="board"
      :class="{ 'is-busy': busy }"
      :aria-busy="busy"
      aria-label="Поле"
    >
      <div class="cells" aria-hidden="true">
        <div
          v-for="cell in cells"
          :key="cell.key"
          class="cell"
          :class="{ alt: cell.alt }"
        />
      </div>
      <div ref="piecesEl" class="layer pieces" aria-hidden="true"></div>
      <div ref="fxEl" class="layer fx" aria-hidden="true"></div>
      <div v-show="selected" class="selection" :style="selectionStyle"></div>
    </div>
    <div
      v-if="victory"
      class="victory"
      role="dialog"
      aria-modal="true"
      aria-labelledby="victory-title"
      @pointerdown.stop
    >
      <div class="victory-card">
        <img class="victory-face" :src="portrait" alt="" />
        <h2 id="victory-title" class="victory-title">{{ nextBoss ? 'Победа' : 'Поход завершён' }}</h2>
        <p class="victory-line">{{ enemyName }} {{ boss.fallen }}</p>
        <p v-if="nextBoss" class="victory-next-name">Дальше: {{ nextBoss.name }}</p>
        <p v-else class="victory-next-name">Все боссы повержены</p>
        <button ref="nextButton" type="button" class="victory-next" @click="goNext">
          {{ nextBoss ? 'Следующий уровень' : 'Сыграть снова' }}
        </button>
      </div>
    </div>
    <div
      v-if="down"
      class="victory"
      role="dialog"
      aria-modal="true"
      aria-labelledby="down-title"
      @pointerdown.stop
    >
      <div class="victory-card">
        <h2 id="down-title" class="victory-title">Вы пали</h2>
        <p class="victory-line">{{ enemyName }} устоял</p>
        <button ref="restartButton" type="button" class="victory-next" @click="goRestart">
          Сыграть снова
        </button>
      </div>
    </div>
  </main>
</template>

<style>
.screen {
  position: relative;
  container-type: inline-size;
  width: 100%;
  max-width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  --cell: min(64px, calc(100cqi / 8), calc((100svh - 312px) / 8));
  gap: 14px;
  padding: 12px 12px 20px;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.screen .score {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0;
  color: #ffe7a8;
}

.screen .score-coin {
  display: block;
  flex: none;
  width: 30px;
  height: 30px;
  filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.35));
}

.screen .score-coin svg,
.screen .coin svg {
  display: block;
  width: 100%;
  height: 100%;
}

.screen .score-value {
  display: inline-block;
  min-width: 1ch;
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #ffe7a8;
  text-shadow: 0 2px 0 rgba(70, 36, 6, 0.45);
  transform-origin: center;
}

.screen .coin {
  position: absolute;
  left: 0;
  top: 0;
  width: 22px;
  height: 22px;
  z-index: 7;
  pointer-events: none;
  filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.45));
}

.screen .enemy {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 12px;
  width: calc(var(--cell) * 8);
  min-height: 84px;
  margin: 0;
  padding: 8px 14px 8px 8px;
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(122, 28, 36, 0.96), rgba(48, 12, 18, 0.96));
  box-shadow:
    inset 0 0 0 2px rgba(255, 214, 150, 0.32),
    0 12px 28px rgba(0, 0, 0, 0.35);
}

.screen .enemy.defeated .enemy-portrait {
  filter: grayscale(1) brightness(0.72);
}

.screen .enemy-portrait {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  overflow: hidden;
  background: radial-gradient(circle at 50% 38%, #c45a4a, #3a1018 72%);
  box-shadow:
    inset 0 0 0 2px rgba(255, 224, 176, 0.85),
    0 4px 10px rgba(0, 0, 0, 0.35);
}

.screen .enemy-face {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}

.screen .enemy-body {
  min-width: 0;
}

.screen .enemy-name {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1.2rem;
  line-height: 1.1;
  letter-spacing: 0.02em;
  color: #ffe7b0;
}

.screen .enemy-title {
  min-width: 0;
}

.screen .enemy-level {
  flex: none;
  font-family: system-ui, sans-serif;
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: rgba(255, 244, 220, 0.78);
}

.screen .enemy.witch {
  background: linear-gradient(180deg, rgba(28, 72, 128, 0.96), rgba(10, 28, 52, 0.96));
}

.screen .enemy.witch .enemy-portrait {
  background: radial-gradient(circle at 50% 38%, #8ec4ef, #10283f 72%);
}

.screen .enemy.golem {
  background: linear-gradient(180deg, rgba(96, 82, 58, 0.96), rgba(36, 28, 18, 0.96));
}

.screen .enemy.golem .enemy-portrait {
  background: radial-gradient(circle at 50% 38%, #b2a78f, #2c261c 72%);
}

.screen .enemy.dragon {
  background: linear-gradient(180deg, rgba(148, 48, 22, 0.96), rgba(52, 14, 8, 0.96));
}

.screen .enemy.dragon .enemy-portrait {
  background: radial-gradient(circle at 50% 38%, #e07048, #3a140e 72%);
}

.screen .enemy.pig {
  background: linear-gradient(180deg, rgba(176, 48, 88, 0.96), rgba(58, 16, 36, 0.96));
}

.screen .enemy.pig .enemy-portrait {
  background: radial-gradient(circle at 50% 38%, #f0a0c0, #3a1024 72%);
}

.screen .enemy-status {
  margin: 2px 0 0;
  font-size: 0.78rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #ffb4b8;
}

.screen .enemy-bar-row {
  position: relative;
  margin-top: 8px;
  padding-right: 14px;
}

.screen .enemy-track {
  height: 16px;
  border-radius: 999px;
  overflow: hidden;
  background: #2a0c10;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.5);
}

.screen .enemy-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(180deg, #ff6a76 0%, #d0122c 72%, #8d0c1c 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35);
  transition: width 0.18s ease-out;
}

.screen .enemy-fill.is-hit {
  filter: brightness(1.4);
}

.screen .enemy-heart {
  position: absolute;
  right: 0;
  top: 50%;
  width: 22px;
  height: 22px;
  transform: translateY(-50%);
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.45));
}

.screen .enemy-hp {
  margin-top: 4px;
  font-size: 0.95rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.screen .enemy-hit.is-heal {
  color: #b6f5c4;
}

.screen .fight {
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(var(--cell) * 8);
}

.screen .player {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 10px;
  border-radius: 999px;
  background: rgba(18, 36, 28, 0.92);
  box-shadow: inset 0 0 0 2px rgba(180, 230, 190, 0.28);
}

.screen .player.is-hit {
  filter: brightness(1.35);
}

.screen .player-name {
  flex: none;
  font-size: 0.85rem;
  font-weight: 700;
  color: #d7ffe4;
}

.screen .player-track {
  flex: 1;
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: #0c1c14;
}

.screen .player-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(180deg, #7dffa8, #14924a);
  transition: width 0.18s ease-out;
}

.screen .player-hp {
  flex: none;
  min-width: 2ch;
  font-size: 0.85rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.screen .player-wound {
  position: absolute;
  right: 8px;
  top: -6px;
  color: #ffb4b8;
  font-size: 1.1rem;
  font-weight: 800;
  pointer-events: none;
  animation: enemy-hit-float 0.55s ease forwards;
}

.screen .cast {
  position: relative;
  flex: none;
  width: 132px;
  height: 36px;
  overflow: hidden;
  border: 0;
  border-radius: 999px;
  padding: 0;
  cursor: pointer;
  font: inherit;
  color: #2a1208;
  background: #3a2a18;
  box-shadow: inset 0 0 0 2px rgba(255, 214, 150, 0.35);
}

.screen .cast:disabled {
  cursor: default;
  color: rgba(255, 236, 210, 0.72);
}

.screen .cast:not(:disabled) {
  box-shadow:
    inset 0 0 0 2px rgba(90, 40, 8, 0.35),
    0 6px 14px rgba(0, 0, 0, 0.28);
}

.screen .cast-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: linear-gradient(180deg, #ffe7a8, #f0b429);
}

.screen .cast:disabled .cast-fill {
  background: linear-gradient(180deg, rgba(240, 180, 70, 0.55), rgba(160, 100, 30, 0.45));
}

.screen .cast-label {
  position: relative;
  z-index: 1;
  font-size: 0.95rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.screen .cast:focus-visible {
  outline: 3px solid #fff4ea;
  outline-offset: 3px;
}

.screen .hint {
  width: calc(var(--cell) * 8);
  min-height: 2.4em;
  margin: -6px 0 0;
  font-size: 0.82rem;
  line-height: 1.25;
  text-align: center;
  color: rgba(255, 244, 220, 0.78);
}

.screen .enemy-hit {
  position: absolute;
  right: 22px;
  top: 30px;
  z-index: 2;
  color: #ffe58a;
  font-size: 1.35rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  text-shadow: 0 2px 0 rgba(0, 0, 0, 0.45);
  pointer-events: none;
  animation: enemy-hit-float 0.55s ease forwards;
}

@keyframes enemy-hit-float {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(-18px);
    opacity: 0;
  }
}

.screen .board {
  position: relative;
  flex: none;
  width: calc(var(--cell) * 8);
  height: calc(var(--cell) * 8);
  touch-action: none;
  cursor: pointer;
}

.screen .board.is-busy {
  cursor: default;
}

.screen .cells {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-template-rows: repeat(8, 1fr);
  border-radius: 16px;
  overflow: hidden;
  background: #12091f;
  box-shadow:
    0 0 0 2px rgba(255, 244, 220, 0.12),
    0 18px 40px rgba(0, 0, 0, 0.38);
}

.screen .cell {
  background: rgba(0, 0, 0, 0.2);
}

.screen .cell.alt {
  background: rgba(255, 246, 230, 0.045);
}

.screen .layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.screen .pieces {
  z-index: 1;
  overflow: hidden;
  border-radius: 16px;
}

.screen .fx {
  z-index: 5;
  overflow: visible;
}

.screen .piece {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--cell);
  height: var(--cell);
  z-index: 1;
  transform-origin: center;
}

.screen .piece-image,
.screen .piece-ice,
.screen .piece-fire,
.screen .piece-slop {
  display: block;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}

.screen .piece-image {
  width: 84%;
  height: 84%;
  margin: 8%;
  filter: drop-shadow(0 3px 2px rgba(0, 0, 0, 0.35));
}

.screen .piece-ice,
.screen .piece-fire,
.screen .piece-slop {
  display: none;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.screen .piece-ice.is-on,
.screen .piece-fire.is-on,
.screen .piece-slop.is-on {
  display: block;
}

.screen .selection {
  position: absolute;
  left: 0;
  top: 0;
  width: var(--cell);
  height: var(--cell);
  z-index: 3;
  pointer-events: none;
  border-radius: 14px;
  box-shadow:
    inset 0 0 0 3px #fff8e8,
    inset 0 0 0 6px rgba(40, 18, 8, 0.55),
    0 0 16px rgba(255, 214, 120, 0.95);
  animation: match3-selection-pulse 0.9s ease-in-out infinite;
}

@keyframes match3-selection-pulse {
  50% {
    box-shadow:
      inset 0 0 0 3px #fff,
      inset 0 0 0 6px rgba(40, 18, 8, 0.35),
      0 0 22px rgba(255, 226, 160, 1);
  }
}

.screen .shard {
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 2px;
  pointer-events: none;
  z-index: 4;
}

.screen .shard.blast {
  box-shadow: 0 0 6px rgba(255, 236, 190, 0.45);
}

.screen .victory {
  position: absolute;
  inset: 0;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(8, 4, 16, 0.72);
}

.screen .victory-card {
  width: min(100%, 340px);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 22px 20px 18px;
  border-radius: 18px;
  text-align: center;
  background: linear-gradient(180deg, #3a2218, #160c14);
  box-shadow:
    inset 0 0 0 2px rgba(255, 214, 150, 0.42),
    0 18px 40px rgba(0, 0, 0, 0.5);
}

.screen .victory-face {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  object-fit: cover;
  box-shadow:
    inset 0 0 0 2px rgba(255, 224, 176, 0.85),
    0 6px 14px rgba(0, 0, 0, 0.35);
}

.screen .victory-title {
  margin: 6px 0 0;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1.8rem;
  font-weight: 700;
  line-height: 1.1;
  color: #ffe7b0;
}

.screen .victory-line {
  margin: 0;
  font-size: 1.05rem;
}

.screen .victory-next-name {
  margin: 0 0 6px;
  color: rgba(255, 244, 220, 0.78);
}

.screen .victory-next {
  appearance: none;
  margin-top: 6px;
  border: 0;
  border-radius: 999px;
  padding: 12px 22px;
  cursor: pointer;
  font: inherit;
  font-size: 1.05rem;
  font-weight: 700;
  color: #2a1208;
  background: linear-gradient(180deg, #ffe7a8, #f0b429);
  box-shadow:
    inset 0 0 0 2px rgba(90, 40, 8, 0.35),
    0 8px 18px rgba(0, 0, 0, 0.35);
}

.screen .victory-next:focus-visible {
  outline: 3px solid #fff4ea;
  outline-offset: 3px;
}

.screen .flash {
  position: absolute;
  left: 0;
  top: 0;
  border-radius: 18%;
  pointer-events: none;
  z-index: 6;
  background: radial-gradient(
    circle at center,
    #ffffff 0%,
    #fffef8 16%,
    #ffe38a 40%,
    rgba(255, 170, 40, 0.42) 62%,
    transparent 76%
  );
  box-shadow:
    0 0 18px 8px rgba(255, 255, 255, 0.98),
    0 0 46px 18px rgba(255, 214, 90, 0.92),
    0 0 72px 28px rgba(255, 140, 20, 0.5);
  mix-blend-mode: plus-lighter;
}
</style>
