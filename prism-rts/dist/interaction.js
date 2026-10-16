// Classic Red Alert mouse routing. Cancelling selection never cancels unit orders.
const attackTarget = hit => hit && hit.team !== 0 && (hit.kind === 'unit' || hit.kind === 'building') ? hit.id : null;
export function fieldAction({ right = false, mode = null, selection = [], hit = null, shift = false }) {
  if (right) return { kind: mode ? 'cancel-mode' : 'deselect' };
  if (mode) return { kind: mode.kind, targetId: attackTarget(hit) };
  const core = selection.length === 1 && selection[0].kind === 'core' && selection[0].team === 0 ? selection[0] : null;
  if (core && hit?.kind === 'building' && hit.team === 0) return { kind: 'dock', core, building: hit };
  if (hit?.team === 0) return { kind: 'select', entity: hit, append: shift && hit.kind === 'unit' };
  const producer = selection.length === 1 && selection[0].team === 0 && !selection[0].construction && ['barracks', 'factory'].includes(selection[0].type) ? selection[0] : null;
  if (producer && !hit) return { kind: 'rally', building: producer };
  const movers = selection.filter(e => e.team === 0 && (e.kind === 'unit' || e.kind === 'core'));
  if (movers.length) {
    const hasTroops = movers.some(e => e.kind === 'unit');
    if (hit?.team === 1 && hit.kind === 'core') return { kind: 'protected-core' };
    if (hit?.team === -1 && hit.kind === 'core' && !hasTroops) return { kind: 'cannot-collect' };
    if (hit?.kind === 'capture' && !hasTroops) return { kind: 'cannot-capture' };
    if (attackTarget(hit) !== null && !hasTroops) return { kind: 'cannot-attack' };
    return { kind: 'command', movers, targetId: attackTarget(hit) };
  }
  return hit ? { kind: 'select', entity: hit, append: false } : { kind: 'deselect' };
}
