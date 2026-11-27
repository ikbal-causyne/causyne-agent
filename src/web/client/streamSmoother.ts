export interface StreamSmoother {
  push(delta: string): void;
  setFull(text: string, streaming: boolean): void;
  flush(): void;
  getText(): string;
}

function solveBarrierBisect(fn: (x: number) => number, lo: number, hi: number): number {
  if (lo >= hi) return hi;
  let a = lo;
  let b = hi;
  if (fn(a) >= 0) return a;
  if (fn(b) <= 0) return b;
  for (let k = 0; k < 22 && (b - a) > 0.05; k += 1) {
    const mid = (a + b) * 0.5;
    if (fn(mid) <= 0) a = mid;
    else b = mid;
  }
  return a;
}

export function createStreamSmoother(
  onRender: (visibleText: string, isStreaming: boolean, shownLen: number) => void
): StreamSmoother {
  let fullText = '';
  let shownLen = 0;
  let vel = 120;
  let lastT = 0;
  let startMs = 0;
  const arrivals: Array<[number, number]> = [[-9999, 0]];
  let done = false;
  let rafId = 0;
  const alpha = 0.99;
  const gamma = 1e-5;
  const reducedMotion = Boolean(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  function step(): void {
    rafId = 0;
    const total = fullText.length;
    if (reducedMotion || total === 0) {
      shownLen = total;
      onRender(fullText, !done, shownLen);
      return;
    }
    if (shownLen >= total) {
      if (done) onRender(fullText, false, total);
      return;
    }
    const nowSec = (performance.now() - startMs) / 1000;
    const dt = Math.max(nowSec - lastT, 1e-4);
    const upper = total + (done ? 120 : 0);
    const lagTarget = 0.9 * nowSec - 0.25;
    let minChars = 0;
    for (let idx = arrivals.length - 1; idx >= 0; idx -= 1) {
      const pair = arrivals[idx]!;
      if (pair[0] < lagTarget) {
        minChars = pair[1];
        break;
      }
    }
    const lo = Math.max(shownLen, Math.min(total, done ? total : minChars));
    const nextX = done && (total - shownLen) <= 18
      ? total
      : solveBarrierBisect((x) => {
          const d = (x - shownLen) / dt;
          return 2 * (done ? gamma * 0.01 : gamma) * (1 / dt) * (d - vel)
            - 1 / Math.max(1e-4, x - lo)
            + 1 / Math.max(1e-4, upper - x);
        }, lo, upper);
    const clamped = Math.min(total, Math.max(shownLen + 1, Math.round(nextX)));
    const instV = (clamped - shownLen) / dt;
    vel = Math.max(45, Math.min(2400, alpha * vel + (1 - alpha) * instV));
    shownLen = clamped;
    lastT = nowSec;
    onRender(fullText.slice(0, shownLen), !done || shownLen < total, shownLen);
    if (shownLen < total) rafId = window.requestAnimationFrame(step);
    else if (done) onRender(fullText, false, total);
  }

  function schedule(): void {
    if (!rafId) rafId = window.requestAnimationFrame(step);
  }

  return {
    push(delta: string): void {
      if (!delta) return;
      if (!startMs) { startMs = performance.now(); lastT = 0; }
      fullText += delta;
      const tSec = (performance.now() - startMs) / 1000;
      arrivals.push([tSec, fullText.length]);
      if (arrivals.length > 120) arrivals.shift();
      schedule();
    },
    setFull(text: string, streaming: boolean): void {
      fullText = String(text || '');
      if (!streaming) {
        if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
        done = true;
        shownLen = fullText.length;
        onRender(fullText, false, shownLen);
        return;
      }
      if (!startMs) { startMs = performance.now(); lastT = 0; }
      arrivals.push([(performance.now() - startMs) / 1000, fullText.length]);
      schedule();
    },
    flush(): void {
      done = true;
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
      shownLen = fullText.length;
      onRender(fullText, false, shownLen);
    },
    getText(): string {
      return fullText;
    }
  };
}
