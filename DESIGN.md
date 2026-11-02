---
name: TradeTwin AI
description: 黑白工作面、荧光黄绿状态与浮层交互构成的询盘合规工作台。
colors:
  ink: "#151612"
  ink-soft: "#50524b"
  ink-faint: "#72746c"
  ink-placeholder: "#797b73"
  sidebar-muted: "#a5a69d"
  green-950: "#11120f"
  green-900: "#20211c"
  green-800: "#303129"
  green-100: "#f1f3e6"
  accent: "#d8fb35"
  paper: "#ffffff"
  paper-warm: "#f3f4f1"
  line: "#e1e3dd"
  line-strong: "#c8cac3"
  page-ground: "#f3f4f1"
  field-surface: "#fbfcfa"
  context-surface: "#f6f7f4"
  active-nav: "#d8fb35"
  amber: "#805415"
  amber-ink: "#805415"
  amber-bg: "#fff4dd"
  red: "#b44c41"
  red-bg: "#fff0ed"
  blue: "#2f6f98"
  blue-bg: "#e9f3fa"
  status-retest: "#a4503d"
  status-retest-bg: "#fff2ee"
  status-reuse: "#26734e"
  status-reuse-bg: "#eff9f2"
  status-update: "#8b691c"
  status-update-bg: "#fff8e8"
  status-review: "#a26616"
  status-review-bg: "#fff8e9"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 720
    lineHeight: 1.08
    letterSpacing: "0"
  headline:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 700
  title:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 700
  body:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Hiragino Sans GB, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  tag: "3px"
  pill: "4px"
  field: "5px"
  control: "7px"
  panel: "7px"
  dialog: "9px"
  avatar: "50%"
spacing:
  hairline: "1px"
  xs: "3px"
  sm: "8px"
  md: "12px"
  lg: "17px"
  xl: "20px"
  page-x: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "38px"
  button-primary-small:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "38px"
  field:
    backgroundColor: "#fbfcfb"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "8px 9px"
    height: "34px"
  status-pill:
    backgroundColor: "#f7faf8"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 6px"
  panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "17px 18px"
  nav-item-active:
    backgroundColor: "{colors.active-nav}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
machine:
  source: "src/styles.css, src/App.tsx, src/components/CaseQueue.tsx, src/components/KnowledgeWorkspace.tsx, src/queueUtils.ts"
  detector:
    report: "/tmp/tradetwin-knowledge-design-findings.json"
    interWarnings: 1
    designTokenAdvisories: 188
    summary: "1 Inter warning + 188 design-token advisories"
    advisoryBreakdown:
      color: 62
      size: 105
      radius: 21
  observedFontSizes: ["8px", "9px", "10px", "11px", "12px", "13px", "14px", "16px", "17px", "18px", "20px", "21px", "24px", "27px", "30px", "clamp(25px, 2.4vw, 35px)"]
  observedRadii: ["3px", "4px", "5px", "6px", "7px", "8px", "9px", "10px", "50%"]
---

# Design System: TradeTwin AI

## Overview

**Creative North Star: “The Evidence Ledger”**

TradeTwin is a work surface for a live trade change, not a promotional dashboard. The interface uses a black navigation rail, cool-white work surfaces, and fluorescent lime for the active step and primary selection. Ink-first controls, consistent Lucide line icons, restrained glass overlays, and short labels carry the hierarchy; business data remains readable without repeated headings.

The refreshed surface uses a queue-first entry and a four-stage case flow: configuration, verification, options, and reply. Low-frequency source text, formulas, alternatives, filters, and case actions open on demand; the desktop detail keeps a sticky cost/timing summary, while small screens stack the same steps and preserve direct navigation. Knowledge, evidence, audit, settings, and inquiry intake share the same ink/lime controls and overlay treatment. Source evidence: `src/styles.css` interaction-system tokens and selectors; `src/App.tsx`, `src/components/CaseQueue.tsx`, and `src/components/KnowledgeWorkspace.tsx` for navigation and workflow behavior.

**Key Characteristics:**

- Black navigation rail with a translucent white utility bar.
- Cool white work surfaces with hairline borders; glass and stronger shadows are reserved for floating navigation, menus, drawers, and dialogs.
- Compact information hierarchy with stable 10–14px metadata, 16–24px section titles, and a fixed 28px case heading.
- Semantic state color is reserved for retest, reuse, update, review, warning, model, and synthetic-data cues.
- Configuration comparison and evidence-page references are the signature interactions.
- Queue-first case discovery with visible status text, derived change chips, explicit unknown fees, and a single “进入案件” action.
- Four-stage detail navigation and unsaved-change guards preserve context through configuration, verification, options, and reply.
- KnowledgeWorkspace keeps index status, six public source entries, searchable knowledge rows, and research provenance in the same paper-ledger hierarchy.
- Inline research citations, separate `asOf`/`checkedAt` dates, and explicit local/live/fallback labels make evidence status scannable without overstating connectivity.

