/**
 * Papelera de actividades y tareas del tablero.
 *
 * Eliminar no borra de una vez: la copia completa queda en TrashedItem durante
 * RETENTION_DAYS y un aprobador (administrador o líder de área) la puede
 * restaurar con el mismo _id, comentarios, historial y adjuntos. Al vencer se
 * borra de verdad (purgeExpired corre al arrancar y cada vez que se abre la
 * papelera).
 */
const mongoose = require('mongoose');
const Activity = require('../models/Activity');
const Task = require('../models/Task');
const TrashedItem = require('../models/TrashedItem');
const { deleteFiles } = require('./activityFileStore');

const RETENTION_DAYS = 60;
const MODELS = { activity: Activity, task: Task };

class TrashError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Mueve a la papelera la entidad ya cargada y la borra de su colección.
 * Al ser una feature, sus tareas quedan "Sin feature" y se recuerda cuáles eran.
 */
async function moveToTrash({ entityType, entity, organizationId, userId }) {
  const Model = MODELS[entityType];
  let detachedChildIds = [];

  if (entityType === 'activity' && entity.type === 'feature') {
    const children = await Activity.find({ featureId: entity._id, organizationId }).select('_id');
    detachedChildIds = children.map(c => c._id);
    if (detachedChildIds.length > 0) {
      await Activity.updateMany({ _id: { $in: detachedChildIds } }, { $set: { featureId: null } });
    }
  }

  const now = new Date();
  await TrashedItem.create({
    organizationId,
    entityType,
    entityId: entity._id,
    title: entity.title || '',
    itemType: entity.type || null,
    data: entity.toObject({ depopulate: true }),
    detachedChildIds,
    deletedBy: userId || null,
    deletedAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
  });
  await Model.deleteOne({ _id: entity._id, organizationId });
}

/** Restaura el elemento de la papelera; devuelve la entidad restaurada. */
async function restoreFromTrash({ trashId, organizationId, userId }) {
  if (!mongoose.Types.ObjectId.isValid(trashId)) {
    throw new TrashError(404, 'NOT_FOUND', 'No se encontró el elemento en la papelera');
  }
  const item = await TrashedItem.findOne({ _id: trashId, organizationId });
  if (!item) throw new TrashError(404, 'NOT_FOUND', 'No se encontró el elemento en la papelera');

  const Model = MODELS[item.entityType];
  if (await Model.exists({ _id: item.entityId })) {
    throw new TrashError(409, 'ALREADY_EXISTS', 'La tarea ya existe; no hace falta restaurarla');
  }

  // Inserción directa: el documento vuelve exactamente como estaba
  await Model.collection.insertOne(item.data);
  const entity = await Model.findById(item.entityId);
  if (typeof entity.logAction === 'function') {
    entity.logAction('restored', userId);
    await entity.save({ validateBeforeSave: false });
  }

  // Las tareas de una feature vuelven a colgar de ella si siguen sueltas
  if (item.detachedChildIds.length > 0) {
    await Activity.updateMany(
      { _id: { $in: item.detachedChildIds }, organizationId, featureId: null },
      { $set: { featureId: item.entityId } }
    );
  }

  await TrashedItem.deleteOne({ _id: item._id });
  return { entityType: item.entityType, entity };
}

/** Borra definitivamente lo que pasó el plazo de retención (y sus documentos). */
async function purgeExpired() {
  const expired = await TrashedItem.find({ expiresAt: { $lte: new Date() } }).select('data.attachments');
  if (expired.length === 0) return 0;
  const fileIds = expired.flatMap(item => (item.data?.attachments || []).map(a => a.fileId));
  await deleteFiles(fileIds);
  await TrashedItem.deleteMany({ _id: { $in: expired.map(i => i._id) } });
  return expired.length;
}

module.exports = { RETENTION_DAYS, TrashError, moveToTrash, restoreFromTrash, purgeExpired };
