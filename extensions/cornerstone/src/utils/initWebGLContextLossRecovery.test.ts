import initWebGLContextLossRecovery from './initWebGLContextLossRecovery';
import { _resetGpuTierCache, getGpuTier } from './getGpuTier';

// Name must start with `mock` — jest hoists jest.mock() above const declarations
// and only allows the factory to close over variables with that prefix.
const mockRender = jest.fn();
jest.mock('@cornerstonejs/core', () => ({
  getRenderingEngines: () => [{ render: (...args: unknown[]) => mockRender(...args) }],
}));

/**
 * The behaviour under test is the difference between "the viewer recovers" and
 * "the radiologist stares at a black box until they reload mid-report".
 */
describe('initWebGLContextLossRecovery', () => {
  let detach: () => void;
  let notifications: Array<{ title: string; type: string }>;
  let canvas: HTMLCanvasElement;

  const deps = () => ({
    uiNotificationService: {
      show: (opts: { title: string; type: string }) => {
        notifications.push(opts);
      },
    },
  });

  function loseContext(target: HTMLCanvasElement = canvas) {
    const event = new Event('webglcontextlost', { cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockRender.mockClear();
    notifications = [];
    sessionStorage.clear();
    _resetGpuTierCache();
    document.body.innerHTML = '';
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    // Start from a machine that has somewhere to fall to.
    window.history.replaceState({}, '', '/?gpuTier=high');
    detach = initWebGLContextLossRecovery(deps());
  });

  afterEach(() => {
    detach?.();
    jest.useRealTimers();
    window.history.replaceState({}, '', '/');
  });

  it('calls preventDefault on context loss — without it the browser never restores', () => {
    const event = loseContext();
    expect(event.defaultPrevented).toBe(true);
  });

  it('re-renders viewports from cache when the context is restored', () => {
    // Spy BEFORE the event: recovery is deferred one animation frame so the
    // browser can finish re-creating GL resources before we draw into them.
    const raf = jest.spyOn(window, 'requestAnimationFrame');

    loseContext();
    canvas.dispatchEvent(new Event('webglcontextrestored'));

    expect(mockRender).not.toHaveBeenCalled();
    raf.mock.calls.forEach(([cb]) => (cb as FrameRequestCallback)(0));

    // No refetch involved — pixels are still in cornerstone's cache, so recovery
    // costs a GPU upload, not a network round trip.
    expect(mockRender).toHaveBeenCalled();
  });

  it('tells the user something is happening rather than leaving a silent black screen', () => {
    loseContext();
    expect(notifications.some(n => /display reset/i.test(n.title))).toBe(true);
  });

  it('downgrades the GPU tier after repeated losses instead of looping forever', () => {
    expect(getGpuTier()).toBe('high');

    loseContext();
    loseContext(); // second loss inside the window trips the breaker

    expect(sessionStorage.getItem('shealth.gpuTier.forced')).toBe('mid');
    expect(notifications.some(n => /lighter display mode/i.test(String(n.title + n.type)) || n.type === 'warning')).toBe(true);
  });

  it('escalates to an actionable error once the lowest tier still fails', () => {
    window.history.replaceState({}, '', '/?gpuTier=low');
    _resetGpuTierCache();

    loseContext();
    loseContext();

    // Nothing left to trade — say so plainly instead of silently retrying.
    expect(notifications.some(n => n.type === 'error')).toBe(true);
    expect(sessionStorage.getItem('shealth.gpuTier.forced')).toBeNull();
  });

  it('attaches to canvases created after init (viewports appear as layouts change)', async () => {
    const later = document.createElement('canvas');
    document.body.appendChild(later);

    // MutationObserver callbacks are microtask-scheduled.
    await Promise.resolve();

    const event = loseContext(later);
    expect(event.defaultPrevented).toBe(true);
  });

  it('stops observing once detached', () => {
    detach();
    const after = document.createElement('canvas');
    document.body.appendChild(after);
    expect(after.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))).toBe(true);
  });
});
