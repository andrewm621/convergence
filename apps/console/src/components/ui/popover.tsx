import { Popover as PopoverPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The confirm sheet. Radix closes it on Escape and on a click outside, moves focus into it when it opens and
 * hands focus back to the trigger when it closes.
 */
function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
	return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({ className, sideOffset = 8, align = "end", children, ...props }: React.ComponentProps<typeof PopoverPrimitive.Content>) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Content
				data-slot="popover-content"
				sideOffset={sideOffset}
				align={align}
				collisionPadding={12}
				className={cn(
					"z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none animate-in fade-in-0 zoom-in-95",
					className,
				)}
				{...props}
			>
				{children}
			</PopoverPrimitive.Content>
		</PopoverPrimitive.Portal>
	);
}

export { Popover, PopoverTrigger, PopoverContent };
