/**
 * @file src/computerUse/types.ts
 * Core data contracts for Causyne Universal Hybrid Computer-Use Grounding & Set-of-Marks Engine.
 *
 * Implements ratified Engineering Plan v2 specifications.
 * Strict TypeScript (Causyne Agent).
 */

/** Geometric rectangle representation. Native input units unless explicitly stated. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Display monitor topology and DPI scaling context. */
export interface Display {
  id: string;
  origin: { x: number; y: number }; // Native units
  size: { w: number; h: number };   // Native units
  physical: { w: number; h: number }; // Captured physical pixels
  pxPerUnit: number; // macOS: backing scale factor (e.g. 2.0); Windows/Linux: 1.0
  rotation: 0 | 90 | 180 | 270;
  primary: boolean;
}

/** Window reference with hierarchy and z-ordering. */
export interface WindowRef {
  id: string;
  pid: number;
  app: string;
  title?: string;
  bounds: Rect;
  z: number;
}

/** Point coordinates in various coordinate spaces. */
export type ModelPoint = {
  x: number;
  y: number;
  space: 'norm1000' | 'norm1' | 'image-px';
};

/** Interactive UI Element perceived from accessibility tree, DOM, or visual grounding. */
export interface UiElement {
  /** Unique numerical identifier within the snapshot (referenced as snapshotId#tag). */
  tag: number;
  role: string;
  name?: string;
  description?: string;
  /** Never populated for secret/password fields. */
  value?: string;
  state: {
    enabled: boolean;
    checked?: boolean;
    selected?: boolean;
    focused?: boolean;
    expanded?: boolean;
    readOnly?: boolean;
  };
  frame: Rect;
  visibleFrame: Rect;
  clickPoint?: { x: number; y: number };
  actions: ('press' | 'focus' | 'setValue' | 'scroll' | 'expand')[];
  /** Deterministic element fingerprint: SHA-256(role, name, ancestorPath, relativeFrame). */
  fingerprint: string;
  window: string;
  provenance: 'a11y' | 'dom' | 'vision';
  confidence: number;
}

/** Immutable, versioned screen perception snapshot. */
export interface Snapshot {
  id: string;
  epoch: number;
  takenAtMs: number;
  skewMs: number; // Time difference between visual capture and tree capture
  displays: Display[];
  frontmost: WindowRef;
  windows: WindowRef[];
  elements: UiElement[];
  image: {
    displayId: string;
    sha256: string;
    w: number;
    h: number;
    resize: { scale: number; padX: number; padY: number };
  };
  channel: 'cdp' | 'a11y' | 'vision' | 'fused';
  truncated?: string;
}

/** Target reference for actions: either an immutable tag or a model-space point. */
export type Target =
  | { snapshotId: string; tag: number }
  | { snapshotId: string; point: ModelPoint };

/** Executable computer-use action types. */
export type Action =
  | { type: 'click'; target: Target; button?: 'left' | 'right' | 'middle'; count?: 1 | 2 | 3 }
  | { type: 'drag'; from: Target; to: Target; steps?: number }
  | { type: 'scroll'; at: Target; dx: number; dy: number; unit: 'line' | 'pixel' }
  | { type: 'type'; text: string; strategy?: 'unicode' | 'paste' }
  | { type: 'secret'; ref: string }
  | { type: 'key'; chord: string }
  | { type: 'focusWindow'; windowId: string }
  | { type: 'wait'; ms: number }
  | { type: 'screenshot' };

/** Action risk tiers for policy gate enforcement. */
export type ActionRiskTier = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

/** Target-bound cryptographic approval token for high-risk actions. */
export interface TargetBoundApprovalToken {
  token: string;
  snapshotId: string;
  elementFingerprint: string;
  actionType: string;
  expiresAtMs: number;
}
