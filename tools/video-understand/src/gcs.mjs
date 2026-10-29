import path from "node:path";

function normalizePrefix(prefix) {
  return String(prefix || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function makeObjectName(filePath, prefix) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 10);
  const cleanedPrefix = normalizePrefix(prefix);
  const filename = `${base || "video"}-${stamp}-${rand}${ext}`;
  return cleanedPrefix ? `${cleanedPrefix}/${filename}` : filename;
}

// @google-cloud/storage is an optional dependency: it is only loaded when a bucket is configured.
export async function createStorageClient(storageOptions = {}) {
  let Storage;
  try {
    ({ Storage } = await import("@google-cloud/storage"));
  } catch (error) {
    throw new Error(
      `GCS_BUCKET is set but @google-cloud/storage could not be loaded (${error.message}). Install it with "pnpm install" or remove GCS_BUCKET to send media inline.`,
    );
  }
  return new Storage(storageOptions);
}

export async function uploadFile({
  storage,
  bucketName,
  filePath,
  objectPrefix,
  mimeType,
}) {
  const objectName = makeObjectName(filePath, objectPrefix);
  const bucket = storage.bucket(bucketName);

  await bucket.upload(filePath, {
    destination: objectName,
    resumable: true,
    metadata: {
      contentType: mimeType,
    },
  });

  return {
    bucketName,
    objectName,
    gsUri: `gs://${bucketName}/${objectName}`,
  };
}

export async function uploadVideo(options) {
  return uploadFile(options);
}

export function createPublicObjectUrl({ bucketName, objectName }) {
  const encodedObjectName = String(objectName)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `https://storage.googleapis.com/${encodeURIComponent(bucketName)}/${encodedObjectName}`;
}

export async function listObjectsWithPrefix({
  storage,
  bucketName,
  objectPrefix,
}) {
  const prefix = normalizePrefix(objectPrefix);
  const [files] = await storage.bucket(bucketName).getFiles({
    prefix: prefix ? `${prefix}/` : undefined,
    autoPaginate: true,
  });

  return files.map((file) => ({
    bucketName,
    objectName: file.name,
  }));
}

export async function deleteObjectsWithPrefix({
  storage,
  bucketName,
  objectPrefix,
  log,
}) {
  const files = await listObjectsWithPrefix({
    storage,
    bucketName,
    objectPrefix,
  });

  if (log) {
    log(`cleanup found ${files.length} object(s) under prefix "${objectPrefix}"`);
  }

  for (const file of files) {
    await deleteObject({
      storage,
      bucketName: file.bucketName,
      objectName: file.objectName,
    });
    if (log) {
      log(`cleanup deleted gs://${file.bucketName}/${file.objectName}`);
    }
  }

  return files.length;
}

export async function deleteObject({ storage, bucketName, objectName }) {
  try {
    await storage.bucket(bucketName).file(objectName).delete();
    return true;
  } catch (error) {
    const code = error?.code || error?.statusCode;
    if (code === 404) {
      return false;
    }
    throw error;
  }
}
