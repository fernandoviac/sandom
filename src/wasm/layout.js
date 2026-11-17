// Memory layout — the contract between JS and WASM.
//
// Sandom uses a single shared WebAssembly.Memory. JS creates it and
// passes it to the WAT module as an import. Both sides read and write
// specific regions; this file defines where each region lives.
//
// The engine's WAT globals are the source of each layout constant: the
// build writes them into the custom section "sandom.layout" of
// renderer-core.wasm, and layoutConstant() reads a constant from it (a
// missing name throws).
//
// Adding or changing a layout value: edit the engine global, then build
// (core/tools/build-wasm.js).
import { layoutConstant } from "./layout-table.js";

// =======================================================================
// Page budget
// =======================================================================
//
// Initial: 16 pages = 1 MB. Enough for moderate documents.
// Maximum: 4096 pages = 256 MB. Room for large DOMs with many elements.
//
// The layout buffer and command buffer can grow by bumping into the
// growable region. memory.grow extends the WASM memory when needed.

export const INITIAL_PAGES = layoutConstant("INITIAL_PAGES");
// One shared memory for engine, HarfBuzz and DOM core (design/memory-map.md).
// Every address the DOM allocator hands out stays below 2^31 at this maximum.
export const MAX_PAGES = layoutConstant("MAX_PAGES");

// =======================================================================
// Header (64 bytes at 0x0)
// =======================================================================
//
// Magic number, version, and global state.

export const HEADER_BASE = layoutConstant("HEADER_BASE");
export const HEADER_SIZE = layoutConstant("HEADER_SIZE");

export const HEADER_OFFSET_MAGIC = layoutConstant("HEADER_OFFSET_MAGIC"); // u32: 0x53444D00 "SDM\0"
export const HEADER_OFFSET_VERSION = layoutConstant("HEADER_OFFSET_VERSION"); // u32: layout version
export const HEADER_OFFSET_FLAGS = layoutConstant("HEADER_OFFSET_FLAGS"); // u32: global flags
export const HEADER_OFFSET_GENERATION = layoutConstant("HEADER_GENERATION"); // u32: current change-tracking
// generation (see design/layout-engine.md). engine.wat owns advancement for
// JavaScript mutations and WebAssembly animation ticks. Ordinary advances are
// O(1). Before wrap, the engine starts a fresh nonzero epoch and invalidates
// every generation-keyed cache. Generation 0 means "never computed".

export const MAGIC = layoutConstant("MAGIC"); // "SDM\0" little-endian
export const VERSION = layoutConstant("VERSION");

// =======================================================================
// Tile dirty map (1 KB at 0x40)
// =======================================================================
//
// One bit per tile. Both JS and WASM read/write this region.
// JS sets bits when DOM mutations affect a tile's bounding area.
// WASM sets additional bits during command buffer diffing.
// The rasterizer reads it to know which tiles to re-draw.
//
// 1 KB = 8192 bits = supports up to 8192 tiles.
// At 64x64 pixel tiles on a 4K framebuffer (3840x2160):
//   60 x 34 = 2040 tiles. Well within budget.
// At 128x128: 30 x 17 = 510 tiles.

export const TILE_DIRTY_MAP_BASE = layoutConstant("TILE_DIRTY_MAP_BASE");
export const TILE_DIRTY_MAP_SIZE = layoutConstant("TILE_DIRTY_MAP_SIZE"); // 1 KB

// Tile grid parameters — written by JS before each emission, read by WASM.
// Stored right after the dirty map. The grid is the raster target's: the
// tile side is in device pixels, and the engine maps each CSS px box to
// device pixels with the device scale and the target's CSS px origin.

export const TILE_CONFIG_BASE = layoutConstant("TILE_CONFIG_BASE");
export const TILE_CONFIG_SIZE = layoutConstant("TILE_CONFIG_SIZE"); // 32 bytes

export const TILE_CONFIG_OFFSET_TILE_SIZE = layoutConstant("TILE_CONFIG_OFFSET_TILE_SIZE"); // u32: device pixels per tile side (a multiple of 64)
export const TILE_CONFIG_OFFSET_COLUMNS = layoutConstant("TILE_CONFIG_OFFSET_COLUMNS"); // u32: tiles across
export const TILE_CONFIG_OFFSET_ROWS = layoutConstant("TILE_CONFIG_OFFSET_ROWS"); // u32: tiles down
export const TILE_CONFIG_OFFSET_FRAME_WIDTH = layoutConstant("TILE_CONFIG_OFFSET_FRAME_WIDTH"); // u32: scene width in CSS pixels
export const TILE_CONFIG_OFFSET_FRAME_HEIGHT = layoutConstant("TILE_CONFIG_OFFSET_FRAME_HEIGHT"); // u32: scene height in CSS pixels
export const TILE_CONFIG_OFFSET_DEVICE_SCALE = layoutConstant("TILE_CONFIG_OFFSET_DEVICE_SCALE"); // f32: device pixels per CSS pixel
export const TILE_CONFIG_OFFSET_ORIGIN_X = layoutConstant("TILE_CONFIG_OFFSET_ORIGIN_X"); // f32: CSS px x of the raster target in the scene
export const TILE_CONFIG_OFFSET_ORIGIN_Y = layoutConstant("TILE_CONFIG_OFFSET_ORIGIN_Y"); // f32: CSS px y of the raster target in the scene

// =======================================================================
// WASM internal stacks (4 KB at 0x460)
// =======================================================================
//
// Used by the WAT module during tree walks. Not accessed by JS.
//
// Walk stack: iterative depth-first traversal of the layout buffer.
//   Each entry: (nodeOffset: u32, parentX: f32, parentY: f32,
//                transformPtr: u32) = 16 bytes.
//   256 entries = 4 KB = max tree depth 256.
//
// Clip stack: pushed on pushClip, popped on popClip.
//   Each entry: (enabledX: u8, enabledY: u8, pad: u16,
//                x: f32, y: f32, w: f32, h: f32, radius: f32) = 24 bytes.
//   32 entries = 768 bytes.
//
// Opacity stack: pushed on pushOpacity, popped on popOpacity.
//   Each entry: (x: f32, y: f32, w: f32, h: f32, opacity: f32,
//                hasClip: u32, clipRadius: f32) = 28 bytes.
//   32 entries = 896 bytes.
//
// Transform scratch: temporary space for matrix multiplication results.
//   4 matrices × 24 bytes = 96 bytes.
//
// All stacks fit within 4 KB with headroom.

export const INTERNAL_STACKS_BASE = layoutConstant("INTERNAL_STACKS_BASE");
export const INTERNAL_STACKS_SIZE = layoutConstant("INTERNAL_STACKS_SIZE"); // 4 KB

export const WALK_STACK_BASE = layoutConstant("WALK_STACK_BASE");
export const WALK_STACK_SIZE = layoutConstant("WALK_STACK_SIZE"); // 4 KB, 256 entries × 16 bytes
export const WALK_STACK_ENTRY = layoutConstant("WALK_STACK_ENTRY");
export const WALK_STACK_MAX = layoutConstant("WALK_STACK_MAX");

// (The pre-P1 CLIP_STACK region that used to live at 0x1460 — 24-byte
// single-radius entries — was dead weight: nothing but its own export ever
// referenced it. Deleted by the oriented-clip redesign; clip state now
// lives in CLIP_ARENA, see its section near the end of the fixed regions.
// The 768-byte hole at 0x1460 is left unassigned rather than shifting
// every later region for no benefit.)

export const OPACITY_STACK_BASE = layoutConstant("OPACITY_STACK_BASE");
export const OPACITY_STACK_SIZE = layoutConstant("OPACITY_STACK_SIZE"); // 896 bytes, 32 entries × 28 bytes
export const OPACITY_STACK_ENTRY = layoutConstant("OPACITY_STACK_ENTRY");
export const OPACITY_STACK_MAX = layoutConstant("OPACITY_STACK_MAX");

export const TRANSFORM_SCRATCH_BASE = layoutConstant("TRANSFORM_SCRATCH_BASE");
export const TRANSFORM_SCRATCH_SIZE = layoutConstant("TRANSFORM_SCRATCH_SIZE"); // 96 bytes, 4 × 24 bytes

// =======================================================================
// Batch descriptors (4 KB at 0x1B40)
// =======================================================================
//
// Written by WASM during command emission, read by JS rasterizer.
// Each descriptor: (type: u8, pad: u8, pad: u16,
//                   commandOffset: u32, commandCount: u32) = 12 bytes.
// 340 descriptors = 4080 bytes.
//
// A batch is a run of consecutive same-type commands between state
// changes (clip/opacity pushes/pops). The rasterizer iterates
// descriptors instead of scanning the command buffer.

export const BATCH_DESCRIPTORS_BASE = layoutConstant("BATCH_DESCRIPTORS_BASE");
export const BATCH_DESCRIPTORS_SIZE = layoutConstant("BATCH_DESCRIPTORS_SIZE"); // 4 KB
export const BATCH_DESCRIPTOR_ENTRY = layoutConstant("BATCH_DESCRIPTOR_ENTRY");
export const BATCH_DESCRIPTOR_MAX = layoutConstant("BATCH_DESCRIPTOR_MAX");

export const BATCH_OFFSET_TYPE = layoutConstant("BATCH_OFFSET_TYPE"); // u8: command type (opcode)
export const BATCH_OFFSET_COMMAND_START = layoutConstant("BATCH_OFFSET_COMMAND_START"); // u32: byte offset into command buffer
export const BATCH_OFFSET_COMMAND_COUNT = layoutConstant("BATCH_OFFSET_COMMAND_COUNT"); // u32: number of commands in batch

// =======================================================================
// Layout buffer (2,182 fixed-size records at 0x2B40 initially; grows)
// =======================================================================
//
// The serialized DOM tree. Written by JS, read by WASM.
// Each node is a fixed-size record (see LAYOUT_NODE_* constants below).
// The buffer is a flat array of nodes in depth-first pre-order.
//
// This region is the INITIAL map only (2,182 records; the node-indexed side
// tables below hold 2,251 rows, more than the buffer). A scene with more
// nodes makes the engine move this buffer and every node-indexed side
// table (computed, pristine, table-grid and previous painted boxes,
// subtree info, layout cache, scroll table, emission history, scope
// flags, scroll data, the collapsed-border arena) into one block from
// the shared allocator, at least doubling (engine.wat
// node_tables_reserve). Hosts read the live bases from the engine
// (layout_buffer_base() and the other accessors) after every reservation.
// The composed engine synchronizes DOM table addresses natively; these
// constants describe the initial map that the build checks, never a live address.
export const LAYOUT_BUFFER_BASE = layoutConstant("LAYOUT_BUFFER_BASE");
export const LAYOUT_BUFFER_SIZE = layoutConstant("LAYOUT_BUFFER_SIZE"); // 1,697 nodes * 1,008 B (initial)

// --- Layout node record (LAYOUT_NODE_SIZE bytes) — STYLE ONLY (Slice 2) ---
//
// As of Slice 2 the node struct carries *style* (the input to layout), not
// geometry. The layout pass COMPUTES x/y/width/height into the computed-box
// buffer; they are no longer caller inputs. (See design/layout-engine.md,
// "Three roles, three buffers".)
//
// Sizes are tagged: a 1-byte tag selects how the f32 value is interpreted.
//   width/height tag:  0 = auto, 1 = length (px), 2 = percent (of CB)
//   min tag:           0 = auto/zero, 1 = length, 2 = percent
//   max tag:           0 = none, 1 = length, 2 = percent
// Margins are plain f32 px; an `auto` margin stores 0 and sets its edge bit
// in LAYOUT_NODE_OFFSET_MARGIN_AUTO (see MARGIN_AUTO_*).

// P0 (node-struct stride bump 320->640, design/paint-coverage.md): grown to
// lay out ALL new fixed-size node fields declared across the SVG work,
// plans/layout/PLAN-layout-grid.md, plans/layout/PLAN-layout-tables.md, the inline formatting work,
// the floats work, plans/layout/PLAN-layout-remaining.md (aspect-ratio), and
// design/paint-coverage.md's own P3-P10, in one pass — see the block below
// starting at LAYOUT_NODE_OFFSET_HAS_Z for the full new layout. Existing
// fields at 0x000-0x127 are UNCHANGED (zero behavior change is the
// acceptance bar for this slice; verified via full-suite byte-identical
// pixel output).
//
// S5 (stride 640->648, SVG): +8 bytes for
// LAYOUT_NODE_OFFSET_SVG_STROKE_PATH_INDEX (see that field's own
// comment, near CHANGED_GEN below, for why this was a genuine stride
// bump rather than aliasing an existing field's bytes). This is the
// FIRST new fixed-size field needed since P0 — every field added
// between P0 and S5 (P5b/P5c/P9/P10) fit inside P0's own reserved
// headroom without a further bump.
//
// P4 step 3 (stride 648->672, design/paint-coverage.md): +24 bytes for
// radial/conic gradient center position (BG_CENTER_X/Y_TAG + BG_CENTER_
// X/Y) and radial's own shape/size-keyword/explicit-radii fields — see
// LAYOUT_NODE_OFFSET_BG_CENTER_X_TAG's own comment for the full
// rationale (no safe alias existed; the free tail sits on the wrong side
// of CHANGED_GEN for session.js's write-if-changed diffing).
//
// The tail 0x2F8..0x2FF holds orphans (0x2F8) and widows (0x2F9) (see
// LAYOUT_NODE_OFFSET_ORPHANS), an SVG shape's currentcolor paint bits
// (0x2FA, LAYOUT_NODE_OFFSET_SVG_PAINT_CURRENT_COLOR), line-break and
// word-break (0x2FB, LAYOUT_NODE_OFFSET_LINE_BREAK) and the paint-only
// generation, a u32 at 0x2FC..0x2FF (LAYOUT_NODE_OFFSET_PAINT_GEN).
// 0x300..0x308 hold text-indent (LAYOUT_NODE_OFFSET_TEXT_INDENT); 0x309
// the page-margin box (LAYOUT_NODE_OFFSET_PAGE_MARGIN); 0x30A the page
// name (LAYOUT_NODE_OFFSET_PAGE_NAME); 0x30C text-align-last and
// text-justify (LAYOUT_NODE_OFFSET_TEXT_JUSTIFICATION); 0x30D the line
// clamp (LAYOUT_NODE_OFFSET_LINE_CLAMP); 0x30E the quirks-mode fill
// (LAYOUT_NODE_OFFSET_QUIRKS_FILL); 0x30F whether the box contains fixed
// boxes (LAYOUT_NODE_OFFSET_CONTAINS_FIXED). 0x310..0x32C hold
// the individual transform properties
// (LAYOUT_NODE_OFFSET_INDIVIDUAL_TRANSLATE); 0x32D the top layer
// (LAYOUT_NODE_OFFSET_TOP_LAYER); 0x32E the size containment
// (LAYOUT_NODE_OFFSET_SIZE_CONTAINMENT); 0x32F is reserved.
// 0x330..0x37F hold the text paint fields of a DISPLAY_TEXT node
// (LAYOUT_NODE_OFFSET_TEXT_DECORATION_COLORS, TEXT_PAINT_FIELDS_SIZE
// bytes): paint fields, which the DOM core's frame transport and the
// engine's retained classification both read as paint.
// 0x380..0x3AF hold the percentage parts of the margins and paddings
// (LAYOUT_NODE_OFFSET_MARGIN_TOP_PERCENT, LAYOUT_NODE_OFFSET_EDGE_EXPRESSIONS).
// 0x3B0..0x3B8 hold word-spacing and tab-size; 0x3BC..0x3D8 the motion
// path (LAYOUT_NODE_OFFSET_MOTION_PATH, LAYOUT_NODE_OFFSET_MOTION).
// (LAYOUT_NODE_OFFSET_WORD_SPACING, LAYOUT_NODE_OFFSET_TEXT_SPACING_FLAGS).
export const LAYOUT_NODE_SIZE = layoutConstant("NODE_SIZE");

export const LAYOUT_NODE_OFFSET_CHILD_OFFSET = layoutConstant("NODE_CHILD_OFFSET"); // u32: byte offset to first child
export const LAYOUT_NODE_OFFSET_CHILD_COUNT = layoutConstant("NODE_CHILD_COUNT"); // u16: number of children
export const LAYOUT_NODE_OFFSET_FLAGS = layoutConstant("NODE_FLAGS"); // u16: bitfield (see below)

export const LAYOUT_NODE_OFFSET_DISPLAY = layoutConstant("NODE_DISPLAY"); // u8: 0=block, 1=none
export const LAYOUT_NODE_OFFSET_BOX_SIZING = layoutConstant("NODE_BOX_SIZING"); // u8: 0=content-box, 1=border-box
export const LAYOUT_NODE_OFFSET_WIDTH_TAG = layoutConstant("NODE_WIDTH_TAG"); // u8: 0=auto,1=length,2=percent
export const LAYOUT_NODE_OFFSET_HEIGHT_TAG = layoutConstant("NODE_HEIGHT_TAG"); // u8
export const LAYOUT_NODE_OFFSET_MIN_W_TAG = layoutConstant("NODE_MIN_W_TAG"); // u8: 0=zero,1=length,2=percent
export const LAYOUT_NODE_OFFSET_MIN_H_TAG = layoutConstant("NODE_MIN_H_TAG"); // u8
export const LAYOUT_NODE_OFFSET_MAX_W_TAG = layoutConstant("NODE_MAX_W_TAG"); // u8: 0=none,1=length,2=percent
export const LAYOUT_NODE_OFFSET_MAX_H_TAG = layoutConstant("NODE_MAX_H_TAG"); // u8

export const LAYOUT_NODE_OFFSET_WIDTH = layoutConstant("NODE_WIDTH"); // f32: requested width value
export const LAYOUT_NODE_OFFSET_HEIGHT = layoutConstant("NODE_HEIGHT"); // f32: requested height value
export const LAYOUT_NODE_OFFSET_MIN_WIDTH = layoutConstant("NODE_MIN_WIDTH"); // f32
export const LAYOUT_NODE_OFFSET_MIN_HEIGHT = layoutConstant("NODE_MIN_HEIGHT"); // f32
export const LAYOUT_NODE_OFFSET_MAX_WIDTH = layoutConstant("NODE_MAX_WIDTH"); // f32
export const LAYOUT_NODE_OFFSET_MAX_HEIGHT = layoutConstant("NODE_MAX_HEIGHT"); // f32

export const LAYOUT_NODE_OFFSET_MARGIN_TOP = layoutConstant("NODE_MARGIN_TOP"); // f32
export const LAYOUT_NODE_OFFSET_MARGIN_RIGHT = layoutConstant("NODE_MARGIN_RIGHT"); // f32
export const LAYOUT_NODE_OFFSET_MARGIN_BOTTOM = layoutConstant("NODE_MARGIN_BOTTOM"); // f32
export const LAYOUT_NODE_OFFSET_MARGIN_LEFT = layoutConstant("NODE_MARGIN_LEFT"); // f32

export const LAYOUT_NODE_OFFSET_PADDING_TOP = layoutConstant("NODE_PAD_TOP"); // f32
export const LAYOUT_NODE_OFFSET_PADDING_RIGHT = layoutConstant("NODE_PAD_RIGHT"); // f32
export const LAYOUT_NODE_OFFSET_PADDING_BOTTOM = layoutConstant("NODE_PAD_BOTTOM"); // f32
export const LAYOUT_NODE_OFFSET_PADDING_LEFT = layoutConstant("NODE_PAD_LEFT"); // f32
export const LAYOUT_NODE_OFFSET_BORDER_TOP = layoutConstant("NODE_BORDER_TOP"); // f32
export const LAYOUT_NODE_OFFSET_BORDER_RIGHT = layoutConstant("NODE_BORDER_RIGHT"); // f32
export const LAYOUT_NODE_OFFSET_BORDER_BOTTOM = layoutConstant("NODE_BORDER_BOTTOM"); // f32
export const LAYOUT_NODE_OFFSET_BORDER_LEFT = layoutConstant("NODE_BORDER_LEFT"); // f32
export const LAYOUT_NODE_OFFSET_BG_COLOR = layoutConstant("NODE_BG_COLOR"); // f32[4]: rgba
// Border colors, one rgba PER SIDE (Slice P2). A uniform border stores the
// same color in all four slots — the engine and rasterizer only ever read
// the per-side form; the scene-spec's single-color sugar is normalized in
// each writeNode.
export const LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP = layoutConstant("NODE_BORDER_COLOR"); // f32[4]: rgba
export const LAYOUT_NODE_OFFSET_BORDER_COLOR_RIGHT = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_COLOR_RIGHT"); // f32[4]: rgba
export const LAYOUT_NODE_OFFSET_BORDER_COLOR_BOTTOM = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_COLOR_BOTTOM"); // f32[4]: rgba
export const LAYOUT_NODE_OFFSET_BORDER_COLOR_LEFT = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_COLOR_LEFT"); // f32[4]: rgba
// Border radii, one PER CORNER in CSS order (Slice P2); uniform radius is
// normalized to four equal slots in writeNode, same as colors.
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT = layoutConstant("NODE_BORDER_RADIUS"); // f32
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_RIGHT = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_RIGHT"); // f32
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_RIGHT = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_RIGHT"); // f32
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_LEFT = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_LEFT"); // f32
export const LAYOUT_NODE_OFFSET_OPACITY = layoutConstant("NODE_OPACITY"); // f32
export const LAYOUT_NODE_OFFSET_TRANSFORM = layoutConstant("NODE_TRANSFORM"); // f32[6]: affine [a,b,c,d,e,f]
// 0xBC..0xD4 = 24 bytes → ends at 0xD4 = 212

// Positioning (CSS 2.1 §9.3). position + four insets (tagged like sizes:
// 0=auto, 1=length, 2=percent). Absolute boxes are out of normal flow.
export const LAYOUT_NODE_OFFSET_POSITION = layoutConstant("NODE_POSITION"); // u8: 0=static,1=relative,2=absolute
export const LAYOUT_NODE_OFFSET_INSET_TOP_TAG = layoutConstant("NODE_INSET_TOP_TAG"); // u8
export const LAYOUT_NODE_OFFSET_INSET_RIGHT_TAG = layoutConstant("NODE_INSET_RIGHT_TAG"); // u8
export const LAYOUT_NODE_OFFSET_INSET_BOTTOM_TAG = layoutConstant("NODE_INSET_BOTTOM_TAG"); // u8
export const LAYOUT_NODE_OFFSET_INSET_LEFT_TAG = layoutConstant("NODE_INSET_LEFT_TAG"); // u8
// 0xD9 holds COLUMN_SPAN (declared with the multi-column fields below);
// 0xDA holds NATIVE_APPEARANCE (declared with COLUMN_SPAN); 0xDB holds
// EMPTY_CELLS (declared with the table fields).
export const LAYOUT_NODE_OFFSET_INSET_TOP = layoutConstant("NODE_INSET_TOP"); // f32
export const LAYOUT_NODE_OFFSET_INSET_RIGHT = layoutConstant("NODE_INSET_RIGHT"); // f32
export const LAYOUT_NODE_OFFSET_INSET_BOTTOM = layoutConstant("NODE_INSET_BOTTOM"); // f32
export const LAYOUT_NODE_OFFSET_INSET_LEFT = layoutConstant("NODE_INSET_LEFT"); // f32
// style fields end at 0xEC = 236
// Flex (CSS Flexbox §9, Slice 5). Container fields (flex-direction/justify/
// align-items/wrap/gaps) apply when display:flex; item fields (grow/shrink/
// basis/align-self) apply to a flex container's children. All in one block so a
// node can be both (a flex item that is itself a flex container). These are
// STYLE, so they sit BEFORE changedGen (which must be the last field — see
// below — so write-if-changed's [0, CHANGED_GEN) range covers all style).
export const LAYOUT_NODE_OFFSET_FLEX_DIRECTION = layoutConstant("NODE_FLEX_DIRECTION"); // u8: 0=row,1=row-reverse,2=column,3=column-reverse
export const LAYOUT_NODE_OFFSET_JUSTIFY_CONTENT = layoutConstant("NODE_JUSTIFY_CONTENT"); // u8 (see JUSTIFY_*)
export const LAYOUT_NODE_OFFSET_ALIGN_ITEMS = layoutConstant("NODE_ALIGN_ITEMS"); // u8 (see ALIGN_*)
export const LAYOUT_NODE_OFFSET_FLEX_WRAP = layoutConstant("NODE_FLEX_WRAP"); // u8: 0=nowrap,1=wrap,2=wrap-reverse
export const LAYOUT_NODE_OFFSET_ALIGN_SELF = layoutConstant("NODE_ALIGN_SELF"); // u8: 0=auto (use parent align-items), else ALIGN_*+1
export const LAYOUT_NODE_OFFSET_FLEX_BASIS_TAG = layoutConstant("NODE_FLEX_BASIS_TAG"); // u8: 0=auto,1=length,2=percent
// margin-*: auto, one bit per edge. `auto` margins are a LAYOUT input, not a
// length: the block axis needs them for flex §8.1 (cross-axis auto margins
// absorb free space and override align-self) exactly as the inline axis
// needs them for block centring, and FLAGS' 16 bits are all spoken for — so
// all four edges live in this one byte, in CSS edge order. The f32 margin
// value of an auto edge is 0 (writer convention); consumers that distribute
// free space read this mask.
export const LAYOUT_NODE_OFFSET_MARGIN_AUTO = layoutConstant("NODE_MARGIN_AUTO"); // u8 bitmask (see MARGIN_AUTO_*)
// Where a box came from in the flow, for an out-of-flow box's static
// position (css-position 3 §3.5; Blink's PlaceOutOfFlowObjects): an
// anonymous block run (the block holding a container's inline content
// beside its blocks), and an out-of-flow box whose display was
// inline-level before blockification. Such a box sits in the last line
// of the run before it, at the line's top and after its content; a
// block-level one sits below the run. Before CHANGED_GEN, so the
// write-if-changed diff compares it with the other style bytes.
export const LAYOUT_NODE_OFFSET_FLOW_ORIGIN = layoutConstant("NODE_FLOW_ORIGIN"); // u8: FLOW_ORIGIN_* bits
export const FLOW_ORIGIN_ANONYMOUS_RUN = layoutConstant("FLOW_ORIGIN_ANONYMOUS_RUN");
export const FLOW_ORIGIN_INLINE_LEVEL = layoutConstant("FLOW_ORIGIN_INLINE_LEVEL");
// content-visibility: hidden (CSS Contain 2, 4.1) on a box that size
// containment applies to. The engine sizes the box as if it had no
// contents: its auto block size and its intrinsic inline sizes take none,
// and its contents add nothing to its scrollable overflow. The contents
// still lay out, so their geometry stays readable; the core writes their
// records visibility: hidden, so they paint nothing. Shares the
// FLOW_ORIGIN byte.
export const LAYOUT_NODE_OFFSET_CONTAINMENT = layoutConstant("NODE_CONTAINMENT"); // u8 bit 2, aliases FLOW_ORIGIN
export const CONTAINMENT_CONTENT_HIDDEN = layoutConstant("CONTAINMENT_CONTENT_HIDDEN");
// An outer svg root whose outer display is block-level (display: block,
// flex, ...). An svg root keeps the svg-root display whatever its outer
// display, so this bit says that it takes a line of its own in inline
// content instead of sitting on the line. Shares the FLOW_ORIGIN byte.
export const FLOW_ORIGIN_SVG_BLOCK_LEVEL = layoutConstant("FLOW_ORIGIN_SVG_BLOCK_LEVEL");
// A box that establishes an independent formatting context for a reason
// that its display and flags do not show: replaced content, a fieldset,
// and layout or paint containment. Like every independent formatting
// context, its border box does not overlap the floats beside it (CSS 2,
// 9.5). Shares the FLOW_ORIGIN byte.
export const CONTAINMENT_INDEPENDENT_FORMATTING_CONTEXT = layoutConstant("CONTAINMENT_INDEPENDENT_FORMATTING_CONTEXT");
export const LAYOUT_NODE_OFFSET_FLEX_GROW = layoutConstant("NODE_FLEX_GROW"); // f32
export const LAYOUT_NODE_OFFSET_FLEX_SHRINK = layoutConstant("NODE_FLEX_SHRINK"); // f32
export const LAYOUT_NODE_OFFSET_FLEX_BASIS = layoutConstant("NODE_FLEX_BASIS"); // f32
export const LAYOUT_NODE_OFFSET_ROW_GAP = layoutConstant("NODE_ROW_GAP"); // f32
export const LAYOUT_NODE_OFFSET_COLUMN_GAP = layoutConstant("NODE_COLUMN_GAP"); // f32
// flex ends at 0x108 = 264

// Text (Slice 6). Applies when display:DISPLAY_TEXT. fontIndex/fontWeight/
// fontStyle mirror CMD_TEXT's paint-time fields (same enums); fontSize is
// the used px size (WAT sets HarfBuzz's scale from this via
// hb_font_set_scale at shape time). lineHeight is tagged like width/height
// (0=normal, 1=length px, 2=number ×fontSize). textAlign applies within
// each line box. These are STYLE, so — like flex — they sit BEFORE
// changedGen.
export const LAYOUT_NODE_OFFSET_FONT_INDEX = layoutConstant("NODE_FONT_INDEX"); // u16
export const LAYOUT_NODE_OFFSET_FONT_WEIGHT = layoutConstant("NODE_FONT_WEIGHT"); // u8
export const LAYOUT_NODE_OFFSET_FONT_STYLE = layoutConstant("NODE_FONT_STYLE"); // u8: 0=normal, 1=italic
export const LAYOUT_NODE_OFFSET_FONT_SIZE = layoutConstant("NODE_FONT_SIZE"); // f32
export const LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG = layoutConstant("NODE_LINE_HEIGHT_TAG"); // u8: 0=normal,1=length,2=number
export const LAYOUT_NODE_OFFSET_TEXT_ALIGN = layoutConstant("NODE_TEXT_ALIGN"); // u8: 0=left,1=center,2=right
// Which animatable inherited fields this node took from its parent
// (design/animations.md, "Inherited properties"). The animation tick
// propagates a sampled value into descendants whose bit is set and
// stops at one whose bit is clear. Scene-spec writers leave it zero.
export const LAYOUT_NODE_OFFSET_INHERITED_MASK = layoutConstant("NODE_INHERITED_MASK"); // u8 bitmask (see INHERITED_MASK_*)
// A DISPLAY_TEXT node that is a list item's ::marker. Zero for every other
// node. Bits 0-2 are the marker style (LIST_MARKER_DISC/CIRCLE/SQUARE paint
// Chrome's geometric symbol instead of glyphs, LIST_MARKER_DISCLOSURE_CLOSED/
// OPEN its disclosure triangle; LIST_MARKER_COUNTER is text, a counter such
// as "3. " or a <string> list-style-type);
// LIST_MARKER_OUTSIDE marks list-style-position: outside,
// which takes the marker out of its list item's flow: the list item places
// it beside its first line, on the side LIST_MARKER_SIDE_SET and
// LIST_MARKER_SIDE_RTL give (marker-side), else the item's start side.
export const LAYOUT_NODE_OFFSET_LIST_MARKER = layoutConstant("NODE_LIST_MARKER"); // u8
export const LIST_MARKER_STYLE_MASK = layoutConstant("LIST_MARKER_STYLE_MASK");
export const LIST_MARKER_DISC = layoutConstant("LIST_MARKER_DISC");
export const LIST_MARKER_CIRCLE = layoutConstant("LIST_MARKER_CIRCLE");
export const LIST_MARKER_SQUARE = layoutConstant("LIST_MARKER_SQUARE");
export const LIST_MARKER_COUNTER = layoutConstant("LIST_MARKER_COUNTER");
export const LIST_MARKER_DISCLOSURE_CLOSED = layoutConstant("LIST_MARKER_DISCLOSURE_CLOSED");
export const LIST_MARKER_DISCLOSURE_OPEN = layoutConstant("LIST_MARKER_DISCLOSURE_OPEN");
export const LIST_MARKER_OUTSIDE = layoutConstant("LIST_MARKER_OUTSIDE");
export const LAYOUT_NODE_OFFSET_LINE_HEIGHT = layoutConstant("NODE_LINE_HEIGHT"); // f32 (length px or ×fontSize number)
export const LAYOUT_NODE_OFFSET_TEXT_COLOR = layoutConstant("NODE_TEXT_COLOR"); // f32[4] (rgba) — CMD_TEXT's fill color
// text ends at 0x128 = 296; style ends at 0x128

// --- P0 block (node-struct stride bump 320->640, design/paint-coverage.md) ---
//
// Everything from here to CHANGED_GEN is new or moved as of P0. Two
// placement cleanups happened here (both explicitly called for by P0):
//   - HAS_Z moved OUT of the old 1-byte pad gap after FLEX_BASIS_TAG
//     (0xF2) into this block.
//   - BLEND_MODE moved from AFTER the old CHANGED_GEN (where it sat
//     outside session.js's write-if-changed diff range, requiring every
//     full-tree writeNode to write it directly) into this block, now
//     genuinely covered by write-if-changed like every other style field.
//
// CHANGED_GEN MUST STAY THE LAST STYLE FIELD: session.writeNode's
// write-if-changed diffs the style range [0, CHANGED_GEN) and stamps
// this separately, so every style byte (including every new field below)
// must precede it. Everything past CHANGED_GEN to the end of the 640-byte
// stride is genuine reserved padding — real headroom for anything a
// future slice needs that wasn't anticipated here.
//
// Fields are grouped by natural alignment (u8s, then u16s, then f32/i32/
// u32s, then f32[4]/f32[5] blocks) to avoid wasted padding. Each field
// notes which plan/slice declares it; most are NOT YET READ by any WAT
// or JS code — they exist so that slice's own future work never needs
// another stride bump, per this slice's whole purpose.

export const LAYOUT_NODE_OFFSET_HAS_Z = layoutConstant("NODE_HAS_Z"); // u8 (moved from old pad-gap 0xF2; Slice 7B)
export const LAYOUT_NODE_OFFSET_BLEND_MODE = layoutConstant("NODE_BLEND_MODE"); // u8: BLEND_* enum, 0=normal (moved; Slice 8C)
export const LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN = layoutConstant("NODE_VISIBILITY_HIDDEN"); // u8: 0=visible,1=hidden (design/paint-coverage.md P10)
export const LAYOUT_NODE_OFFSET_IMAGE_RENDERING_PIXELATED = layoutConstant("NODE_IMAGE_RENDERING_PIXELATED"); // u8: 0=auto,1=pixelated (P10)

export const LAYOUT_NODE_OFFSET_Z_INDEX = layoutConstant("NODE_Z_INDEX"); // i32 (signed) — moved from old 0x128

export const LAYOUT_NODE_OFFSET_BORDER_STYLE_TOP = layoutConstant("NODE_BORDER_STYLE_TOP"); // u8: BORDER_STYLE_* enum (P7)
export const LAYOUT_NODE_OFFSET_BORDER_STYLE_RIGHT = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_STYLE_RIGHT"); // u8 (P7)
export const LAYOUT_NODE_OFFSET_BORDER_STYLE_BOTTOM = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_STYLE_BOTTOM"); // u8 (P7)
export const LAYOUT_NODE_OFFSET_BORDER_STYLE_LEFT = layoutConstant("LAYOUT_NODE_OFFSET_BORDER_STYLE_LEFT"); // u8 (P7)

// border-style values (P7). SOLID = 0 so a zeroed struct keeps the
// pre-P7 behavior (every border painted solid). Values fit 4 bits —
// CMD_RECT packs the four sides as nibbles, see
// CMD_RECT_OFFSET_BORDER_STYLES.
export const BORDER_STYLE_SOLID = layoutConstant("BORDER_STYLE_SOLID");
export const BORDER_STYLE_DOUBLE = layoutConstant("BORDER_STYLE_DOUBLE");
export const BORDER_STYLE_DASHED = layoutConstant("BORDER_STYLE_DASHED");
export const BORDER_STYLE_DOTTED = layoutConstant("BORDER_STYLE_DOTTED");
export const BORDER_STYLE_INSET = layoutConstant("BORDER_STYLE_INSET");
export const BORDER_STYLE_OUTSET = layoutConstant("BORDER_STYLE_OUTSET");
export const BORDER_STYLE_GROOVE = layoutConstant("BORDER_STYLE_GROOVE");
export const BORDER_STYLE_RIDGE = layoutConstant("BORDER_STYLE_RIDGE");
export const BORDER_STYLE_NONE = layoutConstant("BORDER_STYLE_NONE");
export const BORDER_STYLE_HIDDEN = layoutConstant("BORDER_STYLE_HIDDEN");
// The outline style byte (LAYOUT_NODE_OFFSET_OUTLINE_STYLE) for auto.
export const OUTLINE_STYLE_AUTO = layoutConstant("OUTLINE_STYLE_AUTO");
export const LAYOUT_NODE_OFFSET_BACKGROUND_CLIP = layoutConstant("NODE_BACKGROUND_CLIP"); // u8: 0=border-box,1=padding-box,2=content-box (P10)
export const LAYOUT_NODE_OFFSET_ISOLATION_ISOLATE = layoutConstant("NODE_ISOLATION"); // u8: 0=auto,1=isolate (P10)
export const LAYOUT_NODE_OFFSET_FLOAT = layoutConstant("NODE_FLOAT"); // u8: 0=none,1=left,2=right (design/floats.md)
export const LAYOUT_NODE_OFFSET_CLEAR = layoutConstant("NODE_CLEAR"); // u8: 0=none,1=left,2=right,3=both (design/floats.md)

// float / clear enums (design/floats.md). Mirrored as $FLOAT_* /
// $CLEAR_* globals in engine.wat — keep in lockstep.
export const FLOAT_NONE = layoutConstant("FLOAT_NONE");
export const FLOAT_LEFT = layoutConstant("FLOAT_LEFT");
export const FLOAT_RIGHT = layoutConstant("FLOAT_RIGHT");
export const CLEAR_NONE = layoutConstant("CLEAR_NONE");
export const CLEAR_LEFT = layoutConstant("CLEAR_LEFT");
export const CLEAR_RIGHT = layoutConstant("CLEAR_RIGHT");
export const CLEAR_BOTH = layoutConstant("CLEAR_BOTH");
export const LAYOUT_NODE_OFFSET_TEXT_BEHAVIOR = layoutConstant("NODE_TEXT_BEHAVIOR"); // u8 bitmask: overflow/white-space text behavior
export const LAYOUT_NODE_OFFSET_WHITE_SPACE = layoutConstant("NODE_TEXT_BEHAVIOR"); // alias; white-space bits are reserved for its implementation
export const TEXT_BEHAVIOR_ELLIPSIS = layoutConstant("TEXT_BEHAVIOR_ELLIPSIS");
export const TEXT_BEHAVIOR_NOWRAP = layoutConstant("TEXT_BEHAVIOR_NOWRAP");
export const TEXT_BEHAVIOR_BREAK_ANYWHERE = layoutConstant("TEXT_BEHAVIOR_BREAK_ANYWHERE");
export const TEXT_BEHAVIOR_PRESERVE_SPACES = layoutConstant("TEXT_BEHAVIOR_PRESERVE_SPACES");
// overflow-wrap: break-word. The line breaker splits an overflowing word at
// a cluster boundary only when its line has no other break opportunity;
// min-content is unchanged (unlike BREAK_ANYWHERE).
export const TEXT_BEHAVIOR_BREAK_WORD = layoutConstant("TEXT_BEHAVIOR_BREAK_WORD");
// white-space: break-spaces, set with TEXT_BEHAVIOR_PRESERVE_SPACES:
// preserved white space at a line end does not hang.
export const TEXT_BEHAVIOR_BREAK_SPACES = layoutConstant("TEXT_BEHAVIOR_BREAK_SPACES");
// text-wrap-style: balance: the line breaker balances the lines of each
// paragraph.
export const TEXT_BEHAVIOR_BALANCE = layoutConstant("TEXT_BEHAVIOR_BALANCE");
export const LAYOUT_NODE_OFFSET_TABLE_LAYOUT = layoutConstant("NODE_TABLE_LAYOUT"); // u8: 0=auto,1=fixed (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_BORDER_COLLAPSE = layoutConstant("NODE_BORDER_COLLAPSE"); // u8: 0=separate,1=collapse (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_CAPTION_SIDE = layoutConstant("NODE_CAPTION_SIDE"); // u8: 0=top,1=bottom (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_EMPTY_CELLS = layoutConstant("NODE_EMPTY_CELLS"); // u8: 0=show,1=hide
export const LAYOUT_NODE_OFFSET_GRID_AUTO_FLOW = layoutConstant("NODE_GRID_AUTO_FLOW"); // u8: row/column + dense bit (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_ALIGN_CONTENT = layoutConstant("NODE_ALIGN_CONTENT"); // u8 (grid; reuses JUSTIFY_* enum space)
export const LAYOUT_NODE_OFFSET_JUSTIFY_ITEMS = layoutConstant("NODE_JUSTIFY_ITEMS"); // u8 (grid; reuses JUSTIFY_* enum space; plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_JUSTIFY_SELF = layoutConstant("NODE_JUSTIFY_SELF"); // u8 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_SVG_KIND = layoutConstant("NODE_SVG_KIND"); // u8: rect/circle/ellipse/line/path-ref/group (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_FILL_RULE = layoutConstant("NODE_SVG_FILL_RULE"); // u8: 0=nonzero,1=evenodd (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_LINE_CAP = layoutConstant("NODE_SVG_LINE_CAP"); // u8: butt/round/square (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_LINE_JOIN = layoutConstant("NODE_SVG_LINE_JOIN"); // u8: miter/round/bevel (design/svg-rendering.md)
// DISPLAY_TEXT nodes authored by SVG <text> reuse shape-only fields that
// ordinary text never reads. A nonzero anchor marks SVG positioning; x/y are
// SVG user-space coordinates, with y naming the text baseline.
export const LAYOUT_NODE_OFFSET_SVG_TEXT_ANCHOR = layoutConstant("NODE_SVG_TEXT_ANCHOR"); // u8, aliases SVG_KIND
export const LAYOUT_NODE_OFFSET_BG_KIND = layoutConstant("NODE_BG_KIND"); // u8: 0=solid,1=linear,2=radial,3=conic, bit7=repeating (P4)
export const LAYOUT_NODE_OFFSET_BG_REPEAT = layoutConstant("LAYOUT_NODE_OFFSET_BG_REPEAT"); // u8: repeat/no-repeat/space/round (P5c)
export const LAYOUT_NODE_OFFSET_CLIP_PATH_KIND = layoutConstant("LAYOUT_NODE_OFFSET_CLIP_PATH_KIND"); // u8: none/inset/circle/ellipse (P9)
export const LAYOUT_NODE_OFFSET_OUTLINE_STYLE = layoutConstant("NODE_OUTLINE_STYLE"); // u8: 0=none, 1+BORDER_STYLE_*, OUTLINE_STYLE_AUTO (P10)
export const LAYOUT_NODE_OFFSET_ASPECT_RATIO_HAS = layoutConstant("NODE_ASPECT_RATIO_HAS"); // u8: 0=auto,1=has-ratio,2=auto && ratio (a natural ratio wins) (plans/layout/PLAN-layout-remaining.md)
export const LAYOUT_NODE_OFFSET_VERTICAL_ALIGN_TAG = layoutConstant("NODE_VERTICAL_ALIGN_TAG"); // u8: tag shared by table-cell + inline
export const LAYOUT_NODE_OFFSET_BG_SIZE_W_TAG = layoutConstant("LAYOUT_NODE_OFFSET_BG_SIZE_W_TAG"); // u8: auto/length/percent/cover/contain (P5c)
export const LAYOUT_NODE_OFFSET_BG_SIZE_H_TAG = layoutConstant("LAYOUT_NODE_OFFSET_BG_SIZE_H_TAG"); // u8 (P5c)
export const LAYOUT_NODE_OFFSET_BG_POSITION_X_TAG = layoutConstant("LAYOUT_NODE_OFFSET_BG_POSITION_X_TAG"); // u8: length/percent (P5c)
export const LAYOUT_NODE_OFFSET_BG_POSITION_Y_TAG = layoutConstant("LAYOUT_NODE_OFFSET_BG_POSITION_Y_TAG"); // u8 (P5c)

// Replaced raster content (<img> and <canvas>), independent of CSS display.
// Every node without raster content must initialize this field to 0xFFFF:
// zero is the first valid IMAGE_TABLE index, not an absent/default value.
// Background-image references live separately in BG_LAYER_POOL. SVG shape
// nodes use the alias below instead and must not enter raster sizing/painting.
export const LAYOUT_NODE_OFFSET_IMAGE_INDEX = layoutConstant("NODE_IMAGE_INDEX"); // u16: index into IMAGE_TABLE, 0xFFFF=none (P5b, <img> src)
// SVG path-reference rows use this field for a native path-registry identity.
// CMD_SVG_PATH carries it to native atlas residency lookup.
export const LAYOUT_NODE_OFFSET_SVG_PATH_INDEX = layoutConstant("NODE_SVG_PATH_INDEX"); // u16, aliases IMAGE_INDEX (design/svg-rendering.md, Tier B)
export const LAYOUT_NODE_OFFSET_COL_SPAN = layoutConstant("NODE_COL_SPAN"); // u16: table cell colspan (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_ROW_SPAN = layoutConstant("NODE_ROW_SPAN"); // u16: table cell rowspan (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_GEOM_LENGTH = layoutConstant("NODE_GEOM_LENGTH"); // u16: SVG geometry pool span length (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_GRID_COL_TEMPLATE_COUNT = layoutConstant("NODE_GRID_COL_TEMPLATE_COUNT"); // u16 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_ROW_TEMPLATE_COUNT = layoutConstant("NODE_GRID_ROW_TEMPLATE_COUNT"); // u16 (plans/layout/PLAN-layout-grid.md)

export const LAYOUT_NODE_OFFSET_SHADOW_COUNT = layoutConstant("NODE_SHADOW_COUNT"); // u8: box-shadow pool span count (P3)
export const LAYOUT_NODE_OFFSET_STOP_COUNT = layoutConstant("NODE_STOP_COUNT"); // u8: gradient stop pool span count (P4)
export const LAYOUT_NODE_OFFSET_BG_LAYER_COUNT = layoutConstant("NODE_BG_LAYER_COUNT"); // u8: multi-background layer pool span count (P5c)
export const LAYOUT_NODE_OFFSET_TEXT_SHADOW_COUNT = layoutConstant("NODE_TEXT_SHADOW_COUNT"); // u8: text-shadow pool span count (P6)
export const LAYOUT_NODE_OFFSET_FILTER_COUNT = layoutConstant("NODE_FILTER_COUNT"); // u8: filter pool span count (P8)
export const LAYOUT_NODE_OFFSET_BACKDROP_FILTER_COUNT = layoutConstant("NODE_BACKDROP_FILTER_COUNT"); // u8: backdrop-filter pool span count (P8b)

export const LAYOUT_NODE_OFFSET_SHADOW_OFFSET = layoutConstant("NODE_SHADOW_OFFSET"); // u32: box-shadow pool span offset (P3)
export const LAYOUT_NODE_OFFSET_STOP_OFFSET = layoutConstant("NODE_STOP_OFFSET"); // u32: gradient stop pool span offset (P4)
export const LAYOUT_NODE_OFFSET_BG_LAYERS_OFFSET = layoutConstant("NODE_BG_LAYERS_OFFSET"); // u32: multi-background layer pool span offset (P5c)
export const LAYOUT_NODE_OFFSET_TEXT_SHADOW_OFFSET = layoutConstant("NODE_TEXT_SHADOW_OFFSET"); // u32: text-shadow pool span offset (P6)
export const LAYOUT_NODE_OFFSET_FILTER_OFFSET = layoutConstant("NODE_FILTER_OFFSET"); // u32: filter pool span offset (P8)
export const LAYOUT_NODE_OFFSET_BACKDROP_FILTER_OFFSET = layoutConstant("NODE_BACKDROP_FILTER_OFFSET"); // u32: backdrop-filter pool span offset (P8b)
export const LAYOUT_NODE_OFFSET_GEOM_OFFSET = layoutConstant("NODE_GEOM_OFFSET"); // u32: SVG geometry pool span offset (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_GRID_COL_TEMPLATE_OFFSET = layoutConstant("NODE_GRID_COL_TEMPLATE_OFFSET"); // u32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_ROW_TEMPLATE_OFFSET = layoutConstant("NODE_GRID_ROW_TEMPLATE_OFFSET"); // u32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_OUTLINE_WIDTH = layoutConstant("NODE_OUTLINE_WIDTH"); // f32 (P10)
export const LAYOUT_NODE_OFFSET_OUTLINE_OFFSET = layoutConstant("NODE_OUTLINE_OFFSET"); // f32 (P10)
export const LAYOUT_NODE_OFFSET_SVG_STROKE_WIDTH = layoutConstant("NODE_SVG_STROKE_WIDTH"); // f32 (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_FILL_OPACITY = layoutConstant("NODE_SVG_FILL_OPACITY"); // f32 (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_STROKE_OPACITY = layoutConstant("NODE_SVG_STROKE_OPACITY"); // f32 (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_TEXT_X = layoutConstant("NODE_SVG_TEXT_X"); // f32, aliases SVG_STROKE_WIDTH
export const LAYOUT_NODE_OFFSET_SVG_TEXT_Y = layoutConstant("NODE_SVG_TEXT_Y"); // f32, aliases SVG_FILL_OPACITY
export const LAYOUT_NODE_OFFSET_BORDER_SPACING_X = layoutConstant("NODE_BORDER_SPACING_X"); // f32 (plans/layout/PLAN-layout-tables.md; needs scaleNode)
export const LAYOUT_NODE_OFFSET_BORDER_SPACING_Y = layoutConstant("NODE_BORDER_SPACING_Y"); // f32 (plans/layout/PLAN-layout-tables.md; needs scaleNode)
export const LAYOUT_NODE_OFFSET_BG_SIZE_W = layoutConstant("LAYOUT_NODE_OFFSET_BG_SIZE_W"); // f32 (P5c)
export const LAYOUT_NODE_OFFSET_BG_SIZE_H = layoutConstant("LAYOUT_NODE_OFFSET_BG_SIZE_H"); // f32 (P5c)
export const LAYOUT_NODE_OFFSET_BG_POSITION_X = layoutConstant("LAYOUT_NODE_OFFSET_BG_POSITION_X"); // f32 (P5c)
export const LAYOUT_NODE_OFFSET_BG_POSITION_Y = layoutConstant("LAYOUT_NODE_OFFSET_BG_POSITION_Y"); // f32 (P5c)
export const LAYOUT_NODE_OFFSET_ASPECT_RATIO_W = layoutConstant("NODE_ASPECT_RATIO_W"); // f32 (plans/layout/PLAN-layout-remaining.md)
export const LAYOUT_NODE_OFFSET_ASPECT_RATIO_H = layoutConstant("NODE_ASPECT_RATIO_H"); // f32 (plans/layout/PLAN-layout-remaining.md)
export const LAYOUT_NODE_OFFSET_VERTICAL_ALIGN_VALUE = layoutConstant("NODE_VERTICAL_ALIGN_VALUE"); // f32 (table-cell + inline, shared)
export const LAYOUT_NODE_OFFSET_ROW_START_VALUE = layoutConstant("NODE_GRID_ROW_START_VALUE"); // i32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_ROW_END_VALUE = layoutConstant("NODE_GRID_ROW_END_VALUE"); // i32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_COL_START_VALUE = layoutConstant("NODE_GRID_COL_START_VALUE"); // i32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_COL_END_VALUE = layoutConstant("NODE_GRID_COL_END_VALUE"); // i32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MIN = layoutConstant("NODE_GRID_AUTO_ROWS_MIN"); // f32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MAX = layoutConstant("NODE_GRID_AUTO_ROWS_MAX"); // f32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MIN = layoutConstant("NODE_GRID_AUTO_COLS_MIN"); // f32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MAX = layoutConstant("NODE_GRID_AUTO_COLS_MAX"); // f32 (plans/layout/PLAN-layout-grid.md)
// Grid-only aliases. A DISPLAY_GRID node cannot be an SVG root/shape, so these
// coefficients safely reuse SVG-only fields without growing the node record.
// The primary implicit-track values remain at 0x1CC..0x1D8.
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MIN_PERCENTAGE = layoutConstant("NODE_GRID_AUTO_ROWS_MIN_PERCENTAGE");
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MAX_PERCENTAGE = layoutConstant("NODE_GRID_AUTO_ROWS_MAX_PERCENTAGE");
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MIN_PERCENTAGE = layoutConstant("NODE_GRID_AUTO_COLS_MIN_PERCENTAGE");
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MAX_PERCENTAGE = layoutConstant("NODE_GRID_AUTO_COLS_MAX_PERCENTAGE");
export const LAYOUT_NODE_OFFSET_GRID_ROW_GAP_PERCENTAGE = layoutConstant("NODE_GRID_ROW_GAP_PERCENTAGE");
export const LAYOUT_NODE_OFFSET_GRID_COLUMN_GAP_PERCENTAGE = layoutConstant("NODE_GRID_COLUMN_GAP_PERCENTAGE");

export const LAYOUT_NODE_OFFSET_OUTLINE_COLOR = layoutConstant("NODE_OUTLINE_COLOR"); // f32[4] rgba (P10)
export const LAYOUT_NODE_OFFSET_SVG_FILL_COLOR = layoutConstant("NODE_SVG_FILL_COLOR"); // f32[4] rgba (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_STROKE_COLOR = layoutConstant("NODE_SVG_STROKE_COLOR"); // f32[4] rgba (design/svg-rendering.md)

// DISPLAY_SVG_ROOT viewBox (design/svg-rendering.md): NOT anticipated in P0's
// original byte inventory (P0 only reserved fields for svg SHAPES —
// rect/circle/etc — not the root element itself). A node is either an svg
// root (DISPLAY_SVG_ROOT) or an svg shape (a child inside one), NEVER
// both, so the root safely ALIASES the shape-only fill/stroke fields that
// would otherwise sit unused on it — same "carve out of an unused block
// for the SAME node kind's own needs" pattern P5b used for object-fit
// (see that field's own comment above). Do not read/write these offsets
// under their SVG_FILL_COLOR/SVG_STROKE_WIDTH names for a DISPLAY_SVG_ROOT
// node, or vice versa for an svg shape — the two meanings are mutually
// exclusive per node, not layered.
export const LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_MIN_X = layoutConstant("NODE_SVG_VIEW_BOX_MIN_X"); // f32, aliases SVG_FILL_COLOR.r
export const LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_MIN_Y = layoutConstant("NODE_SVG_VIEW_BOX_MIN_Y"); // f32, aliases SVG_FILL_COLOR.g
export const LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_WIDTH = layoutConstant("NODE_SVG_VIEW_BOX_WIDTH"); // f32, aliases SVG_FILL_COLOR.b
export const LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_HEIGHT = layoutConstant("NODE_SVG_VIEW_BOX_HEIGHT"); // f32, aliases SVG_FILL_COLOR.a
export const LAYOUT_NODE_OFFSET_SVG_HAS_VIEW_BOX = layoutConstant("NODE_SVG_HAS_VIEW_BOX"); // u8, aliases SVG_FILL_RULE: 0=no viewBox (use intrinsic px), 1=has viewBox
export const LAYOUT_NODE_OFFSET_SVG_PRESERVE_ASPECT_RATIO = layoutConstant("NODE_SVG_PRESERVE_ASPECT_RATIO"); // u8, aliases SVG_LINE_CAP: PRESERVE_ASPECT_RATIO_* enum
// The x and y of a nested svg viewport (a DISPLAY_SVG_ROOT whose parent is
// an SVG element) in the user space of its parent: a length in px at
// SVG_X and SVG_Y, and a percentage of the parent viewport's width and
// height as a fraction at SVG_X_PERCENT and SVG_Y_PERCENT. A root has no
// stroke, so these alias the stroke width, the fill opacity and the stroke
// color's red and green.
export const LAYOUT_NODE_OFFSET_SVG_X = layoutConstant("NODE_SVG_X"); // f32 px, aliases SVG_STROKE_WIDTH
export const LAYOUT_NODE_OFFSET_SVG_Y = layoutConstant("NODE_SVG_Y"); // f32 px, aliases SVG_FILL_OPACITY
export const LAYOUT_NODE_OFFSET_SVG_X_PERCENT = layoutConstant("NODE_SVG_X_PERCENT"); // f32 fraction, aliases SVG_STROKE_COLOR.r
export const LAYOUT_NODE_OFFSET_SVG_Y_PERCENT = layoutConstant("NODE_SVG_Y_PERCENT"); // f32 fraction, aliases SVG_STROKE_COLOR.g
// The effective zoom of an svg root. SVG content lies in unzoomed user
// units, and the transform from an outermost svg's user space to its
// content box applies its zoom after its viewBox transform at its
// unzoomed size (CSS Viewport 1 §4.1); a nested svg holds 1. It aliases
// the stroke color's blue.
export const LAYOUT_NODE_OFFSET_SVG_ZOOM = layoutConstant("NODE_SVG_ZOOM"); // f32, aliases SVG_STROKE_COLOR.b
// A pattern template (SVG_KIND_PATTERN): the display-none child of a shape
// whose fill or stroke names a <pattern>. Its flags (role, patternUnits,
// patternContentUnits), its patternTransform and its tile size alias
// shape-only fields; its tile x and y are SVG_X and SVG_Y, its viewBox the
// SVG_VIEW_BOX_* fields.
export const LAYOUT_NODE_OFFSET_SVG_PATTERN_FLAGS = layoutConstant("NODE_SVG_PATTERN_FLAGS"); // u8, aliases SVG_LINE_JOIN
export const LAYOUT_NODE_OFFSET_SVG_PATTERN_TRANSFORM = layoutConstant("NODE_SVG_PATTERN_TRANSFORM"); // f32[6], aliases SVG_STROKE_COLOR and BG_GRADIENT_GEOMETRY.x,y
export const LAYOUT_NODE_OFFSET_SVG_PATTERN_WIDTH = layoutConstant("NODE_SVG_PATTERN_WIDTH"); // f32, aliases BG_GRADIENT_GEOMETRY.z
export const LAYOUT_NODE_OFFSET_SVG_PATTERN_HEIGHT = layoutConstant("NODE_SVG_PATTERN_HEIGHT"); // f32, aliases BG_GRADIENT_GEOMETRY.w
export const SVG_PATTERN_ROLE_BITS = layoutConstant("SVG_PATTERN_ROLE_BITS");
export const SVG_PATTERN_ROLE_FILL = layoutConstant("SVG_PATTERN_ROLE_FILL");
export const SVG_PATTERN_ROLE_STROKE = layoutConstant("SVG_PATTERN_ROLE_STROKE");
export const SVG_PATTERN_ROLE_SVG_MASK = layoutConstant("SVG_PATTERN_ROLE_SVG_MASK");
export const SVG_PATTERN_UNITS_BOX = layoutConstant("SVG_PATTERN_UNITS_BOX");
export const SVG_PATTERN_CONTENT_UNITS_BOX = layoutConstant("SVG_PATTERN_CONTENT_UNITS_BOX");
export const SVG_PATTERN_MASK_TYPE_ALPHA = layoutConstant("SVG_PATTERN_MASK_TYPE_ALPHA");
// Text control intrinsic size (Blink's TextAreaIntrinsicInlineSize,
// TextAreaIntrinsicBlockSize and TextFieldIntrinsicInlineSize). A textarea or
// a text field is never an svg shape, so these alias shape-only fields (the
// stroke color, the fill color's alpha and the line join), and
// LAYOUT_FLAG_TEXT_CONTROL names the meaning. COLS is a textarea's cols or a
// text field's size. ROWS is a textarea's rows, and 0 for a text field. The
// engine resolves the font-dependent parts. A textarea: width = ceil(average
// character width x cols) + INLINE_SCROLLBAR, height = line height x rows +
// BLOCK_SCROLLBAR; the scrollbar terms are px, already resolved from overflow
// and scrollbar-width. A text field: width = ceil(average character width x
// cols + max(0, ascent - average character width)), and the height comes
// from its content. The average character width is the font's own (the "x"
// advance) unless INVALID_AVERAGE_FAMILY is 1 (the first authored family is
// in Blink's kFontFamiliesWithInvalidCharWidth) or the font's "x" is more
// than 1.7 times its "0". Then it is the width of "0" plus LETTER_SPACING,
// and a text field adds no ascent term.
export const LAYOUT_NODE_OFFSET_TEXT_CONTROL_COLS = layoutConstant("NODE_TEXT_CONTROL_COLS"); // f32, aliases SVG_STROKE_COLOR.r
export const LAYOUT_NODE_OFFSET_TEXT_CONTROL_ROWS = layoutConstant("NODE_TEXT_CONTROL_ROWS"); // f32, aliases SVG_STROKE_COLOR.g
export const LAYOUT_NODE_OFFSET_TEXT_CONTROL_INLINE_SCROLLBAR = layoutConstant("NODE_TEXT_CONTROL_INLINE_SCROLLBAR"); // f32 px, aliases SVG_STROKE_COLOR.b
export const LAYOUT_NODE_OFFSET_TEXT_CONTROL_BLOCK_SCROLLBAR = layoutConstant("NODE_TEXT_CONTROL_BLOCK_SCROLLBAR"); // f32 px, aliases SVG_STROKE_COLOR.a
export const LAYOUT_NODE_OFFSET_TEXT_CONTROL_LETTER_SPACING = layoutConstant("NODE_TEXT_CONTROL_LETTER_SPACING"); // f32 px, aliases SVG_FILL_COLOR.a
export const LAYOUT_NODE_OFFSET_TEXT_CONTROL_INVALID_AVERAGE_FAMILY = layoutConstant("NODE_TEXT_CONTROL_INVALID_AVERAGE_FAMILY"); // u8, aliases SVG_LINE_JOIN
// MathML box fields (docs/design/mathml-layout.md). A math box
// (DISPLAY_MATH, DISPLAY_BLOCK_MATH, or an mtd cell) is never an svg node, a
// text control, or a grid container, so these alias the SVG fill and stroke
// colors (and the grid percentage and text control aliases over them).
export const LAYOUT_NODE_OFFSET_MATH_KIND = layoutConstant("NODE_MATH_KIND"); // u8 MATH_KIND_*
export const LAYOUT_NODE_OFFSET_MATH_FLAGS = layoutConstant("NODE_MATH_FLAGS"); // u8 MATH_FLAG_*
export const LAYOUT_NODE_OFFSET_MATH_OPERATOR_FLAGS = layoutConstant("NODE_MATH_OPERATOR_FLAGS"); // u8 MATH_OPERATOR_*
export const LAYOUT_NODE_OFFSET_MATH_SPACE_UNITS = layoutConstant("NODE_MATH_SPACE_UNITS"); // u8: default lspace (bits 0-3) and rspace (4-7) in 1/18 em
export const LAYOUT_NODE_OFFSET_MATH_LSPACE = layoutConstant("NODE_MATH_LSPACE"); // f32 px or percent, by MATH_TAGS
export const LAYOUT_NODE_OFFSET_MATH_RSPACE = layoutConstant("NODE_MATH_RSPACE"); // f32 px or percent, by MATH_TAGS
export const LAYOUT_NODE_OFFSET_MATH_CODE_POINT = layoutConstant("NODE_MATH_CODE_POINT"); // u32: the token's single code point, else 0xFFFF
export const LAYOUT_NODE_OFFSET_MATH_LENGTH = layoutConstant("NODE_MATH_LENGTH"); // f32: mfrac linethickness or mspace width
export const LAYOUT_NODE_OFFSET_MATH_MIN_SIZE = layoutConstant("NODE_MATH_MIN_SIZE"); // f32: mo minsize, or mspace height
export const LAYOUT_NODE_OFFSET_MATH_MAX_SIZE = layoutConstant("NODE_MATH_MAX_SIZE"); // f32: mo maxsize, or mspace depth
export const LAYOUT_NODE_OFFSET_MATH_TAGS = layoutConstant("NODE_MATH_TAGS"); // u16: MATH_LENGTH_* pairs (see MATH_LENGTH_DEFAULT)
export const LAYOUT_NODE_OFFSET_BG_GRADIENT_GEOMETRY = layoutConstant("NODE_BG_GRADIENT_GEOMETRY"); // f32[4]: linear{dx,dy,length,pad} / radial{cx,cy,rx,ry} / conic{cx,cy,angle,pad} (P4)
export const LAYOUT_NODE_OFFSET_CLIP_PATH_GEOMETRY = layoutConstant("LAYOUT_NODE_OFFSET_CLIP_PATH_GEOMETRY"); // f32[5] (P9)

// Elliptical border-radius (P10): widens the 4 existing circular radii
// (LAYOUT_NODE_OFFSET_BORDER_RADIUS_*, 0xA8-0xB7, UNCHANGED) into (x, y)
// pairs by adding the Y component here. The X components stay exactly
// where they've always been; do not move them.
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT_Y = layoutConstant("NODE_BORDER_RADIUS_TOP_LEFT_Y"); // f32 (P10)
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_RIGHT_Y = layoutConstant("NODE_BORDER_RADIUS_TOP_RIGHT_Y"); // f32 (P10)
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_RIGHT_Y = layoutConstant("NODE_BORDER_RADIUS_BOTTOM_RIGHT_Y"); // f32 (P10)
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_LEFT_Y = layoutConstant("NODE_BORDER_RADIUS_BOTTOM_LEFT_Y"); // f32 (P10)

// object-fit / object-position (P5b): NOT anticipated in P0's original
// byte inventory — carved out of the 60-byte reserved tail below, which
// exists for exactly this ("headroom for anything a future slice needs
// that wasn't anticipated here"). object-position has no "auto" keyword
// (CSS default is 50% 50%), but the tag byte reuses SIZE_TAG_LENGTH/
// SIZE_TAG_PERCENT for consistency with BG_POSITION_*_TAG's scheme.
export const LAYOUT_NODE_OFFSET_OBJECT_FIT = layoutConstant("NODE_OBJECT_FIT"); // u8: OBJECT_FIT_* enum, 0=fill (P5b)
export const LAYOUT_NODE_OFFSET_OBJECT_POSITION_X_TAG = layoutConstant("NODE_OBJECT_POSITION_X_TAG"); // u8: SIZE_TAG_LENGTH/PERCENT (P5b)
export const LAYOUT_NODE_OFFSET_OBJECT_POSITION_Y_TAG = layoutConstant("NODE_OBJECT_POSITION_Y_TAG"); // u8 (P5b)
export const LAYOUT_NODE_OFFSET_OBJECT_POSITION_X = layoutConstant("NODE_OBJECT_POSITION_X"); // f32: length(LU) or percent 0..100 (P5b)
export const LAYOUT_NODE_OFFSET_OBJECT_POSITION_Y = layoutConstant("NODE_OBJECT_POSITION_Y"); // f32 (P5b)

// mask layer pool span (P11). These two land in existing struct PADDING
// rather than behind a stride bump: 0x240-0x243 is the 4-byte hole P4
// step 3 left when it moved CHANGED_GEN off 0x240, and 0x247 is
// object-position's own tag padding. Both sit BELOW CHANGED_GEN, so
// session.js's write-if-changed diffing covers them.
//
// This is NOT the case S5's "never alias, always bump" rule was written
// for (see SVG_STROKE_PATH_INDEX's comment): that rule is about reusing
// another feature's LIVE field, where two meanings can be true of one
// node at the same time. These bytes are alignment padding — verified
// unreferenced by any offset constant in this file or engine.wat — so
// there is no second meaning to collide with. A 672->680 bump to hold
// 5 bytes would shift every region constant from the command buffer region
// onward.
export const LAYOUT_NODE_OFFSET_MASK_LAYERS_OFFSET = layoutConstant("NODE_MASK_LAYERS_OFFSET"); // u32: MASK_LAYER_POOL span offset (P11)
export const LAYOUT_NODE_OFFSET_MASK_LAYER_COUNT = layoutConstant("NODE_MASK_LAYER_COUNT"); // u8: MASK_LAYER_POOL span count (P11)

export const OBJECT_FIT_FILL = layoutConstant("OBJECT_FIT_FILL");
export const OBJECT_FIT_CONTAIN = layoutConstant("OBJECT_FIT_CONTAIN");
export const OBJECT_FIT_COVER = layoutConstant("OBJECT_FIT_COVER");
export const OBJECT_FIT_NONE = layoutConstant("OBJECT_FIT_NONE");
export const OBJECT_FIT_SCALE_DOWN = layoutConstant("OBJECT_FIT_SCALE_DOWN");

// SVG node kinds (design/svg-rendering.md). A DISPLAY_SVG_ROOT node's children carry
// one of these in LAYOUT_NODE_OFFSET_SVG_KIND to say what geometry they
// hold in the SVG geometry pool (GEOM_OFFSET/GEOM_LENGTH). SVG_KIND_GROUP
// (<g>) has no geometry pool span (length 0) — it's a plain transform +
// paint-order grouping node, per the plan's Node/data model section.
export const SVG_KIND_RECT = layoutConstant("SVG_KIND_RECT");
export const SVG_KIND_CIRCLE = layoutConstant("SVG_KIND_CIRCLE");
export const SVG_KIND_ELLIPSE = layoutConstant("SVG_KIND_ELLIPSE"); // S2
export const SVG_KIND_LINE = layoutConstant("SVG_KIND_LINE");
export const SVG_KIND_PATH_REF = layoutConstant("SVG_KIND_PATH_REF"); // S4 (Tier B, msdfgen path atlas)
export const SVG_KIND_GROUP = layoutConstant("SVG_KIND_GROUP");
export const SVG_KIND_PATTERN = layoutConstant("SVG_KIND_PATTERN"); // a pattern template, painted only by its shape's paint
export const SVG_TEXT_ANCHOR_NONE = layoutConstant("SVG_TEXT_ANCHOR_NONE");
export const SVG_TEXT_ANCHOR_START = layoutConstant("SVG_TEXT_ANCHOR_START");
export const SVG_TEXT_ANCHOR_MIDDLE = layoutConstant("SVG_TEXT_ANCHOR_MIDDLE");
export const SVG_TEXT_ANCHOR_END = layoutConstant("SVG_TEXT_ANCHOR_END");

// preserveAspectRatio (design/svg-rendering.md's viewBox->viewport transform):
// the alignment in the low four bits, and PRESERVE_ASPECT_RATIO_SLICE for
// `slice` (the larger axis scale; the svg viewport clip cuts the overflow).
// `none` has no slice bit.
export const PRESERVE_ASPECT_RATIO_NONE = layoutConstant("PRESERVE_ASPECT_RATIO_NONE");
export const PRESERVE_ASPECT_RATIO_X_MIN_Y_MIN = layoutConstant("PRESERVE_ASPECT_RATIO_X_MIN_Y_MIN");
export const PRESERVE_ASPECT_RATIO_X_MID_Y_MIN = layoutConstant("PRESERVE_ASPECT_RATIO_X_MID_Y_MIN");
export const PRESERVE_ASPECT_RATIO_X_MAX_Y_MIN = layoutConstant("PRESERVE_ASPECT_RATIO_X_MAX_Y_MIN");
export const PRESERVE_ASPECT_RATIO_X_MIN_Y_MID = layoutConstant("PRESERVE_ASPECT_RATIO_X_MIN_Y_MID");
export const PRESERVE_ASPECT_RATIO_X_MID_Y_MID = layoutConstant("PRESERVE_ASPECT_RATIO_X_MID_Y_MID"); // default
export const PRESERVE_ASPECT_RATIO_X_MAX_Y_MID = layoutConstant("PRESERVE_ASPECT_RATIO_X_MAX_Y_MID");
export const PRESERVE_ASPECT_RATIO_X_MIN_Y_MAX = layoutConstant("PRESERVE_ASPECT_RATIO_X_MIN_Y_MAX");
export const PRESERVE_ASPECT_RATIO_X_MID_Y_MAX = layoutConstant("PRESERVE_ASPECT_RATIO_X_MID_Y_MAX");
export const PRESERVE_ASPECT_RATIO_X_MAX_Y_MAX = layoutConstant("PRESERVE_ASPECT_RATIO_X_MAX_Y_MAX");
export const PRESERVE_ASPECT_RATIO_ALIGN_MASK = layoutConstant("PRESERVE_ASPECT_RATIO_ALIGN_MASK");
export const PRESERVE_ASPECT_RATIO_SLICE = layoutConstant("PRESERVE_ASPECT_RATIO_SLICE");

// background-image (P5c): per-LAYER data lives in BG_LAYER_POOL (a node
// can have multiple background-image layers, CSS list order), reached
// via the P0-reserved LAYOUT_NODE_OFFSET_BG_LAYER_COUNT/BG_LAYERS_OFFSET
// pool-span fields above — no standalone per-node image-index field is
// needed here (unlike LAYOUT_NODE_OFFSET_IMAGE_INDEX for <img> src, which
// is a single reference, not a list).

// Stroke-outline atlas index (design/svg-rendering.md, Tier B): the SECOND CMD_SVG_PATH
// draw a stroked svg-path/svg-polygon/svg-polyline node needs, alongside
// the existing SVG_PATH_INDEX (the fill shape's own atlas entry). Chrome
// paints SVG fill and stroke as two independent sequential src-over
// layers (confirmed directly against a live Chrome render — see
// design/svg-rendering.md), and Tier B's stroke-to-fill design
// (SkStroke::strokePath) produces a genuinely different closed shape
// than the fill, not just a color change on the same geometry — so it
// needs its own atlas entry and its own opaque index, resolved the same
// "async ref -> plain field before emission" way SVG_PATH_INDEX already
// is. 0xFFFF = no stroke (fill-only path, or stroke:none/width<=0).
// This is a NEW field, not an alias of any existing one — see the P0/S5
// stride-bump comment below for why aliasing an existing field (e.g.
// table's COL_SPAN/ROW_SPAN) was rejected in favor of growing the
// struct instead.
export const LAYOUT_NODE_OFFSET_SVG_STROKE_PATH_INDEX = layoutConstant("NODE_SVG_STROKE_PATH_INDEX"); // u16 (design/svg-rendering.md)

// border-image (P14): a u16 INDEX into BORDER_IMAGE_POOL, 0xFFFF = none.
// Same "0xFFFF means absent" convention as IMAGE_INDEX above.
//
// An index rather than BG_LAYER/MASK_LAYER's u32 byte offset, because
// 0x252-0x253 is a two-byte gap and that is what was left. The pool has a
// fixed stride, so index x BORDER_IMAGE_ENTRY_SIZE is the offset.
//
// THIS WAS THE LAST FREE SPACE IN THE STYLE REGION. Everything from here
// to CHANGED_GEN (0x26C) is now allocated, and fields cannot go after
// CHANGED_GEN because session.js diffs [0, CHANGED_GEN) for its
// write-if-changed incremental path — anything beyond it is invisible to
// change detection. The next fixed-size node field pays for a stride
// bump; see the S5 comment below for what that involves.
export const LAYOUT_NODE_OFFSET_BORDER_IMAGE_INDEX = layoutConstant("NODE_BORDER_IMAGE_INDEX"); // u16 (P14)

// P0/S5 (node-struct stride bump 640->648): SVG_STROKE_PATH_INDEX above
// was the first NEW fixed-size node field needed since P0's original
// 320->640 bump — every other field added since then (P5b/P5c/P9/P10)
// fit inside P0's own reserved headroom. Unlike those, aliasing an
// existing field's byte offset wasn't an option here (rejected:
// COL_SPAN/ROW_SPAN, the only same-shape-and-size candidates, are
// TABLE-cell fields — a DISPLAY_SVG_SHAPE node is never a table cell,
// so the aliasing precedent SVG_HAS_VIEW_BOX/SVG_PRESERVE_ASPECT_RATIO
// already uses would have applied cleanly, but the user explicitly
// rejected reusing another plan's bytes as too risky, preferring a
// clean stride bump instead). +8 bytes only (640->648, not a large
// speculative pad) — S6 (groups/use/defs) and S7 (SVG
// gradients, reuses P4's own pool) were checked and need NO new node
// fields of their own, so there was no concrete case for reserving
// beyond this one field. See LAYOUT_BUFFER_SIZE's own comment for the
// buffer-size-side half of this bump.

// Radial/conic gradient center + radial's shape/size (P4 step 3): unlike
// linear's angle (which reused BG_GRADIENT_GEOMETRY's own already-
// reserved geom[0]), radial/conic's CENTER POSITION genuinely needs its
// own new fields — it depends on box size at emission time exactly like
// linear's angle did, but P5c's own BG_POSITION_X/Y_TAG fields are NOT a
// safe alias: a node can have BOTH a background-image <img>/layer entry
// AND a background-image gradient at once (CSS's background-image list
// can mix url()s and gradients), so P5c's fields might be live with real,
// DIFFERENT data on the very same node at the very same time — aliasing
// would silently corrupt one or the other. Center position is SHARED
// shape between radial and conic (both take `at <position>`); radial ALSO
// needs its own shape (circle/ellipse) + size-keyword (closest-side/
// farthest-side/closest-corner/farthest-corner/explicit) + explicit radii
// (only meaningful when size-keyword is "explicit"). Conic's `from
// <angle>` needs NO new field — an angle alone has no box-size dependency
// (unlike linear's, which needs the LENGTH formula's w/h), so it's fully
// pre-resolved in JS (deg->rad) straight into BG_GRADIENT_GEOMETRY's
// existing geom[2] slot, same as linear's own geom[0].
//
// NODE-STRUCT STRIDE BUMP (648->672, +24 B, 8-byte-aligned): the only
// genuinely free, contiguous space (the 48 B tail after CHANGED_GEN) is
// OFF LIMITS for real fields — session.js's write-if-changed diffs only
// [0, CHANGED_GEN), so anything placed after it would be invisible to
// incremental-update change detection (a gradient's stops/center changing
// between frames would silently never invalidate the cached render). No
// safe alias existed (see above) and the tail is the wrong side of
// CHANGED_GEN, so — same reasoning and same "never alias, always bump"
// rule as S5's own 640->648 bump — this needed a real stride bump. Sized
// to +24 (not the exact 20 B needed) to stay 8-byte aligned, same
// alignment discipline the struct has held throughout.
export const LAYOUT_NODE_OFFSET_BG_CENTER_X_TAG = layoutConstant("NODE_BG_CENTER_X_TAG"); // u8: SIZE_TAG_LENGTH/PERCENT (radial+conic `at <position>`)
export const LAYOUT_NODE_OFFSET_BG_CENTER_Y_TAG = layoutConstant("NODE_BG_CENTER_Y_TAG"); // u8
export const LAYOUT_NODE_OFFSET_RADIAL_SHAPE = layoutConstant("NODE_RADIAL_SHAPE"); // u8: RADIAL_SHAPE_CIRCLE/ELLIPSE, default ellipse
export const LAYOUT_NODE_OFFSET_RADIAL_SIZE_KEYWORD = layoutConstant("NODE_RADIAL_SIZE_KEYWORD"); // u8: RADIAL_SIZE_* enum, default farthest-corner
export const LAYOUT_NODE_OFFSET_BG_CENTER_X = layoutConstant("NODE_BG_CENTER_X"); // f32: length(LU) or percent 0..100
export const LAYOUT_NODE_OFFSET_BG_CENTER_Y = layoutConstant("NODE_BG_CENTER_Y"); // f32
export const LAYOUT_NODE_OFFSET_RADIAL_EXPLICIT_RX = layoutConstant("NODE_RADIAL_EXPLICIT_RX"); // f32: only meaningful when RADIAL_SIZE_EXPLICIT
export const LAYOUT_NODE_OFFSET_RADIAL_EXPLICIT_RY = layoutConstant("NODE_RADIAL_EXPLICIT_RY"); // f32
// clip-path (design/paint-coverage.md P9): ONE-BASED index into
// CLIP_PATH_POOL (pool entry k is stored as k+1); 0 = none, so a zeroed
// struct naturally reads as "no clip-path" and hand-written node writers
// (test/helpers/scene.js, test/oracle/sandom-layout.js—
// they all zero the struct first) need no knowledge of this field.
// Sits BEFORE CHANGED_GEN so change tracking sees it.
export const LAYOUT_NODE_OFFSET_CLIP_PATH_INDEX = layoutConstant("NODE_CLIP_PATH_INDEX"); // u16
// Requested scrolling input. These live in the reserved
// post-style tail because the float-layout scratch already occupies that
// region and moving every scratch field would add risk without changing
// the wire format. session.js compares and writes these two fields
// explicitly, then stamps CHANGED_GEN when either changes.
export const LAYOUT_NODE_OFFSET_SCROLL_LEFT = layoutConstant("NODE_SCROLL_LEFT"); // i32 LayoutUnits: requested scrollLeft
export const LAYOUT_NODE_OFFSET_SCROLL_TOP = layoutConstant("NODE_SCROLL_TOP"); // i32 LayoutUnits: requested scrollTop
export const LAYOUT_NODE_OFFSET_POSITION_STICKY = layoutConstant("NODE_POSITION_STICKY"); // u8: paint-time sticky constraints enabled
// The shaping context of the node: its content language (HTML "The lang
// and xml:lang attributes": the lang attribute of the nearest inclusive
// ancestor element that has one) and its font feature set, as an index
// into LANGUAGE_TABLE and LANGUAGE_TABLE_FEATURES; 0 when the node has
// neither. The DOM core writes it for every box, text included.
export const LAYOUT_NODE_OFFSET_LANGUAGE = layoutConstant("NODE_LANGUAGE"); // u8: LANGUAGE_TABLE index
// The authored font stack of a text node (design/font-fallback.md):
// a FONT_STACK_TABLE index, or 0 for a stack of LAYOUT_NODE_OFFSET_FONT_INDEX
// alone. Past CHANGED_GEN, so the core's row diff compares it explicitly.
export const LAYOUT_NODE_OFFSET_FONT_STACK = layoutConstant("NODE_FONT_STACK"); // u16
export const LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_MARGIN = layoutConstant("NODE_OVERFLOW_CLIP_MARGIN"); // f32 px
export const LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_BOX = layoutConstant("NODE_OVERFLOW_CLIP_BOX"); // u8 bits 0-1 (SCROLLBAR_CLIP_BOX_MASK): 0=padding,1=border,2=content
export const LAYOUT_NODE_OFFSET_SCROLL_ORIGIN_RIGHT = layoutConstant("NODE_SCROLL_ORIGIN_RIGHT"); // u8 bit 0 (SCROLLBAR_ORIGIN_RIGHT_MASK): exposed horizontal scroll origin is right
// Classic scrollbars (design/scrollbars.md, decision 3). A
// classic bar takes its thickness from the scroll container's content box:
// the record holds it as extra padding on the bar's side. Overlay bars take
// no space and set none of these bits.
//
// SCROLLBAR_LAYOUT shares the OVERFLOW_CLIP_BOX byte (bits 2-7). The core
// writes it from style: the thickness code, the side of the vertical bar,
// and the reservations it already added to the padding (overflow: scroll,
// scrollbar-gutter: stable).
//
// SCROLLBAR_STATE shares the SCROLL_ORIGIN_RIGHT byte (bits 1-4). The core
// writes the AUTO bits: an overflow: auto axis takes a bar only when its
// content overflows. The engine decides that after a full layout pass, adds
// the bar to the padding, sets the APPLIED bit, and lays out again
// (engine-flex.watpart, $settleClassicScrollbars). The core's row diff
// compares the row without its applied bars and keeps them on a row that
// did not change (core-transport.watpart).
export const LAYOUT_NODE_OFFSET_SCROLLBAR_LAYOUT = layoutConstant("NODE_SCROLLBAR_LAYOUT"); // u8 bits 2-7, aliases OVERFLOW_CLIP_BOX
export const LAYOUT_NODE_OFFSET_SCROLLBAR_STATE = layoutConstant("NODE_SCROLLBAR_STATE"); // u8 bits 1-4, aliases SCROLL_ORIGIN_RIGHT
export const SCROLLBAR_CLIP_BOX_MASK = layoutConstant("SCROLLBAR_CLIP_BOX_MASK");
export const SCROLLBAR_ORIGIN_RIGHT_MASK = layoutConstant("SCROLLBAR_ORIGIN_RIGHT_MASK");
export const SCROLLBAR_THICKNESS_SHIFT = layoutConstant("SCROLLBAR_THICKNESS_SHIFT"); // 2 bits: 0 = no bar, 1 = regular, 2 = thin
export const SCROLLBAR_THICKNESS_MASK = layoutConstant("SCROLLBAR_THICKNESS_MASK");
export const SCROLLBAR_VERTICAL_LEFT = layoutConstant("SCROLLBAR_VERTICAL_LEFT"); // the vertical bar is on the left (direction: rtl)
export const SCROLLBAR_BOTH_EDGES = layoutConstant("SCROLLBAR_BOTH_EDGES"); // scrollbar-gutter: stable both-edges reserved both sides
export const SCROLLBAR_VERTICAL_RESERVED = layoutConstant("SCROLLBAR_VERTICAL_RESERVED"); // the vertical bar's side is in the padding
export const SCROLLBAR_HORIZONTAL_RESERVED = layoutConstant("SCROLLBAR_HORIZONTAL_RESERVED"); // the bottom bar is in the padding
export const SCROLLBAR_VERTICAL_AUTO = layoutConstant("SCROLLBAR_VERTICAL_AUTO"); // overflow-y: auto
export const SCROLLBAR_HORIZONTAL_AUTO = layoutConstant("SCROLLBAR_HORIZONTAL_AUTO"); // overflow-x: auto
export const SCROLLBAR_VERTICAL_APPLIED = layoutConstant("SCROLLBAR_VERTICAL_APPLIED"); // the engine added the vertical bar
export const SCROLLBAR_HORIZONTAL_APPLIED = layoutConstant("SCROLLBAR_HORIZONTAL_APPLIED"); // the engine added the horizontal bar
// Chromium's macOS classic thickness (scrollbar_theme_mac.cc), CSS px.
export const SCROLLBAR_REGULAR_THICKNESS = layoutConstant("SCROLLBAR_REGULAR_THICKNESS");
export const SCROLLBAR_THIN_THICKNESS = layoutConstant("SCROLLBAR_THIN_THICKNESS");
// The unicode-bidi keyword in bits 0-3 (UNICODE_BIDI_NORMAL through
// UNICODE_BIDI_PLAINTEXT). Bit 7 (UNICODE_BIDI_TEXT_ALIGN_LOGICAL) is set
// when TEXT_ALIGN was resolved from start, end, justify or no value: a
// unicode-bidi: plaintext container mirrors that alignment on each line
// whose paragraph direction differs from its own direction.
export const LAYOUT_NODE_OFFSET_UNICODE_BIDI = layoutConstant("NODE_UNICODE_BIDI"); // u8
export const UNICODE_BIDI_NORMAL = layoutConstant("UNICODE_BIDI_NORMAL");
export const UNICODE_BIDI_EMBED = layoutConstant("UNICODE_BIDI_EMBED");
export const UNICODE_BIDI_ISOLATE = layoutConstant("UNICODE_BIDI_ISOLATE");
export const UNICODE_BIDI_BIDI_OVERRIDE = layoutConstant("UNICODE_BIDI_BIDI_OVERRIDE");
export const UNICODE_BIDI_ISOLATE_OVERRIDE = layoutConstant("UNICODE_BIDI_ISOLATE_OVERRIDE");
export const UNICODE_BIDI_PLAINTEXT = layoutConstant("UNICODE_BIDI_PLAINTEXT");
export const UNICODE_BIDI_KEYWORD_MASK = layoutConstant("UNICODE_BIDI_KEYWORD_MASK");
export const UNICODE_BIDI_TEXT_ALIGN_LOGICAL = layoutConstant("UNICODE_BIDI_TEXT_ALIGN_LOGICAL");
// 1 when the box's CSS direction is rtl: its inline formatting context
// starts lines at the line-right edge, resolves text-align start/end, and
// orders mixed-direction content with the Unicode Bidirectional Algorithm;
// an inline box with this bit puts its start edges on its right side.
export const LAYOUT_NODE_OFFSET_INLINE_DIRECTION_RTL = layoutConstant("NODE_INLINE_DIRECTION_RTL"); // u8
// background-origin (BUG-background-origin-not-modeled, resolved; see
// activity/reports/REPORT-2026-10-09-resolved-bug-records.md): the box the
// background POSITIONING area is (gradient geometry, bg-image layer
// size/position/tile anchor) — independent of BACKGROUND_CLIP, which
// keeps governing only the clip. 0 = padding-box so a zeroed struct
// reads as the CSS initial value (NOTE the enum order differs from
// BACKGROUND_CLIP's, whose own initial value is border-box=0 — both
// enums put their CSS initial at 0, which is what a zeroed struct
// must mean). Sits BEFORE CHANGED_GEN so change tracking sees it.
export const LAYOUT_NODE_OFFSET_BACKGROUND_ORIGIN = layoutConstant("NODE_BACKGROUND_ORIGIN"); // u8: 0=padding-box,1=border-box,2=content-box
export const LAYOUT_NODE_OFFSET_TEXT_DECORATION = layoutConstant("NODE_TEXT_DECORATION"); // u8 bitmask: underline/line-through/overline
// Grid wire tags. P0 reserved values but omitted the tags required to
// distinguish auto, line, span, and track sizing-function kinds.
export const LAYOUT_NODE_OFFSET_GRID_ROW_START_KIND = layoutConstant("NODE_GRID_ROW_START_KIND"); // u8
export const LAYOUT_NODE_OFFSET_GRID_ROW_END_KIND = layoutConstant("NODE_GRID_ROW_END_KIND"); // u8
export const LAYOUT_NODE_OFFSET_GRID_COL_START_KIND = layoutConstant("NODE_GRID_COL_START_KIND"); // u8
export const LAYOUT_NODE_OFFSET_GRID_COL_END_KIND = layoutConstant("NODE_GRID_COL_END_KIND"); // u8
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MIN_TYPE = layoutConstant("NODE_GRID_AUTO_ROWS_MIN_TYPE"); // u8
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MAX_TYPE = layoutConstant("NODE_GRID_AUTO_ROWS_MAX_TYPE"); // u8
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MIN_TYPE = layoutConstant("NODE_GRID_AUTO_COLS_MIN_TYPE"); // u8
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MAX_TYPE = layoutConstant("NODE_GRID_AUTO_COLS_MAX_TYPE"); // u8
export const TEXT_DECORATION_UNDERLINE = layoutConstant("TEXT_DECORATION_UNDERLINE");
export const TEXT_DECORATION_LINE_THROUGH = layoutConstant("TEXT_DECORATION_LINE_THROUGH");
export const TEXT_DECORATION_OVERLINE = layoutConstant("TEXT_DECORATION_OVERLINE");
// The decoration details of a DISPLAY_TEXT node are valid: the DOM core
// wrote each line's color, thickness and style, and the underline offset
// and position, into the fields below. Without the bit a line paints in the
// text color, solid, at the font's thickness.
export const TEXT_DECORATION_DETAILS = layoutConstant("TEXT_DECORATION_DETAILS");
// Text paint fields of a DISPLAY_TEXT node, their own paint-field block of
// TEXT_PAINT_FIELDS_SIZE bytes. The decoration details
// (core/dom/text-decoration.watpart): colors f32[4] per line
// (underline, line-through, overline, in the order of the
// TEXT_DECORATION_* bits), thicknesses f32 per line in CSS px (-1 auto, -2
// from-font), the underline offset f32 in CSS px (NaN auto), the styles u8
// per line (0 solid, 1 double, 2 dotted, 3 dashed, 4 wavy) and the
// underline position u8 (0 auto, 1 under, 2 from-font). Then the paint
// order of SVG text u8 (0 fill before stroke, SVG_PAINT_ORDER_STROKE_FIRST
// stroke before fill), text-decoration-skip-ink u8 (0 auto,
// TEXT_DECORATION_SKIP_INK_NONE, TEXT_DECORATION_SKIP_INK_ALL), and the
// emphasis mark (core/dom/text-paint-fields.watpart): flags u8
// (TEXT_EMPHASIS_UNDER, TEXT_EMPHASIS_CURRENT_COLOR: the mark paints in the
// text color), the mark's character u32 (0 none), its color RGBA8 u32
// (red in the low byte).
export const LAYOUT_NODE_OFFSET_TEXT_DECORATION_COLORS = layoutConstant("NODE_TEXT_DECORATION_COLORS"); // f32[4] x 3
export const LAYOUT_NODE_OFFSET_TEXT_DECORATION_THICKNESS = layoutConstant("NODE_TEXT_DECORATION_THICKNESS"); // f32 x 3
export const LAYOUT_NODE_OFFSET_TEXT_UNDERLINE_OFFSET = layoutConstant("NODE_TEXT_UNDERLINE_OFFSET"); // f32
export const LAYOUT_NODE_OFFSET_TEXT_DECORATION_STYLES = layoutConstant("NODE_TEXT_DECORATION_STYLES"); // u8 x 3
export const LAYOUT_NODE_OFFSET_TEXT_UNDERLINE_POSITION = layoutConstant("NODE_TEXT_UNDERLINE_POSITION"); // u8
export const LAYOUT_NODE_OFFSET_SVG_PAINT_ORDER = layoutConstant("NODE_SVG_PAINT_ORDER"); // u8
export const LAYOUT_NODE_OFFSET_TEXT_DECORATION_SKIP_INK = layoutConstant("NODE_TEXT_DECORATION_SKIP_INK"); // u8
export const LAYOUT_NODE_OFFSET_TEXT_EMPHASIS_FLAGS = layoutConstant("NODE_TEXT_EMPHASIS_FLAGS"); // u8
export const LAYOUT_NODE_OFFSET_TEXT_EMPHASIS_MARK = layoutConstant("NODE_TEXT_EMPHASIS_MARK"); // u32
export const LAYOUT_NODE_OFFSET_TEXT_EMPHASIS_COLOR = layoutConstant("NODE_TEXT_EMPHASIS_COLOR"); // u32
export const TEXT_PAINT_FIELDS_SIZE = layoutConstant("TEXT_PAINT_FIELDS_SIZE");
export const SVG_PAINT_ORDER_STROKE_FIRST = layoutConstant("SVG_PAINT_ORDER_STROKE_FIRST");
export const TEXT_DECORATION_SKIP_INK_NONE = layoutConstant("TEXT_DECORATION_SKIP_INK_NONE");
export const TEXT_DECORATION_SKIP_INK_ALL = layoutConstant("TEXT_DECORATION_SKIP_INK_ALL");
export const TEXT_EMPHASIS_UNDER = layoutConstant("TEXT_EMPHASIS_UNDER");
export const TEXT_EMPHASIS_CURRENT_COLOR = layoutConstant("TEXT_EMPHASIS_CURRENT_COLOR");
export const TEXT_DECORATION_STYLE_DOUBLE = layoutConstant("TEXT_DECORATION_STYLE_DOUBLE");
export const TEXT_DECORATION_STYLE_DOTTED = layoutConstant("TEXT_DECORATION_STYLE_DOTTED");
export const TEXT_DECORATION_STYLE_DASHED = layoutConstant("TEXT_DECORATION_STYLE_DASHED");
export const TEXT_DECORATION_STYLE_WAVY = layoutConstant("TEXT_DECORATION_STYLE_WAVY");
// 0x274: style boundary

// Radial gradient shape (P4 step 3, css-images-3's radial-gradient()
// <radial-shape>). Mirrors engine.wat's matching enum.
export const RADIAL_SHAPE_CIRCLE = layoutConstant("RADIAL_SHAPE_CIRCLE");
export const RADIAL_SHAPE_ELLIPSE = layoutConstant("RADIAL_SHAPE_ELLIPSE"); // default

// Radial gradient size keyword (P4 step 3, css-images-3's <radial-size>).
// Mirrors engine.wat's matching enum.
export const RADIAL_SIZE_CLOSEST_SIDE = layoutConstant("RADIAL_SIZE_CLOSEST_SIDE");
export const RADIAL_SIZE_FARTHEST_SIDE = layoutConstant("RADIAL_SIZE_FARTHEST_SIDE");
export const RADIAL_SIZE_CLOSEST_CORNER = layoutConstant("RADIAL_SIZE_CLOSEST_CORNER");
export const RADIAL_SIZE_FARTHEST_CORNER = layoutConstant("RADIAL_SIZE_FARTHEST_CORNER"); // default
export const RADIAL_SIZE_EXPLICIT = layoutConstant("RADIAL_SIZE_EXPLICIT");
// With RADIAL_SIZE_EXPLICIT, these bits of the size byte mark a radius that
// is a percentage of the gradient box width (x) or height (y).
export const RADIAL_SIZE_RX_PERCENT = layoutConstant("RADIAL_SIZE_RX_PERCENT");
export const RADIAL_SIZE_RY_PERCENT = layoutConstant("RADIAL_SIZE_RY_PERCENT");

// Change tracking (generation invalidation, see design/layout-engine.md).
// MUST be the LAST style field — see the P0 block comment above.
export const LAYOUT_NODE_OFFSET_CHANGED_GEN = layoutConstant("NODE_CHANGED_GEN"); // u32

// Clearance/pushed decision scratch (design/floats.md) — a
// LAYOUT-scratch record PAST the style range ([0, CHANGED_GEN) is what
// write-if-changed diffing covers; the writers never touch these bytes).
// The engine records each clearance/pushed decision here together with
// the $layoutPassGen it was made under; a CHAIN-site re-test in the SAME
// gen (a corrective relayout) reuses the decision instead of re-deriving
// it (the corrected position would double-count the applied strut), so
// cross-scene/cross-pass staleness is impossible by gen mismatch.
// Mirrors engine.wat's $NODE_CLEARANCE_SCRATCH / $NODE_CLEARANCE_GEN —
// keep in lockstep.
// bit0 clearance-on, bit1 clearance-decided, bit2 pushed-on, bit3 pushed-decided.
export const LAYOUT_NODE_OFFSET_CLEARANCE_SCRATCH = layoutConstant("NODE_CLEARANCE_SCRATCH"); // u8
export const LAYOUT_NODE_OFFSET_CLEARANCE_GEN = layoutConstant("NODE_CLEARANCE_GEN"); // u32
// F3 6b: the vertical-fit retry origin — where this box's avoidance
// resumes its opportunity search after a post-layout misfit (a float
// jutting into its span, reachable only via cleared floats). Own gen
// guard (the decision gen above has different write semantics).
export const LAYOUT_NODE_OFFSET_AVOID_RETRY_ORIGIN = layoutConstant("NODE_AVOID_RETRY_ORIGIN"); // f32
export const LAYOUT_NODE_OFFSET_AVOID_RETRY_GEN = layoutConstant("NODE_AVOID_RETRY_GEN"); // u32
// F4 fuzz: the cbY the misfit was recorded at — the origin is honored
// only by a same-position re-run (the fit-retry loop); repositioned
// relayouts re-derive fresh. Mirrors engine.wat's $NODE_AVOID_RETRY_FROM.
export const LAYOUT_NODE_OFFSET_AVOID_RETRY_FROM = layoutConstant("NODE_AVOID_RETRY_FROM"); // f32

// F4 finding #33: the layout-pass generation in which this new-FC box's
// pushed-margin SEPARATION fired. Blink's separation is a one-way ratchet
// within one parent layout attempt (bla.cc:1943); sandom's provisional →
// correction re-runs together model that single attempt, so a gen-matching
// record forces the separated path even when a re-corrected frame no longer
// shows the push (tree #1276's minimal oscillated between the separated and
// unseparated reports otherwise). Mirrors engine.wat's $NODE_SEPARATED_GEN.
export const LAYOUT_NODE_OFFSET_SEPARATED_GEN = layoutConstant("NODE_SEPARATED_GEN"); // u32
// F4 finding #4103-third: the $layoutInvocationGen (NOT $layoutPassGen) in
// which an interior collapse-through child of this box took the
// RESOLVED-flavor clearance pin path. A cleared self-collapsing wrapper
// carrying such an interior pin is a pure pass-through — its own pin by an
// outer wrapper must not content-separate that wrapper (the nested cleared
// chain stays self-collapsing). Keyed on the invocation gen so it survives
// the #29 chain-abort $layoutPassGen bump between the interior pin and the
// wrapper's own pin. Mirrors engine.wat's $NODE_INTERIOR_CLEAR_PIN_GEN.
export const LAYOUT_NODE_OFFSET_INTERIOR_CLEAR_PIN_GEN = layoutConstant("NODE_INTERIOR_CLEAR_PIN_GEN"); // u32
// style ends at 0x278
// scratch uses 0x278-0x293

// <length-percentage> coefficients. A length or a percentage keeps its own
// tag and zeroes the companion; TAG_CALC_PAIR stores pixels in the original
// value field and the percentage fraction (or NaN for a length expression)
// here.
export const LAYOUT_NODE_OFFSET_WIDTH_PERCENT = layoutConstant("NODE_WIDTH_PERCENT");
export const LAYOUT_NODE_OFFSET_HEIGHT_PERCENT = layoutConstant("NODE_HEIGHT_PERCENT");
export const LAYOUT_NODE_OFFSET_MIN_WIDTH_PERCENT = layoutConstant("NODE_MIN_WIDTH_PERCENT");
export const LAYOUT_NODE_OFFSET_MIN_HEIGHT_PERCENT = layoutConstant("NODE_MIN_HEIGHT_PERCENT");
export const LAYOUT_NODE_OFFSET_MAX_WIDTH_PERCENT = layoutConstant("NODE_MAX_WIDTH_PERCENT");
export const LAYOUT_NODE_OFFSET_MAX_HEIGHT_PERCENT = layoutConstant("NODE_MAX_HEIGHT_PERCENT");
export const LAYOUT_NODE_OFFSET_INSET_TOP_PERCENT = layoutConstant("NODE_INSET_TOP_PERCENT");
export const LAYOUT_NODE_OFFSET_INSET_RIGHT_PERCENT = layoutConstant("NODE_INSET_RIGHT_PERCENT");
export const LAYOUT_NODE_OFFSET_INSET_BOTTOM_PERCENT = layoutConstant("NODE_INSET_BOTTOM_PERCENT");
export const LAYOUT_NODE_OFFSET_INSET_LEFT_PERCENT = layoutConstant("NODE_INSET_LEFT_PERCENT");
export const LAYOUT_NODE_OFFSET_FLEX_BASIS_PERCENT = layoutConstant("NODE_FLEX_BASIS_PERCENT");
// One byte of the node struct's tail padding (0x2D4..0x2D7): the packed
// gradient interpolation identifiers (see GRADIENT_SPACE_NAMES).
export const LAYOUT_NODE_OFFSET_GRADIENT_INTERPOLATION = layoutConstant("NODE_GRADIENT_INTERPOLATION");
// CSS transform-origin coefficients. The animation resolver combines each
// pixel offset and percentage with the post-layout border-box dimensions.
export const LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X = layoutConstant("NODE_TRANSFORM_ORIGIN_X");
export const LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT = layoutConstant("NODE_TRANSFORM_ORIGIN_X_PERCENT");
export const LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y = layoutConstant("NODE_TRANSFORM_ORIGIN_Y");
export const LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT = layoutConstant("NODE_TRANSFORM_ORIGIN_Y_PERCENT");
// CSS transform form. 0: the affine in LAYOUT_NODE_OFFSET_TRANSFORM is the
// node's own transform around its border-box center, as the scene writer
// resolves it. 1: the affine is the CSS transform list composed with its
// translation linear in the border box — e += ew * w + eh * h, f += fw * w
// + fh * h from TRANSFORM_PERCENT — and the engine folds it around
// transform-origin at compose time (the DOM core's records; no provisional
// layout is needed for percentage translations). An animation sample
// overwrites the affine with form 0.
export const LAYOUT_NODE_OFFSET_TRANSFORM_KIND = layoutConstant("NODE_TRANSFORM_KIND"); // u8
export const LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT = layoutConstant("NODE_TRANSFORM_PERCENT"); // f32[4]: ew, eh, fw, fh
export const TRANSFORM_KIND_RESOLVED = layoutConstant("TRANSFORM_KIND_RESOLVED");
export const TRANSFORM_KIND_CSS = layoutConstant("TRANSFORM_KIND_CSS");
// Multi-column containers (CSS Multi-column Layout 1). A block container is
// a multi-column container when its column count is set or its column width
// is positive. COLUMN_WIDTH shares its bytes with BORDER_SPACING_X: a
// multi-column container is never a table. COLUMN_GAP holds the used gap in
// pixels, or -1 for `normal` (1em), plus GRID_COLUMN_GAP_PERCENTAGE as a
// fraction of the content width.
export const LAYOUT_NODE_OFFSET_COLUMN_COUNT = layoutConstant("NODE_COLUMN_COUNT"); // u8: 0=auto, else the count (clamped to 255)
// The break byte: bit 0 is break-inside (BREAK_INSIDE_AVOID); bits 1-3 hold
// break-before and bits 4-6 break-after, each a BREAK_CODE_* value; bit 7
// is box-decoration-break: clone (BOX_DECORATION_BREAK_CLONE).
export const LAYOUT_NODE_OFFSET_BREAK_INSIDE = layoutConstant("NODE_BREAK_INSIDE"); // u8
export const BREAK_INSIDE_AUTO = layoutConstant("BREAK_INSIDE_AUTO");
export const BREAK_INSIDE_AVOID = layoutConstant("BREAK_INSIDE_AVOID");
export const BOX_DECORATION_BREAK_CLONE = layoutConstant("BOX_DECORATION_BREAK_CLONE");
export const BREAK_BEFORE_SHIFT = layoutConstant("BREAK_BEFORE_SHIFT");
export const BREAK_AFTER_SHIFT = layoutConstant("BREAK_AFTER_SHIFT");
export const BREAK_CODE_AUTO = layoutConstant("BREAK_CODE_AUTO");
export const BREAK_CODE_AVOID = layoutConstant("BREAK_CODE_AVOID"); // avoid, avoid-page
export const BREAK_CODE_PAGE = layoutConstant("BREAK_CODE_PAGE"); // page, always, all
export const BREAK_CODE_LEFT = layoutConstant("BREAK_CODE_LEFT"); // left, verso
export const BREAK_CODE_RIGHT = layoutConstant("BREAK_CODE_RIGHT"); // right, recto
export const BREAK_CODE_COLUMN = layoutConstant("BREAK_CODE_COLUMN");
export const BREAK_CODE_AVOID_COLUMN = layoutConstant("BREAK_CODE_AVOID_COLUMN");
export const LAYOUT_NODE_OFFSET_COLUMN_WIDTH = layoutConstant("NODE_COLUMN_WIDTH"); // f32: px; 0=auto (aliases BORDER_SPACING_X)
// orphans and widows (CSS Fragmentation 3): the least line boxes a column
// fragment of a block keeps before and after a break inside it. Inherited
// integers, default 2, clamped to 1..255. 0x2FB holds
// LAYOUT_NODE_OFFSET_LINE_BREAK; 0x2FC..0x2FF hold
// LAYOUT_NODE_OFFSET_PAINT_GEN.
export const LAYOUT_NODE_OFFSET_ORPHANS = layoutConstant("NODE_ORPHANS"); // u8
export const LAYOUT_NODE_OFFSET_WIDOWS = layoutConstant("NODE_WIDOWS"); // u8
// An SVG shape whose fill or stroke is `currentcolor` (CSS Color 4: the
// keyword computes to itself, so its used value is the shape's own
// `color`). The shape paints that paint with TEXT_COLOR, which a running
// `color` animation samples into the shape, rather than SVG_FILL_COLOR or
// SVG_STROKE_COLOR, which hold the color when the record was written.
export const LAYOUT_NODE_OFFSET_SVG_PAINT_CURRENT_COLOR = layoutConstant("NODE_SVG_PAINT_CURRENT_COLOR"); // u8: SVG_PAINT_CURRENT_COLOR_* bits
export const SVG_PAINT_CURRENT_COLOR_FILL = layoutConstant("SVG_PAINT_CURRENT_COLOR_FILL");
export const SVG_PAINT_CURRENT_COLOR_STROKE = layoutConstant("SVG_PAINT_CURRENT_COLOR_STROKE");
export const SVG_PAINT_NON_SCALING_STROKE = layoutConstant("SVG_PAINT_NON_SCALING_STROKE");
// line-break (CSS Text 3 §5.3) in bits 0-2, word-break (§5.2) in bits 3-4
// and text-spacing-trim (CSS Text 4 §9.2) in bits 5-6. All are inherited;
// the DOM core writes them for every box beside TEXT_BEHAVIOR.
// word-break: normal sets neither word-break bit; word-break: break-word
// sets neither and sets TEXT_BEHAVIOR_BREAK_ANYWHERE, as
// overflow-wrap: anywhere does.
export const LAYOUT_NODE_OFFSET_LINE_BREAK = layoutConstant("NODE_LINE_BREAK"); // u8: LINE_BREAK_* | WORD_BREAK_* | TEXT_SPACING_TRIM_*
export const LINE_BREAK_AUTO = layoutConstant("LINE_BREAK_AUTO");
export const LINE_BREAK_LOOSE = layoutConstant("LINE_BREAK_LOOSE");
export const LINE_BREAK_NORMAL = layoutConstant("LINE_BREAK_NORMAL");
export const LINE_BREAK_STRICT = layoutConstant("LINE_BREAK_STRICT");
export const LINE_BREAK_ANYWHERE = layoutConstant("LINE_BREAK_ANYWHERE");
export const LINE_BREAK_STRICTNESS_MASK = layoutConstant("LINE_BREAK_STRICTNESS_MASK");
export const WORD_BREAK_BREAK_ALL = layoutConstant("WORD_BREAK_BREAK_ALL");
export const WORD_BREAK_KEEP_ALL = layoutConstant("WORD_BREAK_KEEP_ALL");
export const TEXT_SPACING_TRIM_SHIFT = layoutConstant("TEXT_SPACING_TRIM_SHIFT");
export const TEXT_SPACING_TRIM_MASK = layoutConstant("TEXT_SPACING_TRIM_MASK");
export const TEXT_SPACING_TRIM_NORMAL = layoutConstant("TEXT_SPACING_TRIM_NORMAL");
export const TEXT_SPACING_TRIM_SPACE_ALL = layoutConstant("TEXT_SPACING_TRIM_SPACE_ALL");
export const TEXT_SPACING_TRIM_SPACE_FIRST = layoutConstant("TEXT_SPACING_TRIM_SPACE_FIRST");
export const TEXT_SPACING_TRIM_TRIM_START = layoutConstant("TEXT_SPACING_TRIM_TRIM_START");
// The generation of the node's last paint-only change: a change of fields
// no layout function reads (the DOM core's EngineFrameFact flag 8). Such a
// change leaves CHANGED_GEN, the layout's generation, as it was, so every
// layout cache and the whole-pass reuse keep; paint and damage read the
// larger of the two. A writer that stamps CHANGED_GEN needs no knowledge of
// this field. Past the tracked style bytes, like CHANGED_GEN itself.
export const LAYOUT_NODE_OFFSET_PAINT_GEN = layoutConstant("NODE_PAINT_GEN"); // u32
// text-indent (CSS Text 3 §8.1): the indent of the indented lines of a
// block container is TEXT_INDENT px plus TEXT_INDENT_PERCENT times its
// content-box inline size; a NaN TEXT_INDENT_PERCENT marks a length
// expression whose interned identifier TEXT_INDENT holds, evaluated at that
// size. TEXT_INDENT_FLAGS holds the hanging and
// each-line keywords. Inherited; the engine reads it on an inline
// formatting context root and on a text leaf that lays itself out. Past
// CHANGED_GEN, so the core's row diff compares it explicitly.
export const LAYOUT_NODE_OFFSET_TEXT_INDENT = layoutConstant("NODE_TEXT_INDENT"); // f32 px
export const LAYOUT_NODE_OFFSET_TEXT_INDENT_PERCENT = layoutConstant("NODE_TEXT_INDENT_PERCENT"); // f32 fraction of the content-box inline size
export const LAYOUT_NODE_OFFSET_TEXT_INDENT_FLAGS = layoutConstant("NODE_TEXT_INDENT_FLAGS"); // u8: TEXT_INDENT_* bits
export const TEXT_INDENT_HANGING = layoutConstant("TEXT_INDENT_HANGING");
export const TEXT_INDENT_EACH_LINE = layoutConstant("TEXT_INDENT_EACH_LINE");
// page (CSS Paged Media 3, 7.1): the node's page name, 0 for auto, else the
// DOM core's interned name (its page_name_text export). Not inherited; the
// engine resolves auto through the parents. Past CHANGED_GEN, so the core's
// row diff compares it explicitly.
export const LAYOUT_NODE_OFFSET_PAGE_NAME = layoutConstant("NODE_PAGE_NAME"); // u16
// A page-margin box (CSS Paged Media 3, 5): 0 for any other box, else its
// index plus 1 in the DOM core's page-margin names (page-rules.watpart).
// The DOM core writes it on the generated margin boxes of the root element
// in page mode; the engine lays them out in the page margins of every page.
export const LAYOUT_NODE_OFFSET_PAGE_MARGIN = layoutConstant("NODE_PAGE_MARGIN"); // u8
// Justification (CSS Text 3 §7.1-§7.4), one byte past CHANGED_GEN like
// text-indent. TEXT_ALIGN keeps the side of an ordinary line (the start
// side for justify). TEXT_ALIGN_JUSTIFY: text-align is justify, so the
// engine stretches each ordinary line. The last line and a line that
// ends in a forced break take text-align-last: with TEXT_ALIGN_LAST_SET
// clear (auto) they take the TEXT_ALIGN side and no justification; with
// it set they take the side in bits 0-1 (TEXT_ALIGN_LEFT, _CENTER,
// _RIGHT), justified when TEXT_ALIGN_LAST_JUSTIFY is set.
// TEXT_ALIGN_LAST_LOGICAL marks that side as resolved from start, end or
// justify (a unicode-bidi: plaintext line mirrors it, as
// UNICODE_BIDI_TEXT_ALIGN_LOGICAL does for TEXT_ALIGN). Bits 6-7 hold
// text-justify (TEXT_JUSTIFY_*): the engine reads the IFC root's byte for
// the alignment and each item's own byte for text-justify. Inherited.
export const LAYOUT_NODE_OFFSET_TEXT_JUSTIFICATION = layoutConstant("NODE_TEXT_JUSTIFICATION"); // u8
// The line clamp of a -webkit-box that clamps its lines (computed display
// flow-root or inline-block; scene.watpart $sceneWebkitBoxClamps): its
// -webkit-line-clamp, 1..255, or 0 for none. Block layout ends the box's
// auto height at the bottom of that line of its block flow.
export const LAYOUT_NODE_OFFSET_LINE_CLAMP = layoutConstant("NODE_LINE_CLAMP"); // u8

// Quirks mode (HTML, "Rendering": the html element fills the viewport, the
// body element fills the html element): QUIRKS_FILL_ROOT for the root
// element, QUIRKS_FILL_BODY for a body whose parent is the root element, 0
// for every other box. Block layout gives such a box with an auto height
// in flow at least the viewport's height less its margins (the body: the
// root's content box less its margins).
export const LAYOUT_NODE_OFFSET_QUIRKS_FILL = layoutConstant("NODE_QUIRKS_FILL"); // u8
export const QUIRKS_FILL_ROOT = layoutConstant("QUIRKS_FILL_ROOT");
export const QUIRKS_FILL_BODY = layoutConstant("QUIRKS_FILL_BODY");


// Percentage margins and paddings (CSS Box 3 §3.3, §4): MARGIN_* and
// PADDING_* hold each side's value with its percentage at 0 (a calc()
// side's pixel part; a length expression evaluated at a basis of 0, the
// value an intrinsic contribution takes). MARGIN_*_PERCENT and
// PADDING_*_PERCENT hold the side's percentage in percent units, NaN for a
// length expression (a min(), max() or clamp() that compares a percentage
// with other units), whose interned identifier is the side's u16 in
// EDGE_EXPRESSIONS (margin top, right, bottom, left, then padding). Layout
// resolves a side against the inline size of the containing block. Past
// CHANGED_GEN, so the core's row diff compares them explicitly.
export const LAYOUT_NODE_OFFSET_MARGIN_TOP_PERCENT = layoutConstant("NODE_MARGIN_TOP_PERCENT"); // f32
export const LAYOUT_NODE_OFFSET_MARGIN_RIGHT_PERCENT = layoutConstant("LAYOUT_NODE_OFFSET_MARGIN_RIGHT_PERCENT"); // f32
export const LAYOUT_NODE_OFFSET_MARGIN_BOTTOM_PERCENT = layoutConstant("LAYOUT_NODE_OFFSET_MARGIN_BOTTOM_PERCENT"); // f32
export const LAYOUT_NODE_OFFSET_MARGIN_LEFT_PERCENT = layoutConstant("LAYOUT_NODE_OFFSET_MARGIN_LEFT_PERCENT"); // f32
export const LAYOUT_NODE_OFFSET_PADDING_TOP_PERCENT = layoutConstant("NODE_PADDING_TOP_PERCENT"); // f32
export const LAYOUT_NODE_OFFSET_PADDING_RIGHT_PERCENT = layoutConstant("LAYOUT_NODE_OFFSET_PADDING_RIGHT_PERCENT"); // f32
export const LAYOUT_NODE_OFFSET_PADDING_BOTTOM_PERCENT = layoutConstant("LAYOUT_NODE_OFFSET_PADDING_BOTTOM_PERCENT"); // f32
export const LAYOUT_NODE_OFFSET_PADDING_LEFT_PERCENT = layoutConstant("LAYOUT_NODE_OFFSET_PADDING_LEFT_PERCENT"); // f32
export const LAYOUT_NODE_OFFSET_EDGE_EXPRESSIONS = layoutConstant("NODE_EDGE_EXPRESSIONS"); // u16[8]

// word-spacing and tab-size (CSS Text 3 §7.1 and §4.2) of a text box and
// of the element that holds it. WORD_SPACING is px, or percent units of
// the computed font size when TEXT_SPACING_WORD_SPACING_PERCENT is set.
// TAB_SIZE is a number of spaces, or px when TEXT_SPACING_TAB_SIZE_LENGTH
// is set. Past CHANGED_GEN, so the core's row diff compares them
// explicitly.
export const LAYOUT_NODE_OFFSET_WORD_SPACING = layoutConstant("NODE_WORD_SPACING"); // f32
export const LAYOUT_NODE_OFFSET_TAB_SIZE = layoutConstant("NODE_TAB_SIZE"); // f32
export const LAYOUT_NODE_OFFSET_TEXT_SPACING_FLAGS = layoutConstant("NODE_TEXT_SPACING_FLAGS"); // u8
export const TEXT_SPACING_TAB_SIZE_LENGTH = layoutConstant("TEXT_SPACING_TAB_SIZE_LENGTH");
export const TEXT_SPACING_WORD_SPACING_PERCENT = layoutConstant("TEXT_SPACING_WORD_SPACING_PERCENT");

// The motion path (CSS Motion Path 1): MOTION_PATH is the address of the
// DOM core's interned definition of the box's offset-path, offset-distance,
// offset-rotate, offset-anchor and offset-position, or 0 for offset-path:
// none. After each layout pass the DOM core writes MOTION, the affine
// (a, b, c, d, e, f) that moves the box along its path, in px relative to
// the border box's top-left corner. Paint and geometry apply it after the
// individual transforms and before `transform`.
export const LAYOUT_NODE_OFFSET_MOTION_PATH = layoutConstant("NODE_MOTION_PATH"); // u32
export const LAYOUT_NODE_OFFSET_MOTION = layoutConstant("NODE_MOTION"); // f32[6]

// 1 when the box is the containing block of its fixed and absolute
// descendants without being positioned: a transform, an individual
// transform property, a filter or skipped contents (the DOM core's
// $elementContainsFixed). Layout places a fixed descendant against its
// padding box instead of the viewport.
export const LAYOUT_NODE_OFFSET_CONTAINS_FIXED = layoutConstant("NODE_CONTAINS_FIXED"); // u8

// The individual transform properties (CSS Transforms 2): translate as
// f32[4] (x pixels, x fraction of the border-box width, y pixels, y
// fraction of the border-box height), rotate as an f32 angle in radians,
// scale as f32[2] (x, y), and a u8 that is 1 when they apply. The
// NODE_TRANSFORM fields hold the `transform` list alone; the engine
// composes translate, rotate, scale, then the list, around
// transform-origin, where it resolves a node's matrix ($nodeOwnAffine).
// A row with the byte 0 has no individual transform, whatever its values.
export const LAYOUT_NODE_OFFSET_INDIVIDUAL_TRANSLATE = layoutConstant("NODE_INDIVIDUAL_TRANSLATE"); // f32[4]
export const LAYOUT_NODE_OFFSET_INDIVIDUAL_ROTATE = layoutConstant("NODE_INDIVIDUAL_ROTATE"); // f32
export const LAYOUT_NODE_OFFSET_INDIVIDUAL_SCALE = layoutConstant("NODE_INDIVIDUAL_SCALE"); // f32[2]
export const LAYOUT_NODE_OFFSET_INDIVIDUAL_TRANSFORM = layoutConstant("NODE_INDIVIDUAL_TRANSFORM"); // u8
// 1 for a box of the top layer (CSS Positioned Layout 4): the box or the
// ::backdrop box of an element rendered in the top layer, a child of the
// viewport row. It makes a stacking context, which paints after the root
// stacking context in top layer order, and its static position is the
// origin of the initial containing block.
export const LAYOUT_NODE_OFFSET_TOP_LAYER = layoutConstant("NODE_TOP_LAYER"); // u8
// Size containment by axis (CSS Containment 2 §3.2, 3 §2):
// SIZE_CONTAINMENT_INLINE and SIZE_CONTAINMENT_BLOCK. On each contained axis
// the box sizes as if it had no contents, which still lay out. contain:
// size, strict and content-visibility: hidden set both; contain:
// inline-size the inline axis.
export const LAYOUT_NODE_OFFSET_SIZE_CONTAINMENT = layoutConstant("NODE_SIZE_CONTAINMENT"); // u8
export const SIZE_CONTAINMENT_INLINE = layoutConstant("SIZE_CONTAINMENT_INLINE");
export const SIZE_CONTAINMENT_BLOCK = layoutConstant("SIZE_CONTAINMENT_BLOCK");
export const TEXT_ALIGN_LAST_SIDE_MASK = layoutConstant("TEXT_ALIGN_LAST_SIDE_MASK");
export const TEXT_ALIGN_LAST_LOGICAL = layoutConstant("TEXT_ALIGN_LAST_LOGICAL");
export const TEXT_ALIGN_LAST_SET = layoutConstant("TEXT_ALIGN_LAST_SET");
export const TEXT_ALIGN_JUSTIFY = layoutConstant("TEXT_ALIGN_JUSTIFY");
export const TEXT_ALIGN_LAST_JUSTIFY = layoutConstant("TEXT_ALIGN_LAST_JUSTIFY");
export const TEXT_JUSTIFY_MASK = layoutConstant("TEXT_JUSTIFY_MASK");
export const TEXT_JUSTIFY_AUTO = layoutConstant("TEXT_JUSTIFY_AUTO");
export const TEXT_JUSTIFY_NONE = layoutConstant("TEXT_JUSTIFY_NONE");
export const TEXT_JUSTIFY_INTER_WORD = layoutConstant("TEXT_JUSTIFY_INTER_WORD");
export const TEXT_JUSTIFY_INTER_CHARACTER = layoutConstant("TEXT_JUSTIFY_INTER_CHARACTER");
// column-rule and column-fill of a multi-column container. They alias
// fields that only grid and table boxes read, and the record writer stores
// them only for a multi-column container, so a grid or table element keeps
// its own values. COLUMN_RULE_STYLE is a BORDER_STYLE_* value (NONE when
// unset); COLUMN_RULE_WIDTH is the used width in px, zero for none and
// hidden; COLUMN_RULE_COLOR is RGBA f32 with currentcolor resolved.
export const LAYOUT_NODE_OFFSET_COLUMN_RULE_WIDTH = layoutConstant("NODE_COLUMN_RULE_WIDTH"); // f32 px (aliases BORDER_SPACING_Y)
export const LAYOUT_NODE_OFFSET_COLUMN_RULE_COLOR = layoutConstant("NODE_COLUMN_RULE_COLOR"); // f32[4] (aliases GRID_AUTO_ROWS_MIN..GRID_AUTO_COLS_MAX)
export const LAYOUT_NODE_OFFSET_COLUMN_RULE_STYLE = layoutConstant("NODE_COLUMN_RULE_STYLE"); // u8: BORDER_STYLE_* (aliases GRID_AUTO_ROWS_MIN_TYPE)
export const LAYOUT_NODE_OFFSET_COLUMN_FILL = layoutConstant("NODE_COLUMN_FILL"); // u8: COLUMN_FILL_* (aliases GRID_AUTO_ROWS_MAX_TYPE)
export const COLUMN_FILL_BALANCE = layoutConstant("COLUMN_FILL_BALANCE");
export const COLUMN_FILL_AUTO = layoutConstant("COLUMN_FILL_AUTO");
// column-height and column-wrap of a multi-column container (CSS
// Multi-column Layout 2), aliasing grid fields as the column rule does.
// COLUMN_HEIGHT is the used column height in px, or -1 for `auto`. With a
// column height, COLUMN_WRAP_AUTO and COLUMN_WRAP_WRAP start a new row of
// columns below the full one, ROW_GAP (px, -1 for `normal`, 1em) plus
// GRID_ROW_GAP_PERCENTAGE of a definite content height between the rows.
export const LAYOUT_NODE_OFFSET_COLUMN_HEIGHT = layoutConstant("NODE_COLUMN_HEIGHT"); // f32 px; -1=auto (aliases GRID_AUTO_ROWS_MIN_PERCENTAGE)
export const LAYOUT_NODE_OFFSET_COLUMN_WRAP = layoutConstant("NODE_COLUMN_WRAP"); // u8: COLUMN_WRAP_* (aliases GRID_AUTO_COLS_MIN_TYPE)
export const COLUMN_WRAP_AUTO = layoutConstant("COLUMN_WRAP_AUTO");
export const COLUMN_WRAP_NOWRAP = layoutConstant("COLUMN_WRAP_NOWRAP");
export const COLUMN_WRAP_WRAP = layoutConstant("COLUMN_WRAP_WRAP");
// column-span of any box: an in-flow block-level box with COLUMN_SPAN_ALL
// whose parent is a multi-column container, or a block in its flow that
// establishes no formatting context, spans every column and splits the
// columns into rows above and below it.
export const LAYOUT_NODE_OFFSET_COLUMN_SPAN = layoutConstant("NODE_COLUMN_SPAN"); // u8: COLUMN_SPAN_*
export const COLUMN_SPAN_NONE = layoutConstant("COLUMN_SPAN_NONE");
export const COLUMN_SPAN_ALL = layoutConstant("COLUMN_SPAN_ALL");
// Native appearance (CSS UI 4 §5.1, `appearance`): the form control a box
// paints as the platform theme does. The low seven bits name the control,
// NATIVE_APPEARANCE_CHECKED its checked state. A checkbox or radio paints
// the control in place of the box's background and border; a menulist
// paints over them. NONE paints the box as CSS alone describes it.
export const LAYOUT_NODE_OFFSET_NATIVE_APPEARANCE = layoutConstant("NODE_NATIVE_APPEARANCE"); // u8
export const NATIVE_APPEARANCE_NONE = layoutConstant("NATIVE_APPEARANCE_NONE");
export const NATIVE_APPEARANCE_CHECKBOX = layoutConstant("NATIVE_APPEARANCE_CHECKBOX");
export const NATIVE_APPEARANCE_RADIO = layoutConstant("NATIVE_APPEARANCE_RADIO");
export const NATIVE_APPEARANCE_MENULIST = layoutConstant("NATIVE_APPEARANCE_MENULIST");
export const NATIVE_APPEARANCE_KIND_MASK = layoutConstant("NATIVE_APPEARANCE_KIND_MASK");
export const NATIVE_APPEARANCE_CHECKED = layoutConstant("NATIVE_APPEARANCE_CHECKED");

// flex-direction values.
export const FLEX_ROW = layoutConstant("FLEX_ROW");
export const FLEX_ROW_REVERSE = layoutConstant("FLEX_ROW_REVERSE");
export const FLEX_COLUMN = layoutConstant("FLEX_COLUMN");
export const FLEX_COLUMN_REVERSE = layoutConstant("FLEX_COLUMN_REVERSE");

// justify-content values (main-axis).
export const JUSTIFY_START = layoutConstant("JUSTIFY_START");
export const JUSTIFY_END = layoutConstant("JUSTIFY_END");
export const JUSTIFY_CENTER = layoutConstant("JUSTIFY_CENTER");
export const JUSTIFY_SPACE_BETWEEN = layoutConstant("JUSTIFY_SPACE_BETWEEN");
export const JUSTIFY_SPACE_AROUND = layoutConstant("JUSTIFY_SPACE_AROUND");
export const JUSTIFY_SPACE_EVENLY = layoutConstant("JUSTIFY_SPACE_EVENLY");

// align-items / align-self values (cross-axis). align-self stores value+1 so 0
// can mean "auto" (inherit the container's align-items).
export const ALIGN_STRETCH = layoutConstant("ALIGN_STRETCH");
export const ALIGN_FLEX_START = layoutConstant("ALIGN_FLEX_START");
export const ALIGN_FLEX_END = layoutConstant("ALIGN_FLEX_END");
export const ALIGN_CENTER = layoutConstant("ALIGN_CENTER");
export const ALIGN_BASELINE = layoutConstant("ALIGN_BASELINE");

// flex-wrap values.
export const FLEX_NOWRAP = layoutConstant("FLEX_NOWRAP");
export const FLEX_WRAP = layoutConstant("FLEX_WRAP");

// Size tags (shared by width/height/min/max value fields).
export const SIZE_TAG_AUTO = layoutConstant("TAG_AUTO"); // also "none" for max, "zero" for min
export const SIZE_TAG_LENGTH = layoutConstant("TAG_LENGTH");
export const SIZE_TAG_PERCENT = layoutConstant("TAG_PERCENT");
export const SIZE_TAG_MIN_CONTENT = layoutConstant("TAG_MIN_CONTENT"); // width:min-content
export const SIZE_TAG_MAX_CONTENT = layoutConstant("TAG_MAX_CONTENT"); // width:max-content
export const SIZE_TAG_FIT_CONTENT = layoutConstant("TAG_FIT_CONTENT"); // width/height:fit-content
// A px + percentage-fraction pair. A NaN percentage marks a length
// expression: the value is the identifier of a program the DOM core interned
// (core/dom/lengths.watpart) for a min(), max(), or clamp() that
// compares a percentage with another unit, evaluated at layout against the
// percentage basis. The same convention holds for the gap and grid track
// pixel/percentage pairs.
export const SIZE_TAG_CALC_PAIR = layoutConstant("TAG_CALC_PAIR");
export const SIZE_TAG_COVER = layoutConstant("SIZE_TAG_COVER"); // background-size:cover (P5c)
export const SIZE_TAG_CONTAIN = layoutConstant("SIZE_TAG_CONTAIN"); // background-size:contain (P5c)

// background-repeat (P5c). space/round are documented-not-shipped (see
// design/paint-coverage.md's P5c note) — repeat/no-repeat only for now.
export const BG_REPEAT_REPEAT = layoutConstant("BG_REPEAT_REPEAT");
export const BG_REPEAT_NO_REPEAT = layoutConstant("BG_REPEAT_NO_REPEAT");
export const BG_REPEAT_SPACE = layoutConstant("BG_REPEAT_SPACE"); // P5c: $resolveBackgroundRepeatAxis
export const BG_REPEAT_ROUND = layoutConstant("BG_REPEAT_ROUND"); // P5c: $resolveBackgroundRepeatAxis

// Display values.
export const DISPLAY_BLOCK = layoutConstant("DISPLAY_BLOCK");
export const DISPLAY_NONE = layoutConstant("DISPLAY_NONE");
export const DISPLAY_FLEX = layoutConstant("DISPLAY_FLEX");
export const DISPLAY_TEXT = layoutConstant("DISPLAY_TEXT"); // Slice 6: leaf node, content comes from a shaped run (6B)
export const DISPLAY_IMAGE = layoutConstant("DISPLAY_IMAGE"); // Slice P5b: leaf node, replaced-box sizing from IMAGE_TABLE
export const DISPLAY_SVG_ROOT = layoutConstant("DISPLAY_SVG_ROOT"); // design/svg-rendering.md: replaced box, sizing from width/height/viewBox; children skip layout entirely
export const DISPLAY_SVG_SHAPE = layoutConstant("DISPLAY_SVG_SHAPE"); // design/svg-rendering.md: a child of an svg root — NODE_SVG_KIND (SVG_KIND_* enum) says which shape; geometry lives in the SVG geometry pool, not CSS layout fields
export const DISPLAY_INLINE = layoutConstant("DISPLAY_INLINE"); // design/inline-layout.md: non-atomic inline box (<span> etc), child of an IFC root (LAYOUT_FLAG_IS_INLINE_CTX) — no computed box, contributes OPEN/CLOSE items to the item stream
export const DISPLAY_INLINE_BLOCK = layoutConstant("DISPLAY_INLINE_BLOCK"); // design/inline-layout.md: atomic inline-level box laid out by block machinery
export const DISPLAY_GRID = layoutConstant("DISPLAY_GRID"); // plans/layout/PLAN-layout-grid.md: CSS Grid formatting context
export const DISPLAY_TABLE = layoutConstant("DISPLAY_TABLE");
export const DISPLAY_INLINE_TABLE = layoutConstant("DISPLAY_INLINE_TABLE");
export const DISPLAY_TABLE_ROW_GROUP = layoutConstant("DISPLAY_TABLE_ROW_GROUP");
export const DISPLAY_TABLE_HEADER_GROUP = layoutConstant("DISPLAY_TABLE_HEADER_GROUP");
export const DISPLAY_TABLE_FOOTER_GROUP = layoutConstant("DISPLAY_TABLE_FOOTER_GROUP");
export const DISPLAY_TABLE_ROW = layoutConstant("DISPLAY_TABLE_ROW");
export const DISPLAY_TABLE_CELL = layoutConstant("DISPLAY_TABLE_CELL");
export const DISPLAY_TABLE_COLUMN = layoutConstant("DISPLAY_TABLE_COLUMN");
export const DISPLAY_TABLE_COLUMN_GROUP = layoutConstant("DISPLAY_TABLE_COLUMN_GROUP");
export const DISPLAY_TABLE_CAPTION = layoutConstant("DISPLAY_TABLE_CAPTION");
export const DISPLAY_INLINE_FLEX = layoutConstant("DISPLAY_INLINE_FLEX");
export const DISPLAY_INLINE_GRID = layoutConstant("DISPLAY_INLINE_GRID"); // atomic inline grid container: participates in its parent IFC like inline-block, lays its own children out as grid
// MathML Core (docs/design/mathml-layout.md). DISPLAY_MATH is an inline
// math box: atomic inline-level, laid out by the MathML algorithms. A
// DISPLAY_BLOCK_MATH box is a block-level math root or any math box inside
// one; LAYOUT_NODE_OFFSET_MATH_KIND names its algorithm.
export const DISPLAY_MATH = layoutConstant("DISPLAY_MATH");
export const DISPLAY_BLOCK_MATH = layoutConstant("DISPLAY_BLOCK_MATH");

// MathML layout algorithms, by element (LAYOUT_NODE_OFFSET_MATH_KIND).
export const MATH_KIND_NONE = layoutConstant("MATH_KIND_NONE");
export const MATH_KIND_ROW = layoutConstant("MATH_KIND_ROW"); // math, mrow, mstyle, merror, mphantom, semantics, maction, mprescripts, none, and the anonymous mrow of an mtd
export const MATH_KIND_TOKEN = layoutConstant("MATH_KIND_TOKEN"); // mi, mn, mtext, ms
export const MATH_KIND_OPERATOR = layoutConstant("MATH_KIND_OPERATOR"); // mo
export const MATH_KIND_FRACTION = layoutConstant("MATH_KIND_FRACTION");
export const MATH_KIND_SQRT = layoutConstant("MATH_KIND_SQRT");
export const MATH_KIND_ROOT = layoutConstant("MATH_KIND_ROOT");
export const MATH_KIND_SUB = layoutConstant("MATH_KIND_SUB");
export const MATH_KIND_SUP = layoutConstant("MATH_KIND_SUP");
export const MATH_KIND_SUBSUP = layoutConstant("MATH_KIND_SUBSUP");
export const MATH_KIND_UNDER = layoutConstant("MATH_KIND_UNDER");
export const MATH_KIND_OVER = layoutConstant("MATH_KIND_OVER");
export const MATH_KIND_UNDEROVER = layoutConstant("MATH_KIND_UNDEROVER");
export const MATH_KIND_MULTISCRIPTS = layoutConstant("MATH_KIND_MULTISCRIPTS");
export const MATH_KIND_SPACE = layoutConstant("MATH_KIND_SPACE");
export const MATH_KIND_PADDED = layoutConstant("MATH_KIND_PADDED");
export const MATH_KIND_PRESCRIPTS = layoutConstant("MATH_KIND_PRESCRIPTS");
export const MATH_KIND_TABLE = layoutConstant("MATH_KIND_TABLE"); // an mtable (display table): baseline on the math axis
export const MATH_KIND_CELL = layoutConstant("MATH_KIND_CELL"); // an mtd (display table-cell): content is an anonymous mrow, centered
// LAYOUT_NODE_OFFSET_MATH_FLAGS
export const MATH_FLAG_DISPLAY_STYLE = layoutConstant("MATH_FLAG_DISPLAY_STYLE"); // math-style: normal
export const MATH_FLAG_SHIFT_COMPACT = layoutConstant("MATH_FLAG_SHIFT_COMPACT"); // math-shift: compact
export const MATH_FLAG_ROOT = layoutConstant("MATH_FLAG_ROOT"); // the <math> element
export const MATH_FLAG_ACCENT = layoutConstant("MATH_FLAG_ACCENT"); // mover/munderover accent="true"
export const MATH_FLAG_ACCENT_UNDER = layoutConstant("MATH_FLAG_ACCENT_UNDER"); // munder/munderover accentunder="true"
export const MATH_FLAG_SPACE_LIKE = layoutConstant("MATH_FLAG_SPACE_LIKE"); // mtext or mspace
export const MATH_FLAG_GROUPING = layoutConstant("MATH_FLAG_GROUPING"); // a grouping element: mrow, mstyle, mphantom, merror, semantics, maction, math
export const MATH_FLAG_CELL_ROW = layoutConstant("MATH_FLAG_CELL_ROW"); // an mtd: its content is an anonymous mrow
// LAYOUT_NODE_OFFSET_MATH_OPERATOR_FLAGS (mo only)
export const MATH_OPERATOR_STRETCHY = layoutConstant("MATH_OPERATOR_STRETCHY");
export const MATH_OPERATOR_SYMMETRIC = layoutConstant("MATH_OPERATOR_SYMMETRIC");
export const MATH_OPERATOR_LARGEOP = layoutConstant("MATH_OPERATOR_LARGEOP");
export const MATH_OPERATOR_MOVABLELIMITS = layoutConstant("MATH_OPERATOR_MOVABLELIMITS");
export const MATH_OPERATOR_VERTICAL = layoutConstant("MATH_OPERATOR_VERTICAL");
export const MATH_OPERATOR_HAS_GLYPH = layoutConstant("MATH_OPERATOR_HAS_GLYPH"); // the base code point maps to a glyph of the primary font
// LAYOUT_NODE_OFFSET_MATH_TAGS: two bits per length, MATH_LENGTH_* values;
// lspace bits 0-1, rspace 2-3, line thickness or mspace width 4-5, minsize 6-7,
// maxsize 8-9.
export const MATH_LENGTH_DEFAULT = layoutConstant("MATH_LENGTH_DEFAULT");
export const MATH_LENGTH_PX = layoutConstant("MATH_LENGTH_PX");
export const MATH_LENGTH_PERCENT = layoutConstant("MATH_LENGTH_PERCENT");

// Grid track sizing-function kinds. G1 consumes LENGTH/PERCENT; later Grid
// slices use the remaining canonical wire values without changing the entry.
export const GRID_TRACK_LENGTH = layoutConstant("GRID_TRACK_LENGTH");
export const GRID_TRACK_PERCENT = layoutConstant("GRID_TRACK_PERCENT");
export const GRID_TRACK_FRACTION = layoutConstant("GRID_TRACK_FRACTION");
export const GRID_TRACK_AUTO = layoutConstant("GRID_TRACK_AUTO");
export const GRID_TRACK_MIN_CONTENT = layoutConstant("GRID_TRACK_MIN_CONTENT");
export const GRID_TRACK_MAX_CONTENT = layoutConstant("GRID_TRACK_MAX_CONTENT");
export const GRID_TRACK_FIT_CONTENT = layoutConstant("GRID_TRACK_FIT_CONTENT");
export const GRID_TRACK_AUTO_FILL = layoutConstant("GRID_TRACK_AUTO_FILL");
export const GRID_TRACK_AUTO_FIT = layoutConstant("GRID_TRACK_AUTO_FIT");
export const GRID_TRACK_FIT_CONTENT_PERCENT = layoutConstant("GRID_TRACK_FIT_CONTENT_PERCENT");
export const GRID_TRACK_LENGTH_PERCENTAGE = layoutConstant("GRID_TRACK_LENGTH_PERCENTAGE");
export const GRID_TRACK_FIT_CONTENT_LENGTH_PERCENTAGE = layoutConstant("GRID_TRACK_FIT_CONTENT_LENGTH_PERCENTAGE");
export const GRID_PLACEMENT_AUTO = layoutConstant("GRID_PLACEMENT_AUTO");
export const GRID_PLACEMENT_LINE = layoutConstant("GRID_PLACEMENT_LINE");
export const GRID_PLACEMENT_SPAN = layoutConstant("GRID_PLACEMENT_SPAN");

// line-height tags (Slice 6). Mirrors the width/height size-tag pattern.
export const LINE_HEIGHT_NORMAL = layoutConstant("LINE_HEIGHT_NORMAL"); // font's own metrics-derived value
export const LINE_HEIGHT_LENGTH = layoutConstant("LINE_HEIGHT_LENGTH"); // explicit px
export const LINE_HEIGHT_NUMBER = layoutConstant("LINE_HEIGHT_NUMBER"); // unitless multiplier × fontSize
// vertical-align tags shared by inline layout and future table-cell layout.
export const VERTICAL_ALIGN_BASELINE = layoutConstant("VERTICAL_ALIGN_BASELINE");
export const VERTICAL_ALIGN_MIDDLE = layoutConstant("VERTICAL_ALIGN_MIDDLE");
export const VERTICAL_ALIGN_SUB = layoutConstant("VERTICAL_ALIGN_SUB");
export const VERTICAL_ALIGN_SUPER = layoutConstant("VERTICAL_ALIGN_SUPER");
export const VERTICAL_ALIGN_TOP = layoutConstant("VERTICAL_ALIGN_TOP");
export const VERTICAL_ALIGN_BOTTOM = layoutConstant("VERTICAL_ALIGN_BOTTOM");
export const VERTICAL_ALIGN_TEXT_TOP = layoutConstant("VERTICAL_ALIGN_TEXT_TOP");
export const VERTICAL_ALIGN_TEXT_BOTTOM = layoutConstant("VERTICAL_ALIGN_TEXT_BOTTOM");
export const VERTICAL_ALIGN_LENGTH = layoutConstant("VERTICAL_ALIGN_LENGTH");
export const VERTICAL_ALIGN_PERCENT = layoutConstant("VERTICAL_ALIGN_PERCENT");

// text-align values (Slice 6).
export const TEXT_ALIGN_LEFT = layoutConstant("TEXT_ALIGN_LEFT");
export const TEXT_ALIGN_CENTER = layoutConstant("TEXT_ALIGN_CENTER");
export const TEXT_ALIGN_RIGHT = layoutConstant("TEXT_ALIGN_RIGHT");

// font-style values (Slice 6). Matches CMD_TEXT_OFFSET_STYLE's encoding.
export const FONT_STYLE_NORMAL = layoutConstant("FONT_STYLE_NORMAL");
export const FONT_STYLE_ITALIC = layoutConstant("FONT_STYLE_ITALIC");

// position values.
export const POSITION_STATIC = layoutConstant("POS_STATIC");
export const POSITION_RELATIVE = layoutConstant("POS_RELATIVE");
export const POSITION_ABSOLUTE = layoutConstant("POS_ABSOLUTE");
// Out of flow like absolute (out-of-flow checks are `position >= ABSOLUTE`)
// but the containing block is ALWAYS the viewport — see POS_FIXED's doc in
// engine.wat (Slice 7A).
export const POSITION_FIXED = layoutConstant("POS_FIXED");
// Author-facing serializer value. The writer lowers it to relative layout
// plus LAYOUT_NODE_OFFSET_POSITION_STICKY for paint-time clamping.
export const POSITION_STICKY = layoutConstant("POSITION_STICKY");

// box-sizing values.
export const BOX_SIZING_CONTENT = layoutConstant("BOX_SIZING_CONTENT");
export const BOX_SIZING_BORDER = layoutConstant("BOX_SIZING_BORDER");

// mix-blend-mode values (Slice 8C). Order matches the CSS Compositing and
// Blending spec's canonical list: NORMAL, then the 11 separable modes
// (simple per-channel formulas), then the 4 non-separable ones (need
// HSL-space SetLum/SetSat helpers — see rasterize.js's COMPOSITE_SHADER).
export const BLEND_NORMAL = layoutConstant("BLEND_NORMAL");
export const BLEND_MULTIPLY = layoutConstant("BLEND_MULTIPLY");
export const BLEND_SCREEN = layoutConstant("BLEND_SCREEN");
export const BLEND_OVERLAY = layoutConstant("BLEND_OVERLAY");
export const BLEND_DARKEN = layoutConstant("BLEND_DARKEN");
export const BLEND_LIGHTEN = layoutConstant("BLEND_LIGHTEN");
export const BLEND_COLOR_DODGE = layoutConstant("BLEND_COLOR_DODGE");
export const BLEND_COLOR_BURN = layoutConstant("BLEND_COLOR_BURN");
export const BLEND_HARD_LIGHT = layoutConstant("BLEND_HARD_LIGHT");
export const BLEND_SOFT_LIGHT = layoutConstant("BLEND_SOFT_LIGHT");
export const BLEND_DIFFERENCE = layoutConstant("BLEND_DIFFERENCE");
export const BLEND_EXCLUSION = layoutConstant("BLEND_EXCLUSION");
export const BLEND_HUE = layoutConstant("BLEND_HUE");
export const BLEND_SATURATION = layoutConstant("BLEND_SATURATION");
export const BLEND_COLOR = layoutConstant("BLEND_COLOR");
export const BLEND_LUMINOSITY = layoutConstant("BLEND_LUMINOSITY");

// node.blendMode (a CSS keyword string) → BLEND_* enum, for JS writers.
export const BLEND_MODE_NAMES = {
  normal: BLEND_NORMAL,
  multiply: BLEND_MULTIPLY,
  screen: BLEND_SCREEN,
  overlay: BLEND_OVERLAY,
  darken: BLEND_DARKEN,
  lighten: BLEND_LIGHTEN,
  "color-dodge": BLEND_COLOR_DODGE,
  "color-burn": BLEND_COLOR_BURN,
  "hard-light": BLEND_HARD_LIGHT,
  "soft-light": BLEND_SOFT_LIGHT,
  difference: BLEND_DIFFERENCE,
  exclusion: BLEND_EXCLUSION,
  hue: BLEND_HUE,
  saturation: BLEND_SATURATION,
  color: BLEND_COLOR,
  luminosity: BLEND_LUMINOSITY,
};

// Layout node flags (bitfield in LAYOUT_NODE_OFFSET_FLAGS)
export const LAYOUT_FLAG_HAS_BACKGROUND = layoutConstant("FLAG_HAS_BACKGROUND");
export const LAYOUT_FLAG_HAS_BORDER = layoutConstant("FLAG_HAS_BORDER");
// Per-axis visual clipping is distinct from per-axis programmatic
// scrollability. overflow:clip sets only the clip bit; hidden/auto/scroll set
// both. This also keeps BFC establishment independent from either behavior.
export const LAYOUT_FLAG_CLIPS_OVERFLOW_X = layoutConstant("FLAG_CLIPS_OVERFLOW_X");
export const LAYOUT_FLAG_CLIPS_OVERFLOW_Y = layoutConstant("FLAG_CLIPS_OVERFLOW_Y");
export const LAYOUT_FLAG_HAS_OPACITY = layoutConstant("FLAG_HAS_OPACITY");
export const LAYOUT_FLAG_HAS_TRANSFORM = layoutConstant("FLAG_HAS_TRANSFORM");
// Replaced content without natural dimensions (video, iframe, embed, object):
// an auto width takes the default object size's 300px, or a length height
// through a preferred aspect ratio; an auto height takes 150px, or the width
// through the ratio; an auto width with a ratio and no length height fills
// the line (CSS 2.1 §10.3.2, §10.6.2; css-images-3 §4.3).
export const LAYOUT_FLAG_DEFAULT_OBJECT_SIZE = layoutConstant("FLAG_DEFAULT_OBJECT_SIZE");
export const LAYOUT_FLAG_HAS_SVG = layoutConstant("FLAG_HAS_SVG");
export const LAYOUT_FLAG_HAS_BOX_SHADOW = layoutConstant("FLAG_HAS_BOX_SHADOW");
// design/inline-layout.md: this block's children are an inline formatting
// context (display:'text'/'inline' siblings) — $layoutBlock/$computeIntrinsic/
// $paintFlow all dispatch on this BEFORE their generic child-recursion paths.
export const LAYOUT_FLAG_IS_INLINE_CTX = layoutConstant("FLAG_IS_INLINE_CTX");
export const LAYOUT_FLAG_HAS_GRADIENT = layoutConstant("FLAG_HAS_GRADIENT");
// 0x0800 and 0x1000 were LAYOUT_FLAG_MARGIN_LEFT_AUTO / _RIGHT_AUTO; the
// four auto-margin edges moved into LAYOUT_NODE_OFFSET_MARGIN_AUTO when flex
// §8.1 needed the block pair too (two bits here could not carry four edges).
// A <textarea> or a text field <input>: auto width (and a textarea's auto
// height) resolve from LAYOUT_NODE_OFFSET_TEXT_CONTROL_*.
export const LAYOUT_FLAG_TEXT_CONTROL = layoutConstant("FLAG_TEXT_CONTROL");
// A <select>: its min- and max-content width is its widest line (the widest
// option label) rounded up to a whole CSS pixel. A list box also stores its
// display size in LAYOUT_NODE_OFFSET_TEXT_CONTROL_ROWS.
export const LAYOUT_FLAG_SELECT = layoutConstant("FLAG_SELECT");
export const LAYOUT_FLAG_ESTABLISHES_BFC = layoutConstant("FLAG_ESTABLISHES_BFC"); // overflow!=visible / flow-root: no margin collapse w/ children
export const LAYOUT_FLAG_SCROLLABLE_OVERFLOW_X = layoutConstant("FLAG_SCROLLABLE_OVERFLOW_X");
export const LAYOUT_FLAG_SCROLLABLE_OVERFLOW_Y = layoutConstant("FLAG_SCROLLABLE_OVERFLOW_Y");

// margin-*: auto edge bits (LAYOUT_NODE_OFFSET_MARGIN_AUTO), CSS edge order.
export const MARGIN_AUTO_TOP = layoutConstant("MARGIN_AUTO_TOP");
export const MARGIN_AUTO_RIGHT = layoutConstant("MARGIN_AUTO_RIGHT");
export const MARGIN_AUTO_BOTTOM = layoutConstant("MARGIN_AUTO_BOTTOM");
export const MARGIN_AUTO_LEFT = layoutConstant("MARGIN_AUTO_LEFT");

// NODE_INHERITED_MASK bits.
export const INHERITED_MASK_TEXT_COLOR = layoutConstant("INHERITED_MASK_TEXT_COLOR");
export const INHERITED_MASK_VISIBILITY = layoutConstant("INHERITED_MASK_VISIBILITY");
export const INHERITED_MASK_FONT_SIZE = layoutConstant("INHERITED_MASK_FONT_SIZE");
export const INHERITED_MASK_LINE_HEIGHT = layoutConstant("INHERITED_MASK_LINE_HEIGHT");
// text-shadow: the TEXT_SHADOW_COUNT and TEXT_SHADOW_OFFSET span.
export const INHERITED_MASK_TEXT_SHADOW = layoutConstant("INHERITED_MASK_TEXT_SHADOW");

// =======================================================================
// Command buffer (512 KB at 0x42B40)
// =======================================================================
//
// Binary draw commands. Written by WASM, read by JS rasterizer.
// Each command is a variable-size record prefixed by a 1-byte opcode.
//
// The command buffer has no constant here: it starts in a fixed region and
// moves to a larger allocated block when a paint walk's commands do not
// fit (engine-paint.watpart $commandBufferGrow). A reader takes its base
// from command_buffer_base() after each emission, and the emission's byte
// count from its return value or command_bytes().

// --- Command opcodes ---
// Retained raster execution-plan ABI. Every offset is relative to the plan
// handle; records and payloads therefore remain valid after memory growth.
export const RASTER_PLAN_ABI_VERSION = layoutConstant("RASTER_PLAN_ABI_VERSION");
export const RASTER_PLAN_MAGIC = layoutConstant("RASTER_PLAN_MAGIC"); // "SRPL" little-endian
export const RASTER_PLAN_HEADER_SIZE = layoutConstant("RASTER_PLAN_HEADER_SIZE");
export const RASTER_PLAN_RECORD_SIZE = layoutConstant("RASTER_PLAN_RECORD_SIZE");
export const RASTER_PLAN_CLIP_FLOATS = layoutConstant("RASTER_PLAN_CLIP_FLOATS");
export const RASTER_PLAN_CLIP_PATH_MASK_FLOATS = layoutConstant("RASTER_PLAN_CLIP_PATH_MASK_FLOATS");
export const RASTER_PLAN_CLIP_ENTRY_SIZE = layoutConstant("RASTER_PLAN_CLIP_ENTRY_SIZE");
export const RASTER_PLAN_NO_CLIP = layoutConstant("RASTER_PLAN_NO_CLIP") >>> 0;
// A host scrollbar row (raster_plan_prepare and raster_plan_rescroll), all
// f32: the engine node whose CMD_SCROLLBAR marker paints it (-1 for the
// viewport's), x, y, width, height in viewport CSS px, r, g, b, a, and one
// corner radius in CSS px. A marker's rows paint back to front.
export const RASTER_PLAN_SCROLLBAR_ROW_SIZE = layoutConstant("RASTER_PLAN_SCROLLBAR_ROW_SIZE");

export const RASTER_PLAN_OFFSET_TOTAL_BYTES = layoutConstant("RASTER_PLAN_OFFSET_TOTAL_BYTES");
export const RASTER_PLAN_OFFSET_RECORD_COUNT = layoutConstant("RASTER_PLAN_OFFSET_RECORD_COUNT");
export const RASTER_PLAN_OFFSET_SOURCE_BYTES = layoutConstant("RASTER_PLAN_OFFSET_SOURCE_BYTES");
export const RASTER_PLAN_OFFSET_RECORD_TABLE = layoutConstant("RASTER_PLAN_OFFSET_RECORD_TABLE");
export const RASTER_PLAN_OFFSET_RECORD_STRIDE = layoutConstant("RASTER_PLAN_OFFSET_RECORD_STRIDE");
export const RASTER_PLAN_OFFSET_FEATURE_BITS = layoutConstant("RASTER_PLAN_OFFSET_FEATURE_BITS");
export const RASTER_PLAN_OFFSET_SOURCE_REVISION = layoutConstant("RASTER_PLAN_OFFSET_SOURCE_REVISION");
export const RASTER_PLAN_OFFSET_WIDTH = layoutConstant("RASTER_PLAN_OFFSET_WIDTH");
export const RASTER_PLAN_OFFSET_HEIGHT = layoutConstant("RASTER_PLAN_OFFSET_HEIGHT");
export const RASTER_PLAN_OFFSET_DEVICE_SCALE = layoutConstant("RASTER_PLAN_OFFSET_DEVICE_SCALE");
export const RASTER_PLAN_OFFSET_RENDER_MODE = layoutConstant("RASTER_PLAN_OFFSET_RENDER_MODE");
export const RASTER_PLAN_OFFSET_CLIP_TABLE = layoutConstant("RASTER_PLAN_OFFSET_CLIP_TABLE");
export const RASTER_PLAN_OFFSET_CLIP_COUNT = layoutConstant("RASTER_PLAN_OFFSET_CLIP_COUNT");
export const RASTER_PLAN_OFFSET_PAYLOAD_REGION = layoutConstant("RASTER_PLAN_OFFSET_PAYLOAD_REGION");
export const RASTER_PLAN_OFFSET_PAYLOAD_BYTES = layoutConstant("RASTER_PLAN_OFFSET_PAYLOAD_BYTES");
export const RASTER_PLAN_OFFSET_VISIBLE_X = layoutConstant("RASTER_PLAN_OFFSET_VISIBLE_X");
export const RASTER_PLAN_OFFSET_VISIBLE_Y = layoutConstant("RASTER_PLAN_OFFSET_VISIBLE_Y");
export const RASTER_PLAN_OFFSET_CULL_WIDTH = layoutConstant("RASTER_PLAN_OFFSET_CULL_WIDTH");
export const RASTER_PLAN_OFFSET_CULL_HEIGHT = layoutConstant("RASTER_PLAN_OFFSET_CULL_HEIGHT");
export const RASTER_PLAN_FEATURE_RECT_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_RECT_NATIVE");
export const RASTER_PLAN_FEATURE_IMAGE_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_IMAGE_NATIVE");
export const RASTER_PLAN_FEATURE_GRADIENT_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_GRADIENT_NATIVE");
export const RASTER_PLAN_FEATURE_SHADOW_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_SHADOW_NATIVE");
export const RASTER_PLAN_BOX_SHADOW_INSTANCE_FLOATS = layoutConstant("RASTER_PLAN_BOX_SHADOW_INSTANCE_FLOATS");
export const RASTER_PLAN_IMAGE_INSTANCE_FLOATS = layoutConstant("RASTER_PLAN_IMAGE_INSTANCE_FLOATS");
// The maximum instance count of one rect draw (raster-plan.watpart).
export const RASTER_PLAN_RECT_BATCH_INSTANCES = layoutConstant("RASTER_PLAN_RECT_BATCH_INSTANCES");
export const RASTER_PLAN_GRADIENT_RECORD_BYTES = layoutConstant("RASTER_PLAN_GRADIENT_RECORD_BYTES");
export const RASTER_PLAN_GRADIENT_STOP_BYTES = layoutConstant("RASTER_PLAN_GRADIENT_STOP_BYTES");
export const RASTER_PLAN_FEATURE_TEXT_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_TEXT_NATIVE");
export const RASTER_PLAN_FEATURE_SVG_PATH_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_SVG_PATH_NATIVE");
export const RASTER_PLAN_TEXT_INSTANCE_FLOATS = layoutConstant("RASTER_PLAN_TEXT_INSTANCE_FLOATS");
export const RASTER_PLAN_SVG_PATH_INSTANCE_FLOATS = layoutConstant("RASTER_PLAN_SVG_PATH_INSTANCE_FLOATS");
export const RASTER_PLAN_FEATURE_GROUP_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_GROUP_NATIVE");
export const RASTER_PLAN_FEATURE_FILTER_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_FILTER_NATIVE");
export const RASTER_PLAN_FEATURE_MASK_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_MASK_NATIVE");
export const RASTER_PLAN_FEATURE_TEXT_RESOURCES_NATIVE = layoutConstant("RASTER_PLAN_FEATURE_TEXT_RESOURCES_NATIVE");
export const RASTER_PLAN_GROUP_PUSH_FLOATS = layoutConstant("RASTER_PLAN_GROUP_PUSH_FLOATS");
export const RASTER_PLAN_GROUP_POP_FLOATS = layoutConstant("RASTER_PLAN_GROUP_POP_FLOATS");
export const RASTER_PLAN_FILTER_LIST_OFFSET = layoutConstant("RASTER_PLAN_FILTER_LIST_OFFSET");
export const RASTER_PLAN_FILTER_DESCRIPTOR_BYTES = layoutConstant("RASTER_PLAN_FILTER_DESCRIPTOR_BYTES");
export const RASTER_PLAN_FILTER_UNIFORM_SLOT_BYTES = layoutConstant("RASTER_PLAN_FILTER_UNIFORM_SLOT_BYTES");
export const RASTER_PLAN_PASS_MATRIX = layoutConstant("RASTER_PLAN_PASS_MATRIX");
export const RASTER_PLAN_PASS_BOX_BLUR_H = layoutConstant("RASTER_PLAN_PASS_BOX_BLUR_H");
export const RASTER_PLAN_PASS_BOX_BLUR_V = layoutConstant("RASTER_PLAN_PASS_BOX_BLUR_V");
export const RASTER_PLAN_PASS_DROP_SHADOW = layoutConstant("RASTER_PLAN_PASS_DROP_SHADOW");
export const RASTER_PLAN_PASS_MASK_COMBINE = layoutConstant("RASTER_PLAN_PASS_MASK_COMBINE");
export const RASTER_PLAN_RECORD_FLAG_NEEDS_BACKDROP_COPY = layoutConstant("RASTER_PLAN_RECORD_FLAG_NEEDS_BACKDROP_COPY");

export const RASTER_PLAN_RECORD_OFFSET_KIND = layoutConstant("RASTER_PLAN_RECORD_OFFSET_KIND");
export const RASTER_PLAN_RECORD_OFFSET_FLAGS = layoutConstant("RASTER_PLAN_RECORD_OFFSET_FLAGS");
export const RASTER_PLAN_RECORD_OFFSET_SOURCE = layoutConstant("RASTER_PLAN_RECORD_OFFSET_SOURCE");
export const RASTER_PLAN_RECORD_OFFSET_SOURCE_BYTES = layoutConstant("RASTER_PLAN_RECORD_OFFSET_SOURCE_BYTES");
export const RASTER_PLAN_RECORD_OFFSET_CLIP = layoutConstant("RASTER_PLAN_RECORD_OFFSET_CLIP");
export const RASTER_PLAN_RECORD_OFFSET_PAYLOAD = layoutConstant("RASTER_PLAN_RECORD_OFFSET_PAYLOAD");
export const RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES = layoutConstant("RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES");
export const RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT = layoutConstant("RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT");
export const RASTER_PLAN_RECORD_OFFSET_RESOURCE = layoutConstant("RASTER_PLAN_RECORD_OFFSET_RESOURCE");
export const RASTER_PLAN_RECORD_OFFSET_GRADIENT = layoutConstant("RASTER_PLAN_RECORD_OFFSET_GRADIENT");
export const RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES = layoutConstant("RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES");
// The extent of the target a record's draw can write, in target device
// pixels: f32 minimum x, minimum y, maximum x, maximum y. A drawing record
// (rect, text, image, box shadow, SVG path) holds the union of its
// instances' quads grown by one pixel; every other record is unbounded,
// -Infinity..Infinity (raster-plan.watpart $rasterPlanWriteRecordBounds).
export const RASTER_PLAN_RECORD_OFFSET_BOUNDS = layoutConstant("RASTER_PLAN_RECORD_OFFSET_BOUNDS");

export const RASTER_RESOURCE_IMAGE = layoutConstant("RASTER_RESOURCE_IMAGE");
export const GLYPH_REQUEST_HEADER_SIZE = layoutConstant("GLYPH_REQUEST_HEADER_SIZE");
export const GLYPH_REQUEST_ROW_SIZE = layoutConstant("GLYPH_REQUEST_ROW_SIZE");
export const GLYPH_REQUEST_KIND_GLYPH = layoutConstant("GLYPH_REQUEST_KIND_GLYPH");
export const GLYPH_REQUEST_KIND_PATH = layoutConstant("GLYPH_REQUEST_KIND_PATH");
export const GLYPH_REQUEST_FONT = layoutConstant("GLYPH_REQUEST_FONT");
export const GLYPH_REQUEST_WEIGHT = layoutConstant("GLYPH_REQUEST_WEIGHT");
export const GLYPH_REQUEST_OPTICAL_SIZE = layoutConstant("GLYPH_REQUEST_OPTICAL_SIZE");
export const GLYPH_REQUEST_FONT_SIZE = layoutConstant("GLYPH_REQUEST_FONT_SIZE");
export const GLYPH_REQUEST_GLYPH = layoutConstant("GLYPH_REQUEST_GLYPH");
export const GLYPH_REQUEST_KIND = layoutConstant("GLYPH_REQUEST_KIND");
export const GLYPH_REQUEST_VARIATIONS = layoutConstant("GLYPH_REQUEST_VARIATIONS");
export const GLYPH_REQUEST_PATH_INDEX = layoutConstant("GLYPH_REQUEST_PATH_INDEX");
export const GLYPH_REQUEST_PATH_SCREEN_SIZE = layoutConstant("GLYPH_REQUEST_PATH_SCREEN_SIZE");
export const GLYPH_REQUEST_PATH_COVERAGE = layoutConstant("GLYPH_REQUEST_PATH_COVERAGE");

export function glyphRequestRowByteSize(view, offset) {
  if (offset + GLYPH_REQUEST_ROW_SIZE > view.byteLength) {
    throw new RangeError(`Resource request at byte ${offset} has ${view.byteLength - offset} bytes; provide a complete ${GLYPH_REQUEST_ROW_SIZE}-byte row`);
  }
  const kind = view.getUint16(offset + GLYPH_REQUEST_KIND, true);
  if (kind !== GLYPH_REQUEST_KIND_GLYPH && kind !== GLYPH_REQUEST_KIND_PATH) {
    throw new RangeError(`Resource request kind ${kind} is unsupported; use glyph kind ${GLYPH_REQUEST_KIND_GLYPH} or path kind ${GLYPH_REQUEST_KIND_PATH}`);
  }
  return GLYPH_REQUEST_ROW_SIZE;
}


export const CMD_RECT = layoutConstant("CMD_RECT");
export const CMD_TEXT = layoutConstant("CMD_TEXT");
export const CMD_IMAGE = layoutConstant("CMD_IMAGE");
export const CMD_BOX_SHADOW = layoutConstant("CMD_BOX_SHADOW");
export const CMD_PUSH_CLIP = layoutConstant("CMD_PUSH_CLIP");
export const CMD_POP_CLIP = layoutConstant("CMD_POP_CLIP");
export const CMD_PUSH_OPACITY = layoutConstant("CMD_PUSH_OPACITY");
export const CMD_POP_OPACITY = layoutConstant("CMD_POP_OPACITY");
// 0x09 was CMD_SVG_RECT/CIRCLE/ELLIPSE/LINE/POLYGON/POLYLINE (0x09-0x0E) —
// declared at S1's start, never emitted (Tier A shapes lower to CMD_RECT
// instead, see design/svg-rendering.md). Reclaimed for Tier B's CMD_SVG_PATH.
export const CMD_SVG_PATH = layoutConstant("CMD_SVG_PATH");
// P8b: backdrop-filter is a SEPARATE, EARLIER group operation from
// filter (CMD_PUSH_OPACITY) — it snapshots whatever's ALREADY painted
// behind the element (before the element's own content/filter/
// background paint at all), applies the filter chain to that snapshot,
// then the element's own content (painted normally, including its own
// CMD_PUSH_OPACITY group if it has one) composites back over the
// filtered result. Brackets $paintContext's WHOLE body, outside
// CMD_PUSH_OPACITY. The element's own clip shape to composite back
// against isn't carried here — the rasterizer already has it from the
// ordinary CMD_PUSH_CLIP that follows (see rasterize.js's ownClipState
// capture).
export const CMD_PUSH_BACKDROP_FILTER = layoutConstant("CMD_PUSH_BACKDROP_FILTER");
export const CMD_POP_BACKDROP_FILTER = layoutConstant("CMD_POP_BACKDROP_FILTER");
// P11 (mask): the mask layer list's own bracket + the per-layer bracket.
// See the "Push/pop mask" format block below.
export const CMD_PUSH_MASK = layoutConstant("CMD_PUSH_MASK");
export const CMD_PUSH_MASK_LAYER = layoutConstant("CMD_PUSH_MASK_LAYER");
export const CMD_POP_MASK_LAYER = layoutConstant("CMD_POP_MASK_LAYER");
// P13 (background-blend-mode): the background stack's own group, plus a
// per-layer bracket for a layer whose blend mode is non-normal. See the
// "Push/pop background" format block below.
export const CMD_PUSH_BACKGROUND = layoutConstant("CMD_PUSH_BACKGROUND");
export const CMD_PUSH_BLEND_LAYER = layoutConstant("CMD_PUSH_BLEND_LAYER");
export const CMD_POP_BLEND_LAYER = layoutConstant("CMD_POP_BLEND_LAYER");
export const CMD_POP_BACKGROUND = layoutConstant("CMD_POP_BACKGROUND");
// Inspection-only source marker. The renderer ignores this command. Paint
// artifact capture uses it to map subsequent draw commands to a scene node
// without changing any draw-command byte layout.
export const CMD_SET_NODE = layoutConstant("CMD_SET_NODE");
export const CMD_SET_NODE_SIZE = layoutConstant("CMD_SET_NODE_SIZE");
export const CMD_SET_NODE_OFFSET_INDEX = layoutConstant("CMD_SET_NODE_OFFSET_INDEX"); // u32
// D2 piece B (scroll-layer compositing, design/layout-engine.md):
// select the current scroll-table entry. Every geometry payload after
// this record is unshifted by the referenced scroller chain's cumulative
// offset; a walker resolves `final = M(payload) + scrollTable[ref]`.
// ref 0 is the reserved zero offset (no scroller / fixed subtree).
export const CMD_SET_SCROLL = layoutConstant("CMD_SET_SCROLL");
export const CMD_SET_SCROLL_SIZE = layoutConstant("CMD_SET_SCROLL_SIZE");
export const CMD_SET_SCROLL_OFFSET_REF = layoutConstant("CMD_SET_SCROLL_OFFSET_REF"); // u16: SCROLL_TABLE index
// Raster-plan-only replay scissor. Payload rows are {x, y, width, height}
// device-pixel rectangles; this opcode never appears in command bytes.
export const CMD_DAMAGE = layoutConstant("CMD_DAMAGE");
// A scroll container's scrollbars, in its outline turn under its ancestors'
// clips (engine-paint.watpart $emitScrollbarMarker): u32 engine node at
// offset 4, or 0xFFFFFFFF for the viewport's, painted after every layer.
// The raster plan expands it from the frame's scrollbar rows.
export const CMD_SCROLLBAR = layoutConstant("CMD_SCROLLBAR");
export const CMD_SCROLLBAR_SIZE = layoutConstant("CMD_SCROLLBAR_SIZE");
export const CMD_SCROLLBAR_OFFSET_NODE = layoutConstant("CMD_SCROLLBAR_OFFSET_NODE"); // u32

// --- Rect command (0x01) ---
// Slice P2: border color is PER SIDE (4 × rgba, top/right/bottom/left) and
// border radius is PER CORNER (CSS order: top-left, top-right, bottom-right,
// bottom-left). A uniform border/radius simply repeats its value — there is
// no single-value fast path in the format.
// P10: radii widened from 4 f32 (circular) to 8 f32 (rx,ry pairs per corner
// — elliptical, `border-radius: h / v`). A circular corner is just rx==ry;
// every existing circular-only caller now writes the same value to both.
// This SHIFTS every offset from XFORM onward by 16 bytes (4 new f32s) vs
// the pre-P10 format — CMD_RECT_SIZE/CMD_RECT_SIZE_XFORM grew to match.
//
// P4 (gradients): a SECOND independent flag-gated extension, appended
// AFTER the transform block per the plan's "transform block first, then
// gradient block" ordering — so a rect can carry a transform, a gradient,
// both, or neither, giving FOUR possible byte sizes, not two. Use
// cmdRectSize()/cmdRectGradientOffset() below rather than hand-deriving —
// this is exactly the kind of size-composition every command-stream
// walker must agree on (see commandByteSize's own warning).
export const CMD_RECT_SIZE = layoutConstant("CMD_RECT_SIZE"); // no transform, no gradient
export const CMD_RECT_SIZE_XFORM = layoutConstant("CMD_RECT_SIZE_XFORM"); // transform, no gradient (also equals gradient-without-transform's size — see cmdRectSize())
export const CMD_RECT_OFFSET_FLAGS = layoutConstant("CMD_RECT_OFFSET_FLAGS"); // u8
// P7 border-style: the four sides' BORDER_STYLE_* values packed as 4-bit
// nibbles into the previously-padded u16 at 0x02 —
// top | right<<4 | bottom<<8 | left<<12. 0 = all solid (pre-P7 wire
// compatibility: writers always zeroed this).
export const CMD_RECT_OFFSET_BORDER_STYLES = layoutConstant("CMD_RECT_OFFSET_BORDER_STYLES"); // u16
export const CMD_RECT_OFFSET_X = layoutConstant("CMD_RECT_OFFSET_X"); // f32
export const CMD_RECT_OFFSET_Y = layoutConstant("CMD_RECT_OFFSET_Y"); // f32
export const CMD_RECT_OFFSET_W = layoutConstant("CMD_RECT_OFFSET_W"); // f32
export const CMD_RECT_OFFSET_H = layoutConstant("CMD_RECT_OFFSET_H"); // f32
export const CMD_RECT_OFFSET_FILL = layoutConstant("CMD_RECT_OFFSET_FILL"); // f32[4]
export const CMD_RECT_OFFSET_BORDER_COLOR_TOP = layoutConstant("CMD_RECT_OFFSET_BORDER_COLOR_TOP"); // f32[4]
export const CMD_RECT_OFFSET_BORDER_COLOR_RIGHT = layoutConstant("CMD_RECT_OFFSET_BORDER_COLOR_RIGHT"); // f32[4]
export const CMD_RECT_OFFSET_BORDER_COLOR_BOTTOM = layoutConstant("CMD_RECT_OFFSET_BORDER_COLOR_BOTTOM"); // f32[4]
export const CMD_RECT_OFFSET_BORDER_COLOR_LEFT = layoutConstant("CMD_RECT_OFFSET_BORDER_COLOR_LEFT"); // f32[4]
export const CMD_RECT_OFFSET_BORDER_TOP = layoutConstant("CMD_RECT_OFFSET_BORDER_TOP"); // f32 border width, top
export const CMD_RECT_OFFSET_BORDER_RIGHT = layoutConstant("CMD_RECT_OFFSET_BORDER_RIGHT"); // f32
export const CMD_RECT_OFFSET_BORDER_BOTTOM = layoutConstant("CMD_RECT_OFFSET_BORDER_BOTTOM"); // f32
export const CMD_RECT_OFFSET_BORDER_LEFT = layoutConstant("CMD_RECT_OFFSET_BORDER_LEFT"); // f32
export const CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X = layoutConstant("CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X"); // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_TOP_LEFT_Y = layoutConstant("CMD_RECT_OFFSET_RADIUS_TOP_LEFT_Y"); // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_X = layoutConstant("CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_X"); // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_Y = layoutConstant("CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_Y"); // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_X = layoutConstant("CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_X"); // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_Y = layoutConstant("CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_Y"); // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_X = layoutConstant("CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_X"); // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_Y = layoutConstant("CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_Y"); // f32 (P10)
export const CMD_RECT_OFFSET_XFORM = layoutConstant("CMD_RECT_OFFSET_XFORM"); // f32[6] (only if flag set)

// Gradient extension (P4): appended AFTER the transform block (present or
// not — see cmdRectGradientOffset() below), only when CMD_RECT_FLAG_GRADIENT
// is set. FILL_COLOR (0x14) still carries a SOLID fallback color in this
// case (unused by the shader when the gradient flag is set, but written
// deterministically like every other command field) — kind/stopCount/
// stopOffset/geom below are the actual gradient description.
//   kind (u8)       — BG_KIND_*: 1=linear,2=radial,3=conic; bit 7=repeating
//                     (mirrors LAYOUT_NODE_OFFSET_BG_KIND's own encoding,
//                     where 0 means solid/none)
//   stopCount (u8)  — number of entries in this draw's GRADIENT_STOP_POOL span
//   flags (u8)      — bit0 = TILED (background-origin: the positioning
//                     area differs from the painted rect, so the shader
//                     wraps the sample position modulo the origin rect —
//                     a gradient is a CSS <image> sized to the
//                     positioning area and tiled per background-repeat's
//                     default `repeat` across the painting area,
//                     Chrome-probe-verified). 0 for every pre-origin
//                     emission shape (SVG, borderless boxes).
//   pad (u8)
//   stopOffset (u32) — byte offset into GRADIENT_STOP_POOL_BASE
//   geom (f32[4])    — linear{dx,dy,length,pad} / radial{cx,cy,rx,ry} /
//                       conic{cx,cy,angle,pad}, mirrors LAYOUT_NODE_OFFSET_
//                       BG_GRADIENT_GEOMETRY's own per-kind layout.
//                       Coordinates are in ORIGIN-BOX space (relative to
//                       the positioning area's top-left) — identical to
//                       painted-rect space whenever origin == rect.
//   origin (f32[4])  — background-origin positioning area: {dx, dy, w, h},
//                       dx/dy = origin box top-left relative to the
//                       painted rect's own top-left (can be negative).
export const CMD_RECT_GRADIENT_EXT_SIZE = layoutConstant("CMD_RECT_GRADIENT_EXT_SIZE");
export const CMD_RECT_GRADIENT_OFFSET_KIND = layoutConstant("CMD_RECT_GRADIENT_OFFSET_KIND"); // u8
export const CMD_RECT_GRADIENT_OFFSET_STOP_COUNT = layoutConstant("CMD_RECT_GRADIENT_OFFSET_STOP_COUNT"); // u8
export const CMD_RECT_GRADIENT_OFFSET_FLAGS = layoutConstant("CMD_RECT_GRADIENT_OFFSET_FLAGS"); // u8: bit0=tiled
export const CMD_RECT_GRADIENT_OFFSET_STOP_OFFSET = layoutConstant("CMD_RECT_GRADIENT_OFFSET_STOP_OFFSET"); // u32
export const CMD_RECT_GRADIENT_OFFSET_INTERPOLATION = layoutConstant("CMD_RECT_GRADIENT_OFFSET_INTERPOLATION"); // u8: packed space + hue method
export const CMD_RECT_GRADIENT_OFFSET_GEOM = layoutConstant("CMD_RECT_GRADIENT_OFFSET_GEOM"); // f32[4]
export const CMD_RECT_GRADIENT_OFFSET_ORIGIN = layoutConstant("CMD_RECT_GRADIENT_OFFSET_ORIGIN"); // f32[4] {dx,dy,w,h}

// Rect flags
export const CMD_RECT_FLAG_FILL = layoutConstant("CMD_RECT_FLAG_FILL");
export const CMD_RECT_FLAG_BORDER = layoutConstant("CMD_RECT_FLAG_BORDER");
export const CMD_RECT_FLAG_GRADIENT = layoutConstant("CMD_RECT_FLAG_GRADIENT");
export const CMD_RECT_FLAG_TRANSFORM = layoutConstant("CMD_RECT_FLAG_TRANSFORM");
// Suppress the rasterizer's destination pixel snapping, exactly as
// CMD_IMAGE_FLAG_NO_PIXEL_SNAP does for image draws. Chrome rounds a CSS
// BOX's paint rect to whole device pixels before painting it — a div at
// top:20.5px occupies rows 21-40 with hard edges — so that snap is the
// DEFAULT here. SVG shape geometry is the exception and carries this flag:
// an <svg> child's rect/circle/ellipse/line is vector geometry in user
// space, positioned by the viewBox affine and antialiased, never quantised
// to the device grid. Snapping it moves the shape (measured: three
// svg_test.js Chrome-oracle cases fail by 380-450 structural px, with the
// stroke ring landing 1-3.4px off its true edge).
export const CMD_RECT_FLAG_NO_PIXEL_SNAP = layoutConstant("CMD_RECT_FLAG_NO_PIXEL_SNAP");
// SVG shape geometry also carries this one: its edges take the exact
// pixel-area coverage SVG paint is judged by (test/helpers/svg-truth.js),
// where a CSS box keeps the smoothstep ramp its Chrome parity was measured
// with. A smoothstep departs from area coverage by up to 0.096 where an
// edge runs horizontal or vertical on screen (measured: a rotated circle's
// topmost and bottommost pixels, 18-21 bytes off the source truth). The
// raster plan carries it to the rect shader as bit 16 of the styles word.
export const CMD_RECT_FLAG_AREA_COVERAGE = layoutConstant("CMD_RECT_FLAG_AREA_COVERAGE");
// The border ring is an SVG stroke, not a CSS border: its outer and inner
// contours are the offset curves of the midline (the border box inset by
// half the border width on every side) at half the border width. For a
// circular corner that is the CSS construction; for an elliptical one
// (an ellipse, a rect with rx != ry) the offset of an ellipse is not an
// ellipse, and the CSS inner contour (radii minus the width) leaves the
// ring 0.1 device px too thin around ±60° on a 30x45 ellipse stroked 5
// wide (BUG-svg-tier-a-ellipse-coverage, resolved; see
// activity/reports/REPORT-2026-10-07-resolved-bug-records.md). The raster plan
// carries it to the rect shader as bit 17 of the styles word.
export const CMD_RECT_FLAG_SVG_STROKE = layoutConstant("CMD_RECT_FLAG_SVG_STROKE");

// Byte size / gradient-extension offset for a CMD_RECT record, given its
// two independent flag bits. The ONLY functions that should ever compute
// these — every reader/writer (commandByteSize, commands.js, rasterize.js,
// engine.wat's four independent CMD_RECT emit sites) must agree, so derive
// from here rather than re-deriving inline.
export const CMD_TRANSFORM_EXTENSION_SIZE = layoutConstant("CMD_TRANSFORM_EXTENSION_SIZE");
export function cmdRectSize(hasTransform, hasGradient) {
  return CMD_RECT_SIZE + (hasTransform ? CMD_TRANSFORM_EXTENSION_SIZE : 0) +
    (hasGradient ? CMD_RECT_GRADIENT_EXT_SIZE : 0);
}
export function cmdRectGradientOffset(hasTransform) {
  return CMD_RECT_OFFSET_XFORM + (hasTransform ? CMD_TRANSFORM_EXTENSION_SIZE : 0);
}

// --- Push clip command (0x05) ---
// Replaces the rasterizer's CURRENT clip state with a complete,
// self-contained LIST of clip entries (oriented-clip redesign): a 4-byte
// header (opcode, reserved flags, u16 entry count) followed by count fixed-size
// entries. The engine (engine.wat) composes the full effective clip state
// itself — every push carries the WHOLE state, so the rasterizer's clip
// stack is a pure save/restore mechanism (push = replace, pop = restore
// previous); there is no rasterizer-side intersection and no ABSOLUTE
// flag anymore (the pre-redesign wire format's intersect-vs-replace split
// existed only because pushes carried a single pre-intersected rect).
//
// Each ENTRY is one rounded rect in its own coordinate space plus the
// affine mapping that space to screen pixels:
//   - flags (u8): enabledX (bit 0), enabledY (bit 1), AFFINE (bit 2 — the
//     entry carries a non-identity paint transform; without it the rect is
//     already in final screen coordinates and the affine words are zero),
//     PATH_MASK (bit 3), AREA (bit 4 — an SVG viewport: an axis-aligned
//     rect clips each pixel by the area of the rect inside it instead of
//     the hard pixel-centre test an overflow clip uses).
//   - x/y/w/h (f32): the clip rect in the entry's LOCAL space (= layout
//     coordinates when AFFINE is set, screen coordinates otherwise).
//   - radii (f32[8]): per-corner ELLIPTICAL radii (Slice P2), CSS corner
//     order topLeft(rx,ry), topRight(rx,ry), bottomRight(rx,ry),
//     bottomLeft(rx,ry). Circular corner: rx == ry; square: 0,0.
//   - affine (f32[6]): a,b,c,d,e,f — the accumulated paint transform at
//     push time (curXform*), mapping local -> screen. Zeroed when the
//     AFFINE flag is clear.
// A pixel is inside the clip state iff it is inside EVERY entry (each
// evaluated in its own local space via the inverse affine). Entries that
// share an affine (and the same AREA bit) are pre-intersected by the
// engine at append time ($clipListAppend), so one entry per distinct
// transform space and clip kind reaches the wire — the common all-identity
// HTML case is exactly one entry, matching the pre-redesign single-rect
// behavior.
export const CMD_PUSH_CLIP_HEADER_SIZE = layoutConstant("CMD_PUSH_CLIP_HEADER_SIZE");
export const CMD_PUSH_CLIP_OFFSET_FLAGS = layoutConstant("CMD_PUSH_CLIP_OFFSET_FLAGS"); // u8: reserved, 0
export const CMD_PUSH_CLIP_OFFSET_COUNT = layoutConstant("CMD_PUSH_CLIP_OFFSET_COUNT"); // u16: entry count
export const CLIP_ENTRY_SIZE = layoutConstant("CLIP_ENTRY_SIZE"); // 4 flags/pad + 16 rect + 32 radii + 24 affine + 4 pad
export const CLIP_ENTRY_OFFSET_FLAGS = layoutConstant("CLIP_ENTRY_OFFSET_FLAGS"); // u8
export const CLIP_ENTRY_OFFSET_X = layoutConstant("CLIP_ENTRY_OFFSET_X"); // f32
export const CLIP_ENTRY_OFFSET_Y = layoutConstant("CLIP_ENTRY_OFFSET_Y"); // f32
export const CLIP_ENTRY_OFFSET_W = layoutConstant("CLIP_ENTRY_OFFSET_W"); // f32
export const CLIP_ENTRY_OFFSET_H = layoutConstant("CLIP_ENTRY_OFFSET_H"); // f32
export const CLIP_ENTRY_OFFSET_RADII = layoutConstant("CLIP_ENTRY_OFFSET_RADII"); // f32[8]
export const CLIP_ENTRY_OFFSET_AFFINE = layoutConstant("CLIP_ENTRY_OFFSET_AFFINE"); // f32[6]
export const CLIP_ENTRY_FLAG_ENABLED_X = layoutConstant("CLIP_ENTRY_FLAG_ENABLED_X");
export const CLIP_ENTRY_FLAG_ENABLED_Y = layoutConstant("CLIP_ENTRY_FLAG_ENABLED_Y");
export const CLIP_ENTRY_FLAG_AFFINE = layoutConstant("CLIP_ENTRY_FLAG_AFFINE");
export const CLIP_ENTRY_FLAG_PATH_MASK = layoutConstant("CLIP_ENTRY_FLAG_PATH_MASK");
export const CLIP_ENTRY_FLAG_AREA = layoutConstant("CLIP_ENTRY_FLAG_AREA");
// The affine translation is a color glyph's origin, snapped as
// CMD_SVG_PATH_FLAG_GLYPH_ORIGIN snaps it.
export const CLIP_ENTRY_FLAG_GLYPH_ORIGIN = layoutConstant("CLIP_ENTRY_FLAG_GLYPH_ORIGIN");
// D2 piece B: the scroll-table index whose offset positions this entry
// (clip geometry is unshifted like every other payload). Lives in the
// entry's trailing pad, so CLIP_ENTRY_SIZE is unchanged.
export const CLIP_ENTRY_OFFSET_SCROLL_REF = layoutConstant("CLIP_ENTRY_OFFSET_SCROLL_REF"); // u16
export function cmdPushClipSize(entryCount) {
  return CMD_PUSH_CLIP_HEADER_SIZE + entryCount * CLIP_ENTRY_SIZE;
}

// --- Pop clip command (0x06) ---
// 1 byte: just the opcode. Pops the clip stack.
export const CMD_POP_CLIP_SIZE = layoutConstant("CMD_POP_CLIP_SIZE"); // padded to 4-byte alignment

// --- Push opacity command (0x07) ---
// Renders subsequent drawing to an offscreen texture, then composites
// with the given opacity (and, as of Slice 8C, blend mode; as of P8, an
// ordered filter-segment list applied at pop time). This is really "push
// compositing group", not opacity-specific.
//
// P8's filters resolve WAT-side (same "resolved data on the wire, never
// a pool index" convention as CMD_BOX_SHADOW/CMD_RECT's own gradient
// extension — the rasterizer never reads WASM linear memory directly,
// only the command stream) — $paintContext walks the node's whole
// filter list and folds it into an ORDERED SEGMENT list (contiguous
// color-matrix functions fold into ONE matrix segment via repeated
// matrix multiplication; each blur() breaks the fold and becomes its
// own segment — "grayscale(1) blur(4px) brightness(1.5)" becomes
// [MATRIX, BLUR, MATRIX], not one combined matrix) BEFORE calling
// $emitPushOpacity, which writes the resolved segments into this
// optional extension. Segments apply in list order at pop time: a
// MATRIX segment is one composite-shader draw (as step 1), a BLUR
// segment is a six-pass box blur (filter-effects-1 §9.14: Chrome/Skia
// approximate Gaussian blur with a three-pass box blur per axis, NOT a
// true per-pixel Gaussian kernel — see design/paint-coverage.md's P8
// blur design note for the box-width formula).
export const CMD_PUSH_OPACITY_SIZE = layoutConstant("CMD_PUSH_OPACITY_SIZE"); // no filter segments
export const CMD_PUSH_OPACITY_OFFSET_FLAGS = layoutConstant("CMD_PUSH_OPACITY_OFFSET_FLAGS"); // u8: hasClip (bit 0, dead/unused);
// BLEND_* enum in bits 1-4 (Slice 8C)
export const CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT = layoutConstant("CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT");
export const CMD_PUSH_OPACITY_FLAG_BLEND_MASK = layoutConstant("CMD_PUSH_OPACITY_FLAG_BLEND_MASK"); // bits 1-4
// P11: this group's content is MASKED — its CMD_POP_OPACITY multiplies
// the group texture's alpha by the top mask accumulator (built by the
// CMD_PUSH_MASK / CMD_PUSH_MASK_LAYER records emitted just before this
// push) and pops it.
export const CMD_PUSH_OPACITY_FLAG_MASK = layoutConstant("CMD_PUSH_OPACITY_FLAG_MASK"); // bit 5
export const CMD_PUSH_OPACITY_OFFSET_SEGMENT_COUNT = layoutConstant("CMD_PUSH_OPACITY_OFFSET_SEGMENT_COUNT"); // u16 (P8, 0 = no filter)
export const CMD_PUSH_OPACITY_OFFSET_ALPHA = layoutConstant("CMD_PUSH_OPACITY_OFFSET_ALPHA"); // f32
// u8: the Porter-Duff operator the pop composites the group with, on
// premultiplied color over the whole target: COMPOSITE_SOURCE_OVER (0)
// composites with the blend mode; any other reads the target's pixels
// (a backdrop copy) and replaces them, clip coverage mixing the result
// with the backdrop. Color glyph composites (COLRv1 PaintComposite) emit
// them; numbering follows hb_paint_composite_mode_t's Porter-Duff modes.
export const CMD_PUSH_OPACITY_OFFSET_COMPOSITE = layoutConstant("CMD_PUSH_OPACITY_OFFSET_COMPOSITE");
export const COMPOSITE_SOURCE_OVER = layoutConstant("COMPOSITE_SOURCE_OVER");
export const COMPOSITE_CLEAR = layoutConstant("COMPOSITE_CLEAR");
export const COMPOSITE_SOURCE = layoutConstant("COMPOSITE_SOURCE");
export const COMPOSITE_DESTINATION = layoutConstant("COMPOSITE_DESTINATION");
export const COMPOSITE_DESTINATION_OVER = layoutConstant("COMPOSITE_DESTINATION_OVER");
export const COMPOSITE_SOURCE_IN = layoutConstant("COMPOSITE_SOURCE_IN");
export const COMPOSITE_DESTINATION_IN = layoutConstant("COMPOSITE_DESTINATION_IN");
export const COMPOSITE_SOURCE_OUT = layoutConstant("COMPOSITE_SOURCE_OUT");
export const COMPOSITE_DESTINATION_OUT = layoutConstant("COMPOSITE_DESTINATION_OUT");
export const COMPOSITE_SOURCE_ATOP = layoutConstant("COMPOSITE_SOURCE_ATOP");
export const COMPOSITE_DESTINATION_ATOP = layoutConstant("COMPOSITE_DESTINATION_ATOP");
export const COMPOSITE_XOR = layoutConstant("COMPOSITE_XOR");
export const COMPOSITE_PLUS = layoutConstant("COMPOSITE_PLUS");
// Filter-segment array starts here, CMD_PUSH_OPACITY_SEGMENT_SIZE bytes
// per entry, SEGMENT_COUNT entries (P8). Every segment is fixed-size
// (sized to the larger MATRIX variant) regardless of kind — uniform
// stride keeps the walk trivial, same "fixed-stride-per-entry" choice
// as SHADOW_POOL/FILTER_POOL over a variable-size packing.
export const CMD_PUSH_OPACITY_OFFSET_SEGMENTS = layoutConstant("CMD_PUSH_OPACITY_OFFSET_SEGMENTS");
export const CMD_PUSH_OPACITY_SEGMENT_SIZE = layoutConstant("CMD_PUSH_OPACITY_SEGMENT_SIZE"); // 4 (header) + 80 (20 f32, MATRIX's own size)
export const CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND = layoutConstant("CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND"); // u8
export const CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD = layoutConstant("CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD"); // MATRIX: f32[20] row-major 4x5
// (R0..R3,RC, G..., B..., A...);
// BLUR: f32 sigmaX, sigmaY at payload[0..1];
// DROP_SHADOW: dx,dy,sigmaX f32 at
// payload[0..2] + color f32[4] at
// payload[3..6] (mirrors FILTER_POOL's
// own drop-shadow entry layout) + sigmaY
// f32 at payload[7]. Lengths are CSS px,
// already mapped through the element's
// transform by $composeFilterSegments.
export const CMD_PUSH_OPACITY_SEGMENT_KIND_MATRIX = layoutConstant("CMD_PUSH_OPACITY_SEGMENT_KIND_MATRIX");
export const CMD_PUSH_OPACITY_SEGMENT_KIND_BLUR = layoutConstant("CMD_PUSH_OPACITY_SEGMENT_KIND_BLUR");
export const CMD_PUSH_OPACITY_SEGMENT_KIND_DROP_SHADOW = layoutConstant("CMD_PUSH_OPACITY_SEGMENT_KIND_DROP_SHADOW");

export function cmdPushOpacitySize(segmentCount) {
  return CMD_PUSH_OPACITY_SIZE + segmentCount * CMD_PUSH_OPACITY_SEGMENT_SIZE;
}

// --- Pop opacity command (0x08) ---
export const CMD_POP_OPACITY_SIZE = layoutConstant("CMD_POP_OPACITY_SIZE"); // padded to 4-byte alignment

// --- Push/pop backdrop-filter (0x0A / 0x0B, P8b) ---
// Same segment-list shape as CMD_PUSH_OPACITY's own filter extension
// (CMD_PUSH_OPACITY_SEGMENT_*, reused verbatim — same KIND enum, same
// per-segment payload layout) but with no alpha/blendMode fields at
// all, since backdrop-filter has neither.
//
// ALSO carries exactly ONE CLIP_ENTRY-format record (CLIP_ENTRY_SIZE, same
// 80-byte layout CMD_PUSH_CLIP's own entries use) immediately after the
// segment list — the element's own BORDER BOX (+ radii), per spec (filter-
// effects-2 "Apply a clip to the contents of T', using the border box of
// element B... the children of B are not considered"). This is a SEPARATE
// channel from the ordinary clip stack (CMD_PUSH_CLIP/ownClipState):
// backdrop-filter's own composite-back draw must clip to this shape, but
// the element's DESCENDANTS must NOT be clipped by it (backdrop-filter
// does not establish an overflow clip on its own children — confirmed
// against MDN: "it has no direct impact on how child elements are
// rendered... unless you explicitly set overflow:hidden"). Routing it
// through the shared clip-list/CLIP_ARENA (like $resolveClipPathAppend
// does for clip-path) would incorrectly narrow the descendant clip too,
// so it rides directly on this command's own payload instead.
export const CMD_PUSH_BACKDROP_FILTER_SIZE = layoutConstant("CMD_PUSH_BACKDROP_FILTER_SIZE"); // opcode(1) + pad(1) + segmentCount(2) + pad(4)
export const CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENT_COUNT = layoutConstant("CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENT_COUNT"); // u16
export const CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS = layoutConstant("CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS");

export function cmdPushBackdropFilterSize(segmentCount) {
  return CMD_PUSH_BACKDROP_FILTER_SIZE +
    segmentCount * CMD_PUSH_OPACITY_SEGMENT_SIZE + CLIP_ENTRY_SIZE;
}
// Offset of the trailing own-shape CLIP_ENTRY record, past the segment list.
export function cmdPushBackdropFilterOwnShapeOffset(segmentCount) {
  return CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS +
    segmentCount * CMD_PUSH_OPACITY_SEGMENT_SIZE;
}

export const CMD_POP_BACKDROP_FILTER_SIZE = layoutConstant("CMD_POP_BACKDROP_FILTER_SIZE"); // padded to 4-byte alignment

// --- Push/pop mask (0x0C / 0x0D / 0x0E, P11) ---
// A mask is a list of CSS <image> layers rendered into an offscreen
// COVERAGE buffer whose per-pixel value multiplies the alpha of the
// element's own group at CMD_POP_OPACITY time. See design/paint-coverage.md
// Slice P11 for why the coverage is RENDERED (multi-layer, tiled,
// Porter-Duff-composited raster) instead of evaluated analytically the
// way clip-path's path mask is.
//
// CMD_PUSH_MASK pushes a fresh zero-cleared accumulator. It is explicit
// rather than implied by the first layer so NESTED masks (a masked
// descendant inside a masked ancestor's content) need no heuristics on
// the rasterizer side.
export const CMD_PUSH_MASK_SIZE = layoutConstant("CMD_PUSH_MASK_SIZE");
// One mask layer: everything between the push and the pop draws into a
// scratch target, which CMD_POP_MASK_LAYER converts to coverage (per
// MASK_MODE_*) and composites into the accumulator (per MASK_COMPOSITE_*).
// A whole-layer scratch is load-bearing, not a convenience: subtract/
// intersect/exclude must change the accumulator where the layer does NOT
// paint, which per-draw blend state cannot express.
export const CMD_PUSH_MASK_LAYER_SIZE = layoutConstant("CMD_PUSH_MASK_LAYER_SIZE");
export const CMD_PUSH_MASK_LAYER_OFFSET_MODE = layoutConstant("CMD_PUSH_MASK_LAYER_OFFSET_MODE"); // u8: MASK_MODE_*
export const CMD_PUSH_MASK_LAYER_OFFSET_COMPOSITE = layoutConstant("CMD_PUSH_MASK_LAYER_OFFSET_COMPOSITE"); // u8: MASK_COMPOSITE_*
export const CMD_POP_MASK_LAYER_SIZE = layoutConstant("CMD_POP_MASK_LAYER_SIZE");

// --- Push/pop background + per-layer blend (0x0F/0x10/0x11/0x12, P13) ---
// css-compositing-1 §5.2: a background layer blends with the layers BELOW
// it plus the background color, and the resulting stack then composites
// over the page NORMALLY — a background layer must not see what is
// painted behind the element. So the stack renders into its own
// accumulator (CMD_PUSH_BACKGROUND ... CMD_POP_BACKGROUND) and each
// non-normal layer blends within it.
//
// Emitted ONLY when some layer's blend mode is non-normal: the ordinary
// background path stays byte-for-byte what it was.
export const CMD_PUSH_BACKGROUND_SIZE = layoutConstant("CMD_PUSH_BACKGROUND_SIZE");
export const CMD_POP_BACKGROUND_SIZE = layoutConstant("CMD_POP_BACKGROUND_SIZE");
// One layer whose blend mode is non-normal: everything between the push
// and the pop draws into a scratch, which the pop then draws over the
// accumulator through the COMPOSITE pipeline at this blend mode (the pop
// snapshots the accumulator as the backdrop first — popOpacity's existing
// blend path verbatim). A normal-blend layer needs neither bracket nor
// scratch and draws straight into the accumulator.
export const CMD_PUSH_BLEND_LAYER_SIZE = layoutConstant("CMD_PUSH_BLEND_LAYER_SIZE");
export const CMD_PUSH_BLEND_LAYER_OFFSET_MODE = layoutConstant("CMD_PUSH_BLEND_LAYER_OFFSET_MODE"); // u8: BLEND_* enum
export const CMD_POP_BLEND_LAYER_SIZE = layoutConstant("CMD_POP_BLEND_LAYER_SIZE");

// mask-mode (css-masking-1 §5.3). match-source resolves to alpha here:
// the only mask sources sandom has are images and gradients, whose
// match IS alpha (match-source's luminance branch is for <mask> element
// references, which need the DOM layer).
export const MASK_MODE_MATCH_SOURCE = layoutConstant("MASK_MODE_MATCH_SOURCE"); // CSS initial
export const MASK_MODE_ALPHA = layoutConstant("MASK_MODE_ALPHA");
export const MASK_MODE_LUMINANCE = layoutConstant("MASK_MODE_LUMINANCE");

// mask-composite (css-masking-1 §5.7), applied between a layer and the
// accumulated result of every layer below it. Coverage rides in ALPHA,
// so each mode is an ordinary alpha blend state — see rasterize.js's
// MASK_COMPOSITE_BLEND for the factor pairs.
export const MASK_COMPOSITE_ADD = layoutConstant("MASK_COMPOSITE_ADD"); // CSS initial
export const MASK_COMPOSITE_SUBTRACT = layoutConstant("MASK_COMPOSITE_SUBTRACT");
export const MASK_COMPOSITE_INTERSECT = layoutConstant("MASK_COMPOSITE_INTERSECT");
export const MASK_COMPOSITE_EXCLUDE = layoutConstant("MASK_COMPOSITE_EXCLUDE");

// mask-origin / mask-clip. NOTE both enums differ from the background-*
// ones they mirror: mask-origin's CSS initial is BORDER-box (background-
// origin's is padding-box) and mask-clip adds no-clip. Each puts its own
// CSS initial at 0 so a zeroed pool entry reads as the CSS defaults.
export const MASK_ORIGIN_BORDER_BOX = layoutConstant("MASK_ORIGIN_BORDER_BOX"); // CSS initial
export const MASK_ORIGIN_PADDING_BOX = layoutConstant("MASK_ORIGIN_PADDING_BOX");
export const MASK_ORIGIN_CONTENT_BOX = layoutConstant("MASK_ORIGIN_CONTENT_BOX");
export const MASK_ORIGIN_STROKE_BOX = layoutConstant("MASK_ORIGIN_STROKE_BOX");
export const MASK_ORIGIN_VIEW_BOX = layoutConstant("MASK_ORIGIN_VIEW_BOX");
export const MASK_CLIP_BORDER_BOX = layoutConstant("MASK_CLIP_BORDER_BOX"); // CSS initial
export const MASK_CLIP_PADDING_BOX = layoutConstant("MASK_CLIP_PADDING_BOX");
export const MASK_CLIP_CONTENT_BOX = layoutConstant("MASK_CLIP_CONTENT_BOX");
export const MASK_CLIP_STROKE_BOX = layoutConstant("MASK_CLIP_STROKE_BOX");
export const MASK_CLIP_VIEW_BOX = layoutConstant("MASK_CLIP_VIEW_BOX");
export const MASK_CLIP_NO_CLIP = layoutConstant("MASK_CLIP_NO_CLIP");

// --- Box-shadow command (0x04) ---
// P3: a blurred, offset, spread-adjusted rounded rect in the shadow color.
// The engine computes final geometry (offset applied, spread inflated/
// deflated, corner radii spread-adjusted per css-backgrounds-3 §7.1's
// curvature rule) — the rasterizer stays dumb, same division of labor as
// every other command. Corner radii are per-corner and ELLIPTICAL, same
// 8-f32 (rx,ry) x 4-corner layout and CSS corner order as CMD_PUSH_CLIP's
// OFFSET_RADII (topLeft, topRight, bottomRight, bottomLeft) — a box-shadow
// must match its node's own (possibly elliptical, post-P10) border-radius
// shape, so it reuses the same per-corner format rather than PLAN-paint-
// coverage.md's original pre-P10 4-float sketch.
//   flags (u8)     — bit 0 = inset, bit 1 = transform
//   rect (f32[4])  — x,y,w,h; already offset+spread-adjusted (for INSET,
//                    this is the DEFLATED "hole" rect — the coverage-
//                    inversion boundary, not the node's own border box)
//   radii (f32[8]) — spread-adjusted per-corner (rx,ry), see above
//   color (f32[4]) — straight (not premultiplied) rgba
//   blurSigma (f32) — CSS blur-radius/2 (spec: half the blur length),
//                     already resolved by the engine; 0 = no blur (a
//                     plain rect, no analytic approximation needed)
//   transform (f32[6]) — only present if flag bit 1 set
//
// Border-box extension: appended AFTER the transform block (present or
// not — see cmdBoxShadowInsetClipOffset() below), when flag bit 2 is set,
// which the engine sets on every shadow it emits (bit 0 alone marks the
// older inset-only form). The node's ORIGINAL (un-spread) rect+radii:
// an inset shadow is clipped to the box's own outer edge (the deflated
// rect above is the coverage-inversion boundary, not the clip); an outset
// shadow is clipped OUT of the border box (css-backgrounds-3 §7.1) —
// under an opaque background the box covers it anyway, under a
// translucent one, or while a background-color transition runs, the
// interior must stay clear.
//   borderBoxRect (f32[4])  — the node's own x,y,w,h, UNADJUSTED by
//                             spread (only the offset+spread-adjusted
//                             rect above reflects spread)
//   borderBoxRadii (f32[8]) — the node's own per-corner (rx,ry), same
//                             order as the main radii field, but
//                             UNADJUSTED by spread's curvature rule
export const CMD_BOX_SHADOW_SIZE = layoutConstant("CMD_BOX_SHADOW_SIZE"); // no transform, no border-box ext
export const CMD_BOX_SHADOW_SIZE_XFORM = layoutConstant("CMD_BOX_SHADOW_SIZE_XFORM"); // transform, no border-box ext
export const CMD_BOX_SHADOW_INSET_EXT_SIZE = layoutConstant("CMD_BOX_SHADOW_INSET_EXT_SIZE"); // borderBoxRect(4)+radii(8) = 12 floats
export const CMD_BOX_SHADOW_OFFSET_FLAGS = layoutConstant("CMD_BOX_SHADOW_OFFSET_FLAGS"); // u8
export const CMD_BOX_SHADOW_OFFSET_X = layoutConstant("CMD_BOX_SHADOW_OFFSET_X"); // f32
export const CMD_BOX_SHADOW_OFFSET_Y = layoutConstant("CMD_BOX_SHADOW_OFFSET_Y"); // f32
export const CMD_BOX_SHADOW_OFFSET_W = layoutConstant("CMD_BOX_SHADOW_OFFSET_W"); // f32
export const CMD_BOX_SHADOW_OFFSET_H = layoutConstant("CMD_BOX_SHADOW_OFFSET_H"); // f32
export const CMD_BOX_SHADOW_OFFSET_RADII = layoutConstant("CMD_BOX_SHADOW_OFFSET_RADII"); // f32[8], see above
export const CMD_BOX_SHADOW_OFFSET_COLOR = layoutConstant("CMD_BOX_SHADOW_OFFSET_COLOR"); // f32[4]
export const CMD_BOX_SHADOW_OFFSET_BLUR_SIGMA = layoutConstant("CMD_BOX_SHADOW_OFFSET_BLUR_SIGMA"); // f32
export const CMD_BOX_SHADOW_OFFSET_XFORM = layoutConstant("CMD_BOX_SHADOW_OFFSET_XFORM"); // f32[6], only if flag set
// Inset border-box extension field offsets, RELATIVE to the extension's
// own start (cmdBoxShadowInsetClipOffset()) — mirrors CMD_RECT_GRADIENT_
// OFFSET_*'s own "offsets relative to the extension block" convention.
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_X = layoutConstant("CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_X"); // f32
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_Y = layoutConstant("CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_Y"); // f32
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_W = layoutConstant("CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_W"); // f32
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_H = layoutConstant("CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_H"); // f32
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_RADII = layoutConstant("CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_RADII"); // f32[8]

export const CMD_BOX_SHADOW_FLAG_INSET = layoutConstant("CMD_BOX_SHADOW_FLAG_INSET");
export const CMD_BOX_SHADOW_FLAG_TRANSFORM = layoutConstant("CMD_BOX_SHADOW_FLAG_TRANSFORM");
export const CMD_BOX_SHADOW_FLAG_BORDER_BOX = layoutConstant("CMD_BOX_SHADOW_FLAG_BORDER_BOX");

// Byte size / border-box-extension offset for a CMD_BOX_SHADOW record,
// given its flag bits — mirrors cmdRectSize()/cmdRectGradientOffset()'s
// own "single source of truth" rationale (every reader/writer must agree
// on these, so derive from here rather than re-deriving inline). The
// extension is present for an inset shadow or a border-box-flagged one.
export function cmdBoxShadowSize(hasTransform, hasBorderBox) {
  return CMD_BOX_SHADOW_SIZE + (hasTransform ? CMD_TRANSFORM_EXTENSION_SIZE : 0) +
    (hasBorderBox ? CMD_BOX_SHADOW_INSET_EXT_SIZE : 0);
}
export function cmdBoxShadowInsetClipOffset(hasTransform) {
  return CMD_BOX_SHADOW_OFFSET_XFORM + (hasTransform ? CMD_TRANSFORM_EXTENSION_SIZE : 0);
}

// --- Text command (0x02) ---
export const CMD_TEXT_SIZE = layoutConstant("CMD_TEXT_SIZE"); // without transform
export const CMD_TEXT_SIZE_XFORM = layoutConstant("CMD_TEXT_SIZE_XFORM"); // with transform
export const CMD_TEXT_OFFSET_FLAGS = layoutConstant("CMD_TEXT_OFFSET_FLAGS"); // u8
export const CMD_TEXT_OFFSET_GCOUNT = layoutConstant("CMD_TEXT_OFFSET_GCOUNT"); // u16 glyph count
export const CMD_TEXT_OFFSET_GOFF = layoutConstant("CMD_TEXT_OFFSET_GOFF"); // u32 glyph buffer offset
export const CMD_TEXT_OFFSET_X = layoutConstant("CMD_TEXT_OFFSET_X"); // f32
export const CMD_TEXT_OFFSET_Y = layoutConstant("CMD_TEXT_OFFSET_Y"); // f32
export const CMD_TEXT_OFFSET_FSIZE = layoutConstant("CMD_TEXT_OFFSET_FSIZE"); // f32 fontSize
export const CMD_TEXT_OFFSET_LH = layoutConstant("CMD_TEXT_OFFSET_LH"); // f32 lineHeight
export const CMD_TEXT_OFFSET_BL = layoutConstant("CMD_TEXT_OFFSET_BL"); // f32 baseline
export const CMD_TEXT_OFFSET_COLOR = layoutConstant("CMD_TEXT_OFFSET_COLOR"); // f32[4]
export const CMD_TEXT_OFFSET_UPEM = layoutConstant("CMD_TEXT_OFFSET_UPEM"); // u16
export const CMD_TEXT_OFFSET_FONT = layoutConstant("CMD_TEXT_OFFSET_FONT"); // u16 fontIndex
export const CMD_TEXT_OFFSET_WEIGHT = layoutConstant("CMD_TEXT_OFFSET_WEIGHT"); // u8
export const CMD_TEXT_OFFSET_STYLE = layoutConstant("CMD_TEXT_OFFSET_STYLE"); // u8 (0=normal, 1=italic)
// u16: the variation key of the glyph outlines, a shaping context index
// (0 for none); text_variation_control reads its variation control.
export const CMD_TEXT_OFFSET_VARIATIONS = layoutConstant("CMD_TEXT_OFFSET_VARIATIONS");
export const CMD_TEXT_OFFSET_ASCENT = layoutConstant("CMD_TEXT_OFFSET_ASCENT"); // f32 line-box ascent
export const CMD_TEXT_OFFSET_DESCENT = layoutConstant("CMD_TEXT_OFFSET_DESCENT"); // f32 line-box descent
export const CMD_TEXT_OFFSET_OPSZ = layoutConstant("CMD_TEXT_OFFSET_OPSZ"); // f32 optical size of the outlines (CSS px)
export const CMD_TEXT_OFFSET_XFORM = layoutConstant("CMD_TEXT_OFFSET_XFORM"); // f32[6] (only if flag set)

// Text flags
export const CMD_TEXT_FLAG_TRANSFORM = layoutConstant("CMD_TEXT_FLAG_TRANSFORM");
export const CMD_TEXT_FLAG_TEXT_SHADOW = layoutConstant("CMD_TEXT_FLAG_TEXT_SHADOW");

// text-shadow extension (P6): appended AFTER the transform block
// (present or not), same additive-blocks shape as CMD_RECT's gradient
// extension. One extension per command — a run with N text-shadows
// emits N shadow-flagged copies of its CMD_TEXT (referencing the SAME
// glyph span) before the plain ink command; a blurred shadow's copy sits
// in a CMD_PUSH_OPACITY group with one blur segment; see
// $advanceTextCommand.
// Offsets below are relative to the extension base (cmdTextShadowExtOffset).
export const CMD_TEXT_SHADOW_EXT_SIZE = layoutConstant("CMD_TEXT_SHADOW_EXT_SIZE"); // color(4) + offset(2) f32s
export const CMD_TEXT_SHADOW_OFFSET_COLOR = layoutConstant("CMD_TEXT_SHADOW_OFFSET_COLOR"); // f32[4]
export const CMD_TEXT_SHADOW_OFFSET_OFFSET_X = layoutConstant("CMD_TEXT_SHADOW_OFFSET_OFFSET_X"); // f32
export const CMD_TEXT_SHADOW_OFFSET_OFFSET_Y = layoutConstant("CMD_TEXT_SHADOW_OFFSET_OFFSET_Y"); // f32

// Byte size / shadow-extension offset for a CMD_TEXT record — single
// source of truth, same rationale as cmdRectSize/cmdBoxShadowSize.
export function cmdTextSize(hasTransform, hasShadow) {
  return CMD_TEXT_SIZE + (hasTransform ? CMD_TRANSFORM_EXTENSION_SIZE : 0) +
    (hasShadow ? CMD_TEXT_SHADOW_EXT_SIZE : 0);
}
export function cmdTextShadowExtOffset(hasTransform) {
  return CMD_TEXT_SIZE + (hasTransform ? CMD_TRANSFORM_EXTENSION_SIZE : 0);
}

// --- Image command (0x03, Slice P5a) ---
// Textured quad: dest rect in the node's border box, source UV rect
// pre-computed by the ENGINE from object-fit/object-position
// (design/paint-coverage.md P5b) — the rasterizer only ever samples the
// given UV rect, it doesn't know what object-fit mode produced it.
export const CMD_IMAGE_SIZE = layoutConstant("CMD_IMAGE_SIZE"); // without transform
export const CMD_IMAGE_SIZE_XFORM = layoutConstant("CMD_IMAGE_SIZE_XFORM"); // with transform
export const CMD_IMAGE_OFFSET_FLAGS = layoutConstant("CMD_IMAGE_OFFSET_FLAGS"); // u8
export const CMD_IMAGE_OFFSET_INDEX = layoutConstant("CMD_IMAGE_OFFSET_INDEX"); // u16: IMAGE_TABLE index
export const CMD_IMAGE_OFFSET_X = layoutConstant("CMD_IMAGE_OFFSET_X"); // f32: dest rect
export const CMD_IMAGE_OFFSET_Y = layoutConstant("CMD_IMAGE_OFFSET_Y"); // f32
export const CMD_IMAGE_OFFSET_W = layoutConstant("CMD_IMAGE_OFFSET_W"); // f32
export const CMD_IMAGE_OFFSET_H = layoutConstant("CMD_IMAGE_OFFSET_H"); // f32
export const CMD_IMAGE_OFFSET_UV_X = layoutConstant("CMD_IMAGE_OFFSET_UV_X"); // f32: source UV rect (0..1)
export const CMD_IMAGE_OFFSET_UV_Y = layoutConstant("CMD_IMAGE_OFFSET_UV_Y"); // f32
export const CMD_IMAGE_OFFSET_UV_W = layoutConstant("CMD_IMAGE_OFFSET_UV_W"); // f32
export const CMD_IMAGE_OFFSET_UV_H = layoutConstant("CMD_IMAGE_OFFSET_UV_H"); // f32
export const CMD_IMAGE_OFFSET_XFORM = layoutConstant("CMD_IMAGE_OFFSET_XFORM"); // f32[6] (only if flag set)

// Image flags
export const CMD_IMAGE_FLAG_TRANSFORM = layoutConstant("CMD_IMAGE_FLAG_TRANSFORM");
// image-rendering: pixelated (P10): the rasterizer samples this draw with
// a nearest-neighbor sampler clamped to mip level 0 (Chrome-faithful
// decimation on downscale too), instead of the linear+mipmap default.
export const CMD_IMAGE_FLAG_PIXELATED = layoutConstant("CMD_IMAGE_FLAG_PIXELATED");
// Suppress the rasterizer's destination pixel snapping. Chrome rounds an
// ELEMENT-level image's destination rect to whole device pixels before
// painting it — a plain <img> at top:20.5px lands on rows 21-40 with hard
// edges, not on rows 20-39 and not antialiased — so that snap is the
// DEFAULT here and every element-level emitter (<img>, background layers)
// simply leaves this flag clear. A border-image PIECE is different: Blink
// snaps the nine-piece grid's OUTER rect once and then subdivides it, so
// the individual pieces legitimately land on fractional boundaries and are
// painted with real partial coverage (measured against Chrome: a `space`
// edge's tile seams read 0.25/0.50/0.75 of a row, not 0 or 1). Snapping
// those a second time would quantise geometry Chrome leaves fractional,
// which is what this flag exists to prevent. See src/rasterize.js's
// CMD_IMAGE batching for the snap itself.
export const CMD_IMAGE_FLAG_NO_PIXEL_SNAP = layoutConstant("CMD_IMAGE_FLAG_NO_PIXEL_SNAP");
// Per-side "this edge is SHARED with a neighbouring draw, not a silhouette".
// The rasterizer antialiases an image draw's outline against the pixel grid;
// two abutting draws that each antialias their shared edge composite to less
// than full coverage there (src-over: p + q - pq < 1 for p+q == 1), leaving a
// visible seam line along a boundary that should not be visible at all. Chrome
// never produces one because it paints a tiled edge as a SINGLE tiled fill
// rather than as N quads. A marked side falls back to the hardware's own
// pixel-centre ownership rule, which partitions the boundary pixel between the
// two draws exactly — no seam, no double-composite. Emitted by border-image's
// nine-piece grid (corner-to-edge, edge-to-centre, and tile-to-tile inside a
// contiguous `repeat`/`round`/`stretch` run; `space` tiles have real gaps and
// are deliberately left unmarked so their outlines DO antialias, which is what
// Chrome shows there).
export const CMD_IMAGE_FLAG_ABUT_LEFT = layoutConstant("CMD_IMAGE_FLAG_ABUT_LEFT");
export const CMD_IMAGE_FLAG_ABUT_TOP = layoutConstant("CMD_IMAGE_FLAG_ABUT_TOP");
export const CMD_IMAGE_FLAG_ABUT_RIGHT = layoutConstant("CMD_IMAGE_FLAG_ABUT_RIGHT");
export const CMD_IMAGE_FLAG_ABUT_BOTTOM = layoutConstant("CMD_IMAGE_FLAG_ABUT_BOTTOM");
// A color glyph bitmap (design/text-rendering.md, "Colour glyphs"): the command's
// X, Y, W, H are the glyph's em square above its origin (X, Y + H), the
// font size W = H, and the index is COLOR_GLYPH_IMAGE_INDEX_BASE + slot.
// The raster plan places the image from the strike metrics of the image
// resource (see COLOR_GLYPH_IMAGE_RESOURCE_COUNT) and snaps the origin as
// CMD_SVG_PATH_FLAG_GLYPH_ORIGIN does when the command has no transform.
export const CMD_IMAGE_FLAG_GLYPH_BITMAP = layoutConstant("CMD_IMAGE_FLAG_GLYPH_BITMAP");
// CMD_IMAGE indices from COLOR_GLYPH_IMAGE_INDEX_BASE up to
// COLOR_GLYPH_CACHE_INDEX_BASE name color glyph bitmap slots (engine
// color_glyph_bitmap_*); IMAGE_TABLE indices stay below it.
export const COLOR_GLYPH_IMAGE_INDEX_BASE = layoutConstant("COLOR_GLYPH_IMAGE_INDEX_BASE");
// The raster image resource of a glyph bitmap holds three 12-byte records:
// (width, height, kind) in texels as every image resource, then the image
// box in ems of the font size relative to the glyph origin, y down:
// (left, top, width), (height, whole pixel, 0); whole pixel 1 draws the
// origin at x rounded (sbix), 0 at Skia's quarter-pixel x (CBDT).
export const COLOR_GLYPH_IMAGE_RESOURCE_COUNT = layoutConstant("COLOR_GLYPH_IMAGE_RESOURCE_COUNT");
// The color glyph cache (design/text-rendering.md, "Colour glyphs"): a COLR glyph
// of axis-aligned, unscaled text is one CMD_IMAGE with
// CMD_IMAGE_FLAG_GLYPH_BITMAP | CMD_IMAGE_FLAG_PIXELATED whose index is
// COLOR_GLYPH_CACHE_INDEX_BASE + a cache slot (engine color_glyph_cache_*:
// a glyph program at one font size and, when it paints the text color,
// that color). X, Y, W, H are the instance's ink box in CSS px; UV_X,
// UV_Y are its glyph origin, the translation the glyph's uncached layers
// carry, which the raster plan snaps as CMD_SVG_PATH_FLAG_GLYPH_ORIGIN;
// UV_W, UV_H are 0. The host renders each slot once for each device scale
// into an RGBA atlas page (image index COLOR_GLYPH_CACHE_PAGE_INDEX_BASE +
// page) and writes the slot's image resource, COLOR_GLYPH_CACHE_RESOURCE_COUNT
// 12-byte records: (page width, page height, 0), (left, top, width),
// (height, u, v), (page image index, 0, 0), the entry's box in device
// pixels from its snapped origin and its texel position in the page.
export const COLOR_GLYPH_CACHE_INDEX_BASE = layoutConstant("COLOR_GLYPH_CACHE_INDEX_BASE");
export const COLOR_GLYPH_CACHE_CAPACITY = layoutConstant("COLOR_GLYPH_CACHE_CAPACITY");
export const COLOR_GLYPH_CACHE_PAGE_INDEX_BASE = layoutConstant("COLOR_GLYPH_CACHE_PAGE_INDEX_BASE");
export const COLOR_GLYPH_CACHE_RESOURCE_COUNT = layoutConstant("COLOR_GLYPH_CACHE_RESOURCE_COUNT");

// --- SVG path command (0x09, design/svg-rendering.md Tier B) ---
// A textured quad through the MSDF pipeline, same shader FAMILY as
// CMD_TEXT (median-of-3-channel distance field) but a solid-color
// fragment path with no Skia-glyph-mask gamma remap (that's a text-
// rasterizer convention, not an SVG one — see rasterize.js's SVG_PATH_SHADER).
// The host supplies generated fields before native atlas packing.
// core/engine/glyph-atlas.watpart owns content/scale keys, placement, and aliases;
// src/atlas.js exposes them to the host. The rasterizer resolves pathIndex
// through the path resource table, as CMD_TEXT resolves glyph resources.
// pathIndex is the core-assigned path identity (LAYOUT_NODE_OFFSET_SVG_PATH_INDEX,
// aliasing IMAGE_INDEX). The vendor generator parses geometry.
export const CMD_SVG_PATH_SIZE = layoutConstant("CMD_SVG_PATH_SIZE"); // without transform, without gradient
export const CMD_SVG_PATH_SIZE_XFORM = layoutConstant("CMD_SVG_PATH_SIZE_XFORM"); // with transform, without gradient
export const CMD_SVG_PATH_OFFSET_FLAGS = layoutConstant("CMD_SVG_PATH_OFFSET_FLAGS"); // u8
export const CMD_SVG_PATH_OFFSET_INDEX = layoutConstant("CMD_SVG_PATH_OFFSET_INDEX"); // u16: native path identity
export const CMD_SVG_PATH_OFFSET_X = layoutConstant("CMD_SVG_PATH_OFFSET_X"); // f32: dest rect (viewport-transformed bbox)
export const CMD_SVG_PATH_OFFSET_Y = layoutConstant("CMD_SVG_PATH_OFFSET_Y"); // f32
export const CMD_SVG_PATH_OFFSET_W = layoutConstant("CMD_SVG_PATH_OFFSET_W"); // f32
export const CMD_SVG_PATH_OFFSET_H = layoutConstant("CMD_SVG_PATH_OFFSET_H"); // f32
export const CMD_SVG_PATH_OFFSET_COLOR = layoutConstant("CMD_SVG_PATH_OFFSET_COLOR"); // f32[4]: fill color, fill-opacity folded into alpha
export const CMD_SVG_PATH_OFFSET_XFORM = layoutConstant("CMD_SVG_PATH_OFFSET_XFORM"); // f32[6] (only if flag set)

export const CMD_SVG_PATH_FLAG_TRANSFORM = layoutConstant("CMD_SVG_PATH_FLAG_TRANSFORM");
// S7 step 2 (Tier B gradients): a fill command carries svgFillGradient, a
// stroke outline command svgStrokeGradient (the path node's one background
// layer). Same shape as CMD_RECT_FLAG_GRADIENT's own extension (see its own
// doc comment) — appended AFTER the transform block, present or not, per
// cmdSvgPathGradientOffset() below.
export const CMD_SVG_PATH_FLAG_GRADIENT = layoutConstant("CMD_SVG_PATH_FLAG_GRADIENT");
// A color glyph layer (design/text-rendering.md, "Colour glyphs"): the transform's
// translation is the glyph's origin. The raster plan snaps it to the device
// pixel Skia draws a color glyph image at: floor(x + 1/8), floor(y + 1/2)
// (the integer part of Skia's quarter-pixel glyph position; measured
// against the pinned Chrome 2026-10-05).
export const CMD_SVG_PATH_FLAG_GLYPH_ORIGIN = layoutConstant("CMD_SVG_PATH_FLAG_GLYPH_ORIGIN");
// A stroked glyph outline (engine-text-stroke.watpart): the command's
// rectangle, in path units, bounds the path; the raster plan draws the
// atlas entry at the entry's own bounds, whose stroke joins and dashes
// only the atlas measures.
export const CMD_SVG_PATH_FLAG_ENTRY_BOUNDS = layoutConstant("CMD_SVG_PATH_FLAG_ENTRY_BOUNDS");
export const CMD_SVG_PATH_GRADIENT_EXT_SIZE = layoutConstant("CMD_SVG_PATH_GRADIENT_EXT_SIZE");
export const CMD_SVG_PATH_GRADIENT_OFFSET_KIND = layoutConstant("CMD_SVG_PATH_GRADIENT_OFFSET_KIND"); // u8
export const CMD_SVG_PATH_GRADIENT_OFFSET_STOP_COUNT = layoutConstant("CMD_SVG_PATH_GRADIENT_OFFSET_STOP_COUNT"); // u8
export const CMD_SVG_PATH_GRADIENT_OFFSET_FLAGS = layoutConstant("CMD_SVG_PATH_GRADIENT_OFFSET_FLAGS"); // u8: bit0=tiled (always 0 for SVG — paint servers pad)
export const CMD_SVG_PATH_GRADIENT_OFFSET_STOP_OFFSET = layoutConstant("CMD_SVG_PATH_GRADIENT_OFFSET_STOP_OFFSET"); // u32
export const CMD_SVG_PATH_GRADIENT_OFFSET_GEOM = layoutConstant("CMD_SVG_PATH_GRADIENT_OFFSET_GEOM"); // f32[4]
export const CMD_SVG_PATH_GRADIENT_OFFSET_ORIGIN = layoutConstant("CMD_SVG_PATH_GRADIENT_OFFSET_ORIGIN"); // f32[4] {dx,dy,w,h}: the fill path's box from the painted box's top-left

// Byte size / gradient-extension offset for a CMD_SVG_PATH record, given
// its two independent flag bits — same "every reader/writer agrees, no
// hand-derived inline size" discipline as cmdRectSize()/
// cmdRectGradientOffset() above.
export function cmdSvgPathSize(hasTransform, hasGradient) {
  return CMD_SVG_PATH_SIZE + (hasTransform ? CMD_TRANSFORM_EXTENSION_SIZE : 0) +
    (hasGradient ? CMD_SVG_PATH_GRADIENT_EXT_SIZE : 0);
}
export function cmdSvgPathGradientOffset(hasTransform) {
  return CMD_SVG_PATH_OFFSET_XFORM + (hasTransform ? CMD_TRANSFORM_EXTENSION_SIZE : 0);
}

// Color glyphs (design/text-rendering.md, "Colour glyphs"; engine-color-glyph.watpart).
// A CMD_SVG_PATH index from COLOR_GLYPH_PATH_INDEX_BASE up to
// TEXT_STROKE_PATH_INDEX_BASE names the outline of a color glyph layer: slot
// (index - base) of the engine's path slots (color_glyph_path_key: font
// index << 16 | glyph). DOM and authored path registry indices stay below the base.
export const COLOR_GLYPH_PATH_INDEX_BASE = layoutConstant("COLOR_GLYPH_PATH_INDEX_BASE");
// A CMD_SVG_PATH index from TEXT_STROKE_PATH_INDEX_BASE on names the
// stroked outline of a glyph of SVG text: slot (index - base) of the
// engine's text stroke slots (engine-text-stroke.watpart), whose
// definition the core writes (svg_path_definition).
export const TEXT_STROKE_PATH_INDEX_BASE = layoutConstant("TEXT_STROKE_PATH_INDEX_BASE");
// The registered hb_font draws outlines at units per em ×
// FONT_UNIT_SUBDIVISION (engine-constants.watpart $FONT_UNIT_SUBDIVISION).
export const FONT_UNIT_SUBDIVISION = layoutConstant("FONT_UNIT_SUBDIVISION");
// COLR gradient kinds of a CMD_SVG_PATH gradient extension: geom f32[4] and
// origin f32[0..1] are an affine (a, b, c, d, e, f) from the position in the
// painted box to the canonical space, origin f32[2..3] two parameters.
// 4 linear (t = x), 5 radial (centers (0, 0) and (1, 0), radii r0 r1),
// 6 concentric radial (radii r0 r1), 7 sweep (start and end angle, radians,
// counter-clockwise from +x with y up). Kind bit 7 = repeat, bit 6 =
// reflect.
export const GRADIENT_KIND_COLR_LINEAR = layoutConstant("GRADIENT_KIND_COLR_LINEAR");
export const GRADIENT_KIND_COLR_RADIAL = layoutConstant("GRADIENT_KIND_COLR_RADIAL");
export const GRADIENT_KIND_COLR_RADIAL_CONCENTRIC = layoutConstant("GRADIENT_KIND_COLR_RADIAL_CONCENTRIC");
export const GRADIENT_KIND_COLR_SWEEP = layoutConstant("GRADIENT_KIND_COLR_SWEEP");
export const GRADIENT_KIND_FLAG_REFLECT = layoutConstant("GRADIENT_KIND_FLAG_REFLECT");

// Shared sizing rules for the JS walker and generated native header. Sizes
// still come from the maintained helpers above; native generation checks
// the complete encoded input domain before emitting a compact size rule.
const commandSizeRules = {
  __proto__: null,
  [CMD_RECT]: {
    inputOffset: CMD_RECT_OFFSET_FLAGS,
    inputBytes: 1,
    size: (flags) =>
      cmdRectSize(
        (flags & CMD_RECT_FLAG_TRANSFORM) !== 0,
        (flags & CMD_RECT_FLAG_GRADIENT) !== 0,
      ),
  },
  [CMD_TEXT]: {
    inputOffset: CMD_TEXT_OFFSET_FLAGS,
    inputBytes: 1,
    size: (flags) =>
      cmdTextSize(
        (flags & CMD_TEXT_FLAG_TRANSFORM) !== 0,
        (flags & CMD_TEXT_FLAG_TEXT_SHADOW) !== 0,
      ),
  },
  [CMD_IMAGE]: {
    inputOffset: CMD_IMAGE_OFFSET_FLAGS,
    inputBytes: 1,
    size: (flags) =>
      flags & CMD_IMAGE_FLAG_TRANSFORM ? CMD_IMAGE_SIZE_XFORM : CMD_IMAGE_SIZE,
  },
  [CMD_SVG_PATH]: {
    inputOffset: CMD_SVG_PATH_OFFSET_FLAGS,
    inputBytes: 1,
    size: (flags) =>
      cmdSvgPathSize(
        (flags & CMD_SVG_PATH_FLAG_TRANSFORM) !== 0,
        (flags & CMD_SVG_PATH_FLAG_GRADIENT) !== 0,
      ),
  },
  [CMD_BOX_SHADOW]: {
    inputOffset: CMD_BOX_SHADOW_OFFSET_FLAGS,
    inputBytes: 1,
    size: (flags) =>
      cmdBoxShadowSize(
        (flags & CMD_BOX_SHADOW_FLAG_TRANSFORM) !== 0,
        (flags & (CMD_BOX_SHADOW_FLAG_INSET | CMD_BOX_SHADOW_FLAG_BORDER_BOX)) !== 0,
      ),
  },
  [CMD_PUSH_CLIP]: {
    inputOffset: CMD_PUSH_CLIP_OFFSET_COUNT,
    inputBytes: 2,
    size: cmdPushClipSize,
  },
  [CMD_POP_CLIP]: { size: CMD_POP_CLIP_SIZE },
  [CMD_PUSH_OPACITY]: {
    inputOffset: CMD_PUSH_OPACITY_OFFSET_SEGMENT_COUNT,
    inputBytes: 2,
    size: cmdPushOpacitySize,
  },
  [CMD_POP_OPACITY]: { size: CMD_POP_OPACITY_SIZE },
  [CMD_PUSH_BACKDROP_FILTER]: {
    inputOffset: CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENT_COUNT,
    inputBytes: 2,
    size: cmdPushBackdropFilterSize,
  },
  [CMD_POP_BACKDROP_FILTER]: { size: CMD_POP_BACKDROP_FILTER_SIZE },
  [CMD_PUSH_MASK]: { size: CMD_PUSH_MASK_SIZE },
  [CMD_PUSH_MASK_LAYER]: { size: CMD_PUSH_MASK_LAYER_SIZE },
  [CMD_POP_MASK_LAYER]: { size: CMD_POP_MASK_LAYER_SIZE },
  [CMD_SET_SCROLL]: { size: CMD_SET_SCROLL_SIZE },
  [CMD_PUSH_BACKGROUND]: { size: CMD_PUSH_BACKGROUND_SIZE },
  [CMD_PUSH_BLEND_LAYER]: { size: CMD_PUSH_BLEND_LAYER_SIZE },
  [CMD_POP_BLEND_LAYER]: { size: CMD_POP_BLEND_LAYER_SIZE },
  [CMD_POP_BACKGROUND]: { size: CMD_POP_BACKGROUND_SIZE },
  [CMD_SET_NODE]: { size: CMD_SET_NODE_SIZE },
  [CMD_SCROLLBAR]: { size: CMD_SCROLLBAR_SIZE },
};
for (const opcode in commandSizeRules) Object.freeze(commandSizeRules[opcode]);
export const COMMAND_SIZE_RULES = Object.freeze(commandSizeRules);

// Byte size of the command at `offset` in a command stream, including the
// flag-dependent variants (transform-carrying rect/text records). Every
// command-stream walker must advance with this — a walker that hand-picks
// sizes for the opcodes it cares about and stops (or guesses) on the rest
// desyncs the moment a stream interleaves an opcode it didn't expect. That
// exact failure mode shipped once: glyph-atlas collection stopped at the
// first CMD_PUSH_CLIP, so every text command painted after any clip (or
// opacity/blend group) silently lost its atlas and rendered zero ink.
// Throws on an opcode with no size rule here, so a future command type
// fails loudly in every walker at once instead of truncating one of them.
export function commandByteSize(view, offset) {
  const opcode = view.getUint8(offset);
  const rule = COMMAND_SIZE_RULES[opcode];
  if (!rule) {
    throw new Error(
      `commandByteSize: unknown opcode 0x${
        opcode.toString(16)
      } at command-stream offset ${offset}`,
    );
  }
  if (typeof rule.size === "number") return rule.size;
  const inputOffset = offset + rule.inputOffset;
  const input = rule.inputBytes === 1
    ? view.getUint8(inputOffset)
    : view.getUint16(inputOffset, true);
  return rule.size(input);
}

// =======================================================================
// Glyph buffer
// =======================================================================
//
// Packed glyph records referenced by text commands.
// Each glyph contains its identifier, its pen (cumulative offset), its
// advance, its prepared-source UTF-8 cluster range and its ink offset from
// the pen (the HarfBuzz x and y offsets, y up), 26 bytes. Readers that
// draw the glyph add the ink offset; carets, selection and text geometry
// read the pen.

// Past every other fixed region (its original 128 KB slot at 0x00224840
// held 7281 glyphs, a fifth of a page of prose); the engine traps
// (trap_site 9) instead of writing past it.
export const GLYPH_BUFFER_BASE = layoutConstant("GLYPH_BUFFER_BASE");
export const GLYPH_BUFFER_SIZE = layoutConstant("GLYPH_BUFFER_SIZE"); // 4 MB

export const GLYPH_ENTRY_SIZE = layoutConstant("GLYPH_ENTRY_SIZE");
export const GLYPH_OFFSET_ID = layoutConstant("GLYPH_OFFSET_ID"); // u16
export const GLYPH_ID_INVISIBLE = layoutConstant("GLYPH_ID_INVISIBLE");
export const GLYPH_OFFSET_X_OFFSET = layoutConstant("GLYPH_OFFSET_X_OFFSET"); // f32
export const GLYPH_OFFSET_X_ADVANCE = layoutConstant("GLYPH_OFFSET_X_ADVANCE"); // f32
export const GLYPH_OFFSET_CLUSTER_START = layoutConstant("GLYPH_OFFSET_CLUSTER_START"); // u32 UTF-8 byte offset
export const GLYPH_OFFSET_CLUSTER_END = layoutConstant("GLYPH_OFFSET_CLUSTER_END"); // u32 UTF-8 byte offset
export const GLYPH_OFFSET_INK_X = layoutConstant("GLYPH_OFFSET_INK_X"); // f32, the units of the pen
export const GLYPH_OFFSET_INK_Y = layoutConstant("GLYPH_OFFSET_INK_Y"); // f32, the units of the pen, y up

// =======================================================================
// Previous command buffer (512 KB at 0xE2B40)
// =======================================================================
//
// Copy of the previous frame's command buffer, kept by WASM for diffing.
// Same size as the command buffer.

export const PREV_COMMAND_BUFFER_BASE = layoutConstant("PREV_COMMAND_BUFFER_BASE");
export const PREV_COMMAND_BUFFER_SIZE = layoutConstant("PREV_COMMAND_BUFFER_SIZE"); // 512 KB

// =======================================================================
// Computed-box buffer (128 KB at 0x2C4840)
// =======================================================================
//
// The layout pass's output: one computed box per node (Blink's "fragment
// tree", renamed — see design/layout-engine.md). emit_commands and later layout
// passes read geometry from here instead of from the node. Geometry is i32 in
// 1/64-px units (LayoutUnit), matching Blink for pixel-perfect Chrome parity.
// 32 bytes/box → 128 KB / 32 = 4096 boxes (> the layout buffer's 2251 nodes).

export const COMPUTED_BOX_BUFFER_BASE = layoutConstant("COMPUTED_BOX_BUFFER_BASE");
export const COMPUTED_BOX_BUFFER_SIZE = layoutConstant("COMPUTED_BOX_BUFFER_SIZE"); // 128 KB

export const BOX_SIZE = layoutConstant("BOX_SIZE");
export const BOX_OFFSET_X = layoutConstant("BOX_X"); // i32: border-box x (1/64 px)
export const BOX_OFFSET_Y = layoutConstant("BOX_Y"); // i32: border-box y
export const BOX_OFFSET_WIDTH = layoutConstant("BOX_WIDTH"); // i32: border-box width
export const BOX_OFFSET_HEIGHT = layoutConstant("BOX_HEIGHT"); // i32: border-box height
export const BOX_OFFSET_CONTENT_X = layoutConstant("BOX_CONTENT_X"); // i32: content-box x
export const BOX_OFFSET_CONTENT_Y = layoutConstant("BOX_CONTENT_Y"); // i32: content-box y
export const BOX_OFFSET_CONTENT_W = layoutConstant("BOX_CONTENT_W"); // i32: content-box width
export const BOX_OFFSET_CONTENT_H = layoutConstant("BOX_CONTENT_H"); // i32: content-box height

// Scrollable-overflow side-table, independently reserved after scroll scratch.
// 88 KB holds every layout node's 40-byte record without sharing computed
// boxes or constraint scratch. Geometry and effective offsets are LayoutUnits.
export const SCROLL_DATA_BUFFER_BASE = layoutConstant("SCROLL_DATA_BUFFER_BASE");
export const SCROLL_DATA_BUFFER_SIZE = layoutConstant("SCROLL_DATA_BUFFER_SIZE");
export const SCROLL_DATA_ENTRY_SIZE = layoutConstant("SCROLL_DATA_ENTRY_SIZE");
export const SCROLL_DATA_OFFSET_MIN_X = layoutConstant("SCROLL_MIN_X");
export const SCROLL_DATA_OFFSET_MIN_Y = layoutConstant("SCROLL_MIN_Y");
export const SCROLL_DATA_OFFSET_MAX_X = layoutConstant("SCROLL_MAX_X");
export const SCROLL_DATA_OFFSET_MAX_Y = layoutConstant("SCROLL_MAX_Y");
export const SCROLL_DATA_OFFSET_EFFECTIVE_LEFT = layoutConstant("SCROLL_EFFECTIVE_LEFT");
export const SCROLL_DATA_OFFSET_EFFECTIVE_TOP = layoutConstant("SCROLL_EFFECTIVE_TOP");
export const SCROLL_DATA_OFFSET_WIDTH = layoutConstant("SCROLL_WIDTH");
export const SCROLL_DATA_OFFSET_HEIGHT = layoutConstant("SCROLL_HEIGHT");
export const SCROLL_DATA_OFFSET_STICKY_LEFT = layoutConstant("SCROLL_STICKY_LEFT");
export const SCROLL_DATA_OFFSET_STICKY_TOP = layoutConstant("SCROLL_STICKY_TOP");

// 1 px = 64 LayoutUnits (Blink kFixedPointDenominator).
export const LAYOUT_UNIT = layoutConstant("LAYOUT_UNIT");

// =======================================================================
// Constraint stack (8 KB at 0x182B40)
// =======================================================================
//
// Layout-pass scratch: available space per nesting level, pushed/popped as the
// pass descends/ascends the tree (like the clip/opacity stacks).

export const CONSTRAINT_STACK_BASE = layoutConstant("CONSTRAINT_STACK_BASE");
export const CONSTRAINT_STACK_SIZE = layoutConstant("CONSTRAINT_STACK_SIZE"); // 8 KB

// =======================================================================
// Intrinsic-size buffer (32 KB at 0x184B40)
// =======================================================================
//
// Slice 4: one record per node holding its min-content and max-content INLINE
// (width) contributions, computed bottom-up by the intrinsic pass BEFORE the
// layout pass, and read by width resolution (width:min-content / max-content)
// and later by flex (flex-basis:auto), and the box's own min-content and
// max-content widths, which a length width does not replace. i32 @ 1/64 px,
// like the computed box. 24 bytes/node (min, max, validGen, layout max, own
// min, own max); the initial 64 KB holds 2730 nodes, past the initial
// node capacity, and node_tables_reserve moves it with the other tables.

export const INTRINSIC_BUFFER_BASE = layoutConstant("INTRINSIC_BUFFER_BASE");
export const INTRINSIC_BUFFER_SIZE = layoutConstant("INTRINSIC_BUFFER_SIZE"); // 64 KB initially

export const INTRINSIC_SIZE = layoutConstant("INTRINSIC_SIZE");
export const INTRINSIC_OFFSET_MIN_CONTENT = layoutConstant("INTRINSIC_MIN"); // i32: min-content border-box width (1/64 px)
export const INTRINSIC_OFFSET_MAX_CONTENT = layoutConstant("INTRINSIC_MAX"); // i32: max-content border-box width
export const INTRINSIC_OFFSET_VALID_GEN = layoutConstant("INTRINSIC_VALID_GEN"); // u32: generation these were computed against
// (0 = never) in bits 0-30; bit 31 set when the node, a spanning ancestor in
// a multi-column flow, left its spanners out. See design/layout-engine.md.
export const INTRINSIC_OFFSET_LAYOUT_MAX = layoutConstant("INTRINSIC_LAYOUT_MAX"); // i32: layout-pass max-content border-box width
// (equals MAX_CONTENT except tables measured beneath a flex container or
// table cell, where the layout pass re-allows percentage amplification).

// =======================================================================
// Flex scratch stack (44 KB at 0x194B40) — DEPTH-INDEXED
// =======================================================================
//
// Per-item (72 B) + per-line (16 B) flex §9.7 records, ONE SLICE PER
// NESTING LEVEL. Nested flex containers recurse into $layoutFlex during the
// outer container's placement pass; a single shared slice would be clobbered by
// the inner run (the outer's later items then read corrupt records).
// $flexDepth selects the slice. 8 levels of flex nesting is far beyond any
// real layout. (Was CONSTRAINT_STACK, which held a single non-reentrant
// slice.)
//
// The values below are the INITIAL map: 64 item records (0x1200) + 64 line
// records (0x400) per 0x1600 slice. $layout sizes the stack for the widest
// flex container each scene holds ($flexScratchEnsure), moving it into an
// allocated block when a container has more in-flow items than the slice
// holds — a scene within the initial budget allocates nothing. The 65th
// item used to overrun the line records and drive $layoutFlexItem into
// unbounded recursion (BUG-exclusion-level-capacity-trap, resolved; see
// activity/reports/REPORT-2026-10-09-resolved-bug-records.md), so
// a reader of the slices must take the stride and item budget from
// flex_scratch_level() / flex_items_per_level() rather than assume these.
// The build's memory map check (assertMemoryMap) reads the initial values.

export const FLEX_SCRATCH_BASE = layoutConstant("FLEX_SCRATCH_BASE");
export const FLEX_SCRATCH_LEVEL = layoutConstant("FLEX_SCRATCH_LEVEL"); // initial: 0x1200 items + 0x400 lines
export const FLEX_SCRATCH_LEVELS = layoutConstant("FLEX_SCRATCH_LEVELS");
export const FLEX_SCRATCH_SIZE = layoutConstant("FLEX_SCRATCH_SIZE"); // 8 × 0x1600 = 44 KB

// =======================================================================
// Debug trace buffer (4 KB at 0x19FB40) — TEMPORARY tracing aid
// =======================================================================
//
// A ring of (tag: i32, a: f32, b: f32, c: f32) = 16-byte records, written by
// $debugEmit in engine.wat, read by JS after a layout() call. Not a permanent
// part of the engine — for WAT-level probing when post-layout scratch reads
// aren't enough to see why a branch didn't fire. debugTraceCount resets to 0
// at the top of every layout() call.

export const DEBUG_TRACE_BASE = layoutConstant("DEBUG_TRACE_BASE");
export const DEBUG_TRACE_SIZE = layoutConstant("DEBUG_TRACE_SIZE"); // 4 KB
export const DEBUG_TRACE_ENTRY = layoutConstant("DEBUG_TRACE_ENTRY");
export const DEBUG_TRACE_MAX = layoutConstant("DEBUG_TRACE_MAX");

// =======================================================================
// Text run directory — Slice 6
// =======================================================================
//
// One entry per node, fixed stride (same pattern as INTRINSIC_BUFFER),
// pointing into the text source pool and shaped-glyph pool below. See
// design/layout-engine.md's "Text buffers" for the full rationale
// (WAT drives hb_shape directly, so source text has to live in WASM
// memory too — not just the shaped output).
//
// 40 B/node; the initial 80 KB table holds 2048 nodes. Every count is
// 32-bit, so one text node's length has no limit below the memory limit:
//   textOffset  (u32) — byte offset into TEXT_SOURCE_BASE
//   textLength  (u32) — UTF-8 byte length of this node's text content
//   glyphOffset (u32) — byte offset into SHAPED_GLYPH_POOL_BASE
//   glyphCount  (u32) — number of shaped glyph entries
//   lineOffset  (u32) — ABSOLUTE byte address of this node's line-box
//                       span inside the text line pool ($layoutText
//                       stores its $textLineCursor grab directly, and
//                       every reader — wat and JS — uses it unchanged;
//                       written by $layoutText, NOT $shapeTextRun —
//                       line breaks depend on contentW, recomputed
//                       every layout() call even when the shaped
//                       glyphs are cache-reused)
//   lineCount   (u32) — number of line-box records
//   hasEllipsis (u8)  — the source has one appended ellipsis
//   letterSpacing, shapedLetterSpacing (f32)
//   contentHeight (f32) — px below the node's content-box top where its
//                       last line box ends; written with lineOffset/
//                       lineCount. The line boxes are scrollable overflow
//                       even when a fixed height makes the content box
//                       shorter than they are.
//
// validGen (Slice 6's caching field) is NOT here — see TEXT_RUN_VALID_GEN
// below; it's stored separately so the text/glyph fields stay a clean
// contiguous struct mirroring how JS writes textOffset/textLength and WAT
// writes glyphOffset/glyphCount/validGen at different times. lineOffset/
// lineCount are layout outputs, not shaping-cache state. A node that ceases
// to own lines does not overwrite them, so analytical callers clear both
// fields through resetAnalyticalLayoutState before each forced layout.

export const TEXT_RUN_DIR_BASE = layoutConstant("TEXT_RUN_DIR_BASE");
export const TEXT_RUN_DIR_SIZE = layoutConstant("TEXT_RUN_DIR_SIZE"); // 80 KB (40 B/node × 2048)

export const TEXT_RUN_ENTRY_SIZE = layoutConstant("TEXT_RUN_ENTRY_SIZE");
export const TEXT_RUN_OFFSET_TEXT_OFFSET = layoutConstant("TEXT_RUN_OFFSET_TEXT_OFFSET"); // u32
export const TEXT_RUN_OFFSET_TEXT_LENGTH = layoutConstant("TEXT_RUN_OFFSET_TEXT_LENGTH"); // u32
export const TEXT_RUN_OFFSET_GLYPH_OFFSET = layoutConstant("TEXT_RUN_OFFSET_GLYPH_OFFSET"); // u32
export const TEXT_RUN_OFFSET_GLYPH_COUNT = layoutConstant("TEXT_RUN_OFFSET_GLYPH_COUNT"); // u32
export const TEXT_RUN_OFFSET_LINE_OFFSET = layoutConstant("TEXT_RUN_OFFSET_LINE_OFFSET"); // u32
export const TEXT_RUN_OFFSET_LINE_COUNT = layoutConstant("TEXT_RUN_OFFSET_LINE_COUNT"); // u32
export const TEXT_RUN_OFFSET_HAS_ELLIPSIS = layoutConstant("TEXT_RUN_OFFSET_HAS_ELLIPSIS"); // u8; source has one appended ellipsis glyph
export const TEXT_RUN_OFFSET_LETTER_SPACING = layoutConstant("TEXT_RUN_OFFSET_LETTER_SPACING"); // f32 resolved px
export const TEXT_RUN_OFFSET_SHAPED_LETTER_SPACING = layoutConstant("TEXT_RUN_OFFSET_SHAPED_LETTER_SPACING"); // f32 cache key
export const TEXT_RUN_OFFSET_CONTENT_HEIGHT = layoutConstant("TEXT_RUN_OFFSET_CONTENT_HEIGHT"); // f32 px below the content-box top: last line box bottom
// design/inline-layout.md: an IFC ROOT (LAYOUT_FLAG_IS_INLINE_CTX) has no
// text of its own — TEXT_OFFSET/TEXT_LENGTH/GLYPH_OFFSET are dead weight
// for that node, repurposed as its item-stream span + virtual-glyph-map
// starting offset. LINE_OFFSET/LINE_COUNT above keep their ORIGINAL
// meaning (a TEXT_LINE_POOL span) for both a bare leaf and an IFC root.
export const TEXT_RUN_OFFSET_ITEM_OFFSET = layoutConstant("TEXT_RUN_OFFSET_ITEM_OFFSET"); // u32, aliases TEXT_OFFSET
export const TEXT_RUN_OFFSET_ITEM_COUNT = layoutConstant("TEXT_RUN_OFFSET_ITEM_COUNT"); // u32, aliases TEXT_LENGTH
export const TEXT_RUN_OFFSET_ITEM_GLYPH_MAP_BASE = layoutConstant("TEXT_RUN_OFFSET_ITEM_GLYPH_MAP_BASE"); // u32, aliases GLYPH_OFFSET
// The IFC's INLINE_GLYPH_MAP entry count and the layout pass that built
// its item stream (engine-constants.watpart's $inlineStreamPass).
export const TEXT_RUN_OFFSET_ITEM_GLYPH_MAP_COUNT = layoutConstant("TEXT_RUN_OFFSET_ITEM_GLYPH_MAP_COUNT"); // u32, aliases LETTER_SPACING
export const TEXT_RUN_OFFSET_ITEM_STREAM_PASS = layoutConstant("TEXT_RUN_OFFSET_ITEM_STREAM_PASS"); // u32, aliases SHAPED_LETTER_SPACING
// 0x19..0x1C padding

// =======================================================================
// Text source pool (512 KB at 0x1ACB40) — Slice 6
// =======================================================================
//
// Bump-allocated raw UTF-8 bytes, one span per text node (JS writes each
// node's text content here — the content originates as a JS string, so
// this write is unavoidable; WAT does the shaping, not this). Sized
// generously (matches the command buffer's order of magnitude) since text
// content is the one field in this system with real per-node size
// variance. Reset per session, not per layout() call — see
// TEXT_RUN_VALID_GEN below for why the run directory (and by extension
// this pool's occupied spans) persists across layout() calls instead of
// being bump-reset every frame like the paint-time glyph buffer.

// Text pools (2026-09-14): the per-frame text regions moved past every
// other fixed region and grew for real documents. In their original slots
// a 500-row text fixture (20k glyphs) trapped the inline glyph map and
// silently overran the 128 KB glyph buffer. Old slots: TEXT_SOURCE
// 0x00316840, SHAPED_GLYPH_POOL 0x00396840, TEXT_LINE_POOL 0x005DEA40,
// INLINE_ITEM_POOL 0x0060EA40, INLINE_GLYPH_MAP 0x0062EA40, INLINE_EDGE_MAP
// 0x0066EE40, LINE_FRAGMENT_POOL 0x006AF240, TEXT_POS_SCRATCH 0x003D6840,
// INLINE_STATE_SCRATCH 0x006D7240 (now unused holes). Layout nodes stay at
// LAYOUT_BUFFER's 2251 capacity - the next fixed limit a large page hits.
export const TEXT_SOURCE_BASE = layoutConstant("TEXT_SOURCE_BASE");
export const TEXT_SOURCE_SIZE = layoutConstant("TEXT_SOURCE_SIZE");

// =======================================================================
// Shaped-glyph pool (128 KB at 0x22CB40) — Slice 6
// =======================================================================
//
// Bump-allocated shaped glyph output, written by WAT after driving a
// hb_shape call (or read back unchanged on a cache hit — see caching
// below). Each entry:
//   glyphId  (u16) — HarfBuzz glyph index
//   xAdvance (i32) — RAW HarfBuzz font-unit advance, NOT pre-scaled to px,
//                    so the same shaped run can be measured at a different
//                    fontSize without re-shaping (WAT scales by
//                    fontSize/upem at read time, matching FontEntry consumers).
//   flags    (u16) — bit 0: break opportunity after this glyph (space
//                    boundaries only this slice, set by WAT while walking
//                    the source text alongside shaping — see 6D).
// 16 B/glyph, 131072 glyphs (2 MB). Sized with the other text pools for
// real documents (a text-heavy page is 20-40k glyphs); it was 8192.
//
// CACHING, not a per-frame scratch buffer (unlike GLYPH_BUFFER above,
// which IS reset every emit_commands call): this pool must NOT be
// blindly bump-reset every layout() call, or every unchanged text node
// would re-shape every frame — a real regression from the JS-side
// shaping cache this replaces (see design/layout-engine.md). Caching is
// WAT-side, keyed by node index + generation. Unlike the intrinsic-size
// cache, shaped text requires an exact generation match: $layoutText re-shapes
// a node unless NODE_CHANGED_GEN equals TEXT_RUN_VALID_GEN[node].
// A standalone analytical layout can replace a render surface's rows with
// different text at the same indices, then the surface can restore its
// earlier changed generation. A newer valid generation is not a cache hit.
// Otherwise it reads the run directory's existing glyphOffset/glyphCount
// as-is, zero HarfBuzz calls. The bump allocator only advances for
// NEWLY-shaped or CHANGED runs.

export const SHAPED_GLYPH_POOL_BASE = layoutConstant("SHAPED_GLYPH_POOL_BASE");
export const SHAPED_GLYPH_POOL_SIZE = layoutConstant("SHAPED_GLYPH_POOL_SIZE");

// 32 B/entry. FONT is the FONT_TABLE index of the face that shaped the
// glyph: the node's primary face, or a later face of its font stack
// (design/font-fallback.md). X_ADVANCE, X_OFFSET and Y_OFFSET are in the
// subdivided units of the node's primary face for every glyph;
// $shapeTextRunGlyphs rescales those of a glyph from another face.
// X_OFFSET and Y_OFFSET are the HarfBuzz offsets of the glyph from its pen
// (y up): paint draws the glyph there.
export const SHAPED_GLYPH_ENTRY_SIZE = layoutConstant("SHAPED_GLYPH_ENTRY_SIZE");
export const SHAPED_GLYPH_OFFSET_ID = layoutConstant("SHAPED_GLYPH_OFFSET_ID"); // u16
export const SHAPED_GLYPH_OFFSET_X_ADVANCE = layoutConstant("SHAPED_GLYPH_OFFSET_X_ADVANCE"); // i32
export const SHAPED_GLYPH_OFFSET_FLAGS = layoutConstant("SHAPED_GLYPH_OFFSET_FLAGS"); // u16
export const SHAPED_GLYPH_OFFSET_CLUSTER_START = layoutConstant("SHAPED_GLYPH_OFFSET_CLUSTER_START"); // u32 UTF-8 byte offset
export const SHAPED_GLYPH_OFFSET_CLUSTER_END = layoutConstant("SHAPED_GLYPH_OFFSET_CLUSTER_END"); // u32 UTF-8 byte offset
export const SHAPED_GLYPH_OFFSET_FONT = layoutConstant("SHAPED_GLYPH_OFFSET_FONT"); // u16: FONT_TABLE index, synthesized bit
// Bit 15 of the font field: a synthesized small capital of font-variant-caps
// (core/engine/engine-caps.watpart), at round(0.7 × font size) px. Bits 0-14
// hold the FONT_TABLE index.
export const SHAPED_GLYPH_FONT_SYNTHESIZED = layoutConstant("SHAPED_GLYPH_FONT_SYNTHESIZED");
export const SHAPED_GLYPH_FONT_INDEX = layoutConstant("SHAPED_GLYPH_FONT_INDEX");
// text-spacing-trim (core/engine/engine-han-kerning.watpart): an i16 that
// holds, in bits 1-15, the advance in font units of the primary face that
// the 'halt' feature removes from the glyph (negative when 'halt' also
// moves the glyph left by that amount, as for an opening bracket), and in
// bit 0 whether shaping removed it. SHAPED_GLYPH_FLAG_HALT tells whether
// X_ADVANCE has it removed now: a line edge can change that.
export const SHAPED_GLYPH_OFFSET_HAN_KERNING = layoutConstant("SHAPED_GLYPH_OFFSET_HAN_KERNING"); // i16
// Before caps scaling, in the shaping face's subdivided units, without spacing.
// Canvas uses this value at the synthesized size without reversing a rounded advance.
export const SHAPED_GLYPH_OFFSET_UNSCALED_ADVANCE = layoutConstant("SHAPED_GLYPH_OFFSET_UNSCALED_ADVANCE"); // i32; synthesized glyphs
export const SHAPED_GLYPH_OFFSET_X_OFFSET = layoutConstant("SHAPED_GLYPH_OFFSET_X_OFFSET"); // i32
export const SHAPED_GLYPH_OFFSET_Y_OFFSET = layoutConstant("SHAPED_GLYPH_OFFSET_Y_OFFSET"); // i32, y up

export const SHAPED_GLYPH_FLAG_BREAK_AFTER = layoutConstant("SHAPED_GLYPH_FLAG_BREAK_AFTER");
export const SHAPED_GLYPH_FLAG_HANGING = layoutConstant("SHAPED_GLYPH_FLAG_HANGING"); // the break glyph hangs at a line
// end (space); hyphens break but
// keep their width
// design/inline-layout.md: set by $collapseInlineItems on a leading/
// trailing collapsible space at an IFC item boundary that CSS collapses
// away — the glyph's advance contributes zero to any width/position sum.
export const SHAPED_GLYPH_FLAG_COLLAPSED = layoutConstant("SHAPED_GLYPH_FLAG_COLLAPSED");
export const SHAPED_GLYPH_FLAG_HALT = layoutConstant("SHAPED_GLYPH_FLAG_HALT");

// =======================================================================
// Text run valid-generation buffer (32 KB at 0x254B40) — Slice 6/6D
// =======================================================================
//
// Two u32 per node: the generation this node's shaped run was last
// computed against (0 = never shaped), and the shaped-glyph-pool EPOCH it
// was shaped against. Separate from TEXT_RUN_DIR above so a cache-hit
// check ($shapeTextRun comparing this against the node's own
// NODE_CHANGED_GEN) doesn't need to touch the text/glyph offset fields at
// all — same separation-of-concerns INTRINSIC_BUFFER already uses
// (INTRINSIC_OFFSET_VALID_GEN lives alongside min/max there because that
// struct is small; here it's split out because TEXT_RUN_DIR's other
// fields are written by two different sides — JS writes text span, WAT
// writes glyph span + this generation — at different times).
//
// poolEpoch exists because SHAPED_GLYPH_POOL_BASE is a bump-allocated
// cache that's NEVER reset per layout() call (unlike this buffer's own
// changedGen check, which IS content-driven) — a long-running session with
// enough cumulative DISTINCT text content eventually fills the pool's
// fixed budget. When that happens $shapeTextRun wraps the bump cursor
// back to the pool's base and bumps a global epoch counter — every
// PREVIOUSLY cached entry is now invalid (its glyphOffset points into
// memory about to be overwritten by different content), but there's no
// node-count available to walk and invalidate them all individually.
// Storing the epoch a run was shaped against, and comparing it against
// the CURRENT epoch alongside changedGen, makes every stale entry
// automatically read as a cache miss without touching them.
//
// 8 B/node × 4096 nodes = 32 KB.

export const TEXT_RUN_VALID_GEN_BASE = layoutConstant("TEXT_RUN_VALID_GEN_BASE");
export const TEXT_RUN_VALID_GEN_SIZE = layoutConstant("TEXT_RUN_VALID_GEN_SIZE"); // 32 KB (8 B/node × 4096)
export const TEXT_RUN_VALID_GEN_ENTRY_SIZE = layoutConstant("TEXT_RUN_VALID_GEN_ENTRY_SIZE");
export const TEXT_RUN_VALID_GEN_OFFSET_GEN = layoutConstant("TEXT_RUN_VALID_GEN_OFFSET_GEN"); // u32
export const TEXT_RUN_VALID_GEN_OFFSET_EPOCH = layoutConstant("TEXT_RUN_VALID_GEN_OFFSET_EPOCH"); // u32

// =======================================================================
// Text line pool (64 KB at 0x258B40) — Slice 6D
// =======================================================================
//
// Bump-allocated per-line records produced by $layoutText's greedy line
// breaker — a PERSISTENT pool keyed by each node's TEXT_RUN_OFFSET_LINE_
// OFFSET/LINE_COUNT (same "pool + per-node span pointer" shape as
// TEXT_SOURCE_BASE / SHAPED_GLYPH_POOL_BASE above), NOT a small transient
// per-depth scratch region. This replaced an earlier depth-indexed
// "TEXT_SCRATCH_BASE" design (8 slices × 64 lines) that couldn't actually
// work: $layout() calls $layoutText once per text node during a SINGLE
// recursive descent, and emit_commands only walks nodes to emit CMD_TEXT
// AFTER that whole descent finishes (call $layout() first, then walk) —
// so by the time emit_commands reaches text node #1, a scratch region
// would already have been overwritten by every text node laid out after
// it. A persistent bump-allocated pool has no such collision.
//
// UNLIKE the shaped-glyph pool, this pool DOES bump-reset every layout()
// call (not a cross-call cache): line breaks depend on contentW, which
// can change every layout() call (e.g. a resize) even when the node's
// shaped glyphs are cache-reused unchanged.
//
// Per line: {firstGlyphIdx: u32, glyphCount: u32, width: f32, y: f32} =
// 16 B. 64 KB / 16 B = 4096 lines — generous for a "moderate document"
// (this memory map's own stated sizing philosophy), same order of
// magnitude as the glyph pool relative to an average handful of words
// per line.

// D1 (design/layout-engine.md): the line/inline pools are
// PERSISTENT epoch'd caches, no longer reset per layout() call. A skipped
// (layout-cached) subtree's spans must survive until its next relayout.
// Cursors persist across layout() calls; when any cursor crosses its
// pool's midpoint at layout() entry, every cursor resets to base and the
// shared line-pool epoch advances, which reads every cached span as
// invalid (the SHAPED_GLYPH_POOL epoch pattern). The midpoint rule keeps
// the old one-pass budget: at pass start at least half the (doubled)
// pool — the full pre-D1 capacity — is always free.
//
// All five pools relocated (old slots below are intentional holes, same
// convention as BG_LAYER_POOL's move) and doubled for D1:
// 0x003BE840-0x003D6840 (old text-line pool; FONT_STACK_TABLE now occupies
// 0x003BE840-0x003C4840 and MATH_BOX 0x003C4840-0x003CD4F0),
// 0x003E6940-0x003F6940 (old inline-item pool; LANGUAGE_TABLE now
// occupies 0x003E6940-0x003E8940 and LANGUAGE_TABLE_FEATURES
// 0x003E8940-0x003E9140),
// 0x003F6940-0x00416B40 (old inline glyph map),
// 0x00416B40-0x0042AB40 (old line-fragment pool),
// 0x00485520-0x004A5720 (old inline edge map),
// 0x004AE720-0x004B5520 (unused inline-state scratch),
// 0x004C9520-0x004C9B20 (old font variation and decoration tables).
// FONT_TABLE occupies 0x004A5720-0x004AB720, FONT_VARIATION_TABLE
// 0x004AB720-0x004AC720, FONT_DECORATION_TABLE 0x004AC720-0x004AE720.
// MULTICOLUMN_FRAGMENT_POOL occupies 0x004B5520-0x004C9520.
export const TEXT_LINE_POOL_BASE = layoutConstant("TEXT_LINE_POOL_BASE");
export const TEXT_LINE_POOL_SIZE = layoutConstant("TEXT_LINE_POOL_SIZE");

// Entry grew 16 → 24 B for float line bands (design/floats.md): a line
// beside a float starts at the band's left edge and aligns within the
// band's width, not the content box's — X/AVAIL carry that per line.
// For float-free lines X = contentX and AVAIL = contentW, making the
// paint-side text-align math byte-identical to the pre-F2 output.
export const TEXT_LINE_ENTRY_SIZE = layoutConstant("TEXT_LINE_ENTRY_SIZE");
export const TEXT_LINE_OFFSET_FIRST_GLYPH = layoutConstant("TEXT_LINE_OFFSET_FIRST_GLYPH"); // u32
export const TEXT_LINE_OFFSET_GLYPH_COUNT = layoutConstant("TEXT_LINE_OFFSET_GLYPH_COUNT"); // u32
export const TEXT_LINE_OFFSET_WIDTH = layoutConstant("TEXT_LINE_OFFSET_WIDTH"); // f32
export const TEXT_LINE_OFFSET_Y = layoutConstant("TEXT_LINE_OFFSET_Y"); // f32 (px, relative to the node's contentY)
export const TEXT_LINE_OFFSET_X = layoutConstant("TEXT_LINE_OFFSET_X"); // f32 (px, band left RELATIVE to contentX — shifts move boxes, not pool records; F2)
export const TEXT_LINE_OFFSET_AVAIL = layoutConstant("TEXT_LINE_OFFSET_AVAIL"); // f32 (px, band width; F2)

// =======================================================================
// Text position scratch — Slice 6F
// =======================================================================
//
// $layoutText's per-glyph position cache: one i32 per glyph holding
// ceil-to-LU of the ABSOLUTE f32 prefix advance sum (position where the
// glyph starts, from the run's origin), plus one trailing entry for the
// position after the last glyph. This is the engine's equivalent of
// Blink's ShapeResult::ComputePositionData character-position cache — the
// line breaker's fit test runs on these INTEGERS (with a +1 raw-LU
// epsilon), never on float width comparisons. Transient scratch, rebuilt
// per $layoutText call. The initial region holds 132096 positions; a
// scene with more text moves it into the text pool block
// (engine-interface.watpart's $textPoolsEnsure), sized for the scene's
// glyphs and items.

export const TEXT_POS_SCRATCH_BASE = layoutConstant("TEXT_POS_SCRATCH_BASE");
export const TEXT_POS_SCRATCH_SIZE = layoutConstant("TEXT_POS_SCRATCH_SIZE");

// =======================================================================
// Inline item pool (64 KB at 0x2C3220) — design/inline-layout.md
// =======================================================================
//
// Bump-allocated PER IFC ROOT (unlike SHAPED_GLYPH_POOL's cross-call
// cache, this rebuilds every layout() call — the item stream's line
// ASSIGNMENT depends on contentW, same "depends on layout, not just
// style" reasoning TEXT_LINE_POOL already documents; simplest to
// rebuild the whole stream alongside the line pool's own reset rather
// than invent a second cache-validity story in v1). An IFC root's own
// TEXT_RUN_DIR entry (it's never ALSO a DISPLAY_TEXT leaf under I1's
// tree-shape rule, so no field collision) repurposes LINE_OFFSET/
// LINE_COUNT to mean "item span" instead of "line span" for that one
// node — see $buildInlineItems' own doc comment in engine.wat.
//
// Per item (24 B): {kind: u8, flags: u8, bidiLevel: u8, nodeIndex: u32,
// parentItemIndex: u32, glyphOffset: u32, glyphCount: u32, baselineShift: f32}.
// 1 MB / 16 B = 65536 items (u16 item index) — same order of magnitude as TEXT_LINE_POOL
// relative to a "moderate document". Relocated + doubled for D1 (see the
// TEXT_LINE_POOL comment; cursor persists, epoch'd).
export const INLINE_ITEM_POOL_BASE = layoutConstant("INLINE_ITEM_POOL_BASE");
export const INLINE_ITEM_POOL_SIZE = layoutConstant("INLINE_ITEM_POOL_SIZE");

export const INLINE_ITEM_ENTRY_SIZE = layoutConstant("INLINE_ITEM_ENTRY_SIZE");
export const INLINE_ITEM_OFFSET_KIND = layoutConstant("INLINE_ITEM_OFFSET_KIND"); // u8
export const INLINE_ITEM_OFFSET_FLAGS = layoutConstant("INLINE_ITEM_OFFSET_FLAGS"); // u8
// FLAGS bit: the element that holds the item (its inline box, or the IFC
// root) does not wrap (TEXT_BEHAVIOR_NOWRAP).
export const INLINE_ITEM_FLAG_CONTAINER_NOWRAP = layoutConstant("INLINE_ITEM_FLAG_CONTAINER_NOWRAP");
export const INLINE_ITEM_OFFSET_NODE_INDEX = layoutConstant("INLINE_ITEM_OFFSET_NODE_INDEX"); // u32
export const INLINE_ITEM_OFFSET_PARENT_INDEX = layoutConstant("INLINE_ITEM_OFFSET_PARENT_INDEX"); // u32; 0xFFFFFFFF = IFC root
export const INLINE_ITEM_OFFSET_GLYPH_OFFSET = layoutConstant("INLINE_ITEM_OFFSET_GLYPH_OFFSET"); // u32 (TEXT only)
export const INLINE_ITEM_OFFSET_GLYPH_COUNT = layoutConstant("INLINE_ITEM_OFFSET_GLYPH_COUNT"); // u32 (TEXT only)
// f32 px: an ATOMIC item's shift from the baseline of its parent box on
// the line that holds it (its vertical-align), positive down.
export const INLINE_ITEM_OFFSET_BASELINE_SHIFT = layoutConstant("INLINE_ITEM_OFFSET_BASELINE_SHIFT");

export const INLINE_ITEM_KIND_TEXT = layoutConstant("INLINE_ITEM_KIND_TEXT");
export const INLINE_ITEM_KIND_OPEN = layoutConstant("INLINE_ITEM_KIND_OPEN");
export const INLINE_ITEM_KIND_CLOSE = layoutConstant("INLINE_ITEM_KIND_CLOSE");
export const INLINE_ITEM_KIND_ATOMIC = layoutConstant("INLINE_ITEM_KIND_ATOMIC");
// An absolute or fixed box: no glyph; GLYPH_OFFSET is its boundary's
// glyph-map index, GLYPH_COUNT 0.
export const INLINE_ITEM_KIND_OUT_OF_FLOW = layoutConstant("INLINE_ITEM_KIND_OUT_OF_FLOW");
// A float: no glyph; GLYPH_OFFSET is its boundary's glyph-map index,
// GLYPH_COUNT 0. Line layout places it on the line that reaches the
// boundary, or below it.
export const INLINE_ITEM_KIND_FLOAT = layoutConstant("INLINE_ITEM_KIND_FLOAT");

// =======================================================================
// Inline glyph map (131 KB at 0x2D3220) — design/inline-layout.md
// =======================================================================
//
// TEXT_POS_SCRATCH indexes glyphs WITHIN ONE run (one node's own
// SHAPED_GLYPH_POOL span); an IFC's item stream needs a "virtual glyph
// index" spanning ALL its TEXT items' glyphs in STREAM order, but
// different items' glyphs are NOT contiguous in SHAPED_GLYPH_POOL (each
// was bump-allocated wherever that node's own $shapeTextRun call landed,
// in node-VISIT order, not item-stream order). This pool is that
// indirection: one entry per glyph across the whole stream, in stream
// order, resolving a virtual index straight to (which item, which
// absolute SHAPED_GLYPH_POOL pointer) — the line-breaker's ported pre-
// pass/loop (see engine.wat's $layoutInlineItems) operates on virtual
// indices into THIS map, never touching per-item glyphOffset math
// directly. The fixed map holds 196608 entries: $textPoolsEnsure moves the
// pools to an allocated block when a scene's text needs more than half
// of that (the pools flip at their midpoint).
//
// Per entry (8 B): {itemIndex: u16, glyphPtr: u32 (absolute
// SHAPED_GLYPH_POOL_BASE pointer for this glyph)} + 2 B pad.
// Relocated + doubled for D1 (see the TEXT_LINE_POOL comment). It gave
// its last 512 KB to INLINE_EDGE_MAP when edge entries grew to 12 B.
export const INLINE_GLYPH_MAP_BASE = layoutConstant("INLINE_GLYPH_MAP_BASE");
export const INLINE_GLYPH_MAP_SIZE = layoutConstant("INLINE_GLYPH_MAP_SIZE");
export const INLINE_GLYPH_MAP_ENTRY_SIZE = layoutConstant("INLINE_GLYPH_MAP_ENTRY_SIZE");
export const INLINE_GLYPH_MAP_OFFSET_ITEM_INDEX = layoutConstant("INLINE_GLYPH_MAP_OFFSET_ITEM_INDEX"); // u32
export const INLINE_GLYPH_MAP_OFFSET_GLYPH_PTR = layoutConstant("INLINE_GLYPH_MAP_OFFSET_GLYPH_PTR"); // u32

// =======================================================================
// Line fragment pool (80 KB at 0x2F3420) — design/inline-layout.md
// =======================================================================
//
// One record per FRAGMENT (a contiguous same-item run of glyphs within
// one broken line) — the per-fragment detail TEXT_LINE_POOL's own
// records don't carry once a line can mix multiple items/styles. An IFC
// root's TEXT_LINE_POOL record reinterprets FIRST_GLYPH/GLYPH_COUNT as
// fragmentOffset/fragmentCount, a span into THIS pool (see
// TEXT_LINE_POOL's own doc comment for the dual-interpretation rule).
// Bump-allocated per IFC root, reset every layout() call, same
// reasoning as TEXT_LINE_POOL/INLINE_ITEM_POOL's own resets.
//
// Per fragment (28 B): {itemIndex: u32, glyphCount: u32, bidiLevel: u8,
// visualOrder: u8, 2 B padding, glyphStart: u32 (virtual glyph index into that item's
// own span — resolved via INLINE_GLYPH_MAP at paint time), x: f32 (offset
// within the already text-align-shifted line), width: f32, blockOffset:
// f32}. I2's blockOffset positions each fragment within the mixed-metrics
// line box. Glyph count is u32: one fragment is one item's glyphs on one
// line, and one line of preserved text can hold every glyph of a text
// node. Fragments are in visual order, left to right. visualOrder is 0 on
// a line laid out in logical order (every bidi level 0, no right-to-left
// inline box in its IFC). It is 1 on a line laid out by the Unicode
// Bidirectional Algorithm (core/engine/engine-bidi.watpart): each fragment
// is a run of virtual glyphs that ascend left to right at one bidiLevel,
// and the line's inline edge map entries hold edges by physical side
// (before = left, after = right).
// Relocated + doubled for D1 (see the TEXT_LINE_POOL comment).
export const LINE_FRAGMENT_POOL_BASE = layoutConstant("LINE_FRAGMENT_POOL_BASE");
export const LINE_FRAGMENT_POOL_SIZE = layoutConstant("LINE_FRAGMENT_POOL_SIZE");
export const LINE_FRAGMENT_ENTRY_SIZE = layoutConstant("LINE_FRAGMENT_ENTRY_SIZE");
export const LINE_FRAGMENT_OFFSET_ITEM_INDEX = layoutConstant("LINE_FRAGMENT_OFFSET_ITEM_INDEX"); // u32
export const LINE_FRAGMENT_OFFSET_GLYPH_COUNT = layoutConstant("LINE_FRAGMENT_OFFSET_GLYPH_COUNT"); // u32
export const LINE_FRAGMENT_OFFSET_BIDI_LEVEL = layoutConstant("LINE_FRAGMENT_OFFSET_BIDI_LEVEL"); // u8: resolved embedding level
export const LINE_FRAGMENT_OFFSET_VISUAL_ORDER = layoutConstant("LINE_FRAGMENT_OFFSET_VISUAL_ORDER"); // u8: 1 when laid out in visual order
// The VISUAL_ORDER value of a visual-order fragment of hanging glyphs
// (collapsible trailing spaces): zero width, and no inline box's extent.
export const LINE_FRAGMENT_VISUAL_ORDER_HANGING = layoutConstant("LINE_FRAGMENT_VISUAL_ORDER_HANGING");
export const LINE_FRAGMENT_OFFSET_GLYPH_START = layoutConstant("LINE_FRAGMENT_OFFSET_GLYPH_START"); // u32
export const LINE_FRAGMENT_OFFSET_X = layoutConstant("LINE_FRAGMENT_OFFSET_X"); // f32
export const LINE_FRAGMENT_OFFSET_WIDTH = layoutConstant("LINE_FRAGMENT_OFFSET_WIDTH"); // f32
export const LINE_FRAGMENT_OFFSET_BLOCK_OFFSET = layoutConstant("LINE_FRAGMENT_OFFSET_BLOCK_OFFSET"); // f32, relative to line top

// =======================================================================
// Font table (24576 B) — Slice 6D
// =======================================================================
//
// A font, for shaping purposes, is a fully-resolved (already variation-
// instanced, if applicable) hb_font_t living in hb.wasm's own heap —
// shared by complete font bytes, face index, weight, width and slant.
// Authored family aliases do not affect instance identity.
// JS uploads file bytes. register_font hashes and compares complete bytes,
// consumes duplicate uploads, and shares one native allocation per file.
// It derives physical italic metadata from the selected collection face.
// It creates the HarfBuzz blob, face and variation-instanced font in WAT.
// A byte-object cache skips uploads for immutable sources. Mutable sources
// receive a fresh snapshot and native content check.
//
// A node's NODE_FONT_INDEX indexes THIS table directly — it is "the Nth
// registered physical font instance", not "the Nth authored family".
// $layoutText never touches variation axes or face creation; it just
// reads {hbFontPtr, upem, ascender, descender, lineGap} for the node's
// fontIndex and shapes/measures. Vertical metrics are queried ONCE here
// (hb_font_get_h_extents, at the SAME scale hb_font_set_scale already set
// — font units, matching xAdvance's own unit — see 6D §4) rather than
// re-querying HarfBuzz per text node per layout() call. Other consumers read
// OpenType scalar metrics through the font-metrics reader composed into the
// renderer core, independently of this table.
//
// 48 B/entry × 512 entries = 24576 B in retired inline-state scratch.
// Registration rejects exhaustion before writing. FONT_VARIATION_TABLE and
// FONT_DECORATION_TABLE, indexed by the same font index, follow it with
// the same capacity. The WPT MathML corpus alone registers 58 font files,
// and one test process registers every suite's faces, so 64 entries
// overflowed in a full run.

export const FONT_TABLE_BASE = layoutConstant("FONT_TABLE_BASE");
export const FONT_TABLE_SIZE = layoutConstant("FONT_TABLE_SIZE");
export const FONT_TABLE_ENTRY_SIZE = layoutConstant("FONT_TABLE_ENTRY_SIZE");
export const FONT_TABLE_MAX_ENTRIES = layoutConstant("FONT_TABLE_MAX_ENTRIES");

// Shaping contexts, interned by the DOM core: one entry per distinct pair
// of a content language (a BCP 47 tag) and a font feature set, appended in
// first-use order and never removed while the engine lives. NODE_LANGUAGE
// indexes this table; index 0 is "no language, no features" and its entry
// stays unused. Entry: byte 0 is the tag length in bytes (0..31; 0 for an
// entry that only carries features), bytes 1..31 are the tag in ASCII
// lowercase. 32 B/entry × 256 entries = 8192 B in the old inline-item pool
// hole. design/text-rendering.md ("Font features") explains the choice.
export const LANGUAGE_TABLE_BASE = layoutConstant("LANGUAGE_TABLE_BASE");
export const LANGUAGE_TABLE_SIZE = layoutConstant("LANGUAGE_TABLE_SIZE");
export const LANGUAGE_TABLE_ENTRY_SIZE = layoutConstant("LANGUAGE_TABLE_ENTRY_SIZE");
export const LANGUAGE_TABLE_MAX_ENTRIES = layoutConstant("LANGUAGE_TABLE_MAX_ENTRIES");
export const LANGUAGE_TABLE_TAG_MAX_LENGTH = layoutConstant("LANGUAGE_TABLE_TAG_MAX_LENGTH");
// The font feature set of each LANGUAGE_TABLE entry, at the same index:
// the OpenType features that font-variant-*, font-kerning and
// font-feature-settings resolve to, in Blink's order (FontFeatures::
// Initialize). Entry: the feature block (u32 pointer to `count` pairs
// {tag u32, value u32}, owned by the DOM core and never freed; 0 for no
// features), count (u16), and variant count (u16): the first `variant
// count` pairs come from font-variant-* and font-kerning, the rest from
// font-feature-settings. With a non-zero letter-spacing the engine drops
// the variant pairs liga, clig, dlig, hlig and calt and turns liga, clig
// and calt off, as Blink does. 8 B/entry × 256 entries = 2048 B, after
// LANGUAGE_TABLE in the same hole.
export const LANGUAGE_TABLE_FEATURES_BASE = layoutConstant("LANGUAGE_TABLE_FEATURES_BASE");
export const LANGUAGE_TABLE_FEATURES_SIZE = layoutConstant("LANGUAGE_TABLE_FEATURES_SIZE");
export const LANGUAGE_TABLE_FEATURES_ENTRY_SIZE = layoutConstant("LANGUAGE_TABLE_FEATURES_ENTRY_SIZE");
export const LANGUAGE_TABLE_FEATURES_OFFSET_COUNT = layoutConstant("LANGUAGE_TABLE_FEATURES_OFFSET_COUNT");
export const LANGUAGE_TABLE_FEATURES_OFFSET_VARIANT_COUNT = layoutConstant("LANGUAGE_TABLE_FEATURES_OFFSET_VARIANT_COUNT");

// Font decoration metrics, indexed by FONT_TABLE index. JS supplies signed
// OpenType font units (post underline position/thickness, OS/2 strikeout
// position/thickness); the engine stores them ×FONT_UNIT_SUBDIVISION (512)
// to match the shaping scale (see engine.wat's $FONT_UNIT_SUBDIVISION).
// This separate table holds four signed scalar metrics per instance.
// 16 B/entry × 512 entries = 8192 B.
export const FONT_DECORATION_TABLE_BASE = layoutConstant("FONT_DECORATION_TABLE_BASE");
export const FONT_DECORATION_TABLE_SIZE = layoutConstant("FONT_DECORATION_TABLE_SIZE");
export const FONT_DECORATION_TABLE_ENTRY_SIZE = layoutConstant("FONT_DECORATION_TABLE_ENTRY_SIZE");
// Variation coordinates beyond wght, indexed by FONT_TABLE index: the wdth
// coordinate (a CSS font-stretch percentage) the instance shapes at, f32,
// 0 = the font's own default, and the slnt coordinate (the negated CSS
// oblique angle), f32, always applied (0 is upright; a font without a slnt
// axis ignores it). Separate for the same reason as the decoration table.
// 8 B/entry × 512 entries = 4096 B.
export const FONT_VARIATION_TABLE_BASE = layoutConstant("FONT_VARIATION_TABLE_BASE");
export const FONT_VARIATION_TABLE_SIZE = layoutConstant("FONT_VARIATION_TABLE_SIZE");
export const FONT_VARIATION_TABLE_ENTRY_SIZE = layoutConstant("FONT_VARIATION_TABLE_ENTRY_SIZE");
export const FONT_VARIATION_OFFSET_WIDTH = layoutConstant("FONT_VARIATION_OFFSET_WIDTH"); // f32, wdth coordinate
export const FONT_VARIATION_OFFSET_SLANT = layoutConstant("FONT_VARIATION_OFFSET_SLANT"); // f32, slnt coordinate
export const FONT_TABLE_OFFSET_HB_FONT_PTR = layoutConstant("FONT_TABLE_OFFSET_HB_FONT_PTR"); // i32: hb_font_t* in hb.wasm's memory
export const FONT_TABLE_OFFSET_UPEM = layoutConstant("FONT_TABLE_OFFSET_UPEM"); // u32, upem × FONT_UNIT_SUBDIVISION (512)
export const FONT_TABLE_OFFSET_ASCENDER = layoutConstant("FONT_TABLE_OFFSET_ASCENDER"); // i32, subdivided font units (hb_font_get_h_extents)
export const FONT_TABLE_OFFSET_DESCENDER = layoutConstant("FONT_TABLE_OFFSET_DESCENDER"); // i32, subdivided font units (negative)
export const FONT_TABLE_OFFSET_LINE_GAP = layoutConstant("FONT_TABLE_OFFSET_LINE_GAP"); // i32, subdivided font units
export const FONT_TABLE_OFFSET_WEIGHT = layoutConstant("FONT_TABLE_OFFSET_WEIGHT"); // u16, CSS weight; re-applied with wdth, slnt and opsz before shaping
export const FONT_TABLE_OFFSET_X_GLYPH = layoutConstant("FONT_TABLE_OFFSET_X_GLYPH"); // u16, nominal glyph id for lowercase x
export const FONT_TABLE_OFFSET_BYTES = layoutConstant("FONT_TABLE_OFFSET_BYTES");
export const FONT_TABLE_OFFSET_LENGTH = layoutConstant("FONT_TABLE_OFFSET_LENGTH");
export const FONT_TABLE_OFFSET_HASH = layoutConstant("FONT_TABLE_OFFSET_HASH");
export const FONT_TABLE_OFFSET_FACE_INDEX = layoutConstant("FONT_TABLE_OFFSET_FACE_INDEX");
export const FONT_TABLE_OFFSET_ITALIC = layoutConstant("FONT_TABLE_OFFSET_ITALIC");

// Font stack table (design/font-fallback.md): the authored font stack
// of a text node, primary face first. Entry: count (u16), then up to
// FONT_STACK_MAX_FACES FONT_TABLE indices (u16), the primary slot (u16) and
// the slot block (u32). Equal stacks share one entry; entry 0 is never
// written (LAYOUT_NODE_OFFSET_FONT_STACK 0 is a stack of the primary face
// alone). 24 B/entry x 1024 entries = 24576 B in the retired text-line pool.
// A stack with a unicode-range face (design/text-rendering.md) has
// a slot block instead of the indices: {byte length u32, slot count u32},
// then slots of FONT_STACK_SLOT_SIZE bytes {font u16 (0xFFFF not loaded),
// 2 B zero, pair count u32, catalog face ID u32 of an unloaded face, core
// face number u32, pair offset u32 from the block start}, then the u32
// {start, end} scalar pairs. The font of the primary slot, when loaded, is
// the node's primary face (see engine-constants.watpart).
export const FONT_STACK_TABLE_BASE = layoutConstant("FONT_STACK_TABLE_BASE");
export const FONT_STACK_TABLE_SIZE = layoutConstant("FONT_STACK_TABLE_SIZE");
export const FONT_STACK_ENTRY_SIZE = layoutConstant("FONT_STACK_ENTRY_SIZE");
export const FONT_STACK_MAX_ENTRIES = layoutConstant("FONT_STACK_MAX_ENTRIES");
export const FONT_STACK_MAX_FACES = layoutConstant("FONT_STACK_MAX_FACES");
export const FONT_STACK_OFFSET_COUNT = layoutConstant("FONT_STACK_OFFSET_COUNT"); // u16
export const FONT_STACK_OFFSET_FONTS = layoutConstant("FONT_STACK_OFFSET_FONTS"); // u16 x FONT_STACK_MAX_FACES
export const FONT_STACK_OFFSET_PRIMARY = layoutConstant("FONT_STACK_OFFSET_PRIMARY"); // u16 slot index
export const FONT_STACK_OFFSET_SLOTS = layoutConstant("FONT_STACK_OFFSET_SLOTS"); // u32 slot block, 0 for none
export const FONT_STACK_SLOT_HEADER_SIZE = layoutConstant("FONT_STACK_SLOT_HEADER_SIZE");
export const FONT_STACK_SLOT_SIZE = layoutConstant("FONT_STACK_SLOT_SIZE");
export const FONT_STACK_UNLOADED = layoutConstant("FONT_STACK_UNLOADED");

// --- Image table (Slice P5a): decoded-image intrinsic size registry ---
// Mirrors FONT_TABLE's shape exactly: JS decodes image bytes (src/images.js,
// PNG only for v1) off the engine entirely — pixels never enter WASM memory,
// they go straight to a GPU texture at draw time (src/rasterize.js) — and
// calls register_image(index, width, height, defaultSized, ratio) so the
// ENGINE can read intrinsic size for replaced-box layout
// (design/paint-coverage.md P5b's shared sizing helper, also consumed by
// the svg-root sizing).
// UNLIKE register_font (which returns an auto-incremented index), the
// caller PICKS the index here — JS already has a natural image identity
// (the decoded-bytes cache key) before any node references it, so there's
// no need for the engine to hand back an opaque handle.
// An entry with IMAGE_FLAG_DEFAULT_SIZED has neither a natural width nor a
// natural height (an SVG image without width and height attributes); the
// engine sizes it by the default sizing algorithm of CSS Images 3 §5.2,
// with its natural ratio (0 for none).
// 16 B/entry x 256 entries = 4096 B.
export const IMAGE_TABLE_BASE = layoutConstant("IMAGE_TABLE_BASE");
export const IMAGE_TABLE_SIZE = layoutConstant("IMAGE_TABLE_SIZE"); // 4096 B (16 B x 256 entries)
export const IMAGE_TABLE_ENTRY_SIZE = layoutConstant("IMAGE_TABLE_ENTRY_SIZE");
export const IMAGE_TABLE_MAX_ENTRIES = layoutConstant("IMAGE_TABLE_MAX_ENTRIES");
export const IMAGE_TABLE_OFFSET_WIDTH = layoutConstant("IMAGE_TABLE_OFFSET_WIDTH"); // u32: intrinsic width, px
export const IMAGE_TABLE_OFFSET_HEIGHT = layoutConstant("IMAGE_TABLE_OFFSET_HEIGHT"); // u32: intrinsic height, px
export const IMAGE_TABLE_OFFSET_RATIO = layoutConstant("IMAGE_TABLE_OFFSET_RATIO"); // f32: natural ratio, width / height (0: none)
export const IMAGE_TABLE_OFFSET_FLAGS = layoutConstant("IMAGE_TABLE_OFFSET_FLAGS"); // u32: IMAGE_FLAG_*
export const IMAGE_FLAG_DEFAULT_SIZED = layoutConstant("IMAGE_FLAG_DEFAULT_SIZED");

// =======================================================================
// Background-layer pool (P5c) — one fixed-size entry per background-image
// LAYER (a node can have multiple, CSS list order; bottom layer = LAST in
// the list per css-backgrounds-3 §3.8). Bump-allocated fresh every
// emitSceneCommands/render call (NOT cached like the text shaping
// pools above) — layer data is pure per-node style, cheap to recompute,
// no shaping/measurement work to avoid repeating. LAYOUT_NODE_OFFSET_
// BG_LAYER_COUNT/BG_LAYERS_OFFSET (P0-reserved) point a node at its span
// here, same shape as the (not yet built) box-shadow pool.
//
// 24 B/layer x 1024 layers = 24576 B — generous headroom (a single node
// rarely has more than 2-3 background layers in real CSS).
//   bgImageIndex (u16) — index into IMAGE_TABLE, 0xFFFF = none
//   sizeWTag/sizeHTag (u8 each) — SIZE_TAG_AUTO/LENGTH/PERCENT/COVER/CONTAIN
//   positionXTag/positionYTag (u8 each) — SIZE_TAG_LENGTH/PERCENT
//   repeat (u8) — BG_REPEAT_* enum
//   (1 B padding to reach 4-byte alignment for the f32s below)
//   sizeW/sizeH (f32 each) — length(px) or percent 0..100; ignored when tag is COVER/CONTAIN/AUTO
//   positionX/positionY (f32 each) — length(px) or percent 0..100
// A layer is an IMAGE (imageIndex != 0xFFFF) or a GRADIENT
// (gradientKind != 0) — css-backgrounds-3's background-image list takes
// either at any position, so a node can carry several gradients, or mix
// gradients and url()s in one list. Before the gradient half existed a
// node had exactly ONE gradient, in its own BG_KIND/BG_GRADIENT_GEOMETRY
// fields, which is why `background-image: linear-gradient(…),
// radial-gradient(…)` could not be expressed at all.
//
// The entry layout is BYTE-IDENTICAL to MASK_LAYER's (P11), including the
// four bytes at 0x18-0x1B that only a mask uses — deliberately, so both
// pools feed the SAME $emitBackgroundLayerDraw and the same
// $resolveBackgroundSize/$resolveBackgroundRepeat calls with no
// per-pool adaptation. Keep them in lockstep.
//
// RELOCATED when the stride grew 24 -> 80: this pool now lives past what
// used to be FIXED_REGIONS_END rather than in its old slot, and
// 0x310220-0x316220 is an INTENTIONAL 24 KB hole in the region map. The
// alternative was renumbering the ~14 region bases that followed it; the
// build's memory map check (assertMemoryMap) catches regions that overlap.
export const BG_LAYER_POOL_BASE = layoutConstant("BG_LAYER_POOL_BASE");
export const BG_LAYER_POOL_SIZE = layoutConstant("BG_LAYER_POOL_SIZE"); // 81920 B (88 B x 930 layers)
export const BG_LAYER_ENTRY_SIZE = layoutConstant("BG_LAYER_ENTRY_SIZE");
export const BG_LAYER_MAX_ENTRIES = layoutConstant("BG_LAYER_MAX_ENTRIES");
export const BG_LAYER_OFFSET_IMAGE_INDEX = layoutConstant("BG_LAYER_OFFSET_IMAGE_INDEX"); // u16 (0xFFFF = none/gradient layer)
export const BG_LAYER_OFFSET_SIZE_W_TAG = layoutConstant("BG_LAYER_OFFSET_SIZE_W_TAG"); // u8
export const BG_LAYER_OFFSET_SIZE_H_TAG = layoutConstant("BG_LAYER_OFFSET_SIZE_H_TAG"); // u8
// A position tag is SIZE_TAG_LENGTH, PERCENT or CALC_PAIR; a CALC_PAIR adds
// POSITION_*_PERCENT, a fraction of the free space, to its length
// (`right 10px` is calc(100% - 10px)).
export const BG_LAYER_OFFSET_POSITION_X_TAG = layoutConstant("BG_LAYER_OFFSET_POSITION_X_TAG"); // u8
export const BG_LAYER_OFFSET_POSITION_Y_TAG = layoutConstant("BG_LAYER_OFFSET_POSITION_Y_TAG"); // u8
// Measures a gradient center from the far edge (GRAD_DESC_OFFSET_CENTER_*_TAG).
export const BG_LAYER_POSITION_TAG_FROM_END = layoutConstant("BG_LAYER_POSITION_TAG_FROM_END");
export const BG_LAYER_OFFSET_REPEAT_X = layoutConstant("BG_LAYER_OFFSET_REPEAT_X"); // u8: BG_REPEAT_* enum
export const BG_LAYER_OFFSET_REPEAT_Y = layoutConstant("BG_LAYER_OFFSET_REPEAT_Y"); // u8: BG_REPEAT_* enum
export const BG_LAYER_OFFSET_SIZE_W = layoutConstant("BG_LAYER_OFFSET_SIZE_W"); // f32
export const BG_LAYER_OFFSET_SIZE_H = layoutConstant("BG_LAYER_OFFSET_SIZE_H"); // f32
export const BG_LAYER_OFFSET_POSITION_X = layoutConstant("BG_LAYER_OFFSET_POSITION_X"); // f32
export const BG_LAYER_OFFSET_POSITION_Y = layoutConstant("BG_LAYER_OFFSET_POSITION_Y"); // f32
export const BG_LAYER_OFFSET_POSITION_X_PERCENT = layoutConstant("BG_LAYER_OFFSET_POSITION_X_PERCENT"); // f32
export const BG_LAYER_OFFSET_POSITION_Y_PERCENT = layoutConstant("BG_LAYER_OFFSET_POSITION_Y_PERCENT"); // f32
// Background attachment, origin and clip use the first three bytes of the
// background-only 0x18-0x1B metadata quartet. Mask entries use these bytes
// as mode, composite and origin; the shared draw helper receives the entry
// but these bytes are read only by the background caller.
export const BG_LAYER_OFFSET_ATTACHMENT = layoutConstant("BG_LAYER_OFFSET_ATTACHMENT"); // u8: BG_ATTACHMENT_* enum
export const BG_ATTACHMENT_SCROLL = layoutConstant("BG_ATTACHMENT_SCROLL");
export const BG_ATTACHMENT_LOCAL = layoutConstant("BG_ATTACHMENT_LOCAL");
export const BG_ATTACHMENT_FIXED = layoutConstant("BG_ATTACHMENT_FIXED");
// This layer's background-origin (LAYOUT_NODE_OFFSET_BACKGROUND_ORIGIN's
// encoding: 0 padding-box, 1 border-box, 2 content-box) and
// background-clip (LAYOUT_NODE_OFFSET_BACKGROUND_CLIP's encoding: 0
// border-box, 1 padding-box, 2 content-box). The node fields keep the
// bottom layer's values, which also govern the background color.
export const BG_LAYER_OFFSET_ORIGIN = layoutConstant("BG_LAYER_OFFSET_ORIGIN"); // u8
export const BG_LAYER_OFFSET_CLIP = layoutConstant("BG_LAYER_OFFSET_CLIP"); // u8
export const BG_LAYER_OFFSET_GRADIENT_KIND = layoutConstant("BG_LAYER_OFFSET_GRADIENT_KIND"); // u8: 0=none, else BG_KIND_* (bit7 = repeating)
// P13: this layer's background-blend-mode (BLEND_* enum, 0 = normal).
// Existing padding after GRADIENT_KIND, free in BOTH pool entries; a
// MASK_LAYER leaves it zero. Deliberately NOT one of the 0x18-0x1B bytes
// that carry the mask's own mode/composite/origin/clip — giving one byte
// two live meanings across two pools is the aliasing this file refuses
// elsewhere, and $emitBackgroundLayerDraw reads neither block, so the
// shared-entry-shape property holds either way.
export const BG_LAYER_OFFSET_BLEND_MODE = layoutConstant("BG_LAYER_OFFSET_BLEND_MODE"); // u8: BLEND_* enum (P13)
export const BG_LAYER_OFFSET_GRADIENT = layoutConstant("BG_LAYER_OFFSET_GRADIENT"); // GRAD_DESC_SIZE bytes (0x20-0x4B), 4 B tail pad

// =======================================================================
// Gradient descriptor (P11) — the packed parameter block
// $writeGradientExtension reads its gradient from. Before P11 that
// function took a $nodePtr and read the parameters from fields scattered
// across the node struct (STOP_COUNT/STOP_OFFSET at 0x15B/0x164,
// BG_GRADIENT_GEOMETRY at 0x20C, BG_CENTER_* at 0x254, RADIAL_* at
// 0x256); a mask layer's gradient is per-LAYER, so the parameters had to
// become a struct that both a node and a pool entry can present. The
// node-side callers fill a scratch descriptor from their own fields
// ($writeGradientDescriptorFromNode); a mask layer entry's gradient block
// IS this layout, read in place.
export const GRAD_DESC_SIZE = layoutConstant("GRAD_DESC_SIZE");
export const GRAD_DESC_OFFSET_STOP_COUNT = layoutConstant("GRAD_DESC_OFFSET_STOP_COUNT"); // u8
export const GRAD_DESC_OFFSET_CENTER_X_TAG = layoutConstant("GRAD_DESC_OFFSET_CENTER_X_TAG"); // u8: SIZE_TAG_LENGTH/PERCENT
export const GRAD_DESC_OFFSET_CENTER_Y_TAG = layoutConstant("GRAD_DESC_OFFSET_CENTER_Y_TAG"); // u8
export const GRAD_DESC_OFFSET_RADIAL_SHAPE = layoutConstant("GRAD_DESC_OFFSET_RADIAL_SHAPE"); // u8: RADIAL_SHAPE_*
export const GRAD_DESC_OFFSET_RADIAL_SIZE = layoutConstant("GRAD_DESC_OFFSET_RADIAL_SIZE"); // u8: RADIAL_SIZE_*
export const GRAD_DESC_OFFSET_INTERPOLATION = layoutConstant("GRAD_DESC_OFFSET_INTERPOLATION"); // u8: packed space + hue method
export const GRAD_DESC_OFFSET_STOP_OFFSET = layoutConstant("GRAD_DESC_OFFSET_STOP_OFFSET"); // u32: GRADIENT_STOP_POOL span offset
export const GRAD_DESC_OFFSET_GEOMETRY = layoutConstant("GRAD_DESC_OFFSET_GEOMETRY"); // f32[4]: linear angle geom[0], conic angle geom[2]
export const GRAD_DESC_OFFSET_CENTER_X = layoutConstant("GRAD_DESC_OFFSET_CENTER_X"); // f32
export const GRAD_DESC_OFFSET_CENTER_Y = layoutConstant("GRAD_DESC_OFFSET_CENTER_Y"); // f32
export const GRAD_DESC_OFFSET_EXPLICIT_RX = layoutConstant("GRAD_DESC_OFFSET_EXPLICIT_RX"); // f32
export const GRAD_DESC_OFFSET_EXPLICIT_RY = layoutConstant("GRAD_DESC_OFFSET_EXPLICIT_RY"); // f32

// =======================================================================
// Mask layer pool (P11) — one fixed-size entry per mask-image LAYER, same
// "pool + per-node span pointer" shape and same per-scene bump-allocated
// lifetime as BG_LAYER_POOL above, reached via LAYOUT_NODE_OFFSET_MASK_
// LAYER_COUNT/MASK_LAYERS_OFFSET. Written bottom-to-top (CSS list order
// reversed), so the engine's forward walk composites lower layers first.
//
// The first 24 bytes ARE BG_LAYER's exact field layout, so the shared
// $resolveBackgroundSize/$resolveBackgroundRepeat take the same arguments
// from either pool. Unlike a background layer, a mask layer carries its
// OWN gradient (a node's single BG_KIND/BG_GRADIENT_GEOMETRY block can
// hold exactly one gradient — the P5c limitation recorded in this plan's
// status list), so the entry continues with the mask-only enums and a
// full GRAD_DESC block.
//
// 80 B/layer x 512 layers = 40960 B.
export const MASK_LAYER_POOL_BASE = layoutConstant("MASK_LAYER_POOL_BASE");
export const MASK_LAYER_POOL_SIZE = layoutConstant("MASK_LAYER_POOL_SIZE"); // 40960 B (80 B x 512 layers)
export const MASK_LAYER_ENTRY_SIZE = layoutConstant("MASK_LAYER_ENTRY_SIZE");
export const MASK_LAYER_MAX_ENTRIES = layoutConstant("MASK_LAYER_MAX_ENTRIES");
export const MASK_LAYER_OFFSET_IMAGE_INDEX = layoutConstant("MASK_LAYER_OFFSET_IMAGE_INDEX"); // u16 (0xFFFF = none/gradient layer)
export const MASK_LAYER_OFFSET_SIZE_W_TAG = layoutConstant("MASK_LAYER_OFFSET_SIZE_W_TAG"); // u8
export const MASK_LAYER_OFFSET_SIZE_H_TAG = layoutConstant("MASK_LAYER_OFFSET_SIZE_H_TAG"); // u8
export const MASK_LAYER_OFFSET_POSITION_X_TAG = layoutConstant("MASK_LAYER_OFFSET_POSITION_X_TAG"); // u8
export const MASK_LAYER_OFFSET_POSITION_Y_TAG = layoutConstant("MASK_LAYER_OFFSET_POSITION_Y_TAG"); // u8
export const MASK_LAYER_OFFSET_REPEAT_X = layoutConstant("MASK_LAYER_OFFSET_REPEAT_X"); // u8: BG_REPEAT_* enum
export const MASK_LAYER_OFFSET_REPEAT_Y = layoutConstant("MASK_LAYER_OFFSET_REPEAT_Y"); // u8: BG_REPEAT_* enum
export const MASK_LAYER_OFFSET_SIZE_W = layoutConstant("MASK_LAYER_OFFSET_SIZE_W"); // f32
export const MASK_LAYER_OFFSET_SIZE_H = layoutConstant("MASK_LAYER_OFFSET_SIZE_H"); // f32
export const MASK_LAYER_OFFSET_POSITION_X = layoutConstant("MASK_LAYER_OFFSET_POSITION_X"); // f32
export const MASK_LAYER_OFFSET_POSITION_Y = layoutConstant("MASK_LAYER_OFFSET_POSITION_Y"); // f32
export const MASK_LAYER_OFFSET_MODE = layoutConstant("MASK_LAYER_OFFSET_MODE"); // u8: MASK_MODE_*
export const MASK_LAYER_OFFSET_COMPOSITE = layoutConstant("MASK_LAYER_OFFSET_COMPOSITE"); // u8: MASK_COMPOSITE_*
export const MASK_LAYER_OFFSET_ORIGIN = layoutConstant("MASK_LAYER_OFFSET_ORIGIN"); // u8: MASK_ORIGIN_*
export const MASK_LAYER_OFFSET_CLIP = layoutConstant("MASK_LAYER_OFFSET_CLIP"); // u8: MASK_CLIP_*
export const MASK_LAYER_OFFSET_GRADIENT_KIND = layoutConstant("MASK_LAYER_OFFSET_GRADIENT_KIND"); // u8: 0=none, else BG_KIND_* (bit7 = repeating)
export const MASK_LAYER_OFFSET_GRADIENT = layoutConstant("MASK_LAYER_OFFSET_GRADIENT"); // GRAD_DESC_SIZE bytes (0x20-0x4B), 4 B tail pad

// SVG geometry pool (design/svg-rendering.md): a node's GEOM_OFFSET/GEOM_LENGTH
// (P0-reserved, see the node-struct offsets above) point at a span of
// fixed-size entries here — same "pool + per-node span pointer" pattern
// as BG_LAYER_POOL just above, TEXT_SOURCE_BASE, and SHAPED_GLYPH_POOL_BASE.
// GEOM_LENGTH counts ENTRIES (not bytes) for Tier A shapes, always 1 (a
// rect/circle/line is one shape = one entry; a future <polygon>/<polyline>
// (Tier B) would use a multi-entry span of point pairs instead — GEOM_LENGTH
// already supports that without a format change, S1 just never emits >1).
//
// Fields are a uniform 6xf32 slots generically sized for the LARGEST Tier A
// shape (rect: x,y,width,height,rx,ry); circle/line use fewer slots and
// leave the rest zeroed/unread. $emitNodeRect (engine.wat) reads by
// NODE_SVG_KIND to know which fields apply — see SVG_KIND_* in
// layout.js's enum block above for the kind values.
//   rect:   [0]=x [1]=y [2]=width [3]=height [4]=rx [5]=ry
//   circle: [0]=cx [1]=cy [2]=r
//   line:   [0]=x1 [1]=y1 [2]=x2 [3]=y2
export const SVG_GEOM_POOL_BASE = layoutConstant("SVG_GEOM_POOL_BASE");
export const SVG_GEOM_POOL_SIZE = layoutConstant("SVG_GEOM_POOL_SIZE"); // 24576 B (24 B x 1024 entries)
export const SVG_GEOM_ENTRY_SIZE = layoutConstant("SVG_GEOM_ENTRY_SIZE");
export const SVG_GEOM_MAX_ENTRIES = layoutConstant("SVG_GEOM_MAX_ENTRIES");
export const SVG_GEOM_OFFSET_0 = layoutConstant("SVG_GEOM_OFFSET_0"); // f32
export const SVG_GEOM_OFFSET_1 = layoutConstant("SVG_GEOM_OFFSET_1"); // f32
export const SVG_GEOM_OFFSET_2 = layoutConstant("SVG_GEOM_OFFSET_2"); // f32
export const SVG_GEOM_OFFSET_3 = layoutConstant("SVG_GEOM_OFFSET_3"); // f32
export const SVG_GEOM_OFFSET_4 = layoutConstant("SVG_GEOM_OFFSET_4"); // f32
export const SVG_GEOM_OFFSET_5 = layoutConstant("SVG_GEOM_OFFSET_5"); // f32

// Gradient stop pool (design/paint-coverage.md P4): a node's background
// gradient (LAYOUT_NODE_OFFSET_STOP_OFFSET/STOP_COUNT, P0-reserved) points
// at a span of fixed-size entries here — same "pool + per-node span
// pointer" pattern as SVG_GEOM_POOL/BG_LAYER_POOL just above. Bump-
// allocated fresh every emitSceneCommands/render call (pure per-node
// style, cheap to recompute), same lifetime as those two pools.
//
// 28 B/entry x 1462 entries fit in 40960 B. A stop keeps its position
// unresolved: a fraction of the gradient line plus a length in CSS px.
// The raster plan resolves the length against the gradient line of the
// painted tile (the linear gradient length, the radial horizontal radius)
// and then fixes the stops up (CSS Images 3, 3.5.3): an unpositioned end
// stop goes to 0 or 1, a position never goes back, and a run of
// unpositioned stops spreads evenly between its neighbours.
//   position (f32) — fraction of the gradient line; NaN when the author
//     gives no position
//   color (f32[4]) — rgba, straight (NOT premultiplied) at rest; the
//     rasterizer premultiplies at interpolation time (see P4's "Rasterizer"
//     section — premultiplied-sRGB interpolation is a shader-side concern)
//   length (f32) — CSS px along the gradient line, added to position
export const GRADIENT_STOP_POOL_BASE = layoutConstant("GRADIENT_STOP_POOL_BASE");
export const GRADIENT_STOP_POOL_SIZE = layoutConstant("GRADIENT_STOP_POOL_SIZE"); // 40960 B (28 B x 1462 entries)
export const GRADIENT_STOP_ENTRY_SIZE = layoutConstant("GRADIENT_STOP_ENTRY_SIZE");

export const GRADIENT_STOP_OFFSET_POSITION = layoutConstant("GRADIENT_STOP_OFFSET_POSITION"); // f32
export const GRADIENT_STOP_OFFSET_COLOR = layoutConstant("GRADIENT_STOP_OFFSET_COLOR"); // f32[4]: components + alpha
// u32: bits 0-2 = missing-component mask (CSS `none`), bit 3 = alpha missing,
// bit 4 = a colour hint (its position only; the raster plan replaces it with
// nine stops between its neighbours).
export const GRADIENT_STOP_OFFSET_MISSING = layoutConstant("GRADIENT_STOP_OFFSET_MISSING");
export const GRADIENT_STOP_OFFSET_LENGTH = layoutConstant("GRADIENT_STOP_OFFSET_LENGTH"); // f32

// Shadow pool (design/paint-coverage.md P3): a node's box-shadow list
// (LAYOUT_NODE_OFFSET_SHADOW_OFFSET/SHADOW_COUNT, P0-reserved) points at a
// span of fixed-size entries here — same "pool + per-node span pointer"
// pattern as every other P4/P5c/SVG pool above. Bump-allocated fresh every
// emitSceneCommands/render call. Entries hold the RAW per-shadow CSS
// declaration (offset/blur-radius/spread/color/inset) — the engine reads
// a span of these at CMD_BOX_SHADOW emission time and resolves the FINAL
// offset+spread-adjusted rect, spread-adjusted per-corner radii (css-
// backgrounds-3 §7.1's curvature rule when r<spread), and blur sigma
// (b/2) into the command itself; the pool never travels to the
// rasterizer directly, same "engine computes, rasterizer stays dumb"
// split as every other command.
//
// 40 B/entry x 1024 entries = 40960 B. Per the plan's own list-order
// rule, multiple shadows on one node emit in REVERSE CSS-list order (the
// first-listed shadow paints on top), a JS/engine emission-order concern,
// not a pool-format one — entries themselves carry no ordering field.
//   offsetX, offsetY (f32) — CSS px, already resolved from any length unit
//   blurRadius (f32)       — CSS px, raw (NOT pre-halved to sigma — the
//                            engine applies b/2 at CMD_BOX_SHADOW emission)
//   spread (f32)           — CSS px
//   color (f32[4])         — straight (not premultiplied) rgba
//   inset (u8)             — 0=outset, 1=inset
export const SHADOW_POOL_BASE = layoutConstant("SHADOW_POOL_BASE");
export const SHADOW_POOL_SIZE = layoutConstant("SHADOW_POOL_SIZE"); // 40960 B (40 B x 1024 entries)
export const SHADOW_ENTRY_SIZE = layoutConstant("SHADOW_ENTRY_SIZE");
export const SHADOW_MAX_ENTRIES = layoutConstant("SHADOW_MAX_ENTRIES");
export const SHADOW_OFFSET_OFFSET_X = layoutConstant("SHADOW_OFFSET_OFFSET_X"); // f32
export const SHADOW_OFFSET_OFFSET_Y = layoutConstant("SHADOW_OFFSET_OFFSET_Y"); // f32
export const SHADOW_OFFSET_BLUR = layoutConstant("SHADOW_OFFSET_BLUR"); // f32
export const SHADOW_OFFSET_SPREAD = layoutConstant("SHADOW_OFFSET_SPREAD"); // f32
export const SHADOW_OFFSET_COLOR = layoutConstant("SHADOW_OFFSET_COLOR"); // f32[4]
export const SHADOW_OFFSET_INSET = layoutConstant("SHADOW_OFFSET_INSET"); // u8

// =======================================================================
// End of fixed regions: 0x2F5370 (~2.95 MB). P0 (node-struct stride bump
// 320->640, design/paint-coverage.md) shifted the PREVIOUS end (0x27D240)
// to 0x2BD240; Slice P5a's IMAGE_TABLE appended 0x800 more (to 0x2BDA40);
// Slice P5c's BG_LAYER_POOL appended 0x6000 more (to 0x2C3A40);
// the SVG geometry pool appended 0x6000 more (to 0x2C9A40);
// the SVG stroke-path node-struct stride bump (640->648, LAYOUT_NODE_OFFSET_
// SVG_STROKE_PATH_INDEX) shifted EVERY region from LAYOUT_BUFFER_BASE
// onward by +0x1918 (to 0x2CB358) — a genuine stride-bump shift, not an
// append, since this delta lands before LAYOUT_BUFFER_BASE's own
// contents rather than after FIXED_REGIONS_END. P4 step 1's
// GRADIENT_STOP_POOL appended 0xA000 more (to 0x2D5358) — an append, not
// a shift, since P4's linear-gradient fields needed NO node-struct
// stride bump (they fit inside P0's own reserved headroom). P4 step 3
// (radial/conic center + radial shape/size, LAYOUT_NODE_OFFSET_BG_
// CENTER_X_TAG) DID need a genuine stride bump (648->672) — same
// "shifts everything from LAYOUT_BUFFER_BASE onward" mechanics as S5's
// own bump, +0x4CC8 this time (to 0x2DA020). P3 step 1's SHADOW_POOL
// appended 0xA000 more (to 0x2E4020) — an append, not a shift, since
// P3's node-level shadow-span fields (SHADOW_COUNT/SHADOW_OFFSET) were
// ALREADY P0-reserved, same "no stride bump needed" situation P4 step 1
// found for its own linear-gradient fields. The oriented-clip redesign's
// CLIP_ARENA appended 0x8000 more (to 0x2EC020) — an append, no stride
// bump (clip state is walk scratch, not node fields). P9's
// CLIP_PATH_POOL appended 0x4000 more (to 0x2F0020) — an append, no
// stride bump (the node-side index u16 fit P4 step 3's own 4-byte
// spare at 0x268). P8 step 1's FILTER_POOL appended 0x5000 more (to
// 0x2F5020) — an append, no stride bump (FILTER_COUNT/OFFSET and
// BACKDROP_FILTER_COUNT/OFFSET were ALREADY P0-reserved). P8's blur
// sub-step's FILTER_SEGMENT_SCRATCH appended 0x350 more (to 0x2F5370)
// — an append, no stride bump (single-node scratch, not a node field).
// The INLINE_ITEM_POOL appended 0x10000 more (to
// 0x305370) — an append, no stride bump (the IFC-root's item span reuses
// TEXT_RUN_DIR's existing per-node LINE_OFFSET/LINE_COUNT fields rather
// than needing a new node field). I1's INLINE_GLYPH_MAP appended 0x20200
// more (to 0x325570) — another append, same reasoning, needed once the
// line-breaker's virtual-glyph-index design was pinned down (glyphs from
// different items aren't contiguous in SHAPED_GLYPH_POOL). I1's
// LINE_FRAGMENT_POOL appended 0x14000 more (to 0x339570) — the per-
// fragment detail TEXT_LINE_POOL's own (reinterpreted) records point
// into, no stride bump (dual-interprets TEXT_LINE_POOL's existing
// FIRST_GLYPH/GLYPH_COUNT fields rather than adding new node fields).
// =======================================================================

// =======================================================================
// Clip arena (oriented-clip redesign)
// =======================================================================
//
// A LIFO arena of immutable clip-entry LISTS — the paint walk's clip state.
// Each list is a contiguous run of CLIP_ENTRY_SIZE entries (the same
// 80-byte layout CMD_PUSH_CLIP carries on the wire — emission is a plain
// byte copy). Entering a clip scope allocates a NEW list at the arena top
// (copy of the current list with the new entry merged in — entries sharing
// an affine intersect via $clipListAppend's port of the old
// $intersectCurClip rules, distinct affines append); leaving a scope
// restores the previously-saved (base, count, arenaTop) triple. Lists are
// never mutated after allocation, so a containing-block snapshot
// ($absClipListBase/Count) is a plain reference that stays valid for the
// whole bracket that took it. A list that does not fit in the reserved
// arena goes to an allocated chunk ($clipListReserve); a list has no entry
// limit.
export const CLIP_ARENA_BASE = layoutConstant("CLIP_ARENA_BASE");
export const CLIP_ARENA_SIZE = layoutConstant("CLIP_ARENA_SIZE"); // 32 KB (409 × 80 B entries)

// =======================================================================
// clip-path pool (design/paint-coverage.md P9)
// =======================================================================
//
// One fixed-size record per node with a clip-path (at most one per node —
// LAYOUT_NODE_OFFSET_CLIP_PATH_INDEX is one-based; 0 = none). Basic shapes
// carry per-value TAG bytes, resolved at emission against the border box.
// DOM polygons retain typed coordinates and resolve their path after layout.
// Emission appends the resulting mask to the oriented clip list
// (see CLIP_ARENA above / design/clipping.md).
//   kind u8:    1 = inset, 2 = circle, 3 = ellipse, 4 = polygon, 5 = path
//   tags u8[4]: per-value CLIP_PATH_VALUE_* for basic shapes; for polygon/
//               path, bytes 2..3 carry the opaque SVG-path atlas index
//   values f32[4]: basic-shape tagged values; for polygon/path, the resolved
//                  path bbox [xMin,yMin,xMax,yMax] in path coordinates
//   radii f32[8]: inset's `round` radii; polygon/path uses radii[0] for the
//                 path-coordinate-to-layout scale. DOM polygons also retain
//                 an immutable definition pointer at byte 32 and the last
//                 reference box [x,y,width,height] at bytes 48..63.
export const CLIP_PATH_POOL_BASE = layoutConstant("CLIP_PATH_POOL_BASE");
export const CLIP_PATH_POOL_SIZE = layoutConstant("CLIP_PATH_POOL_SIZE"); // 16384 B (64 B × 256)
export const CLIP_PATH_ENTRY_SIZE = layoutConstant("CLIP_PATH_ENTRY_SIZE");
export const CLIP_PATH_MAX_ENTRIES = layoutConstant("CLIP_PATH_MAX_ENTRIES");
export const CLIP_PATH_OFFSET_KIND = layoutConstant("CLIP_PATH_OFFSET_KIND"); // u8
export const CLIP_PATH_OFFSET_TAGS = layoutConstant("CLIP_PATH_OFFSET_TAGS"); // u8[4]
export const CLIP_PATH_OFFSET_PATH_INDEX = layoutConstant("CLIP_PATH_OFFSET_PATH_INDEX"); // u16, polygon/path only
export const CLIP_PATH_OFFSET_VALUES = layoutConstant("CLIP_PATH_OFFSET_VALUES"); // f32[4]
export const CLIP_PATH_OFFSET_RADII = layoutConstant("CLIP_PATH_OFFSET_RADII"); // f32[8]
export const CLIP_PATH_KIND_INSET = layoutConstant("CLIP_PATH_KIND_INSET");
export const CLIP_PATH_KIND_CIRCLE = layoutConstant("CLIP_PATH_KIND_CIRCLE");
export const CLIP_PATH_KIND_ELLIPSE = layoutConstant("CLIP_PATH_KIND_ELLIPSE");
export const CLIP_PATH_KIND_POLYGON = layoutConstant("CLIP_PATH_KIND_POLYGON");
export const CLIP_PATH_KIND_PATH = layoutConstant("CLIP_PATH_KIND_PATH");
export const CLIP_PATH_VALUE_PX = layoutConstant("CLIP_PATH_VALUE_PX");
export const CLIP_PATH_VALUE_PERCENT = layoutConstant("CLIP_PATH_VALUE_PERCENT"); // stored 0..100
export const CLIP_PATH_VALUE_CLOSEST_SIDE = layoutConstant("CLIP_PATH_VALUE_CLOSEST_SIDE"); // circle/ellipse radii only
export const CLIP_PATH_VALUE_FARTHEST_SIDE = layoutConstant("CLIP_PATH_VALUE_FARTHEST_SIDE"); // circle/ellipse radii only

// =======================================================================

// =======================================================================
// filter pool (design/paint-coverage.md P8) — filter and backdrop-filter
// share this ONE pool format; a node's LAYOUT_NODE_OFFSET_FILTER_OFFSET/
// COUNT and ..._BACKDROP_FILTER_OFFSET/COUNT each point at their own span
// within it (two independent lists, filter and backdrop-filter never
// share entries even when both are present on the same node).
// =======================================================================
//
// One fixed-size record per filter-list entry (list order = engine
// emission order = CSS's own left-to-right chaining order — entries
// carry no ordering field, same "order is span order" convention as
// SHADOW_POOL). fn selects which filter function this entry is; payload
// is a plain f32[4] union, interpreted per fn:
//   brightness/contrast/saturate/grayscale/sepia/invert/hue-rotate/
//     opacity: payload[0] = amount (grayscale/sepia/invert treat amount
//     as 0..1 interpolation-to-full-strength; hue-rotate's amount is
//     radians, pre-converted from the CSS angle JS-side)
//   drop-shadow: payload[0]=dx, payload[1]=dy, payload[2]=sigma (px,
//     NOT css blur-radius — the raw std deviation, unlike box-shadow's
//     radius/2 mapping), payload[3..6] = four 32-bit color floats
//     (r, g, b, a — no packed-integer color remains anywhere)
//   blur: payload[0] = sigma (px, direct — filter:blur()'s own length
//     IS sigma, unlike box-shadow's blur-radius)
export const FILTER_POOL_BASE = layoutConstant("FILTER_POOL_BASE");
export const FILTER_POOL_SIZE = layoutConstant("FILTER_POOL_SIZE"); // 20480 B (32 B x 640 entries)
export const FILTER_ENTRY_SIZE = layoutConstant("FILTER_ENTRY_SIZE");
export const FILTER_MAX_ENTRIES = layoutConstant("FILTER_MAX_ENTRIES");
export const FILTER_OFFSET_FN = layoutConstant("FILTER_OFFSET_FN"); // u8
export const FILTER_OFFSET_PAYLOAD = layoutConstant("FILTER_OFFSET_PAYLOAD"); // f32[7]
export const FILTER_FN_BRIGHTNESS = layoutConstant("FILTER_FN_BRIGHTNESS");
export const FILTER_FN_CONTRAST = layoutConstant("FILTER_FN_CONTRAST");
export const FILTER_FN_SATURATE = layoutConstant("FILTER_FN_SATURATE");
export const FILTER_FN_GRAYSCALE = layoutConstant("FILTER_FN_GRAYSCALE");
export const FILTER_FN_SEPIA = layoutConstant("FILTER_FN_SEPIA");
export const FILTER_FN_INVERT = layoutConstant("FILTER_FN_INVERT");
export const FILTER_FN_HUE_ROTATE = layoutConstant("FILTER_FN_HUE_ROTATE");
export const FILTER_FN_OPACITY = layoutConstant("FILTER_FN_OPACITY");
export const FILTER_FN_BLUR = layoutConstant("FILTER_FN_BLUR");
export const FILTER_FN_DROP_SHADOW = layoutConstant("FILTER_FN_DROP_SHADOW");

// =======================================================================
// Filter-segment scratch (design/paint-coverage.md P8, blur sub-step) — a
// SINGLE-node's-worth scratch buffer, not a pool: $composeFilterSegments
// walks one node's FILTER_POOL span, folds contiguous color-matrix
// entries into ONE matrix segment each, and writes the resulting
// segment list HERE in the exact same byte layout CMD_PUSH_OPACITY's own
// segment extension uses (so $emitPushOpacity is a plain word-copy, same
// "resolve into an arena, then emit via memcpy" pattern as $emitPushClip/
// CLIP_ARENA). Re-populated fresh per $paintContext call — never holds
// more than one node's segments at a time, no cross-call reuse risk (the
// SVG-root-vs-clip-scope class of bug this codebase has hit before
// requires a stale-read across TWO different call sites; this scratch
// has exactly one writer and one reader, called back-to-back).
// Sized for the worst case: every one of the 10 distinct filter
// functions in one list with NO folding (e.g. alternating blur/matrix),
// same conservative sizing spirit as FILTER_MAX_ENTRIES.
export const FILTER_SEGMENT_SCRATCH_BASE = layoutConstant("FILTER_SEGMENT_SCRATCH_BASE");
export const FILTER_SEGMENT_SCRATCH_MAX = layoutConstant("FILTER_SEGMENT_SCRATCH_MAX");
export const FILTER_SEGMENT_SCRATCH_SIZE = layoutConstant("FILTER_SEGMENT_SCRATCH_SIZE"); // 840 B (10 x 84 B segments)

// =======================================================================
// Exclusion scratch (design/floats.md): placed floats per BFC
// nesting level — the float's MARGIN box in absolute page px (same
// coordinate space as computed boxes) + its type. Same depth-indexed-
// slice shape as FLEX_SCRATCH ($bfcLevel selects the slice), but budget
// overflow GROWS the stack instead of reusing the last slice: flex-slice
// reuse only degrades pathological nesting's precision, exclusion-slice
// reuse would make one BFC's floats silently visible to another. Every
// level starts with a 16-byte header (count u32 + 12 reserved), then
// EXCLUSION_ENTRIES_PER_LEVEL 24-byte entries. Clear offsets and the
// top-edge-rule's last-float-block-start are DERIVED by scanning the
// entries at query time, not maintained incrementally like Blink's
// ExclusionSpaceInternal — keeps provisional-Y rollback (see the plan's
// F1 design) to "restore count", nothing else.
//
// The BASE, STRIDE, LEVELS and ENTRIES_PER_LEVEL below are the INITIAL
// map: $exclusionPushLevel doubles the stack into an allocated block when
// a document nests more formatting contexts than the fixed region holds
// (the stride does not change, so every live level copies flat), and
// $exclusionAppend doubles the entries of every level when one level is
// full (each level moves to its slot at the new stride).
// exclusion_scratch_base() / exclusion_levels() report the current pair.
// The build's memory map check reads the initial values. Only an
// allocator that refuses a block stops layout, named (trap sites 4 and 5).
// =======================================================================

export const EXCLUSION_SCRATCH_BASE = layoutConstant("EXCLUSION_SCRATCH_BASE");
export const EXCLUSION_LEVEL_STRIDE = layoutConstant("EXCLUSION_LEVEL_STRIDE"); // initial: header + 64 × 24 B = 1552, strided to 1664
export const EXCLUSION_LEVELS = layoutConstant("EXCLUSION_LEVELS"); // initial; doubles on demand
export const EXCLUSION_SCRATCH_SIZE = layoutConstant("EXCLUSION_SCRATCH_SIZE"); // 16 × 0x680 = 26 KB
export const EXCLUSION_ENTRIES_PER_LEVEL = layoutConstant("EXCLUSION_ENTRIES_PER_LEVEL"); // initial; doubles on demand
export const EXCLUSION_HEADER_SIZE = layoutConstant("EXCLUSION_HEADER_SIZE");
export const EXCLUSION_HEADER_OFFSET_COUNT = layoutConstant("EXCLUSION_HEADER_OFFSET_COUNT"); // u32
export const EXCLUSION_ENTRY_SIZE = layoutConstant("EXCLUSION_ENTRY_SIZE");
export const EXCLUSION_ENTRY_OFFSET_BLOCK_START = layoutConstant("EXCL_BLOCK_START"); // f32: margin-box top
export const EXCLUSION_ENTRY_OFFSET_BLOCK_END = layoutConstant("EXCL_BLOCK_END"); // f32: margin-box bottom
export const EXCLUSION_ENTRY_OFFSET_INLINE_START = layoutConstant("EXCL_INLINE_START"); // f32: margin-box left
export const EXCLUSION_ENTRY_OFFSET_INLINE_END = layoutConstant("EXCL_INLINE_END"); // f32: margin-box right
export const EXCLUSION_ENTRY_OFFSET_TYPE = layoutConstant("EXCL_TYPE"); // u32: FLOAT_LEFT / FLOAT_RIGHT

// =======================================================================
// F4: Blink DerivedGeometry scratch (shelves + closed-off areas) for the
// avoided-BFC placement query — rebuilt per query from the current
// exclusion level's entries; no persistent state (rollback stays "restore
// the entry count"). Mirrors engine.wat's SHELF_GEOM_* — keep in
// lockstep; internal slot layout is documented at the WAT globals. The
// BASE and SIZE are the initial fixed region; a build that needs more
// shelves, areas or edges moves the geometry into an allocated block.

export const SHELF_GEOM_BASE = layoutConstant("SHELF_GEOM_BASE");
export const SHELF_GEOM_SIZE = layoutConstant("SHELF_GEOM_SIZE"); // 136 KB: 66 shelves + copy + 65 areas x 1048 B

// Inline edge map (I4): per virtual glyph, horizontal inline-box edges
// attached immediately before/after it. OPEN ancestors add their
// margin+border+padding to the first descendant glyph; CLOSE ancestors add
// the corresponding trailing edge to the last. JUSTIFY is the px that
// text-align: justify adds to the glyph's advance after the glyph (CSS
// Text 3 §7.4): part of the glyph's text advance, so fragment widths,
// positions and paint include it. Transient per layout call, indexed
// exactly like INLINE_GLYPH_MAP, 12 B per entry: 1.5 times the map's size.
// It starts where INLINE_GLYPH_MAP ends; [0x01606000, 0x01646000) before
// LINE_FRAGMENT_POOL is unused.
export const INLINE_EDGE_MAP_BASE = layoutConstant("INLINE_EDGE_MAP_BASE");
export const INLINE_EDGE_MAP_SIZE = layoutConstant("INLINE_EDGE_MAP_SIZE");
export const INLINE_EDGE_MAP_ENTRY_SIZE = layoutConstant("INLINE_EDGE_MAP_ENTRY_SIZE");
export const INLINE_EDGE_MAP_OFFSET_BEFORE = layoutConstant("INLINE_EDGE_MAP_OFFSET_BEFORE");
export const INLINE_EDGE_MAP_OFFSET_AFTER = layoutConstant("INLINE_EDGE_MAP_OFFSET_AFTER");
export const INLINE_EDGE_MAP_OFFSET_JUSTIFY = layoutConstant("INLINE_EDGE_MAP_OFFSET_JUSTIFY");

// Inline box state scratch (I6): one 32-byte transient state per persisted
// inline item, rebuilt for each line while closing nested inline boxes.
// Relocated + doubled for D1: indexed by the GLOBAL inline-item index, so
// its capacity tracks INLINE_ITEM_POOL's own (65536 items).
export const INLINE_STATE_SCRATCH_BASE = layoutConstant("INLINE_STATE_SCRATCH_BASE");
export const INLINE_STATE_SCRATCH_SIZE = layoutConstant("INLINE_STATE_SCRATCH_SIZE");
export const INLINE_STATE_ENTRY_SIZE = layoutConstant("INLINE_STATE_ENTRY_SIZE");
export const INLINE_STATE_MAX_ENTRIES = layoutConstant("INLINE_STATE_MAX_ENTRIES");

// =======================================================================

// P11's MASK_LAYER_POOL appended 0xA000 (0x3AE400 -> 0x3B8400) and the
// gradient-descriptor scratch 0x40 more — appends past the old end, not
// shifts, so no existing region moved.
export const GRAD_DESC_SCRATCH_BASE = layoutConstant("GRAD_DESC_SCRATCH_BASE");
export const GRAD_DESC_SCRATCH_SIZE = layoutConstant("GRAD_DESC_SCRATCH_SIZE"); // one GRAD_DESC_SIZE record, padded
// BG_LAYER_POOL's relocation (stride 24 -> 80) appended 0x14000 here
// (0x3B8440 -> 0x3CC440); its old 0x310220-0x316220 slot is now an
// intentional hole — see that pool's own comment.
// P14's BORDER_IMAGE_POOL appends 0x4000 at the old end (0x3CC440 ->
// 0x3D0440) — an append past the end, not a shift, so no existing region
// moved (P0's rule, same as MASK_LAYER_POOL above).
export const BORDER_IMAGE_POOL_BASE = layoutConstant("BORDER_IMAGE_POOL_BASE");
export const BORDER_IMAGE_POOL_SIZE = layoutConstant("BORDER_IMAGE_POOL_SIZE"); // 16384 B (112 B x 146)
export const BORDER_IMAGE_ENTRY_SIZE = layoutConstant("BORDER_IMAGE_ENTRY_SIZE");
export const BORDER_IMAGE_MAX_ENTRIES = layoutConstant("BORDER_IMAGE_MAX_ENTRIES");

// One entry per node that HAS a border-image, bump-allocated per scene
// like every other pool here. Reached by index from
// LAYOUT_NODE_OFFSET_BORDER_IMAGE_INDEX.
//
// A number slice is in image pixels. A percentage slice is kept as a
// percentage (its bit in BORDER_IMAGE_OFFSET_SLICE_PERCENT) and resolves
// in WAT at emit time against the concrete size of the image: its natural
// size, or for an image without natural dimensions the size that the
// default sizing algorithm gives in the border image area. Widths and
// outsets are NOT pre-resolved either: those depend on the border box and
// on border-width, so they carry unit tags and resolve in WAT at emit time.
// A gradient source has no image index (0xFFFF): its kind byte and its
// gradient descriptor give the image, whose concrete size is the border
// image area (CSS Backgrounds 3 §6.2).
export const BORDER_IMAGE_OFFSET_IMAGE_INDEX = layoutConstant("BORDER_IMAGE_OFFSET_IMAGE_INDEX"); // u16: source, into IMAGE_TABLE
export const BORDER_IMAGE_OFFSET_FILL = layoutConstant("BORDER_IMAGE_OFFSET_FILL"); // u8: the `fill` keyword — paint the centre slice
export const BORDER_IMAGE_OFFSET_REPEAT_X = layoutConstant("BORDER_IMAGE_OFFSET_REPEAT_X"); // u8: BORDER_IMAGE_REPEAT_*
export const BORDER_IMAGE_OFFSET_REPEAT_Y = layoutConstant("BORDER_IMAGE_OFFSET_REPEAT_Y"); // u8: BORDER_IMAGE_REPEAT_*
export const BORDER_IMAGE_OFFSET_WIDTH_TOP_TAG = layoutConstant("BORDER_IMAGE_OFFSET_WIDTH_TOP_TAG"); // u8: BORDER_IMAGE_WIDTH_*
export const BORDER_IMAGE_OFFSET_WIDTH_RIGHT_TAG = layoutConstant("BORDER_IMAGE_OFFSET_WIDTH_RIGHT_TAG"); // u8
export const BORDER_IMAGE_OFFSET_WIDTH_BOTTOM_TAG = layoutConstant("BORDER_IMAGE_OFFSET_WIDTH_BOTTOM_TAG"); // u8
export const BORDER_IMAGE_OFFSET_WIDTH_LEFT_TAG = layoutConstant("BORDER_IMAGE_OFFSET_WIDTH_LEFT_TAG"); // u8
export const BORDER_IMAGE_OFFSET_OUTSET_TOP_TAG = layoutConstant("BORDER_IMAGE_OFFSET_OUTSET_TOP_TAG"); // u8: BORDER_IMAGE_OUTSET_*
export const BORDER_IMAGE_OFFSET_OUTSET_RIGHT_TAG = layoutConstant("BORDER_IMAGE_OFFSET_OUTSET_RIGHT_TAG"); // u8
export const BORDER_IMAGE_OFFSET_OUTSET_BOTTOM_TAG = layoutConstant("BORDER_IMAGE_OFFSET_OUTSET_BOTTOM_TAG"); // u8
export const BORDER_IMAGE_OFFSET_OUTSET_LEFT_TAG = layoutConstant("BORDER_IMAGE_OFFSET_OUTSET_LEFT_TAG"); // u8
export const BORDER_IMAGE_OFFSET_SLICE_PERCENT = layoutConstant("BORDER_IMAGE_OFFSET_SLICE_PERCENT"); // u8: bit i set: slice i (top, right, bottom, left) is a percentage
export const BORDER_IMAGE_OFFSET_GRADIENT_KIND = layoutConstant("BORDER_IMAGE_OFFSET_GRADIENT_KIND"); // u8: 0 = image, else BG_KIND_* (bit7 = repeating)
// 0x0F pads to f32 alignment
export const BORDER_IMAGE_OFFSET_SLICE_TOP = layoutConstant("BORDER_IMAGE_OFFSET_SLICE_TOP"); // f32: image pixels, or a percentage
export const BORDER_IMAGE_OFFSET_SLICE_RIGHT = layoutConstant("BORDER_IMAGE_OFFSET_SLICE_RIGHT"); // f32
export const BORDER_IMAGE_OFFSET_SLICE_BOTTOM = layoutConstant("BORDER_IMAGE_OFFSET_SLICE_BOTTOM"); // f32
export const BORDER_IMAGE_OFFSET_SLICE_LEFT = layoutConstant("BORDER_IMAGE_OFFSET_SLICE_LEFT"); // f32
export const BORDER_IMAGE_OFFSET_WIDTH_TOP = layoutConstant("BORDER_IMAGE_OFFSET_WIDTH_TOP"); // f32: meaning per its tag
export const BORDER_IMAGE_OFFSET_WIDTH_RIGHT = layoutConstant("BORDER_IMAGE_OFFSET_WIDTH_RIGHT"); // f32
export const BORDER_IMAGE_OFFSET_WIDTH_BOTTOM = layoutConstant("BORDER_IMAGE_OFFSET_WIDTH_BOTTOM"); // f32
export const BORDER_IMAGE_OFFSET_WIDTH_LEFT = layoutConstant("BORDER_IMAGE_OFFSET_WIDTH_LEFT"); // f32
export const BORDER_IMAGE_OFFSET_OUTSET_TOP = layoutConstant("BORDER_IMAGE_OFFSET_OUTSET_TOP"); // f32: meaning per its tag
export const BORDER_IMAGE_OFFSET_OUTSET_RIGHT = layoutConstant("BORDER_IMAGE_OFFSET_OUTSET_RIGHT"); // f32
export const BORDER_IMAGE_OFFSET_OUTSET_BOTTOM = layoutConstant("BORDER_IMAGE_OFFSET_OUTSET_BOTTOM"); // f32
export const BORDER_IMAGE_OFFSET_OUTSET_LEFT = layoutConstant("BORDER_IMAGE_OFFSET_OUTSET_LEFT"); // f32
export const BORDER_IMAGE_OFFSET_GRADIENT = layoutConstant("BORDER_IMAGE_OFFSET_GRADIENT"); // GRAD_DESC_* block (entry ends at 0x70 = 112)

// border-image-repeat. NOT BG_REPEAT_*: `stretch` has no background
// counterpart, and the two enums would drift if one were made to stand in
// for the other. The mapping into $resolveBackgroundRepeatAxis happens at
// the one call site that needs it.
export const BORDER_IMAGE_REPEAT_STRETCH = layoutConstant("BORDER_IMAGE_REPEAT_STRETCH");
export const BORDER_IMAGE_REPEAT_REPEAT = layoutConstant("BORDER_IMAGE_REPEAT_REPEAT");
export const BORDER_IMAGE_REPEAT_ROUND = layoutConstant("BORDER_IMAGE_REPEAT_ROUND");
export const BORDER_IMAGE_REPEAT_SPACE = layoutConstant("BORDER_IMAGE_REPEAT_SPACE");

// border-image-width units. `auto` means "use the slice's own size",
// which is why it is a tag rather than a resolved number.
export const BORDER_IMAGE_WIDTH_LENGTH = layoutConstant("BORDER_IMAGE_WIDTH_LENGTH"); // LU
export const BORDER_IMAGE_WIDTH_PERCENT = layoutConstant("BORDER_IMAGE_WIDTH_PERCENT"); // % of the BORDER BOX (w for l/r, h for t/b)
export const BORDER_IMAGE_WIDTH_NUMBER = layoutConstant("BORDER_IMAGE_WIDTH_NUMBER"); // multiple of the corresponding border-width
export const BORDER_IMAGE_WIDTH_AUTO = layoutConstant("BORDER_IMAGE_WIDTH_AUTO"); // the slice's intrinsic size

// border-image-outset units.
export const BORDER_IMAGE_OUTSET_LENGTH = layoutConstant("BORDER_IMAGE_OUTSET_LENGTH"); // LU
export const BORDER_IMAGE_OUTSET_NUMBER = layoutConstant("BORDER_IMAGE_OUTSET_NUMBER"); // multiple of the corresponding border-width

// Animation regions are append-only. Variable-length declarations allocate
// complete immutable spans before publishing a live track. The track table,
// the effect stack table, the keyframe, transform component and linear
// easing pools and the event queue start here with the capacities below
// and move to allocated blocks when they grow
// (engine-animation-pools.watpart); hosts read their live bases from the
// engine (animation_table_base, effect_stack_table_base,
// keyframe_pool_base, animation_event_queue_base).
export const ANIMATION_TABLE_BASE = layoutConstant("ANIMATION_TABLE_BASE");
export const ANIMATION_RECORD_SIZE = layoutConstant("ANIMATION_RECORD_SIZE");
export const ANIMATION_TABLE_CAPACITY = layoutConstant("ANIMATION_TABLE_CAPACITY");
export const ANIMATION_TABLE_SIZE = layoutConstant("ANIMATION_TABLE_SIZE");
export const KEYFRAME_POOL_BASE = layoutConstant("KEYFRAME_POOL_BASE");
export const KEYFRAME_ENTRY_SIZE = layoutConstant("KEYFRAME_ENTRY_SIZE");
export const KEYFRAME_POOL_CAPACITY = layoutConstant("KEYFRAME_POOL_CAPACITY");
export const KEYFRAME_POOL_SIZE = layoutConstant("KEYFRAME_POOL_SIZE");
export const TRANSFORM_COMPONENT_POOL_BASE = layoutConstant("TRANSFORM_COMPONENT_POOL_BASE");
export const TRANSFORM_COMPONENT_ENTRY_SIZE = layoutConstant("TRANSFORM_COMPONENT_ENTRY_SIZE");
export const TRANSFORM_COMPONENT_POOL_CAPACITY = layoutConstant("TRANSFORM_COMPONENT_POOL_CAPACITY");
export const TRANSFORM_COMPONENT_POOL_SIZE = layoutConstant("TRANSFORM_COMPONENT_POOL_SIZE");
export const TRANSFORM_COMPONENT_BITMAP_BASE = layoutConstant("TRANSFORM_COMPONENT_BITMAP_BASE");
export const TRANSFORM_COMPONENT_BITMAP_SIZE = layoutConstant("TRANSFORM_COMPONENT_BITMAP_SIZE");
export const TRANSFORM_SOURCE_TABLE_BASE = layoutConstant("TRANSFORM_SOURCE_TABLE_BASE");
export const TRANSFORM_SOURCE_ENTRY_SIZE = layoutConstant("TRANSFORM_SOURCE_ENTRY_SIZE");
export const TRANSFORM_SOURCE_TABLE_CAPACITY = layoutConstant("TRANSFORM_SOURCE_TABLE_CAPACITY");
export const TRANSFORM_SOURCE_TABLE_SIZE = layoutConstant("TRANSFORM_SOURCE_TABLE_SIZE");
export const EFFECT_STACK_TABLE_BASE = layoutConstant("EFFECT_STACK_TABLE_BASE");
export const EFFECT_STACK_ENTRY_SIZE = layoutConstant("EFFECT_STACK_ENTRY_SIZE");
export const EFFECT_STACK_TABLE_CAPACITY = layoutConstant("EFFECT_STACK_TABLE_CAPACITY");
export const EFFECT_STACK_TABLE_SIZE = layoutConstant("EFFECT_STACK_TABLE_SIZE");
export const LINEAR_EASING_POOL_BASE = layoutConstant("LINEAR_EASING_POOL_BASE");
export const LINEAR_EASING_ENTRY_SIZE = layoutConstant("LINEAR_EASING_ENTRY_SIZE");
export const LINEAR_EASING_POOL_CAPACITY = layoutConstant("LINEAR_EASING_POOL_CAPACITY");
export const LINEAR_EASING_POOL_SIZE = layoutConstant("LINEAR_EASING_POOL_SIZE");
export const ANIMATION_EVENT_QUEUE_BASE = layoutConstant("ANIMATION_EVENT_QUEUE_BASE");
export const ANIMATION_EVENT_ENTRY_SIZE = layoutConstant("ANIMATION_EVENT_ENTRY_SIZE");
export const ANIMATION_EVENT_QUEUE_CAPACITY = layoutConstant("ANIMATION_EVENT_QUEUE_CAPACITY");
export const ANIMATION_EVENT_QUEUE_SIZE = layoutConstant("ANIMATION_EVENT_QUEUE_SIZE");
export const ANIMATION_RESULT_BASE = layoutConstant("ANIMATION_RESULT_BASE");
export const ANIMATION_RESULT_SIZE = layoutConstant("ANIMATION_RESULT_SIZE");
// Animated box-shadow spans: one fixed span per animation track, written
// by the engine's sample write for a box-shadow track (kind 7). The node's
// SHADOW_OFFSET is repointed at the span (as an offset from
// SHADOW_POOL_BASE, which is all the paint reads) for the track's life and
// restored from the track's base at its end. A keyframe list holds at most
// ANIMATED_SHADOW_MAX_SHADOWS shadows; the shorter list is padded with
// transparent zero shadows (css-backgrounds-3 §7.1 interpolation).
// Appended past the old FIXED_REGIONS_END, same rule as the mask pool.
export const ANIMATED_SHADOW_MAX_SHADOWS = layoutConstant("ANIMATED_SHADOW_MAX_SHADOWS");
export const ANIMATED_SHADOW_SPAN_SIZE = layoutConstant("ANIMATED_SHADOW_SPAN_SIZE");
export const ANIMATED_SHADOW_POOL_BASE = layoutConstant("ANIMATED_SHADOW_POOL_BASE");
export const ANIMATED_SHADOW_POOL_SIZE = layoutConstant("ANIMATED_SHADOW_POOL_SIZE"); // 320 B x 256 tracks = 0x14000

// Grid sizing-function entries. Each endpoint carries a primary f32 and a
// percentage companion so calc(<length> + <percentage>) survives to the axis
// basis used by layout. Pure values retain their existing tags and primary
// representation; their percentage companions are zero.
export const GRID_TRACK_POOL_BASE = layoutConstant("GRID_TRACK_POOL_BASE");
export const GRID_TRACK_POOL_SIZE = layoutConstant("GRID_TRACK_POOL_SIZE");
export const GRID_TRACK_ENTRY_SIZE = layoutConstant("GRID_TRACK_ENTRY_SIZE");
export const GRID_TRACK_OFFSET_MIN_TYPE = layoutConstant("GRID_TRACK_MIN_TYPE");
export const GRID_TRACK_OFFSET_MAX_TYPE = layoutConstant("GRID_TRACK_MAX_TYPE");
// An auto-fill or auto-fit marker entry's u16 pattern length.
export const GRID_TRACK_OFFSET_REPEAT_LENGTH = layoutConstant("GRID_TRACK_REPEAT_LENGTH");
export const GRID_TRACK_OFFSET_MIN_VALUE = layoutConstant("GRID_TRACK_MIN_VALUE");
export const GRID_TRACK_OFFSET_MAX_VALUE = layoutConstant("GRID_TRACK_MAX_VALUE");
export const GRID_TRACK_OFFSET_MIN_PERCENTAGE = layoutConstant("GRID_TRACK_MIN_PERCENTAGE");
export const GRID_TRACK_OFFSET_MAX_PERCENTAGE = layoutConstant("GRID_TRACK_MAX_PERCENTAGE");
// The grid implementation limit (CSS Grid 2 §5.4): the tracks an explicit
// grid keeps, and the line indices -GRID_LINE_LIMIT to GRID_LINE_LIMIT
// from its first line that an axis keeps.
export const GRID_LINE_LIMIT = layoutConstant("GRID_LINE_LIMIT");
// The grid layout scratch: a stack of the arrays of the grids being laid
// out, in this region while they fit and in allocated blocks past it.
export const GRID_SCRATCH_BASE = layoutConstant("GRID_SCRATCH_BASE");
export const GRID_SCRATCH_SIZE = layoutConstant("GRID_SCRATCH_SIZE");

// The INITIAL table scratch map. $layout sizes every nesting level's slice
// for the largest table of each scene ($tableScratchEnsure in
// engine-block-grid.watpart) and moves the stack into an allocated block
// when a slice outgrows TABLE_SCRATCH_LEVEL_SIZE; levels from
// TABLE_SCRATCH_LEVELS on get slices of their own. The build's memory map
// check reads the initial base and size.
export const TABLE_SCRATCH_BASE = layoutConstant("TABLE_SCRATCH_BASE");
export const TABLE_SCRATCH_SIZE = layoutConstant("TABLE_SCRATCH_SIZE");
export const TABLE_SCRATCH_LEVEL_SIZE = layoutConstant("TABLE_SCRATCH_LEVEL_SIZE");
export const TABLE_SCRATCH_LEVELS = layoutConstant("TABLE_SCRATCH_LEVELS");
// Node-indexed geometry/cache regions are contiguous after INLINE_STATE_SCRATCH.
// Each covers all 2251 layout records; the former 819-row table-grid slot is free.
export const TABLE_GRID_BOX_BASE = layoutConstant("TABLE_GRID_BOX_BASE");
export const TABLE_GRID_BOX_SIZE = layoutConstant("TABLE_GRID_BOX_SIZE");
export const TABLE_GRID_BOX_ENTRY_SIZE = layoutConstant("TABLE_GRID_BOX_ENTRY_SIZE");
// A box that is not a table (DISPLAY_TABLE or DISPLAY_INLINE_TABLE) holds
// its multi-column record in its table-grid slot instead: a fragmented
// box's fragment count (0 when the box is not fragmented) and the
// addresses of its first and last fragment entries; a multi-column
// container's first row entry (engine-multicolumn.watpart).
export const MULTICOLUMN_RECORD_OFFSET_FRAGMENT_COUNT = layoutConstant("MULTICOLUMN_RECORD_FRAGMENT_COUNT");
export const MULTICOLUMN_RECORD_OFFSET_FIRST_FRAGMENT = layoutConstant("MULTICOLUMN_RECORD_FIRST_FRAGMENT");
export const MULTICOLUMN_RECORD_OFFSET_LAST_FRAGMENT = layoutConstant("MULTICOLUMN_RECORD_LAST_FRAGMENT");
export const MULTICOLUMN_RECORD_OFFSET_FIRST_ROW = layoutConstant("MULTICOLUMN_RECORD_FIRST_ROW");
// The entries the multi-column records address, in the old inline state
// scratch hole. Each entry holds the address of the next entry (0 ends
// the list), then four i32 LayoutUnits: a fragment's border box relative
// to its box's union border box, or a column row's top and bottom below
// the container's content box top and its last column. The pool persists
// across layout() calls and flips with the line pools at layout() entry
// once past its midpoint; a pass that needs more entries throws (trap
// site 14). 20 B x 4096 entries.
export const MULTICOLUMN_FRAGMENT_POOL_BASE = layoutConstant("MULTICOLUMN_FRAGMENT_POOL_BASE");
export const MULTICOLUMN_FRAGMENT_POOL_SIZE = layoutConstant("MULTICOLUMN_FRAGMENT_POOL_SIZE");
export const MULTICOLUMN_ENTRY_SIZE = layoutConstant("MULTICOLUMN_ENTRY_SIZE");
export const MULTICOLUMN_ENTRY_OFFSET_NEXT = layoutConstant("MULTICOLUMN_ENTRY_NEXT");
export const MULTICOLUMN_ENTRY_OFFSET_FRAGMENT_X = layoutConstant("MULTICOLUMN_ENTRY_FRAGMENT_X");
export const MULTICOLUMN_ENTRY_OFFSET_FRAGMENT_Y = layoutConstant("MULTICOLUMN_ENTRY_FRAGMENT_Y");
export const MULTICOLUMN_ENTRY_OFFSET_FRAGMENT_WIDTH = layoutConstant("MULTICOLUMN_ENTRY_FRAGMENT_WIDTH");
export const MULTICOLUMN_ENTRY_OFFSET_FRAGMENT_HEIGHT = layoutConstant("MULTICOLUMN_ENTRY_FRAGMENT_HEIGHT");
export const MULTICOLUMN_ENTRY_OFFSET_ROW_TOP = layoutConstant("MULTICOLUMN_ENTRY_ROW_TOP");
export const MULTICOLUMN_ENTRY_OFFSET_ROW_BOTTOM = layoutConstant("MULTICOLUMN_ENTRY_ROW_BOTTOM");
export const MULTICOLUMN_ENTRY_OFFSET_ROW_LAST_COLUMN = layoutConstant("MULTICOLUMN_ENTRY_ROW_LAST_COLUMN");
// D1 piece 2: pristine layout-space geometry. layout() snapshots the
// computed-box records and the table-grid boxes right after the layout
// recursion, BEFORE the root margin shift, scroll translation, and sticky
// clamping mutate them in place. A layout-cache hit restores its subtree's
// geometry from this snapshot, and the post-passes then re-run over the
// whole tree each pass — no gating, no double-apply.
export const PRISTINE_BOX_BUFFER_BASE = layoutConstant("PRISTINE_BOX_BUFFER_BASE");
export const PRISTINE_BOX_BUFFER_SIZE = layoutConstant("PRISTINE_BOX_BUFFER_SIZE"); // 2251 × BOX_SIZE
export const PRISTINE_TABLE_GRID_BOX_BASE = layoutConstant("PRISTINE_TABLE_GRID_BOX_BASE");
export const PRISTINE_TABLE_GRID_BOX_SIZE = layoutConstant("PRISTINE_TABLE_GRID_BOX_SIZE");
// D1 piece 3: the layout cache. SUBTREE_INFO holds one bottom-up record
// per node, rebuilt at every layout() entry: the subtree's max changedGen,
// its highest node index (subtrees are NOT contiguous index ranges —
// grandchild blocks interleave), an eligibility flag (the node's own call
// may hit: its subtree is restorable and it is not a table-internal box,
// which table layout adjusts after the box's own call returns), and a
// restorable flag (every collapsed table below still has its pristine
// grid-line positions at the address the collapsed arena gives it now).
// LAYOUT_CACHE holds one record per node: the constraint-space key of the
// node's MOST RECENT eligible fresh-site layout, the generations it was
// stored under, and the margin-report outputs to replay on a hit. Reserved
// bytes 0x64..0x6B retain the return-time border-box x/y in LayoutUnits.
// A hit restores the pristine subtree and rebases it to that origin:
// ancestors may have translated the end-of-pass snapshot after this
// node's layout returned. Parent placement must not accumulate on reuse.
// Any non-eligible layout of the node invalidates its record.
// MathML box results (docs/design/mathml-layout.md): one entry per
// layout node, written by the engine math layout for every math box. Ascent
// is the baseline offset from the border-box top and italic correction the
// MATH table value of a stretched operator, both i32 LayoutUnits. An
// operator with special shaping (Blink's MathOperatorLayoutAlgorithm) keeps
// the stretch target its glyph was shaped for, so paint shapes it again.
// The region follows FONT_STACK_TABLE in the old text-line pool hole (see
// TEXT_LINE_POOL_BASE).
export const MATH_BOX_BASE = layoutConstant("MATH_BOX_BASE");
export const MATH_BOX_SIZE = layoutConstant("MATH_BOX_SIZE");
export const MATH_BOX_ENTRY_SIZE = layoutConstant("MATH_BOX_ENTRY_SIZE");
export const MATH_BOX_OFFSET_ASCENT = layoutConstant("MATH_BOX_OFFSET_ASCENT"); // i32 LayoutUnits
export const MATH_BOX_OFFSET_ITALIC_CORRECTION = layoutConstant("MATH_BOX_OFFSET_ITALIC_CORRECTION"); // i32 LayoutUnits
// u32: 1 laid out by math layout this pass, 2 an operator the math painter
// paints, 4 its stretch axis is inline (horizontal)
export const MATH_BOX_OFFSET_FLAGS = layoutConstant("MATH_BOX_OFFSET_FLAGS");
export const MATH_BOX_OFFSET_OPERATOR_TARGET = layoutConstant("MATH_BOX_OFFSET_OPERATOR_TARGET"); // i32 LayoutUnits
export const SUBTREE_INFO_BASE = layoutConstant("SUBTREE_INFO_BASE");
export const SUBTREE_INFO_SIZE = layoutConstant("SUBTREE_INFO_SIZE");
export const SUBTREE_INFO_ENTRY_SIZE = layoutConstant("SUBTREE_INFO_ENTRY_SIZE");
export const LAYOUT_CACHE_BASE = layoutConstant("LAYOUT_CACHE_BASE");
export const LAYOUT_CACHE_SIZE = layoutConstant("LAYOUT_CACHE_SIZE");
export const LAYOUT_CACHE_ENTRY_SIZE = layoutConstant("LAYOUT_CACHE_ENTRY_SIZE");
// D2 piece A: engine-derived tile dirty. emit_commands ends by comparing
// every node's painted (post-post-pass) box against the previous frame's
// copy here, and marks old-box ∪ new-box tiles dirty for every node whose
// box moved or whose changedGen advanced past the last painted
// generation. This is the engine-side replacement for session.js's
// spec-rect marking and the DOM render surface's second-layout box diff
// (both deleted at the D3 cutover). Border-box semantics, matching the
// JS diff it replaces; transformed ink beyond the box keeps the same
// (pre-existing) box-granularity contract.
export const PREV_PAINTED_BOX_BASE = layoutConstant("PREV_PAINTED_BOX_BASE");
export const PREV_PAINTED_BOX_SIZE = layoutConstant("PREV_PAINTED_BOX_SIZE");
// D2 piece B: the per-frame scroll table of CUMULATIVE device-px offsets
// (f32 dx, f32 dy - the sum of active ancestor scopes, including this
// one). Entry 0 belongs to the root/no-scroller state and stays zero;
// entry node + 1 is a scroll container's CMD_SET_SCROLL scope, resolved
// by containing block (absolute subtrees can adopt their containing
// block's outer scope; fixed subtrees adopt the zero scope); the entries
// from node count + 1 on are sticky scopes, one per sticky node in the
// order the full walk opens them. Two entries per node and the reserved
// one. Rewritten every emit; a scroll-only frame changes ONLY this table,
// never command bytes.
export const SCROLL_TABLE_BASE = layoutConstant("SCROLL_TABLE_BASE");
export const SCROLL_TABLE_ENTRY_SIZE = layoutConstant("SCROLL_TABLE_ENTRY_SIZE");
export const SCROLL_TABLE_SIZE = layoutConstant("SCROLL_TABLE_SIZE"); // 2 × 2251 nodes + reserved entry 0
// Separate regions: never borrow live scroll-table rows for emission history,
// nesting scratch, or scope flags. SCROLL_LAST_EMITTED follows
// PREV_PAINTED_BOX, and the save stack follows it.
export const SCROLL_LAST_EMITTED_BASE = layoutConstant("SCROLL_LAST_EMITTED_BASE");
export const SCROLL_LAST_EMITTED_SIZE = layoutConstant("SCROLL_LAST_EMITTED_SIZE");
// The paint walk's save stack: each frame holds the in-flow, absolute and
// fixed scroll tiers and the absolute and fixed clip tiers
// ($pushScrollSave). A frame past the reserved 512 lies in an allocated
// block that grows; an allocator refusal traps with site 29.
export const SCROLL_SAVE_STACK_BASE = layoutConstant("SCROLL_SAVE_STACK_BASE");
export const SCROLL_SAVE_STACK_SIZE = layoutConstant("SCROLL_SAVE_STACK_SIZE"); // 512 × 52-byte frames
export const SCROLL_SCOPE_FLAGS_BASE = layoutConstant("SCROLL_SCOPE_FLAGS_BASE");
export const SCROLL_SCOPE_FLAGS_SIZE = layoutConstant("SCROLL_SCOPE_FLAGS_SIZE");
// The repacked tail and collapsed arena remain within the same reservation.
export const FIXED_REGIONS_END = layoutConstant("FIXED_REGIONS_END");
export const ACTUAL_INITIAL_PAGES = layoutConstant("ACTUAL_INITIAL_PAGES"); // includes the maximum checked collapsed-edge arena
// The collapsed-border arena starts exactly at FIXED_REGIONS_END and
// grows upward into the 804-page reservation. Metadata and original borders
// cover all layout nodes before edge storage begins. It sits OUTSIDE the fixed region
// map on purpose; the engine global is its one source, so a drift between
// two copies cannot recur. Before 2026-08-31 the
// engine's base was a stale 0x004CE640 — inside the mask-layer,
// gradient-scratch, background-layer, and border-image pools that were
// appended over that address later — so every layout pass corrupted
// BG_LAYER_POOL from node index 52 on (found from the Sandtable loop:
// a gradient background plus ~25 text runs trapped emit_commands with
// "float unrepresentable in integer range").
export const COLLAPSED_ARENA_BASE = layoutConstant("COLLAPSED_ARENA_BASE");
export const COLLAPSED_META_SIZE = layoutConstant("COLLAPSED_META_SIZE");
export const COLLAPSED_ORIGINAL_BASE = layoutConstant("COLLAPSED_ORIGINAL_BASE"); // arena-relative
export const COLLAPSED_ORIGINAL_SIZE = layoutConstant("COLLAPSED_ORIGINAL_SIZE");
export const COLLAPSED_ORIGINAL_STRIDE = layoutConstant("COLLAPSED_ORIGINAL_STRIDE");
export const COLLAPSED_EDGE_START = layoutConstant("COLLAPSED_EDGE_START");
export const LAYOUT_RESERVATION_END = layoutConstant("LAYOUT_RESERVATION_END");
// Shared-memory sizing (plans/PLAN-safari-browser-support.md): HarfBuzz is
// linked with GLOBAL_BASE at ACTUAL_INITIAL_PAGES × 64 KB and its static
// data + stack occupy the pages above the layout reservation, so the ONE
// shared memory must start at hb.wasm's linked INITIAL_MEMORY (864 pages,
// -sINITIAL_MEMORY=56623104). Instantiation fails below this.
export const HB_INITIAL_PAGES = layoutConstant("HB_INITIAL_PAGES");
// The DOM core's static data begins where HarfBuzz's region ends (page 864,
// 0x03600000) and its heap at page 880; the shared memory starts at 944
// pages so the heap has four megabytes before the allocator first grows it.
export const DOM_BASE_PAGES = layoutConstant("DOM_BASE_PAGES");
export const DOM_INITIAL_PAGES = layoutConstant("DOM_INITIAL_PAGES");

// Sparse paint transactions publish changed command ranges through getters;
// their private row/range allocations do not occupy fixed-map addresses.
export const RETAINED_FRAME_ABI_VERSION = layoutConstant("RETAINED_FRAME_ABI_VERSION");
