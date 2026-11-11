/** Золотая монетка без градиентов: одинаковые id в нескольких SVG перебивают друг друга. */
export const COIN_MARKUP = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <circle cx="16" cy="17.4" r="12.2" fill="#6b3a06"/>
  <circle cx="16" cy="15" r="12.2" fill="#e8a317"/>
  <circle cx="16" cy="15" r="9.3" fill="#ffd15a"/>
  <circle cx="16" cy="15" r="9.3" fill="none" stroke="#fff6d4" stroke-width="1.25"/>
  <circle cx="16" cy="15" r="7.1" fill="none" stroke="#b87408" stroke-width="1.15"/>
  <ellipse cx="12" cy="11" rx="3.5" ry="2" fill="#fff8dc"/>
</svg>`

export function createCoinElement(): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'coin'
  el.innerHTML = COIN_MARKUP
  return el
}