## Colors

The palette uses black ink and cool-white surfaces as the base, with fluorescent lime (`#d8fb35`) to mark the selected workflow step and active intent. Blue, amber, and red remain reserved for connectivity, review, and failure states. The final interaction-system block in `src/styles.css` is authoritative when earlier legacy component rules differ.

### Primary

- **Ink Action** (`{colors.ink}`): Primary action buttons, focused case entry, and active detail surfaces.
- **Fluorescent Lime** (`{colors.accent}`): Active navigation, current workflow marker, and hover feedback.
- **Black Rail** (`{colors.green-950}`): The persistent navigation rail and the strongest structural anchor.

### Secondary

- **Review Blue** (`{colors.blue}`): Live model and informational treatment, used sparingly so it does not compete with the primary green workflow.

### Tertiary

- **Amber Review** (`{colors.amber}`): Warnings, pending confirmation, delivery uncertainty, and the current workflow step.
- **Evidence Red** (`{colors.red}`): Retest, failed parsing, and error states; it is a review signal rather than a decorative accent.

### Neutral

- **Working Ink** (`{colors.ink}`), **Soft Ink** (`{colors.ink-soft}`), and **Faint Ink** (`{colors.ink-faint}`): Primary copy, explanations, metadata, and labels; body-size muted copy uses the contrast-reviewed value.
- **Placeholder and rail copy** (`{colors.ink-placeholder}`, `{colors.sidebar-muted}`): Placeholder text on fields and quiet labels in the dark navigation rail.
- **Paper** (`{colors.paper}`), **Warm Paper Ground** (`{colors.paper-warm}`), and **Page Ground** (`{colors.page-ground}`): White work panels, warm sheet surfaces, and the page-level background.
- **Field and context surfaces** (`{colors.field-surface}`, `{colors.context-surface}`): Slightly lifted input fields and green context strips without adding decorative gradients.
- **Line** (`{colors.line}`) and **Strong Line** (`{colors.line-strong}`): Hairline separators and field/control boundaries.
- **Pale Green** (`{colors.green-100}`): Quiet context surfaces and supporting green fills.

### Named Rules

**The State-First Color Rule.** Color must explain a workflow state or a provenance signal before it decorates a surface; retest, reuse, update, review, model, and synthetic data keep their distinct low-saturation treatments.

**The Ink-on-Paper Rule.** Keep work surfaces light and legible; use lime for active intent and ink for high-confidence actions.

## Typography

**Display Font:** Inter with the system UI stack fallback (`ui-sans-serif`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `PingFang SC`, `Hiragino Sans GB`, `Arial`).

**Body Font:** The same sans stack; the build does not introduce a separate display or mono family for normal UI copy.

**Label/Mono Font:** Labels stay in the same sans stack. Only failure-detail `<pre>` content uses the existing compact `ui-monospace` stack.

**Character:** The type system is practical and compact, with slightly tightened large headings and generous body leading for Chinese/English mixed content. The hierarchy is carried by weight, spacing, and alignment rather than by a decorative face.

### Hierarchy

- **Display** (720, `clamp(25px, 2.4vw, 35px)`, `1.08`): Case and secondary-page headings; the negative tracking keeps long names controlled.
- **Headline** (700, `18px`): Bill and section headings where a panel needs a clear reading anchor.
- **Title** (700, `16px`): Configuration, conversation, quote, and card titles.
- **Body** (400, `13px`, `1.6`): Explanations, inquiry context, and page descriptions; supporting findings step down to 11px.
- **Label** (650, `10px`, `0.08em` when metadata is uppercase): Status pills, field labels, overlines, and compact workflow metadata.

The implemented stylesheet also uses a deliberate supporting ladder of `8px`, `9px`, `10px`, `11px`, `12px`, `13px`, and `14px`, with larger anchors at `16px`, `17px`, `18px`, `20px`, `21px`, `24px`, `27px`, and `30px`; the case heading remains `clamp(25px, 2.4vw, 35px)`. Queue and focused-detail primary reading text is overridden to 14px, with 12px as the common supporting size; metadata, timestamps, scope hints, and compact state context retain 11px/10px where the source does so. The smallest sizes are reserved for audit metadata, scope hints, source labels, and compact status context rather than primary reading copy.

### Named Rules

