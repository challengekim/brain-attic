// Two-way adapters send over the network, so the proposal may change on disk while a send is in flight (an answer pulled
// by sync, a withdraw, a reclassify that starts a new generation). Never write a stale copy back: read before sending,
// and after sending record only this adapter's own `external` key on the current copy.
import { getProposal, saveProposal } from '../proposals.mjs';

const gen = (p) => p.generation || 1;

/** The current on-disk proposal if it is still pending and of the same generation as the caller's copy, else null. */
export function freshPending(vault, given) {
  const p = getProposal(vault, given.id);
  return p && p.status === 'pending' && gen(p) === gen(given) ? p : null;
}

/** Record a finished send on the current copy. A newer generation is left alone: it gets its own card. */
export function recordSent(vault, sentCopy, key, record) {
  const p = getProposal(vault, sentCopy.id);
  if (!p || gen(p) !== gen(sentCopy)) return null;
  p.external = { ...p.external, [key]: record };
  return saveProposal(vault, p);
}
