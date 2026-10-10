// Memory layout — the contract between JS and WASM.
//
// Sandom uses a single shared WebAssembly.Memory. JS creates it and
// passes it to the WAT module as an import. Both sides read and write
// specific regions; this file defines where each region lives.
//
// The WAT module exports getter functions for every layout constant.
// At init time, the JS loader reads all of them and verifyLayout()
// compares against the constants in this file. If any disagree, the
// module throws — a layout drift means JS and WASM are looking at
// different addresses, which silently corrupts data.
//
// Adding/changing a layout value:
//   1. Edit engine.wat — update the global, add/update the export.
//   2. Edit this file — update the mirror constant.
//   3. Build (tools/build-wasm.js) and run tests; verifyLayout catches
//      any mismatch.

// =======================================================================
// Page budget
// =======================================================================
//
// Initial: 16 pages = 1 MB. Enough for moderate documents.
// Maximum: 4096 pages = 256 MB. Room for large DOMs with many elements.
//
// The layout buffer and command buffer can grow by bumping into the
// growable region. memory.grow extends the WASM memory when needed.

export const INITIAL_PAGES = 16;
// One shared memory for engine, HarfBuzz and DOM core (design/memory-map.md).
// Every address the DOM allocator hands out stays below 2^31 at this maximum.
export const MAX_PAGES = 32768;

// =======================================================================
// Header (64 bytes at 0x0)
// =======================================================================
//
// Magic number, version, and global state.

export const HEADER_BASE = 0x00000000;
export const HEADER_SIZE = 0x00000040;

export const HEADER_OFFSET_MAGIC = 0x00; // u32: 0x53444D00 "SDM\0"
export const HEADER_OFFSET_VERSION = 0x04; // u32: layout version
export const HEADER_OFFSET_FLAGS = 0x08; // u32: global flags
export const HEADER_OFFSET_GENERATION = 0x0C; // u32: current change-tracking
// generation (see design/layout-engine.md). engine.wat owns advancement for
// JavaScript mutations and WebAssembly animation ticks. Ordinary advances are
// O(1). Before wrap, the engine starts a fresh nonzero epoch and invalidates
// every generation-keyed cache. Generation 0 means "never computed".

export const MAGIC = 0x53444D00; // "SDM\0" little-endian
export const VERSION = 1;

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

export const TILE_DIRTY_MAP_BASE = 0x00000040;
export const TILE_DIRTY_MAP_SIZE = 0x00000400; // 1 KB

// Tile grid parameters — written by JS at init, read by WASM.
// Stored right after the dirty map.

export const TILE_CONFIG_BASE = 0x00000440;
export const TILE_CONFIG_SIZE = 0x00000020; // 32 bytes

export const TILE_CONFIG_OFFSET_TILE_SIZE = 0x00; // u32: pixels per tile side (64 or 128)
export const TILE_CONFIG_OFFSET_COLUMNS = 0x04; // u32: tiles across
export const TILE_CONFIG_OFFSET_ROWS = 0x08; // u32: tiles down
export const TILE_CONFIG_OFFSET_FRAME_WIDTH = 0x0C; // u32: framebuffer width in pixels
export const TILE_CONFIG_OFFSET_FRAME_HEIGHT = 0x10; // u32: framebuffer height in pixels

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

export const INTERNAL_STACKS_BASE = 0x00000460;
export const INTERNAL_STACKS_SIZE = 0x00001000; // 4 KB

export const WALK_STACK_BASE = 0x00000460;
export const WALK_STACK_SIZE = 0x00001000; // 4 KB, 256 entries × 16 bytes
export const WALK_STACK_ENTRY = 16;
export const WALK_STACK_MAX = 256;

// (The pre-P1 CLIP_STACK region that used to live at 0x1460 — 24-byte
// single-radius entries — was dead weight: nothing but its own export ever
// referenced it. Deleted by the oriented-clip redesign; clip state now
// lives in CLIP_ARENA, see its section near the end of the fixed regions.
// The 768-byte hole at 0x1460 is left unassigned rather than shifting
// every later region for no benefit.)

export const OPACITY_STACK_BASE = 0x00001760;
export const OPACITY_STACK_SIZE = 0x00000380; // 896 bytes, 32 entries × 28 bytes
export const OPACITY_STACK_ENTRY = 28;
export const OPACITY_STACK_MAX = 32;

export const TRANSFORM_SCRATCH_BASE = 0x00001AE0;
export const TRANSFORM_SCRATCH_SIZE = 0x00000060; // 96 bytes, 4 × 24 bytes

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

export const BATCH_DESCRIPTORS_BASE = 0x00001B40;
export const BATCH_DESCRIPTORS_SIZE = 0x00001000; // 4 KB
export const BATCH_DESCRIPTOR_ENTRY = 12;
export const BATCH_DESCRIPTOR_MAX = 340;

export const BATCH_OFFSET_TYPE = 0x00; // u8: command type (opcode)
export const BATCH_OFFSET_COMMAND_START = 0x04; // u32: byte offset into command buffer
export const BATCH_OFFSET_COMMAND_COUNT = 0x08; // u32: number of commands in batch

// =======================================================================
// Layout buffer (2,228 fixed-size records at 0x2B40 initially; grows)
// =======================================================================
//
// The serialized DOM tree. Written by JS, read by WASM.
// Each node is a fixed-size record (see LAYOUT_NODE_* constants below).
// The buffer is a flat array of nodes in depth-first pre-order.
//
// This region is the INITIAL map only (2,228 records; the node-indexed side
// tables below hold 2,251 rows, more than the buffer). A scene with more
// nodes makes the engine move this buffer and every node-indexed side
// table (computed, pristine, table-grid and previous painted boxes,
// subtree info, layout cache, scroll table, emission history, scope
// flags, scroll data, the collapsed-border arena) into one block from
// the shared allocator, at least doubling (engine.wat
// node_tables_reserve). Hosts read the live bases from the engine
// (layout_buffer_base() and the other accessors) after every reservation.
// The composed engine synchronizes DOM table addresses natively; these
// constants describe the map verifyLayout checks at load, never a live address.
export const LAYOUT_BUFFER_BASE = 0x00002B40;
export const LAYOUT_BUFFER_SIZE = 0x001A1C60; // 2,228 nodes * 768 B (initial)

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
export const LAYOUT_NODE_SIZE = 768;

export const LAYOUT_NODE_OFFSET_CHILD_OFFSET = 0x00; // u32: byte offset to first child
export const LAYOUT_NODE_OFFSET_CHILD_COUNT = 0x04; // u16: number of children
export const LAYOUT_NODE_OFFSET_FLAGS = 0x06; // u16: bitfield (see below)

export const LAYOUT_NODE_OFFSET_DISPLAY = 0x08; // u8: 0=block, 1=none
export const LAYOUT_NODE_OFFSET_BOX_SIZING = 0x09; // u8: 0=content-box, 1=border-box
export const LAYOUT_NODE_OFFSET_WIDTH_TAG = 0x0A; // u8: 0=auto,1=length,2=percent
export const LAYOUT_NODE_OFFSET_HEIGHT_TAG = 0x0B; // u8
export const LAYOUT_NODE_OFFSET_MIN_W_TAG = 0x0C; // u8: 0=zero,1=length,2=percent
export const LAYOUT_NODE_OFFSET_MIN_H_TAG = 0x0D; // u8
export const LAYOUT_NODE_OFFSET_MAX_W_TAG = 0x0E; // u8: 0=none,1=length,2=percent
export const LAYOUT_NODE_OFFSET_MAX_H_TAG = 0x0F; // u8

export const LAYOUT_NODE_OFFSET_WIDTH = 0x10; // f32: requested width value
export const LAYOUT_NODE_OFFSET_HEIGHT = 0x14; // f32: requested height value
export const LAYOUT_NODE_OFFSET_MIN_WIDTH = 0x18; // f32
export const LAYOUT_NODE_OFFSET_MIN_HEIGHT = 0x1C; // f32
export const LAYOUT_NODE_OFFSET_MAX_WIDTH = 0x20; // f32
export const LAYOUT_NODE_OFFSET_MAX_HEIGHT = 0x24; // f32

export const LAYOUT_NODE_OFFSET_MARGIN_TOP = 0x28; // f32
export const LAYOUT_NODE_OFFSET_MARGIN_RIGHT = 0x2C; // f32
export const LAYOUT_NODE_OFFSET_MARGIN_BOTTOM = 0x30; // f32
export const LAYOUT_NODE_OFFSET_MARGIN_LEFT = 0x34; // f32

export const LAYOUT_NODE_OFFSET_PADDING_TOP = 0x38; // f32
export const LAYOUT_NODE_OFFSET_PADDING_RIGHT = 0x3C; // f32
export const LAYOUT_NODE_OFFSET_PADDING_BOTTOM = 0x40; // f32
export const LAYOUT_NODE_OFFSET_PADDING_LEFT = 0x44; // f32
export const LAYOUT_NODE_OFFSET_BORDER_TOP = 0x48; // f32
export const LAYOUT_NODE_OFFSET_BORDER_RIGHT = 0x4C; // f32
export const LAYOUT_NODE_OFFSET_BORDER_BOTTOM = 0x50; // f32
export const LAYOUT_NODE_OFFSET_BORDER_LEFT = 0x54; // f32
export const LAYOUT_NODE_OFFSET_BG_COLOR = 0x58; // f32[4]: rgba
// Border colors, one rgba PER SIDE (Slice P2). A uniform border stores the
// same color in all four slots — the engine and rasterizer only ever read
// the per-side form; the scene-spec's single-color sugar is normalized in
// each writeNode.
export const LAYOUT_NODE_OFFSET_BORDER_COLOR_TOP = 0x68; // f32[4]: rgba
export const LAYOUT_NODE_OFFSET_BORDER_COLOR_RIGHT = 0x78; // f32[4]: rgba
export const LAYOUT_NODE_OFFSET_BORDER_COLOR_BOTTOM = 0x88; // f32[4]: rgba
export const LAYOUT_NODE_OFFSET_BORDER_COLOR_LEFT = 0x98; // f32[4]: rgba
// Border radii, one PER CORNER in CSS order (Slice P2); uniform radius is
// normalized to four equal slots in writeNode, same as colors.
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT = 0xA8; // f32
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_RIGHT = 0xAC; // f32
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_RIGHT = 0xB0; // f32
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_LEFT = 0xB4; // f32
export const LAYOUT_NODE_OFFSET_OPACITY = 0xB8; // f32
export const LAYOUT_NODE_OFFSET_TRANSFORM = 0xBC; // f32[6]: affine [a,b,c,d,e,f]
// 0xBC..0xD4 = 24 bytes → ends at 0xD4 = 212

// Positioning (CSS 2.1 §9.3). position + four insets (tagged like sizes:
// 0=auto, 1=length, 2=percent). Absolute boxes are out of normal flow.
export const LAYOUT_NODE_OFFSET_POSITION = 0xD4; // u8: 0=static,1=relative,2=absolute
export const LAYOUT_NODE_OFFSET_INSET_TOP_TAG = 0xD5; // u8
export const LAYOUT_NODE_OFFSET_INSET_RIGHT_TAG = 0xD6; // u8
export const LAYOUT_NODE_OFFSET_INSET_BOTTOM_TAG = 0xD7; // u8
export const LAYOUT_NODE_OFFSET_INSET_LEFT_TAG = 0xD8; // u8
// 0xD9 holds COLUMN_SPAN (declared with the multi-column fields below);
// 0xDA holds NATIVE_APPEARANCE (declared with COLUMN_SPAN); 0xDB holds
// EMPTY_CELLS (declared with the table fields).
export const LAYOUT_NODE_OFFSET_INSET_TOP = 0xDC; // f32
export const LAYOUT_NODE_OFFSET_INSET_RIGHT = 0xE0; // f32
export const LAYOUT_NODE_OFFSET_INSET_BOTTOM = 0xE4; // f32
export const LAYOUT_NODE_OFFSET_INSET_LEFT = 0xE8; // f32
// style fields end at 0xEC = 236
// Flex (CSS Flexbox §9, Slice 5). Container fields (flex-direction/justify/
// align-items/wrap/gaps) apply when display:flex; item fields (grow/shrink/
// basis/align-self) apply to a flex container's children. All in one block so a
// node can be both (a flex item that is itself a flex container). These are
// STYLE, so they sit BEFORE changedGen (which must be the last field — see
// below — so write-if-changed's [0, CHANGED_GEN) range covers all style).
export const LAYOUT_NODE_OFFSET_FLEX_DIRECTION = 0xEC; // u8: 0=row,1=row-reverse,2=column,3=column-reverse
export const LAYOUT_NODE_OFFSET_JUSTIFY_CONTENT = 0xED; // u8 (see JUSTIFY_*)
export const LAYOUT_NODE_OFFSET_ALIGN_ITEMS = 0xEE; // u8 (see ALIGN_*)
export const LAYOUT_NODE_OFFSET_FLEX_WRAP = 0xEF; // u8: 0=nowrap,1=wrap
export const LAYOUT_NODE_OFFSET_ALIGN_SELF = 0xF0; // u8: 0=auto (use parent align-items), else ALIGN_*+1
export const LAYOUT_NODE_OFFSET_FLEX_BASIS_TAG = 0xF1; // u8: 0=auto,1=length,2=percent
// margin-*: auto, one bit per edge. `auto` margins are a LAYOUT input, not a
// length: the block axis needs them for flex §8.1 (cross-axis auto margins
// absorb free space and override align-self) exactly as the inline axis
// needs them for block centring, and FLAGS' 16 bits are all spoken for — so
// all four edges live in this one byte, in CSS edge order. The f32 margin
// value of an auto edge is 0 (writer convention); consumers that distribute
// free space read this mask.
export const LAYOUT_NODE_OFFSET_MARGIN_AUTO = 0xF2; // u8 bitmask (see MARGIN_AUTO_*)
// Where a box came from in the flow, for an out-of-flow box's static
// position (css-position 3 §3.5; Blink's PlaceOutOfFlowObjects): an
// anonymous block run (the block holding a container's inline content
// beside its blocks), and an out-of-flow box whose display was
// inline-level before blockification. Such a box sits in the last line
// of the run before it, at the line's top and after its content; a
// block-level one sits below the run. Before CHANGED_GEN, so the
// write-if-changed diff compares it with the other style bytes.
export const LAYOUT_NODE_OFFSET_FLOW_ORIGIN = 0xF3; // u8: FLOW_ORIGIN_* bits
export const FLOW_ORIGIN_ANONYMOUS_RUN = 0x01;
export const FLOW_ORIGIN_INLINE_LEVEL = 0x02;
// content-visibility: hidden (CSS Contain 2, 4.1) on a box that size
// containment applies to. The engine sizes the box as if it had no
// contents: its auto block size and its intrinsic inline sizes take none,
// and its contents add nothing to its scrollable overflow. The contents
// still lay out, so their geometry stays readable; the core writes their
// records visibility: hidden, so they paint nothing. Shares the
// FLOW_ORIGIN byte.
export const LAYOUT_NODE_OFFSET_CONTAINMENT = 0xF3; // u8 bit 2, aliases FLOW_ORIGIN
export const CONTAINMENT_CONTENT_HIDDEN = 0x04;
export const LAYOUT_NODE_OFFSET_FLEX_GROW = 0xF4; // f32
export const LAYOUT_NODE_OFFSET_FLEX_SHRINK = 0xF8; // f32
export const LAYOUT_NODE_OFFSET_FLEX_BASIS = 0xFC; // f32
export const LAYOUT_NODE_OFFSET_ROW_GAP = 0x100; // f32
export const LAYOUT_NODE_OFFSET_COLUMN_GAP = 0x104; // f32
// flex ends at 0x108 = 264

// Text (Slice 6). Applies when display:DISPLAY_TEXT. fontIndex/fontWeight/
// fontStyle mirror CMD_TEXT's paint-time fields (same enums); fontSize is
// the used px size (WAT sets HarfBuzz's scale from this via
// hb_font_set_scale at shape time). lineHeight is tagged like width/height
// (0=normal, 1=length px, 2=number ×fontSize). textAlign applies within
// each line box. These are STYLE, so — like flex — they sit BEFORE
// changedGen.
export const LAYOUT_NODE_OFFSET_FONT_INDEX = 0x108; // u16
export const LAYOUT_NODE_OFFSET_FONT_WEIGHT = 0x10A; // u8
export const LAYOUT_NODE_OFFSET_FONT_STYLE = 0x10B; // u8: 0=normal, 1=italic
export const LAYOUT_NODE_OFFSET_FONT_SIZE = 0x10C; // f32
export const LAYOUT_NODE_OFFSET_LINE_HEIGHT_TAG = 0x110; // u8: 0=normal,1=length,2=number
export const LAYOUT_NODE_OFFSET_TEXT_ALIGN = 0x111; // u8: 0=left,1=center,2=right
// Which animatable inherited fields this node took from its parent
// (design/animations.md, "Inherited properties"). The animation tick
// propagates a sampled value into descendants whose bit is set and
// stops at one whose bit is clear. Scene-spec writers leave it zero.
export const LAYOUT_NODE_OFFSET_INHERITED_MASK = 0x112; // u8 bitmask (see INHERITED_MASK_*)
// A DISPLAY_TEXT node that is a list item's ::marker. Zero for every other
// node. Bits 0-2 are the marker style (LIST_MARKER_DISC/CIRCLE/SQUARE paint
// Chrome's geometric symbol instead of glyphs, LIST_MARKER_DISCLOSURE_CLOSED/
// OPEN its disclosure triangle; LIST_MARKER_COUNTER is text such as "3. ");
// LIST_MARKER_OUTSIDE marks list-style-position: outside,
// which takes the marker out of its list item's flow: the list item places
// it beside its first line.
export const LAYOUT_NODE_OFFSET_LIST_MARKER = 0x113; // u8
export const LIST_MARKER_STYLE_MASK = 0x07;
export const LIST_MARKER_DISC = 1;
export const LIST_MARKER_CIRCLE = 2;
export const LIST_MARKER_SQUARE = 3;
export const LIST_MARKER_COUNTER = 4;
export const LIST_MARKER_DISCLOSURE_CLOSED = 5;
export const LIST_MARKER_DISCLOSURE_OPEN = 6;
export const LIST_MARKER_OUTSIDE = 0x08;
export const LAYOUT_NODE_OFFSET_LINE_HEIGHT = 0x114; // f32 (length px or ×fontSize number)
export const LAYOUT_NODE_OFFSET_TEXT_COLOR = 0x118; // f32[4] (rgba) — CMD_TEXT's fill color
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

export const LAYOUT_NODE_OFFSET_HAS_Z = 0x128; // u8 (moved from old pad-gap 0xF2; Slice 7B)
export const LAYOUT_NODE_OFFSET_BLEND_MODE = 0x129; // u8: BLEND_* enum, 0=normal (moved; Slice 8C)
export const LAYOUT_NODE_OFFSET_VISIBILITY_HIDDEN = 0x12A; // u8: 0=visible,1=hidden (design/paint-coverage.md P10)
export const LAYOUT_NODE_OFFSET_IMAGE_RENDERING_PIXELATED = 0x12B; // u8: 0=auto,1=pixelated (P10)

export const LAYOUT_NODE_OFFSET_Z_INDEX = 0x12C; // i32 (signed) — moved from old 0x128

export const LAYOUT_NODE_OFFSET_BORDER_STYLE_TOP = 0x130; // u8: BORDER_STYLE_* enum (P7)
export const LAYOUT_NODE_OFFSET_BORDER_STYLE_RIGHT = 0x131; // u8 (P7)
export const LAYOUT_NODE_OFFSET_BORDER_STYLE_BOTTOM = 0x132; // u8 (P7)
export const LAYOUT_NODE_OFFSET_BORDER_STYLE_LEFT = 0x133; // u8 (P7)

// border-style values (P7). SOLID = 0 so a zeroed struct keeps the
// pre-P7 behavior (every border painted solid). Values fit 4 bits —
// CMD_RECT packs the four sides as nibbles, see
// CMD_RECT_OFFSET_BORDER_STYLES.
export const BORDER_STYLE_SOLID = 0;
export const BORDER_STYLE_DOUBLE = 1;
export const BORDER_STYLE_DASHED = 2;
export const BORDER_STYLE_DOTTED = 3;
export const BORDER_STYLE_INSET = 4;
export const BORDER_STYLE_OUTSET = 5;
export const BORDER_STYLE_GROOVE = 6;
export const BORDER_STYLE_RIDGE = 7;
export const BORDER_STYLE_NONE = 8;
export const BORDER_STYLE_HIDDEN = 9;
export const LAYOUT_NODE_OFFSET_BACKGROUND_CLIP = 0x134; // u8: 0=border-box,1=padding-box,2=content-box (P10)
export const LAYOUT_NODE_OFFSET_ISOLATION_ISOLATE = 0x135; // u8: 0=auto,1=isolate (P10)
export const LAYOUT_NODE_OFFSET_FLOAT = 0x136; // u8: 0=none,1=left,2=right (design/floats.md)
export const LAYOUT_NODE_OFFSET_CLEAR = 0x137; // u8: 0=none,1=left,2=right,3=both (design/floats.md)

// float / clear enums (design/floats.md). Mirrored as $FLOAT_* /
// $CLEAR_* globals in engine.wat — keep in lockstep.
export const FLOAT_NONE = 0;
export const FLOAT_LEFT = 1;
export const FLOAT_RIGHT = 2;
export const CLEAR_NONE = 0;
export const CLEAR_LEFT = 1;
export const CLEAR_RIGHT = 2;
export const CLEAR_BOTH = 3;
export const LAYOUT_NODE_OFFSET_TEXT_BEHAVIOR = 0x138; // u8 bitmask: overflow/white-space text behavior
export const LAYOUT_NODE_OFFSET_WHITE_SPACE = 0x138; // alias; white-space bits are reserved for its implementation
export const TEXT_BEHAVIOR_ELLIPSIS = 0x01;
export const TEXT_BEHAVIOR_NOWRAP = 0x02;
export const TEXT_BEHAVIOR_BREAK_ANYWHERE = 0x04;
export const TEXT_BEHAVIOR_PRESERVE_SPACES = 0x08;
// overflow-wrap: break-word. The line breaker splits an overflowing word at
// a cluster boundary only when its line has no other break opportunity;
// min-content is unchanged (unlike BREAK_ANYWHERE).
export const TEXT_BEHAVIOR_BREAK_WORD = 0x10;
export const LAYOUT_NODE_OFFSET_TABLE_LAYOUT = 0x139; // u8: 0=auto,1=fixed (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_BORDER_COLLAPSE = 0x13A; // u8: 0=separate,1=collapse (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_CAPTION_SIDE = 0x13B; // u8: 0=top,1=bottom (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_EMPTY_CELLS = 0x0DB; // u8: 0=show,1=hide
export const LAYOUT_NODE_OFFSET_GRID_AUTO_FLOW = 0x13C; // u8: row/column + dense bit (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_ALIGN_CONTENT = 0x13D; // u8 (grid; reuses JUSTIFY_* enum space)
export const LAYOUT_NODE_OFFSET_JUSTIFY_ITEMS = 0x13E; // u8 (grid; reuses JUSTIFY_* enum space; plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_JUSTIFY_SELF = 0x13F; // u8 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_SVG_KIND = 0x140; // u8: rect/circle/ellipse/line/path-ref/group (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_FILL_RULE = 0x141; // u8: 0=nonzero,1=evenodd (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_LINE_CAP = 0x142; // u8: butt/round/square (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_LINE_JOIN = 0x143; // u8: miter/round/bevel (design/svg-rendering.md)
// DISPLAY_TEXT nodes authored by SVG <text> reuse shape-only fields that
// ordinary text never reads. A nonzero anchor marks SVG positioning; x/y are
// SVG user-space coordinates, with y naming the text baseline.
export const LAYOUT_NODE_OFFSET_SVG_TEXT_ANCHOR = 0x140; // u8, aliases SVG_KIND
export const LAYOUT_NODE_OFFSET_BG_KIND = 0x144; // u8: 0=solid,1=linear,2=radial,3=conic, bit7=repeating (P4)
export const LAYOUT_NODE_OFFSET_BG_REPEAT = 0x145; // u8: repeat/no-repeat/space/round (P5c)
export const LAYOUT_NODE_OFFSET_CLIP_PATH_KIND = 0x146; // u8: none/inset/circle/ellipse (P9)
export const LAYOUT_NODE_OFFSET_OUTLINE_STYLE = 0x147; // u8: 0=none,1=solid (P10)
export const LAYOUT_NODE_OFFSET_ASPECT_RATIO_HAS = 0x148; // u8: 0=auto,1=has-ratio (plans/layout/PLAN-layout-remaining.md)
export const LAYOUT_NODE_OFFSET_VERTICAL_ALIGN_TAG = 0x149; // u8: tag shared by table-cell + inline
export const LAYOUT_NODE_OFFSET_BG_SIZE_W_TAG = 0x14A; // u8: auto/length/percent/cover/contain (P5c)
export const LAYOUT_NODE_OFFSET_BG_SIZE_H_TAG = 0x14B; // u8 (P5c)
export const LAYOUT_NODE_OFFSET_BG_POSITION_X_TAG = 0x14C; // u8: length/percent (P5c)
export const LAYOUT_NODE_OFFSET_BG_POSITION_Y_TAG = 0x14D; // u8 (P5c)

// Replaced raster content (<img> and <canvas>), independent of CSS display.
// Every node without raster content must initialize this field to 0xFFFF:
// zero is the first valid IMAGE_TABLE index, not an absent/default value.
// Background-image references live separately in BG_LAYER_POOL. SVG shape
// nodes use the alias below instead and must not enter raster sizing/painting.
export const LAYOUT_NODE_OFFSET_IMAGE_INDEX = 0x14E; // u16: index into IMAGE_TABLE, 0xFFFF=none (P5b, <img> src)
// Reused on DISPLAY_SVG_SHAPE nodes with svgKind=SVG_KIND_PATH_REF (S4):
// an opaque JS-side handle into the SVG path atlas cache, NOT an
// IMAGE_TABLE index — WAT never reads a path's `d` string (JS-only per
// the plan), so this is just forwarded through CMD_SVG_PATH untouched
// for the rasterizer to resolve at draw time, same "index picked by the
// caller" contract as IMAGE_TABLE's own doc comment above.
export const LAYOUT_NODE_OFFSET_SVG_PATH_INDEX = 0x14E; // u16, aliases IMAGE_INDEX (design/svg-rendering.md, Tier B)
export const LAYOUT_NODE_OFFSET_COL_SPAN = 0x150; // u16: table cell colspan (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_ROW_SPAN = 0x152; // u16: table cell rowspan (plans/layout/PLAN-layout-tables.md)
export const LAYOUT_NODE_OFFSET_GEOM_LENGTH = 0x154; // u16: SVG geometry pool span length (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_GRID_COL_TEMPLATE_COUNT = 0x156; // u16 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_ROW_TEMPLATE_COUNT = 0x158; // u16 (plans/layout/PLAN-layout-grid.md)

export const LAYOUT_NODE_OFFSET_SHADOW_COUNT = 0x15A; // u8: box-shadow pool span count (P3)
export const LAYOUT_NODE_OFFSET_STOP_COUNT = 0x15B; // u8: gradient stop pool span count (P4)
export const LAYOUT_NODE_OFFSET_BG_LAYER_COUNT = 0x15C; // u8: multi-background layer pool span count (P5c)
export const LAYOUT_NODE_OFFSET_TEXT_SHADOW_COUNT = 0x15D; // u8: text-shadow pool span count (P6)
export const LAYOUT_NODE_OFFSET_FILTER_COUNT = 0x15E; // u8: filter pool span count (P8)
export const LAYOUT_NODE_OFFSET_BACKDROP_FILTER_COUNT = 0x15F; // u8: backdrop-filter pool span count (P8b)