**The Compact Ledger Rule.** Use the smallest readable size for metadata and state labels, but preserve a clear jump to 16–18px panel titles and the 25–35px case heading.

## Layout

The desktop shell is a sticky 240px sidebar plus a flexible main shell. The topbar is 71px high and remains visible while the work surface scrolls. The default workbench view is the queue: a 1500px surface with search/filter controls, a fixed-layout comparison table, and a lower-right pagination control; desktop-only column visibility controls are paired with comfortable/compact density. Entering a case returns to the focused single-case work surface, which uses a wide main column and a 315–390px aside with a 20px gap; evidence uses a roughly 1.15fr / .85fr list-to-detail split. Primary pages cap at 1500px, secondary pages at 1260px, with 32px horizontal page padding on wide screens and 22px at the 1180px step.

The responsive grammar is explicit in `src/styles.css`: at 1180px the rail narrows to 220px, knowledge cards become two columns, and the focused workspace becomes one column so the full order/value/bill/conversation content stays inside the viewport; at 1100px the fixed case-bill snapshot becomes two columns, the commercial strip becomes two columns with its title and total spanning the row, and the bill summary uses two columns; at 1024px the queue hides the desktop table and column chooser in favor of summary cards, while search and toolbar controls wrap; at 860px the rail becomes a slide-in mobile drawer with its own scroll and the workspace aside becomes two columns; at 768px queue controls become touch-sized and the queue gutter is 13px; at 630px the topbar is 62px, the case heading and actions stack, the workflow becomes a visible three-step grid with connectors and helper copy hidden, the configuration comparison and alternatives stack, the workspace aside becomes one column, evidence detail moves above the list, and knowledge/settings grids become one column. The KnowledgeWorkspace keeps its research entry after the index summary, lets the public-source panel collapse with native `details`, and lets long entry/citation text wrap instead of widening the viewport. The rhythm is a compact 3/8/12/17/20px family with 32px desktop page gutters and 13px mobile gutters.

**The Task-Order Rule.** On narrow screens, preserve the sequence of case context → configuration → bill → evidence/conversation; responsive stacking is a workflow decision, not a cosmetic collapse.

**The Queue Truth Rule.** Queue status, change chips, fee labels, and sort order must come from the case record and deterministic result; unknown is a visible state, never a zero fallback.

## Elevation & Depth

Depth is primarily tonal and structural. Normal work sections stay on cool white with fine borders; sticky workflow navigation, popovers, dialogs, and drawers use a translucent blurred surface with a stronger shadow. Motion is short and functional, with reduced-motion rules preserved.

### Shadow Vocabulary

- **Ambient Notice** (`0 14px 34px rgba(20, 46, 37, .06)`): Floating notices that need separation without looking like a modal.
- **Panel Lift** (`0 2px 10px rgba(19, 50, 40, .018)`): Quiet lift on bill, quote, conversation, settings, and report panels.
- **Drawer Lift** (`-14px 0 35px rgba(3, 30, 22, .14)`): Evidence drawer entering from the right.
- **Dialog Lift** (`0 20px 50px rgba(3, 30, 22, .23)`): New-case dialog above the backdrop.

### Named Rules

**The On-Demand Layer Rule.** Keep normal work surfaces quiet; use glass and lift only where a control floats above the active task.

## Shapes

The form language is compact and consistent: 4px state chips, 5px fields, and 6–8px controls, panels, and overlays. Borders are 1px in `line` or `line-strong`; focus uses a visible lime outline. Icon buttons share a 36px target and Lucide icons share a 17px line treatment.

**The Hairline Boundary Rule.** Use a one-pixel separator to expose a relationship or state change; do not replace every boundary with a shadow.

## Components

### Buttons

- **Shape:** Six-pixel radius, 38px default height, 32px small height, and 0 14px / 0 10px horizontal padding (`.button`, `.button-small`).
- **Primary:** Ink fill with white text; hover shifts to lime and lifts one pixel. The primary button carries the key workflow action such as “重新推演”.
- **Secondary:** White fill with a strong line; hover shifts the border and adds a barely tinted paper fill.
- **Hover / Focus:** 160ms color/border/transform transition; global `:focus-visible` uses the lime outline. Disabled controls reduce opacity to `.58` and use a not-allowed cursor.

### Chips

- **Style:** Status pills use a 4px radius, 5px × 6px padding, a 5px dot, and a 1px state-colored border. Round badges and synthetic labels use the same compact label language with a 4px radius.
- **State:** `retest`/`failed` use red, `reuse`/`ready` use green, `update` uses muted gold, and `review`/`warning` use amber. Model badges add live/fallback blue or red variants.

### Cards / Containers

