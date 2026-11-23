---
name: Komorebi Minimal
colors:
  surface: '#f9f9ff'
  surface-dim: '#d0daf0'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f0f3ff'
  surface-container: '#e7eeff'
  surface-container-high: '#dee8ff'
  surface-container-highest: '#d9e3f9'
  on-surface: '#121c2c'
  on-surface-variant: '#59413c'
  inverse-surface: '#273141'
  inverse-on-surface: '#ebf1ff'
  outline: '#8d716a'
  outline-variant: '#e1bfb8'
  surface-tint: '#ae3115'
  primary: '#ae3115'
  on-primary: '#ffffff'
  primary-container: '#ff6b4a'
  on-primary-container: '#661000'
  inverse-primary: '#ffb4a3'
  secondary: '#1960a3'
  on-secondary: '#ffffff'
  secondary-container: '#7db6ff'
  on-secondary-container: '#00477f'
  tertiary: '#1b6d24'
  on-tertiary: '#ffffff'
  tertiary-container: '#5cab5a'
  on-tertiary-container: '#003b0a'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#ffdad2'
  primary-fixed-dim: '#ffb4a3'
  on-primary-fixed: '#3d0600'
  on-primary-fixed-variant: '#8c1900'
  secondary-fixed: '#d3e4ff'
  secondary-fixed-dim: '#a2c9ff'
  on-secondary-fixed: '#001c38'
  on-secondary-fixed-variant: '#004881'
  tertiary-fixed: '#a3f69c'
  tertiary-fixed-dim: '#88d982'
  on-tertiary-fixed: '#002204'
  on-tertiary-fixed-variant: '#005312'
  background: '#f9f9ff'
  on-background: '#121c2c'
  surface-variant: '#d9e3f9'
typography:
  display:
    fontFamily: Noto Sans
    fontSize: 34px
    fontWeight: '700'
    lineHeight: 42px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Noto Sans
    fontSize: 26px
    fontWeight: '600'
    lineHeight: 34px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Noto Sans
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Noto Sans
    fontSize: 17px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-lg:
    fontFamily: Noto Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 26px
    letterSpacing: 0em
  body-md:
    fontFamily: Noto Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: 0.005em
  body-sm:
    fontFamily: Noto Sans
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0.01em
  label-md:
    fontFamily: Noto Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.04em
  label-sm:
    fontFamily: Noto Sans
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 0.75rem
  gutter-desktop: 1.5rem
  margin: 1rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

The aesthetic merges contemporary Japanese editorial minimalism (*Ma* — negative space, clarity, and intentional restraint) with the utility of an agile mobile itinerary planner. The emotional target is calm focus, effortless discovery, and quiet confidence: organizing a trip should evoke the tactile pleasure of a pristine traveler’s notebook rather than an overwhelming logistics spreadsheet.

Visual direction centers on:
- **Atmospheric Whitespace:** Generous negative space that allows text and high-intent visual nodes to breathe, reducing cognitive load on compact screens.
- **Micro-tactile Warmth:** Balanced off-whites paired with a sudden energetic coral, evoking stamp seals (*hanko*) on raw washi paper.
- **Editorial Legibility:** Strict typographic hierarchies engineered for dual Latin and CJK character sets, balancing stroke weights across diverse scripts.

## Colors

The palette balances airy base tones with decisive semantic markers:

- **Canvas & Neutral Surfaces:**
  - Background Canvas: `#F8F9FA` (standard) to `#F5F6F8` (recessed/scrolled underlay).
  - Surface Pure: `#FFFFFF` for floating cards, itinerary blocks, and interactive sheets.
  - Neutral Charcoal: `#2D3748` for high-legibility body content; `#1A202C` for primary headings and critical metadata.
  - Neutral Muted: `#718096` for secondary labels, timestamps, and transit step dividers.
  - Hairline Rule: `#E2E8F0` for hairline dividers and subtle component containment.

- **Primary Action (Coral Shunt):**
  - Primary Base: `#FF6B4A` (warm, vibrant coral orange for primary CTAs, active itinerary nodes, and bookmark targets).
  - Primary Active/Pressed: `#E85B3A`.
  - Primary Container: `#FFF0EB` (low-saturation tint for active category chips or selected day markers).

- **Secondary Guidance & Context (Muted Sky):**
  - Info Container: `#EBF5FB`.
  - Info Text / Icon: `#2B6CB0` (used for travel alerts, boarding prompts, and contextual weather indicators).

- **System Success (Mint Sage):**
  - Success Container: `#EBF7EE`.
  - Success Text: `#2E7D32`.
  - Success Border: `#C8E6C9` (applied to itinerary AI parse completion, booking confirmation receipts, and synched states).

## Typography

The type system prioritizes cross-script harmony across Latin glyphs and Traditional Chinese (via font fallbacks: `Noto Sans`, `Noto Sans TC`, `PingFang TC`, `Hiragino Sans`, `sans-serif`).

