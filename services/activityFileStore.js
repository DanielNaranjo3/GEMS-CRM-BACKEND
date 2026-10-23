/**
 * Documentos adjuntos de actividades (PDF, Word, Excel) guardados en MongoDB
 * con GridFS: el disco de Render se borra en cada despliegue.
 */
const mongoose = require('mongoose');
const { Readable } = require('stream');

const BUCKET_NAME = 'activityFiles';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB por archivo

// Tipos permitidos: el navegador no siempre manda el mimetype correcto de
// Office, así que también se acepta por extensión.
const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv'
]);
const ALLOWED_EXTENSIONS = /\.(pdf|docx?|xlsx?|csv)$/i;

function isAllowedDocument(file) {
  return ALLOWED_MIMETYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.test(file.originalname || '');
}

function bucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
}

/** Guarda el buffer y devuelve el ObjectId del archivo. */
function saveFile({ buffer, filename, mimetype, metadata }) {
  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(filename, { contentType: mimetype, metadata });
    Readable.from(buffer)
      .pipe(upload)
      .on('error', reject)
      .on('finish', () => resolve(upload.id));
  });
}

function openDownload(fileId) {
  return bucket().openDownloadStream(new mongoose.Types.ObjectId(fileId));
}

/** Borra los archivos indicados; los que ya no existen se ignoran. */
async function deleteFiles(fileIds) {
  const b = bucket();
  for (const id of fileIds.filter(Boolean)) {
    try {
      await b.delete(new mongoose.Types.ObjectId(id));
    } catch (e) {
      if (!/FileNotFound|File not found/i.test(e.message)) {
        console.warn('activityFileStore: no se pudo borrar', String(id), e.message);
      }
    }
  }
}

module.exports = { MAX_FILE_SIZE, isAllowedDocument, saveFile, openDownload, deleteFiles };
