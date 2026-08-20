import React, { useCallback, useEffect, useState } from 'react';
import { Numeric } from '@ohif/ui-next';
import {
  DEFAULT_MAGNIFY_ZOOM,
  MAGNIFY_ZOOM_STEP,
  MAX_MAGNIFY_ZOOM,
  MIN_MAGNIFY_ZOOM,
  getMagnifyZoom,
  setMagnifyZoom,
  subscribeMagnifyZoom,
} from '../../tools/magnifyZoomStore';

/**
 * Zoom strength for the hover magnifier.
 *
 * Shown as a PERCENTAGE because that is how magnification is quoted everywhere
 * else a radiologist meets it - 400% reads as "four times life size", where a
 * bare "4" needs a legend. The stored value stays a plain factor; percent is
 * presentation only.
 */

const toPercent = (zoom: number) => Math.round(zoom * 100);

/**
 * Presets rather than slider-only: picking a known strength is one click, and
 * it is what makes the available range legible at a glance. The slider stays
 * for the radiologist who wants something between two presets.
 */
const PRESETS = [200, 300, 400, 500, 600, 800, 1000];

interface MagnifyZoomMenuProps {
  className?: string;
}

function MagnifyZoomMenu({ className }: MagnifyZoomMenuProps) {
  const [zoom, setZoom] = useState<number>(() => getMagnifyZoom());

  // The store is the single source of truth and can change from elsewhere
  // (another menu instance, a restored preference), so mirror it rather than
  // treating local state as authoritative.
  useEffect(() => subscribeMagnifyZoom(setZoom), []);

  const apply = useCallback((next: number) => {
    // Render what the store accepted, not what was requested: it clamps, so a
    // rejected value must not leave the control showing something the
    // magnifier is not doing.
    setZoom(setMagnifyZoom(next));
  }, []);

  const percent = toPercent(zoom);

  return (
    <div className={className}>
      <div className="bg-popover w-64 rounded-lg p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-muted-foreground text-base">Magnifier zoom</span>
          <span className="text-foreground text-base tabular-nums">{percent}%</span>
        </div>

        <Numeric.Container
          mode="singleRange"
          value={zoom}
          onChange={(value: number | [number, number]) => {
            if (typeof value === 'number') {
              apply(value);
            }
          }}
          min={MIN_MAGNIFY_ZOOM}
          max={MAX_MAGNIFY_ZOOM}
          step={MAGNIFY_ZOOM_STEP}
        >
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs tabular-nums">
              {toPercent(MIN_MAGNIFY_ZOOM)}%
            </span>
            <Numeric.SingleRange showNumberInput={false} />
            <span className="text-muted-foreground text-xs tabular-nums">
              {toPercent(MAX_MAGNIFY_ZOOM)}%
            </span>
          </div>
        </Numeric.Container>

        <div className="mt-3 grid grid-cols-4 gap-1">
          {PRESETS.map(preset => {
            const isActive = percent === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => apply(preset / 100)}
                aria-pressed={isActive}
                className={`h-8 rounded text-xs tabular-nums transition-colors outline-none focus-visible:outline-none ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground hover:bg-primary/30'
                }`}
              >
                {preset}%
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => apply(DEFAULT_MAGNIFY_ZOOM)}
            className="text-muted-foreground hover:text-foreground h-8 rounded text-xs outline-none focus-visible:outline-none"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

export default MagnifyZoomMenu;
