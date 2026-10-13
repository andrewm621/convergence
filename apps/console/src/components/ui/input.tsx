import type * as React from "react";
import { cn } from "@/lib/utils";

const field =
	"w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-danger/20";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return <input type={type} data-slot="input" className={cn(field, "h-9 py-1", className)} {...props} />;
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return <textarea data-slot="textarea" className={cn(field, "min-h-16 py-2 leading-relaxed", className)} {...props} />;
}

/** A styled native select: keyboard and screen-reader behaviour for free. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
	return <select data-slot="native-select" className={cn(field, "h-9 py-1", className)} {...props} />;
}

function Label({ className, ...props }: React.ComponentProps<"label">) {
	return <label data-slot="label" className={cn("text-xs font-medium text-foreground select-none", className)} {...props} />;
}

export { Input, Textarea, NativeSelect, Label };
