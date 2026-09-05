// toolbar.js — 시트지: the toolbar strip and the formula bar (docs/SPEC.md section 12).
//
// The constructor builds every node itself: index.html only supplies an empty
// root element. Nothing here touches the engine, the grid or the socket — the
// toolbar is a pure view that reports intent through onCommand(name, payload)
// and paints whatever setState() hands it.
//
// ---------------------------------------------------------------------------
// DOM / class-name contract (styled by public/css/style.css)
// ---------------------------------------------------------------------------
//   .sz-toolbar        the button strip; direct child of the root element
//   .sz-tb-group       one logical group of buttons inside the strip
//   .sz-tb-btn         a single icon button
//   .sz-tb-btn-active  pressed state of a button (also mirrored on aria-pressed)
//   .sz-tb-sep         1px vertical separator between groups
//   .sz-swatches       the swatch grid inside a colour popover
//   .sz-swatch         one colour swatch button
//   .sz-fbar           the formula bar row, below the strip
//   .sz-namebox        name box input — active reference; type a ref to jump
//   .sz-finput         formula input bound to the active cell's raw input
// Additional structural classes (not named in the spec, layout only):
//   .sz-ico            an inline <svg> icon
//   .sz-tb-pop-title   the popover heading (글자색 / 배경색)
//   .sz-tb-pop-row     the "직접 선택 / 기본값" row inside a popover
//   .sz-tb-pop-label   the label wrapping the native colour input
//   .sz-tb-native      the native <input type="color">
//   .sz-tb-reset       the 기본값 button that clears a colour
//   .sz-tb-colorbar    colour indicator bar inside the 글자색/배경색 icons
//   .sz-tb-stats       합계/평균/개수 readout at the right end of the formula bar
//   .sz-tb-merge       the main merge button (셀 병합 / 병합 해제) — SPEC 21.5
//   .sz-tb-merge-menu  the popup listing 전체 병합 / 가로로 병합 / 세로로 병합 / 병합 해제
//   .sz-tb-merge-caret the caret button that opens that menu (layout only)
//   .sz-tb-merge-item  one row inside the menu (layout only)
// Cell-formatting controls — SPEC 22.4:
//   .sz-tb-font        the 글꼴 button; opens the font dropdown
//   .sz-tb-fontsize    the 글꼴 크기 value button; opens the size dropdown
//   .sz-tb-size-step   the − and + buttons flanking that value
//   .sz-tb-border      the 테두리 button; opens the border picker
//   .sz-tb-border-grid the 3x3 preset grid inside that picker
//   .sz-tb-valign      the 세로 정렬 button
//   .sz-tb-wrap        the 텍스트 줄바꿈 button
//   .sz-tb-rotate      the 텍스트 회전 button
//   .sz-tb-drop        the shared dropdown surface all six of them open
// Tools — SPEC 23:
//   .sz-tb-painter     서식 복사 (format painter); on while the painter is armed
//   .sz-tb-zoom        확대/축소 — the percentage button; opens the zoom menu
//   .sz-tb-print       인쇄
//   .sz-tb-link        링크 삽입 — opens the .sz-link-panel
//   .sz-link-panel     the URL field + 적용 / 제거 panel that button opens
//   .sz-tb-fx          함수 도우미 — the Σ button (the caret sits beside it)
//   .sz-fx-list        the searchable "기타 함수" panel
//   .sz-fx-search      its search field
//   .sz-fx-item        one function row inside it
// Additional structural classes for those controls (layout only):
//   .sz-tb-drop-item   one chooseable row inside a .sz-tb-drop
//   .sz-tb-drop-label  the text of such a row
//   .sz-tb-drop-desc   the muted second column of such a row (function gloss)
//   .sz-tb-drop-title  the heading of a sub-control block in the border picker
//   .sz-tb-drop-row    a horizontal strip of sub-control buttons
//   .sz-tb-drop-clear  the 지우기 row that removes every border
//   .sz-tb-border-preset  one of the nine preset buttons in that grid
//   .sz-tb-value       the font name / size text painted inside a button
//   .sz-tb-caret       the caret <svg> drawn at the right edge of such a button
//   .sz-tb-fx-caret    the caret button beside the Σ button
//   .sz-link-row       one row of the link panel (the field, then the buttons)
//   .sz-link-input     the URL field itself
//   .sz-link-apply     적용   .sz-link-clear  제거
//   .sz-fx-rows        the scrolling list inside .sz-fx-list
//   .sz-fx-name        the function name inside a .sz-fx-item
//   .sz-fx-desc        its one-line Korean description
//   .sz-fx-empty       the "일치하는 함수가 없습니다" row
// Data features — SPEC 24:
//   .sz-tb-filter      필터 만들기 / 필터 끄기 over the selection
//   .sz-tb-chart       차트 삽입 — builds a chart from the selection
//   .sz-tb-comment     댓글 — adds a comment to the active cell
//
// ---------------------------------------------------------------------------
// GrowBar — 시트 늘리기 (SPEC 25.4), exported separately from this file
// ---------------------------------------------------------------------------
// This control deliberately does NOT live in the strip above: growing a sheet is a
// geometry change on the sheet you are looking at, so it belongs BELOW the grid,
// beside the sheet bar, where Google Sheets puts it. It is its own class with its
// own root element (#sz-grow-root); the composition root mounts it.
//
//   .sz-grow           the row of controls. GrowBar uses its ROOT element as this
//                      box (adding the class if the host page has not), so mounting
//                      into an element index.html already marked .sz-grow cannot end
//                      up as two nested boxes with two sets of padding and borders.
//   .sz-grow-rows      the 맨 아래에 행 [1000] 개 추가 group
//   .sz-grow-cols      the 오른쪽에 열 [26] 개 추가 group
//   .sz-grow-input     the editable count inside a group. Its `max` is what REMAINS
//                      before MAX_ROWS / MAX_COLS, and the value is clamped to that
//                      on every commit, so the control can never ask for more rows
//                      than the sheet is allowed to have.
//   .sz-grow-btn       the 개 추가 button that ends a group
// Additional structural classes (layout only, not named in the spec):
//   .sz-grow-lead      the leading text of a group (맨 아래에 행 / 오른쪽에 열)
//   .sz-grow-max       the 최대 크기입니다 message. At the limit it REPLACES the
//                      group's children rather than hiding them with [hidden]: a
//                      stylesheet that gives .sz-grow-btn a `display` would beat the
//                      hidden attribute, and a disabled-but-visible button that does
//                      nothing is exactly the state this message exists to prevent.
//
// The colour popover IS the .sz-swatches panel (style.css gives that class the
// panel chrome and hides it through [hidden]); the toolbar only adds position,
// left/top and the hidden attribute, exactly as that stylesheet expects.
// The .sz-tb-drop panels follow the very same pattern.
//
// ---------------------------------------------------------------------------
// Commands emitted through onCommand(name, payload)
// ---------------------------------------------------------------------------
// Spec commands (payload undefined unless noted):
//   undo redo
//   bold italic underline strike
//   align:left align:center align:right
//   fmt:general fmt:number fmt:currency fmt:percent fmt:date fmt:text
//   decimals:inc decimals:dec
//   bg:<hex> fg:<hex>                payload = the same '#rrggbb' string;
//                                    <hex> is the literal 'none' to clear it
//   insertRowAbove insertRowBelow insertColLeft insertColRight
//   deleteRow deleteCol clear
//   freeze:rows freeze:cols          no payload — the host toggles the count
//   export:csv
//   merge:all merge:horizontal       SPEC 21.5 — the main button emits merge:all when
//   merge:vertical merge:none        the selection has no merge and merge:none when it
//                                    has one; the caret menu emits all four directly
//   font:<id>                        SPEC 22.4 — <id> is a key of FONT_LABELS
//   fontsize:<n>                     <n> is an integer 6..96
//   border:<preset>                  payload = the chosen edge { w, s, c }; <preset> is
//                                    all|outer|inner|top|right|bottom|left|
//                                    horizontal|vertical|none
//   valign:top|middle|bottom
//   wrap:overflow|wrap|clip
//   rotate:<value>                   <value> is an integer -90..90, or 'v' (stacked)
//   painter:toggle                   SPEC 23.1 — payload = { sticky: boolean }. A single
//                                    click reports sticky:false ("arm for one selection"),
//                                    the second click of a DOUBLE click reports sticky:true
//                                    ("keep painting"). One command, two intents: the mode
//                                    rides in the payload rather than in a second name.
//   zoom:<n>                         SPEC 23.2 — <n> is a percentage from ZOOM_LEVELS;
//                                    the same number is the payload
//   print                            SPEC 23.3
//   link:set                         SPEC 23.4 — payload = the URL typed into the panel
//   link:clear                       removes the active cell's link (제거, or 적용 on an
//                                    empty field, which can only mean "remove it")
//   fx:sum fx:average fx:count       SPEC 23.5 — insert that function over the guessed range
//   fx:max fx:min
//   fx:more                          the user asked for the full function list; the toolbar
//                                    opens it itself, so a host may ignore this command
//   fx:insert                        payload = a function NAME chosen from that list
//   filter:on filter:off             SPEC 24.1 — the one 필터 button emits filter:on over a
//                                    selection with no filter and filter:off when the sheet
//                                    already has one; `filtered` says which label it wears
//   chart:add                        SPEC 24.2 — build a chart from the selection
//   comment:add                      SPEC 24.3 — comment on the active cell
//
// Formula-bar commands (the spec mandates the bar but names no commands for it):
//   goto            payload: text typed into the name box ('B2' | 'B2:D9')
//   formula:commit  payload: the raw input string typed into the formula input
//   focusGrid       payload: undefined — asks the host to refocus the grid
//
// setState({ style, value, formula, selectionLabel, stats, merged,
//            ff, fs, va, wrap, rot, bd, painting, zoom, link }):
//   style          the active cell's style object ({} when unstyled)
//   value          the active cell's formatted display value (informational)
//   formula        the active cell's raw input, shown in the formula input
//   selectionLabel 'B2' or 'B2:D9', shown in the name box
//   stats          { sum, avg, count } over the numeric cells of the selection
//   merged         true when the active selection contains at least one merge; it
//                  flips the main merge button between 셀 병합 and 병합 해제
//   ff fs va       SPEC 22.4 — the active cell's font id, font size, vertical
//   wrap rot bd    alignment, wrap mode, rotation and border spec, so each of the
//                  six new controls can show the value that is actually in force.
//                  Each one is optional: when the key is absent but `style` is
//                  given, the value is read off that style object instead, so a
//                  host that only passes `style` still gets correct controls.
//                  `va` and `wrap` may end up as '' — the cell has chosen NEITHER,
//                  which is a state of its own and not a member of their enums: an
//                  absent `va` renders centred and an absent `wrap` clips (SPEC
//                  22.1), so the controls mark nothing and their buttons read
//                  기본값. Anything else would have the toolbar claim a value the
//                  user never picked.
//   painting       SPEC 23.1 — true while the host has the format painter armed
//   zoom           SPEC 23.2 — the zoom currently in force. A percentage (100) is the
//                  canonical form, but a factor (1) is accepted too, because the grid's
//                  own setZoom()/getZoom() speak factors and a host that forwards one
//                  must not end up showing "1%".
//   link           SPEC 23.4 — the active cell's link, or null. It prefills the link
//                  panel and lights the 링크 button.
//   filtered       SPEC 24.1 — true when the sheet on screen carries a filter. It flips
//                  the 필터 button between 필터 만들기 and 필터 끄기, exactly the way
//                  `merged` flips the merge button.
//   hasChart       SPEC 24.2 — true when the sheet already holds at least one chart.
//   hasComment     SPEC 24.3 — true when the ACTIVE CELL already has a comment thread,
//                  so the button can offer 댓글 열기 rather than 댓글 추가.
//
// GrowBar.setState({ rows, cols, maxRows, maxCols }):
//   rows cols       the extent of the sheet on screen. Everything the control shows is
//                   derived from what REMAINS: max − current, per axis.
//   maxRows maxCols the ceiling, defaulting to MAX_ROWS / MAX_COLS (5000 x 702). It is
//                   a parameter rather than a constant so the host stays the single
//                   authority on how big a sheet may get.

// The font and border vocabularies are CLOSED sets owned by shared/model.js, so the
// toolbar offers exactly what sanitizeDoc will accept and `fontStackFor` is the only
// thing that ever turns a font id into a CSS font-family string (SPEC 22.2).
import {
  FONT_LABELS, FONT_SIZES, DEFAULT_FONT_SIZE, fontStackFor,
  BORDER_WIDTHS, BORDER_STYLES,
  // SPEC 25.4 — how many rows/columns one press of the grow button asks for, and the
  // extent a fresh sheet starts at (what GrowBar shows until setState says otherwise).
  ROW_GROW_STEP, COL_GROW_STEP, DEFAULT_ROWS, DEFAULT_COLS,
} from '/shared/model.js';
// The hard ceiling a sheet may grow to (5000 x 702, A..ZZ). It is the engine's own
// limit, so the control offers exactly what growSheet() will actually grant.
import { MAX_ROWS, MAX_COLS } from '/shared/formula/refs.js';
// SPEC 23.5: the 함수 도우미 lists the ENGINE's own function table, so what it offers can
// never drift from what the parser accepts, and function-docs.js supplies the prose. Both
// are plain data modules — importing them costs the toolbar no engine behaviour at all.
import { FUNCTIONS } from '/shared/formula/functions.js';
import { docFor } from '/shared/formula/function-docs.js';

/** The fixed 20-colour palette shared by the 글자색 and 배경색 popovers. */
const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7',
  '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00',
  '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
];

/**
 * Minimal structural fallback styling. It is PREPENDED to <head> so that
 * public/css/style.css — linked later in the document — always overrides it.
 * Without it the toolbar would be a vertical stack of unsized buttons in a
 * host page whose stylesheet has not loaded (or is missing).
 */
