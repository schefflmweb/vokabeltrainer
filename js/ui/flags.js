/**
 * Windows doesn't render flag emoji (🇬🇧/🇩🇪) as actual flag icons — it falls
 * back to plain "GB"/"DE" text in a box, since Segoe UI Emoji has no glyphs
 * for regional indicator sequences. Inline SVGs render identically on every
 * platform instead.
 */

export const flagGB = `<svg class="flag-icon" viewBox="0 0 60 36" aria-hidden="true">
  <rect width="60" height="36" fill="#00247d"/>
  <path d="M0,0 L60,36 M60,0 L0,36" stroke="#fff" stroke-width="6"/>
  <path d="M0,0 L60,36 M60,0 L0,36" stroke="#cf142b" stroke-width="2"/>
  <path d="M30,0 V36 M0,18 H60" stroke="#fff" stroke-width="10"/>
  <path d="M30,0 V36 M0,18 H60" stroke="#cf142b" stroke-width="6"/>
</svg>`;

export const flagDE = `<svg class="flag-icon" viewBox="0 0 60 36" aria-hidden="true">
  <rect width="60" height="12" y="0" fill="#000000"/>
  <rect width="60" height="12" y="12" fill="#dd0000"/>
  <rect width="60" height="12" y="24" fill="#ffce00"/>
</svg>`;
