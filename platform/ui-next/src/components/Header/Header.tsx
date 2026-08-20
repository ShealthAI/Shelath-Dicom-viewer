import React, { ReactNode } from 'react';
import classNames from 'classnames';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  Icons,
  Button,
  ToolButton,
} from '../';
import { IconPresentationProvider } from '@ohif/ui-next';

import NavBar from '../NavBar';

// Todo: we should move this component to composition and remove props base

interface HeaderProps {
  children?: ReactNode;
  menuOptions: Array<{
    title: string;
    icon?: string;
    onClick: () => void;
  }>;
  isReturnEnabled?: boolean;
  onClickReturnButton?: () => void;
  isSticky?: boolean;
  WhiteLabeling?: {
    createLogoComponentFn?: (React: any, props: any) => ReactNode;
  };
  PatientInfo?: ReactNode;
  Secondary?: ReactNode;
  UndoRedo?: ReactNode;
}

function Header({
  children,
  menuOptions,
  isReturnEnabled = true,
  onClickReturnButton,
  isSticky = false,
  WhiteLabeling,
  PatientInfo,
  UndoRedo,
  Secondary,
  ...props
}: HeaderProps): ReactNode {
  const onClickReturn = () => {
    if (isReturnEnabled && onClickReturnButton) {
      onClickReturnButton();
    }
  };

  return (
    <IconPresentationProvider
      size="large"
      IconContainer={ToolButton}
    >
      <NavBar
        isSticky={isSticky}
        {...props}
      >
        {/* Flex row, not absolute positioning.
          *
          * This used to place all three clusters absolutely — logo at left-0,
          * Secondary at a hardcoded left-[250px], the toolbar centred with
          * left-1/2 -translate-x-1/2, and the patient/settings cluster at
          * right-0. Absolute boxes do not know about each other, so as soon as
          * the viewer is narrower than the sum of their widths — which is
          * exactly what happens when the reporting panel takes half the screen —
          * they overlap and the toolbar icons appear crushed on top of the
          * Secondary row.
          *
          * As a flex row the clusters push against each other honestly: the
          * logo and the right cluster keep their size (shrink-0), and the
          * toolbar takes the remaining space, centring while it fits and
          * scrolling horizontally once it does not. Nothing ever overlaps.
          */}
        <div className="flex h-[48px] w-full items-center gap-2">
          <div className="flex shrink-0 items-center">
            <div
              className={classNames(
                // No mr-3: a white-labelled logo brings its own padding, and
                // stacking both crowded the mark against the toolbar.
                'inline-flex items-center',
                isReturnEnabled && 'cursor-pointer'
              )}
              onClick={onClickReturn}
              data-cy="return-to-work-list"
            >
              {isReturnEnabled && <Icons.ArrowLeft className="text-primary ml-1 h-7 w-7" />}
              <div className="flex items-center">
                {WhiteLabeling?.createLogoComponentFn?.(React, props) || <Icons.OHIFLogo />}
              </div>
            </div>
          </div>
          <div className="flex h-8 shrink-0 items-center">{Secondary}</div>

          {/* min-w-0 is what lets this shrink at all: without it a flex child
            * refuses to go below its content width and would push the right-hand
            * cluster off-screen.
            *
            * This used to be a horizontal scroll container with the scrollbar
            * hidden, which meant tools silently disappeared whenever the row ran
            * out of room — no scrollbar, no chevron, nothing to say they were
            * still there. Overflow is now the toolbar's own job: it measures
            * this slot and moves what does not fit into a menu. All this has to
            * do is hand it a definite width to measure, hence flex-1 here and
            * w-full on the child rather than a content-sized wrapper. */}
          <div className="flex min-w-0 flex-1 justify-center">
            <div className="flex w-full items-center justify-center">{children}</div>
          </div>

          <div className="flex shrink-0 select-none items-center">
            {UndoRedo}
            <div className="border-muted mx-1.5 h-[25px] border-r"></div>
            {PatientInfo}
            <div className="border-muted mx-1.5 h-[25px] border-r"></div>
            <div className="flex-shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-primary hover:bg-muted mt-2 h-full w-full"
                  >
                    <Icons.GearSettings />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {menuOptions.map((option, index) => {
                    const IconComponent = option.icon
                      ? Icons[option.icon as keyof typeof Icons]
                      : null;
                    return (
                      <DropdownMenuItem
                        key={index}
                        onSelect={option.onClick}
                        className="flex items-center gap-2 py-2"
                      >
                        {IconComponent && (
                          <span className="flex h-4 w-4 items-center justify-center">
                            <Icons.ByName name={option.icon} />
                          </span>
                        )}
                        <span className="flex-1">{option.title}</span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </NavBar>
    </IconPresentationProvider>
  );
}

export default Header;