const FALLBACK_CSS = [
  // nowrap, not wrap: style.css gives the strip a fixed height and `overflow-x:auto`,
  // so it is meant to be ONE scrolling row. A wrapping fallback beats that (style.css
  // declares no flex-wrap of its own) and pushes the last groups onto a second line
  // that the fixed height then clips — visible, but not clickable.
  '.sz-toolbar{display:flex;flex-wrap:nowrap;align-items:center;gap:2px;padding:4px 6px;',
  'overflow-x:auto;overflow-y:hidden}',
  '.sz-tb-group{display:flex;align-items:center;gap:1px}',
  '.sz-tb-sep{display:inline-block;width:1px;height:20px;margin:0 5px;background:currentColor;opacity:.18}',
  '.sz-tb-btn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;',
  'padding:0 4px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;font:inherit}',
  '.sz-tb-btn:hover{background:rgba(60,64,67,.10)}',
  '.sz-tb-btn-active{background:rgba(26,115,232,.16);color:#1a73e8}',
  '.sz-fbar{display:flex;align-items:center;gap:6px;padding:3px 6px}',
  '.sz-namebox{flex:0 0 auto;width:92px;min-width:0}',
  '.sz-finput{flex:1 1 auto;min-width:0}',
  '.sz-tb-stats{flex:0 0 auto;display:flex;align-items:center;margin-left:auto;padding:0 12px;',
  'white-space:nowrap;font-size:12px;opacity:.72}',
  '.sz-swatches{display:grid;grid-template-columns:repeat(10,18px);gap:5px;padding:9px;',
  'border:1px solid rgba(0,0,0,.18);border-radius:8px;background:#fff;color:#202124;',
  'box-shadow:0 6px 20px rgba(0,0,0,.22);font-size:12px}',
  '.sz-swatches[hidden]{display:none}',
  '.sz-swatch{width:18px;height:18px;padding:0;border:1px solid rgba(0,0,0,.22);border-radius:3px;cursor:pointer}',
  '.sz-tb-pop-title{font-weight:600}',
  '.sz-tb-pop-row{display:flex;align-items:center;gap:8px}',
  '.sz-tb-merge-caret{min-width:18px;padding:0 1px}',
  '.sz-tb-merge-menu{min-width:170px;padding:5px;border:1px solid rgba(0,0,0,.18);',
  'border-radius:8px;background:#fff;color:#202124;box-shadow:0 6px 20px rgba(0,0,0,.22);',
  'font-size:13px}',
  '.sz-tb-merge-menu[hidden]{display:none}',
  '.sz-tb-merge-item{display:flex;align-items:center;gap:9px;width:100%;padding:6px 10px;',
  'border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;',
  'font:inherit;text-align:left;white-space:nowrap}',
  '.sz-tb-merge-item:hover,.sz-tb-merge-item:focus{background:rgba(60,64,67,.10)}',
  // The cell-formatting controls (SPEC 22.4). Same floating-panel chrome as the
  // merge menu, so the six dropdowns look like one family even with no stylesheet.
  '.sz-tb-value{display:inline-block;max-width:9.5em;overflow:hidden;text-overflow:ellipsis;',
  'white-space:nowrap;font-size:12px;line-height:1}',
  '.sz-tb-caret{width:12px;height:12px;margin-left:1px;opacity:.7}',
  '.sz-tb-font{min-width:78px;padding:0 4px;justify-content:space-between}',
  '.sz-tb-fontsize{min-width:30px;padding:0 3px}',
  '.sz-tb-size-step{min-width:22px;padding:0 1px}',
  '.sz-tb-drop{min-width:150px;padding:6px;border:1px solid rgba(0,0,0,.18);',
  'border-radius:8px;background:#fff;color:#202124;box-shadow:0 6px 20px rgba(0,0,0,.22);',
  'font-size:13px}',
  '.sz-tb-drop[hidden]{display:none}',
  '.sz-tb-drop-item{display:flex;align-items:center;gap:9px;width:100%;padding:6px 10px;',
  'border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer;',
  'font:inherit;text-align:left;white-space:nowrap}',
  '.sz-tb-drop-item:hover,.sz-tb-drop-item:focus{background:rgba(60,64,67,.10)}',
  '.sz-tb-drop-item[aria-checked="true"]{color:#1a73e8}',
  '.sz-tb-drop-title{padding:6px 10px 2px;font-size:11px;opacity:.7}',
  '.sz-tb-drop-row{display:flex;align-items:center;gap:4px;padding:0 6px 4px}',
  '.sz-tb-drop-clear{margin-top:2px}',
  '.sz-tb-border-grid{display:grid;grid-template-columns:repeat(3,32px);gap:2px;padding:2px}',
  // Tools, SPEC 23. Same floating-panel chrome again, so the zoom menu, the link
  // panel and the function list read as one family with the six dropdowns above.
  '.sz-tb-zoom{min-width:52px;padding:0 4px;justify-content:space-between}',
  '.sz-tb-fx-caret{min-width:18px;padding:0 1px}',
  '.sz-tb-drop-desc{margin-left:auto;padding-left:14px;font-size:12px;opacity:.62}',
  '.sz-link-panel{min-width:290px}',
  '.sz-link-row{display:flex;align-items:center;gap:6px;padding:4px 6px}',
  '.sz-link-input{flex:1 1 auto;min-width:0;padding:5px 8px;border:1px solid rgba(0,0,0,.28);',
  'border-radius:5px;background:#fff;color:inherit;font:inherit}',
  '.sz-link-apply,.sz-link-clear{flex:0 0 auto;min-width:52px;padding:0 10px}',
  '.sz-fx-list{min-width:290px}',
  '.sz-fx-search{width:100%;margin:2px 0 6px;padding:5px 8px;border:1px solid rgba(0,0,0,.28);',
  'border-radius:5px;background:#fff;color:inherit;font:inherit}',
  '.sz-fx-rows{max-height:280px;overflow-y:auto;overflow-x:hidden}',
  '.sz-fx-name{font-weight:600}',
  '.sz-fx-empty{padding:8px 10px;font-size:12px;opacity:.7}',
  // 시트 늘리기 (SPEC 25.4). One low row of text-sized controls under the grid; it
  // must never look like a second toolbar, so no chrome beyond the input and button.
  // nowrap for the reason .sz-toolbar above is nowrap: style.css gives this bar a
  // fixed min-height and `overflow-x:auto`, so it is meant to be ONE scrolling row.
  // A wrapping fallback would survive into the real stylesheet (which declares no
  // flex-wrap of its own) and push a group onto a clipped second line.
  '.sz-grow{display:flex;flex-wrap:nowrap;align-items:center;gap:16px;padding:3px 8px;font-size:12px}',
  '.sz-grow-rows,.sz-grow-cols{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
  '.sz-grow-input{width:66px;min-width:0;padding:2px 6px;border:1px solid rgba(0,0,0,.28);',
  'border-radius:5px;background:#fff;color:inherit;font:inherit;font-size:12px;text-align:right}',
  '.sz-grow-btn{padding:2px 9px;border:1px solid rgba(0,0,0,.20);border-radius:5px;',
  'background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px}',
  '.sz-grow-btn:hover{background:rgba(60,64,67,.10)}',
  '.sz-grow-btn:disabled{opacity:.5;cursor:default}',
  '.sz-grow-max{opacity:.7}',
  '@media (prefers-color-scheme:dark){',
  '.sz-grow-input{background:#202124;color:#e8eaed;border-color:rgba(255,255,255,.28)}',
  '.sz-grow-btn{border-color:rgba(255,255,255,.20)}',
  '.sz-grow-btn:hover{background:rgba(255,255,255,.10)}',
  '.sz-link-input,.sz-fx-search{background:#202124;color:#e8eaed;border-color:rgba(255,255,255,.28)}',
  '.sz-swatches{background:#2a2c2f;color:#e8eaed;border-color:rgba(255,255,255,.16)}',
  '.sz-tb-merge-menu{background:#2a2c2f;color:#e8eaed;border-color:rgba(255,255,255,.16)}',
  '.sz-tb-drop{background:#2a2c2f;color:#e8eaed;border-color:rgba(255,255,255,.16)}',
  '.sz-tb-merge-item:hover,.sz-tb-merge-item:focus{background:rgba(255,255,255,.10)}',
  '.sz-tb-drop-item:hover,.sz-tb-drop-item:focus{background:rgba(255,255,255,.10)}',
  '.sz-tb-btn:hover{background:rgba(255,255,255,.10)}}',
].join('');

let cssInjected = false;
function injectFallbackCss() {
  if (cssInjected || typeof document === 'undefined' || !document.head) return;
  cssInjected = true;
  const el = document.createElement('style');
  el.id = 'sz-toolbar-fallback';
  el.textContent = FALLBACK_CSS;
  document.head.prepend(el); // first in <head> => the real stylesheet wins
}

/**
 * Wrap icon geometry in a stroked 24x24 <svg>.
 * `style="fill:none"` (not just the attribute) because style.css declares
 * `.sz-tb-btn svg { fill: currentColor }`, which would otherwise beat the
 * presentation attribute and flood every outline icon with solid colour.
 * Children that need their own fill set it as an attribute, which wins over
 * the inherited value.
 */
