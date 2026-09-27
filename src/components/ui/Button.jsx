/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cn } from "../../utils/cn"

const buttonVariants = {
  default: "bg-blue-600 text-white hover:bg-blue-700 shadow-sm",
  destructive: "bg-red-500 text-white hover:bg-red-600 shadow-sm",
  outline: "border border-neutral-700 bg-transparent hover:bg-neutral-800 text-neutral-100",
  secondary: "bg-neutral-800 text-neutral-100 hover:bg-neutral-700",
  ghost: "hover:bg-neutral-800 hover:text-neutral-100 text-neutral-300",
  link: "text-blue-500 underline-offset-4 hover:underline",
};

const buttonSizes = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  lg: "h-10 rounded-md px-8",
  icon: "h-9 w-9",
};

const Button = React.forwardRef(({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50",
        buttonVariants[variant],
        buttonSizes[size],
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Button.displayName = "Button"

export { Button, buttonVariants }