export const LAYOUT_NODE_OFFSET_SHADOW_OFFSET = 0x160; // u32: box-shadow pool span offset (P3)
export const LAYOUT_NODE_OFFSET_STOP_OFFSET = 0x164; // u32: gradient stop pool span offset (P4)
export const LAYOUT_NODE_OFFSET_BG_LAYERS_OFFSET = 0x168; // u32: multi-background layer pool span offset (P5c)
export const LAYOUT_NODE_OFFSET_TEXT_SHADOW_OFFSET = 0x16C; // u32: text-shadow pool span offset (P6)
export const LAYOUT_NODE_OFFSET_FILTER_OFFSET = 0x170; // u32: filter pool span offset (P8)
export const LAYOUT_NODE_OFFSET_BACKDROP_FILTER_OFFSET = 0x174; // u32: backdrop-filter pool span offset (P8b)
export const LAYOUT_NODE_OFFSET_GEOM_OFFSET = 0x178; // u32: SVG geometry pool span offset (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_GRID_COL_TEMPLATE_OFFSET = 0x17C; // u32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_ROW_TEMPLATE_OFFSET = 0x180; // u32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_OUTLINE_WIDTH = 0x184; // f32 (P10)
export const LAYOUT_NODE_OFFSET_OUTLINE_OFFSET = 0x188; // f32 (P10)
export const LAYOUT_NODE_OFFSET_SVG_STROKE_WIDTH = 0x18C; // f32 (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_FILL_OPACITY = 0x190; // f32 (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_STROKE_OPACITY = 0x194; // f32 (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_TEXT_X = 0x18C; // f32, aliases SVG_STROKE_WIDTH
export const LAYOUT_NODE_OFFSET_SVG_TEXT_Y = 0x190; // f32, aliases SVG_FILL_OPACITY
export const LAYOUT_NODE_OFFSET_BORDER_SPACING_X = 0x198; // f32 (plans/layout/PLAN-layout-tables.md; needs scaleNode)
export const LAYOUT_NODE_OFFSET_BORDER_SPACING_Y = 0x19C; // f32 (plans/layout/PLAN-layout-tables.md; needs scaleNode)
export const LAYOUT_NODE_OFFSET_BG_SIZE_W = 0x1A0; // f32 (P5c)
export const LAYOUT_NODE_OFFSET_BG_SIZE_H = 0x1A4; // f32 (P5c)
export const LAYOUT_NODE_OFFSET_BG_POSITION_X = 0x1A8; // f32 (P5c)
export const LAYOUT_NODE_OFFSET_BG_POSITION_Y = 0x1AC; // f32 (P5c)
export const LAYOUT_NODE_OFFSET_ASPECT_RATIO_W = 0x1B0; // f32 (plans/layout/PLAN-layout-remaining.md)
export const LAYOUT_NODE_OFFSET_ASPECT_RATIO_H = 0x1B4; // f32 (plans/layout/PLAN-layout-remaining.md)
export const LAYOUT_NODE_OFFSET_VERTICAL_ALIGN_VALUE = 0x1B8; // f32 (table-cell + inline, shared)
export const LAYOUT_NODE_OFFSET_ROW_START_VALUE = 0x1BC; // i32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_ROW_END_VALUE = 0x1C0; // i32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_COL_START_VALUE = 0x1C4; // i32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_COL_END_VALUE = 0x1C8; // i32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MIN = 0x1CC; // f32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MAX = 0x1D0; // f32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MIN = 0x1D4; // f32 (plans/layout/PLAN-layout-grid.md)
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MAX = 0x1D8; // f32 (plans/layout/PLAN-layout-grid.md)
// Grid-only aliases. A DISPLAY_GRID node cannot be an SVG root/shape, so these
// coefficients safely reuse SVG-only fields without growing the node record.
// The primary implicit-track values remain at 0x1CC..0x1D8.
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MIN_PERCENTAGE = 0x194;
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MAX_PERCENTAGE = 0x1EC;
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MIN_PERCENTAGE = 0x1F0;
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MAX_PERCENTAGE = 0x1F4;
export const LAYOUT_NODE_OFFSET_GRID_ROW_GAP_PERCENTAGE = 0x18C;
export const LAYOUT_NODE_OFFSET_GRID_COLUMN_GAP_PERCENTAGE = 0x190;

export const LAYOUT_NODE_OFFSET_OUTLINE_COLOR = 0x1DC; // f32[4] rgba (P10)
export const LAYOUT_NODE_OFFSET_SVG_FILL_COLOR = 0x1EC; // f32[4] rgba (design/svg-rendering.md)
export const LAYOUT_NODE_OFFSET_SVG_STROKE_COLOR = 0x1FC; // f32[4] rgba (design/svg-rendering.md)

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
export const LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_MIN_X = 0x1EC; // f32, aliases SVG_FILL_COLOR.r
export const LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_MIN_Y = 0x1F0; // f32, aliases SVG_FILL_COLOR.g
export const LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_WIDTH = 0x1F4; // f32, aliases SVG_FILL_COLOR.b
export const LAYOUT_NODE_OFFSET_SVG_VIEW_BOX_HEIGHT = 0x1F8; // f32, aliases SVG_FILL_COLOR.a
export const LAYOUT_NODE_OFFSET_SVG_HAS_VIEW_BOX = 0x141; // u8, aliases SVG_FILL_RULE: 0=no viewBox (use intrinsic px), 1=has viewBox
export const LAYOUT_NODE_OFFSET_SVG_PRESERVE_ASPECT_RATIO = 0x142; // u8, aliases SVG_LINE_CAP: PRESERVE_ASPECT_RATIO_* enum
// <textarea> intrinsic size (Blink's TextAreaIntrinsicInlineSize and
// TextAreaIntrinsicBlockSize). A textarea is never an svg shape, so these
// alias the shape-only stroke color, and LAYOUT_FLAG_TEXTAREA names the
// meaning. The engine resolves the font-dependent parts: width = ceil(average
// character width x cols) + INLINE_SCROLLBAR, height = line height x rows +
// BLOCK_SCROLLBAR. The scrollbar terms are px, already resolved from
// overflow and scrollbar-width.
export const LAYOUT_NODE_OFFSET_TEXTAREA_COLS = 0x1FC; // f32, aliases SVG_STROKE_COLOR.r
export const LAYOUT_NODE_OFFSET_TEXTAREA_ROWS = 0x200; // f32, aliases SVG_STROKE_COLOR.g
export const LAYOUT_NODE_OFFSET_TEXTAREA_INLINE_SCROLLBAR = 0x204; // f32 px, aliases SVG_STROKE_COLOR.b
export const LAYOUT_NODE_OFFSET_TEXTAREA_BLOCK_SCROLLBAR = 0x208; // f32 px, aliases SVG_STROKE_COLOR.a
// MathML box fields (plans/layout/PLAN-mathml-layout.md). A math box
// (DISPLAY_MATH, DISPLAY_BLOCK_MATH, or an mtd cell) is never an svg node, a
// textarea, or a grid container, so these alias the SVG fill and stroke
// colors (and the grid percentage and textarea aliases over them).
export const LAYOUT_NODE_OFFSET_MATH_KIND = 0x1EC; // u8 MATH_KIND_*
export const LAYOUT_NODE_OFFSET_MATH_FLAGS = 0x1ED; // u8 MATH_FLAG_*
export const LAYOUT_NODE_OFFSET_MATH_OPERATOR_FLAGS = 0x1EE; // u8 MATH_OPERATOR_*
export const LAYOUT_NODE_OFFSET_MATH_SPACE_UNITS = 0x1EF; // u8: default lspace (bits 0-3) and rspace (4-7) in 1/18 em
export const LAYOUT_NODE_OFFSET_MATH_LSPACE = 0x1F0; // f32 px or percent, by MATH_TAGS
export const LAYOUT_NODE_OFFSET_MATH_RSPACE = 0x1F4; // f32 px or percent, by MATH_TAGS
export const LAYOUT_NODE_OFFSET_MATH_CODE_POINT = 0x1F8; // u32: the token's single code point, else 0xFFFF
export const LAYOUT_NODE_OFFSET_MATH_LENGTH = 0x1FC; // f32: mfrac linethickness or mspace width
export const LAYOUT_NODE_OFFSET_MATH_MIN_SIZE = 0x200; // f32: mo minsize, or mspace height
export const LAYOUT_NODE_OFFSET_MATH_MAX_SIZE = 0x204; // f32: mo maxsize, or mspace depth
export const LAYOUT_NODE_OFFSET_MATH_TAGS = 0x208; // u16: MATH_LENGTH_* pairs (see MATH_LENGTH_DEFAULT)
export const LAYOUT_NODE_OFFSET_BG_GRADIENT_GEOMETRY = 0x20C; // f32[4]: linear{dx,dy,length,pad} / radial{cx,cy,rx,ry} / conic{cx,cy,angle,pad} (P4)
export const LAYOUT_NODE_OFFSET_CLIP_PATH_GEOMETRY = 0x21C; // f32[5] (P9)

// Elliptical border-radius (P10): widens the 4 existing circular radii
// (LAYOUT_NODE_OFFSET_BORDER_RADIUS_*, 0xA8-0xB7, UNCHANGED) into (x, y)
// pairs by adding the Y component here. The X components stay exactly
// where they've always been; do not move them.
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_LEFT_Y = 0x230; // f32 (P10)
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_TOP_RIGHT_Y = 0x234; // f32 (P10)
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_RIGHT_Y = 0x238; // f32 (P10)
export const LAYOUT_NODE_OFFSET_BORDER_RADIUS_BOTTOM_LEFT_Y = 0x23C; // f32 (P10)

// object-fit / object-position (P5b): NOT anticipated in P0's original
// byte inventory — carved out of the 60-byte reserved tail below, which
// exists for exactly this ("headroom for anything a future slice needs
// that wasn't anticipated here"). object-position has no "auto" keyword
// (CSS default is 50% 50%), but the tag byte reuses SIZE_TAG_LENGTH/
// SIZE_TAG_PERCENT for consistency with BG_POSITION_*_TAG's scheme.
export const LAYOUT_NODE_OFFSET_OBJECT_FIT = 0x244; // u8: OBJECT_FIT_* enum, 0=fill (P5b)
export const LAYOUT_NODE_OFFSET_OBJECT_POSITION_X_TAG = 0x245; // u8: SIZE_TAG_LENGTH/PERCENT (P5b)
export const LAYOUT_NODE_OFFSET_OBJECT_POSITION_Y_TAG = 0x246; // u8 (P5b)
export const LAYOUT_NODE_OFFSET_OBJECT_POSITION_X = 0x248; // f32: length(LU) or percent 0..100 (P5b)
export const LAYOUT_NODE_OFFSET_OBJECT_POSITION_Y = 0x24C; // f32 (P5b)

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
// 5 bytes would shift every region constant from COMMAND_BUFFER_BASE
// onward in both mirrors, and verifyLayout (which compares the two
// mirrors against each other) cannot catch a consistent double-typo
// that overlaps two regions.
export const LAYOUT_NODE_OFFSET_MASK_LAYERS_OFFSET = 0x240; // u32: MASK_LAYER_POOL span offset (P11)
export const LAYOUT_NODE_OFFSET_MASK_LAYER_COUNT = 0x247; // u8: MASK_LAYER_POOL span count (P11)

export const OBJECT_FIT_FILL = 0;
export const OBJECT_FIT_CONTAIN = 1;
export const OBJECT_FIT_COVER = 2;
export const OBJECT_FIT_NONE = 3;
export const OBJECT_FIT_SCALE_DOWN = 4;

// SVG node kinds (design/svg-rendering.md). A DISPLAY_SVG_ROOT node's children carry
// one of these in LAYOUT_NODE_OFFSET_SVG_KIND to say what geometry they
// hold in the SVG geometry pool (GEOM_OFFSET/GEOM_LENGTH). SVG_KIND_GROUP
// (<g>) has no geometry pool span (length 0) — it's a plain transform +
// paint-order grouping node, per the plan's Node/data model section.
export const SVG_KIND_RECT = 0;
export const SVG_KIND_CIRCLE = 1;
export const SVG_KIND_ELLIPSE = 2; // S2
export const SVG_KIND_LINE = 3;
export const SVG_KIND_PATH_REF = 4; // S4 (Tier B, msdfgen path atlas)
export const SVG_KIND_GROUP = 5;
export const SVG_TEXT_ANCHOR_NONE = 0;
export const SVG_TEXT_ANCHOR_START = 1;
export const SVG_TEXT_ANCHOR_MIDDLE = 2;
export const SVG_TEXT_ANCHOR_END = 3;

// preserveAspectRatio (design/svg-rendering.md's viewBox->viewport transform).
// Ships the meet family only (xMidYMid default + the other 8 alignment
// keywords) and 'none'; 'slice' needs a clip push, not scoped into S1's
// initial cut — see the plan's own staging note.
export const PRESERVE_ASPECT_RATIO_NONE = 0;
export const PRESERVE_ASPECT_RATIO_X_MIN_Y_MIN = 1;
export const PRESERVE_ASPECT_RATIO_X_MID_Y_MIN = 2;
export const PRESERVE_ASPECT_RATIO_X_MAX_Y_MIN = 3;
export const PRESERVE_ASPECT_RATIO_X_MIN_Y_MID = 4;
export const PRESERVE_ASPECT_RATIO_X_MID_Y_MID = 5; // default
export const PRESERVE_ASPECT_RATIO_X_MAX_Y_MID = 6;
export const PRESERVE_ASPECT_RATIO_X_MIN_Y_MAX = 7;
export const PRESERVE_ASPECT_RATIO_X_MID_Y_MAX = 8;
export const PRESERVE_ASPECT_RATIO_X_MAX_Y_MAX = 9;

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
export const LAYOUT_NODE_OFFSET_SVG_STROKE_PATH_INDEX = 0x250; // u16 (design/svg-rendering.md)

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
export const LAYOUT_NODE_OFFSET_BORDER_IMAGE_INDEX = 0x252; // u16 (P14)

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
export const LAYOUT_NODE_OFFSET_BG_CENTER_X_TAG = 0x254; // u8: SIZE_TAG_LENGTH/PERCENT (radial+conic `at <position>`)
export const LAYOUT_NODE_OFFSET_BG_CENTER_Y_TAG = 0x255; // u8
export const LAYOUT_NODE_OFFSET_RADIAL_SHAPE = 0x256; // u8: RADIAL_SHAPE_CIRCLE/ELLIPSE, default ellipse
export const LAYOUT_NODE_OFFSET_RADIAL_SIZE_KEYWORD = 0x257; // u8: RADIAL_SIZE_* enum, default farthest-corner
export const LAYOUT_NODE_OFFSET_BG_CENTER_X = 0x258; // f32: length(LU) or percent 0..100
export const LAYOUT_NODE_OFFSET_BG_CENTER_Y = 0x25C; // f32
export const LAYOUT_NODE_OFFSET_RADIAL_EXPLICIT_RX = 0x260; // f32: only meaningful when RADIAL_SIZE_EXPLICIT
export const LAYOUT_NODE_OFFSET_RADIAL_EXPLICIT_RY = 0x264; // f32
// clip-path (design/paint-coverage.md P9): ONE-BASED index into
// CLIP_PATH_POOL (pool entry k is stored as k+1); 0 = none, so a zeroed
// struct naturally reads as "no clip-path" and hand-written node writers
// (test/helpers/scene.js, test/oracle/sandom-layout.js—
// they all zero the struct first) need no knowledge of this field.
// Sits BEFORE CHANGED_GEN so change tracking sees it.
export const LAYOUT_NODE_OFFSET_CLIP_PATH_INDEX = 0x268; // u16
// Requested scrolling input. These live in the reserved
// post-style tail because the float-layout scratch already occupies that
// region and moving every scratch field would add risk without changing
// the wire format. session.js compares and writes these two fields
// explicitly, then stamps CHANGED_GEN when either changes.
export const LAYOUT_NODE_OFFSET_SCROLL_LEFT = 0x294; // i32 LayoutUnits: requested scrollLeft
export const LAYOUT_NODE_OFFSET_SCROLL_TOP = 0x298; // i32 LayoutUnits: requested scrollTop
export const LAYOUT_NODE_OFFSET_POSITION_STICKY = 0x29C; // u8: paint-time sticky constraints enabled
// The shaping context of the node: its content language (HTML "The lang
// and xml:lang attributes": the lang attribute of the nearest inclusive
// ancestor element that has one) and its font feature set, as an index
// into LANGUAGE_TABLE and LANGUAGE_TABLE_FEATURES; 0 when the node has
// neither. The DOM core writes it for every box, text included.
export const LAYOUT_NODE_OFFSET_LANGUAGE = 0x29D; // u8: LANGUAGE_TABLE index
// The authored font stack of a text node (plans/PLAN-font-fallback.md):
// a FONT_STACK_TABLE index, or 0 for a stack of LAYOUT_NODE_OFFSET_FONT_INDEX
// alone. Past CHANGED_GEN, so the core's row diff compares it explicitly.
export const LAYOUT_NODE_OFFSET_FONT_STACK = 0x29E; // u16
export const LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_MARGIN = 0x2A0; // f32 px
export const LAYOUT_NODE_OFFSET_OVERFLOW_CLIP_BOX = 0x2A4; // u8 bits 0-1 (SCROLLBAR_CLIP_BOX_MASK): 0=padding,1=border,2=content
export const LAYOUT_NODE_OFFSET_SCROLL_ORIGIN_RIGHT = 0x2A5; // u8 bit 0 (SCROLLBAR_ORIGIN_RIGHT_MASK): exposed horizontal scroll origin is right
// Classic scrollbars (plans/PLAN-native-scrollbars.md, decision 3). A
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
export const LAYOUT_NODE_OFFSET_SCROLLBAR_LAYOUT = 0x2A4; // u8 bits 2-7, aliases OVERFLOW_CLIP_BOX
export const LAYOUT_NODE_OFFSET_SCROLLBAR_STATE = 0x2A5; // u8 bits 1-4, aliases SCROLL_ORIGIN_RIGHT
export const SCROLLBAR_CLIP_BOX_MASK = 0x03;
export const SCROLLBAR_ORIGIN_RIGHT_MASK = 0x01;
export const SCROLLBAR_THICKNESS_SHIFT = 2; // 2 bits: 0 = no bar, 1 = regular, 2 = thin
export const SCROLLBAR_THICKNESS_MASK = 0x0C;
export const SCROLLBAR_VERTICAL_LEFT = 0x10; // the vertical bar is on the left (direction: rtl)
export const SCROLLBAR_BOTH_EDGES = 0x20; // scrollbar-gutter: stable both-edges reserved both sides
export const SCROLLBAR_VERTICAL_RESERVED = 0x40; // the vertical bar's side is in the padding
export const SCROLLBAR_HORIZONTAL_RESERVED = 0x80; // the bottom bar is in the padding
export const SCROLLBAR_VERTICAL_AUTO = 0x02; // overflow-y: auto
export const SCROLLBAR_HORIZONTAL_AUTO = 0x04; // overflow-x: auto
export const SCROLLBAR_VERTICAL_APPLIED = 0x08; // the engine added the vertical bar
export const SCROLLBAR_HORIZONTAL_APPLIED = 0x10; // the engine added the horizontal bar
// Chromium's macOS classic thickness (scrollbar_theme_mac.cc), CSS px.
export const SCROLLBAR_REGULAR_THICKNESS = 15;
export const SCROLLBAR_THIN_THICKNESS = 11;
// The unicode-bidi keyword in bits 0-3 (UNICODE_BIDI_NORMAL through
// UNICODE_BIDI_PLAINTEXT). Bit 7 (UNICODE_BIDI_TEXT_ALIGN_LOGICAL) is set
// when TEXT_ALIGN was resolved from start, end, justify or no value: a
// unicode-bidi: plaintext container mirrors that alignment on each line
// whose paragraph direction differs from its own direction.
export const LAYOUT_NODE_OFFSET_UNICODE_BIDI = 0x2A6; // u8
export const UNICODE_BIDI_NORMAL = 0;
export const UNICODE_BIDI_EMBED = 1;
export const UNICODE_BIDI_ISOLATE = 2;
export const UNICODE_BIDI_BIDI_OVERRIDE = 3;
export const UNICODE_BIDI_ISOLATE_OVERRIDE = 4;
export const UNICODE_BIDI_PLAINTEXT = 5;
export const UNICODE_BIDI_KEYWORD_MASK = 0x0F;
export const UNICODE_BIDI_TEXT_ALIGN_LOGICAL = 0x80;
// 1 when the box's CSS direction is rtl: its inline formatting context
// starts lines at the line-right edge, resolves text-align start/end, and
// orders mixed-direction content with the Unicode Bidirectional Algorithm;
// an inline box with this bit puts its start edges on its right side.
export const LAYOUT_NODE_OFFSET_INLINE_DIRECTION_RTL = 0x2A7; // u8
// background-origin (BUG-background-origin-not-modeled, resolved; see
// activity/reports/REPORT-2026-10-09-resolved-bug-records.md): the box the
// background POSITIONING area is (gradient geometry, bg-image layer
// size/position/tile anchor) — independent of BACKGROUND_CLIP, which
// keeps governing only the clip. 0 = padding-box so a zeroed struct
// reads as the CSS initial value (NOTE the enum order differs from
// BACKGROUND_CLIP's, whose own initial value is border-box=0 — both
// enums put their CSS initial at 0, which is what a zeroed struct
// must mean). Sits BEFORE CHANGED_GEN so change tracking sees it.
export const LAYOUT_NODE_OFFSET_BACKGROUND_ORIGIN = 0x26A; // u8: 0=padding-box,1=border-box,2=content-box
export const LAYOUT_NODE_OFFSET_TEXT_DECORATION = 0x26B; // u8 bitmask: underline/line-through/overline
// Grid wire tags. P0 reserved values but omitted the tags required to
// distinguish auto, line, span, and track sizing-function kinds.
export const LAYOUT_NODE_OFFSET_GRID_ROW_START_KIND = 0x26C; // u8
export const LAYOUT_NODE_OFFSET_GRID_ROW_END_KIND = 0x26D; // u8
export const LAYOUT_NODE_OFFSET_GRID_COL_START_KIND = 0x26E; // u8
export const LAYOUT_NODE_OFFSET_GRID_COL_END_KIND = 0x26F; // u8
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MIN_TYPE = 0x270; // u8
export const LAYOUT_NODE_OFFSET_GRID_AUTO_ROWS_MAX_TYPE = 0x271; // u8
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MIN_TYPE = 0x272; // u8
export const LAYOUT_NODE_OFFSET_GRID_AUTO_COLS_MAX_TYPE = 0x273; // u8
export const TEXT_DECORATION_UNDERLINE = 0x01;
export const TEXT_DECORATION_LINE_THROUGH = 0x02;
export const TEXT_DECORATION_OVERLINE = 0x04;
// 0x274: style boundary

// Radial gradient shape (P4 step 3, css-images-3's radial-gradient()
// <radial-shape>). Mirrors engine.wat's matching enum.
export const RADIAL_SHAPE_CIRCLE = 0;
export const RADIAL_SHAPE_ELLIPSE = 1; // default

// Radial gradient size keyword (P4 step 3, css-images-3's <radial-size>).
// Mirrors engine.wat's matching enum.
export const RADIAL_SIZE_CLOSEST_SIDE = 0;
export const RADIAL_SIZE_FARTHEST_SIDE = 1;
export const RADIAL_SIZE_CLOSEST_CORNER = 2;
export const RADIAL_SIZE_FARTHEST_CORNER = 3; // default
export const RADIAL_SIZE_EXPLICIT = 4;

// Change tracking (generation invalidation, see design/layout-engine.md).
// MUST be the LAST style field — see the P0 block comment above.
export const LAYOUT_NODE_OFFSET_CHANGED_GEN = 0x274; // u32

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
export const LAYOUT_NODE_OFFSET_CLEARANCE_SCRATCH = 0x278; // u8
export const LAYOUT_NODE_OFFSET_CLEARANCE_GEN = 0x27C; // u32
// F3 6b: the vertical-fit retry origin — where this box's avoidance
// resumes its opportunity search after a post-layout misfit (a float
// jutting into its span, reachable only via cleared floats). Own gen
// guard (the decision gen above has different write semantics).
export const LAYOUT_NODE_OFFSET_AVOID_RETRY_ORIGIN = 0x280; // f32
export const LAYOUT_NODE_OFFSET_AVOID_RETRY_GEN = 0x284; // u32
// F4 fuzz: the cbY the misfit was recorded at — the origin is honored
// only by a same-position re-run (the fit-retry loop); repositioned
// relayouts re-derive fresh. Mirrors engine.wat's $NODE_AVOID_RETRY_FROM.
export const LAYOUT_NODE_OFFSET_AVOID_RETRY_FROM = 0x288; // f32

// F4 finding #33: the layout-pass generation in which this new-FC box's
// pushed-margin SEPARATION fired. Blink's separation is a one-way ratchet
// within one parent layout attempt (bla.cc:1943); sandom's provisional →
// correction re-runs together model that single attempt, so a gen-matching
// record forces the separated path even when a re-corrected frame no longer
// shows the push (tree #1276's minimal oscillated between the separated and
// unseparated reports otherwise). Mirrors engine.wat's $NODE_SEPARATED_GEN.
export const LAYOUT_NODE_OFFSET_SEPARATED_GEN = 0x28C; // u32
// F4 finding #4103-third: the $layoutInvocationGen (NOT $layoutPassGen) in
// which an interior collapse-through child of this box took the
// RESOLVED-flavor clearance pin path. A cleared self-collapsing wrapper
// carrying such an interior pin is a pure pass-through — its own pin by an
// outer wrapper must not content-separate that wrapper (the nested cleared
// chain stays self-collapsing). Keyed on the invocation gen so it survives
// the #29 chain-abort $layoutPassGen bump between the interior pin and the
// wrapper's own pin. Mirrors engine.wat's $NODE_INTERIOR_CLEAR_PIN_GEN.
export const LAYOUT_NODE_OFFSET_INTERIOR_CLEAR_PIN_GEN = 0x290; // u32
// style ends at 0x278
// scratch uses 0x278-0x293

