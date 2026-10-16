export const CORE_HOLD_MS = 380;

export function coreFromHit(world, hit) {
  if (!hit || hit.team !== 0) return null;
  if (hit.kind === 'core' && !hit.dock) return hit;
  if (hit.kind === 'building' && !hit.construction && world.buildings[hit.type]?.acceptsCore) return world.dockedCore(hit);
  return null;
}

// Preview is read-only: production keeps running until a valid drop is committed.
export function previewCoreDrop(world, coreId, point, hit = null) {
  const core = world.byId(coreId);
  if (!core || core.team !== 0 || core.kind !== 'core' || world.result) return { ok: false, label: '核心当前无法调度' };
  if (hit?.id === core.id || (core.dock && hit?.id === core.dock)) return { ok: true, kind: 'stay', label: core.dock ? '保持接入 · 松开仅选中核心' : '保持当前位置', point: core };
  if (hit?.kind === 'building') {
    const plan = world.previewCoreAssignment(coreId, hit.id, { swap: true });
    const label = !plan.ok ? plan.reason : plan.swapped ? plan.sourceId ? '交换核心 · 两个核心互换建筑' : '替换核心 · 原核心卸在建筑旁' : `接入${world.buildings[hit.type].name}`;
    return { ...plan, kind: 'dock', buildingId: hit.id, point: hit, label };
  }
  if (hit?.team === 1 || (hit?.kind === 'core' && hit.team === -1)) return { ok: false, label: '请选择己方建筑或可通行空地' };
  if (!world.walkable(point.x, point.y, core.r)) return { ok: false, label: '此处无法停放核心，请选择陆地' };
  const origin = world.orderOrigin(core), path = origin ? world.findPath({ ...origin, r: core.r }, point) : [];
  if (!path.length) return { ok: false, label: '核心无法到达此处，请留出通道' };
  return { ok: true, kind: 'move', point, path, origin, label: '移动到此处 · 持续储能' };
}
