// Sovereign TUI Scroll & Mouse Isolation Controller
//
// Implements OpenCode-compliant viewport containment:
// 1. Mouse wheel events are strictly confined to the chat box viewport.
// 2. Overscrolling past the top (0) or bottom (maxScrollTop) saturates cleanly.
// 3. Mouse reporting is NEVER released to the terminal during an active session,
//    preventing terminal scrollback desync and UI freezes.
// 4. Scrollbar (rail) mouse interactions clamp cleanly even if clicked above or
//    below the chat box bounds.

export interface MouseCoordinate {
  x: number;
  y: number;
  button?: number;
  pressed?: boolean;
}

export interface WheelCoordinate {
  direction: 'up' | 'down' | 'left' | 'right';
  x?: number;
  y?: number;
}

export interface KeyEvent {
  name: string;
  wheel?: WheelCoordinate;
  mouse?: MouseCoordinate;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  text?: string;
  sequence?: string;
}

export interface ViewportContract {
  scrollTop: number;
  maxScrollTop(): number;
  wheel(direction: 'up' | 'down', notches?: number, now?: number): number;
  scrollTo(position: number, options?: { snap?: boolean }): number;
  toBottom(): number;
  toTop(): number;
  pageUp(): number;
  pageDown(): number;
  lineUp(n?: number): number;
  lineDown(n?: number): number;
  halfPageUp(): number;
  halfPageDown(): number;
  following: boolean;
  height: number;
  width: number;
  lastWheelMoved?: boolean;
}

export interface SurfaceContract {
  stage?: {
    height: number;
    width(): number;
    reserved?: boolean;
  };
  viewport?: ViewportContract;
  width?: number;
  mouseCaptured?: boolean;
  detached?: boolean;
  releaseMouse?(): boolean;
  captureMouse?(): boolean;
  railEnabled?(width: number): boolean;
}

export interface PromptScrollHost {
  surface: SurfaceContract | null;
  out: { rows?: number; columns?: number; write?(text: string): boolean } | null;
  notice: string;
  draw(): void;
  scheduleDraw?(): void;
  pickerLayout?: {
    pickerStart: number;
    pickerCount: number;
    totalPromptRows: number;
  } | null;
}

/**
 * Handle mouse wheel scrolling with full viewport containment.
 * Replaces the buggy overscroll release with clean boundary saturation.
 */
export function handleViewportWheel(
  key: KeyEvent,
  viewport: ViewportContract | null | undefined,
  surface: SurfaceContract | null | undefined,
  host: PromptScrollHost
): boolean {
  if (!viewport || !key.wheel) return true;

  // Auto-heal: If the surface was ever detached, immediately re-capture mouse
  // so the session stays responsive and never freezes.
  if (surface && typeof surface.captureMouse === 'function' && surface.detached) {
    surface.captureMouse();
    if (host.notice.startsWith('top of this view')) {
      host.notice = '';
    }
  }

  // Pure isolated scrolling: clamp strictly inside [0, maxScrollTop]
  viewport.wheel(key.wheel.direction === 'down' ? 'down' : 'up');

  // Immediately draw updated viewport
  host.draw();
  return true;
}

/**
 * Handle mouse clicks on the scrollbar rail.
 * Safely clamps coordinates even when clicking above or below the chat box.
 */
export function handleScrollbarMouse(
  key: KeyEvent,
  viewport: ViewportContract | null | undefined,
  surface: SurfaceContract | null | undefined,
  host: PromptScrollHost
): boolean {
  if (!viewport || !surface || !key.mouse || !key.mouse.pressed) return false;
  if (key.mouse.button !== 0) return false; // Left click only

  // If completion picker is active, check if click was on the picker
  if (host.pickerLayout && Number.isFinite(key.mouse.y)) {
    const termRows = host.out?.rows || 24;
    const stageH = surface.stage?.height || termRows;
    const promptTop = Math.max(1, stageH - host.pickerLayout.totalPromptRows + 1);
    const pickerTop = promptTop + host.pickerLayout.pickerStart - 1;
    const pickerBottom = pickerTop + host.pickerLayout.pickerCount;
    if (key.mouse.y >= pickerTop && key.mouse.y <= pickerBottom) {
      return false; // Leave to completion handler
    }
  }

  const termRows = host.out?.rows || 24;
  const stageH = surface.stage?.height || termRows;
  const stageTop = Math.max(0, termRows - stageH);
  const viewportH = viewport.height;
  const stageW = typeof surface.stage?.width === 'function' ? surface.stage.width() : (surface.width || 80);
  const hasRail = typeof surface.railEnabled === 'function' ? surface.railEnabled(stageW) : true;
  const contentW = hasRail ? Math.max(20, stageW - 3) : stageW;

  const mouseX = key.mouse.x;
  const mouseY = key.mouse.y;

  // Rail occupies column contentW - 1 through stageW
  const isRailColumn = mouseX >= contentW - 1 && mouseX <= stageW;

  if (isRailColumn) {
    // Auto-heal if detached
    if (typeof surface.captureMouse === 'function' && surface.detached) {
      surface.captureMouse();
      if (host.notice.startsWith('top of this view')) host.notice = '';
    }

    // Boundary clamping:
    // Clicks preceding/above chat box clamp to top (0)
    if (mouseY < stageTop) {
      viewport.scrollTo(0);
      host.draw();
      return true;
    }

    // Clicks below viewport clamp to bottom (maxScrollTop) and resume following
    if (mouseY >= stageTop + viewportH) {
      viewport.toBottom();
      host.draw();
      return true;
    }

    // Clicks on rail inside viewport: compute proportional scroll
    const relY = mouseY - stageTop;
    const fraction = viewportH > 1 ? relY / (viewportH - 1) : 0;
    const clampedFraction = Math.max(0, Math.min(1, fraction));
    const target = Math.round(clampedFraction * viewport.maxScrollTop());

    if (target >= viewport.maxScrollTop()) {
      viewport.toBottom();
    } else {
      viewport.scrollTo(target);
    }

    host.draw();
    return true;
  }

  return false;
}