// <length-percentage> coefficients. A length or a percentage keeps its own
// tag and zeroes the companion; TAG_CALC_PAIR stores pixels in the original
// value field and the percentage fraction (or NaN for a length expression)
// here.
export const LAYOUT_NODE_OFFSET_WIDTH_PERCENT = 0x2A8;
export const LAYOUT_NODE_OFFSET_HEIGHT_PERCENT = 0x2AC;
export const LAYOUT_NODE_OFFSET_MIN_WIDTH_PERCENT = 0x2B0;
export const LAYOUT_NODE_OFFSET_MIN_HEIGHT_PERCENT = 0x2B4;
export const LAYOUT_NODE_OFFSET_MAX_WIDTH_PERCENT = 0x2B8;
export const LAYOUT_NODE_OFFSET_MAX_HEIGHT_PERCENT = 0x2BC;
export const LAYOUT_NODE_OFFSET_INSET_TOP_PERCENT = 0x2C0;
export const LAYOUT_NODE_OFFSET_INSET_RIGHT_PERCENT = 0x2C4;
export const LAYOUT_NODE_OFFSET_INSET_BOTTOM_PERCENT = 0x2C8;
export const LAYOUT_NODE_OFFSET_INSET_LEFT_PERCENT = 0x2CC;
export const LAYOUT_NODE_OFFSET_FLEX_BASIS_PERCENT = 0x2D0;
// One byte of the node struct's tail padding (0x2D4..0x2D7): the packed
// gradient interpolation identifiers (see GRADIENT_SPACE_NAMES).
export const LAYOUT_NODE_OFFSET_GRADIENT_INTERPOLATION = 0x2D4;
// CSS transform-origin coefficients. The animation resolver combines each
// pixel offset and percentage with the post-layout border-box dimensions.
export const LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X = 0x2D8;
export const LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_X_PERCENT = 0x2DC;
export const LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y = 0x2E0;
export const LAYOUT_NODE_OFFSET_TRANSFORM_ORIGIN_Y_PERCENT = 0x2E4;
// CSS transform form. 0: the affine in LAYOUT_NODE_OFFSET_TRANSFORM is the
// node's own transform around its border-box center, as the scene writer
// resolves it. 1: the affine is the CSS transform list composed with its
// translation linear in the border box — e += ew * w + eh * h, f += fw * w
// + fh * h from TRANSFORM_PERCENT — and the engine folds it around
// transform-origin at compose time (the DOM core's records; no provisional
// layout is needed for percentage translations). An animation sample
// overwrites the affine with form 0.
export const LAYOUT_NODE_OFFSET_TRANSFORM_KIND = 0x2D5; // u8
export const LAYOUT_NODE_OFFSET_TRANSFORM_PERCENT = 0x2E8; // f32[4]: ew, eh, fw, fh
export const TRANSFORM_KIND_RESOLVED = 0;
export const TRANSFORM_KIND_CSS = 1;
// Multi-column containers (CSS Multi-column Layout 1). A block container is
// a multi-column container when its column count is set or its column width
// is positive. COLUMN_WIDTH shares its bytes with BORDER_SPACING_X: a
// multi-column container is never a table. COLUMN_GAP holds the used gap in
// pixels, or -1 for `normal` (1em), plus GRID_COLUMN_GAP_PERCENTAGE as a
// fraction of the content width.
export const LAYOUT_NODE_OFFSET_COLUMN_COUNT = 0x2D6; // u8: 0=auto, else the count (clamped to 255)
export const LAYOUT_NODE_OFFSET_BREAK_INSIDE = 0x2D7; // u8: BREAK_INSIDE_*
export const LAYOUT_NODE_OFFSET_COLUMN_WIDTH = 0x198; // f32: px; 0=auto (aliases BORDER_SPACING_X)
export const BREAK_INSIDE_AUTO = 0;
export const BREAK_INSIDE_AVOID = 1;
// orphans and widows (CSS Fragmentation 3): the least line boxes a column
// fragment of a block keeps before and after a break inside it. Inherited
// integers, default 2, clamped to 1..255. 0x2FB holds
// LAYOUT_NODE_OFFSET_LINE_BREAK; 0x2FC..0x2FF hold
// LAYOUT_NODE_OFFSET_PAINT_GEN.
export const LAYOUT_NODE_OFFSET_ORPHANS = 0x2F8; // u8
export const LAYOUT_NODE_OFFSET_WIDOWS = 0x2F9; // u8
// An SVG shape whose fill or stroke is `currentcolor` (CSS Color 4: the
// keyword computes to itself, so its used value is the shape's own
// `color`). The shape paints that paint with TEXT_COLOR, which a running
// `color` animation samples into the shape, rather than SVG_FILL_COLOR or
// SVG_STROKE_COLOR, which hold the color when the record was written.
export const LAYOUT_NODE_OFFSET_SVG_PAINT_CURRENT_COLOR = 0x2FA; // u8: SVG_PAINT_CURRENT_COLOR_* bits
export const SVG_PAINT_CURRENT_COLOR_FILL = 0x01;
export const SVG_PAINT_CURRENT_COLOR_STROKE = 0x02;
// line-break (CSS Text 3 §5.3) in bits 0-2, word-break (§5.2) in bits 3-4
// and text-spacing-trim (CSS Text 4 §9.2) in bits 5-6. All are inherited;
// the DOM core writes them for every box beside TEXT_BEHAVIOR.
// word-break: normal sets neither word-break bit; word-break: break-word
// sets neither and sets TEXT_BEHAVIOR_BREAK_ANYWHERE, as
// overflow-wrap: anywhere does.
export const LAYOUT_NODE_OFFSET_LINE_BREAK = 0x2FB; // u8: LINE_BREAK_* | WORD_BREAK_* | TEXT_SPACING_TRIM_*
export const LINE_BREAK_AUTO = 0;
export const LINE_BREAK_LOOSE = 1;
export const LINE_BREAK_NORMAL = 2;
export const LINE_BREAK_STRICT = 3;
export const LINE_BREAK_ANYWHERE = 4;
export const LINE_BREAK_STRICTNESS_MASK = 0x07;
export const WORD_BREAK_BREAK_ALL = 0x08;
export const WORD_BREAK_KEEP_ALL = 0x10;
export const TEXT_SPACING_TRIM_SHIFT = 5;
export const TEXT_SPACING_TRIM_MASK = 0x60;
export const TEXT_SPACING_TRIM_NORMAL = 0x00;
export const TEXT_SPACING_TRIM_SPACE_ALL = 0x20;
export const TEXT_SPACING_TRIM_SPACE_FIRST = 0x40;
export const TEXT_SPACING_TRIM_TRIM_START = 0x60;
// The generation of the node's last paint-only change: a change of fields
// no layout function reads (the DOM core's EngineFrameFact flag 8). Such a
// change leaves CHANGED_GEN, the layout's generation, as it was, so every
// layout cache and the whole-pass reuse keep; paint and damage read the
// larger of the two. A writer that stamps CHANGED_GEN needs no knowledge of
// this field. Past the tracked style bytes, like CHANGED_GEN itself.
export const LAYOUT_NODE_OFFSET_PAINT_GEN = 0x2FC; // u32
// column-rule and column-fill of a multi-column container. They alias
// fields that only grid and table boxes read, and the record writer stores
// them only for a multi-column container, so a grid or table element keeps
// its own values. COLUMN_RULE_STYLE is a BORDER_STYLE_* value (NONE when
// unset); COLUMN_RULE_WIDTH is the used width in px, zero for none and
// hidden; COLUMN_RULE_COLOR is RGBA f32 with currentcolor resolved.
export const LAYOUT_NODE_OFFSET_COLUMN_RULE_WIDTH = 0x19C; // f32 px (aliases BORDER_SPACING_Y)
export const LAYOUT_NODE_OFFSET_COLUMN_RULE_COLOR = 0x1CC; // f32[4] (aliases GRID_AUTO_ROWS_MIN..GRID_AUTO_COLS_MAX)
export const LAYOUT_NODE_OFFSET_COLUMN_RULE_STYLE = 0x270; // u8: BORDER_STYLE_* (aliases GRID_AUTO_ROWS_MIN_TYPE)
export const LAYOUT_NODE_OFFSET_COLUMN_FILL = 0x271; // u8: COLUMN_FILL_* (aliases GRID_AUTO_ROWS_MAX_TYPE)
export const COLUMN_FILL_BALANCE = 0;
export const COLUMN_FILL_AUTO = 1;
// column-span of any box: an in-flow block-level box with COLUMN_SPAN_ALL
// whose parent is a multi-column container, or a block in its flow that
// establishes no formatting context, spans every column and splits the
// columns into rows above and below it.
export const LAYOUT_NODE_OFFSET_COLUMN_SPAN = 0xD9; // u8: COLUMN_SPAN_*
export const COLUMN_SPAN_NONE = 0;
export const COLUMN_SPAN_ALL = 1;
// Native appearance (CSS UI 4 §5.1, `appearance`): the form control a box
// paints as the platform theme does. The low seven bits name the control,
// NATIVE_APPEARANCE_CHECKED its checked state. A checkbox or radio paints
// the control in place of the box's background and border; a menulist
// paints over them. NONE paints the box as CSS alone describes it.
export const LAYOUT_NODE_OFFSET_NATIVE_APPEARANCE = 0xDA; // u8
export const NATIVE_APPEARANCE_NONE = 0;
export const NATIVE_APPEARANCE_CHECKBOX = 1;
export const NATIVE_APPEARANCE_RADIO = 2;
export const NATIVE_APPEARANCE_MENULIST = 3;
export const NATIVE_APPEARANCE_KIND_MASK = 0x7F;
export const NATIVE_APPEARANCE_CHECKED = 0x80;

// flex-direction values.
export const FLEX_ROW = 0;
export const FLEX_ROW_REVERSE = 1;
export const FLEX_COLUMN = 2;
export const FLEX_COLUMN_REVERSE = 3;

// justify-content values (main-axis).
export const JUSTIFY_START = 0;
export const JUSTIFY_END = 1;
export const JUSTIFY_CENTER = 2;
export const JUSTIFY_SPACE_BETWEEN = 3;
export const JUSTIFY_SPACE_AROUND = 4;
export const JUSTIFY_SPACE_EVENLY = 5;

// align-items / align-self values (cross-axis). align-self stores value+1 so 0
// can mean "auto" (inherit the container's align-items).
export const ALIGN_STRETCH = 0;
export const ALIGN_FLEX_START = 1;
export const ALIGN_FLEX_END = 2;
export const ALIGN_CENTER = 3;
export const ALIGN_BASELINE = 4;

// flex-wrap values.
export const FLEX_NOWRAP = 0;
export const FLEX_WRAP = 1;

// Size tags (shared by width/height/min/max value fields).
export const SIZE_TAG_AUTO = 0; // also "none" for max, "zero" for min
export const SIZE_TAG_LENGTH = 1;
export const SIZE_TAG_PERCENT = 2;
export const SIZE_TAG_MIN_CONTENT = 3; // width:min-content
export const SIZE_TAG_MAX_CONTENT = 4; // width:max-content
export const SIZE_TAG_FIT_CONTENT = 8; // width/height:fit-content
// A px + percentage-fraction pair. A NaN percentage marks a length
// expression: the value is the identifier of a program the DOM core interned
// (src/dom-wasm/lengths.watpart) for a min(), max(), or clamp() that
// compares a percentage with another unit, evaluated at layout against the
// percentage basis. The same convention holds for the gap and grid track
// pixel/percentage pairs.
export const SIZE_TAG_CALC_PAIR = 5;
export const SIZE_TAG_COVER = 6; // background-size:cover (P5c)
export const SIZE_TAG_CONTAIN = 7; // background-size:contain (P5c)

// background-repeat (P5c). space/round are documented-not-shipped (see
// design/paint-coverage.md's P5c note) — repeat/no-repeat only for now.
export const BG_REPEAT_REPEAT = 0;
export const BG_REPEAT_NO_REPEAT = 1;
export const BG_REPEAT_SPACE = 2; // P5c: $resolveBackgroundRepeatAxis
export const BG_REPEAT_ROUND = 3; // P5c: $resolveBackgroundRepeatAxis

// Display values.
export const DISPLAY_BLOCK = 0;
export const DISPLAY_NONE = 1;
export const DISPLAY_FLEX = 2;
export const DISPLAY_TEXT = 3; // Slice 6: leaf node, content comes from a shaped run (6B)
export const DISPLAY_IMAGE = 4; // Slice P5b: leaf node, replaced-box sizing from IMAGE_TABLE
export const DISPLAY_SVG_ROOT = 5; // design/svg-rendering.md: replaced box, sizing from width/height/viewBox; children skip layout entirely
export const DISPLAY_SVG_SHAPE = 6; // design/svg-rendering.md: a child of an svg root — NODE_SVG_KIND (SVG_KIND_* enum) says which shape; geometry lives in the SVG geometry pool, not CSS layout fields
export const DISPLAY_INLINE = 7; // design/inline-layout.md: non-atomic inline box (<span> etc), child of an IFC root (LAYOUT_FLAG_IS_INLINE_CTX) — no computed box, contributes OPEN/CLOSE items to the item stream
export const DISPLAY_INLINE_BLOCK = 8; // design/inline-layout.md: atomic inline-level box laid out by block machinery
export const DISPLAY_GRID = 9; // plans/layout/PLAN-layout-grid.md: CSS Grid formatting context
export const DISPLAY_TABLE = 10;
export const DISPLAY_INLINE_TABLE = 11;
export const DISPLAY_TABLE_ROW_GROUP = 12;
export const DISPLAY_TABLE_HEADER_GROUP = 13;
export const DISPLAY_TABLE_FOOTER_GROUP = 14;
export const DISPLAY_TABLE_ROW = 15;
export const DISPLAY_TABLE_CELL = 16;
export const DISPLAY_TABLE_COLUMN = 17;
export const DISPLAY_TABLE_COLUMN_GROUP = 18;
export const DISPLAY_TABLE_CAPTION = 19;
export const DISPLAY_INLINE_FLEX = 20;
export const DISPLAY_INLINE_GRID = 21; // atomic inline grid container: participates in its parent IFC like inline-block, lays its own children out as grid
// MathML Core (plans/layout/PLAN-mathml-layout.md). DISPLAY_MATH is an inline
// math box: atomic inline-level, laid out by the MathML algorithms. A
// DISPLAY_BLOCK_MATH box is a block-level math root or any math box inside
// one; LAYOUT_NODE_OFFSET_MATH_KIND names its algorithm.
export const DISPLAY_MATH = 22;
export const DISPLAY_BLOCK_MATH = 23;

// MathML layout algorithms, by element (LAYOUT_NODE_OFFSET_MATH_KIND).
export const MATH_KIND_NONE = 0;
export const MATH_KIND_ROW = 1; // math, mrow, mstyle, merror, mphantom, semantics, maction, mprescripts, none, and the anonymous mrow of an mtd
export const MATH_KIND_TOKEN = 2; // mi, mn, mtext, ms
export const MATH_KIND_OPERATOR = 3; // mo
export const MATH_KIND_FRACTION = 4;
export const MATH_KIND_SQRT = 5;
export const MATH_KIND_ROOT = 6;
export const MATH_KIND_SUB = 7;
export const MATH_KIND_SUP = 8;
export const MATH_KIND_SUBSUP = 9;
export const MATH_KIND_UNDER = 10;
export const MATH_KIND_OVER = 11;
export const MATH_KIND_UNDEROVER = 12;
export const MATH_KIND_MULTISCRIPTS = 13;
export const MATH_KIND_SPACE = 14;
export const MATH_KIND_PADDED = 15;
export const MATH_KIND_PRESCRIPTS = 16;
export const MATH_KIND_TABLE = 17; // an mtable (display table): baseline on the math axis
export const MATH_KIND_CELL = 18; // an mtd (display table-cell): content is an anonymous mrow, centered
// LAYOUT_NODE_OFFSET_MATH_FLAGS
export const MATH_FLAG_DISPLAY_STYLE = 0x01; // math-style: normal
export const MATH_FLAG_SHIFT_COMPACT = 0x02; // math-shift: compact
export const MATH_FLAG_ROOT = 0x04; // the <math> element
export const MATH_FLAG_ACCENT = 0x08; // mover/munderover accent="true"
export const MATH_FLAG_ACCENT_UNDER = 0x10; // munder/munderover accentunder="true"
export const MATH_FLAG_SPACE_LIKE = 0x20; // mtext or mspace
export const MATH_FLAG_GROUPING = 0x40; // a grouping element: mrow, mstyle, mphantom, merror, semantics, maction, math
export const MATH_FLAG_CELL_ROW = 0x80; // an mtd: its content is an anonymous mrow
// LAYOUT_NODE_OFFSET_MATH_OPERATOR_FLAGS (mo only)
export const MATH_OPERATOR_STRETCHY = 0x01;
export const MATH_OPERATOR_SYMMETRIC = 0x02;
export const MATH_OPERATOR_LARGEOP = 0x04;
export const MATH_OPERATOR_MOVABLELIMITS = 0x08;
export const MATH_OPERATOR_VERTICAL = 0x10;
export const MATH_OPERATOR_HAS_GLYPH = 0x20; // the base code point maps to a glyph of the primary font
// LAYOUT_NODE_OFFSET_MATH_TAGS: two bits per length, MATH_LENGTH_* values;
// lspace bits 0-1, rspace 2-3, line thickness or mspace width 4-5, minsize 6-7,
// maxsize 8-9.
export const MATH_LENGTH_DEFAULT = 0;
export const MATH_LENGTH_PX = 1;
export const MATH_LENGTH_PERCENT = 2;

// Grid track sizing-function kinds. G1 consumes LENGTH/PERCENT; later Grid
// slices use the remaining canonical wire values without changing the entry.
export const GRID_TRACK_LENGTH = 0;
export const GRID_TRACK_PERCENT = 1;
export const GRID_TRACK_FRACTION = 2;
export const GRID_TRACK_AUTO = 3;
export const GRID_TRACK_MIN_CONTENT = 4;
export const GRID_TRACK_MAX_CONTENT = 5;
export const GRID_TRACK_FIT_CONTENT = 6;
export const GRID_TRACK_AUTO_FILL = 8;
export const GRID_TRACK_AUTO_FIT = 9;
export const GRID_TRACK_FIT_CONTENT_PERCENT = 7;
export const GRID_TRACK_LENGTH_PERCENTAGE = 10;
export const GRID_TRACK_FIT_CONTENT_LENGTH_PERCENTAGE = 11;
export const GRID_PLACEMENT_AUTO = 0;
export const GRID_PLACEMENT_LINE = 1;
export const GRID_PLACEMENT_SPAN = 2;

// line-height tags (Slice 6). Mirrors the width/height size-tag pattern.
export const LINE_HEIGHT_NORMAL = 0; // font's own metrics-derived value
export const LINE_HEIGHT_LENGTH = 1; // explicit px
export const LINE_HEIGHT_NUMBER = 2; // unitless multiplier × fontSize
// vertical-align tags shared by inline layout and future table-cell layout.
export const VERTICAL_ALIGN_BASELINE = 0;
export const VERTICAL_ALIGN_MIDDLE = 1;
export const VERTICAL_ALIGN_SUB = 2;
export const VERTICAL_ALIGN_SUPER = 3;
export const VERTICAL_ALIGN_TOP = 4;
export const VERTICAL_ALIGN_BOTTOM = 5;
export const VERTICAL_ALIGN_TEXT_TOP = 6;
export const VERTICAL_ALIGN_TEXT_BOTTOM = 7;
export const VERTICAL_ALIGN_LENGTH = 8;
export const VERTICAL_ALIGN_PERCENT = 9;

// text-align values (Slice 6).
export const TEXT_ALIGN_LEFT = 0;
export const TEXT_ALIGN_CENTER = 1;
export const TEXT_ALIGN_RIGHT = 2;

// font-style values (Slice 6). Matches CMD_TEXT_OFFSET_STYLE's encoding.
export const FONT_STYLE_NORMAL = 0;
export const FONT_STYLE_ITALIC = 1;

// position values.
export const POSITION_STATIC = 0;
export const POSITION_RELATIVE = 1;
export const POSITION_ABSOLUTE = 2;
// Out of flow like absolute (out-of-flow checks are `position >= ABSOLUTE`)
// but the containing block is ALWAYS the viewport — see POS_FIXED's doc in
// engine.wat (Slice 7A).
export const POSITION_FIXED = 3;
// Author-facing serializer value. The writer lowers it to relative layout
// plus LAYOUT_NODE_OFFSET_POSITION_STICKY for paint-time clamping.
export const POSITION_STICKY = 4;

// box-sizing values.
export const BOX_SIZING_CONTENT = 0;
export const BOX_SIZING_BORDER = 1;

// mix-blend-mode values (Slice 8C). Order matches the CSS Compositing and
// Blending spec's canonical list: NORMAL, then the 11 separable modes
// (simple per-channel formulas), then the 4 non-separable ones (need
// HSL-space SetLum/SetSat helpers — see rasterize.js's COMPOSITE_SHADER).
export const BLEND_NORMAL = 0;
export const BLEND_MULTIPLY = 1;
export const BLEND_SCREEN = 2;
export const BLEND_OVERLAY = 3;
export const BLEND_DARKEN = 4;
export const BLEND_LIGHTEN = 5;
export const BLEND_COLOR_DODGE = 6;
export const BLEND_COLOR_BURN = 7;
export const BLEND_HARD_LIGHT = 8;
export const BLEND_SOFT_LIGHT = 9;
export const BLEND_DIFFERENCE = 10;
export const BLEND_EXCLUSION = 11;
export const BLEND_HUE = 12;
export const BLEND_SATURATION = 13;
export const BLEND_COLOR = 14;
export const BLEND_LUMINOSITY = 15;

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
export const LAYOUT_FLAG_HAS_BACKGROUND = 0x0001;
export const LAYOUT_FLAG_HAS_BORDER = 0x0002;
// Per-axis visual clipping is distinct from per-axis programmatic
// scrollability. overflow:clip sets only the clip bit; hidden/auto/scroll set
// both. This also keeps BFC establishment independent from either behavior.
export const LAYOUT_FLAG_CLIPS_OVERFLOW_X = 0x0004;
export const LAYOUT_FLAG_CLIPS_OVERFLOW_Y = 0x0008;
export const LAYOUT_FLAG_HAS_OPACITY = 0x0010;
export const LAYOUT_FLAG_HAS_TRANSFORM = 0x0020;
export const LAYOUT_FLAG_HAS_IMAGE = 0x0040;
export const LAYOUT_FLAG_HAS_SVG = 0x0080;
export const LAYOUT_FLAG_HAS_BOX_SHADOW = 0x0100;
// design/inline-layout.md: this block's children are an inline formatting
// context (display:'text'/'inline' siblings) — $layoutBlock/$computeIntrinsic/
// $paintFlow all dispatch on this BEFORE their generic child-recursion paths.
export const LAYOUT_FLAG_IS_INLINE_CTX = 0x0200;
export const LAYOUT_FLAG_HAS_GRADIENT = 0x0400;
// 0x0800 and 0x1000 were LAYOUT_FLAG_MARGIN_LEFT_AUTO / _RIGHT_AUTO; the
// four auto-margin edges moved into LAYOUT_NODE_OFFSET_MARGIN_AUTO when flex
// §8.1 needed the block pair too (two bits here could not carry four edges).
// A <textarea>: auto width and height resolve from LAYOUT_NODE_OFFSET_TEXTAREA_*.
export const LAYOUT_FLAG_TEXTAREA = 0x0800;
// A menulist <select>: its min- and max-content width is its widest line
// (the widest option label) rounded up to a whole CSS pixel.
export const LAYOUT_FLAG_MENULIST = 0x1000;
export const LAYOUT_FLAG_ESTABLISHES_BFC = 0x2000; // overflow!=visible / flow-root: no margin collapse w/ children
export const LAYOUT_FLAG_SCROLLABLE_OVERFLOW_X = 0x4000;
export const LAYOUT_FLAG_SCROLLABLE_OVERFLOW_Y = 0x8000;

// margin-*: auto edge bits (LAYOUT_NODE_OFFSET_MARGIN_AUTO), CSS edge order.
export const MARGIN_AUTO_TOP = 0x01;
export const MARGIN_AUTO_RIGHT = 0x02;
export const MARGIN_AUTO_BOTTOM = 0x04;
export const MARGIN_AUTO_LEFT = 0x08;

// NODE_INHERITED_MASK bits.
export const INHERITED_MASK_TEXT_COLOR = 0x01;
export const INHERITED_MASK_VISIBILITY = 0x02;
export const INHERITED_MASK_FONT_SIZE = 0x04;
export const INHERITED_MASK_LINE_HEIGHT = 0x08;

// =======================================================================
// Command buffer (512 KB at 0x42B40)
// =======================================================================
//
// Binary draw commands. Written by WASM, read by JS rasterizer.
// Each command is a variable-size record prefixed by a 1-byte opcode.
//
// 512 KB is generous for most documents. For very complex renders,
// this region can grow into the growable area.

export const COMMAND_BUFFER_BASE = 0x001A4840;
export const COMMAND_BUFFER_SIZE = 0x00080000; // 512 KB

// --- Command opcodes ---
// Retained raster execution-plan ABI. Every offset is relative to the plan
// handle; records and payloads therefore remain valid after memory growth.
export const RASTER_PLAN_ABI_VERSION = 5;
export const RASTER_PLAN_MAGIC = 0x4C505253; // "SRPL" little-endian
export const RASTER_PLAN_HEADER_SIZE = 96;
export const RASTER_PLAN_RECORD_SIZE = 56;
export const RASTER_PLAN_CLIP_FLOATS = 160;
export const RASTER_PLAN_CLIP_PATH_MASK_FLOATS = 24;
export const RASTER_PLAN_CLIP_ENTRY_SIZE = 756;
export const RASTER_PLAN_NO_CLIP = 0xFFFFFFFF;
// A host scrollbar row (raster_plan_prepare and raster_plan_rescroll), all
// f32: the engine node whose CMD_SCROLLBAR marker paints it (-1 for the
// viewport's), x, y, width, height in viewport CSS px, r, g, b, a, and one
// corner radius in CSS px. A marker's rows paint back to front.
export const RASTER_PLAN_SCROLLBAR_ROW_SIZE = 40;

export const RASTER_PLAN_OFFSET_TOTAL_BYTES = 8;
export const RASTER_PLAN_OFFSET_RECORD_COUNT = 12;
export const RASTER_PLAN_OFFSET_SOURCE_BYTES = 16;
export const RASTER_PLAN_OFFSET_RECORD_TABLE = 20;
export const RASTER_PLAN_OFFSET_RECORD_STRIDE = 24;
export const RASTER_PLAN_OFFSET_FEATURE_BITS = 28;
export const RASTER_PLAN_OFFSET_SOURCE_REVISION = 32;
export const RASTER_PLAN_OFFSET_WIDTH = 36;
export const RASTER_PLAN_OFFSET_HEIGHT = 40;
export const RASTER_PLAN_OFFSET_DEVICE_SCALE = 44;
export const RASTER_PLAN_OFFSET_RENDER_MODE = 48;
export const RASTER_PLAN_OFFSET_CLIP_TABLE = 52;
export const RASTER_PLAN_OFFSET_CLIP_COUNT = 56;
export const RASTER_PLAN_OFFSET_PAYLOAD_REGION = 60;
export const RASTER_PLAN_OFFSET_PAYLOAD_BYTES = 64;
export const RASTER_PLAN_OFFSET_VISIBLE_X = 68;
export const RASTER_PLAN_OFFSET_VISIBLE_Y = 72;
export const RASTER_PLAN_OFFSET_CULL_WIDTH = 76;
export const RASTER_PLAN_OFFSET_CULL_HEIGHT = 80;
export const RASTER_PLAN_FEATURE_RECT_NATIVE = 1 << 0;
export const RASTER_PLAN_FEATURE_IMAGE_NATIVE = 1 << 1;
export const RASTER_PLAN_FEATURE_GRADIENT_NATIVE = 1 << 2;
export const RASTER_PLAN_FEATURE_SHADOW_NATIVE = 1 << 3;
export const RASTER_PLAN_BOX_SHADOW_INSTANCE_FLOATS = 36;
export const RASTER_PLAN_IMAGE_INSTANCE_FLOATS = 18;
export const RASTER_PLAN_GRADIENT_RECORD_BYTES = 48;
export const RASTER_PLAN_GRADIENT_STOP_BYTES = 48;
export const RASTER_PLAN_FEATURE_TEXT_NATIVE = 1 << 4;
export const RASTER_PLAN_FEATURE_SVG_PATH_NATIVE = 1 << 5;
export const RASTER_PLAN_TEXT_INSTANCE_FLOATS = 20;
export const RASTER_PLAN_SVG_PATH_INSTANCE_FLOATS = 23;
export const RASTER_PLAN_FEATURE_GROUP_NATIVE = 1 << 6;
export const RASTER_PLAN_FEATURE_FILTER_NATIVE = 1 << 7;
export const RASTER_PLAN_FEATURE_MASK_NATIVE = 1 << 8;
export const RASTER_PLAN_GROUP_PUSH_FLOATS = 4;
export const RASTER_PLAN_GROUP_POP_FLOATS = 214;
export const RASTER_PLAN_FILTER_LIST_OFFSET = 16;
export const RASTER_PLAN_FILTER_DESCRIPTOR_BYTES = 12;
export const RASTER_PLAN_FILTER_UNIFORM_SLOT_BYTES = 80;
export const RASTER_PLAN_PASS_MATRIX = 1;
export const RASTER_PLAN_PASS_BOX_BLUR_H = 2;
export const RASTER_PLAN_PASS_BOX_BLUR_V = 3;
export const RASTER_PLAN_PASS_DROP_SHADOW = 4;
export const RASTER_PLAN_PASS_MASK_COMBINE = 5;
export const RASTER_PLAN_RECORD_FLAG_NEEDS_BACKDROP_COPY = 1 << 8;

export const RASTER_PLAN_RECORD_OFFSET_KIND = 0;
export const RASTER_PLAN_RECORD_OFFSET_FLAGS = 2;
export const RASTER_PLAN_RECORD_OFFSET_SOURCE = 4;
export const RASTER_PLAN_RECORD_OFFSET_SOURCE_BYTES = 8;
export const RASTER_PLAN_RECORD_OFFSET_CLIP = 12;
export const RASTER_PLAN_RECORD_OFFSET_PAYLOAD = 16;
export const RASTER_PLAN_RECORD_OFFSET_PAYLOAD_BYTES = 20;
export const RASTER_PLAN_RECORD_OFFSET_INSTANCE_COUNT = 24;
export const RASTER_PLAN_RECORD_OFFSET_RESOURCE = 28;
export const RASTER_PLAN_RECORD_OFFSET_GRADIENT = 32;
export const RASTER_PLAN_RECORD_OFFSET_GRADIENT_BYTES = 36;
// The extent of the target a record's draw can write, in target device
// pixels: f32 minimum x, minimum y, maximum x, maximum y. A drawing record
// (rect, text, image, box shadow, SVG path) holds the union of its
// instances' quads grown by one pixel; every other record is unbounded,
// -Infinity..Infinity (raster-plan.watpart $rasterPlanWriteRecordBounds).
export const RASTER_PLAN_RECORD_OFFSET_BOUNDS = 40;

