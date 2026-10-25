import { cva } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
const variants = cva("button", {
  variants: {
    variant: {
      default: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
  },
  defaultVariants: { variant: "default" },
});
export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button className={variants({ variant }) + " " + className} {...props} />
  );
}
