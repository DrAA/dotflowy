import type { ReactElement } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Hover label for icon-only header controls. `children` must be the control
 *  itself (a Button, menu trigger, …) so Base UI can merge props onto it. */
export function HeaderTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