export const RASTER_RESOURCE_GLYPH = 1;
export const RASTER_RESOURCE_PATH = 2;
export const RASTER_RESOURCE_IMAGE = 3;
export const RASTER_RESOURCE_GLYPH_ROW_SIZE = 64;
export const GLYPH_REQUEST_HEADER_SIZE = 8;
export const GLYPH_REQUEST_ROW_SIZE = 16;


export const CMD_RECT = 0x01;
export const CMD_TEXT = 0x02;
export const CMD_IMAGE = 0x03;
export const CMD_BOX_SHADOW = 0x04;
export const CMD_PUSH_CLIP = 0x05;
export const CMD_POP_CLIP = 0x06;
export const CMD_PUSH_OPACITY = 0x07;
export const CMD_POP_OPACITY = 0x08;
// 0x09 was CMD_SVG_RECT/CIRCLE/ELLIPSE/LINE/POLYGON/POLYLINE (0x09-0x0E) —
// declared at S1's start, never emitted (Tier A shapes lower to CMD_RECT
// instead, see design/svg-rendering.md). Reclaimed for Tier B's CMD_SVG_PATH.
export const CMD_SVG_PATH = 0x09;
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
export const CMD_PUSH_BACKDROP_FILTER = 0x0A;
export const CMD_POP_BACKDROP_FILTER = 0x0B;
// P11 (mask): the mask layer list's own bracket + the per-layer bracket.
// See the "Push/pop mask" format block below.
export const CMD_PUSH_MASK = 0x0C;
export const CMD_PUSH_MASK_LAYER = 0x0D;
export const CMD_POP_MASK_LAYER = 0x0E;
// P13 (background-blend-mode): the background stack's own group, plus a
// per-layer bracket for a layer whose blend mode is non-normal. See the
// "Push/pop background" format block below.
export const CMD_PUSH_BACKGROUND = 0x0F;
export const CMD_PUSH_BLEND_LAYER = 0x10;
export const CMD_POP_BLEND_LAYER = 0x11;
export const CMD_POP_BACKGROUND = 0x12;
// Inspection-only source marker. The renderer ignores this command. Paint
// artifact capture uses it to map subsequent draw commands to a scene node
// without changing any draw-command byte layout.
export const CMD_SET_NODE = 0x13;
export const CMD_SET_NODE_SIZE = 8;
export const CMD_SET_NODE_OFFSET_INDEX = 0x04; // u32
// D2 piece B (scroll-layer compositing, design/layout-engine.md):
// select the current scroll-table entry. Every geometry payload after
// this record is unshifted by the referenced scroller chain's cumulative
// offset; a walker resolves `final = M(payload) + scrollTable[ref]`.
// ref 0 is the reserved zero offset (no scroller / fixed subtree).
export const CMD_SET_SCROLL = 0x14;
export const CMD_SET_SCROLL_SIZE = 8;
export const CMD_SET_SCROLL_OFFSET_REF = 0x02; // u16: SCROLL_TABLE index
// Raster-plan-only replay scissor. Payload rows are {x, y, width, height}
// device-pixel rectangles; this opcode never appears in command bytes.
export const CMD_DAMAGE = 0x15;
// A scroll container's scrollbars, in its outline turn under its ancestors'
// clips (engine-paint.watpart $emitScrollbarMarker): u32 engine node at
// offset 4, or 0xFFFFFFFF for the viewport's, painted after every layer.
// The raster plan expands it from the frame's scrollbar rows.
export const CMD_SCROLLBAR = 0x16;
export const CMD_SCROLLBAR_SIZE = 8;
export const CMD_SCROLLBAR_OFFSET_NODE = 0x04; // u32

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
export const CMD_RECT_SIZE = 148; // no transform, no gradient
export const CMD_RECT_SIZE_XFORM = 172; // transform, no gradient (also equals gradient-without-transform's size — see cmdRectSize())
export const CMD_RECT_OFFSET_FLAGS = 0x01; // u8
// P7 border-style: the four sides' BORDER_STYLE_* values packed as 4-bit
// nibbles into the previously-padded u16 at 0x02 —
// top | right<<4 | bottom<<8 | left<<12. 0 = all solid (pre-P7 wire
// compatibility: writers always zeroed this).
export const CMD_RECT_OFFSET_BORDER_STYLES = 0x02; // u16
export const CMD_RECT_OFFSET_X = 0x04; // f32
export const CMD_RECT_OFFSET_Y = 0x08; // f32
export const CMD_RECT_OFFSET_W = 0x0C; // f32
export const CMD_RECT_OFFSET_H = 0x10; // f32
export const CMD_RECT_OFFSET_FILL = 0x14; // f32[4]
export const CMD_RECT_OFFSET_BORDER_COLOR_TOP = 0x24; // f32[4]
export const CMD_RECT_OFFSET_BORDER_COLOR_RIGHT = 0x34; // f32[4]
export const CMD_RECT_OFFSET_BORDER_COLOR_BOTTOM = 0x44; // f32[4]
export const CMD_RECT_OFFSET_BORDER_COLOR_LEFT = 0x54; // f32[4]
export const CMD_RECT_OFFSET_BORDER_TOP = 0x64; // f32 border width, top
export const CMD_RECT_OFFSET_BORDER_RIGHT = 0x68; // f32
export const CMD_RECT_OFFSET_BORDER_BOTTOM = 0x6C; // f32
export const CMD_RECT_OFFSET_BORDER_LEFT = 0x70; // f32
export const CMD_RECT_OFFSET_RADIUS_TOP_LEFT_X = 0x74; // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_TOP_LEFT_Y = 0x78; // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_X = 0x7C; // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_TOP_RIGHT_Y = 0x80; // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_X = 0x84; // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_BOTTOM_RIGHT_Y = 0x88; // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_X = 0x8C; // f32 (P10)
export const CMD_RECT_OFFSET_RADIUS_BOTTOM_LEFT_Y = 0x90; // f32 (P10)
export const CMD_RECT_OFFSET_XFORM = 0x94; // f32[6] (only if flag set)

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
export const CMD_RECT_GRADIENT_EXT_SIZE = 40;
export const CMD_RECT_GRADIENT_OFFSET_KIND = 0x00; // u8
export const CMD_RECT_GRADIENT_OFFSET_STOP_COUNT = 0x01; // u8
export const CMD_RECT_GRADIENT_OFFSET_FLAGS = 0x02; // u8: bit0=tiled
export const CMD_RECT_GRADIENT_OFFSET_STOP_OFFSET = 0x04; // u32
export const CMD_RECT_GRADIENT_OFFSET_INTERPOLATION = 0x03; // u8: packed space + hue method
export const CMD_RECT_GRADIENT_OFFSET_GEOM = 0x08; // f32[4]
export const CMD_RECT_GRADIENT_OFFSET_ORIGIN = 0x18; // f32[4] {dx,dy,w,h}

// Rect flags
export const CMD_RECT_FLAG_FILL = 0x01;
export const CMD_RECT_FLAG_BORDER = 0x02;
export const CMD_RECT_FLAG_GRADIENT = 0x04;
export const CMD_RECT_FLAG_TRANSFORM = 0x08;
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
export const CMD_RECT_FLAG_NO_PIXEL_SNAP = 0x10;
// SVG shape geometry also carries this one: its edges take the exact
// pixel-area coverage SVG paint is judged by (test/helpers/svg-truth.js),
// where a CSS box keeps the smoothstep ramp its Chrome parity was measured
// with. A smoothstep departs from area coverage by up to 0.096 where an
// edge runs horizontal or vertical on screen (measured: a rotated circle's
// topmost and bottommost pixels, 18-21 bytes off the source truth). The
// raster plan carries it to the rect shader as bit 16 of the styles word.
export const CMD_RECT_FLAG_AREA_COVERAGE = 0x20;
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
export const CMD_RECT_FLAG_SVG_STROKE = 0x40;

// Byte size / gradient-extension offset for a CMD_RECT record, given its
// two independent flag bits. The ONLY functions that should ever compute
// these — every reader/writer (commandByteSize, commands.js, rasterize.js,
// engine.wat's four independent CMD_RECT emit sites) must agree, so derive
// from here rather than re-deriving inline.
export function cmdRectSize(hasTransform, hasGradient) {
  return CMD_RECT_SIZE + (hasTransform ? 24 : 0) +
    (hasGradient ? CMD_RECT_GRADIENT_EXT_SIZE : 0);
}
export function cmdRectGradientOffset(hasTransform) {
  return CMD_RECT_OFFSET_XFORM + (hasTransform ? 24 : 0);
}

// --- Push clip command (0x05) ---
// Replaces the rasterizer's CURRENT clip state with a complete,
// self-contained LIST of clip entries (oriented-clip redesign): a 4-byte
// header (opcode, reserved flags, entry count) followed by count fixed-size
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
export const CMD_PUSH_CLIP_HEADER_SIZE = 4;
export const CMD_PUSH_CLIP_OFFSET_FLAGS = 0x01; // u8: reserved, 0
export const CMD_PUSH_CLIP_OFFSET_COUNT = 0x02; // u8: entry count
export const CLIP_ENTRY_SIZE = 80; // 4 flags/pad + 16 rect + 32 radii + 24 affine + 4 pad
export const CLIP_ENTRY_OFFSET_FLAGS = 0x00; // u8
export const CLIP_ENTRY_OFFSET_X = 0x04; // f32
export const CLIP_ENTRY_OFFSET_Y = 0x08; // f32
export const CLIP_ENTRY_OFFSET_W = 0x0C; // f32
export const CLIP_ENTRY_OFFSET_H = 0x10; // f32
export const CLIP_ENTRY_OFFSET_RADII = 0x14; // f32[8]
export const CLIP_ENTRY_OFFSET_AFFINE = 0x34; // f32[6]
export const CLIP_ENTRY_FLAG_ENABLED_X = 0x01;
export const CLIP_ENTRY_FLAG_ENABLED_Y = 0x02;
export const CLIP_ENTRY_FLAG_AFFINE = 0x04;
export const CLIP_ENTRY_FLAG_PATH_MASK = 0x08;
export const CLIP_ENTRY_FLAG_AREA = 0x10;
// The affine translation is a color glyph's origin, snapped as
// CMD_SVG_PATH_FLAG_GLYPH_ORIGIN snaps it.
export const CLIP_ENTRY_FLAG_GLYPH_ORIGIN = 0x20;
// D2 piece B: the scroll-table index whose offset positions this entry
// (clip geometry is unshifted like every other payload). Lives in the
// entry's trailing pad, so CLIP_ENTRY_SIZE is unchanged.
export const CLIP_ENTRY_OFFSET_SCROLL_REF = 0x4C; // u16
// Hard cap on one wire list's entry count (distinct transform spaces with
// active clips on one paint path). The engine traps at append time rather
// than truncating; the count byte could carry 255 but nothing real nests
// this deep.
export const CLIP_LIST_MAX_ENTRIES = 64;
export function cmdPushClipSize(entryCount) {
  return CMD_PUSH_CLIP_HEADER_SIZE + entryCount * CLIP_ENTRY_SIZE;
}

// --- Pop clip command (0x06) ---
// 1 byte: just the opcode. Pops the clip stack.
export const CMD_POP_CLIP_SIZE = 4; // padded to 4-byte alignment

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
export const CMD_PUSH_OPACITY_SIZE = 24; // no filter segments
export const CMD_PUSH_OPACITY_OFFSET_FLAGS = 0x01; // u8: hasClip (bit 0, dead/unused);
// BLEND_* enum in bits 1-4 (Slice 8C)
export const CMD_PUSH_OPACITY_FLAG_BLEND_SHIFT = 1;
export const CMD_PUSH_OPACITY_FLAG_BLEND_MASK = 0x1E; // bits 1-4
// P11: this group's content is MASKED — its CMD_POP_OPACITY multiplies
// the group texture's alpha by the top mask accumulator (built by the
// CMD_PUSH_MASK / CMD_PUSH_MASK_LAYER records emitted just before this
// push) and pops it.
export const CMD_PUSH_OPACITY_FLAG_MASK = 0x20; // bit 5
export const CMD_PUSH_OPACITY_OFFSET_SEGMENT_COUNT = 0x02; // u16 (P8, 0 = no filter)
export const CMD_PUSH_OPACITY_OFFSET_ALPHA = 0x14; // f32
// u8: the Porter-Duff operator the pop composites the group with, on
// premultiplied color over the whole target: COMPOSITE_SOURCE_OVER (0)
// composites with the blend mode; any other reads the target's pixels
// (a backdrop copy) and replaces them, clip coverage mixing the result
// with the backdrop. Color glyph composites (COLRv1 PaintComposite) emit
// them; numbering follows hb_paint_composite_mode_t's Porter-Duff modes.
export const CMD_PUSH_OPACITY_OFFSET_COMPOSITE = 0x04;
export const COMPOSITE_SOURCE_OVER = 0;
export const COMPOSITE_CLEAR = 1;
export const COMPOSITE_SOURCE = 2;
export const COMPOSITE_DESTINATION = 3;
export const COMPOSITE_DESTINATION_OVER = 4;
export const COMPOSITE_SOURCE_IN = 5;
export const COMPOSITE_DESTINATION_IN = 6;
export const COMPOSITE_SOURCE_OUT = 7;
export const COMPOSITE_DESTINATION_OUT = 8;
export const COMPOSITE_SOURCE_ATOP = 9;
export const COMPOSITE_DESTINATION_ATOP = 10;
export const COMPOSITE_XOR = 11;
export const COMPOSITE_PLUS = 12;
// Filter-segment array starts here, CMD_PUSH_OPACITY_SEGMENT_SIZE bytes
// per entry, SEGMENT_COUNT entries (P8). Every segment is fixed-size
// (sized to the larger MATRIX variant) regardless of kind — uniform
// stride keeps the walk trivial, same "fixed-stride-per-entry" choice
// as SHADOW_POOL/FILTER_POOL over a variable-size packing.
export const CMD_PUSH_OPACITY_OFFSET_SEGMENTS = 0x18;
export const CMD_PUSH_OPACITY_SEGMENT_SIZE = 84; // 4 (header) + 80 (20 f32, MATRIX's own size)
export const CMD_PUSH_OPACITY_SEGMENT_OFFSET_KIND = 0x00; // u8
export const CMD_PUSH_OPACITY_SEGMENT_OFFSET_PAYLOAD = 0x04; // MATRIX: f32[20] row-major 4x5
// (R0..R3,RC, G..., B..., A...);
// BLUR: f32 sigmaX, sigmaY at payload[0..1];
// DROP_SHADOW: dx,dy,sigmaX f32 at
// payload[0..2] + color f32[4] at
// payload[3..6] (mirrors FILTER_POOL's
// own drop-shadow entry layout) + sigmaY
// f32 at payload[7]. Lengths are CSS px,
// already mapped through the element's
// transform by $composeFilterSegments.
export const CMD_PUSH_OPACITY_SEGMENT_KIND_MATRIX = 1;
export const CMD_PUSH_OPACITY_SEGMENT_KIND_BLUR = 2;
export const CMD_PUSH_OPACITY_SEGMENT_KIND_DROP_SHADOW = 3;

export function cmdPushOpacitySize(segmentCount) {
  return CMD_PUSH_OPACITY_SIZE + segmentCount * CMD_PUSH_OPACITY_SEGMENT_SIZE;
}

// --- Pop opacity command (0x08) ---
export const CMD_POP_OPACITY_SIZE = 4; // padded to 4-byte alignment

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
export const CMD_PUSH_BACKDROP_FILTER_SIZE = 8; // opcode(1) + pad(1) + segmentCount(2) + pad(4)
export const CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENT_COUNT = 0x02; // u16
export const CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS = 0x08;

export function cmdPushBackdropFilterSize(segmentCount) {
  return CMD_PUSH_BACKDROP_FILTER_SIZE +
    segmentCount * CMD_PUSH_OPACITY_SEGMENT_SIZE + CLIP_ENTRY_SIZE;
}
// Offset of the trailing own-shape CLIP_ENTRY record, past the segment list.
export function cmdPushBackdropFilterOwnShapeOffset(segmentCount) {
  return CMD_PUSH_BACKDROP_FILTER_OFFSET_SEGMENTS +
    segmentCount * CMD_PUSH_OPACITY_SEGMENT_SIZE;
}

export const CMD_POP_BACKDROP_FILTER_SIZE = 4; // padded to 4-byte alignment

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
export const CMD_PUSH_MASK_SIZE = 4;
// One mask layer: everything between the push and the pop draws into a
// scratch target, which CMD_POP_MASK_LAYER converts to coverage (per
// MASK_MODE_*) and composites into the accumulator (per MASK_COMPOSITE_*).
// A whole-layer scratch is load-bearing, not a convenience: subtract/
// intersect/exclude must change the accumulator where the layer does NOT
// paint, which per-draw blend state cannot express.
export const CMD_PUSH_MASK_LAYER_SIZE = 4;
export const CMD_PUSH_MASK_LAYER_OFFSET_MODE = 0x01; // u8: MASK_MODE_*
export const CMD_PUSH_MASK_LAYER_OFFSET_COMPOSITE = 0x02; // u8: MASK_COMPOSITE_*
export const CMD_POP_MASK_LAYER_SIZE = 4;

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
export const CMD_PUSH_BACKGROUND_SIZE = 4;
export const CMD_POP_BACKGROUND_SIZE = 4;
// One layer whose blend mode is non-normal: everything between the push
// and the pop draws into a scratch, which the pop then draws over the
// accumulator through the COMPOSITE pipeline at this blend mode (the pop
// snapshots the accumulator as the backdrop first — popOpacity's existing
// blend path verbatim). A normal-blend layer needs neither bracket nor
// scratch and draws straight into the accumulator.
export const CMD_PUSH_BLEND_LAYER_SIZE = 4;
export const CMD_PUSH_BLEND_LAYER_OFFSET_MODE = 0x01; // u8: BLEND_* enum
export const CMD_POP_BLEND_LAYER_SIZE = 4;

// mask-mode (css-masking-1 §5.3). match-source resolves to alpha here:
// the only mask sources sandom has are images and gradients, whose
// match IS alpha (match-source's luminance branch is for <mask> element
// references, which need the DOM layer).
export const MASK_MODE_MATCH_SOURCE = 0; // CSS initial
export const MASK_MODE_ALPHA = 1;
export const MASK_MODE_LUMINANCE = 2;

// mask-composite (css-masking-1 §5.7), applied between a layer and the
// accumulated result of every layer below it. Coverage rides in ALPHA,
// so each mode is an ordinary alpha blend state — see rasterize.js's
// MASK_COMPOSITE_BLEND for the factor pairs.
export const MASK_COMPOSITE_ADD = 0; // CSS initial
export const MASK_COMPOSITE_SUBTRACT = 1;
export const MASK_COMPOSITE_INTERSECT = 2;
export const MASK_COMPOSITE_EXCLUDE = 3;

// mask-origin / mask-clip. NOTE both enums differ from the background-*
// ones they mirror: mask-origin's CSS initial is BORDER-box (background-
// origin's is padding-box) and mask-clip adds no-clip. Each puts its own
// CSS initial at 0 so a zeroed pool entry reads as the CSS defaults.
export const MASK_ORIGIN_BORDER_BOX = 0; // CSS initial
export const MASK_ORIGIN_PADDING_BOX = 1;
export const MASK_ORIGIN_CONTENT_BOX = 2;
export const MASK_CLIP_BORDER_BOX = 0; // CSS initial
export const MASK_CLIP_PADDING_BOX = 1;
export const MASK_CLIP_CONTENT_BOX = 2;
export const MASK_CLIP_NO_CLIP = 3;

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
export const CMD_BOX_SHADOW_SIZE = 72; // no transform, no border-box ext
export const CMD_BOX_SHADOW_SIZE_XFORM = 96; // transform, no border-box ext
export const CMD_BOX_SHADOW_INSET_EXT_SIZE = 48; // borderBoxRect(4)+radii(8) = 12 floats
export const CMD_BOX_SHADOW_OFFSET_FLAGS = 0x01; // u8
export const CMD_BOX_SHADOW_OFFSET_X = 0x04; // f32
export const CMD_BOX_SHADOW_OFFSET_Y = 0x08; // f32
export const CMD_BOX_SHADOW_OFFSET_W = 0x0C; // f32
export const CMD_BOX_SHADOW_OFFSET_H = 0x10; // f32
export const CMD_BOX_SHADOW_OFFSET_RADII = 0x14; // f32[8], see above
export const CMD_BOX_SHADOW_OFFSET_COLOR = 0x34; // f32[4]
export const CMD_BOX_SHADOW_OFFSET_BLUR_SIGMA = 0x44; // f32
export const CMD_BOX_SHADOW_OFFSET_XFORM = 0x48; // f32[6], only if flag set
// Inset border-box extension field offsets, RELATIVE to the extension's
// own start (cmdBoxShadowInsetClipOffset()) — mirrors CMD_RECT_GRADIENT_
// OFFSET_*'s own "offsets relative to the extension block" convention.
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_X = 0x00; // f32
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_Y = 0x04; // f32
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_W = 0x08; // f32
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_H = 0x0C; // f32
export const CMD_BOX_SHADOW_INSET_OFFSET_BORDER_BOX_RADII = 0x10; // f32[8]

export const CMD_BOX_SHADOW_FLAG_INSET = 0x01;
export const CMD_BOX_SHADOW_FLAG_TRANSFORM = 0x02;
export const CMD_BOX_SHADOW_FLAG_BORDER_BOX = 0x04;

// Byte size / border-box-extension offset for a CMD_BOX_SHADOW record,
// given its flag bits — mirrors cmdRectSize()/cmdRectGradientOffset()'s
// own "single source of truth" rationale (every reader/writer must agree
// on these, so derive from here rather than re-deriving inline). The
// extension is present for an inset shadow or a border-box-flagged one.
export function cmdBoxShadowSize(hasTransform, hasBorderBox) {
  return CMD_BOX_SHADOW_SIZE + (hasTransform ? 24 : 0) +
    (hasBorderBox ? CMD_BOX_SHADOW_INSET_EXT_SIZE : 0);
}
export function cmdBoxShadowInsetClipOffset(hasTransform) {
  return CMD_BOX_SHADOW_OFFSET_XFORM + (hasTransform ? 24 : 0);
}

// --- Text command (0x02) ---
export const CMD_TEXT_SIZE = 60; // without transform
export const CMD_TEXT_SIZE_XFORM = 84; // with transform
export const CMD_TEXT_OFFSET_FLAGS = 0x01; // u8
export const CMD_TEXT_OFFSET_GCOUNT = 0x02; // u16 glyph count
export const CMD_TEXT_OFFSET_GOFF = 0x04; // u32 glyph buffer offset
export const CMD_TEXT_OFFSET_X = 0x08; // f32
export const CMD_TEXT_OFFSET_Y = 0x0C; // f32
export const CMD_TEXT_OFFSET_FSIZE = 0x10; // f32 fontSize
export const CMD_TEXT_OFFSET_LH = 0x14; // f32 lineHeight
export const CMD_TEXT_OFFSET_BL = 0x18; // f32 baseline
export const CMD_TEXT_OFFSET_COLOR = 0x1C; // f32[4]
export const CMD_TEXT_OFFSET_UPEM = 0x2C; // u16
export const CMD_TEXT_OFFSET_FONT = 0x2E; // u16 fontIndex
export const CMD_TEXT_OFFSET_WEIGHT = 0x30; // u8
export const CMD_TEXT_OFFSET_STYLE = 0x31; // u8 (0=normal, 1=italic)
export const CMD_TEXT_OFFSET_ASCENT = 0x34; // f32 line-box ascent
export const CMD_TEXT_OFFSET_DESCENT = 0x38; // f32 line-box descent
export const CMD_TEXT_OFFSET_XFORM = 0x3C; // f32[6] (only if flag set)

// Text flags
export const CMD_TEXT_FLAG_TRANSFORM = 0x01;
export const CMD_TEXT_FLAG_TEXT_SHADOW = 0x02;

// text-shadow extension (P6): appended AFTER the transform block
// (present or not), same additive-blocks shape as CMD_RECT's gradient
// extension. One extension per command — a run with N text-shadows
// emits N shadow-flagged copies of its CMD_TEXT (referencing the SAME
// glyph span) before the plain ink command; see $expandTextShadowPasses.
// Offsets below are relative to the extension base (cmdTextShadowExtOffset).
export const CMD_TEXT_SHADOW_EXT_SIZE = 28; // color(4) + offset(2) + sigma(1) f32s
export const CMD_TEXT_SHADOW_OFFSET_COLOR = 0x00; // f32[4]
export const CMD_TEXT_SHADOW_OFFSET_OFFSET_X = 0x10; // f32
export const CMD_TEXT_SHADOW_OFFSET_OFFSET_Y = 0x14; // f32
export const CMD_TEXT_SHADOW_OFFSET_BLUR_SIGMA = 0x18; // f32 (CSS blur radius / 2, the P3-verified rule)

// Byte size / shadow-extension offset for a CMD_TEXT record — single
// source of truth, same rationale as cmdRectSize/cmdBoxShadowSize.
export function cmdTextSize(hasTransform, hasShadow) {
  return CMD_TEXT_SIZE + (hasTransform ? 24 : 0) +
    (hasShadow ? CMD_TEXT_SHADOW_EXT_SIZE : 0);
}
export function cmdTextShadowExtOffset(hasTransform) {
  return CMD_TEXT_SIZE + (hasTransform ? 24 : 0);
}

// --- Image command (0x03, Slice P5a) ---
// Textured quad: dest rect in the node's border box, source UV rect
// pre-computed by the ENGINE from object-fit/object-position
// (design/paint-coverage.md P5b) — the rasterizer only ever samples the
// given UV rect, it doesn't know what object-fit mode produced it.
export const CMD_IMAGE_SIZE = 36; // without transform
export const CMD_IMAGE_SIZE_XFORM = 60; // with transform
export const CMD_IMAGE_OFFSET_FLAGS = 0x01; // u8
export const CMD_IMAGE_OFFSET_INDEX = 0x02; // u16: IMAGE_TABLE index
export const CMD_IMAGE_OFFSET_X = 0x04; // f32: dest rect
export const CMD_IMAGE_OFFSET_Y = 0x08; // f32
export const CMD_IMAGE_OFFSET_W = 0x0C; // f32
export const CMD_IMAGE_OFFSET_H = 0x10; // f32
export const CMD_IMAGE_OFFSET_UV_X = 0x14; // f32: source UV rect (0..1)
export const CMD_IMAGE_OFFSET_UV_Y = 0x18; // f32
export const CMD_IMAGE_OFFSET_UV_W = 0x1C; // f32
export const CMD_IMAGE_OFFSET_UV_H = 0x20; // f32
export const CMD_IMAGE_OFFSET_XFORM = 0x24; // f32[6] (only if flag set)

