import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tones are semantic, never raw colors. A badge always carries a text label (and usually an
 * icon), so meaning never rests on color alone.
 */
const badgeVariants = cva(
	"inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
	{
		variants: {
			tone: {
				neutral: "border-border bg-muted text-muted-foreground",
				outline: "border-border bg-transparent text-foreground",
				primary: "border-primary/30 bg-accent text-accent-foreground",
				success: "border-success/30 bg-success-soft text-success",
				warning: "border-warning/35 bg-warning-soft text-warning",
				danger: "border-danger/35 bg-danger-soft text-danger",
				info: "border-info/30 bg-info-soft text-info",
				merged: "border-merged/30 bg-merged-soft text-merged",
			},
			emphasis: {
				soft: "",
				solid: "border-transparent text-background",
			},
			dashed: { true: "border-dashed", false: "" },
		},
		compoundVariants: [
			{ tone: "success", emphasis: "solid", className: "bg-success" },
			{ tone: "danger", emphasis: "solid", className: "bg-danger" },
			{ tone: "info", emphasis: "solid", className: "bg-info" },
			{ tone: "merged", emphasis: "solid", className: "bg-merged" },
			{ tone: "warning", emphasis: "solid", className: "bg-warning" },
		],
		defaultVariants: { tone: "neutral", emphasis: "soft", dashed: false },
	},
);

function Badge({
	className,
	tone,
	emphasis,
	dashed,
	asChild = false,
	...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
	const Comp = asChild ? Slot.Root : "span";
	return <Comp data-slot="badge" className={cn(badgeVariants({ tone, emphasis, dashed }), className)} {...props} />;
}

export { Badge, badgeVariants };