- **Corner Style:** Major work panels, config cards, bill panels, quote/conversation panels, report details, settings cards, and knowledge forms use a 7px radius.
- **Background:** White paper on a cool neutral ground; selected controls use lime and semantic states retain their own color.
- **Shadow Strategy:** Use the Elevation & Depth vocabulary; glass and stronger shadows belong to floating surfaces.
- **Border:** One-pixel `line`, strengthened for active/config-accent states.
- **Internal Padding:** 15–19px for major sections, 12px for compact evidence blocks, and 17–18px on config/panel shells.

### Inputs / Fields

- **Style:** `{colors.field-surface}` (`#fbfcfb`) field background, 1px line border, 5px radius, 8px 9px padding, and 34px minimum height. Field labels use the finish-review muted ink token at 10px above the control; placeholders use `{colors.ink-placeholder}` (`#66756e`).
- **Focus:** Border shifts to `#8dbba7`, background becomes white, and a 3px low-opacity green halo appears. The global focus-visible rule remains available for keyboard users.
- **Error / Disabled:** Disabled buttons use opacity `.58`; failed evidence uses the red callout rather than silently styling a field as valid.

### Navigation

- **Style:** A 240px black rail contains the TT mark, compact brand lockup, primary nav, recent cases, synthetic-data note, consistent bottom actions, and local-user footer.
- **States:** Default nav is quiet neutral text; hover adds a translucent white surface; active uses lime with ink text. The bottom search, audit, and settings actions share the same icon size, line weight, border, and hit area. At 860px the rail becomes a slide-in drawer.

### Case Queue

The queue is the default workbench entry and is intentionally table-like only while the viewport has room for comparison. The search field tokenizes customer, case, model, and buyer-original-text input with an AND match; status filters can be combined for unanalysed, manual review, retest, and replied cases. Sorting supports newest/oldest update time, customer A–Z, and fee ascending/descending; unknown fee values remain at the end and a genuine zero remains sortable. Page sizes are 10 or 20; case/entry columns remain visible when optional columns are hidden, and density switches between comfortable and compact row/card rhythm.

- **Desktop table:** White paper table with ledger lines, change chips, status badge, fee/lead-time summary, update date, and a right-aligned “进入案件” action.
- **Summary fallback:** At `≤1024px`, the table and column chooser are hidden and each case becomes a readable card containing identity, status, change summary, commercial state, date, and entry action.
- **State language:** Queue states are `待推演`, `待核验`, `含补测`, and `已推演`; `待核验` and unknown fees stay amber and explicit instead of being shown as zero.
- **Controls:** The toolbar, filter chips, pagination, column details popover, and density toggle reuse the existing 6–9px control/panel shapes and focus treatment.

### Detail navigation and unsaved state

The focused case keeps a four-stage sticky nav for configuration, verification, options, and reply. The stage and short status update from the case state. A separate bill snapshot keeps cost, timing, commitment wording, and demo provenance visible while scanning. Editing configuration or order values marks the work surface `未保存`; returning to the queue or switching cases opens a portal-mounted discard dialog, while refresh and new-case actions show a save-first notice. Chat, option selection, and quote generation attempt to save first; a failed save leaves the draft and stops the downstream action.

**The Guarded Save Rule.** A downstream conversation, option, or quote action may run only after the current draft has saved successfully; preserving the user's input is part of the component state, not a notification afterthought.

### Evidence Drawer

The evidence drawer is the signature traceability component: a right-side 450px white sheet with rule chips, status, report/page references, source links, synthetic labels, and a manual override form. It is an operational overlay with a stronger drawer shadow and a short 200ms entrance, not a generic modal. Both it and the new-case dialog render through the `#dialog-root` portal, use `role="dialog"`/`aria-modal="true"`, and stop backdrop clicks at the content boundary.

### Dialog and focus behavior

`useDialogAccessibility` keeps the interaction contract explicit: opening an overlay locks body scroll, marks other body-level siblings inert, focuses the requested initial control (the close button for the drawer and the first case field for new-case), wraps `Tab`/`Shift+Tab` within the dialog, and closes on `Escape`. Cleanup restores each sibling's prior `inert` value, body overflow, and the previously focused element. This is the source behavior behind the visual drawer/dialog treatment, not an implied accessibility claim beyond the implemented paths.

### Audit summaries

The audit view converts event types into compact Chinese labels and deterministic summaries while preserving the raw JSON record behind “查看原始记录”. It exposes the rule version and actor beside each event, shows a separate推演指纹 when present, and summarizes configuration, retrieval count, evidence changes, and manual-override reasons without replacing the underlying audit detail. On compact screens the timestamp rail narrows to 61px so the event summary remains readable.