// Image flags
export const CMD_IMAGE_FLAG_TRANSFORM = 0x01;
// image-rendering: pixelated (P10): the rasterizer samples this draw with
// a nearest-neighbor sampler clamped to mip level 0 (Chrome-faithful
// decimation on downscale too), instead of the linear+mipmap default.
export const CMD_IMAGE_FLAG_PIXELATED = 0x02;
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
export const CMD_IMAGE_FLAG_NO_PIXEL_SNAP = 0x04;
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
export const CMD_IMAGE_FLAG_ABUT_LEFT = 0x08;
export const CMD_IMAGE_FLAG_ABUT_TOP = 0x10;
export const CMD_IMAGE_FLAG_ABUT_RIGHT = 0x20;
export const CMD_IMAGE_FLAG_ABUT_BOTTOM = 0x40;
// A color glyph bitmap (plans/PLAN-color-glyphs.md slice 2): the command's
// X, Y, W, H are the glyph's em square above its origin (X, Y + H), the
// font size W = H, and the index is COLOR_GLYPH_IMAGE_INDEX_BASE + slot.
// The raster plan places the image from the strike metrics of the image
// resource (see COLOR_GLYPH_IMAGE_RESOURCE_COUNT) and snaps the origin as
// CMD_SVG_PATH_FLAG_GLYPH_ORIGIN does when the command has no transform.
export const CMD_IMAGE_FLAG_GLYPH_BITMAP = 0x80;
// CMD_IMAGE indices from COLOR_GLYPH_IMAGE_INDEX_BASE up to
// COLOR_GLYPH_CACHE_INDEX_BASE name color glyph bitmap slots (engine
// color_glyph_bitmap_*); IMAGE_TABLE indices stay below it.
export const COLOR_GLYPH_IMAGE_INDEX_BASE = 0x8000;
// The raster image resource of a glyph bitmap holds three 12-byte records:
// (width, height, kind) in texels as every image resource, then the image
// box in ems of the font size relative to the glyph origin, y down:
// (left, top, width), (height, whole pixel, 0); whole pixel 1 draws the
// origin at x rounded (sbix), 0 at Skia's quarter-pixel x (CBDT).
export const COLOR_GLYPH_IMAGE_RESOURCE_COUNT = 3;
// The color glyph cache (plans/PLAN-color-glyphs.md slice 3): a COLR glyph
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
export const COLOR_GLYPH_CACHE_INDEX_BASE = 0xC000;
export const COLOR_GLYPH_CACHE_CAPACITY = 0x3F00;
export const COLOR_GLYPH_CACHE_PAGE_INDEX_BASE = 0xFF00;
export const COLOR_GLYPH_CACHE_RESOURCE_COUNT = 4;

// --- SVG path command (0x09, design/svg-rendering.md Tier B) ---
// A textured quad through the MSDF pipeline, same shader FAMILY as
// CMD_TEXT (median-of-3-channel distance field) but a solid-color
// fragment path with no Skia-glyph-mask gamma remap (that's a text-
// rasterizer convention, not an SVG one — see rasterize.js's SVG_PATH_SHADER).
// UNLIKE CMD_IMAGE, the UV rect is NOT precomputed by the engine — the
// atlas doesn't exist until the host ensures it (msdfgen + the atlas
// cache run in the msdfgen wasm module, keyed by content + on-screen
// scale — see src/atlas.js's SvgPathAtlas wrapper and
// vendor/msdfgen-wasm-cpp/src/atlas.cpp), so the
// rasterizer resolves pathIndex -> atlas UV at DRAW time, same pattern
// CMD_TEXT's glyphId -> atlas lookup already uses. pathIndex is an
// opaque host-side handle (LAYOUT_NODE_OFFSET_SVG_PATH_INDEX, aliasing
// IMAGE_INDEX) — WAT never reads path content, only forwards it.
export const CMD_SVG_PATH_SIZE = 44; // without transform, without gradient
export const CMD_SVG_PATH_SIZE_XFORM = 68; // with transform, without gradient
export const CMD_SVG_PATH_OFFSET_FLAGS = 0x01; // u8
export const CMD_SVG_PATH_OFFSET_INDEX = 0x02; // u16: pathIndex (opaque JS handle)
export const CMD_SVG_PATH_OFFSET_X = 0x04; // f32: dest rect (viewport-transformed bbox)
export const CMD_SVG_PATH_OFFSET_Y = 0x08; // f32
export const CMD_SVG_PATH_OFFSET_W = 0x0C; // f32
export const CMD_SVG_PATH_OFFSET_H = 0x10; // f32
export const CMD_SVG_PATH_OFFSET_COLOR = 0x14; // f32[4]: fill color, fill-opacity folded into alpha
export const CMD_SVG_PATH_OFFSET_XFORM = 0x24; // f32[6] (only if flag set)

export const CMD_SVG_PATH_FLAG_TRANSFORM = 0x01;
// S7 step 2 (Tier B gradients): a fill command carries svgFillGradient, a
// stroke outline command svgStrokeGradient (the path node's one background
// layer). Same shape as CMD_RECT_FLAG_GRADIENT's own extension (see its own
// doc comment) — appended AFTER the transform block, present or not, per
// cmdSvgPathGradientOffset() below.
export const CMD_SVG_PATH_FLAG_GRADIENT = 0x02;
// A color glyph layer (plans/PLAN-color-glyphs.md): the transform's
// translation is the glyph's origin. The raster plan snaps it to the device
// pixel Skia draws a color glyph image at: floor(x + 1/8), floor(y + 1/2)
// (the integer part of Skia's quarter-pixel glyph position; measured
// against the pinned Chrome 2026-10-05).
export const CMD_SVG_PATH_FLAG_GLYPH_ORIGIN = 0x04;
export const CMD_SVG_PATH_GRADIENT_EXT_SIZE = 40;
export const CMD_SVG_PATH_GRADIENT_OFFSET_KIND = 0x00; // u8
export const CMD_SVG_PATH_GRADIENT_OFFSET_STOP_COUNT = 0x01; // u8
export const CMD_SVG_PATH_GRADIENT_OFFSET_FLAGS = 0x02; // u8: bit0=tiled (always 0 for SVG — paint servers pad)
export const CMD_SVG_PATH_GRADIENT_OFFSET_STOP_OFFSET = 0x04; // u32
export const CMD_SVG_PATH_GRADIENT_OFFSET_GEOM = 0x08; // f32[4]
export const CMD_SVG_PATH_GRADIENT_OFFSET_ORIGIN = 0x18; // f32[4] {dx,dy,w,h}: the fill path's box from the painted box's top-left

// Byte size / gradient-extension offset for a CMD_SVG_PATH record, given
// its two independent flag bits — same "every reader/writer agrees, no
// hand-derived inline size" discipline as cmdRectSize()/
// cmdRectGradientOffset() above.
export function cmdSvgPathSize(hasTransform, hasGradient) {
  return CMD_SVG_PATH_SIZE + (hasTransform ? 24 : 0) +
    (hasGradient ? CMD_SVG_PATH_GRADIENT_EXT_SIZE : 0);
}
export function cmdSvgPathGradientOffset(hasTransform) {
  return CMD_SVG_PATH_OFFSET_XFORM + (hasTransform ? 24 : 0);
}

// Color glyphs (plans/PLAN-color-glyphs.md, engine-color-glyph.watpart).
// A CMD_SVG_PATH index from COLOR_GLYPH_PATH_INDEX_BASE up to
// BUILTIN_PATH_INDEX_BASE names the outline of a color glyph layer: slot
// (index - base) of the engine's path slots (color_glyph_path_key: font
// index << 16 | glyph). The host's own SVG path indices stay below the base.
export const COLOR_GLYPH_PATH_INDEX_BASE = 0x8000;
// The last CMD_SVG_PATH indices name fixed outlines the engine paints
// itself: the disclosure triangles of a list marker, pointing right, left
// and down, in the unit square of the marker's symbol box (Blink's
// list_marker_painter.cc). The host resolves them without the engine.
export const BUILTIN_PATH_INDEX_BASE = 0xfffd;
export const BUILTIN_PATH_DISCLOSURE_RIGHT = 0xfffd;
export const BUILTIN_PATH_DISCLOSURE_LEFT = 0xfffe;
export const BUILTIN_PATH_DISCLOSURE_DOWN = 0xffff;
// The registered hb_font draws outlines at units per em ×
// FONT_UNIT_SUBDIVISION (engine-constants.watpart $FONT_UNIT_SUBDIVISION).
export const FONT_UNIT_SUBDIVISION = 512;
// COLR gradient kinds of a CMD_SVG_PATH gradient extension: geom f32[4] and
// origin f32[0..1] are an affine (a, b, c, d, e, f) from the position in the
// painted box to the canonical space, origin f32[2..3] two parameters.
// 4 linear (t = x), 5 radial (centers (0, 0) and (1, 0), radii r0 r1),
// 6 concentric radial (radii r0 r1), 7 sweep (start and end angle, radians,
// counter-clockwise from +x with y up). Kind bit 7 = repeat, bit 6 =
// reflect.
export const GRADIENT_KIND_COLR_LINEAR = 4;
export const GRADIENT_KIND_COLR_RADIAL = 5;
export const GRADIENT_KIND_COLR_RADIAL_CONCENTRIC = 6;
export const GRADIENT_KIND_COLR_SWEEP = 7;
export const GRADIENT_KIND_FLAG_REFLECT = 0x40;

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
    inputBytes: 1,
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
// Glyph buffer (128 KB at 0xC2B40)
// =======================================================================
//
// Packed glyph records referenced by text commands.
// Each glyph contains its identifier, cumulative offset, advance, and
// prepared-source UTF-8 cluster range. 128 KB / 18 = ~7,280 glyphs per frame.

// Past every other fixed region (its original 128 KB slot at 0x00224840
// held 7281 glyphs, a fifth of a page of prose); the engine traps
// (trap_site 9) instead of writing past it.
export const GLYPH_BUFFER_BASE = 0x007C6000;
export const GLYPH_BUFFER_SIZE = 0x00400000; // 4 MB

export const GLYPH_ENTRY_SIZE = 18;
export const GLYPH_OFFSET_ID = 0x00; // u16
export const GLYPH_ID_INVISIBLE = 0xFFFF;
export const GLYPH_OFFSET_X_OFFSET = 0x02; // f32
export const GLYPH_OFFSET_X_ADVANCE = 0x06; // f32
export const GLYPH_OFFSET_CLUSTER_START = 0x0A; // u32 UTF-8 byte offset
export const GLYPH_OFFSET_CLUSTER_END = 0x0E; // u32 UTF-8 byte offset

// =======================================================================
// Previous command buffer (512 KB at 0xE2B40)
// =======================================================================
//
// Copy of the previous frame's command buffer, kept by WASM for diffing.
// Same size as the command buffer.

export const PREV_COMMAND_BUFFER_BASE = 0x00244840;
export const PREV_COMMAND_BUFFER_SIZE = 0x00080000; // 512 KB

// =======================================================================
// Computed-box buffer (128 KB at 0x2C4840)
// =======================================================================
//
// The layout pass's output: one computed box per node (Blink's "fragment
// tree", renamed — see design/layout-engine.md). emit_commands and later layout
// passes read geometry from here instead of from the node. Geometry is i32 in
// 1/64-px units (LayoutUnit), matching Blink for pixel-perfect Chrome parity.
// 32 bytes/box → 128 KB / 32 = 4096 boxes (> the layout buffer's 2251 nodes).

export const COMPUTED_BOX_BUFFER_BASE = 0x002C4840;
export const COMPUTED_BOX_BUFFER_SIZE = 0x00020000; // 128 KB

export const BOX_SIZE = 32;
export const BOX_OFFSET_X = 0x00; // i32: border-box x (1/64 px)
export const BOX_OFFSET_Y = 0x04; // i32: border-box y
export const BOX_OFFSET_WIDTH = 0x08; // i32: border-box width
export const BOX_OFFSET_HEIGHT = 0x0C; // i32: border-box height
export const BOX_OFFSET_CONTENT_X = 0x10; // i32: content-box x
export const BOX_OFFSET_CONTENT_Y = 0x14; // i32: content-box y
export const BOX_OFFSET_CONTENT_W = 0x18; // i32: content-box width
export const BOX_OFFSET_CONTENT_H = 0x1C; // i32: content-box height

// Scrollable-overflow side-table, independently reserved after scroll scratch.
// 88 KB holds every layout node's 40-byte record without sharing computed
// boxes or constraint scratch. Geometry and effective offsets are LayoutUnits.
export const SCROLL_DATA_BUFFER_BASE = 0x007AF620;
export const SCROLL_DATA_BUFFER_SIZE = 0x00016000;
export const SCROLL_DATA_ENTRY_SIZE = 40;
export const SCROLL_DATA_OFFSET_MIN_X = 0x00;
export const SCROLL_DATA_OFFSET_MIN_Y = 0x04;
export const SCROLL_DATA_OFFSET_MAX_X = 0x08;
export const SCROLL_DATA_OFFSET_MAX_Y = 0x0C;
export const SCROLL_DATA_OFFSET_EFFECTIVE_LEFT = 0x10;
export const SCROLL_DATA_OFFSET_EFFECTIVE_TOP = 0x14;
export const SCROLL_DATA_OFFSET_WIDTH = 0x18;
export const SCROLL_DATA_OFFSET_HEIGHT = 0x1C;
export const SCROLL_DATA_OFFSET_STICKY_LEFT = 0x20;
export const SCROLL_DATA_OFFSET_STICKY_TOP = 0x24;

// 1 px = 64 LayoutUnits (Blink kFixedPointDenominator).
export const LAYOUT_UNIT = 64;

// =======================================================================
// Constraint stack (8 KB at 0x182B40)
// =======================================================================
//
// Layout-pass scratch: available space per nesting level, pushed/popped as the
// pass descends/ascends the tree (like the clip/opacity stacks).

export const CONSTRAINT_STACK_BASE = 0x002E4840;
export const CONSTRAINT_STACK_SIZE = 0x00002000; // 8 KB

// =======================================================================
// Intrinsic-size buffer (32 KB at 0x184B40)
// =======================================================================
//
// Slice 4: one record per node holding its min-content and max-content INLINE
// (width) sizes, computed bottom-up by the intrinsic pass BEFORE the layout
// pass, and read by width resolution (width:min-content / max-content) and
// later by flex (flex-basis:auto). i32 @ 1/64 px, like the computed box.
// 16 bytes/node (min, max, validGen, pad) → 64 KB / 16 = 4096 nodes.

export const INTRINSIC_BUFFER_BASE = 0x002E6840;
export const INTRINSIC_BUFFER_SIZE = 0x00010000; // 64 KB (16 B/node × 4096)

export const INTRINSIC_SIZE = 16;
export const INTRINSIC_OFFSET_MIN_CONTENT = 0x00; // i32: min-content border-box width (1/64 px)
export const INTRINSIC_OFFSET_MAX_CONTENT = 0x04; // i32: max-content border-box width
export const INTRINSIC_OFFSET_VALID_GEN = 0x08; // u32: generation these were computed against
// (0 = never). See design/layout-engine.md.
export const INTRINSIC_OFFSET_LAYOUT_MAX = 0x0c; // i32: layout-pass max-content border-box width
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
// verifyLayout runs before any layout, so it still compares them.

export const FLEX_SCRATCH_BASE = 0x002F6840;
export const FLEX_SCRATCH_LEVEL = 0x00001600; // initial: 0x1200 items + 0x400 lines
export const FLEX_SCRATCH_LEVELS = 8;
export const FLEX_SCRATCH_SIZE = 0x0000B000; // 8 × 0x1600 = 44 KB

// =======================================================================
// Debug trace buffer (4 KB at 0x19FB40) — TEMPORARY tracing aid
// =======================================================================
//
// A ring of (tag: i32, a: f32, b: f32, c: f32) = 16-byte records, written by
// $debugEmit in engine.wat, read by JS after a layout() call. Not a permanent
// part of the engine — for WAT-level probing when post-layout scratch reads
// aren't enough to see why a branch didn't fire. debugTraceCount resets to 0
// at the top of every layout() call.

export const DEBUG_TRACE_BASE = 0x00301840;
export const DEBUG_TRACE_SIZE = 0x00001000; // 4 KB
export const DEBUG_TRACE_ENTRY = 16;
export const DEBUG_TRACE_MAX = 256;

// =======================================================================
// Text run directory (48 KB at 0x1A0B40) — Slice 6
// =======================================================================
//
// One entry per node, fixed stride (same pattern as INTRINSIC_BUFFER),
// pointing into the text source pool and shaped-glyph pool below. See
// design/layout-engine.md's "Text buffers" for the full rationale
// (WAT drives hb_shape directly, so source text has to live in WASM
// memory too — not just the shaped output).
//
// 32 B/node × 2560 nodes = 80 KB:
//   textOffset  (u32) — byte offset into TEXT_SOURCE_BASE
//   textLength  (u16) — UTF-8 byte length of this node's text content
//   glyphOffset (u32) — byte offset into SHAPED_GLYPH_POOL_BASE
//   glyphCount  (u16) — number of shaped glyph entries
//   lineOffset  (u32) — ABSOLUTE byte address of this node's line-box
//                       span inside the text line pool ($layoutText
//                       stores its $textLineCursor grab directly, and
//                       every reader — wat and JS — uses it unchanged;
//                       written by $layoutText, NOT $shapeTextRun —
//                       line breaks depend on contentW, recomputed
//                       every layout() call even when the shaped
//                       glyphs are cache-reused)
//   lineCount   (u16) — number of line-box records
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

export const TEXT_RUN_DIR_BASE = 0x00302840;
export const TEXT_RUN_DIR_SIZE = 0x00014000; // 80 KB (32 B/node × 2560)

export const TEXT_RUN_ENTRY_SIZE = 32;
export const TEXT_RUN_OFFSET_TEXT_OFFSET = 0x00; // u32
export const TEXT_RUN_OFFSET_TEXT_LENGTH = 0x04; // u16
export const TEXT_RUN_OFFSET_GLYPH_OFFSET = 0x06; // u32
export const TEXT_RUN_OFFSET_GLYPH_COUNT = 0x0A; // u16
export const TEXT_RUN_OFFSET_LINE_OFFSET = 0x0C; // u32
export const TEXT_RUN_OFFSET_LINE_COUNT = 0x10; // u16
export const TEXT_RUN_OFFSET_HAS_ELLIPSIS = 0x12; // u8; source has one appended ellipsis glyph
export const TEXT_RUN_OFFSET_LETTER_SPACING = 0x14; // f32 resolved px
export const TEXT_RUN_OFFSET_SHAPED_LETTER_SPACING = 0x18; // f32 cache key
export const TEXT_RUN_OFFSET_CONTENT_HEIGHT = 0x1C; // f32 px below the content-box top: last line box bottom
// design/inline-layout.md: an IFC ROOT (LAYOUT_FLAG_IS_INLINE_CTX) has no
// text of its own — TEXT_OFFSET/TEXT_LENGTH/GLYPH_OFFSET are dead weight
// for that node, repurposed as its item-stream span + virtual-glyph-map
// starting offset. LINE_OFFSET/LINE_COUNT above keep their ORIGINAL
// meaning (a TEXT_LINE_POOL span) for both a bare leaf and an IFC root.
export const TEXT_RUN_OFFSET_ITEM_OFFSET = 0x00; // u32, aliases TEXT_OFFSET
export const TEXT_RUN_OFFSET_ITEM_COUNT = 0x04; // u16, aliases TEXT_LENGTH
export const TEXT_RUN_OFFSET_ITEM_GLYPH_MAP_BASE = 0x06; // u32, aliases GLYPH_OFFSET
// 0x12..0x14 padding

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
export const TEXT_SOURCE_BASE = 0x00BC6000;
export const TEXT_SOURCE_SIZE = 0x00200000;

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

export const SHAPED_GLYPH_POOL_BASE = 0x00DC6000;
export const SHAPED_GLYPH_POOL_SIZE = 0x00200000;

// 20 B/entry. FONT is the FONT_TABLE index of the face that shaped the
// glyph: the node's primary face, or a later face of its font stack
// (plans/PLAN-font-fallback.md). X_ADVANCE is in the subdivided units of
// the node's primary face for every glyph; $shapeTextRun rescales the
// advance of a glyph from another face.
export const SHAPED_GLYPH_ENTRY_SIZE = 20;
export const SHAPED_GLYPH_OFFSET_ID = 0x00; // u16
export const SHAPED_GLYPH_OFFSET_X_ADVANCE = 0x02; // i32
export const SHAPED_GLYPH_OFFSET_FLAGS = 0x06; // u16
export const SHAPED_GLYPH_OFFSET_CLUSTER_START = 0x08; // u32 UTF-8 byte offset
export const SHAPED_GLYPH_OFFSET_CLUSTER_END = 0x0C; // u32 UTF-8 byte offset
export const SHAPED_GLYPH_OFFSET_FONT = 0x10; // u16 FONT_TABLE index
// text-spacing-trim (src/wasm/engine-han-kerning.watpart): an i16 that
// holds, in bits 1-15, the advance in font units of the primary face that
// the 'halt' feature removes from the glyph (negative when 'halt' also
// moves the glyph left by that amount, as for an opening bracket), and in
// bit 0 whether shaping removed it. SHAPED_GLYPH_FLAG_HALT tells whether
// X_ADVANCE has it removed now: a line edge can change that.
export const SHAPED_GLYPH_OFFSET_HAN_KERNING = 0x12; // i16

export const SHAPED_GLYPH_FLAG_BREAK_AFTER = 0x0001;
export const SHAPED_GLYPH_FLAG_HANGING = 0x0002; // the break glyph hangs at a line
// end (space); hyphens break but
// keep their width
// design/inline-layout.md: set by $collapseInlineItems on a leading/
// trailing collapsible space at an IFC item boundary that CSS collapses
// away — the glyph's advance contributes zero to any width/position sum.
export const SHAPED_GLYPH_FLAG_COLLAPSED = 0x0004;
export const SHAPED_GLYPH_FLAG_HALT = 0x0080;

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

export const TEXT_RUN_VALID_GEN_BASE = 0x003B6840;
export const TEXT_RUN_VALID_GEN_SIZE = 0x00008000; // 32 KB (8 B/node × 4096)
export const TEXT_RUN_VALID_GEN_ENTRY_SIZE = 8;
export const TEXT_RUN_VALID_GEN_OFFSET_GEN = 0x00; // u32
export const TEXT_RUN_VALID_GEN_OFFSET_EPOCH = 0x04; // u32

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
export const TEXT_LINE_POOL_BASE = 0x00FC6000;
export const TEXT_LINE_POOL_SIZE = 0x00180000;

// Entry grew 16 → 24 B for float line bands (design/floats.md): a line
// beside a float starts at the band's left edge and aligns within the
// band's width, not the content box's — X/AVAIL carry that per line.
// For float-free lines X = contentX and AVAIL = contentW, making the
// paint-side text-align math byte-identical to the pre-F2 output.
export const TEXT_LINE_ENTRY_SIZE = 24;
export const TEXT_LINE_OFFSET_FIRST_GLYPH = 0x00; // u32
export const TEXT_LINE_OFFSET_GLYPH_COUNT = 0x04; // u32
export const TEXT_LINE_OFFSET_WIDTH = 0x08; // f32
export const TEXT_LINE_OFFSET_Y = 0x0C; // f32 (px, relative to the node's contentY)
export const TEXT_LINE_OFFSET_X = 0x10; // f32 (px, band left RELATIVE to contentX — shifts move boxes, not pool records; F2)
export const TEXT_LINE_OFFSET_AVAIL = 0x14; // f32 (px, band width; F2)

// =======================================================================
// Text position scratch (65792 B at 0x26CB40) — Slice 6F
// =======================================================================
//
// $layoutText's per-glyph position cache: one i32 per glyph holding
// ceil-to-LU of the ABSOLUTE f32 prefix advance sum (position where the
// glyph starts, from the run's origin), plus one trailing entry for the
// position after the last glyph. This is the engine's equivalent of
// Blink's ShapeResult::ComputePositionData character-position cache — the
// line breaker's fit test runs on these INTEGERS (with a +1 raw-LU
// epsilon), never on float width comparisons. Transient scratch,
// rebuilt per $layoutText call; sized to the shaped-glyph pool's initial
// capacity at 16 B/entry (131072 glyphs) + 1, rounded up to 0x81000 bytes.
// At 20 B/entry the pool holds 104857 glyphs; one run holds at most 65535.

export const TEXT_POS_SCRATCH_BASE = 0x01786000;
export const TEXT_POS_SCRATCH_SIZE = 0x00081000;

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
// Per item (16 B): {kind: u8, nodeIndex: u16, flags: u8,
// parentItemIndex: u16, glyphOffset: u32, glyphCount: u32}.
// 1 MB / 16 B = 65536 items (u16 item index) — same order of magnitude as TEXT_LINE_POOL
// relative to a "moderate document". Relocated + doubled for D1 (see the
// TEXT_LINE_POOL comment; cursor persists, epoch'd).
export const INLINE_ITEM_POOL_BASE = 0x01146000;
export const INLINE_ITEM_POOL_SIZE = 0x00100000;

export const INLINE_ITEM_ENTRY_SIZE = 24;
export const INLINE_ITEM_OFFSET_KIND = 0x00; // u8
export const INLINE_ITEM_OFFSET_FLAGS = 0x01; // u8
export const INLINE_ITEM_OFFSET_NODE_INDEX = 0x04; // u32
export const INLINE_ITEM_OFFSET_PARENT_INDEX = 0x08; // u32; 0xFFFFFFFF = IFC root
export const INLINE_ITEM_OFFSET_GLYPH_OFFSET = 0x0C; // u32 (TEXT only)
export const INLINE_ITEM_OFFSET_GLYPH_COUNT = 0x10; // u32 (TEXT only)

export const INLINE_ITEM_KIND_TEXT = 0;
export const INLINE_ITEM_KIND_OPEN = 1;
export const INLINE_ITEM_KIND_CLOSE = 2;
export const INLINE_ITEM_KIND_ATOMIC = 3;
// An absolute or fixed box: no glyph; GLYPH_OFFSET is its boundary's
// glyph-map index, GLYPH_COUNT 0.
export const INLINE_ITEM_KIND_OUT_OF_FLOW = 4;

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
// directly. Same capacity as TEXT_POS_SCRATCH (worst case: one IFC's
// stream uses the entire shared glyph pool; 262144 entries).
//
// Per entry (8 B): {itemIndex: u16, glyphPtr: u32 (absolute
// SHAPED_GLYPH_POOL_BASE pointer for this glyph)} + 2 B pad.
// Relocated + doubled for D1 (see the TEXT_LINE_POOL comment).
export const INLINE_GLYPH_MAP_BASE = 0x01246000;
export const INLINE_GLYPH_MAP_SIZE = 0x00200000;
export const INLINE_GLYPH_MAP_ENTRY_SIZE = 8;
export const INLINE_GLYPH_MAP_OFFSET_ITEM_INDEX = 0x00; // u32
export const INLINE_GLYPH_MAP_OFFSET_GLYPH_PTR = 0x04; // u32

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
// Per fragment (24 B): {itemIndex: u32, glyphCount: u16, bidiLevel: u8,
// visualOrder: u8, glyphStart: u32 (virtual glyph index into that item's
// own span — resolved via INLINE_GLYPH_MAP at paint time), x: f32 (offset
// within the already text-align-shifted line), width: f32, blockOffset:
// f32}. I2's blockOffset positions each fragment within the mixed-metrics
// line box. Glyph count is u16: one fragment is one item's glyphs on one
// line. Fragments are in visual order, left to right. visualOrder is 0 on
// a line laid out in logical order (every bidi level 0, no right-to-left
// inline box in its IFC). It is 1 on a line laid out by the Unicode
// Bidirectional Algorithm (src/wasm/engine-bidi.watpart): each fragment
// is a run of virtual glyphs that ascend left to right at one bidiLevel,
// and the line's inline edge map entries hold edges by physical side
// (before = left, after = right).
// Relocated + doubled for D1 (see the TEXT_LINE_POOL comment).
export const LINE_FRAGMENT_POOL_BASE = 0x01646000;
export const LINE_FRAGMENT_POOL_SIZE = 0x00140000;
export const LINE_FRAGMENT_ENTRY_SIZE = 24;
export const LINE_FRAGMENT_OFFSET_ITEM_INDEX = 0x00; // u32
export const LINE_FRAGMENT_OFFSET_GLYPH_COUNT = 0x04; // u16
export const LINE_FRAGMENT_OFFSET_BIDI_LEVEL = 0x06; // u8: resolved embedding level
export const LINE_FRAGMENT_OFFSET_VISUAL_ORDER = 0x07; // u8: 1 when laid out in visual order
// The VISUAL_ORDER value of a visual-order fragment of hanging glyphs
// (collapsible trailing spaces): zero width, and no inline box's extent.
export const LINE_FRAGMENT_VISUAL_ORDER_HANGING = 3;
export const LINE_FRAGMENT_OFFSET_GLYPH_START = 0x08; // u32
export const LINE_FRAGMENT_OFFSET_X = 0x0C; // f32
export const LINE_FRAGMENT_OFFSET_WIDTH = 0x10; // f32
export const LINE_FRAGMENT_OFFSET_BLOCK_OFFSET = 0x14; // f32, relative to line top

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
// OpenType scalar metrics through the standalone @sandom/font-metrics package,
// independently of this table.
//
// 48 B/entry × 512 entries = 24576 B in retired inline-state scratch.
// Registration rejects exhaustion before writing. FONT_VARIATION_TABLE and
// FONT_DECORATION_TABLE, indexed by the same font index, follow it with
// the same capacity. The WPT MathML corpus alone registers 58 font files,
// and one test process registers every suite's faces, so 64 entries
// overflowed in a full run.

