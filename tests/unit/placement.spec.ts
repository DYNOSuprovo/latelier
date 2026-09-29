import { describe, it, expect, vi } from 'vitest';
import { placeFloatingPanel, OPERATOR_PANEL_SIZE } from '../../src/features/fieldSuggestions/placement';

const VIEWPORT = { width: 1200, height: 800 };

describe('OPERATOR_PANEL_SIZE', () => {
  it('is the shared 340x360 footprint', () => {
    expect(OPERATOR_PANEL_SIZE).toEqual({ width: 340, height: 360 });
  });
});

describe('placeFloatingPanel', () => {
  it('returns preferred "right" when there is room', () => {
    const anchor = { top: 200, left: 300, width: 200, height: 40 };
    const panel = { width: 340, height: 360 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('right');
    expect(r.left).toBe(300 + 200 + 8);
    expect(r.top).toBe(200);
  });

  it('flips to "left" when the right edge would overflow', () => {
    const anchor = { top: 100, left: 1000, width: 100, height: 40 };
    const panel = { width: 340, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('left');
    expect(r.left).toBe(1000 - 340 - 8);
  });

  it('falls back to "below" when both sides are too narrow', () => {
    const anchor = { top: 20, left: 20, width: 1000, height: 40 };
    const panel = { width: 340, height: 200 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('below');
    expect(r.top).toBe(20 + 40 + 8);
    expect(r.left).toBe(20);
  });

  it('falls back to "above" when below would overflow', () => {
    const anchor = { top: 600, left: 20, width: 1160, height: 40 };
    const panel = { width: 340, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('above');
    expect(r.top).toBe(600 - 300 - 8);
  });

  it('clamps coordinates when nothing fits', () => {
    const anchor = { top: 10, left: 10, width: 50, height: 20 };
    const panel = { width: 2000, height: 2000 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('right');
    // Even though nothing fits, coords should be clamped to at least the
    // top-left margin.
    expect(r.top).toBeGreaterThanOrEqual(8);
    expect(r.left).toBeGreaterThanOrEqual(8);
  });

  it('uses the caller-supplied viewport size', () => {
    const small = { width: 400, height: 300 };
    const anchor = { top: 50, left: 50, width: 100, height: 40 };
    const panel = { width: 340, height: 300 };
    // Right fits at left=158 (50+100+8), right edge at 498 — exceeds 400.
    // Left fits at left = -298 — negative. Below fits at top = 98, bottom = 398
    // — exceeds 300. Above: top = 50-300-8 = -258 — negative. Nothing fits
    // → clamped.
    const r = placeFloatingPanel(anchor, panel, 'right', small);
    expect(r.placement).toBe('right');
    expect(r.top).toBeGreaterThanOrEqual(8);
    expect(r.left).toBeGreaterThanOrEqual(8);
  });

  it('respects the "below" preference when right fits too', () => {
    const anchor = { top: 100, left: 100, width: 200, height: 40 };
    const panel = { width: 340, height: 100 };
    const r = placeFloatingPanel(anchor, panel, 'below', VIEWPORT);
    expect(r.placement).toBe('below');
  });

  it('flips "left" to "right" when the left edge would overflow', () => {
    const anchor = { top: 100, left: 20, width: 50, height: 40 };
    const panel = { width: 340, height: 100 };
    const r = placeFloatingPanel(anchor, panel, 'left', VIEWPORT);
    expect(r.placement).toBe('right');
    expect(r.left).toBe(20 + 50 + 8);
  });

  it('flips "above" to "below" when the top edge would overflow', () => {
    const anchor = { top: 20, left: 400, width: 100, height: 40 };
    const panel = { width: 200, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'above', VIEWPORT);
    expect(r.placement).toBe('below');
    expect(r.top).toBe(20 + 40 + 8);
  });

  it('flips "below" to "above" when the bottom edge would overflow', () => {
    const anchor = { top: 750, left: 400, width: 100, height: 40 };
    const panel = { width: 200, height: 100 };
    const r = placeFloatingPanel(anchor, panel, 'below', VIEWPORT);
    expect(r.placement).toBe('above');
    expect(r.top).toBe(750 - 100 - 8);
  });

  it('falls back to the default viewport size when neither `viewport` nor `window` is available', () => {
    // No `viewport` argument, and the unit test project runs in Node, so
    // `window` is also undefined — this exercises the 1024x768 default.
    const anchor = { top: 100, left: 900, width: 50, height: 40 };
    const panel = { width: 340, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'right');
    // 'right' overflows a 1024-wide viewport (900+50+8+340 > 1016), so it
    // flips to 'left' — this value only comes out right if the 1024
    // fallback was actually used.
    expect(r.placement).toBe('left');
    expect(r.left).toBe(900 - 340 - 8);
    expect(r.top).toBe(100);
  });

  it("reads the window's size when no `viewport` is passed and a window exists", () => {
    // The renderer always has a window; the default above only covers Node.
    const anchor = { top: 100, left: 900, width: 50, height: 40 };
    const panel = { width: 340, height: 300 };
    try {
      vi.stubGlobal('window', { innerWidth: 2000, innerHeight: 1000 });
      // 'right' fits a 2000-wide window, where a 1024 default flips it to 'left'.
      expect(placeFloatingPanel(anchor, panel, 'right').placement).toBe('right');
      vi.stubGlobal('window', { innerWidth: 2000, innerHeight: 350 });
      // 'below' overflows a 350-high window (148+300 > 342), where a 768
      // default would place it at 148; with 'above' off-screen too, the
      // preferred placement is clamped to 350-8-300.
      expect(placeFloatingPanel(anchor, panel, 'below').top).toBe(42);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats the fits() bounds as inclusive at the left edge', () => {
    // 'right' overflows comfortably; 'left' lands exactly on the left
    // margin (left === MARGIN); 'below' would land somewhere else
    // entirely, so a wrongly-exclusive `left >= MARGIN` check is caught by
    // the reported placement, not just masked by clamping.
    const anchor = { top: 100, left: 356, width: 900, height: 40 };
    const panel = { width: 340, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('left');
    expect(r.left).toBe(8);
  });

  it('treats the fits() bounds as inclusive at the right edge', () => {
    // 'left' overflows comfortably (goes negative); 'right' lands exactly
    // on the right margin (left + panel.width === vw - MARGIN).
    const anchor = { top: 100, left: 50, width: 794, height: 40 };
    const panel = { width: 340, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'left', VIEWPORT);
    expect(r.placement).toBe('right');
    expect(r.left).toBe(1200 - 8 - 340);
  });

  it('treats the fits() bounds as inclusive at the bottom edge', () => {
    // 'right' and 'left' both fail on the (deliberately invalid) raw
    // anchor.top; 'below' recomputes its own top and lands exactly on the
    // bottom margin (top + panel.height === vh - MARGIN); 'above' fails
    // comfortably. A wrongly-exclusive check here falls through to the
    // clamped fallback instead, which reports a different placement.
    const anchor = { top: -1000, left: 400, width: 0, height: 1484 };
    const panel = { width: 100, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('below');
    expect(r.top).toBe(800 - 8 - 300);
    expect(r.left).toBe(400);
  });

  it('clamps a too-tall panel up to the top margin, not down past it', () => {
    // top starts negative (below the margin) and maxTop is comfortably
    // larger than MARGIN, so `Math.max(top, MARGIN)` and the outer
    // `Math.min(..., maxTop)` each do real, distinguishable work here.
    const anchor = { top: -50, left: 50, width: 0, height: 0 };
    const panel = { width: 2000, height: 100 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.top).toBe(8);
  });

  it('clamps a too-wide panel up to the left margin, not down past it', () => {
    const anchor = { top: 50, left: -50, width: 0, height: 0 };
    const panel = { width: 100, height: 2000 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.left).toBe(8);
  });

  it('treats the fits() bound as inclusive at the top margin', () => {
    // 'right'/'left' both fail (deliberately invalid raw anchor.top);
    // 'below' recomputes its own top and lands exactly on the top margin
    // (top === MARGIN); 'above' fails comfortably.
    const anchor = { top: -1000, left: 400, width: 0, height: 1000 };
    const panel = { width: 100, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('below');
    expect(r.top).toBe(8);
  });

  it('rejects a right-edge overflow the fits() width bound must not widen', () => {
    // 'right' overflows the true right margin (vw - MARGIN) by 10px — just
    // within a wrongly-widened `vw + MARGIN` bound, so a sign error here
    // would wrongly accept it instead of flipping to 'left'.
    const anchor = { top: 100, left: 800, width: 54, height: 40 };
    const panel = { width: 340, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.placement).toBe('left');
  });

  it('rejects a bottom-edge overflow the fits() height bound must not widen', () => {
    // 'below' overflows the true bottom margin (vh - MARGIN) by 10px —
    // just within a wrongly-widened `vh + MARGIN` bound.
    const anchor = { top: 380, left: 400, width: 100, height: 114 };
    const panel = { width: 200, height: 300 };
    const r = placeFloatingPanel(anchor, panel, 'below', VIEWPORT);
    expect(r.placement).toBe('above');
  });

  it('computes maxLeft from the true right margin, not a widened one', () => {
    // panel.width (1000) exceeds the viewport, so every direction fails
    // and the fallback's maxLeft clamp is the binding constraint (the raw
    // left, 5008, comfortably exceeds every candidate maxLeft formula
    // could produce) — this isolates the maxLeft arithmetic itself.
    const anchor = { top: 100, left: 5000, width: 0, height: 0 };
    const panel = { width: 1000, height: 2000 };
    const r = placeFloatingPanel(anchor, panel, 'right', VIEWPORT);
    expect(r.left).toBe(1200 - 8 - 1000);
  });

  it('computes maxTop from the true bottom margin, not a widened one', () => {
    const anchor = { top: 5000, left: 100, width: 0, height: 0 };
    const panel = { width: 2000, height: 500 };
    const r = placeFloatingPanel(anchor, panel, 'below', VIEWPORT);
    expect(r.top).toBe(800 - 8 - 500);
  });
});
