/** Who is recording the call, in words for the call bar; null when nobody is. */
export function recordingNotice(self: boolean, others: string[]): string | null {
  const who = [...(self ? ['You'] : []), ...others]
  if (who.length === 0) return null
  if (who.length === 1) return self ? 'You’re recording this call' : `${who[0]} is recording this call`
  return `${who.slice(0, -1).join(', ')} and ${who.at(-1)} are recording this call`
}