export const FONT_TABLE_BASE = 0x004A5720;
export const FONT_TABLE_SIZE = 0x00006000;
export const FONT_TABLE_ENTRY_SIZE = 48;
export const FONT_TABLE_MAX_ENTRIES = 512;

// Shaping contexts, interned by the DOM core: one entry per distinct pair
// of a content language (a BCP 47 tag) and a font feature set, appended in
// first-use order and never removed while the engine lives. NODE_LANGUAGE
// indexes this table; index 0 is "no language, no features" and its entry
// stays unused. Entry: byte 0 is the tag length in bytes (0..31; 0 for an
// entry that only carries features), bytes 1..31 are the tag in ASCII
// lowercase. 32 B/entry × 256 entries = 8192 B in the old inline-item pool
// hole. design/text-rendering.md ("Font features") explains the choice.
export const LANGUAGE_TABLE_BASE = 0x003E6940;
export const LANGUAGE_TABLE_SIZE = 0x00002000;
export const LANGUAGE_TABLE_ENTRY_SIZE = 32;
export const LANGUAGE_TABLE_MAX_ENTRIES = 256;
export const LANGUAGE_TABLE_TAG_MAX_LENGTH = 31;
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
export const LANGUAGE_TABLE_FEATURES_BASE = 0x003E8940;
export const LANGUAGE_TABLE_FEATURES_SIZE = 0x00000800;
export const LANGUAGE_TABLE_FEATURES_ENTRY_SIZE = 8;
export const LANGUAGE_TABLE_FEATURES_OFFSET_COUNT = 4;
export const LANGUAGE_TABLE_FEATURES_OFFSET_VARIANT_COUNT = 6;

// Font decoration metrics, indexed by FONT_TABLE index. JS supplies signed
// OpenType font units (post underline position/thickness, OS/2 strikeout
// position/thickness); the engine stores them ×FONT_UNIT_SUBDIVISION (512)
// to match the shaping scale (see engine.wat's $FONT_UNIT_SUBDIVISION).
// This separate table holds four signed scalar metrics per instance.
// 16 B/entry × 512 entries = 8192 B.
export const FONT_DECORATION_TABLE_BASE = 0x004AC720;
export const FONT_DECORATION_TABLE_SIZE = 0x00002000;
export const FONT_DECORATION_TABLE_ENTRY_SIZE = 16;
// Variation coordinates beyond wght, indexed by FONT_TABLE index: the wdth
// coordinate (a CSS font-stretch percentage) the instance shapes at, f32,
// 0 = the font's own default, and the slnt coordinate (the negated CSS
// oblique angle), f32, always applied (0 is upright; a font without a slnt
// axis ignores it). Separate for the same reason as the decoration table.
// 8 B/entry × 512 entries = 4096 B.
export const FONT_VARIATION_TABLE_BASE = 0x004AB720;
export const FONT_VARIATION_TABLE_SIZE = 0x00001000;
export const FONT_VARIATION_TABLE_ENTRY_SIZE = 8;
export const FONT_VARIATION_OFFSET_WIDTH = 0x00; // f32, wdth coordinate
export const FONT_VARIATION_OFFSET_SLANT = 0x04; // f32, slnt coordinate
export const FONT_TABLE_OFFSET_HB_FONT_PTR = 0x00; // i32: hb_font_t* in hb.wasm's memory
export const FONT_TABLE_OFFSET_UPEM = 0x04; // u32, upem × FONT_UNIT_SUBDIVISION (512)
export const FONT_TABLE_OFFSET_ASCENDER = 0x08; // i32, subdivided font units (hb_font_get_h_extents)
export const FONT_TABLE_OFFSET_DESCENDER = 0x0C; // i32, subdivided font units (negative)
export const FONT_TABLE_OFFSET_LINE_GAP = 0x10; // i32, subdivided font units
export const FONT_TABLE_OFFSET_WEIGHT = 0x14; // u16, CSS weight; re-applied with wdth, slnt and opsz before shaping
export const FONT_TABLE_OFFSET_X_GLYPH = 0x16; // u16, nominal glyph id for lowercase x
export const FONT_TABLE_OFFSET_BYTES = 24;
export const FONT_TABLE_OFFSET_LENGTH = 28;
export const FONT_TABLE_OFFSET_HASH = 32;
export const FONT_TABLE_OFFSET_FACE_INDEX = 36;
export const FONT_TABLE_OFFSET_ITALIC = 40;

// Font stack table (plans/PLAN-font-fallback.md): the authored font stack
// of a text node, primary face first. Entry: count (u16), then up to
// FONT_STACK_MAX_FACES FONT_TABLE indices (u16), the primary slot (u16) and
// the slot block (u32). Equal stacks share one entry; entry 0 is never
// written (LAYOUT_NODE_OFFSET_FONT_STACK 0 is a stack of the primary face
// alone). 24 B/entry x 1024 entries = 24576 B in the retired text-line pool.
// A stack with a unicode-range face (plans/PLAN-font-unicode-range.md) has
// a slot block instead of the indices: {byte length u32, slot count u32},
// then slots of FONT_STACK_SLOT_SIZE bytes {font u16 (0xFFFF not loaded),
// 2 B zero, pair count u32, catalog face ID u32 of an unloaded face, core
// face number u32, pair offset u32 from the block start}, then the u32
// {start, end} scalar pairs. The font of the primary slot, when loaded, is
// the node's primary face (see engine-constants.watpart).
export const FONT_STACK_TABLE_BASE = 0x003BE840;
export const FONT_STACK_TABLE_SIZE = 0x00006000;
export const FONT_STACK_ENTRY_SIZE = 24;
export const FONT_STACK_MAX_ENTRIES = 1024;
export const FONT_STACK_MAX_FACES = 8;
export const FONT_STACK_OFFSET_COUNT = 0x00; // u16
export const FONT_STACK_OFFSET_FONTS = 0x02; // u16 x FONT_STACK_MAX_FACES
export const FONT_STACK_OFFSET_PRIMARY = 0x12; // u16 slot index
export const FONT_STACK_OFFSET_SLOTS = 0x14; // u32 slot block, 0 for none
export const FONT_STACK_SLOT_HEADER_SIZE = 8;
export const FONT_STACK_SLOT_SIZE = 20;
export const FONT_STACK_UNLOADED = 0xFFFF;

// --- Image table (Slice P5a): decoded-image intrinsic size registry ---
// Mirrors FONT_TABLE's shape exactly: JS decodes image bytes (src/images.js,
// PNG only for v1) off the engine entirely — pixels never enter WASM memory,
// they go straight to a GPU texture at draw time (src/rasterize.js) — and
// calls register_image(index, width, height) so the ENGINE can read
// intrinsic size for replaced-box layout (design/paint-coverage.md P5b's
// shared sizing helper, also consumed by the svg-root sizing).
// UNLIKE register_font (which returns an auto-incremented index), the
// caller PICKS the index here — JS already has a natural image identity
// (the decoded-bytes cache key) before any node references it, so there's
// no need for the engine to hand back an opaque handle.
// 8 B/entry x 256 entries = 2048 B.
export const IMAGE_TABLE_BASE = 0x0042B140;
export const IMAGE_TABLE_SIZE = 0x00000800; // 2048 B (8 B x 256 entries)
export const IMAGE_TABLE_ENTRY_SIZE = 8;
export const IMAGE_TABLE_MAX_ENTRIES = 256;
export const IMAGE_TABLE_OFFSET_WIDTH = 0x00; // u32: intrinsic width, px
export const IMAGE_TABLE_OFFSET_HEIGHT = 0x04; // u32: intrinsic height, px

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
// alternative was renumbering the ~14 region bases that followed it,
// which verifyLayout cannot fully protect (it compares the JS and WAT
// mirrors against each other, so a consistent double-typo that overlaps
// two regions passes) — see verifyLayout's own overlap check, added with
// this move.
export const BG_LAYER_POOL_BASE = 0x004D3B60;
export const BG_LAYER_POOL_SIZE = 0x00014000; // 81920 B (80 B x 1024 layers)
export const BG_LAYER_ENTRY_SIZE = 80;
export const BG_LAYER_MAX_ENTRIES = 1024;
export const BG_LAYER_OFFSET_IMAGE_INDEX = 0x00; // u16 (0xFFFF = none/gradient layer)
export const BG_LAYER_OFFSET_SIZE_W_TAG = 0x02; // u8
export const BG_LAYER_OFFSET_SIZE_H_TAG = 0x03; // u8
// A position tag with BG_LAYER_POSITION_TAG_FROM_END set measures its value
// from the far (right or bottom) edge: the offset is the free space minus
// the resolved value (`right 10px`, `calc(100% - 10px)`).
export const BG_LAYER_OFFSET_POSITION_X_TAG = 0x04; // u8: SIZE_TAG_LENGTH/PERCENT, optional FROM_END bit
export const BG_LAYER_OFFSET_POSITION_Y_TAG = 0x05; // u8
export const BG_LAYER_POSITION_TAG_FROM_END = 0x80;
export const BG_LAYER_OFFSET_REPEAT_X = 0x06; // u8: BG_REPEAT_* enum
export const BG_LAYER_OFFSET_REPEAT_Y = 0x07; // u8: BG_REPEAT_* enum
export const BG_LAYER_OFFSET_SIZE_W = 0x08; // f32
export const BG_LAYER_OFFSET_SIZE_H = 0x0C; // f32
export const BG_LAYER_OFFSET_POSITION_X = 0x10; // f32
export const BG_LAYER_OFFSET_POSITION_Y = 0x14; // f32
// Background attachment, origin and clip use the first three bytes of the
// background-only 0x18-0x1B metadata quartet. Mask entries use these bytes
// as mode, composite and origin; the shared draw helper receives the entry
// but these bytes are read only by the background caller.
export const BG_LAYER_OFFSET_ATTACHMENT = 0x18; // u8: BG_ATTACHMENT_* enum
export const BG_ATTACHMENT_SCROLL = 0;
export const BG_ATTACHMENT_LOCAL = 1;
export const BG_ATTACHMENT_FIXED = 2;
// This layer's background-origin (LAYOUT_NODE_OFFSET_BACKGROUND_ORIGIN's
// encoding: 0 padding-box, 1 border-box, 2 content-box) and
// background-clip (LAYOUT_NODE_OFFSET_BACKGROUND_CLIP's encoding: 0
// border-box, 1 padding-box, 2 content-box). The node fields keep the
// bottom layer's values, which also govern the background color.
export const BG_LAYER_OFFSET_ORIGIN = 0x19; // u8
export const BG_LAYER_OFFSET_CLIP = 0x1A; // u8
export const BG_LAYER_OFFSET_GRADIENT_KIND = 0x1C; // u8: 0=none, else BG_KIND_* (bit7 = repeating)
// P13: this layer's background-blend-mode (BLEND_* enum, 0 = normal).
// Existing padding after GRADIENT_KIND, free in BOTH pool entries; a
// MASK_LAYER leaves it zero. Deliberately NOT one of the 0x18-0x1B bytes
// that carry the mask's own mode/composite/origin/clip — giving one byte
// two live meanings across two pools is the aliasing this file refuses
// elsewhere, and $emitBackgroundLayerDraw reads neither block, so the
// shared-entry-shape property holds either way.
export const BG_LAYER_OFFSET_BLEND_MODE = 0x1D; // u8: BLEND_* enum (P13)
export const BG_LAYER_OFFSET_GRADIENT = 0x20; // GRAD_DESC_SIZE bytes (0x20-0x4B), 4 B tail pad

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
export const GRAD_DESC_SIZE = 44;
export const GRAD_DESC_OFFSET_STOP_COUNT = 0x00; // u8
export const GRAD_DESC_OFFSET_CENTER_X_TAG = 0x01; // u8: SIZE_TAG_LENGTH/PERCENT
export const GRAD_DESC_OFFSET_CENTER_Y_TAG = 0x02; // u8
export const GRAD_DESC_OFFSET_RADIAL_SHAPE = 0x03; // u8: RADIAL_SHAPE_*
export const GRAD_DESC_OFFSET_RADIAL_SIZE = 0x04; // u8: RADIAL_SIZE_*
export const GRAD_DESC_OFFSET_INTERPOLATION = 0x05; // u8: packed space + hue method
export const GRAD_DESC_OFFSET_STOP_OFFSET = 0x08; // u32: GRADIENT_STOP_POOL span offset
export const GRAD_DESC_OFFSET_GEOMETRY = 0x0C; // f32[4]: linear angle geom[0], conic angle geom[2]
export const GRAD_DESC_OFFSET_CENTER_X = 0x1C; // f32
export const GRAD_DESC_OFFSET_CENTER_Y = 0x20; // f32
export const GRAD_DESC_OFFSET_EXPLICIT_RX = 0x24; // f32
export const GRAD_DESC_OFFSET_EXPLICIT_RY = 0x28; // f32

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
export const MASK_LAYER_POOL_BASE = 0x004C9B20;
export const MASK_LAYER_POOL_SIZE = 0x0000A000; // 40960 B (80 B x 512 layers)
export const MASK_LAYER_ENTRY_SIZE = 80;
export const MASK_LAYER_MAX_ENTRIES = 512;
export const MASK_LAYER_OFFSET_IMAGE_INDEX = 0x00; // u16 (0xFFFF = none/gradient layer)
export const MASK_LAYER_OFFSET_SIZE_W_TAG = 0x02; // u8
export const MASK_LAYER_OFFSET_SIZE_H_TAG = 0x03; // u8
export const MASK_LAYER_OFFSET_POSITION_X_TAG = 0x04; // u8
export const MASK_LAYER_OFFSET_POSITION_Y_TAG = 0x05; // u8
export const MASK_LAYER_OFFSET_REPEAT_X = 0x06; // u8: BG_REPEAT_* enum
export const MASK_LAYER_OFFSET_REPEAT_Y = 0x07; // u8: BG_REPEAT_* enum
export const MASK_LAYER_OFFSET_SIZE_W = 0x08; // f32
export const MASK_LAYER_OFFSET_SIZE_H = 0x0C; // f32
export const MASK_LAYER_OFFSET_POSITION_X = 0x10; // f32
export const MASK_LAYER_OFFSET_POSITION_Y = 0x14; // f32
export const MASK_LAYER_OFFSET_MODE = 0x18; // u8: MASK_MODE_*
export const MASK_LAYER_OFFSET_COMPOSITE = 0x19; // u8: MASK_COMPOSITE_*
export const MASK_LAYER_OFFSET_ORIGIN = 0x1A; // u8: MASK_ORIGIN_*
export const MASK_LAYER_OFFSET_CLIP = 0x1B; // u8: MASK_CLIP_*
export const MASK_LAYER_OFFSET_GRADIENT_KIND = 0x1C; // u8: 0=none, else BG_KIND_* (bit7 = repeating)
export const MASK_LAYER_OFFSET_GRADIENT = 0x20; // GRAD_DESC_SIZE bytes (0x20-0x4B), 4 B tail pad

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
export const SVG_GEOM_POOL_BASE = 0x00431940;
export const SVG_GEOM_POOL_SIZE = 0x00006000; // 24576 B (24 B x 1024 entries)
export const SVG_GEOM_ENTRY_SIZE = 24;
export const SVG_GEOM_MAX_ENTRIES = 1024;
export const SVG_GEOM_OFFSET_0 = 0x00; // f32
export const SVG_GEOM_OFFSET_1 = 0x04; // f32
export const SVG_GEOM_OFFSET_2 = 0x08; // f32
export const SVG_GEOM_OFFSET_3 = 0x0C; // f32
export const SVG_GEOM_OFFSET_4 = 0x10; // f32
export const SVG_GEOM_OFFSET_5 = 0x14; // f32

// Gradient stop pool (design/paint-coverage.md P4): a node's background
// gradient (LAYOUT_NODE_OFFSET_STOP_OFFSET/STOP_COUNT, P0-reserved) points
// at a span of fixed-size entries here — same "pool + per-node span
// pointer" pattern as SVG_GEOM_POOL/BG_LAYER_POOL just above. Bump-
// allocated fresh every emitSceneCommands/render call (pure per-node
// style, cheap to recompute), same lifetime as those two pools.
//
// 20 B/entry x 2048 entries = 40960 B. Stop POSITIONS are resolved to 0..1
// by JS at scene-build time (length/percent/hint syntax all collapse to a
// plain fraction before reaching WASM — see design/paint-coverage.md's P4
// section); WAT never interprets a raw CSS stop specifier, only walks
// already-resolved (position, color) pairs.
//   position (f32) — 0..1 along the gradient axis
//   color (f32[4]) — rgba, straight (NOT premultiplied) at rest; the
//     rasterizer premultiplies at interpolation time (see P4's "Rasterizer"
//     section — premultiplied-sRGB interpolation is a shader-side concern)
export const GRADIENT_STOP_POOL_BASE = 0x00437940;
export const GRADIENT_STOP_POOL_SIZE = 0x0000A000; // 40960 B (24 B x 1706 entries)
export const GRADIENT_STOP_ENTRY_SIZE = 24;

export const GRADIENT_STOP_OFFSET_POSITION = 0x00; // f32
export const GRADIENT_STOP_OFFSET_COLOR = 0x04; // f32[4]: components + alpha
// u32: bits 0-2 = missing-component mask (CSS `none`), bit 3 = alpha missing.
export const GRADIENT_STOP_OFFSET_MISSING = 0x14;

// Gradient interpolation identifiers, packed into one byte: bits 0-3 =
// interpolation space, bits 4-5 = hue method. The byte rides the node
// (LAYOUT_NODE_OFFSET_GRADIENT_INTERPOLATION), the layer descriptor
// (GRAD_DESC_OFFSET_INTERPOLATION), and the command extension
// (CMD_RECT_GRADIENT_OFFSET_INTERPOLATION).
export const GRADIENT_SPACE_NAMES = Object.freeze({
  srgb: 0,
  "srgb-linear": 1,
  lab: 2,
  oklab: 3,
  "xyz-d65": 4,
  hsl: 5,
  hwb: 6,
  lch: 7,
  oklch: 8,
});
export const GRADIENT_HUE_NAMES = Object.freeze({
  shorter: 0,
  longer: 1,
  increasing: 2,
  decreasing: 3,
});

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
export const SHADOW_POOL_BASE = 0x00441940;
export const SHADOW_POOL_SIZE = 0x0000A000; // 40960 B (40 B x 1024 entries)
export const SHADOW_ENTRY_SIZE = 40;
export const SHADOW_MAX_ENTRIES = 1024;
export const SHADOW_OFFSET_OFFSET_X = 0x00; // f32
export const SHADOW_OFFSET_OFFSET_Y = 0x04; // f32
export const SHADOW_OFFSET_BLUR = 0x08; // f32
export const SHADOW_OFFSET_SPREAD = 0x0C; // f32
export const SHADOW_OFFSET_COLOR = 0x10; // f32[4]
export const SHADOW_OFFSET_INSET = 0x20; // u8

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
// whole bracket that took it. The engine traps (fail loud) if the arena
// or a single list's CLIP_LIST_MAX_ENTRIES cap overflows.
export const CLIP_ARENA_BASE = 0x0044B940;
export const CLIP_ARENA_SIZE = 0x00008000; // 32 KB (409 × 80 B entries)

// =======================================================================
// clip-path pool (design/paint-coverage.md P9)
// =======================================================================
//
// One fixed-size record per node with a clip-path (at most one per node —
// LAYOUT_NODE_OFFSET_CLIP_PATH_INDEX points here, 0xFFFF = none). Values
// carry per-value TAG bytes and are resolved at EMIT time against the
// node's laid-out BORDER box (same "resolve against the laid-out box in
// WAT" pattern as P4's gradient center) into one oriented-clip-list entry
// (see CLIP_ARENA above / design/clipping.md).
//   kind u8:    1 = inset, 2 = circle, 3 = ellipse, 4 = polygon, 5 = path
//   tags u8[4]: per-value CLIP_PATH_VALUE_* for basic shapes; for polygon/
//               path, bytes 2..3 carry the opaque SVG-path atlas index
//   values f32[4]: basic-shape tagged values; for polygon/path, the resolved
//                  path bbox [xMin,yMin,xMax,yMax] in path coordinates
//   radii f32[8]: inset's `round` radii; for polygon/path, radii[0] is the
//                 path-coordinate-to-layout scale (currently 1 because
//                 scaleResolvedSvgNode pre-scales both point and path data)
export const CLIP_PATH_POOL_BASE = 0x00453940;
export const CLIP_PATH_POOL_SIZE = 0x00004000; // 16384 B (64 B × 256)
export const CLIP_PATH_ENTRY_SIZE = 64;
export const CLIP_PATH_MAX_ENTRIES = 256;
export const CLIP_PATH_OFFSET_KIND = 0x00; // u8
export const CLIP_PATH_OFFSET_TAGS = 0x01; // u8[4]
export const CLIP_PATH_OFFSET_PATH_INDEX = 0x02; // u16, polygon/path only
export const CLIP_PATH_OFFSET_VALUES = 0x08; // f32[4]
export const CLIP_PATH_OFFSET_RADII = 0x18; // f32[8]
export const CLIP_PATH_KIND_INSET = 1;
export const CLIP_PATH_KIND_CIRCLE = 2;
export const CLIP_PATH_KIND_ELLIPSE = 3;
export const CLIP_PATH_KIND_POLYGON = 4;
export const CLIP_PATH_KIND_PATH = 5;
export const CLIP_PATH_VALUE_PX = 0;
export const CLIP_PATH_VALUE_PERCENT = 1; // stored 0..100
export const CLIP_PATH_VALUE_CLOSEST_SIDE = 2; // circle/ellipse radii only
export const CLIP_PATH_VALUE_FARTHEST_SIDE = 3; // circle/ellipse radii only

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
export const FILTER_POOL_BASE = 0x00457940;
export const FILTER_POOL_SIZE = 0x00005000; // 20480 B (32 B x 640 entries)
export const FILTER_ENTRY_SIZE = 32;
export const FILTER_MAX_ENTRIES = 640;
export const FILTER_OFFSET_FN = 0x00; // u8
export const FILTER_OFFSET_PAYLOAD = 0x04; // f32[7]
export const FILTER_FN_BRIGHTNESS = 1;
export const FILTER_FN_CONTRAST = 2;
export const FILTER_FN_SATURATE = 3;
export const FILTER_FN_GRAYSCALE = 4;
export const FILTER_FN_SEPIA = 5;
export const FILTER_FN_INVERT = 6;
export const FILTER_FN_HUE_ROTATE = 7;
export const FILTER_FN_OPACITY = 8;
export const FILTER_FN_BLUR = 9;
export const FILTER_FN_DROP_SHADOW = 10;

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
export const FILTER_SEGMENT_SCRATCH_BASE = 0x0045C940;
export const FILTER_SEGMENT_SCRATCH_MAX = 10;
export const FILTER_SEGMENT_SCRATCH_SIZE = 0x00000350; // 840 B (10 x 84 B segments)

// =======================================================================
// Exclusion scratch (design/floats.md): placed floats per BFC
// nesting level — the float's MARGIN box in absolute page px (same
// coordinate space as computed boxes) + its type. Same depth-indexed-
// slice shape as FLEX_SCRATCH ($bfcLevel selects the slice), but budget
// overflow GROWS the stack instead of reusing the last slice: flex-slice
// reuse only degrades pathological nesting's precision, exclusion-slice
// reuse would make one BFC's floats silently visible to another. Every
// level starts with a 16-byte header (count u32 + 12 reserved), then
// EXCLUSION_MAX_PER_LEVEL 24-byte entries. Clear offsets and the
// top-edge-rule's last-float-block-start are DERIVED by scanning the
// ≤64 entries at query time, not maintained incrementally like Blink's
// ExclusionSpaceInternal — keeps provisional-Y rollback (see the plan's
// F1 design) to "restore count", nothing else.
//
// The BASE and LEVELS below are the INITIAL map: $exclusionPushLevel
// doubles the stack into an allocated block when a document nests more
// formatting contexts than the fixed region holds (the stride never
// changes, so every live level copies flat), and exclusion_scratch_base()
// / exclusion_levels() report the current pair. verifyLayout runs before
// any layout, so it still compares these. EXCLUSION_MAX_PER_LEVEL is a
// real limit: the shelf geometry these entries feed has its own fixed
// per-shelf edge budget, so the engine reports it by name (trap site 5)
// with the observed count rather than trapping bare.
// =======================================================================

export const EXCLUSION_SCRATCH_BASE = 0x0045CC90;
export const EXCLUSION_LEVEL_STRIDE = 0x00000680; // header + 64 × 24 B = 1552, strided to 1664
export const EXCLUSION_LEVELS = 16; // initial; doubles on demand
export const EXCLUSION_SCRATCH_SIZE = 0x00006800; // 16 × 0x680 = 26 KB
export const EXCLUSION_MAX_PER_LEVEL = 64;
export const EXCLUSION_HEADER_SIZE = 16;
export const EXCLUSION_HEADER_OFFSET_COUNT = 0x00; // u32
export const EXCLUSION_ENTRY_SIZE = 24;
export const EXCLUSION_ENTRY_OFFSET_BLOCK_START = 0x00; // f32: margin-box top
export const EXCLUSION_ENTRY_OFFSET_BLOCK_END = 0x04; // f32: margin-box bottom
export const EXCLUSION_ENTRY_OFFSET_INLINE_START = 0x08; // f32: margin-box left
export const EXCLUSION_ENTRY_OFFSET_INLINE_END = 0x0C; // f32: margin-box right
export const EXCLUSION_ENTRY_OFFSET_TYPE = 0x10; // u32: FLOAT_LEFT / FLOAT_RIGHT

// =======================================================================
// F4: Blink DerivedGeometry scratch (shelves + closed-off areas) for the
// avoided-BFC placement query — rebuilt per query from the current
// exclusion level's entries; no persistent state (rollback stays "restore
// the entry count"). Mirrors engine.wat's SHELF_GEOM_* — keep in
// lockstep; internal slot layout is documented at the WAT globals.

export const SHELF_GEOM_BASE = 0x00463490;
export const SHELF_GEOM_SIZE = 0x00022000; // 136 KB: 66 shelves + copy + 65 areas x 1048 B

// Inline edge map (I4): per virtual glyph, horizontal inline-box edges
// attached immediately before/after it. OPEN ancestors add their
// margin+border+padding to the first descendant glyph; CLOSE ancestors add
// the corresponding trailing edge to the last. Transient per layout call,
// indexed exactly like INLINE_GLYPH_MAP.
// Relocated + doubled for D1 (see the TEXT_LINE_POOL comment).
export const INLINE_EDGE_MAP_BASE = 0x01446000;
export const INLINE_EDGE_MAP_SIZE = 0x00200000;
export const INLINE_EDGE_MAP_ENTRY_SIZE = 8;
export const INLINE_EDGE_MAP_OFFSET_BEFORE = 0x00;
export const INLINE_EDGE_MAP_OFFSET_AFTER = 0x04;

// Inline box state scratch (I6): one 32-byte transient state per persisted
// inline item, rebuilt for each line while closing nested inline boxes.
// Relocated + doubled for D1: indexed by the GLOBAL inline-item index, so
// its capacity tracks INLINE_ITEM_POOL's own (65536 items).
export const INLINE_STATE_SCRATCH_BASE = 0x01807000;
export const INLINE_STATE_SCRATCH_SIZE = 0x00240000;
export const INLINE_STATE_ENTRY_SIZE = 40;
export const INLINE_STATE_MAX_ENTRIES = 65536;

// =======================================================================

