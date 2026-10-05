// Shared session-identity derivation for display purposes only.
// The session user payload is relayed upstream identity data, not an
// authoritative audit actor; callers choose their own neutral fallback
// (header: "Signed-in user"; generation provenance: "User name unavailable").

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// Returns the trimmed display name or '' when no usable field exists —
// never a fabricated placeholder. Callers own the fallback wording.
export function sessionUserDisplayName(user: Record<string, unknown> | null | undefined): string {
  if (!user) return ''
  const direct = text(user.name) || text(user.display_name) || text(user.full_name)
  if (direct) return direct
  const first = text(user.first_name) || text(user.firstName)
  const last = text(user.last_name) || text(user.lastName) || text(user.surname)
  const combined = `${first} ${last}`.trim()
  if (combined) return combined
  return text(user.email)
}
