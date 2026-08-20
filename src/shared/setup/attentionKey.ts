/**
 * How a silenced attention item is identified, written once.
 *
 * WHY THIS IS ITS OWN FILE. The server builds this string to decide what is silenced and the client
 * builds it to decide what to hide. Two copies of the same concatenation is the pair that drifts —
 * and it drifted immediately: one side joined with a space and the other with a stray NUL byte that
 * had been pasted in invisibly, so nothing ever matched and dismissing appeared to do nothing at
 * all. The bug was invisible in a diff and cost twenty minutes to find in a debugger.
 *
 * The separator is a visible token for the same reason: `key::signature` is greppable, and a
 * control character in a source file is a thing nobody can see.
 */
export function attentionSignature(key: string, headline: string): string {
  return `${key}::${headline}`;
}