// P11's MASK_LAYER_POOL appended 0xA000 (0x3AE400 -> 0x3B8400) and the
// gradient-descriptor scratch 0x40 more — appends past the old end, not
// shifts, so no existing region moved.
export const GRAD_DESC_SCRATCH_BASE = 0x004D3B20;
export const GRAD_DESC_SCRATCH_SIZE = 0x00000040; // one GRAD_DESC_SIZE record, padded
// BG_LAYER_POOL's relocation (stride 24 -> 80) appended 0x14000 here
// (0x3B8440 -> 0x3CC440); its old 0x310220-0x316220 slot is now an
// intentional hole — see that pool's own comment.
// P14's BORDER_IMAGE_POOL appends 0x4000 at the old end (0x3CC440 ->
// 0x3D0440) — an append past the end, not a shift, so no existing region
// moved (P0's rule, same as MASK_LAYER_POOL above).
export const BORDER_IMAGE_POOL_BASE = 0x004E7B60;
export const BORDER_IMAGE_POOL_SIZE = 0x00004000; // 16384 B (64 B x 256)
export const BORDER_IMAGE_ENTRY_SIZE = 64;
export const BORDER_IMAGE_MAX_ENTRIES = 256;

// One entry per node that HAS a border-image, bump-allocated per scene
// like every other pool here. Reached by index from
// LAYOUT_NODE_OFFSET_BORDER_IMAGE_INDEX.
//
// Slice values are PRE-RESOLVED to source-image pixels in JS. That is
// safe (and not a violation of the "resolve nothing box-dependent at
// scene build" rule that governs gradient stops) precisely because
// border-image-slice percentages are relative to the SOURCE IMAGE, whose
// size JS already knows from having decoded and registered it — no
// laid-out box is involved. Widths and outsets are NOT pre-resolved:
// those depend on the border box and on border-width, so they carry unit
// tags and resolve in WAT at emit time.
export const BORDER_IMAGE_OFFSET_IMAGE_INDEX = 0x00; // u16: source, into IMAGE_TABLE
export const BORDER_IMAGE_OFFSET_FILL = 0x02; // u8: the `fill` keyword — paint the centre slice
export const BORDER_IMAGE_OFFSET_REPEAT_X = 0x03; // u8: BORDER_IMAGE_REPEAT_*
export const BORDER_IMAGE_OFFSET_REPEAT_Y = 0x04; // u8: BORDER_IMAGE_REPEAT_*
export const BORDER_IMAGE_OFFSET_WIDTH_TOP_TAG = 0x05; // u8: BORDER_IMAGE_WIDTH_*
export const BORDER_IMAGE_OFFSET_WIDTH_RIGHT_TAG = 0x06; // u8
export const BORDER_IMAGE_OFFSET_WIDTH_BOTTOM_TAG = 0x07; // u8
export const BORDER_IMAGE_OFFSET_WIDTH_LEFT_TAG = 0x08; // u8
export const BORDER_IMAGE_OFFSET_OUTSET_TOP_TAG = 0x09; // u8: BORDER_IMAGE_OUTSET_*
export const BORDER_IMAGE_OFFSET_OUTSET_RIGHT_TAG = 0x0A; // u8
export const BORDER_IMAGE_OFFSET_OUTSET_BOTTOM_TAG = 0x0B; // u8
export const BORDER_IMAGE_OFFSET_OUTSET_LEFT_TAG = 0x0C; // u8
// 0x0D-0x0F pad to f32 alignment
export const BORDER_IMAGE_OFFSET_SLICE_TOP = 0x10; // f32: SOURCE PIXELS (pre-resolved)
export const BORDER_IMAGE_OFFSET_SLICE_RIGHT = 0x14; // f32
export const BORDER_IMAGE_OFFSET_SLICE_BOTTOM = 0x18; // f32
export const BORDER_IMAGE_OFFSET_SLICE_LEFT = 0x1C; // f32
export const BORDER_IMAGE_OFFSET_WIDTH_TOP = 0x20; // f32: meaning per its tag
export const BORDER_IMAGE_OFFSET_WIDTH_RIGHT = 0x24; // f32
export const BORDER_IMAGE_OFFSET_WIDTH_BOTTOM = 0x28; // f32
export const BORDER_IMAGE_OFFSET_WIDTH_LEFT = 0x2C; // f32
export const BORDER_IMAGE_OFFSET_OUTSET_TOP = 0x30; // f32: meaning per its tag
export const BORDER_IMAGE_OFFSET_OUTSET_RIGHT = 0x34; // f32
export const BORDER_IMAGE_OFFSET_OUTSET_BOTTOM = 0x38; // f32
export const BORDER_IMAGE_OFFSET_OUTSET_LEFT = 0x3C; // f32  (entry ends at 0x40 = 64)

// border-image-repeat. NOT BG_REPEAT_*: `stretch` has no background
// counterpart, and the two enums would drift if one were made to stand in
// for the other. The mapping into $resolveBackgroundRepeatAxis happens at
// the one call site that needs it.
export const BORDER_IMAGE_REPEAT_STRETCH = 0;
export const BORDER_IMAGE_REPEAT_REPEAT = 1;
export const BORDER_IMAGE_REPEAT_ROUND = 2;
export const BORDER_IMAGE_REPEAT_SPACE = 3;

// border-image-width units. `auto` means "use the slice's own size",
// which is why it is a tag rather than a resolved number.
export const BORDER_IMAGE_WIDTH_LENGTH = 0; // LU
export const BORDER_IMAGE_WIDTH_PERCENT = 1; // % of the BORDER BOX (w for l/r, h for t/b)
export const BORDER_IMAGE_WIDTH_NUMBER = 2; // multiple of the corresponding border-width
export const BORDER_IMAGE_WIDTH_AUTO = 3; // the slice's intrinsic size

// border-image-outset units.
export const BORDER_IMAGE_OUTSET_LENGTH = 0; // LU
export const BORDER_IMAGE_OUTSET_NUMBER = 1; // multiple of the corresponding border-width

// Animation regions are append-only. Variable-length declarations allocate
// complete immutable spans before publishing a live track.
export const ANIMATION_TABLE_BASE = 0x004EBB60;
export const ANIMATION_RECORD_SIZE = 112;
export const ANIMATION_TABLE_CAPACITY = 256;
export const ANIMATION_TABLE_SIZE = ANIMATION_RECORD_SIZE *
  ANIMATION_TABLE_CAPACITY;
export const KEYFRAME_POOL_BASE = 0x004F2B60;
export const KEYFRAME_ENTRY_SIZE = 56;
export const KEYFRAME_POOL_CAPACITY = 4096;
export const KEYFRAME_POOL_SIZE = KEYFRAME_ENTRY_SIZE * KEYFRAME_POOL_CAPACITY;
export const TRANSFORM_COMPONENT_POOL_BASE = 0x0052AB60;
export const TRANSFORM_COMPONENT_ENTRY_SIZE = 32;
export const TRANSFORM_COMPONENT_POOL_CAPACITY = 4096;
export const TRANSFORM_COMPONENT_POOL_SIZE = TRANSFORM_COMPONENT_ENTRY_SIZE *
  TRANSFORM_COMPONENT_POOL_CAPACITY;
export const TRANSFORM_COMPONENT_BITMAP_BASE = 0x0054AB60;
export const TRANSFORM_COMPONENT_BITMAP_SIZE = 512;
export const TRANSFORM_SOURCE_TABLE_BASE = 0x0054AD60;
export const TRANSFORM_SOURCE_ENTRY_SIZE = 8;
export const TRANSFORM_SOURCE_TABLE_CAPACITY = 819;
export const TRANSFORM_SOURCE_TABLE_SIZE = 0x00001998;
export const EFFECT_STACK_TABLE_BASE = 0x0054C6F8;
export const EFFECT_STACK_ENTRY_SIZE = 40;
export const EFFECT_STACK_TABLE_CAPACITY = 256;
export const EFFECT_STACK_TABLE_SIZE = 0x00002800;
export const LINEAR_EASING_POOL_BASE = 0x0054EEF8;
export const LINEAR_EASING_ENTRY_SIZE = 8;
export const LINEAR_EASING_POOL_CAPACITY = 4096;
export const LINEAR_EASING_POOL_SIZE = 0x00008000;
export const ANIMATION_EVENT_QUEUE_BASE = 0x00556EF8;
export const ANIMATION_EVENT_ENTRY_SIZE = 8;
export const ANIMATION_EVENT_QUEUE_CAPACITY = 256;
export const ANIMATION_EVENT_QUEUE_SIZE = 0x00000800;
export const ANIMATION_RESULT_BASE = 0x005576F8;
export const ANIMATION_RESULT_SIZE = 16;
// Animated box-shadow spans: one fixed span per animation track, written
// by the engine's sample write for a box-shadow track (kind 7). The node's
// SHADOW_OFFSET is repointed at the span (as an offset from
// SHADOW_POOL_BASE, which is all the paint reads) for the track's life and
// restored from the track's base at its end. A keyframe list holds at most
// ANIMATED_SHADOW_MAX_SHADOWS shadows; the shorter list is padded with
// transparent zero shadows (css-backgrounds-3 §7.1 interpolation).
// Appended past the old FIXED_REGIONS_END, same rule as the mask pool.
export const ANIMATED_SHADOW_MAX_SHADOWS = 8;
export const ANIMATED_SHADOW_SPAN_SIZE = SHADOW_ENTRY_SIZE *
  ANIMATED_SHADOW_MAX_SHADOWS;
export const ANIMATED_SHADOW_POOL_BASE = 0x01A47000;
export const ANIMATED_SHADOW_POOL_SIZE = ANIMATED_SHADOW_SPAN_SIZE *
  ANIMATION_TABLE_CAPACITY; // 320 B x 256 tracks = 0x14000

// Grid sizing-function entries. Each endpoint carries a primary f32 and a
// percentage companion so calc(<length> + <percentage>) survives to the axis
// basis used by layout. Pure values retain their existing tags and primary
// representation; their percentage companions are zero.
export const GRID_TRACK_POOL_BASE = 0x00557708;
export const GRID_TRACK_POOL_SIZE = 0x00004000;
export const GRID_TRACK_ENTRY_SIZE = 24;
export const GRID_TRACK_POOL_MAX_ENTRIES = Math.floor(
  GRID_TRACK_POOL_SIZE / GRID_TRACK_ENTRY_SIZE,
);
export const GRID_TRACK_OFFSET_MIN_TYPE = 0x00;
export const GRID_TRACK_OFFSET_MAX_TYPE = 0x01;
export const GRID_TRACK_OFFSET_MIN_VALUE = 0x04;
export const GRID_TRACK_OFFSET_MAX_VALUE = 0x08;
export const GRID_TRACK_OFFSET_MIN_PERCENTAGE = 0x0C;
export const GRID_TRACK_OFFSET_MAX_PERCENTAGE = 0x10;
export const GRID_SCRATCH_BASE = 0x0055B708;
export const GRID_SCRATCH_SIZE = 0x00020000;
export const GRID_SCRATCH_LEVEL_SIZE = 0x00004000;
export const GRID_SCRATCH_LEVELS = 8;

export const TABLE_SCRATCH_BASE = 0x0057B708;
export const TABLE_SCRATCH_SIZE = 0x00060000;
export const TABLE_SCRATCH_LEVEL_SIZE = 0x0000C000;
export const TABLE_SCRATCH_LEVELS = 8;
// Node-indexed geometry/cache regions are contiguous after INLINE_STATE_SCRATCH.
// Each covers all 2251 layout records; the former 819-row table-grid slot is free.
export const TABLE_GRID_BOX_BASE = 0x0071F240;
export const TABLE_GRID_BOX_SIZE = 0x00008CB0;
export const TABLE_GRID_BOX_ENTRY_SIZE = 16;
// A box that is not a table (DISPLAY_TABLE or DISPLAY_INLINE_TABLE) holds
// its multi-column record in its table-grid slot instead: a fragmented
// box's fragment count (0 when the box is not fragmented) and the
// addresses of its first and last fragment entries; a multi-column
// container's first row entry (engine-multicolumn.watpart).
export const MULTICOLUMN_RECORD_OFFSET_FRAGMENT_COUNT = 0x00;
export const MULTICOLUMN_RECORD_OFFSET_FIRST_FRAGMENT = 0x04;
export const MULTICOLUMN_RECORD_OFFSET_LAST_FRAGMENT = 0x08;
export const MULTICOLUMN_RECORD_OFFSET_FIRST_ROW = 0x0C;
// The entries the multi-column records address, in the old inline state
// scratch hole. Each entry holds the address of the next entry (0 ends
// the list), then four i32 LayoutUnits: a fragment's border box relative
// to its box's union border box, or a column row's top and bottom below
// the container's content box top and its last column. The pool persists
// across layout() calls and flips with the line pools at layout() entry
// once past its midpoint; a pass that needs more entries throws (trap
// site 14). 20 B x 4096 entries.
export const MULTICOLUMN_FRAGMENT_POOL_BASE = 0x004B5520;
export const MULTICOLUMN_FRAGMENT_POOL_SIZE = 0x00014000;
export const MULTICOLUMN_ENTRY_SIZE = 20;
export const MULTICOLUMN_ENTRY_OFFSET_NEXT = 0x00;
export const MULTICOLUMN_ENTRY_OFFSET_FRAGMENT_X = 0x04;
export const MULTICOLUMN_ENTRY_OFFSET_FRAGMENT_Y = 0x08;
export const MULTICOLUMN_ENTRY_OFFSET_FRAGMENT_WIDTH = 0x0C;
export const MULTICOLUMN_ENTRY_OFFSET_FRAGMENT_HEIGHT = 0x10;
export const MULTICOLUMN_ENTRY_OFFSET_ROW_TOP = 0x04;
export const MULTICOLUMN_ENTRY_OFFSET_ROW_BOTTOM = 0x08;
export const MULTICOLUMN_ENTRY_OFFSET_ROW_LAST_COLUMN = 0x0C;
// D1 piece 2: pristine layout-space geometry. layout() snapshots the
// computed-box records and the table-grid boxes right after the layout
// recursion, BEFORE the root margin shift, scroll translation, and sticky
// clamping mutate them in place. A layout-cache hit restores its subtree's
// geometry from this snapshot, and the post-passes then re-run over the
// whole tree each pass — no gating, no double-apply.
export const PRISTINE_BOX_BUFFER_BASE = 0x00727EF0;
export const PRISTINE_BOX_BUFFER_SIZE = 0x00011960; // 2251 × BOX_SIZE
export const PRISTINE_TABLE_GRID_BOX_BASE = 0x00739850;
export const PRISTINE_TABLE_GRID_BOX_SIZE = 0x00008CB0;
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
// MathML box results (plans/layout/PLAN-mathml-layout.md): one entry per
// layout node, written by the engine math layout for every math box. Ascent
// is the baseline offset from the border-box top and italic correction the
// MATH table value of a stretched operator, both i32 LayoutUnits. An
// operator with special shaping (Blink's MathOperatorLayoutAlgorithm) keeps
// the stretch target its glyph was shaped for, so paint shapes it again.
// The region follows FONT_STACK_TABLE in the old text-line pool hole (see
// TEXT_LINE_POOL_BASE).
export const MATH_BOX_BASE = 0x003C4840;
export const MATH_BOX_SIZE = 0x00008CB0;
export const MATH_BOX_ENTRY_SIZE = 16;
export const MATH_BOX_OFFSET_ASCENT = 0x00; // i32 LayoutUnits
export const MATH_BOX_OFFSET_ITALIC_CORRECTION = 0x04; // i32 LayoutUnits
// u32: 1 laid out by math layout this pass, 2 an operator the math painter
// paints, 4 its stretch axis is inline (horizontal)
export const MATH_BOX_OFFSET_FLAGS = 0x08;
export const MATH_BOX_OFFSET_OPERATOR_TARGET = 0x0C; // i32 LayoutUnits
export const SUBTREE_INFO_BASE = 0x00742500;
export const SUBTREE_INFO_SIZE = 0x00008CB0;
export const SUBTREE_INFO_ENTRY_SIZE = 16;
export const LAYOUT_CACHE_BASE = 0x0074B1B0;
export const LAYOUT_CACHE_SIZE = 0x00046580;
export const LAYOUT_CACHE_ENTRY_SIZE = 128;
// D2 piece A: engine-derived tile dirty. emit_commands ends by comparing
// every node's painted (post-post-pass) box against the previous frame's
// copy here, and marks old-box ∪ new-box tiles dirty for every node whose
// box moved or whose changedGen advanced past the last painted
// generation. This is the engine-side replacement for session.js's
// spec-rect marking and the DOM render surface's second-layout box diff
// (both deleted at the D3 cutover). Border-box semantics, matching the
// JS diff it replaces; transformed ink beyond the box keeps the same
// (pre-existing) box-granularity contract.
export const PREV_PAINTED_BOX_BASE = 0x00791730;
export const PREV_PAINTED_BOX_SIZE = 0x00011960;
// D2 piece B: the per-frame scroll table of CUMULATIVE device-px offsets
// (f32 dx, f32 dy - the sum of active ancestor scopes, including this
// one). Entry 0 belongs to the root/no-scroller state and stays zero;
// entry node + 1 is a scroll container's CMD_SET_SCROLL scope, resolved
// by containing block (absolute subtrees can adopt their containing
// block's outer scope; fixed subtrees adopt the zero scope); the entries
// from node count + 1 on are sticky scopes, one per sticky node in the
// order the full walk opens them. Two entries per node and the reserved
// one. Rewritten every emit; a scroll-only frame changes ONLY this table,
// never command bytes. It sits after TABLE_SCRATCH; the span
// [0x007A3090, 0x007A76F0) before SCROLL_LAST_EMITTED is unused.
export const SCROLL_TABLE_BASE = 0x005DB708;
export const SCROLL_TABLE_ENTRY_SIZE = 8;
export const SCROLL_TABLE_SIZE = 0x00008CB8; // 2 × 2251 nodes + reserved entry 0
// Separate regions: never borrow live scroll-table rows for emission history,
// nesting scratch, or scope flags.
export const SCROLL_LAST_EMITTED_BASE = 0x007A76F0;
export const SCROLL_LAST_EMITTED_SIZE = 0x00004660;
export const SCROLL_SAVE_STACK_BASE = 0x007ABD50;
export const SCROLL_SAVE_STACK_SIZE = 0x00003000; // 512 × 24-byte frames
export const SCROLL_SCOPE_FLAGS_BASE = 0x007AED50;
export const SCROLL_SCOPE_FLAGS_SIZE = 0x000008D0;
// The repacked tail and collapsed arena remain within the same reservation.
export const FIXED_REGIONS_END = 0x01A5B000;
export const ACTUAL_INITIAL_PAGES = 804; // includes the maximum checked collapsed-edge arena
// The collapsed-border arena starts exactly at FIXED_REGIONS_END and
// grows upward into the 804-page reservation. Metadata and original borders
// cover all layout nodes before edge storage begins. It sits OUTSIDE the fixed region
// map on purpose; verifyLayout compares this base against the engine's
// own global so a drift cannot recur silently. Before 2026-08-31 the
// engine's base was a stale 0x004CE640 — inside the mask-layer,
// gradient-scratch, background-layer, and border-image pools that were
// appended over that address later — so every layout pass corrupted
// BG_LAYER_POOL from node index 52 on (found from the Sandtable loop:
// a gradient background plus ~25 text runs trapped emit_commands with
// "float unrepresentable in integer range").
export const COLLAPSED_ARENA_BASE = FIXED_REGIONS_END;
export const COLLAPSED_META_SIZE = 0x00008CB0;
export const COLLAPSED_ORIGINAL_BASE = COLLAPSED_META_SIZE; // arena-relative
export const COLLAPSED_ORIGINAL_SIZE = 0x00039280;
export const COLLAPSED_ORIGINAL_STRIDE = 104;
export const COLLAPSED_EDGE_START = 0x00041F30;
export const LAYOUT_RESERVATION_END = ACTUAL_INITIAL_PAGES * 65536;
// Shared-memory sizing (plans/PLAN-safari-browser-support.md): HarfBuzz is
// linked with GLOBAL_BASE at ACTUAL_INITIAL_PAGES × 64 KB and its static
// data + stack occupy the pages above the layout reservation, so the ONE
// shared memory must start at hb.wasm's linked INITIAL_MEMORY (864 pages,
// -sINITIAL_MEMORY=56623104). Instantiation fails below this.
export const HB_INITIAL_PAGES = 864;
// The DOM core's static data begins where HarfBuzz's region ends (page 864,
// 0x03600000) and its heap at page 880; the shared memory starts at 944
// pages so the heap has four megabytes before the allocator first grows it.
export const DOM_BASE_PAGES = 864;
export const DOM_INITIAL_PAGES = 944;

// Sparse paint transactions publish changed command ranges through getters;
// their private row/range allocations do not occupy fixed-map addresses.
export const RETAINED_FRAME_ABI_VERSION = 2;

// =======================================================================
// Verification
// =======================================================================

