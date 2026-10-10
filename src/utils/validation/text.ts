import { CONTROL_CHARACTER_PATTERN } from "../../constants.js";

export function isValidBoundedText(value: string, maxLength: number): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}