- **Vertical Grid Harmony:** Line heights for CJK content are slightly more generous than standard western metrics (1.5x–1.6x for body text) to accommodate the dense spatial footprint of multi-stroke ideograms.
- **Hierarchy Restraint:** Weight jumps are kept intentional. Primary headings utilize medium-heavy weights (600/700) to stand firm against ample negative space, while secondary descriptors stay at 400 with muted text coloring to preserve scan efficiency.
- **Numeric Clarity:** Numbers representing times (e.g., flight schedules, departure countdowns) and currency require proportional or tabular figures where supported, preventing layout jitter in vertical timetable trees.

## Layout & Spacing

The layout is built mobile-first, optimized around a 390px viewport width (standard iOS/modern Android hand-held canvas), flexing seamlessly up to desktop widths via a centralized single-column reading column (max-width: 680px for planning views, 1140px for multi-column dashboards).

- **Grid & Margins:**
  - Base Mobile: 4-column layout, 16px (`1rem`) outer margins, 12px (`0.75rem`) gutters.
  - Tablet/Desktop: 12-column layout, 32px (`2rem`) outer margins, 24px (`1.5rem`) gutters.
- **Rhythm & Safe Areas:**
  - Spacing anchors to a base 4px/8px modular unit.
  - Bottom navigation and pinned checkout/sync triggers observe standard mobile dynamic safe-insets, with a fixed 16px floor clearance above hardware home indicators.
- **Vertical Air:** Itinerary day clusters decouple via `space-xl` (40px) to prevent distinct days from bleeding together visually, retaining the curated notebook structure.

## Elevation & Depth

Visual depth is achieved through quiet optical separation rather than sharp, structural drop-shadows.

- **Surface Stacking:** The background canvas sits at base level (`#F8F9FA`). Cards and actionable containers utilize crisp `#FFFFFF` surfaces, standing out primarily through slight tonal contrast.
- **Ambient Veil Shadows:** Where elevation is necessary to convey touch affordance or dynamic dragging (e.g., reordering daily stops), surfaces employ a soft, low-contrast, multi-stop ambient shadow:
  - Resting Card: `0 2px 8px -2px rgba(45, 55, 72, 0.04), 0 1px 3px -1px rgba(45, 55, 72, 0.02)`.
  - Floating / Dragged Node: `0 12px 24px -6px rgba(45, 55, 72, 0.08), 0 4px 8px -2px rgba(45, 55, 72, 0.03)`.
  - Bottom Sheet Backdrop: Translucent overlay using `rgba(26, 32, 44, 0.25)` paired with a subtle blur (`backdrop-filter: blur(4px)`).
- **Hairline Restraint:** Outlines are reserved for structural distinction (e.g., input edges, success banners) using soft 1px solid borders (`#E2E8F0` or `#C8E6C9`), eschewing heavy visual dividers.

## Shapes

The design system standardizes on gentle, cohesive curvature to balance Japanese paper craft simplicity with friendly mobile ergonomics.

- **Primary Radius (`rounded-lg` / 16px):** Standard for core content containers, trip overview cards, modal dialogs, and image viewports.
- **Base Interactive Radius (`rounded` / 8px):** Form fields, sub-elements within cards, and action pills inside tight schedule rows.
- **Full Radius (Pill):** Floating Action Buttons (FAB), category filter chips, day toggles (`Day 1`, `Day 2`), and status indicator badges.

## Components

- **Buttons:**
  - *Primary Button:* Height 48px, background `#FF6B4A`, text `#FFFFFF`, border-radius 12px (or full pill for floating action), font-weight 600. Active tap triggers micro-scale compression (scale: `0.98`) with `#E85B3A`.
  - *Secondary Button:* Height 48px, background `#FFFFFF`, text `#2D3748`, border 1px solid `#E2E8F0`.
  - *Ghost / Navigation Items:* Subtle `#718096` typography, shifting to `#FF6B4A` upon selection, devoid of background noise.

- **Cards (Itinerary Nodes):**
  - Surface `#FFFFFF`, border-radius 16px, ambient drop-shadow. Internal padding 16px.
  - Left edge integrates an optional 3px vertical status stripe or sequence indicator (e.g., `09:30 AM` paired with a delicate circular timeline node).

- **Chips & Filters:**
  - Height 32px, pill-shaped. Default: `#FFFFFF`, border 1px solid `#E2E8F0`, text `#718096`. Selected: `#FFF0EB` background, border 1px solid `#FF6B4A`, text `#FF6B4A`.

- **Guidance & Status Banners:**
  - *Informational (Sky):* Background `#EBF5FB`, border-radius 12px, border 1px solid `#D0E6F7`, text `#2B6CB0`. Used for transit notices and airport luggage tips.
  - *Success (Sage):* Background `#EBF7EE`, border-radius 12px, border 1px solid `#C8E6C9`, text `#2E7D32`. Houses confirmation checks and itinerary import receipts.

- **Input Fields:**
  - Height 48px, background `#FFFFFF`, border 1px solid `#E2E8F0`, border-radius 12px, text `#1A202C`. Focus state applies a 1px ring in `#FF6B4A` without heavy external glows.

- **Timeline Connectors:**
  - A vertical 1.5px dotted or solid `#E2E8F0` track uniting subsequent destination cards, keeping transit transfer durations (e.g., `Train • 18 min`) float-centered between cards.