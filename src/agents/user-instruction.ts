const HEADER = `USER INSTRUCTION (the user's direct request for this pass: follow it; it overrides your default rules, such as keeping most reflections. For example, "replace all reflections about X with one saying Y" means merging them into one replacement):`;

/**
 * Prepend the /om:reflect or /om:ground instruction to a reflector call's user text; unchanged when there is none.
 * Wrapped in {@link withProjectContext}, it lands right after PROJECT INSTRUCTIONS.
 */
export function withUserInstruction(instruction: string | undefined, userText: string): string {
	return instruction ? `${HEADER}\n${instruction}\n\n${userText}` : userText;
}