export function verifyLayout(wasmExports) {
  const checks = [
    [
      "retainedFrameAbiVersion",
      wasmExports.retained_frame_abi_version(),
      RETAINED_FRAME_ABI_VERSION,
    ],
    ["headerBase", wasmExports.header_base(), HEADER_BASE],
    ["inheritedMaskFontSize", wasmExports.inherited_mask_font_size(), INHERITED_MASK_FONT_SIZE],
    ["inheritedMaskLineHeight", wasmExports.inherited_mask_line_height(), INHERITED_MASK_LINE_HEIGHT],
    ["nodeListMarkerOffset", wasmExports.node_list_marker_offset(), LAYOUT_NODE_OFFSET_LIST_MARKER],
    ["listMarkerOutside", wasmExports.list_marker_outside(), LIST_MARKER_OUTSIDE],
    ["nodeSvgPaintCurrentColorOffset", wasmExports.node_svg_paint_current_color_offset(), LAYOUT_NODE_OFFSET_SVG_PAINT_CURRENT_COLOR],
    ["svgPaintCurrentColorFill", wasmExports.svg_paint_current_color_fill(), SVG_PAINT_CURRENT_COLOR_FILL],
    ["svgPaintCurrentColorStroke", wasmExports.svg_paint_current_color_stroke(), SVG_PAINT_CURRENT_COLOR_STROKE],
    ["nodeLanguageOffset", wasmExports.node_language_offset(), LAYOUT_NODE_OFFSET_LANGUAGE],
    ["nodeLineBreakOffset", wasmExports.node_line_break_offset(), LAYOUT_NODE_OFFSET_LINE_BREAK],
    ["lineBreakStrict", wasmExports.line_break_strict(), LINE_BREAK_STRICT],
    ["lineBreakAnywhere", wasmExports.line_break_anywhere(), LINE_BREAK_ANYWHERE],
    ["lineBreakStrictnessMask", wasmExports.line_break_strictness_mask(), LINE_BREAK_STRICTNESS_MASK],
    ["wordBreakBreakAll", wasmExports.word_break_break_all(), WORD_BREAK_BREAK_ALL],
    ["wordBreakKeepAll", wasmExports.word_break_keep_all(), WORD_BREAK_KEEP_ALL],
    ["textSpacingTrimShift", wasmExports.text_spacing_trim_shift(), TEXT_SPACING_TRIM_SHIFT],
    ["textSpacingTrimMask", wasmExports.text_spacing_trim_mask(), TEXT_SPACING_TRIM_MASK],
    ["nodeScrollbarLayoutOffset", wasmExports.node_scrollbar_layout_offset(), LAYOUT_NODE_OFFSET_SCROLLBAR_LAYOUT],
    ["nodeScrollbarStateOffset", wasmExports.node_scrollbar_state_offset(), LAYOUT_NODE_OFFSET_SCROLLBAR_STATE],
    ["scrollbarThicknessMask", wasmExports.scrollbar_thickness_mask(), SCROLLBAR_THICKNESS_MASK],
    ["scrollbarVerticalLeft", wasmExports.scrollbar_vertical_left(), SCROLLBAR_VERTICAL_LEFT],
    ["scrollbarBothEdges", wasmExports.scrollbar_both_edges(), SCROLLBAR_BOTH_EDGES],
    ["scrollbarVerticalReserved", wasmExports.scrollbar_vertical_reserved(), SCROLLBAR_VERTICAL_RESERVED],
    ["scrollbarHorizontalReserved", wasmExports.scrollbar_horizontal_reserved(), SCROLLBAR_HORIZONTAL_RESERVED],
    ["scrollbarVerticalAuto", wasmExports.scrollbar_vertical_auto(), SCROLLBAR_VERTICAL_AUTO],
    ["scrollbarHorizontalAuto", wasmExports.scrollbar_horizontal_auto(), SCROLLBAR_HORIZONTAL_AUTO],
    ["scrollbarVerticalApplied", wasmExports.scrollbar_vertical_applied(), SCROLLBAR_VERTICAL_APPLIED],
    ["scrollbarHorizontalApplied", wasmExports.scrollbar_horizontal_applied(), SCROLLBAR_HORIZONTAL_APPLIED],
    ["scrollbarRegularThickness", wasmExports.scrollbar_regular_thickness(), SCROLLBAR_REGULAR_THICKNESS],
    ["scrollbarThinThickness", wasmExports.scrollbar_thin_thickness(), SCROLLBAR_THIN_THICKNESS],
    ["textSpacingTrimSpaceAll", wasmExports.text_spacing_trim_space_all(), TEXT_SPACING_TRIM_SPACE_ALL],
    ["textSpacingTrimSpaceFirst", wasmExports.text_spacing_trim_space_first(), TEXT_SPACING_TRIM_SPACE_FIRST],
    ["textSpacingTrimTrimStart", wasmExports.text_spacing_trim_trim_start(), TEXT_SPACING_TRIM_TRIM_START],
    ["tileConfigBase", wasmExports.tile_config_base(), TILE_CONFIG_BASE],
    ["tileConfigSize", wasmExports.tile_config_size(), TILE_CONFIG_SIZE],
    [
      "tileDirtyMapBase",
      wasmExports.tile_dirty_map_base(),
      TILE_DIRTY_MAP_BASE,
    ],
    ["walkStackBase", wasmExports.walk_stack_base(), WALK_STACK_BASE],
    ["opacityStackBase", wasmExports.opacity_stack_base(), OPACITY_STACK_BASE],
    [
      "batchDescriptorsBase",
      wasmExports.batch_descriptors_base(),
      BATCH_DESCRIPTORS_BASE,
    ],
    ["layoutBufferBase", wasmExports.layout_buffer_base(), LAYOUT_BUFFER_BASE],
    ["layoutBufferSize", wasmExports.layout_buffer_size(), LAYOUT_BUFFER_SIZE],
    [
      "commandBufferBase",
      wasmExports.command_buffer_base(),
      COMMAND_BUFFER_BASE,
    ],
    [
      "commandBufferSize",
      wasmExports.command_buffer_size(),
      COMMAND_BUFFER_SIZE,
    ],
    ["colorGlyphPathIndexBase", wasmExports.color_glyph_path_index_base(), COLOR_GLYPH_PATH_INDEX_BASE],
    ["builtinPathIndexBase", wasmExports.builtin_path_index_base(), BUILTIN_PATH_INDEX_BASE],
    ["listMarkerDisclosureClosed", wasmExports.list_marker_disclosure_closed(), LIST_MARKER_DISCLOSURE_CLOSED],
    ["listMarkerDisclosureOpen", wasmExports.list_marker_disclosure_open(), LIST_MARKER_DISCLOSURE_OPEN],
    ["colorGlyphImageIndexBase", wasmExports.color_glyph_image_index_base(), COLOR_GLYPH_IMAGE_INDEX_BASE],
    ["colorGlyphImageResourceCount", wasmExports.color_glyph_image_resource_count(), COLOR_GLYPH_IMAGE_RESOURCE_COUNT],
    ["cmdImageFlagGlyphBitmap", wasmExports.cmd_image_flag_glyph_bitmap(), CMD_IMAGE_FLAG_GLYPH_BITMAP],
    ["colorGlyphCacheIndexBase", wasmExports.color_glyph_cache_index_base(), COLOR_GLYPH_CACHE_INDEX_BASE],
    ["colorGlyphCacheCapacity", wasmExports.color_glyph_cache_capacity(), COLOR_GLYPH_CACHE_CAPACITY],
    ["colorGlyphCachePageIndexBase", wasmExports.color_glyph_cache_page_index_base(), COLOR_GLYPH_CACHE_PAGE_INDEX_BASE],
    ["colorGlyphCacheResourceCount", wasmExports.color_glyph_cache_resource_count(), COLOR_GLYPH_CACHE_RESOURCE_COUNT],
    ["fontUnitSubdivision", wasmExports.font_unit_subdivision(), FONT_UNIT_SUBDIVISION],
    ["gradientKindColrLinear", wasmExports.gradient_kind_colr_linear(), GRADIENT_KIND_COLR_LINEAR],
    ["gradientKindColrSweep", wasmExports.gradient_kind_colr_sweep(), GRADIENT_KIND_COLR_SWEEP],
    ["gradientKindFlagReflect", wasmExports.gradient_kind_flag_reflect(), GRADIENT_KIND_FLAG_REFLECT],
    ["cmdSvgPathFlagGlyphOrigin", wasmExports.cmd_svg_path_flag_glyph_origin(), CMD_SVG_PATH_FLAG_GLYPH_ORIGIN],
    ["clipEntryFlagGlyphOrigin", wasmExports.clip_entry_flag_glyph_origin(), CLIP_ENTRY_FLAG_GLYPH_ORIGIN],
    ["cmdPushOpacityOffsetComposite", wasmExports.cmd_push_opacity_offset_composite(), CMD_PUSH_OPACITY_OFFSET_COMPOSITE],
    ["glyphBufferBase", wasmExports.glyph_buffer_base(), GLYPH_BUFFER_BASE],
    ["glyphBufferSize", wasmExports.glyph_buffer_size(), GLYPH_BUFFER_SIZE],
    [
      "prevCommandBufferBase",
      wasmExports.prev_command_buffer_base(),
      PREV_COMMAND_BUFFER_BASE,
    ],
    [
      "computedBoxBufferBase",
      wasmExports.computed_box_buffer_base(),
      COMPUTED_BOX_BUFFER_BASE,
    ],
    [
      "computedBoxBufferSize",
      wasmExports.computed_box_buffer_size(),
      COMPUTED_BOX_BUFFER_SIZE,
    ],
    [
      "scrollDataBufferBase",
      wasmExports.scroll_data_buffer_base(),
      SCROLL_DATA_BUFFER_BASE,
    ],
    [
      "scrollDataBufferSize",
      wasmExports.scroll_data_buffer_size(),
      SCROLL_DATA_BUFFER_SIZE,
    ],
    [
      "constraintStackBase",
      wasmExports.constraint_stack_base(),
      CONSTRAINT_STACK_BASE,
    ],
    [
      "constraintStackSize",
      wasmExports.constraint_stack_size(),
      CONSTRAINT_STACK_SIZE,
    ],
    [
      "intrinsicBufferBase",
      wasmExports.intrinsic_buffer_base(),
      INTRINSIC_BUFFER_BASE,
    ],
    [
      "intrinsicBufferSize",
      wasmExports.intrinsic_buffer_size(),
      INTRINSIC_BUFFER_SIZE,
    ],
    ["flexScratchBase", wasmExports.flex_scratch_base(), FLEX_SCRATCH_BASE],
    ["flexScratchSize", wasmExports.flex_scratch_size(), FLEX_SCRATCH_SIZE],
    [
      "gridTrackPoolBase",
      wasmExports.grid_track_pool_base(),
      GRID_TRACK_POOL_BASE,
    ],
    [
      "gridTrackPoolSize",
      wasmExports.grid_track_pool_size(),
      GRID_TRACK_POOL_SIZE,
    ],
    ["gridScratchBase", wasmExports.grid_scratch_base(), GRID_SCRATCH_BASE],
    ["gridScratchSize", wasmExports.grid_scratch_size(), GRID_SCRATCH_SIZE],
    ["tableScratchBase", wasmExports.table_scratch_base(), TABLE_SCRATCH_BASE],
    ["tableScratchSize", wasmExports.table_scratch_size(), TABLE_SCRATCH_SIZE],
    [
      "tableGridBoxBase",
      wasmExports.table_grid_box_base(),
      TABLE_GRID_BOX_BASE,
    ],
    [
      "tableGridBoxSize",
      wasmExports.table_grid_box_size(),
      TABLE_GRID_BOX_SIZE,
    ],
    [
      "multicolumnFragmentPoolBase",
      wasmExports.multicolumn_fragment_pool_base(),
      MULTICOLUMN_FRAGMENT_POOL_BASE,
    ],
    [
      "multicolumnFragmentPoolSize",
      wasmExports.multicolumn_fragment_pool_size(),
      MULTICOLUMN_FRAGMENT_POOL_SIZE,
    ],
    [
      "pristineBoxBufferBase",
      wasmExports.pristine_box_buffer_base(),
      PRISTINE_BOX_BUFFER_BASE,
    ],
    [
      "pristineBoxBufferSize",
      wasmExports.pristine_box_buffer_size(),
      PRISTINE_BOX_BUFFER_SIZE,
    ],
    [
      "pristineTableGridBoxBase",
      wasmExports.pristine_table_grid_box_base(),
      PRISTINE_TABLE_GRID_BOX_BASE,
    ],
    [
      "pristineTableGridBoxSize",
      wasmExports.pristine_table_grid_box_size(),
      PRISTINE_TABLE_GRID_BOX_SIZE,
    ],
    [
      "exclusionScratchBase",
      wasmExports.exclusion_scratch_base(),
      EXCLUSION_SCRATCH_BASE,
    ],
    [
      "exclusionScratchSize",
      wasmExports.exclusion_scratch_size(),
      EXCLUSION_SCRATCH_SIZE,
    ],
    [
      "subtreeInfoBase",
      wasmExports.subtree_info_base(),
      SUBTREE_INFO_BASE,
    ],
    ["mathBoxBase", wasmExports.math_box_base(), MATH_BOX_BASE],
    ["mathBoxSize", wasmExports.math_box_size(), MATH_BOX_SIZE],
    ["mathBoxStride", wasmExports.math_box_entry_size(), MATH_BOX_ENTRY_SIZE],
    [
      "subtreeInfoSize",
      wasmExports.subtree_info_size(),
      SUBTREE_INFO_SIZE,
    ],
    [
      "layoutCacheBase",
      wasmExports.layout_cache_base(),
      LAYOUT_CACHE_BASE,
    ],
    [
      "layoutCacheSize",
      wasmExports.layout_cache_size(),
      LAYOUT_CACHE_SIZE,
    ],
    [
      "prevPaintedBoxBase",
      wasmExports.prev_painted_box_base(),
      PREV_PAINTED_BOX_BASE,
    ],
    [
      "prevPaintedBoxSize",
      wasmExports.prev_painted_box_size(),
      PREV_PAINTED_BOX_SIZE,
    ],
    [
      "scrollTableBase",
      wasmExports.scroll_table_base(),
      SCROLL_TABLE_BASE,
    ],
    [
      "scrollTableSize",
      wasmExports.scroll_table_size(),
      SCROLL_TABLE_SIZE,
    ],
    [
      "scrollLastEmittedBase",
      wasmExports.scroll_last_emitted_base(),
      SCROLL_LAST_EMITTED_BASE,
    ],
    [
      "scrollLastEmittedSize",
      wasmExports.scroll_last_emitted_size(),
      SCROLL_LAST_EMITTED_SIZE,
    ],
    [
      "scrollSaveStackBase",
      wasmExports.scroll_save_stack_base(),
      SCROLL_SAVE_STACK_BASE,
    ],
    [
      "scrollSaveStackSize",
      wasmExports.scroll_save_stack_size(),
      SCROLL_SAVE_STACK_SIZE,
    ],
    [
      "scrollScopeFlagsBase",
      wasmExports.scroll_scope_flags_base(),
      SCROLL_SCOPE_FLAGS_BASE,
    ],
    [
      "scrollScopeFlagsSize",
      wasmExports.scroll_scope_flags_size(),
      SCROLL_SCOPE_FLAGS_SIZE,
    ],
    [
      "subtreeInfoStride",
      wasmExports.subtree_info_entry_size(),
      SUBTREE_INFO_ENTRY_SIZE,
    ],
    [
      "layoutCacheStride",
      wasmExports.layout_cache_entry_size(),
      LAYOUT_CACHE_ENTRY_SIZE,
    ],
    // Arena-relative offsets are not fixed-region addresses.
    [
      "collapsedMetaBytes",
      wasmExports.collapsed_meta_size(),
      COLLAPSED_META_SIZE,
    ],
    [
      "collapsedOriginalOffset",
      wasmExports.collapsed_original_base(),
      COLLAPSED_ORIGINAL_BASE,
    ],
    [
      "collapsedOriginalBytes",
      wasmExports.collapsed_original_size(),
      COLLAPSED_ORIGINAL_SIZE,
    ],
    [
      "collapsedOriginalStride",
      wasmExports.collapsed_original_stride(),
      COLLAPSED_ORIGINAL_STRIDE,
    ],
    [
      "collapsedEdgeStart",
      wasmExports.collapsed_edge_start(),
      COLLAPSED_EDGE_START,
    ],
    [
      "layoutReservationEnd",
      wasmExports.layout_reservation_end(),
      LAYOUT_RESERVATION_END,
    ],
    [
      "collapsedArenaBase",
      wasmExports.collapsed_arena_base(),
      COLLAPSED_ARENA_BASE,
    ],
    ["shelfGeomBase", wasmExports.shelf_geom_base(), SHELF_GEOM_BASE],
    ["shelfGeomSize", wasmExports.shelf_geom_size(), SHELF_GEOM_SIZE],
    ["debugTraceBase", wasmExports.debug_trace_base(), DEBUG_TRACE_BASE],
    ["debugTraceSize", wasmExports.debug_trace_size(), DEBUG_TRACE_SIZE],
    ["textRunDirBase", wasmExports.text_run_dir_base(), TEXT_RUN_DIR_BASE],
    ["textRunDirSize", wasmExports.text_run_dir_size(), TEXT_RUN_DIR_SIZE],
    ["textSourceBase", wasmExports.text_source_base(), TEXT_SOURCE_BASE],
    ["textSourceSize", wasmExports.text_source_size(), TEXT_SOURCE_SIZE],
    [
      "shapedGlyphPoolBase",
      wasmExports.shaped_glyph_pool_base(),
      SHAPED_GLYPH_POOL_BASE,
    ],
    [
      "shapedGlyphPoolSize",
      wasmExports.shaped_glyph_pool_size(),
      SHAPED_GLYPH_POOL_SIZE,
    ],
    [
      "shapedGlyphEntrySize",
      wasmExports.shaped_glyph_entry_size(),
      SHAPED_GLYPH_ENTRY_SIZE,
    ],
    [
      "shapedGlyphOffsetFont",
      wasmExports.shaped_glyph_offset_font(),
      SHAPED_GLYPH_OFFSET_FONT,
    ],
    ["shapedGlyphOffsetHanKerning", wasmExports.shaped_glyph_offset_han_kerning(), SHAPED_GLYPH_OFFSET_HAN_KERNING],
    ["shapedGlyphFlagHalt", wasmExports.shaped_glyph_flag_halt(), SHAPED_GLYPH_FLAG_HALT],
    [
      "textRunValidGenBase",
      wasmExports.text_run_valid_gen_base(),
      TEXT_RUN_VALID_GEN_BASE,
    ],
    [
      "textRunValidGenSize",
      wasmExports.text_run_valid_gen_size(),
      TEXT_RUN_VALID_GEN_SIZE,
    ],
    [
      "textLinePoolBase",
      wasmExports.text_line_pool_base(),
      TEXT_LINE_POOL_BASE,
    ],
    [
      "textLinePoolSize",
      wasmExports.text_line_pool_size(),
      TEXT_LINE_POOL_SIZE,
    ],
    [
      "textPosScratchBase",
      wasmExports.text_pos_scratch_base(),
      TEXT_POS_SCRATCH_BASE,
    ],
    [
      "textPosScratchSize",
      wasmExports.text_pos_scratch_size(),
      TEXT_POS_SCRATCH_SIZE,
    ],
    [
      "inlineItemPoolBase",
      wasmExports.inline_item_pool_base(),
      INLINE_ITEM_POOL_BASE,
    ],
    [
      "inlineItemPoolSize",
      wasmExports.inline_item_pool_size(),
      INLINE_ITEM_POOL_SIZE,
    ],
    [
      "inlineGlyphMapBase",
      wasmExports.inline_glyph_map_base(),
      INLINE_GLYPH_MAP_BASE,
    ],
    [
      "inlineGlyphMapSize",
      wasmExports.inline_glyph_map_size(),
      INLINE_GLYPH_MAP_SIZE,
    ],
    [
      "inlineEdgeMapBase",
      wasmExports.inline_edge_map_base(),
      INLINE_EDGE_MAP_BASE,
    ],
    [
      "inlineEdgeMapSize",
      wasmExports.inline_edge_map_size(),
      INLINE_EDGE_MAP_SIZE,
    ],
    [
      "lineFragmentPoolBase",
      wasmExports.line_fragment_pool_base(),
      LINE_FRAGMENT_POOL_BASE,
    ],
    [
      "lineFragmentPoolSize",
      wasmExports.line_fragment_pool_size(),
      LINE_FRAGMENT_POOL_SIZE,
    ],
    ["nodeSize", wasmExports.node_size(), LAYOUT_NODE_SIZE],
    ["fontTableBase", wasmExports.font_table_base(), FONT_TABLE_BASE],
    ["fontTableSize", wasmExports.font_table_size(), FONT_TABLE_SIZE],
    ["fontTableEntrySize", wasmExports.font_table_entry_size(), FONT_TABLE_ENTRY_SIZE],
    ["fontTableLengthOffset", wasmExports.font_table_length_offset(), FONT_TABLE_OFFSET_LENGTH],
    ["fontTableHashOffset", wasmExports.font_table_hash_offset(), FONT_TABLE_OFFSET_HASH],
    ["languageTableBase", wasmExports.language_table_base(), LANGUAGE_TABLE_BASE],
    ["languageTableSize", wasmExports.language_table_size(), LANGUAGE_TABLE_SIZE],
    ["languageTableEntrySize", wasmExports.language_table_entry_size(), LANGUAGE_TABLE_ENTRY_SIZE],
    ["languageTableFeaturesBase", wasmExports.language_table_features_base(), LANGUAGE_TABLE_FEATURES_BASE],
    ["languageTableFeaturesSize", wasmExports.language_table_features_size(), LANGUAGE_TABLE_FEATURES_SIZE],
    [
      "languageTableFeaturesEntrySize",
      wasmExports.language_table_features_entry_size(),
      LANGUAGE_TABLE_FEATURES_ENTRY_SIZE,
    ],
    [
      "languageTableFeaturesOffsetCount",
      wasmExports.language_table_features_offset_count(),
      LANGUAGE_TABLE_FEATURES_OFFSET_COUNT,
    ],
    [
      "languageTableFeaturesOffsetVariantCount",
      wasmExports.language_table_features_offset_variant_count(),
      LANGUAGE_TABLE_FEATURES_OFFSET_VARIANT_COUNT,
    ],
    [
      "fontVariationTableBase",
      wasmExports.font_variation_table_base(),
      FONT_VARIATION_TABLE_BASE,
    ],
    [
      "fontVariationTableSize",
      wasmExports.font_variation_table_size(),
      FONT_VARIATION_TABLE_SIZE,
    ],
    [
      "fontDecorationTableBase",
      wasmExports.font_decoration_table_base(),
      FONT_DECORATION_TABLE_BASE,
    ],
    [
      "fontDecorationTableSize",
      wasmExports.font_decoration_table_size(),
      FONT_DECORATION_TABLE_SIZE,
    ],
    ["fontStackTableBase", wasmExports.font_stack_table_base(), FONT_STACK_TABLE_BASE],
    ["fontStackTableSize", wasmExports.font_stack_table_size(), FONT_STACK_TABLE_SIZE],
    ["fontStackEntrySize", wasmExports.font_stack_entry_size(), FONT_STACK_ENTRY_SIZE],
    ["fontStackOffsetSlots", wasmExports.font_stack_offset_slots(), FONT_STACK_OFFSET_SLOTS],
    ["fontStackSlotSize", wasmExports.font_stack_slot_size(), FONT_STACK_SLOT_SIZE],
    ["imageTableBase", wasmExports.image_table_base(), IMAGE_TABLE_BASE],
    ["imageTableSize", wasmExports.image_table_size(), IMAGE_TABLE_SIZE],
    ["bgLayerPoolBase", wasmExports.bg_layer_pool_base(), BG_LAYER_POOL_BASE],
    ["bgLayerPoolSize", wasmExports.bg_layer_pool_size(), BG_LAYER_POOL_SIZE],
    [
      "maskLayerPoolBase",
      wasmExports.mask_layer_pool_base(),
      MASK_LAYER_POOL_BASE,
    ],
    [
      "maskLayerPoolSize",
      wasmExports.mask_layer_pool_size(),
      MASK_LAYER_POOL_SIZE,
    ],
    [
      "borderImagePoolBase",
      wasmExports.border_image_pool_base(),
      BORDER_IMAGE_POOL_BASE,
    ],
    [
      "borderImagePoolSize",
      wasmExports.border_image_pool_size(),
      BORDER_IMAGE_POOL_SIZE,
    ],
    [
      "gradDescScratchBase",
      wasmExports.grad_desc_scratch_base(),
      GRAD_DESC_SCRATCH_BASE,
    ],
    ["svgGeomPoolBase", wasmExports.svg_geom_pool_base(), SVG_GEOM_POOL_BASE],
    ["svgGeomPoolSize", wasmExports.svg_geom_pool_size(), SVG_GEOM_POOL_SIZE],
    [
      "gradientStopPoolBase",
      wasmExports.gradient_stop_pool_base(),
      GRADIENT_STOP_POOL_BASE,
    ],
    [
      "gradientStopPoolSize",
      wasmExports.gradient_stop_pool_size(),
      GRADIENT_STOP_POOL_SIZE,
    ],
    ["shadowPoolBase", wasmExports.shadow_pool_base(), SHADOW_POOL_BASE],
    ["shadowPoolSize", wasmExports.shadow_pool_size(), SHADOW_POOL_SIZE],
    ["clipArenaBase", wasmExports.clip_arena_base(), CLIP_ARENA_BASE],
    ["clipArenaSize", wasmExports.clip_arena_size(), CLIP_ARENA_SIZE],
    ["clipEntrySize", wasmExports.clip_entry_size(), CLIP_ENTRY_SIZE],
    [
      "clipPathPoolBase",
      wasmExports.clip_path_pool_base(),
      CLIP_PATH_POOL_BASE,
    ],
    [
      "clipPathPoolSize",
      wasmExports.clip_path_pool_size(),
      CLIP_PATH_POOL_SIZE,
    ],
    ["filterPoolBase", wasmExports.filter_pool_base(), FILTER_POOL_BASE],
    ["filterPoolSize", wasmExports.filter_pool_size(), FILTER_POOL_SIZE],
    [
      "filterSegmentScratchBase",
      wasmExports.filter_segment_scratch_base(),
      FILTER_SEGMENT_SCRATCH_BASE,
    ],
    [
      "animationTableBase",
      wasmExports.animation_table_base(),
      ANIMATION_TABLE_BASE,
    ],
    [
      "animationTableSize",
      wasmExports.animation_table_size(),
      ANIMATION_TABLE_SIZE,
    ],
    ["keyframePoolBase", wasmExports.keyframe_pool_base(), KEYFRAME_POOL_BASE],
    ["keyframePoolSize", wasmExports.keyframe_pool_size(), KEYFRAME_POOL_SIZE],
    [
      "animatedShadowPoolBase",
      wasmExports.animated_shadow_pool_base(),
      ANIMATED_SHADOW_POOL_BASE,
    ],
    [
      "animatedShadowPoolSize",
      wasmExports.animated_shadow_pool_size(),
      ANIMATED_SHADOW_POOL_SIZE,
    ],
    [
      "transformComponentPoolBase",
      wasmExports.transform_component_pool_base(),
      TRANSFORM_COMPONENT_POOL_BASE,
    ],
    [
      "transformComponentPoolSize",
      wasmExports.transform_component_pool_size(),
      TRANSFORM_COMPONENT_POOL_SIZE,
    ],
    [
      "transformComponentBitmapBase",
      wasmExports.transform_component_bitmap_base(),
      TRANSFORM_COMPONENT_BITMAP_BASE,
    ],
    [
      "transformComponentBitmapSize",
      wasmExports.transform_component_bitmap_size(),
      TRANSFORM_COMPONENT_BITMAP_SIZE,
    ],
    [
      "transformSourceTableBase",
      wasmExports.transform_source_table_base(),
      TRANSFORM_SOURCE_TABLE_BASE,
    ],
    [
      "transformSourceTableSize",
      wasmExports.transform_source_table_size(),
      TRANSFORM_SOURCE_TABLE_SIZE,
    ],
    [
      "effectStackTableBase",
      wasmExports.effect_stack_table_base(),
      EFFECT_STACK_TABLE_BASE,
    ],
    [
      "effectStackTableSize",
      wasmExports.effect_stack_table_size(),
      EFFECT_STACK_TABLE_SIZE,
    ],
    [
      "linearEasingPoolBase",
      wasmExports.linear_easing_pool_base(),
      LINEAR_EASING_POOL_BASE,
    ],
    [
      "linearEasingPoolSize",
      wasmExports.linear_easing_pool_size(),
      LINEAR_EASING_POOL_SIZE,
    ],
    [
      "animationEventQueueBase",
      wasmExports.animation_event_queue_base(),
      ANIMATION_EVENT_QUEUE_BASE,
    ],
    [
      "animationEventQueueSize",
      wasmExports.animation_event_queue_size(),
      ANIMATION_EVENT_QUEUE_SIZE,
    ],
    [
      "animationResultBase",
      wasmExports.animation_result_base(),
      ANIMATION_RESULT_BASE,
    ],
    [
      "animationResultSize",
      wasmExports.animation_result_size(),
      ANIMATION_RESULT_SIZE,
    ],
    [
      "rasterPlanAbiVersion",
      wasmExports.raster_plan_abi_version(),
      RASTER_PLAN_ABI_VERSION,
    ],
    [
      "rasterPlanHeaderSize",
      wasmExports.raster_plan_header_size(),
      RASTER_PLAN_HEADER_SIZE,
    ],
    [
      "rasterPlanRecordSize",
      wasmExports.raster_plan_record_size(),
      RASTER_PLAN_RECORD_SIZE,
    ],
    [
      "rasterPlanClipEntrySize",
      wasmExports.raster_plan_clip_entry_size(),
      RASTER_PLAN_CLIP_ENTRY_SIZE,
    ],
    [
      "rasterPlanScrollbarRowSize",
      wasmExports.raster_plan_scrollbar_row_size(),
      RASTER_PLAN_SCROLLBAR_ROW_SIZE,
    ],
    ["glyphRequestHeaderSize", wasmExports.glyph_request_header_size(), GLYPH_REQUEST_HEADER_SIZE],
    ["glyphRequestRowSize", wasmExports.glyph_request_row_size(), GLYPH_REQUEST_ROW_SIZE],
  ];

  const mismatches = [];
  for (const [name, wasmValue, jsValue] of checks) {
    const actual = wasmValue >>> 0;
    if (actual !== jsValue) {
      mismatches.push(`${name}: WASM=${hex(actual)} JS=${hex(jsValue)}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Layout mismatch between engine.wat and layout.js:\n  ${
        mismatches.join("\n  ")
      }`,
    );
  }

  const nodeCapacity = Math.floor(LAYOUT_BUFFER_SIZE / LAYOUT_NODE_SIZE);
  const nodeRegions = [
    ["computed boxes", COMPUTED_BOX_BUFFER_SIZE, BOX_SIZE],
    ["table-grid boxes", TABLE_GRID_BOX_SIZE, TABLE_GRID_BOX_ENTRY_SIZE],
    ["pristine boxes", PRISTINE_BOX_BUFFER_SIZE, BOX_SIZE],
    [
      "pristine table-grid boxes",
      PRISTINE_TABLE_GRID_BOX_SIZE,
      TABLE_GRID_BOX_ENTRY_SIZE,
    ],
    ["subtree info", SUBTREE_INFO_SIZE, SUBTREE_INFO_ENTRY_SIZE],
    ["math boxes", MATH_BOX_SIZE, MATH_BOX_ENTRY_SIZE],
    ["layout cache", LAYOUT_CACHE_SIZE, LAYOUT_CACHE_ENTRY_SIZE],
    ["previous painted boxes", PREV_PAINTED_BOX_SIZE, BOX_SIZE],
    ["scroll data", SCROLL_DATA_BUFFER_SIZE, SCROLL_DATA_ENTRY_SIZE],
    ["text run directory", TEXT_RUN_DIR_SIZE, TEXT_RUN_ENTRY_SIZE],
    [
      "scroll table",
      SCROLL_TABLE_SIZE - SCROLL_TABLE_ENTRY_SIZE,
      SCROLL_TABLE_ENTRY_SIZE * 2,
    ],
    [
      "scroll emission history",
      SCROLL_LAST_EMITTED_SIZE,
      SCROLL_TABLE_ENTRY_SIZE,
    ],
    ["scroll scope flags", SCROLL_SCOPE_FLAGS_SIZE, 1],
    ["collapsed metadata", COLLAPSED_META_SIZE, 16],
    [
      "collapsed border originals",
      COLLAPSED_ORIGINAL_SIZE,
      COLLAPSED_ORIGINAL_STRIDE,
    ],
  ];
  for (const [name, size, stride] of nodeRegions) {
    if (Math.floor(size / stride) < nodeCapacity) {
      throw new Error(`${name} capacity is smaller than layout-node capacity`);
    }
  }
  if (
    COLLAPSED_ORIGINAL_BASE < COLLAPSED_META_SIZE ||
    COLLAPSED_EDGE_START < COLLAPSED_ORIGINAL_BASE + COLLAPSED_ORIGINAL_SIZE ||
    COLLAPSED_ARENA_BASE + COLLAPSED_EDGE_START > LAYOUT_RESERVATION_END
  ) {
    throw new Error(
      "Collapsed-border storage overlaps metadata or the HarfBuzz reservation",
    );
  }

  // Region OVERLAP, which the mirror comparison above structurally cannot
  // catch: it compares each region's WAT constant against its JS one, so
  // a base/size edited consistently in BOTH files but landing inside a
  // neighbour passes every check while two features silently scribble on
  // each other. Added when BG_LAYER_POOL's stride grew 24 -> 80 and the
  // pool had to move; the alternative (renumbering the ~14 bases that
  // followed it) is exactly the edit this guard exists for.
  //
  // Every (base, size) pair from `checks`, paired by name — a `…Base`
  // entry with a matching `…Size` entry. Regions with no size export
  // (scratch slots) are skipped: nothing to range-check.
  const bases = new Map();
  const sizes = new Map();
  for (const [name, , jsValue] of checks) {
    if (name.endsWith("Base")) bases.set(name.slice(0, -4), jsValue);
    else if (name.endsWith("Size")) sizes.set(name.slice(0, -4), jsValue);
  }
  const regions = [...bases]
    .filter(([key]) => sizes.has(key))
    .map(([key, base]) => ({ key, base, end: base + sizes.get(key) }))
    .sort((a, b) => a.base - b.base);
  const overlaps = [];
  for (let i = 1; i < regions.length; i++) {
    const prev = regions[i - 1];
    const cur = regions[i];
    if (cur.base < prev.end) {
      overlaps.push(
        `${prev.key} [${hex(prev.base)}, ${
          hex(prev.end)
        }) overlaps ${cur.key} [${hex(cur.base)}, ${hex(cur.end)})`,
      );
    }
  }
  if (overlaps.length > 0) {
    throw new Error(
      `Overlapping memory regions in layout.js:\n  ${overlaps.join("\n  ")}`,
    );
  }
  const last = regions[regions.length - 1];
  if (last && last.end > FIXED_REGIONS_END) {
    throw new Error(
      `Region ${last.key} ends at ${hex(last.end)}, past FIXED_REGIONS_END ${
        hex(FIXED_REGIONS_END)
      } ` +
        `— grow FIXED_REGIONS_END and ACTUAL_INITIAL_PAGES together`,
    );
  }
}

function hex(n) {
  return "0x" + n.toString(16).padStart(8, "0");
}
