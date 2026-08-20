import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useToolbar } from '@ohif/core';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Icons,
  Button,
} from '@ohif/ui-next';
import { getVisibleCount } from './getVisibleCount';

/**
 * Props for the Toolbar component that renders a collection of toolbar buttons and/or button sections.
 *
 * @interface ToolbarProps
 */
interface ToolbarProps {
  /**
   * The section of buttons to display in the toolbar.
   * Common values include 'primary', 'secondary', 'tertiary', etc.
   * Defaults to 'primary' if not specified.
   *
   * @default 'primary'
   */
  buttonSection?: string;

  /**
   * The unique identifier of the viewport this toolbar is associated with.
   */
  viewportId?: string;

  /**
   * The numeric position or location of the toolbar.
   * Used for ordering and layout purposes in the UI.
   */
  location?: number;

  /**
   * Move buttons that do not fit into an overflow menu instead of letting the
   * row clip.
   *
   * Off by default: viewport action menus and the secondary row are short and
   * sit in containers that are never the constrained axis, so measuring them
   * would be cost without benefit. The main header toolbar sets it.
   */
  collapsible?: boolean;
}

export function Toolbar({
  buttonSection = 'primary',
  viewportId,
  location,
  collapsible = false,
}: ToolbarProps) {
  const {
    toolbarButtons,
    onInteraction,
    isItemOpen,
    isItemLocked,
    openItem,
    closeItem,
    toggleLock,
  } = useToolbar({
    buttonSection,
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  // Widths are cached by button id and reused across resizes. A button's own
  // width does not depend on how much room the row has, so re-measuring on
  // every resize would burn layout for an answer that cannot have changed.
  const widthsRef = useRef(new Map<string, number>());
  const overflowWidthRef = useRef(40);
  const gapRef = useRef(4);
  const [visibleCount, setVisibleCount] = useState<number | null>(null);

  const buttons = toolbarButtons.filter(Boolean);
  const ids = buttons.map(toolDef => toolDef.id);
  const idKey = ids.join('|');
  // A button we have never measured forces a pass with the row fully rendered.
  // Otherwise a newly added tool would be sized as zero and the row would
  // believe it has more space than it does.
  const needsMeasure = collapsible && ids.some(id => !widthsRef.current.has(id));

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const widths = idKey ? idKey.split('|').map(id => widthsRef.current.get(id) ?? 0) : [];
    setVisibleCount(
      getVisibleCount(widths, container.clientWidth, gapRef.current, overflowWidthRef.current)
    );
  }, [idKey]);

  useLayoutEffect(() => {
    if (!collapsible) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }

    // Read the real gap rather than assuming it, so changing the row spacing in
    // markup cannot silently make the fit calculation wrong.
    const parsedGap = Number.parseFloat(getComputedStyle(container).columnGap);
    if (Number.isFinite(parsedGap)) {
      gapRef.current = parsedGap;
    }

    if (needsMeasure) {
      itemRefs.current.forEach((element, id) => {
        const width = element?.getBoundingClientRect?.().width ?? 0;
        if (width > 0) {
          widthsRef.current.set(id, width);
        }
      });
    }

    recompute();

    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    return () => observer.disconnect();
  }, [collapsible, needsMeasure, recompute]);

  if (!toolbarButtons.length) {
    return null;
  }

  const renderTool = (toolDef, { inOverflow = false } = {}) => {
    const { id, Component, componentProps } = toolDef;

    // Enhanced props with state and actions - respecting viewport specificity
    const enhancedProps = {
      ...componentProps,
      isOpen: isItemOpen(id, viewportId),
      isLocked: isItemLocked(id, viewportId),
      onOpen: () => openItem(id, viewportId),
      onClose: () => closeItem(id, viewportId),
      onToggleLock: () => toggleLock(id, viewportId),
      viewportId,
    };

    const tool = (
      <Component
        key={id}
        id={id}
        location={location}
        onInteraction={args => {
          onInteraction({
            ...args,
            itemId: id,
            viewportId,
          });
        }}
        {...enhancedProps}
      />
    );

    const setRef = (element: HTMLDivElement | null) => {
      if (element) {
        itemRefs.current.set(id, element);
      } else {
        itemRefs.current.delete(id);
      }
    };

    return (
      <div
        key={id}
        ref={inOverflow ? undefined : setRef}
        // `contents` keeps this wrapper out of the layout while satisfying
        // React's key requirement. A measured row cannot use it: a
        // display:contents box has no box, so it has no width to read.
        className={inOverflow || collapsible ? 'flex items-center' : 'contents'}
      >
        {tool}
      </div>
    );
  };

  if (!collapsible) {
    return <>{buttons.map(toolDef => renderTool(toolDef))}</>;
  }

  // While measuring, everything is rendered - that pass is what produces the
  // widths. useLayoutEffect runs before paint, so the momentarily wide row is
  // never shown.
  const shown = visibleCount === null || needsMeasure ? buttons.length : visibleCount;
  const visible = buttons.slice(0, shown);
  const hidden = buttons.slice(shown);

  return (
    <div
      ref={containerRef}
      // overflow-hidden, not overflow-x-auto: with an overflow menu there is
      // nothing to scroll to, and a scroll container here would let the row be
      // dragged sideways into empty space.
      className="flex w-full min-w-0 items-center justify-center gap-[4px] overflow-hidden"
    >
      {visible.map(toolDef => renderTool(toolDef))}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-primary hover:bg-muted shrink-0"
              aria-label={`${hidden.length} more tools`}
              title={`${hidden.length} more tools`}
              data-cy="toolbar-overflow"
            >
              <Icons.More />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            // The real toolbar buttons are rendered here rather than plain menu
            // rows, so active state, disabled state and their own popovers keep
            // behaving exactly as they do in the row. A grid stops a long tail
            // from becoming a column that runs off the screen.
            className="bg-popover grid grid-flow-row grid-cols-4 gap-1 p-2"
          >
            {hidden.map(toolDef => renderTool(toolDef, { inOverflow: true }))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