### UI copy and semantics

Primary page names are emitted as real DOM headings and labels in `src/App.tsx` (`变更工作台`, `证据库`, `知识与规则`, `审计记录`, `接入设置`); the compact CSS rule only hides legacy English metadata that would duplicate those headings. No pseudo-element or CSS-generated copy is used as a substitute for the accessible text.

### Workflow Strip and Comparison

The workspace begins with a four-stage sticky process navigator and a compact cost/timing strip. Configuration editing uses one full-width target form, live before/after markers for changed fields, and a collapsed report baseline; quantity and price follow as a separate quote basis. The bill panel shows a four-cell finding summary, evidence rows, a collapsed timing formula, and on-demand alternatives. This order moves from edit → verify → choose → reply without making two full configuration cards compete for attention.

### KnowledgeWorkspace

KnowledgeWorkspace is a secondary work surface, not a marketing search page. It starts with the index summary and counts, then places the local-first research entry below; low-frequency source and runtime provenance live in disclosures. The research card uses the same compact ink/lime controls and semantic blue/amber/red labels as the case workspace.

- **Index and sources:** The package strip exposes package/index versions, index date, counts, warnings, and the boundary note. The six public source entries live in a native `details` disclosure, with canonical source ID, publisher, topic, scope note, index date, and safe HTTPS link.
- **Entries:** The toolbar pairs a compact search field with a type select. Each row is a native `details` element; the summary shows kind, title, source identifier, and date, while the expanded body shows full text, package provenance, tags, artificial-data and human-review flags, and a non-live index URL label where applicable.
- **Research states:** `local` uses an explicit “仅本地索引·未联网” label and a “查看索引线索” action; `live` shows inline citations and consulted HTTPS sources; `fallback` distinguishes “搜索未采用” from “本次未联网” and keeps local hits visibly separate. `asOf` and `checkedAt` remain separate metadata columns.
- **Interaction:** While research is busy, the query, selected sources, sync, and related editing controls are disabled. Inline citation anchors use the response text span and point only to validated HTTPS URLs; canonical source IDs and same-domain supplemental pages are labelled rather than merged.

**The Evidence Status Rule.** A research card must make it obvious whether the answer came from local index, validated live search, or a fallback; no green treatment may imply live connectivity when `checkedAt` is null.

## Do's and Don'ts

### Do:

- **Do** use the ink/lime palette and semantic status colors for real workflow state.
- **Do** keep evidence, page number, source text, and synthetic provenance visible near the conclusion they support.
- **Do** preserve the 1px border and compact spacing rhythm before reaching for stronger elevation.
- **Do** keep focus-visible outlines, labeled fields, semantic buttons, loading states, and reduced-motion behavior present in new surfaces.
- **Do** preserve the portal-mounted dialog behavior, inert background, focus restoration, Escape close, compact three-step workflow, and readable audit summaries when extending the UI.
- **Do** keep the model mode, fallback state, and “演示数据环境” treatment visible whenever generated output is shown.
- **Do** keep queue search, status filters, fee/lead-time labels, and customer changes derived from the same case record; show unknown cost explicitly.
- **Do** move from queue comparison into a focused case and retain the active queue conditions when returning.
- **Do** keep KnowledgeWorkspace’s package counts, source scope, full entry provenance, `asOf`/`checkedAt`, and research mode visible near the answer they qualify.
- **Do** use native disclosure and keyboard-visible focus for public sources and entry rows; let Chinese, English, German, and long citation text wrap within the panel.

### Don't:

- **Don't** introduce a marketing hero, decorative dashboard graphic, paper texture, stamp motif, or gradient that the implementation does not use.
- **Don't** use lime as generic decoration when amber/red/blue state semantics are required.
- **Don't** turn synthetic reports, planning fees, or model output into an unqualified certification or delivery promise through visual emphasis.
- **Don't** widen the sidebar or add a second navigation system without preserving the 240px/220px rail behavior and 860px drawer transition.
- **Don't** claim complete accessibility or production polish from this source-derived record; verify new changes against the actual UI.
- **Don't** force a dense table below the 1024px queue breakpoint, or hide the Menu/X control, drawer scroll, focus loop, Escape close, or `inert` behavior on mobile.
- **Don't** discard dirty configuration when save fails, and don't let chat, option selection, or quote generation continue after a failed automatic save.
- **Don't** label a local index result as “已联网”, or use a source index URL as if it were a citation from the current web search.
- **Don't** collapse canonical source IDs and same-domain supplemental pages into one provenance label, and don't let a missing `checkedAt` imply a fresh review.
