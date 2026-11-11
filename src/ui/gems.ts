import type { Cell, GemColor } from '../game'
import redUrl from '../assets/gems/red.svg'
import blueUrl from '../assets/gems/blue.svg'
import greenUrl from '../assets/gems/green.svg'
import yellowUrl from '../assets/gems/yellow.svg'
import purpleUrl from '../assets/gems/purple.svg'
import bombUrl from '../assets/gems/bomb.svg'
import skullUrl from '../assets/hazards/skull.svg'
import iceUrl from '../assets/hazards/ice.svg'
import fireUrl from '../assets/hazards/fire.svg'
import slopUrl from '../assets/hazards/slop.svg'

export { iceUrl, fireUrl, slopUrl }

const GEM_URLS: Record<GemColor, string> = {
  red: redUrl,
  blue: blueUrl,
  green: greenUrl,
  yellow: yellowUrl,
  purple: purpleUrl,
}

export function imageSource(cell: Cell): string {
  if (cell.kind === 'bomb') return bombUrl
  if (cell.kind === 'skull') return skullUrl
  return GEM_URLS[cell.color]
}
