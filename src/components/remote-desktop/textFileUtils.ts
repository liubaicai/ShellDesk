/** Binary file extension denylist; other files are allowed to open in Notepad. */
export const BINARY_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'avif', 'tiff', 'tif',
  'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'arw', 'dng', 'heic', 'heif',
  // Audio
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'aiff', 'opus', 'mid', 'midi',
  // Video
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst', 'lz4', 'tgz', 'tbz2',
  'cab', 'iso', 'dmg', 'img', 'wim', 'swm', 'esd',
  // Executables and compiled artifacts
  'exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'app', 'deb', 'rpm', 'snap', 'flatpak',
  'apk', 'ipa', 'war', 'jar', 'ear', 'class', 'pyc', 'pyo', 'whl',
  'o', 'obj', 'a', 'lib', 'pdb',
  // Databases and binary data
  'db', 'sqlite', 'sqlite3', 's3db', 'sl3', 'sqlitedb', 'mdb', 'accdb',
  // Binary document formats
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  // Binary font formats
  'woff', 'woff2', 'eot', 'ttc',
  // Other binary formats
  'dat', 'bin', 'sav', 'pickle', 'pkl', 'npy', 'npz', 'parquet', 'feather', 'arrow',
  'pb', 'onnx', 'tflite', 'h5', 'hdf5', 'caffemodel',
  'torrent', 'wasm',
  'keystore', 'jks', 'truststore',
]);

export function getFileExtension(name: string): string {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) return '';
  return name.slice(dotIndex + 1).toLowerCase();
}

export function isTextFile(fileName: string): boolean {
  const ext = getFileExtension(fileName);
  if (!ext && !fileName.includes('.')) return true;
  return !BINARY_EXTENSIONS.has(ext);
}