function ico(inner) {
  return '<svg class="sz-ico" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" ' +
    'focusable="false" style="fill:none" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}

/** A glyph drawn as SVG text — still an inline icon, no font file involved. */
function glyph(text, size, weight, x, y, italic) {
  return '<text x="' + (x === undefined ? 12 : x) + '" y="' + (y === undefined ? 16.5 : y) + '" ' +
    'text-anchor="middle" font-size="' + (size || 13) + '" font-weight="' + (weight || 700) + '" ' +
    (italic ? 'font-style="italic" ' : '') +
    'font-family="Georgia,serif" fill="currentColor" stroke="none">' + text + '</text>';
}

/**
 * A border-preset icon: a faint 2x2 cell grid with the lines the preset draws
 * traced heavily over it, so every preset reads as a picture of its own result.
 * `heavy` is SVG path data (possibly several subpaths); '' means "nothing drawn",
 * which is what 지우기 shows.
 */
const BORDER_ICON_GRID =
  '<path d="M4 4h16v16H4z" opacity=".3"/><path d="M12 4v16M4 12h16" opacity=".3"/>';
function borderIco(heavy) {
  return BORDER_ICON_GRID +
    (heavy ? '<path d="' + heavy + '" stroke-width="2.6"/>' : '');
}

/** A sample line for the border width / style sub-controls. */
function lineIco(width, dash) {
  return '<path d="M3.5 12h17" stroke-width="' + width + '"' +
    (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';
}

const ICONS = {
  undo: '<path d="M8.5 6 4 10.5 8.5 15"/><path d="M4 10.5h10.5a5.5 5.5 0 0 1 0 11H9"/>',
  redo: '<path d="M15.5 6 20 10.5 15.5 15"/><path d="M20 10.5H9.5a5.5 5.5 0 0 0 0 11H15"/>',
  bold: glyph('B', 16, 800),
  italic: glyph('I', 16, 600, 12, 16.5, true),
  underline: glyph('U', 14, 600, 12, 15.5) + '<path d="M6.5 19.5h11"/>',
  strike: glyph('S', 14, 600, 12, 17) + '<path d="M4.5 12h15"/>',
  alignLeft: '<path d="M4 6h16M4 10.5h10M4 15h16M4 19.5h10"/>',
  alignCenter: '<path d="M4 6h16M7 10.5h10M4 15h16M7 19.5h10"/>',
  alignRight: '<path d="M4 6h16M10 10.5h10M4 15h16M10 19.5h10"/>',
  fmtGeneral: glyph('123', 9.5, 700),
  fmtNumber: glyph('0.0', 9.5, 700),
  fmtCurrency: glyph('₩', 15, 700, 12, 17),
  fmtPercent: glyph('%', 14, 700, 12, 17),
  fmtDate: '<rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M3.5 10.5h17M8 3.5v4M16 3.5v4"/>',
  fmtText: '<path d="M5 6h14M12 6v13"/>',
  decInc: glyph('.00', 8.5, 700, 9, 16.5) + '<path d="M16.5 12.5h4M18.8 10.5l2 2-2 2"/>',
  decDec: glyph('.0', 8.5, 700, 9.5, 16.5) + '<path d="M20.5 12.5h-4M18.2 10.5l-2 2 2 2"/>',
  fg: glyph('A', 12.5, 800, 12, 14.5) +
    '<rect class="sz-tb-colorbar" x="4" y="17.5" width="16" height="4.5" rx="1.2" ' +
    'fill="#000000" stroke="none"/>',
  bg: '<path d="M7.5 11.5 12.8 6.2l5.3 5.3-5.3 5.3z"/><path d="M9.6 9.4 7.6 7.4"/>' +
    '<rect class="sz-tb-colorbar" x="4" y="18" width="16" height="4.5" rx="1.2" ' +
    'fill="#ffff00" stroke="none"/>',
  rowAbove: '<rect x="3.5" y="12.5" width="17" height="8" rx="1.5"/>' +
    '<path d="M12 3v7.5M8.5 6.5 12 3l3.5 3.5"/>',
  rowBelow: '<rect x="3.5" y="3.5" width="17" height="8" rx="1.5"/>' +
    '<path d="M12 21v-7.5M8.5 17.5 12 21l3.5-3.5"/>',
  colLeft: '<rect x="12.5" y="3.5" width="8" height="17" rx="1.5"/>' +
    '<path d="M3 12h7.5M6.5 8.5 3 12l3.5 3.5"/>',
  colRight: '<rect x="3.5" y="3.5" width="8" height="17" rx="1.5"/>' +
    '<path d="M21 12h-7.5M17.5 8.5 21 12l-3.5 3.5"/>',
  delRow: '<rect x="3.5" y="8" width="17" height="8" rx="1.5"/><path d="M8.5 12h7"/>' +
    '<path d="M3.5 4.5h17M3.5 19.5h17" stroke-dasharray="2 2.6" opacity=".5"/>',
  delCol: '<rect x="8" y="3.5" width="8" height="17" rx="1.5"/><path d="M12 8.5v7"/>' +
    '<path d="M4.5 3.5v17M19.5 3.5v17" stroke-dasharray="2 2.6" opacity=".5"/>',
  clear: '<path d="M4 20.5h16"/><path d="M13.8 4.7 20 10.9l-6.4 6.4H8.4L4.6 13.5z"/>' +
    '<path d="M9.4 9.1 15.6 15.3"/>',
  freezeRows: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/>' +
    '<path d="M3.5 9.5h17" stroke-width="2.8"/><path d="M3.5 15h17" opacity=".45"/>',
  freezeCols: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/>' +
    '<path d="M9.5 3.5v17" stroke-width="2.8"/><path d="M15 3.5v17" opacity=".45"/>',
  csv: '<path d="M12 3v11M8 10.5l4 3.7 4-3.7"/>' +
    '<path d="M4 16.5v3A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
  // Merge icons. The dashed strokes are the grid lines a merge dissolves; the solid
  // ones are the lines that survive it, so each icon reads as its own mode.
  mergeAll: '<rect x="3" y="6" width="18" height="12" rx="1.5"/>' +
    '<path d="M12 6v12" stroke-dasharray="2 2.4" opacity=".5"/>' +
    '<path d="M5.6 12h3.6M7.4 10.2 9.2 12l-1.8 1.8"/>' +
    '<path d="M18.4 12h-3.6M16.6 10.2 14.8 12l1.8 1.8"/>',
  mergeH: '<rect x="3" y="5" width="18" height="14" rx="1.5"/>' +
    '<path d="M3 12h18"/>' +
    '<path d="M9 5v14M15 5v14" stroke-dasharray="2 2.4" opacity=".5"/>',
  mergeV: '<rect x="3" y="5" width="18" height="14" rx="1.5"/>' +
    '<path d="M12 5v14"/>' +
    '<path d="M3 9.7h18M3 14.3h18" stroke-dasharray="2 2.4" opacity=".5"/>',
  mergeOff: '<rect x="3" y="6" width="18" height="12" rx="1.5"/>' +
    '<path d="M12 6v12"/>' +
    '<path d="M9.2 12H5.6M7.4 10.2 5.6 12l1.8 1.8"/>' +
    '<path d="M14.8 12h3.6M16.6 10.2 18.4 12l-1.8 1.8"/>',
  caret: '<path d="M8.5 10.5 12 14l3.5-3.5"/>',

  // ---- cell formatting, SPEC 22.4 -----------------------------------------
  font: glyph('가', 13, 700, 12, 17),
  sizeDec: '<path d="M5 12h14"/>',
  sizeInc: '<path d="M5 12h14M12 5v14"/>',
  // Borders. Each preset traces the exact lines it will draw.
  bdAll: borderIco('M4 4h16v16H4zM12 4v16M4 12h16'),
  bdOuter: borderIco('M4 4h16v16H4z'),
  bdInner: borderIco('M12 4v16M4 12h16'),
  bdTop: borderIco('M4 4h16'),
  bdRight: borderIco('M20 4v16'),
  bdBottom: borderIco('M4 20h16'),
  bdLeft: borderIco('M4 4v16'),
  bdHorizontal: borderIco('M4 12h16'),
  bdVertical: borderIco('M12 4v16'),
  bdNone: borderIco(''),
  // Vertical alignment: the heavy rule is the edge the text is pushed against.
  vaTop: '<path d="M4 4h16" stroke-width="2.6"/><path d="M7.5 8.5h9M7.5 12h9M7.5 15.5h6"/>',
  vaMiddle: '<path d="M4 12h16" stroke-width="2.6"/><path d="M7.5 6h9M7.5 18h9"/>',
  vaBottom: '<path d="M4 20h16" stroke-width="2.6"/><path d="M7.5 8.5h6M7.5 12h9M7.5 15.5h9"/>',
  // Overflow behaviour. The dashed rule is the right-hand cell boundary: text
  // crosses it, turns back before it, or is cut off by it.
  wrapOver: '<path d="M4 7h16M4 12h16M4 17h9"/>' +
    '<path d="M15.5 3.5v17" stroke-dasharray="2 2.4" opacity=".55"/>',
  wrapWrap: '<path d="M4 7h16"/><path d="M4 12h11a3 3 0 0 1 0 6h-4"/>' +
    '<path d="M12.6 15.6 10 18l2.6 2.4"/><path d="M4 17h3"/>',
  wrapClip: '<path d="M4 7h11M4 12h11M4 17h7"/><path d="M15.5 3.5v17" stroke-width="2.4"/>',
  // Rotation. The glyph really is drawn at the angle the preset applies.
  rotNone: glyph('가', 12, 700, 11, 16) + '<path d="M4 19.5h16" opacity=".5"/>',
  rotUp: '<g transform="rotate(-45 11 15)">' + glyph('가', 12, 700, 11, 16) + '</g>' +
    '<path d="M4 19.5h16" opacity=".5"/>',
  rotDown: '<g transform="rotate(45 11 15)">' + glyph('가', 12, 700, 11, 16) + '</g>' +
    '<path d="M4 19.5h16" opacity=".5"/>',
  rotStack: glyph('가', 9, 700, 12, 11) + glyph('나', 9, 700, 12, 21),
  rotQuarter: '<g transform="rotate(-90 11 15)">' + glyph('가', 12, 700, 11, 16) + '</g>' +
    '<path d="M4 19.5h16" opacity=".5"/>',

  // ---- tools, SPEC 23 ------------------------------------------------------
  // A paint roller: the sleeve, the frame that carries it, and the handle that
  // reaches down into the cell the format lands on.
  painter: '<rect x="3.2" y="4" width="12.6" height="5.4" rx="1.2"/>' +
    '<path d="M15.8 6.7h3.4a1.4 1.4 0 0 1 1.4 1.4v2.6a1.4 1.4 0 0 1-1.4 1.4h-7.7"/>' +
    '<rect x="9.7" y="12.1" width="4" height="3.4" rx="1"/>' +
    '<path d="M11.7 15.5v5"/>',
  // A printer: the paper going in on top, the body, the sheet coming out below.
  print: '<path d="M7 8.6V3.4h10v5.2"/>' +
    '<path d="M4.5 8.6h15a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6H17"/>' +
    '<path d="M7 16.8H4.5A1.6 1.6 0 0 1 2.9 15.2v-5A1.6 1.6 0 0 1 4.5 8.6"/>' +
    '<rect x="7" y="13.6" width="10" height="7" rx="1.2"/>',
  // Two chain links, meeting in the middle.
  link: '<path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1.5 1.5"/>' +
    '<path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1.5-1.5"/>',
  fx: glyph('Σ', 16, 700, 12, 18),
  fxMore: '<path d="M4.5 7h15M4.5 12h15M4.5 17h9"/>',

  // ---- data features, SPEC 24 ---------------------------------------------
  // A funnel: wide at the top, narrowing to the stem the surviving rows fall through.
  filter: '<path d="M3.6 5h16.8l-6.6 7.7v6.1l-3.6 2.2v-8.3z"/>',
  // The same funnel, struck through — the 필터 끄기 face of the one filter button.
  filterOff: '<path d="M3.6 5h16.8l-6.6 7.7v6.1l-3.6 2.2v-8.3z" opacity=".55"/>' +
    '<path d="M4.4 4.4 19.6 19.6" stroke-width="2.2"/>',
  // A column chart standing on its axis.
  chart: '<path d="M3.8 20.4h16.4"/>' +
    '<rect x="5.6" y="11.4" width="3.6" height="6.8" rx=".8"/>' +
    '<rect x="10.2" y="6.4" width="3.6" height="11.8" rx=".8"/>' +
    '<rect x="14.8" y="13.6" width="3.6" height="4.6" rx=".8"/>',
  // A speech bubble with its tail, and two lines of text inside it.
  comment: '<path d="M20.2 14.2a2.1 2.1 0 0 1-2.1 2.1H9.4L5.2 20v-3.7a2.1 2.1 0 0 1-1.4-2V6a2.1 2.1 0 0 1 2.1-2.1h12.2A2.1 2.1 0 0 1 20.2 6z"/>' +
    '<path d="M8 8.6h8M8 11.8h5"/>',
};

/** The caret menu: [command, Korean label, icon key]. */
const MERGE_MENU = [
  ['merge:all', '전체 병합', 'mergeAll'],
  ['merge:horizontal', '가로로 병합', 'mergeH'],
  ['merge:vertical', '세로로 병합', 'mergeV'],
  ['merge:none', '병합 해제', 'mergeOff'],
];

/** Buttons of the strip: [command, Korean title, icon key]. */
const GROUPS = [
  [
    ['undo', '실행취소 (Ctrl+Z)', 'undo'],
    ['redo', '다시실행 (Ctrl+Y)', 'redo'],
  ],
  [
    ['bold', '굵게 (Ctrl+B)', 'bold'],
    ['italic', '기울임 (Ctrl+I)', 'italic'],
    ['underline', '밑줄 (Ctrl+U)', 'underline'],
    ['strike', '취소선', 'strike'],
  ],
  [
    ['align:left', '왼쪽 정렬', 'alignLeft'],
    ['align:center', '가운데 정렬', 'alignCenter'],
    ['align:right', '오른쪽 정렬', 'alignRight'],
  ],
  // The merge control sits right after the alignment group (SPEC 21.5). The main
  // button comes first in DOM order so it, not the caret, is the one a search for
  // "병합" finds.
  [
    ['@merge:main', '셀 병합', 'mergeAll'],
    ['@merge:menu', '병합 옵션 더보기', 'caret'],
  ],
  [
    ['fmt:general', '일반 서식', 'fmtGeneral'],
    ['fmt:number', '숫자 서식', 'fmtNumber'],
    ['fmt:currency', '통화 서식', 'fmtCurrency'],
    ['fmt:percent', '백분율 서식', 'fmtPercent'],
    ['fmt:date', '날짜 서식', 'fmtDate'],
    ['fmt:text', '텍스트 서식', 'fmtText'],
    ['decimals:inc', '소수점 자릿수 늘리기', 'decInc'],
    ['decimals:dec', '소수점 자릿수 줄이기', 'decDec'],
  ],
  [
    ['@pop:fg', '글자색', 'fg'],
    ['@pop:bg', '배경색', 'bg'],
  ],
  [
    ['insertRowAbove', '위에 행 삽입', 'rowAbove'],
    ['insertRowBelow', '아래에 행 삽입', 'rowBelow'],
    ['insertColLeft', '왼쪽에 열 삽입', 'colLeft'],
    ['insertColRight', '오른쪽에 열 삽입', 'colRight'],
    ['deleteRow', '행 삭제', 'delRow'],
    ['deleteCol', '열 삭제', 'delCol'],
    ['clear', '내용 지우기 (Delete)', 'clear'],
  ],
  [
    ['freeze:rows', '행 고정 전환', 'freezeRows'],
    ['freeze:cols', '열 고정 전환', 'freezeCols'],
  ],
  [
    ['export:csv', 'CSV로 내보내기', 'csv'],
  ],
];

// ---------------------------------------------------------------------------
// Cell formatting, SPEC 22.4
// ---------------------------------------------------------------------------
//
// The six controls are spliced into the strip immediately after the colour group,
// i.e. at the end of the existing formatting section and before the structural
// buttons, in the order the spec lists them: 글꼴, 글꼴 크기, 테두리, 세로 정렬,
// 텍스트 줄바꿈, 텍스트 회전. They are laid out as three groups so the strip keeps
// its rhythm: typography, borders, then the three text-flow dropdowns.

/** The command of the last button of the group the new controls follow. */
const FORMAT_ANCHOR_CMD = '@pop:bg';

/** Font ids in menu order — the insertion order of the closed FONT_LABELS set. */
const FONT_ORDER = Object.keys(FONT_LABELS);

/** The bounds `sanitizeDoc` enforces on `fs`; a stepped size never leaves them. */
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 96;

/** [value, Korean label, icon key] for the three plain choice dropdowns. */
const VALIGN_ITEMS = [
  ['top', '위', 'vaTop'],
  ['middle', '가운데', 'vaMiddle'],
  ['bottom', '아래', 'vaBottom'],
];
const WRAP_ITEMS = [
  ['overflow', '넘치기', 'wrapOver'],
  ['wrap', '줄바꿈', 'wrapWrap'],
  ['clip', '자르기', 'wrapClip'],
];
// Values are the literal `rotate:<value>` payloads; 'v' is the stacked-vertical mode.
const ROTATE_ITEMS = [
  ['0', '기울임 없음', 'rotNone'],
  ['45', '위로 기울임', 'rotUp'],
  ['-45', '아래로 기울임', 'rotDown'],
  ['v', '세로로 쌓기', 'rotStack'],
  ['90', '90° 회전', 'rotQuarter'],
];

/** The nine presets of the 3x3 picker, row-major: [preset, label, icon key]. */
const BORDER_PRESET_ITEMS = [
  ['all', '전체 테두리', 'bdAll'],
  ['outer', '바깥쪽 테두리', 'bdOuter'],
  ['inner', '안쪽 테두리', 'bdInner'],
  ['horizontal', '가로 테두리', 'bdHorizontal'],
  ['vertical', '세로 테두리', 'bdVertical'],
  ['top', '위쪽 테두리', 'bdTop'],
  ['bottom', '아래쪽 테두리', 'bdBottom'],
  ['left', '왼쪽 테두리', 'bdLeft'],
  ['right', '오른쪽 테두리', 'bdRight'],
];

/** The accessible name of each shared dropdown panel. */
const DROP_LABELS = {
  font: '글꼴',
  size: '글꼴 크기',
  border: '테두리',
  valign: '세로 정렬',
  wrap: '텍스트 줄바꿈',
  rotate: '텍스트 회전',
  // Tools, SPEC 23 — the same dropdown machinery, four more panels.
  zoom: '확대/축소',
  link: '링크 삽입',
  fx: '함수',
  fxlist: '함수 검색',
};

/**
 * Panels that hold something other than a list of choices get role="dialog", and
 * their button announces aria-haspopup="dialog": a screen reader must not promise a
 * menu and then hand over a text field.
 */
const DIALOG_DROPS = new Set(['border', 'link', 'fxlist']);

/** Labels for the border width / style sub-controls. */
const BORDER_WIDTH_LABELS = { 1: '얇게', 2: '보통', 3: '굵게' };
const BORDER_STYLE_LABELS = { solid: '실선', dashed: '파선', dotted: '점선' };
const BORDER_STYLE_DASH = { solid: '', dashed: '5 3.5', dotted: '0.1 3.4' };

/** The default border edge the picker starts on — 1px solid black, as in Sheets. */
function defaultBorderEdge() {
  return { w: 1, s: 'solid', c: '#000000' };
}

/** A known font id, or 'default' for anything else. */
function normFontId(v) {
  return (typeof v === 'string' && Object.prototype.hasOwnProperty.call(FONT_LABELS, v))
    ? v : 'default';
}

/** An integer size inside 6..96, or DEFAULT_FONT_SIZE when there is no usable one. */
function normFontSize(v) {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^[0-9]{1,3}$/.test(v.trim())) n = Number(v.trim());
  return (Number.isInteger(n) && n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE)
    ? n : DEFAULT_FONT_SIZE;
}

/** The `[value, label, iconKey]` triple for one value, or null when it is not offered. */
function itemOf(items, value) {
  for (const item of items) if (item[0] === value) return item;
  return null;
}

/**
 * One of the values in `items`, or '' — "nothing chosen" — for anything else.
 *
 * `va` and `wrap` have NO default inside their own enum (SPEC 22.1): a cell carrying
 * neither key renders CENTRED and CLIPPED, and neither of those is what a `valign:` or
 * `wrap:` command would have written. Folding an absent key onto a member of the list is
 * therefore the toolbar asserting a choice the user never made — it showed 아래 as active
 * over cells the grid was centring, which is the control telling somebody something false
 * about their own document. '' cannot match a row, so no row is marked and the button says
 * 기본값 instead (see `_paintChoiceBtn`).
 *
 * `ff`, `fs` and `rot` are deliberately NOT normalised this way: `'default'`,
 * `DEFAULT_FONT_SIZE` and no-rotation really are what an absent key renders as, so those
 * three keep their own normalisers and go on showing a real answer.
 */
function normStyleChoice(v, items) {
  return itemOf(items, v) ? v : '';
}

/** A rotation normalised to its `rotate:<value>` string form; '0' when unusable. */
function normRotation(v) {
  if (v === 'v') return 'v';
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    if (s === 'v') return 'v';
    if (/^[+-]?[0-9]{1,3}$/.test(s)) n = Number(s);
  }
  return (Number.isInteger(n) && n >= -90 && n <= 90) ? String(n) : '0';
}

/**
 * The first edge a border spec defines, normalised into the picker's own shape.
 * Used to seed the width / style / colour sub-controls from the active cell, so
 * the picker opens showing what that cell already has. Returns null for a cell
 * with no border at all, which leaves the picker on its last explicit choice.
 */
function firstBorderEdge(bd) {
  if (!bd || typeof bd !== 'object') return null;
  for (const side of ['t', 'r', 'b', 'l']) {
    const e = bd[side];
    if (!e || typeof e !== 'object') continue;
    return {
      w: BORDER_WIDTHS.indexOf(e.w) >= 0 ? e.w : 1,
      s: BORDER_STYLES.indexOf(e.s) >= 0 ? e.s : 'solid',
      c: normHex(e.c) || '#000000',
    };
  }
  return null;
}

/**
 * The next size along FONT_SIZES, clamped at both ends: at the smallest entry a
 * further − returns the same value, which the caller reads as "nothing to do".
 * `current` need not be a member of the list (the default 13 is not), so the step
 * is defined as "the nearest listed size strictly below / above it".
 */
