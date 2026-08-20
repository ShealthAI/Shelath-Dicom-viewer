import React, { ReactNode } from 'react';
import { useSystem } from '@ohif/core';
import {
  Button,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useIconPresentation,
} from '@ohif/ui-next';
import MagnifyZoomMenu from './MagnifyZoomMenu';

type MagnifyZoomMenuWrapperProps = {
  location: string;
  isOpen?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  disabled?: boolean;
};

/**
 * The toolbar affordance that opens the magnifier zoom control.
 *
 * Deliberately NOT part of the Magnify button itself: the magnifier is a
 * hover tool, so folding the setting into the same button would mean turning
 * the magnifier on to change its strength, and clicking to adjust would fight
 * the hover interaction. A separate neighbouring control can be opened at any
 * time, including before the magnifier is switched on.
 */
export function MagnifyZoomMenuWrapper(props: MagnifyZoomMenuWrapperProps): ReactNode {
  const { location, isOpen = false, onOpen, onClose, disabled, ...rest } = props;
  const { IconContainer, className: iconClassName, containerProps } = useIconPresentation();

  const { servicesManager } = useSystem();
  const { toolbarService } = servicesManager.services;
  const { align, side } = toolbarService.getAlignAndSide(location);

  const handleOpenChange = (openState: boolean) => {
    if (openState) {
      onOpen?.();
    } else {
      onClose?.();
    }
  };

  const Icon = <Icons.ByName name="tool-zoom" className={iconClassName} />;

  return (
    <Popover
      open={isOpen}
      onOpenChange={handleOpenChange}
    >
      <PopoverTrigger
        asChild
        className="flex items-center justify-center"
      >
        <div>
          {IconContainer ? (
            <IconContainer
              disabled={disabled}
              icon="tool-zoom"
              {...rest}
              {...containerProps}
            >
              {Icon}
            </IconContainer>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled}
            >
              {Icon}
            </Button>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent
        className="border-none bg-transparent p-0 shadow-none"
        side={side}
        align={align}
        alignOffset={0}
        sideOffset={5}
      >
        <MagnifyZoomMenu className="w-full" />
      </PopoverContent>
    </Popover>
  );
}
