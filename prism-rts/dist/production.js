import { UNITS } from './engine.js';

export function productionUnits(producerType) {
  return Object.keys(UNITS).filter(type => UNITS[type].producer === producerType);
}

// Each panel is bound to one actual building; there is no shared primary producer.
export function productionFacilities(world, unitType) {
  const type = (world.units || UNITS)[unitType]?.producer;
  return type ? world.all(0, 'building').filter(b => b.type === type && !b.construction) : [];
}

export function productionOrder(world, buildingId, unitType, right = false) {
  const b = world.byId(buildingId), d = (world.units || UNITS)[unitType];
  if (!b || b.team !== 0 || b.kind !== 'building' || !d || d.producer !== b.type || b.construction || world.result) {
    return { ok: false, reason: '此生产建筑不可用' };
  }
  if (right) {
    const queuedIndex = b.queue.lastIndexOf(unitType);
    if (queuedIndex !== -1) {
      world.cancelQueued(b.id, queuedIndex);
      return { ok: true, message: `已取消该建筑的一个${d.name}等待订单` };
    }
    if (!b.job || b.job.type !== unitType) return { ok: false, reason: `该建筑没有${d.name}生产订单` };
    if (b.job.paused) {
      world.cancelProduction(b.id);
      return { ok: true, message: '该建筑生产已取消，已付能量退回原核心' };
    }
    world.toggleProductionPause(b.id);
    return { ok: true, message: '该建筑已暂停，左键继续；再次右键取消' };
  }
  if (b.job?.paused && b.job.type === unitType) {
    world.toggleProductionPause(b.id);
    return { ok: true, message: '该建筑生产已继续' };
  }
  const result = world.enqueue(b.id, unitType);
  return result.ok ? { ok: true, message: '已向该建筑添加生产订单' } : result;
}