function stepFontSize(current, dir) {
  if (dir < 0) {
    let prev = null;
    for (const n of FONT_SIZES) { if (n < current) prev = n; }
    return prev === null ? current : prev;
  }
  for (const n of FONT_SIZES) { if (n > current) return n; }
  return current;
}

/** Format one statistic for the formula-bar readout. */
function statNum(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return n.toExponential(4);
  return n.toLocaleString('ko-KR', { maximumFractionDigits: 6 });
}

/** '#abc' / 'abc123' / '#AABBCC' -> '#aabbcc', or '' when unusable. */
function normHex(value) {
  if (typeof value !== 'string') return '';
  let s = value.trim().toLowerCase();
  if (s.charAt(0) === '#') s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
  return /^[0-9a-f]{6}$/.test(s) ? '#' + s : '';
}

// ---------------------------------------------------------------------------
// Tools, SPEC 23
// ---------------------------------------------------------------------------
//
// Five controls, spliced into the strip at two points so they land in the order the
// spec lists them: 서식 복사 / 확대/축소 / 인쇄 join the undo group at the left end,
// where a view- and document-level tool belongs, and 링크 / 함수 도우미 close the
// strip beside CSV 내보내기, where the things that INSERT something belong.
//
// Not one of them needs a new popover implementation: 확대/축소, 링크 and 함수 도우미
// are .sz-tb-drop panels driven by the very same open/close/keyboard machinery the six
// cell-formatting controls already use, so there is exactly one "close the open panel"
// rule in this file and it keeps applying to every panel added after it.

/** The command of the last button of the group each tool cluster follows. */
const TOOLS_ANCHOR_CMD = 'redo';
const INSERT_ANCHOR_CMD = 'export:csv';

/** 확대/축소 — the percentages the menu offers (SPEC 23.2). */
const ZOOM_LEVELS = [50, 75, 90, 100, 125, 150, 200];
const DEFAULT_ZOOM = 100;
const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

/** 함수 도우미 — the five shortcut rows, then 기타 함수. [command tail, NAME, gloss]. */
const FX_ITEMS = [
  ['sum', 'SUM', '합계'],
  ['average', 'AVERAGE', '평균'],
  ['count', 'COUNT', '개수'],
  ['max', 'MAX', '최댓값'],
  ['min', 'MIN', '최솟값'],
];

/**
 * A zoom value normalised to a PERCENTAGE inside ZOOM_LEVELS' bounds.
 *
 * Both spellings are accepted on purpose: the command and the menu speak percentages
 * (`zoom:150`), while `Grid.setZoom`/`getZoom` speak factors (1.5). A host that hands
 * back whatever the grid gave it must not make the button read "1%", and nothing here
 * can tell the two apart except by magnitude — no real zoom is 2%, and no factor is 50.
 */
function normZoom(v) {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') n = Number(v.trim().replace(/%$/, ''));
  if (!isFinite(n) || n <= 0) return DEFAULT_ZOOM;
  if (n <= 5) n *= 100;                    // a factor (0.5 .. 2), not a percentage
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(n)));
}

/**
 * Every function the ENGINE knows, sorted, with its Korean one-liner (SPEC 23.5).
 * Built once per page: the table is a frozen module constant, so a second walk could
 * only ever produce the same rows. `search` is the lowercased haystack the search box
 * matches against — name and description together, exactly what the spec asks for.
 */
let fxCatalogue = null;
function functionCatalogue() {
  if (fxCatalogue) return fxCatalogue;
  const names = [];
  for (const name of Object.keys(FUNCTIONS || {})) {
    if (typeof name === 'string' && name) names.push(name);
  }
  names.sort();
  fxCatalogue = names.map((name) => {
    const desc = docFor(name);             // '' for a function with no entry: it still lists
    return { name, desc, search: (name + ' ' + desc).toLowerCase() };
  });
  return fxCatalogue;
}

// ---------------------------------------------------------------------------
// Data features, SPEC 24
// ---------------------------------------------------------------------------
//
// Three buttons — 필터 / 차트 / 댓글 — spliced in at the right end of the strip, after
// the insert group, because all three act on a RANGE of data rather than on the format
// of a cell. None of them opens a panel of its own: the panels they lead to
// (.sz-filter-panel, .sz-chart-panel, .sz-comment-panel) belong to the host, which is
// the only place that knows the sheet's filter, its charts and its comment threads.
// The toolbar's whole job here is to report the intent and to show, through `filtered`
// / `hasChart` / `hasComment`, what is already in force.

/** The 필터 button is a toggle, so it goes through the same indirection as 병합. */
const FILTER_MAIN_CMD = '@filter:main';

export class Toolbar {
  /**
   * @param {HTMLElement} root  an empty element supplied by index.html
   * @param {{onCommand?: (name: string, payload?: *) => void}} [options]
   */
  constructor(root, options = {}) {
    if (!root || typeof root.appendChild !== 'function') {
      throw new TypeError('Toolbar: 툴바를 붙일 root 엘리먼트가 필요합니다');
    }
    this.root = root;
    this.onCommand = typeof options.onCommand === 'function' ? options.onCommand : () => {};

    this.state = {
      style: {},
      value: '',
      formula: '',
      selectionLabel: 'A1',
      stats: null,
      merged: false,
      // SPEC 22.4 — the active cell's cell-formatting values, already normalised.
      ff: 'default',
      fs: DEFAULT_FONT_SIZE,
      // '' means "this cell has chosen nothing", which is a real state for `va` and
      // `wrap` and is NOT the same as any member of their enums (SPEC 22.1).
      va: '',
      wrap: '',
      rot: '0',
      bd: null,
      // SPEC 23 — the tools' view state.
      painting: false,
      zoom: DEFAULT_ZOOM,
      link: null,
      // SPEC 24 — the data features' view state.
      filtered: false,
      hasChart: false,
      hasComment: false,
    };

    /** @type {Map<string, HTMLButtonElement>} command -> button */
    this._btns = new Map();
    this._pop = null;      // the single reusable colour popover
    this._popKind = '';    // 'fg' | 'bg' | '' when closed
    this._popAnchor = null;
    this._menu = null;     // the merge menu panel, built on first use
    this._menuOpen = false;
    this._menuItems = [];
    this._mergeIcon = '';  // icon key currently painted on the main merge button

    /**
     * The six cell-formatting dropdowns (SPEC 22.4). One shared implementation,
     * one open at a time: `_drops` holds every panel built so far, `_dropKey` names
     * the one currently open ('' when none is).
     * @type {Map<string, {panel: HTMLElement, anchor: HTMLElement}>}
     */
    this._drops = new Map();
    this._dropKey = '';
    /** The border edge the picker will send with the next preset. */
    this._borderEdge = defaultBorderEdge();
    /** True once the user has picked a width / style / colour of their own. */
    this._borderTouched = false;

    // SPEC 23 — nodes the tools paint into, resolved in _build().
    this._painterBtn = null;
    this._zoomBtn = null;
    this._zoomLabel = null;
    this._printBtn = null;
    this._linkBtn = null;
    this._linkInput = null;
    this._fxBtn = null;
    this._fxCaret = null;
    this._fxSearch = null;
    this._fxRows = [];        // the .sz-fx-item buttons, in catalogue order
    this._fxEmpty = null;

    // SPEC 24 — the data features' buttons, resolved in _buildDataGroups().
    this._filterBtn = null;
    this._filterIcon = '';    // icon key currently painted on the filter button
    this._chartBtn = null;
    this._commentBtn = null;

    injectFallbackCss();
    this._build();
    this._bindGlobal();
    this.setState(this.state);
  }

  // ------------------------------------------------------------------ build

