import * as React from "react"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    value?: number
    max?: number
    indicatorColor?: string
  }
>(({ className, value, max = 100, indicatorColor, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "relative h-4 w-full overflow-hidden rounded-full bg-secondary",
      className
    )}
    {...props}
  >
    <div
      className={cn("h-full w-full flex-1 transition-all", indicatorColor || "bg-primary")}
      style={{
        transform: `translateX(-${100 - ((value || 0) / max) * 100}%)`,
      }}
    />
  </div>
))
Progress.displayName = "Progress"

export { Progress }