  _build() {
    this.root.textContent = '';

    const bar = document.createElement('div');
    bar.className = 'sz-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '서식 도구 모음');
    this.bar = bar;

    GROUPS.forEach((defs, i) => {
      if (i > 0) bar.appendChild(this._sep());
      const group = document.createElement('div');
      group.className = 'sz-tb-group';
      for (const def of defs) group.appendChild(this._btn(def[0], def[1], def[2]));
      bar.appendChild(group);
      // Controls that are built rather than declared are spliced in after the group
      // they follow: the cell-formatting six after the colour group (SPEC 22.4), the
      // view/document tools after undo/redo and the insert tools after CSV (SPEC 23).
      // Each one brings its own separator, so the next iteration's separator still
      // lands between two groups and never doubles up.
      const last = defs.length ? defs[defs.length - 1][0] : '';
      let extras = null;
      if (last === FORMAT_ANCHOR_CMD) extras = this._buildFormatGroups();
      else if (last === TOOLS_ANCHOR_CMD) extras = this._buildToolGroups();
      else if (last === INSERT_ANCHOR_CMD) {
        // The insert tools (SPEC 23.4 - 23.5) and then the data features (SPEC 24),
        // which close the strip: they are the ones that act on a whole range.
        extras = this._buildInsertGroups().concat(this._buildDataGroups());
      }
      if (extras) {
        for (const extra of extras) {
          bar.appendChild(this._sep());
          bar.appendChild(extra);
        }
      }
    });

    bar.addEventListener('click', (ev) => this._onBarClick(ev));
    this.root.appendChild(bar);

    // Colour indicator bars live inside the fg/bg icons.
    const fgBtn = this._btns.get('@pop:fg');
    const bgBtn = this._btns.get('@pop:bg');
    this._fgBar = fgBtn ? fgBtn.querySelector('.sz-tb-colorbar') : null;
    this._bgBar = bgBtn ? bgBtn.querySelector('.sz-tb-colorbar') : null;

    // The merge control: the spec names these two class names, so they are added
    // here rather than being baked into the generic button builder.
    this._mergeBtn = this._btns.get('@merge:main') || null;
    if (this._mergeBtn) {
      this._mergeBtn.classList.add('sz-tb-merge');
      this._mergeIcon = 'mergeAll';
    }
    this._mergeCaret = this._btns.get('@merge:menu') || null;
    if (this._mergeCaret) {
      this._mergeCaret.classList.add('sz-tb-merge-caret');
      this._mergeCaret.setAttribute('aria-haspopup', 'menu');
      this._mergeCaret.setAttribute('aria-expanded', 'false');
      this._mergeCaret.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowDown' || ev.key === 'Down') {
          ev.preventDefault();
          this._openMenu();
          this._focusItem(0);
        }
      });
    }

    this.root.appendChild(this._buildFormulaBar());
  }

  _btn(cmd, title, iconKey) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sz-tb-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.cmd = cmd;
    b.innerHTML = ico(ICONS[iconKey] || '');
    this._btns.set(cmd, b);
    return b;
  }

  _sep() {
    const s = document.createElement('span');
    s.className = 'sz-tb-sep';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }

  /**
   * A toolbar button whose face is TEXT rather than an icon — the font name and
   * the font size (SPEC 22.4). The text lives in its own .sz-tb-value span so
   * setState can rewrite it without disturbing the caret beside it.
   */
  _labelBtn(cmd, title, className, text, withCaret) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sz-tb-btn' + (className ? ' ' + className : '');
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.cmd = cmd;
    const span = document.createElement('span');
    span.className = 'sz-tb-value';
    span.textContent = text;                  // never interpolate a value as HTML
    b.appendChild(span);
    if (withCaret) {
      b.insertAdjacentHTML('beforeend',
        '<svg class="sz-ico sz-tb-caret" viewBox="0 0 24 24" width="12" height="12" ' +
        'aria-hidden="true" focusable="false" style="fill:none" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round">' + ICONS.caret + '</svg>');
    }
    this._btns.set(cmd, b);
    return b;
  }

  /** Mark a button as the trigger of dropdown `key`, ArrowDown included. */
  _dropAnchor(btn, key) {
    btn.setAttribute('aria-haspopup', DIALOG_DROPS.has(key) ? 'dialog' : 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'Down') {
        ev.preventDefault();
        this._openDrop(key, btn);
        this._focusDropStart(key);
      }
    });
  }

  /**
   * The cell-formatting controls (SPEC 22.4), in the order the spec lists them:
   * 글꼴, 글꼴 크기, 테두리, 세로 정렬, 텍스트 줄바꿈, 텍스트 회전. They come back as
   * three .sz-tb-group elements — typography, borders, text flow — so the strip
   * keeps the same visual rhythm as the groups already in it.
   */
  _buildFormatGroups() {
    const group = (nodes) => {
      const g = document.createElement('div');
      g.className = 'sz-tb-group';
      for (const node of nodes) g.appendChild(node);
      return g;
    };

    // 글꼴 — the current font's name plus a caret.
    const font = this._labelBtn('@drop:font', '글꼴', 'sz-tb-font', FONT_LABELS.default, true);
    this._fontBtn = font;
    this._fontLabel = font.querySelector('.sz-tb-value');
    this._dropAnchor(font, 'font');

    // 글꼴 크기 — − / value / +. The value is also the trigger of the size menu.
    const dec = this._btn('@size:dec', '글꼴 크기 줄이기', 'sizeDec');
    dec.classList.add('sz-tb-size-step');
    const size = this._labelBtn('@drop:size', '글꼴 크기', 'sz-tb-fontsize',
      String(DEFAULT_FONT_SIZE), false);
    this._sizeBtn = size;
    this._sizeLabel = size.querySelector('.sz-tb-value');
    this._dropAnchor(size, 'size');
    const inc = this._btn('@size:inc', '글꼴 크기 늘리기', 'sizeInc');
    inc.classList.add('sz-tb-size-step');

    // 테두리 — the 3x3 preset picker plus its width / style / colour sub-controls.
    const border = this._btn('@drop:border', '테두리', 'bdAll');
    border.classList.add('sz-tb-border');
    this._borderBtn = border;
    this._dropAnchor(border, 'border');

    // 세로 정렬 / 텍스트 줄바꿈 / 텍스트 회전 — three plain choice dropdowns whose
    // button icon is always the choice currently in force.
    const valign = this._btn('@drop:valign', '세로 정렬', 'vaBottom');
    valign.classList.add('sz-tb-valign');
    this._valignBtn = valign;
    this._valignIcon = 'vaBottom';
    this._dropAnchor(valign, 'valign');

    const wrap = this._btn('@drop:wrap', '텍스트 줄바꿈', 'wrapOver');
    wrap.classList.add('sz-tb-wrap');
    this._wrapBtn = wrap;
    this._wrapIcon = 'wrapOver';
    this._dropAnchor(wrap, 'wrap');

    const rotate = this._btn('@drop:rotate', '텍스트 회전', 'rotNone');
    rotate.classList.add('sz-tb-rotate');
    this._rotateBtn = rotate;
    this._rotateIcon = 'rotNone';
    this._dropAnchor(rotate, 'rotate');

    return [
      group([font, dec, size, inc]),
      group([border]),
      group([valign, wrap, rotate]),
    ];
  }

  /** A .sz-tb-group wrapping the given nodes. */
  _group(nodes) {
    const g = document.createElement('div');
    g.className = 'sz-tb-group';
    for (const node of nodes) g.appendChild(node);
    return g;
  }

  /**
   * 서식 복사 / 확대/축소 / 인쇄 (SPEC 23.1 - 23.3) — the tools that act on the view
   * or on the document rather than on cell data. They sit beside undo/redo, which is
   * where the reference layout puts them.
   */
  _buildToolGroups() {
    const painter = this._btn('painter:toggle', '서식 복사 (두 번 클릭하면 계속 적용)', 'painter');
    painter.classList.add('sz-tb-painter');
    painter.setAttribute('aria-pressed', 'false');
    this._painterBtn = painter;

    const zoom = this._labelBtn('@drop:zoom', '확대/축소', 'sz-tb-zoom',
      DEFAULT_ZOOM + '%', true);
    this._zoomBtn = zoom;
    this._zoomLabel = zoom.querySelector('.sz-tb-value');
    this._dropAnchor(zoom, 'zoom');

    const print = this._btn('print', '인쇄', 'print');
    print.classList.add('sz-tb-print');
    this._printBtn = print;

    return [this._group([painter, zoom, print])];
  }

  /**
   * 링크 삽입 and 함수 도우미 (SPEC 23.4 - 23.5) — the two tools that put something
   * INTO the sheet. The Σ button comes before its caret in DOM order for the same
   * reason the merge button does: it is the one a search for "함수" should find.
   */
  _buildInsertGroups() {
    const link = this._btn('@drop:link', '링크 삽입', 'link');
    link.classList.add('sz-tb-link');
    this._linkBtn = link;
    this._dropAnchor(link, 'link');

    const fx = this._btn('@fx:main', '함수 (SUM)', 'fx');
    fx.classList.add('sz-tb-fx');
    this._fxBtn = fx;

    const caret = this._btn('@drop:fx', '함수 더보기', 'caret');
    caret.classList.add('sz-tb-fx-caret');
    this._fxCaret = caret;
    this._dropAnchor(caret, 'fx');

    return [this._group([link, fx, caret])];
  }

  /**
   * 정렬/필터, 차트 and 댓글 (SPEC 24) — the three data features. Each one is a plain
   * button that reports intent; every panel they lead to belongs to the host, which is
   * the only place that knows the sheet's filter, charts and comment threads.
   *
   * 필터 is the one toggle of the three: like the merge button it goes out under an
   * internal command and _onBarClick picks the real one from `filtered`, so the strip
   * never shows 필터 만들기 over a sheet that already has a filter.
   */
  _buildDataGroups() {
    const filter = this._btn(FILTER_MAIN_CMD, '필터 만들기', 'filter');
    filter.classList.add('sz-tb-filter');
    this._filterBtn = filter;
    this._filterIcon = 'filter';

    const chart = this._btn('chart:add', '차트 삽입', 'chart');
    chart.classList.add('sz-tb-chart');
    this._chartBtn = chart;

    const comment = this._btn('comment:add', '댓글 추가', 'comment');
    comment.classList.add('sz-tb-comment');
    this._commentBtn = comment;

    return [this._group([filter, chart, comment])];
  }

  _buildFormulaBar() {
    const fbar = document.createElement('div');
    fbar.className = 'sz-fbar';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'sz-namebox';
    name.title = '이름 상자 — 이동할 셀이나 범위를 입력하세요';
    name.setAttribute('aria-label', '이름 상자');
    name.spellcheck = false;
    name.autocomplete = 'off';
    name.value = this.state.selectionLabel;
    this.namebox = name;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sz-finput';
    input.title = '수식 입력줄 — Enter로 확정, Esc로 취소';
    input.setAttribute('aria-label', '수식 입력줄');
    input.placeholder = '값 또는 수식을 입력하세요';
    input.spellcheck = false;
    input.autocomplete = 'off';
    this.finput = input;

    const stats = document.createElement('span');
    stats.className = 'sz-tb-stats';
    stats.setAttribute('aria-live', 'polite');
    this.statsEl = stats;

    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const text = name.value.trim();
        this._namePending = false;
        if (text) this.emit('goto', text);
        name.blur();
        this.emit('focusGrid');
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this._namePending = false;
        name.value = this.state.selectionLabel;
        name.blur();
        this.emit('focusGrid');
      } else {
        this._namePending = true;
      }
    });
    name.addEventListener('focus', () => { name.select(); });
    name.addEventListener('blur', () => {
      this._namePending = false;
      name.value = this.state.selectionLabel; // never leave a stale ref showing
    });

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this._commitFormula();
        this.emit('focusGrid');
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this._reverting = true;
        input.value = this.state.formula;
        input.blur();
        this._reverting = false;
        this.emit('focusGrid');
      }
      ev.stopPropagation(); // the grid must not treat formula typing as its own
    });
    input.addEventListener('blur', () => {
      // Clicking a cell blurs the bar: commit what was typed, like Sheets does.
      if (this._reverting) return;
      this._commitFormula();
    });

    fbar.appendChild(name);
    fbar.appendChild(input);
    fbar.appendChild(stats);
    this.fbar = fbar;
    return fbar;
  }

  _commitFormula() {
    const text = this.finput.value;
    if (text === this.state.formula) return;
    this.state.formula = text;
    this.emit('formula:commit', text);
  }

  _bindGlobal() {
    this._onDocDown = (ev) => {
      if (this._pop && this._popKind
        && !this._pop.contains(ev.target)
        && !(this._popAnchor && this._popAnchor.contains(ev.target))) {
        this._closePop();
      }
      if (this._menuOpen
        && !(this._menu && this._menu.contains(ev.target))
        && !(this._mergeCaret && this._mergeCaret.contains(ev.target))) {
        this._closeMenu();
      }
      if (this._dropKey) {
        const entry = this._drops.get(this._dropKey);
        if (entry
          && !entry.panel.contains(ev.target)
          && !(entry.anchor && entry.anchor.contains(ev.target))) {
          this._closeDrop();
        }
      }
    };
    this._onDocKey = (ev) => {
      if (ev.key !== 'Escape') return;
      if (this._popKind) this._closePop();
      if (this._menuOpen) this._closeMenu(true);
      if (this._dropKey) this._closeDrop(true);
    };
    this._onReflow = (ev) => {
      // A scroll that STARTED INSIDE the open dropdown is the user reading it, not
      // the page moving out from under it. The 글꼴 크기 menu is taller than the
      // panel's max-height, so closing on its own scroll would make it unreachable.
      if (this._scrolledInsideDrop(ev)) return;
      if (this._popKind) this._closePop();
      if (this._menuOpen) this._closeMenu();
      if (this._dropKey) this._closeDrop();
    };

    document.addEventListener('mousedown', this._onDocDown, true);
    document.addEventListener('keydown', this._onDocKey, true);
    window.addEventListener('resize', this._onReflow);
    window.addEventListener('scroll', this._onReflow, true);
  }

  // ------------------------------------------------------------------ events

  emit(name, payload) {
    try {
      this.onCommand(name, payload);
    } catch (e) {
      console.error('[toolbar] 명령 처리 실패: ' + name, e);
    }
  }

  _onBarClick(ev) {
    const btn = ev.target.closest ? ev.target.closest('button[data-cmd]') : null;
    if (!btn || !this.bar.contains(btn)) return;
    ev.preventDefault();
    const cmd = btn.dataset.cmd;
    if (cmd === '@pop:fg' || cmd === '@pop:bg') {
      this._closeMenu();
      this._closeDrop();
      this._togglePop(btn, cmd.slice(5));
      return;
    }
    if (cmd === '@merge:menu') {
      this._closePop();
      this._closeDrop();
      this._toggleMenu();
      return;
    }
    // The six cell-formatting dropdowns (SPEC 22.4). One open at a time, so
    // opening any of them shuts whatever else the strip had open.
    if (cmd.slice(0, 6) === '@drop:') {
      this._closePop();
      this._closeMenu();
      this._toggleDrop(cmd.slice(6), btn);
      return;
    }
    this._closePop();
    this._closeMenu();
    this._closeDrop();
    if (cmd === '@size:dec' || cmd === '@size:inc') {
      this._stepSize(cmd === '@size:inc' ? 1 : -1);
      return;
    }
    if (cmd === '@merge:main') {
      // One button, two meanings: it undoes the merge the selection already has,
      // and otherwise makes one. The label painted by setState says which.
      this.emit(this.state.merged ? 'merge:none' : 'merge:all');
      return;
    }
    if (cmd === FILTER_MAIN_CMD) {
      // One button, two meanings (SPEC 24.1): it removes the filter the sheet already
      // has, and otherwise makes one over the selection. The label says which.
      this.emit(this.state.filtered ? 'filter:off' : 'filter:on');
      return;
    }
    if (cmd === '@fx:main') {
      // The Σ button itself is the SUM shortcut (SPEC 23.5); the caret beside it
      // opens the rest.
      this.emit('fx:sum');
      return;
    }
    if (cmd === 'painter:toggle') {
      // SPEC 23.1 — one command, two intents. `detail` is the browser's own click
      // counter, so the second click of a double click reports itself without a
      // timer: no delayed single click, no invented second command name, and a host
      // that ignores the payload still gets a plain toggle out of the first click.
      this.emit(cmd, { sticky: (ev.detail || 1) >= 2 });
      return;
    }
    this.emit(cmd);
  }

  // ------------------------------------------------------------- colour pop

  _togglePop(anchor, kind) {
    if (this._popKind === kind) { this._closePop(); return; }
    this._openPop(anchor, kind);
  }

  _openPop(anchor, kind) {
    const pop = this._ensurePop();
    this._popKind = kind;
    this._popAnchor = anchor;
    pop.dataset.kind = kind;
    this._popTitle.textContent = kind === 'fg' ? '글자색' : '배경색';

    const current = normHex(kind === 'fg' ? this.state.style.fg : this.state.style.bg);
    this._popNative.value = current || (kind === 'fg' ? '#000000' : '#ffff00');
    for (const s of this._swatchEls) {
      s.setAttribute('aria-pressed', s.dataset.hex === current ? 'true' : 'false');
    }

    pop.hidden = false; // style.css hides .sz-swatches through [hidden]
    this._placePanel(pop, anchor, 232, 140);
    anchor.setAttribute('aria-expanded', 'true');
  }

  /**
   * Park an already-shown floating panel under its anchor, flipping it above when
   * there is no room below and keeping it inside the viewport on both axes.
   *
   * position:fixed keeps a popover correct no matter how the host page positions
   * the toolbar root (no containing-block assumptions), and the inline left/top
   * override whatever fallback `position` the stylesheet declares. The fallback
   * sizes are only used before the panel has ever been laid out.
   */
  _placePanel(panel, anchor, fallbackW, fallbackH) {
    if (!panel || !anchor || typeof anchor.getBoundingClientRect !== 'function') return;
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth || fallbackW;
    const h = panel.offsetHeight || fallbackH;
    const left = Math.min(r.left, Math.max(4, window.innerWidth - w - 6));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - 4);
    panel.style.left = Math.max(4, left) + 'px';
    panel.style.top = top + 'px';
  }

  _closePop() {
    if (this._popAnchor) this._popAnchor.setAttribute('aria-expanded', 'false');
    this._popKind = '';
    this._popAnchor = null;
    if (this._pop) this._pop.hidden = true;
  }

  /**
   * The popover is itself the .sz-swatches panel: style.css styles that class
   * as a floating panel and hides it with [hidden]. The title and the
   * "직접 선택 / 기본값" row span every column of its 10-wide grid.
   */
  _ensurePop() {
    if (this._pop) return this._pop;

    const pop = document.createElement('div');
    pop.className = 'sz-swatches';
    pop.setAttribute('role', 'dialog');
    pop.hidden = true;
    // Structural, not cosmetic: the stylesheet leaves placement to the host.
    pop.style.position = 'fixed';
    pop.style.zIndex = '2147483000';
    pop.style.maxWidth = 'calc(100vw - 12px)';

    const title = document.createElement('div');
    title.className = 'sz-tb-pop-title';
    title.style.gridColumn = '1 / -1';
    this._popTitle = title;
    pop.appendChild(title);

    this._swatchEls = [];
    for (const hex of PALETTE) {
      const s = document.createElement('button');
      s.type = 'button';
      s.className = 'sz-swatch';
      s.dataset.hex = hex;
      s.title = hex;
      s.setAttribute('aria-label', hex);
      s.style.backgroundColor = hex; // a swatch's colour can only be inline
      pop.appendChild(s);
      this._swatchEls.push(s);
    }
    pop.addEventListener('click', (ev) => {
      const s = ev.target.closest ? ev.target.closest('button.sz-swatch') : null;
      if (!s) return;
      ev.preventDefault();
      this._pickColor(s.dataset.hex);
    });

    const row = document.createElement('div');
    row.className = 'sz-tb-pop-row';
    row.style.gridColumn = '1 / -1';

    const label = document.createElement('label');
    label.className = 'sz-tb-pop-label';
    label.textContent = '직접 선택 ';
    const native = document.createElement('input');
    native.type = 'color';
    native.className = 'sz-tb-native';
    native.setAttribute('aria-label', '색상 직접 선택');
    native.addEventListener('change', () => this._pickColor(native.value));
    label.appendChild(native);
    this._popNative = native;

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'sz-tb-btn sz-tb-reset';
    reset.textContent = '기본값';
    reset.title = '색상 지우기';
    reset.addEventListener('click', (ev) => {
      ev.preventDefault();
      this._pickColor('none');
    });

    row.appendChild(label);
    row.appendChild(reset);
    pop.appendChild(row);

    document.body.appendChild(pop);
    this._pop = pop;
    return pop;
  }

  _pickColor(raw) {
    const kind = this._popKind || 'fg';
    const hex = raw === 'none' ? 'none' : normHex(raw);
    if (!hex) return;
    this._closePop();
    this.emit(kind + ':' + hex, hex);
  }

  // -------------------------------------------------------------- merge menu
  //
  // Built and positioned exactly like the colour popover — a fixed-position panel
  // parented to <body>, closed by Escape, an outside click, a reflow or a choice —
  // so the two behave identically for a keyboard user.

  _ensureMenu() {
    if (this._menu) return this._menu;

    const menu = document.createElement('div');
    menu.className = 'sz-tb-merge-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '셀 병합 옵션');
    menu.hidden = true;
    menu.style.position = 'fixed';
    menu.style.zIndex = '2147483000';
    menu.style.maxWidth = 'calc(100vw - 12px)';

    this._menuItems = [];
    for (const [cmd, label, iconKey] of MERGE_MENU) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sz-tb-merge-item';
      item.setAttribute('role', 'menuitem');
      item.dataset.cmd = cmd;
      item.title = label;
      item.innerHTML = ico(ICONS[iconKey] || '') +
        '<span class="sz-tb-merge-label"></span>';
      const text = item.querySelector('.sz-tb-merge-label');
      if (text) text.textContent = label;         // never interpolate a label as HTML
      menu.appendChild(item);
      this._menuItems.push(item);
    }

    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest ? ev.target.closest('button.sz-tb-merge-item') : null;
      if (!item) return;
      ev.preventDefault();
      const cmd = item.dataset.cmd;
      this._closeMenu(true);                      // focus returns to the caret
      this.emit(cmd);
    });

    menu.addEventListener('keydown', (ev) => {
      const items = this._menuItems;
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown' || ev.key === 'Down') {
        ev.preventDefault();
        this._focusItem(at < 0 ? 0 : at + 1);
      } else if (ev.key === 'ArrowUp' || ev.key === 'Up') {
        ev.preventDefault();
        this._focusItem(at < 0 ? items.length - 1 : at - 1);
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        this._focusItem(0);
      } else if (ev.key === 'End') {
        ev.preventDefault();
        this._focusItem(items.length - 1);
      } else if (ev.key === 'Tab') {
        this._closeMenu();                        // let focus leave naturally
      }
    });

    document.body.appendChild(menu);
    this._menu = menu;
    return menu;
  }

  /** Focus one menu item, wrapping at both ends. */
  _focusItem(index) {
    const items = this._menuItems;
    if (!items.length) return;
    const n = items.length;
    const i = ((index % n) + n) % n;
    try { items[i].focus(); } catch (e) { /* detached: nothing to focus */ }
  }

  _toggleMenu() {
    if (this._menuOpen) this._closeMenu(true);
    else { this._openMenu(); this._focusItem(0); }
  }

  _openMenu() {
    const anchor = this._mergeCaret || this._mergeBtn;
    if (!anchor) return;
    const menu = this._ensureMenu();
    this._menuOpen = true;
    menu.hidden = false;
    this._placePanel(menu, anchor, 180, 150);
    if (this._mergeCaret) this._mergeCaret.setAttribute('aria-expanded', 'true');
  }

  /** @param {boolean} [restoreFocus] send focus back to the caret that opened it */
  _closeMenu(restoreFocus) {
    if (!this._menuOpen) return;
    this._menuOpen = false;
    if (this._menu) this._menu.hidden = true;
    if (this._mergeCaret) {
      this._mergeCaret.setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        try { this._mergeCaret.focus(); } catch (e) { /* best effort */ }
      }
    }
  }

  // -------------------------------------------------- cell-formatting dropdowns
  //
  // SPEC 22.4: the six cell-formatting controls share ONE dropdown implementation
  // and ONE open-at-a-time rule. Every panel is a fixed-position .sz-tb-drop
  // parented to <body> — the same shape as the colour popover and the merge menu —
  // built once on first use, and closed by Escape, an outside click, a reflow, a
  // choice, or the opening of any other popover in the strip. Keyboard handling
  // matches the merge menu: ArrowDown on the button opens and focuses the first
  // row, the arrows and Home/End walk the rows, Tab lets focus leave, Escape
  // closes and hands focus back to the button.

  /** True when `ev` is a scroll that happened inside the currently open panel. */
  _scrolledInsideDrop(ev) {
    if (!ev || ev.type !== 'scroll' || !this._dropKey) return false;
    const entry = this._drops.get(this._dropKey);
    const target = ev.target;
    if (!entry || !entry.panel || !target || !target.nodeType) return false;
    return entry.panel.contains(target);
  }

  /**
   * Every focusable row of one panel, in DOM order.
   * Rows the function search has filtered out are skipped: they are `hidden`, so
   * focusing one would move the focus ring to something nobody can see.
   */
  _dropItems(key) {
    const entry = this._drops.get(key);
    if (!entry) return [];
    const all = Array.prototype.slice.call(entry.panel.querySelectorAll('[data-drop-item]'));
    return all.filter((node) => !node.hidden);
  }

  _toggleDrop(key, anchor) {
    if (this._dropKey === key) { this._closeDrop(true); return; }
    this._openDrop(key, anchor);
    this._focusDropStart(key);
  }

  /**
   * Put the focus where a freshly opened panel expects it. A list of choices starts
   * on its first row; a panel built around a text field starts in that field, with
   * its contents selected so typing replaces the URL that is already there.
   */
  _focusDropStart(key) {
    if (key === 'link' && this._linkInput) {
      try { this._linkInput.focus(); this._linkInput.select(); } catch (e) { /* best effort */ }
      return;
    }
    if (key === 'fxlist' && this._fxSearch) {
      try { this._fxSearch.focus(); this._fxSearch.select(); } catch (e) { /* best effort */ }
      return;
    }
    this._focusDropItem(0);
  }

  _openDrop(key, anchor) {
    if (this._dropKey && this._dropKey !== key) this._closeDrop();
    const entry = this._ensureDrop(key, anchor);
    if (!entry) return;
    if (anchor) entry.anchor = anchor;
    this._dropKey = key;
    this._paintDrop(key);              // show the value in force before it appears
    entry.panel.hidden = false;
    this._placePanel(entry.panel, entry.anchor, 180, 220);
    if (entry.anchor) entry.anchor.setAttribute('aria-expanded', 'true');
  }

  /** @param {boolean} [restoreFocus] send focus back to the button that opened it */
  _closeDrop(restoreFocus) {
    const key = this._dropKey;
    if (!key) return;
    this._dropKey = '';
    const entry = this._drops.get(key);
    if (!entry) return;
    entry.panel.hidden = true;
    if (entry.anchor) {
      entry.anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        try { entry.anchor.focus(); } catch (e) { /* detached: best effort */ }
      }
    }
  }

  /** Focus one row of the open panel, wrapping at both ends. */
  _focusDropItem(index) {
    const items = this._dropItems(this._dropKey);
    if (!items.length) return;
    const n = items.length;
    const i = ((index % n) + n) % n;
    try { items[i].focus(); } catch (e) { /* detached: nothing to focus */ }
  }

  _onDropKey(ev) {
    // A text field inside a panel owns its own keys: Home/End move the caret, Tab
    // walks the panel's own buttons, and swallowing either would make the URL field
    // and the function search unusable. The one exception is opted into per field
    // (data-drop-nav): the search box lets the vertical arrows step into the list.
    const t = ev.target;
    if (t && t.nodeType === 1 && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      const nav = t.dataset && t.dataset.dropNav;
      const arrow = ev.key === 'ArrowDown' || ev.key === 'Down'
        || ev.key === 'ArrowUp' || ev.key === 'Up';
      if (!nav || !arrow) return;
    }
    const items = this._dropItems(this._dropKey);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'Down') {
      ev.preventDefault();
      this._focusDropItem(at < 0 ? 0 : at + 1);
    } else if (ev.key === 'ArrowUp' || ev.key === 'Up') {
      ev.preventDefault();
      this._focusDropItem(at < 0 ? items.length - 1 : at - 1);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      this._focusDropItem(0);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      this._focusDropItem(items.length - 1);
    } else if (ev.key === 'Tab') {
      this._closeDrop();                          // let focus leave naturally
    }
  }

  _ensureDrop(key, anchor) {
    const existing = this._drops.get(key);
    if (existing) return existing;

    const panel = document.createElement('div');
    panel.className = 'sz-tb-drop sz-tb-drop-' + key;
    panel.setAttribute('role', DIALOG_DROPS.has(key) ? 'dialog' : 'menu');
    panel.setAttribute('aria-label', DROP_LABELS[key] || '');
    panel.hidden = true;
    // Structural, not cosmetic: the stylesheet leaves placement to the host.
    panel.style.position = 'fixed';
    panel.style.zIndex = '2147483000';
    panel.style.maxWidth = 'calc(100vw - 12px)';

    if (key === 'font') this._fillFontDrop(panel);
    else if (key === 'size') this._fillSizeDrop(panel);
    else if (key === 'border') this._fillBorderDrop(panel);
    else if (key === 'valign') this._fillChoiceDrop(panel, VALIGN_ITEMS, 'valign');
    else if (key === 'wrap') this._fillChoiceDrop(panel, WRAP_ITEMS, 'wrap');
    else if (key === 'rotate') this._fillChoiceDrop(panel, ROTATE_ITEMS, 'rotate');
    // Tools, SPEC 23 — three more panels on the very same machinery.
    else if (key === 'zoom') this._fillZoomDrop(panel);
    else if (key === 'link') this._fillLinkDrop(panel);
    else if (key === 'fx') this._fillFxDrop(panel);
    else if (key === 'fxlist') this._fillFxListDrop(panel);
    else return null;

    panel.addEventListener('keydown', (ev) => this._onDropKey(ev));
    document.body.appendChild(panel);
    const entry = { panel, anchor: anchor || null };
    this._drops.set(key, entry);
    return entry;
  }

  /** One chooseable row: an optional icon, a label, and the value it stands for. */
  _dropItem(value, label, iconKey, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sz-tb-drop-item' + (extraClass ? ' ' + extraClass : '');
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', 'false');
    b.dataset.dropItem = '1';
    b.dataset.value = value;
    b.title = label;
    if (iconKey) b.innerHTML = ico(ICONS[iconKey] || '');
    const text = document.createElement('span');
    text.className = 'sz-tb-drop-label';
    text.textContent = label;                     // never interpolate a label as HTML
    b.appendChild(text);
    return b;
  }

  /** A small heading above a block of sub-controls. */
  _dropTitle(text) {
    const t = document.createElement('div');
    t.className = 'sz-tb-drop-title';
    t.textContent = text;
    return t;
  }

  _fillFontDrop(panel) {
    for (const id of FONT_ORDER) {
      const item = this._dropItem(id, FONT_LABELS[id], '');
      // "each entry rendered in its own face" (SPEC 22.4). fontStackFor() is the
      // only thing that turns an id into a font string, and the id comes from the
      // closed FONT_LABELS set, so nothing user-supplied reaches this declaration.
      item.style.fontFamily = fontStackFor(id);
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._closeDrop(true);
        this.emit('font:' + id, id);
      });
      panel.appendChild(item);
    }
  }

  _fillSizeDrop(panel) {
    for (const n of FONT_SIZES) {
      const item = this._dropItem(String(n), String(n), '');
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._closeDrop(true);
        this.emit('fontsize:' + n, n);
      });
      panel.appendChild(item);
    }
  }

  _fillChoiceDrop(panel, items, command) {
    for (const [value, label, iconKey] of items) {
      const item = this._dropItem(value, label, iconKey);
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._closeDrop(true);
        this.emit(command + ':' + value, value);
      });
      panel.appendChild(item);
    }
  }

  // ------------------------------------------------------------ tools, SPEC 23

  /** 확대/축소 (SPEC 23.2): the seven levels, marked with the one in force. */
  _fillZoomDrop(panel) {
    for (const n of ZOOM_LEVELS) {
      const item = this._dropItem(String(n), n + '%', '');
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._closeDrop(true);
        this.emit('zoom:' + n, n);
      });
      panel.appendChild(item);
    }
  }

  /**
   * 링크 삽입 (SPEC 23.4): a URL field prefilled from the active cell, 적용 and 제거.
   * Enter applies, Escape closes (the strip's own document-level Escape handler does
   * that for every panel alike). The value is emitted RAW — `sanitizeLink` in
   * shared/model.js is the single gate every stored link passes through, and putting a
   * second, weaker check here would only invite the two to disagree.
   */
  _fillLinkDrop(panel) {
    panel.classList.add('sz-link-panel');

    const row = document.createElement('div');
    row.className = 'sz-link-row';

    const input = document.createElement('input');
    // Deliberately type="text": a type="url" field applies its own idea of validity on
    // top of ours, and a user who pastes a mailto: address must not be told it is wrong
    // by the browser before sanitizeLink ever sees it.
    input.type = 'text';
    input.className = 'sz-link-input';
    // The placeholder names the schemes rather than showing a whole example address:
    // the app must make no external network reference at all (tools/check-spec.mjs
    // enforces that), and a literal URL in shipped code is exactly what that forbids.
    input.placeholder = 'https:// 또는 mailto: 주소';
    input.title = '링크 주소 — Enter로 적용, Esc로 닫기';
    input.setAttribute('aria-label', '링크 주소');
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.dataset.dropItem = '1';
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this._applyLink();
      }
      ev.stopPropagation();   // the grid must not treat URL typing as its own
    });
    this._linkInput = input;
    row.appendChild(input);
    panel.appendChild(row);

    const actions = document.createElement('div');
    actions.className = 'sz-link-row';

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'sz-tb-btn sz-link-apply';
    apply.dataset.dropItem = '1';
    apply.textContent = '적용';
    apply.title = '이 셀에 링크를 적용합니다';
    apply.addEventListener('click', (ev) => { ev.preventDefault(); this._applyLink(); });

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'sz-tb-btn sz-link-clear';
    clear.dataset.dropItem = '1';
    clear.textContent = '제거';
    clear.title = '이 셀의 링크를 제거합니다';
    clear.addEventListener('click', (ev) => {
      ev.preventDefault();
      this._closeDrop(true);
      this.emit('link:clear');
    });

    actions.appendChild(apply);
    actions.appendChild(clear);
    panel.appendChild(actions);
  }

  /**
   * 적용. An empty field can only mean one thing — there is no link to apply — so it
   * reports link:clear rather than asking the host to interpret an empty URL.
   */
  _applyLink() {
    const raw = this._linkInput ? String(this._linkInput.value || '').trim() : '';
    this._closeDrop(true);
    if (!raw) { this.emit('link:clear'); return; }
    this.emit('link:set', raw);
  }

  /** 함수 도우미 (SPEC 23.5): the five shortcuts, then 기타 함수. */
  _fillFxDrop(panel) {
    for (const [tail, name, gloss] of FX_ITEMS) {
      const item = this._dropItem(tail, name, '');
      item.setAttribute('role', 'menuitem');
      item.removeAttribute('aria-checked');       // an action, not a choice
      const desc = document.createElement('span');
      desc.className = 'sz-tb-drop-desc';
      desc.textContent = gloss;                   // never interpolate a label as HTML
      item.appendChild(desc);
      item.title = name + ' — ' + gloss;
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._closeDrop(true);
        this.emit('fx:' + tail);
      });
      panel.appendChild(item);
    }

    const more = this._dropItem('more', '기타 함수', 'fxMore', 'sz-tb-drop-clear');
    more.setAttribute('role', 'menuitem');
    more.removeAttribute('aria-checked');
    more.addEventListener('click', (ev) => {
      ev.preventDefault();
      this._openFxList();
    });
    panel.appendChild(more);
  }

  /**
   * 기타 함수: report the intent, then open the searchable list. The list is the
   * toolbar's own affordance — a host that has no use for the command can ignore it
   * and the panel still opens.
   */
  _openFxList() {
    this.emit('fx:more');
    const anchor = this._fxCaret || this._fxBtn;
    this._openDrop('fxlist', anchor);             // closes the fx menu on its way in
    // Reopening starts from the whole list rather than from the last search.
    if (this._fxSearch) {
      this._fxSearch.value = '';
      this._filterFx();
    }
    this._focusDropStart('fxlist');
  }

  /**
   * The searchable function list (SPEC 23.5). Every row comes from the ENGINE's own
   * FUNCTIONS table, so the list can never offer a name the parser would reject, and
   * the description comes from function-docs.js — a function with no entry still
   * lists, with its name alone.
   */
  _fillFxListDrop(panel) {
    panel.classList.add('sz-fx-list');

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'sz-fx-search';
    search.placeholder = '함수 검색';
    search.title = '이름이나 설명으로 검색합니다';
    search.setAttribute('aria-label', '함수 검색');
    search.spellcheck = false;
    search.autocomplete = 'off';
    search.dataset.dropItem = '1';
    search.dataset.dropNav = '1';                 // ↓ / ↑ step into the list
    search.addEventListener('input', () => this._filterFx());
    search.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const first = this._fxRows.find((row) => !row.hidden);
      if (first) this._chooseFx(first.dataset.value);
    });
    this._fxSearch = search;
    panel.appendChild(search);

    const rows = document.createElement('div');
    rows.className = 'sz-fx-rows';
    this._fxRows = [];
    for (const entry of functionCatalogue()) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sz-tb-drop-item sz-fx-item';
      item.setAttribute('role', 'menuitem');
      item.dataset.dropItem = '1';
      item.dataset.value = entry.name;
      item.dataset.search = entry.search;
      item.title = entry.desc ? (entry.name + ' — ' + entry.desc) : entry.name;

      const name = document.createElement('span');
      name.className = 'sz-tb-drop-label sz-fx-name';
      name.textContent = entry.name;              // text nodes only, never markup
      item.appendChild(name);
      if (entry.desc) {
        const desc = document.createElement('span');
        desc.className = 'sz-tb-drop-desc sz-fx-desc';
        desc.textContent = entry.desc;
        item.appendChild(desc);
      }
      item.addEventListener('click', (ev) => {
        ev.preventDefault();
        this._chooseFx(entry.name);
      });
      rows.appendChild(item);
      this._fxRows.push(item);
    }
    panel.appendChild(rows);

    const empty = document.createElement('div');
    empty.className = 'sz-fx-empty';
    empty.textContent = '일치하는 함수가 없습니다';
    empty.hidden = true;
    this._fxEmpty = empty;
    panel.appendChild(empty);
  }

  /** Filter the list on the search text — name AND description, case-insensitively. */
  _filterFx() {
    const q = this._fxSearch ? String(this._fxSearch.value || '').trim().toLowerCase() : '';
    let shown = 0;
    for (const row of this._fxRows) {
      const on = !q || (row.dataset.search || '').indexOf(q) >= 0;
      row.hidden = !on;
      if (on) shown += 1;
    }
    if (this._fxEmpty) this._fxEmpty.hidden = shown > 0;
  }

  _chooseFx(name) {
    if (!name) return;
    this._closeDrop(true);
    this.emit('fx:insert', name);
  }

  /**
   * The 테두리 picker: the nine presets in a 3x3 .sz-tb-border-grid, a 지우기 row
   * for `none`, and the width / style / colour sub-controls that decide the edge
   * every preset sends as its payload.
   */
  _fillBorderDrop(panel) {
    const grid = document.createElement('div');
    grid.className = 'sz-tb-border-grid';
    for (const [preset, label, iconKey] of BORDER_PRESET_ITEMS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sz-tb-btn sz-tb-border-preset';
      b.dataset.dropItem = '1';
      b.dataset.value = preset;
      // style.css keys its own preset artwork off data-preset, so a host that
      // restyles the picker can reach each button without parsing a label.
      b.dataset.preset = preset;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = ico(ICONS[iconKey] || '');
      b.addEventListener('click', (ev) => { ev.preventDefault(); this._pickBorder(preset); });
      grid.appendChild(b);
    }
    panel.appendChild(grid);

    const clear = this._dropItem('none', '지우기', 'bdNone', 'sz-tb-drop-clear');
    clear.setAttribute('role', 'menuitem');
    clear.removeAttribute('aria-checked');        // an action, not a choice
    clear.addEventListener('click', (ev) => { ev.preventDefault(); this._pickBorder('none'); });
    panel.appendChild(clear);

    panel.appendChild(this._dropTitle('선 두께'));
    const widthRow = document.createElement('div');
    widthRow.className = 'sz-tb-drop-row';
    this._bdWidthBtns = [];
    for (const w of BORDER_WIDTHS) {
      const label = BORDER_WIDTH_LABELS[w] || (w + 'px');
      const b = this._subBtn(String(w), label, lineIco(w, ''), () => {
        this._borderEdge.w = w;
        this._borderTouched = true;
        this._paintBorderDrop();
      });
      this._bdWidthBtns.push(b);
      widthRow.appendChild(b);
    }
    panel.appendChild(widthRow);

    panel.appendChild(this._dropTitle('선 스타일'));
    const styleRow = document.createElement('div');
    styleRow.className = 'sz-tb-drop-row';
    this._bdStyleBtns = [];
    for (const s of BORDER_STYLES) {
      const label = BORDER_STYLE_LABELS[s] || s;
      const b = this._subBtn(s, label, lineIco(2, BORDER_STYLE_DASH[s] || ''), () => {
        this._borderEdge.s = s;
        this._borderTouched = true;
        this._paintBorderDrop();
      });
      this._bdStyleBtns.push(b);
      styleRow.appendChild(b);
    }
    panel.appendChild(styleRow);

    panel.appendChild(this._dropTitle('선 색상'));
    const colorRow = document.createElement('div');
    colorRow.className = 'sz-tb-drop-row';
    const label = document.createElement('label');
    label.className = 'sz-tb-pop-label';
    label.textContent = '색상 ';
    const native = document.createElement('input');
    native.type = 'color';
    native.className = 'sz-tb-native';
    native.dataset.dropItem = '1';
    native.value = this._borderEdge.c;
    native.setAttribute('aria-label', '테두리 색상');
    native.addEventListener('change', () => {
      const hex = normHex(native.value);
      if (!hex) return;
      this._borderEdge.c = hex;
      this._borderTouched = true;
    });
    label.appendChild(native);
    colorRow.appendChild(label);
    panel.appendChild(colorRow);
    this._bdColorInput = native;
  }

  /** A small sub-control button inside the border picker. */
  _subBtn(value, label, iconInner, onPick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sz-tb-btn';
    b.dataset.dropItem = '1';
    b.dataset.value = value;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = ico(iconInner);
    b.addEventListener('click', (ev) => { ev.preventDefault(); onPick(); });
    return b;
  }

  _pickBorder(preset) {
    this._closeDrop(true);
    // The edge travels as the payload, so the host hands it straight to
    // applyBorderPreset() (SPEC 22.3) instead of re-deriving it from the command.
    this.emit('border:' + preset, { ...this._borderEdge });
  }

  /** Mark the row that matches the value currently in force. */
  _paintDrop(key) {
    if (!this._drops.has(key)) return;
    if (key === 'border') { this._paintBorderDrop(); return; }
    if (key === 'fx') return;                     // a list of actions, nothing to mark
    if (key === 'link') {
      // Prefilled from the active cell every time it opens (SPEC 23.4), except while
      // the user is actually typing in it — a repaint mid-edit must not eat the URL.
      if (this._linkInput && document.activeElement !== this._linkInput) {
        this._linkInput.value = this.state.link || '';
      }
      return;
    }
    if (key === 'fxlist') { this._filterFx(); return; }   // rows follow the search box
    // '' marks nothing, which is exactly right for a `va`/`wrap` the cell does not carry
    // (SPEC 22.1/22.4): no row may claim to be the active choice when none was made. It
    // is also what the size menu does at DEFAULT_FONT_SIZE, which is not in FONT_SIZES.
    let current = '';
    if (key === 'font') current = this.state.ff;
    else if (key === 'size') current = String(this.state.fs);
    else if (key === 'valign') current = this.state.va;
    else if (key === 'wrap') current = this.state.wrap;
    else if (key === 'rotate') current = this.state.rot;
    else if (key === 'zoom') current = String(this.state.zoom);
    for (const item of this._dropItems(key)) {
      const on = item.dataset.value === current;
      item.classList.toggle('sz-tb-btn-active', on);
      item.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  /**
   * The picker's sub-controls. Until the user touches one of them they follow the
   * active cell's own border, so opening the picker over a red dashed cell offers
   * a red dashed edge; after that the user's explicit choice sticks.
   */
  _paintBorderDrop() {
    if (!this._borderTouched) {
      const seeded = firstBorderEdge(this.state.bd);
      if (seeded) this._borderEdge = seeded;
    }
    const edge = this._borderEdge;
    const mark = (btns, value) => {
      if (!btns) return;
      for (const b of btns) {
        const on = b.dataset.value === String(value);
        b.classList.toggle('sz-tb-btn-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    };
    mark(this._bdWidthBtns, edge.w);
    mark(this._bdStyleBtns, edge.s);
    if (this._bdColorInput) this._bdColorInput.value = edge.c;
  }

  _stepSize(dir) {
    const next = stepFontSize(this.state.fs, dir);
    if (next === this.state.fs) return;   // clamped at an end of FONT_SIZES
    this.emit('fontsize:' + next, next);
  }

  // ---------------------------------------------------------------- painting

  /**
   * Reflect the host's view of the selection into the toolbar.
   * Every key is optional; omitted keys keep their previous value.
   */
  setState(next = {}) {
    const s = next && typeof next === 'object' ? next : {};
    if ('style' in s) this.state.style = (s.style && typeof s.style === 'object') ? s.style : {};
    if ('value' in s) this.state.value = s.value == null ? '' : String(s.value);
    if ('formula' in s) this.state.formula = s.formula == null ? '' : String(s.formula);
    if ('selectionLabel' in s) {
      this.state.selectionLabel = s.selectionLabel == null ? '' : String(s.selectionLabel);
    }
    if ('stats' in s) this.state.stats = (s.stats && typeof s.stats === 'object') ? s.stats : null;
    if ('merged' in s) this.state.merged = !!s.merged;

    const style = this.state.style;

    // SPEC 22.4 — the six cell-formatting values. An explicit key wins; when only
    // `style` is supplied the value is read off that object instead, so a host that
    // has not been taught the new keys still gets correct controls. Everything is
    // normalised here, once, so no painter downstream has to re-validate.
    const hasStyle = 'style' in s;
    const src = (key) => ((key in s) ? s[key] : (hasStyle ? style[key] : undefined));
    if ('ff' in s || hasStyle) this.state.ff = normFontId(src('ff'));
    if ('fs' in s || hasStyle) this.state.fs = normFontSize(src('fs'));
    if ('va' in s || hasStyle) this.state.va = normStyleChoice(src('va'), VALIGN_ITEMS);
    if ('wrap' in s || hasStyle) this.state.wrap = normStyleChoice(src('wrap'), WRAP_ITEMS);
    if ('rot' in s || hasStyle) this.state.rot = normRotation(src('rot'));
    if ('bd' in s || hasStyle) {
      const bd = src('bd');
      this.state.bd = (bd && typeof bd === 'object') ? bd : null;
    }

    // SPEC 23 — the tools' state. Unlike the six above, none of these lives in the
    // cell style, so there is nothing to fall back to: an absent key keeps the value
    // the toolbar already had.
    if ('painting' in s) this.state.painting = !!s.painting;
    if ('zoom' in s) this.state.zoom = normZoom(s.zoom);
    if ('link' in s) {
      this.state.link = (typeof s.link === 'string' && s.link.trim()) ? s.link.trim() : null;
    }

    // SPEC 24 — the data features. Three plain booleans; like the tools above, an
    // absent key keeps whatever the toolbar already had.
    if ('filtered' in s) this.state.filtered = !!s.filtered;
    if ('hasChart' in s) this.state.hasChart = !!s.hasChart;
    if ('hasComment' in s) this.state.hasComment = !!s.hasComment;

    this._press('bold', !!style.b);
    this._press('italic', !!style.i);
    this._press('underline', !!style.u);
    this._press('strike', !!style.s);

    this._press('align:left', style.align === 'left');
    this._press('align:center', style.align === 'center');
    this._press('align:right', style.align === 'right');

    const fmt = typeof style.fmt === 'string' ? style.fmt : 'general';
    for (const key of ['general', 'number', 'currency', 'percent', 'date', 'text']) {
      this._press('fmt:' + key, fmt === key);
    }

    if (this._fgBar) this._fgBar.setAttribute('fill', normHex(style.fg) || '#202124');
    if (this._bgBar) this._bgBar.setAttribute('fill', normHex(style.bg) || '#ffff00');

    this._paintMerge();
    this._paintFormat();
    this._paintTools();
    this._paintData();

    if (document.activeElement !== this.namebox && !this._namePending) {
      this.namebox.value = this.state.selectionLabel;
    }
    if (document.activeElement !== this.finput) {
      this.finput.value = this.state.formula;
    }

    this._paintStats();
  }

  _press(cmd, on) {
    const b = this._btns.get(cmd);
    if (!b) return;
    b.classList.toggle('sz-tb-btn-active', !!on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  /**
   * The main merge button is a toggle: over a selection that already contains a
   * merge it offers 병합 해제, otherwise 셀 병합. The icon is only rewritten when
   * the mode actually changes, so a repaint per selection move costs nothing.
   */
  _paintMerge() {
    const btn = this._mergeBtn;
    if (!btn) return;
    const merged = !!this.state.merged;
    const label = merged ? '병합 해제' : '셀 병합';
    const wantIcon = merged ? 'mergeOff' : 'mergeAll';
    if (this._mergeIcon !== wantIcon) {
      this._mergeIcon = wantIcon;
      btn.innerHTML = ico(ICONS[wantIcon] || '');
    }
    if (btn.title !== label) {
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
    this._press('@merge:main', merged);
  }

  /**
   * The six cell-formatting controls (SPEC 22.4): each shows the value in force on
   * the active cell. Icons and titles are only rewritten when the choice actually
   * changes, so a repaint per selection move costs nothing.
   */
  _paintFormat() {
    const fontLabel = FONT_LABELS[this.state.ff] || FONT_LABELS.default;
    if (this._fontLabel) this._fontLabel.textContent = fontLabel;
    this._retitle(this._fontBtn, '글꼴: ' + fontLabel);

    if (this._sizeLabel) this._sizeLabel.textContent = String(this.state.fs);
    this._retitle(this._sizeBtn, '글꼴 크기: ' + this.state.fs);

    // The last argument is what the cell renders as when the key is ABSENT (SPEC 22.1):
    // a cell with no `va` is centred, not bottom-aligned, and one with no `wrap` clips,
    // not overflows. `rot` needs none — an absent rotation really is 기울임 없음.
    this._paintChoiceBtn('_valignBtn', '_valignIcon', VALIGN_ITEMS, this.state.va, '세로 정렬', 'middle');
    this._paintChoiceBtn('_wrapBtn', '_wrapIcon', WRAP_ITEMS, this.state.wrap, '텍스트 줄바꿈', 'clip');
    this._paintChoiceBtn('_rotateBtn', '_rotateIcon', ROTATE_ITEMS, this.state.rot, '텍스트 회전');

    // The border button lights up — and says so — when the active cell carries one.
    this._retitle(this._borderBtn, this.state.bd ? '테두리 (적용됨)' : '테두리');
    this._press('@drop:border', !!this.state.bd);

    if (this._dropKey) this._paintDrop(this._dropKey);   // an open panel follows too
  }

  /**
   * The five tools (SPEC 23). The painter button is a real toggle, the zoom button
   * always reads the zoom in force, and the link button says whether the active cell
   * already has one — that is the only place a user can see it without clicking.
   */
  _paintTools() {
    this._press('painter:toggle', this.state.painting);
    this._retitle(this._painterBtn, this.state.painting
      ? '서식 복사 중 (Esc로 해제)'
      : '서식 복사 (두 번 클릭하면 계속 적용)');

    const zoom = this.state.zoom;
    if (this._zoomLabel) this._zoomLabel.textContent = zoom + '%';
    this._retitle(this._zoomBtn, '확대/축소: ' + zoom + '%');

    // The icon stays the same either way — a slashed chain would read as "remove the
    // link", which is what 제거 inside the panel does, not what the button does. The
    // pressed state and the title carry the difference instead.
    const linked = !!this.state.link;
    this._retitle(this._linkBtn, linked ? '링크 편집' : '링크 삽입');
    this._press('@drop:link', linked);
  }

  /**
   * The three data features (SPEC 24). 필터 is a real toggle and swaps both its icon
   * and its label; 차트 and 댓글 only light up to say that the sheet — or, for 댓글, the
   * active cell — already carries one, which is the only way to see that without
   * opening the panel. Icons are rewritten only when the mode actually changes, so a
   * repaint per selection move costs nothing.
   */
  _paintData() {
    const filtered = !!this.state.filtered;
    const filterLabel = filtered ? '필터 끄기' : '필터 만들기';
    const wantIcon = filtered ? 'filterOff' : 'filter';
    if (this._filterBtn && this._filterIcon !== wantIcon) {
      this._filterIcon = wantIcon;
      this._filterBtn.innerHTML = ico(ICONS[wantIcon] || '');
    }
    this._retitle(this._filterBtn, filterLabel);
    this._press(FILTER_MAIN_CMD, filtered);

    this._retitle(this._chartBtn, this.state.hasChart ? '차트 삽입 (이 시트에 차트 있음)' : '차트 삽입');
    this._press('chart:add', this.state.hasChart);

    this._retitle(this._commentBtn, this.state.hasComment ? '댓글 열기' : '댓글 추가');
    this._press('comment:add', this.state.hasComment);
  }

  /** Retitle a button (title + aria-label) only when the text really changed. */
  _retitle(btn, title) {
    if (!btn || btn.title === title) return;
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }

  /**
   * Paint one choice dropdown's button as the item it currently stands for.
   *
   * `value` may be '' — the cell has chosen nothing (see `normStyleChoice`). The button
   * still has to show SOMETHING, so `renderedAs` names the item whose icon matches what
   * the cell actually renders as (SPEC 22.1's ABSENT column: centred for `va`, clipped
   * for `wrap`), and the title says 기본값 so the icon is never read as a choice the user
   * made. Controls whose absent state IS a member of their list pass no `renderedAs` and
   * fall back to the first item, which is what they did before.
   *
   * @param {string} btnField     field holding the button node
   * @param {string} iconField    field caching the icon key painted on it
   * @param {Array<Array>} items  [value, label, iconKey] triples
   * @param {string} value        the value in force, or '' for none
   * @param {string} prefix       the control's name, e.g. '세로 정렬'
   * @param {string} [renderedAs] the item to borrow icon and label from when value is ''
   */
  _paintChoiceBtn(btnField, iconField, items, value, prefix, renderedAs) {
    const btn = this[btnField];
    if (!btn) return;
    const entry = itemOf(items, value);
    const shown = entry || (renderedAs ? itemOf(items, renderedAs) : null) || items[0];
    if (this[iconField] !== shown[2]) {
      this[iconField] = shown[2];
      btn.innerHTML = ico(ICONS[shown[2]] || '');
    }
    this._retitle(btn, entry
      ? prefix + ': ' + entry[1]
      : prefix + ': 기본값 (' + shown[1] + ')');
  }

  _paintStats() {
    const st = this.state.stats;
    if (!st || !st.count) {
      this.statsEl.textContent = '';
      return;
    }
    const avg = typeof st.avg === 'number' ? st.avg : (st.count ? st.sum / st.count : 0);
    this.statsEl.textContent =
      '합계 ' + statNum(st.sum) + '  ·  평균 ' + statNum(avg) + '  ·  개수 ' + statNum(st.count);
  }

  /** Detach global listeners and the popover (index.html never calls this, but
   *  a host that rebuilds the shell should). */
  destroy() {
    document.removeEventListener('mousedown', this._onDocDown, true);
    document.removeEventListener('keydown', this._onDocKey, true);
    window.removeEventListener('resize', this._onReflow);
    window.removeEventListener('scroll', this._onReflow, true);
    if (this._pop && this._pop.parentNode) this._pop.parentNode.removeChild(this._pop);
    this._pop = null;
    if (this._menu && this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
    this._menu = null;
    this._menuOpen = false;
    this._menuItems = [];
    this._mergeBtn = null;
    this._mergeCaret = null;
    for (const entry of this._drops.values()) {
      if (entry.panel && entry.panel.parentNode) entry.panel.parentNode.removeChild(entry.panel);
    }
    this._drops.clear();
    this._dropKey = '';
    this._fontBtn = null;
    this._fontLabel = null;
    this._sizeBtn = null;
    this._sizeLabel = null;
    this._borderBtn = null;
    this._valignBtn = null;
    this._wrapBtn = null;
    this._rotateBtn = null;
    this._bdWidthBtns = null;
    this._bdStyleBtns = null;
    this._bdColorInput = null;
    // Tools, SPEC 23. Their panels are .sz-tb-drop entries, so the loop above has
    // already removed them; only the references are left to drop.
    this._painterBtn = null;
    this._zoomBtn = null;
    this._zoomLabel = null;
    this._printBtn = null;
    this._linkBtn = null;
    this._linkInput = null;
    this._fxBtn = null;
    this._fxCaret = null;
    this._fxSearch = null;
    this._fxRows = [];
    this._fxEmpty = null;
    // Data features, SPEC 24. Plain buttons with no panel of their own: only the
    // references are left to drop.
    this._filterBtn = null;
    this._filterIcon = '';
    this._chartBtn = null;
    this._commentBtn = null;
    this._btns.clear();
    this.root.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// GrowBar — 맨 아래에 행 추가 / 오른쪽에 열 추가 (SPEC 25.4)
// ---------------------------------------------------------------------------
//
// A sheet starts at 200 x 26 and may grow to 5000 x 702. The grid grows one on its
// own when the user reaches its edge (SPEC 25.3); this is the deliberate way to ask
// for a lot at once, and the place the limit is stated out loud when it is reached.
//
// It is a pure view, exactly like the Toolbar above: it reports intent through
// onCommand(name, count) and paints whatever setState() hands it. It does not know
// what a document is, it never touches the engine, and — importantly — it does not
// grow anything itself. The host owns growSheet(); this control only asks.
//
// Two decisions worth stating:
//
//   * The count is capped at what REMAINS, not at the maximum. A 4900-row sheet
//     offers at most 100, so the number on screen is always a number the sheet can
//     actually accept. The host clamps again (growSheet() does the same arithmetic
//     from the document itself), so a hand-edited DOM buys nothing.
//   * At the limit the group's children are REPLACED by the 최대 크기입니다 message
//     rather than merely disabled. A disabled control still invites a click; a
//     sentence explains why there is nothing to click.

/** The exact words SPEC 25.4 asks a maxed-out control to read. */
const GROW_MAX_TEXT = '최대 크기입니다';

/** Makes each count field's id unique, so a second GrowBar could never collide. */
let growSeq = 0;

/** The two axes, in the order the spec lists them. */
const GROW_AXES = [
  {
    key: 'rows', cmd: 'grow:rows', cls: 'sz-grow-rows',
    lead: '맨 아래에 행', tail: '개 추가', unit: '행',
    step: ROW_GROW_STEP, start: DEFAULT_ROWS, limit: MAX_ROWS,
    action: '맨 아래에 행 추가', countLabel: '추가할 행 수',
  },
  {
    key: 'cols', cmd: 'grow:cols', cls: 'sz-grow-cols',
    lead: '오른쪽에 열', tail: '개 추가', unit: '열',
    step: COL_GROW_STEP, start: DEFAULT_COLS, limit: MAX_COLS,
    action: '오른쪽에 열 추가', countLabel: '추가할 열 수',
  },
];

/**
 * A positive whole number, or `fallback` for anything else — undefined, null, NaN,
 * a negative number, '1e9', the empty string a cleared input reports. Every number
 * this control shows or emits goes through it, so nothing downstream ever has to
 * defend itself against the contents of a text field.
 */
function growInt(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

export class GrowBar {
  /**
   * @param {HTMLElement} root  the element index.html supplies as #sz-grow-root
   * @param {{onCommand?: (name: string, count: number) => void}} [options]
   *   onCommand('grow:rows' | 'grow:cols', count) — count is a positive integer,
   *   already clamped to what remains before the maximum.
   */
  constructor(root, options = {}) {
    if (!root || typeof root.appendChild !== 'function') {
      throw new TypeError('GrowBar: 컨트롤을 붙일 root 엘리먼트가 필요합니다');
    }
    this.root = root;
    this.onCommand = typeof options.onCommand === 'function' ? options.onCommand : () => {};

    /** The extent on screen and the ceiling it may grow to. */
    this.state = {
      rows: DEFAULT_ROWS,
      cols: DEFAULT_COLS,
      maxRows: MAX_ROWS,
      maxCols: MAX_COLS,
    };

    /** @type {Map<string, object>} axis key -> its nodes and view state */
    this._axes = new Map();
    /** True when _build() added the .sz-grow class, so destroy() can take it back. */
    this._addedClass = false;

    injectFallbackCss();
    this._build();
    this.setState(this.state);
  }

  // ------------------------------------------------------------------ build

  _build() {
    this.root.textContent = '';
    // The root IS the strip when the host page already marked it as one (index.html
    // does), so mounting here cannot produce two nested .sz-grow boxes.
    if (!this.root.classList.contains('sz-grow')) {
      this.root.classList.add('sz-grow');
      this._addedClass = true;
    }
    this.el = this.root;
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', '시트 크기 늘리기');
    for (const axis of GROW_AXES) this.el.appendChild(this._buildAxis(axis));
  }

  /** One axis: 맨 아래에 행 [1000] 개 추가. */
  _buildAxis(axis) {
    const box = document.createElement('div');
    box.className = axis.cls;

    // A real <label>, not a <span>: clicking 맨 아래에 행 then focuses the number,
    // which is the behaviour anyone expects from a label sitting against a field.
    const fieldId = 'sz-grow-count-' + axis.key + '-' + (++growSeq);
    const lead = document.createElement('label');
    lead.className = 'sz-grow-lead';
    lead.textContent = axis.lead;
    lead.htmlFor = fieldId;

    const input = document.createElement('input');
    input.id = fieldId;
    input.type = 'number';
    input.className = 'sz-grow-input';
    input.min = '1';
    input.step = '1';
    input.value = String(axis.step);
    input.autocomplete = 'off';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', axis.countLabel);
    input.addEventListener('keydown', (ev) => {
      // The editor listens for keys on `document`; a digit typed here must not also
      // reach the grid, and Enter here means "add", not "move down a cell".
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this._submit(axis.key);
      } else if (ev.key === 'Escape' || ev.key === 'Esc') {
        ev.preventDefault();
        const entry = this._axes.get(axis.key);
        if (entry) entry.touched = false;      // back to the default step
        this._paint();
        input.blur();
      }
    });
    const touch = () => {
      const entry = this._axes.get(axis.key);
      if (entry) entry.touched = true;
    };
    input.addEventListener('input', touch);
    input.addEventListener('change', () => { touch(); this._clamp(axis.key); });
    input.addEventListener('blur', () => this._clamp(axis.key));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sz-grow-btn';
    btn.textContent = axis.tail;
    btn.title = axis.action;
    btn.setAttribute('aria-label', axis.action);
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      this._submit(axis.key);
    });

    const max = document.createElement('span');
    max.className = 'sz-grow-max';
    max.textContent = GROW_MAX_TEXT;

    // `mode` is what is currently in the box: 'grow' (lead + input + button) or
    // 'max' (the message). _paint() only rebuilds when it changes, so repainting
    // on every cursor move never steals focus from a half-typed number.
    this._axes.set(axis.key, { axis, box, lead, input, btn, max, mode: '', touched: false });
    return box;
  }

  // ----------------------------------------------------------------- numbers

  /** The ceiling for one axis: what the host asked for, never above the engine's. */
  _limit(key) {
    const axis = key === 'cols' ? GROW_AXES[1] : GROW_AXES[0];
    const want = growInt(key === 'cols' ? this.state.maxCols : this.state.maxRows, axis.limit);
    return Math.min(want, axis.limit);
  }

  /** How many more rows / columns this sheet may still be given. */
  _remaining(key) {
    const current = growInt(key === 'cols' ? this.state.cols : this.state.rows, 1);
    return Math.max(0, this._limit(key) - current);
  }

  /**
   * Read the input, clamp it into 1..remaining, write the clamped value back.
   * @returns {number} the clamped count (0 when the axis is already at its limit)
   */
  _clamp(key) {
    const entry = this._axes.get(key);
    if (!entry) return 0;
    const remaining = this._remaining(key);
    if (remaining <= 0) return 0;
    const want = entry.touched
      ? growInt(entry.input.value, Math.min(entry.axis.step, remaining))
      : Math.min(entry.axis.step, remaining);
    const count = Math.min(want, remaining);
    const text = String(count);
    if (entry.input.value !== text) entry.input.value = text;
    return count;
  }

  // ------------------------------------------------------------------ events

  emit(name, payload) {
    try {
      this.onCommand(name, payload);
    } catch (e) {
      console.error('[growbar] 명령 처리 실패: ' + name, e);
    }
  }

  _submit(key) {
    const entry = this._axes.get(key);
    if (!entry) return;
    const count = this._clamp(key);
    if (count <= 0) return;               // at the limit: the message says so already
    this.emit(entry.axis.cmd, count);
  }

  // ------------------------------------------------------------------- paint

  /**
   * @param {{rows?:number, cols?:number, maxRows?:number, maxCols?:number}} next
   */
  setState(next) {
    if (next && typeof next === 'object') {
      const s = this.state;
      if (next.rows !== undefined) s.rows = growInt(next.rows, s.rows);
      if (next.cols !== undefined) s.cols = growInt(next.cols, s.cols);
      if (next.maxRows !== undefined) s.maxRows = growInt(next.maxRows, s.maxRows);
      if (next.maxCols !== undefined) s.maxCols = growInt(next.maxCols, s.maxCols);
    }
    this._paint();
  }

  _paint() {
    for (const entry of this._axes.values()) {
      const { axis, box, input, btn, max } = entry;
      const remaining = this._remaining(axis.key);
      const mode = remaining > 0 ? 'grow' : 'max';
      if (entry.mode !== mode) {
        entry.mode = mode;
        box.textContent = '';
        if (mode === 'grow') {
          box.appendChild(entry.lead);
          box.appendChild(input);
          box.appendChild(btn);
        } else {
          box.appendChild(max);
        }
      }
      if (mode === 'max') {
        max.title = axis.unit + ' 수가 최대치인 ' + this._limit(axis.key) + axis.unit
          + '에 도달했습니다.';
        continue;
      }
      input.max = String(remaining);
      input.disabled = false;
      btn.disabled = false;
      btn.title = axis.action + ' (최대 ' + remaining + axis.unit + ')';
      // Never rewrite the field the user is typing into; the commit clamps it anyway.
      if (document.activeElement !== input) this._clamp(axis.key);
    }
  }

  /** Drop every node this control built and the class it added to the root. */
  destroy() {
    for (const entry of this._axes.values()) {
      entry.mode = '';
      entry.touched = false;
    }
    this._axes.clear();
    this.root.textContent = '';
    this.root.removeAttribute('role');
    this.root.removeAttribute('aria-label');
    if (this._addedClass) {
      this.root.classList.remove('sz-grow');
      this._addedClass = false;
    }
    this.el = null;
  }
}

export default Toolbar;
